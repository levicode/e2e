"""Exact-source and ordinary-build custody for one bounded native gate."""
import argparse, hashlib, json, os, pathlib, re, subprocess
p=argparse.ArgumentParser();p.add_argument('command',choices=['prepare','verify-source','select-executable','audit','postcheck']);p.add_argument('--gate',choices=['clippy','controls'],required=True);a=p.parse_args()
root=pathlib.Path(os.environ['GITHUB_WORKSPACE']).resolve();here=pathlib.Path(__file__).resolve().parent;pins=json.loads((here/'pins.json').read_text());evidence=pathlib.Path(os.environ['GATE_EVIDENCE']).resolve();native=root/'native-source'
def git(directory,*args):return subprocess.check_output(['git','-C',str(directory),*args],text=True).strip()
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def dump(name,value):
 with (evidence/name).open('x') as f:json.dump(value,f,indent=2);f.write('\n')
def source():
 assert git(native,'rev-parse','HEAD')==pins['commit'],'wrong native commit'
 assert git(native,'rev-parse','HEAD^{tree}')==pins['tree'],'wrong native tree'
 assert git(native,'status','--porcelain')=='','native source changed'
 for path,digest in pins['files'].items():assert sha(native/path)==digest,path
 return {'nativeCommit':pins['commit'],'nativeTree':pins['tree'],'files':pins['files'],'cargoLockSHA256':sha(native/'cli/Cargo.lock')}
def artifacts():
 rows=[json.loads(line) for line in (evidence/'cargo-artifacts.jsonl').read_text().splitlines()]
 assert rows and rows[-1].get('reason')=='build-finished' and rows[-1].get('success') is True,'compile did not finish successfully'
 return rows
assert pins['schemaVersion']==1 and pins['repository']=='levicode/agent-browser'
assert pins['toolchain']=='1.99.1' and pins['profile']=='ci' and pins['features']==[]
assert re.fullmatch('[0-9a-f]{40}',pins['commit']) and pins['commit']!='0'*40,'unresolved native commit'
assert re.fullmatch('[0-9a-f]{40}',pins['tree'])
if a.command=='prepare':
 assert git(root,'status','--porcelain')=='','producer checkout must be clean'
 evidence.mkdir(parents=True,exist_ok=False)
 dump('producer.json',{'gate':a.gate,'runId':os.environ['GITHUB_RUN_ID'],'runAttempt':os.environ['GITHUB_RUN_ATTEMPT'],'producerCommit':git(root,'rev-parse','HEAD'),'producerTree':git(root,'rev-parse','HEAD^{tree}'),'sourceHashes':{f:sha(here/f) for f in ['pins.json','run-stage.py','ci.py','test-run-stage.py']},'nativePatchSHA256':pins['nativePatchSHA256']})
 with open(os.environ['GITHUB_OUTPUT'],'a') as f:f.write('native_commit='+pins['commit']+'\n')
elif a.command=='verify-source':dump('source-before.json',source())
elif a.command=='select-executable':
 assert a.gate=='controls'
 candidates=[row for row in artifacts() if row.get('reason')=='compiler-artifact' and row.get('target',{}).get('name')=='agent-browser' and 'bin' in row.get('target',{}).get('kind',[]) and row.get('profile',{}).get('test') is True and row.get('executable')]
 assert len(candidates)==1,'require exactly one newly compiled test executable'
 row=candidates[0];assert row.get('features')==[],'nonordinary features'
 assert row.get('fresh') is False,'test executable was not newly compiled'
 exe=pathlib.Path(row['executable']).resolve(strict=True);target=pathlib.Path(os.environ['CARGO_TARGET_DIR']).resolve(strict=True)
 assert exe.is_relative_to(target) and exe.is_file(),'test executable outside fresh target'
 dump('test-binary.json',{'sha256':sha(exe),'fresh':row['fresh'],'features':row['features'],'profile':row['profile'],'relativePath':str(exe.relative_to(target))})
 with open(os.environ['GITHUB_OUTPUT'],'a') as f:f.write('executable='+str(exe)+'\n')
elif a.command=='audit':
 # Collect each available custody fact independently, even after compile/oracle failure.
 evidence.mkdir(parents=True,exist_ok=True)
 audit={'gate':a.gate,'errors':[],'native':{},'binary':None,'files':{}}
 def attempt(label,fn):
  try:return fn()
  except Exception as error:
   audit['errors'].append({'check':label,'type':type(error).__name__});return None
 for label,args in [('commit',('rev-parse','HEAD')),('tree',('rev-parse','HEAD^{tree}')),('status',('status','--porcelain'))]:
  audit['native'][label]=attempt('native-'+label,lambda args=args:git(native,*args))
 for path,digest in pins['files'].items():
  actual=attempt('source-'+path,lambda path=path:sha(native/path));audit['files'][path]={'expected':digest,'actual':actual,'matches':actual==digest}
 audit['sourceVerified']=(audit['native']=={'commit':pins['commit'],'tree':pins['tree'],'status':''} and all(x['matches'] for x in audit['files'].values()))
 b=evidence/'test-binary.json'
 if b.exists():
  meta=attempt('binary-metadata',lambda:json.loads(b.read_text()))
  if meta is not None:
   target=pathlib.Path(os.environ['CARGO_TARGET_DIR']).resolve();exe=(target/meta['relativePath']).resolve()
   actual=attempt('binary-hash',lambda:sha(exe) if exe.is_relative_to(target) else (_ for _ in ()).throw(ValueError('outside target')))
   audit['binary']={'expected':meta['sha256'],'actual':actual,'matches':actual==meta['sha256']}
 audit['retainedFiles']={f:attempt('evidence-'+f,lambda f=f:sha(evidence/f)) for f in ['producer.json','compiler-argv.txt','cargo-artifacts.jsonl','compiler-stderr.log','controls/receipt.json'] if (evidence/f).is_file()}
 dump('custody-after.json',audit)
 # Missing binary after failed compilation is documented, never manufactured as a pass.
 if not audit['sourceVerified'] or (audit['binary'] is not None and not audit['binary']['matches']) or audit['errors']:raise SystemExit(1)
elif a.command=='postcheck':
 dump('source-after.json',source());assert git(root,'diff','HEAD','--name-only')=='','producer tracked source changed'
 producer=json.loads((evidence/'producer.json').read_text());assert producer['producerCommit']==git(root,'rev-parse','HEAD') and producer['producerTree']==git(root,'rev-parse','HEAD^{tree}')
 for f,digest in producer['sourceHashes'].items():assert sha(here/f)==digest
 rows=artifacts();own=[row for row in rows if row.get('reason')=='compiler-artifact' and row.get('target',{}).get('name')=='agent-browser'];assert own and all(row.get('features')==[] for row in own),'ordinary root artifact missing/features changed'
 if a.gate=='controls':
  receipt=json.loads((evidence/'controls/receipt.json').read_text());binary=json.loads((evidence/'test-binary.json').read_text())
  assert sha(pathlib.Path(os.environ['CARGO_TARGET_DIR'])/binary['relativePath'])==binary['sha256'],'test binary changed'
  assert receipt['accepted'] is True and receipt['binarySHA256']==binary['sha256']
  assert [x['test'] for x in receipt['results']]==pins['tests'] and all(x['accepted'] and x['returncode']==code for x,code in zip(receipt['results'],pins['expectedCodes'],strict=True))
 dump('gate-receipt.json',{'gate':a.gate,'accepted':True,'cargoArtifactsSHA256':sha(evidence/'cargo-artifacts.jsonl'),'compilerStderrSHA256':sha(evidence/'compiler-stderr.log'),'compilerArgvSHA256':sha(evidence/'compiler-argv.txt'),'nativeTree':pins['tree']})
