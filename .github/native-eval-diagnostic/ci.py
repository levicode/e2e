"""Exact-source and ordinary-build custody for one bounded native gate."""
import argparse, hashlib, json, os, pathlib, re, subprocess
p=argparse.ArgumentParser();p.add_argument('command',choices=['prepare','verify-source','select-executable','postcheck']);p.add_argument('--gate',choices=['clippy','controls'],required=True);a=p.parse_args()
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
 exe=pathlib.Path(row['executable']).resolve(strict=True);target=pathlib.Path(os.environ['CARGO_TARGET_DIR']).resolve(strict=True)
 assert exe.is_relative_to(target) and exe.is_file(),'test executable outside fresh target'
 dump('test-binary.json',{'sha256':sha(exe),'features':row['features'],'profile':row['profile'],'relativePath':str(exe.relative_to(target))})
 with open(os.environ['GITHUB_OUTPUT'],'a') as f:f.write('executable='+str(exe)+'\n')
elif a.command=='postcheck':
 dump('source-after.json',source());assert git(root,'diff','HEAD','--name-only')=='','producer tracked source changed'
 producer=json.loads((evidence/'producer.json').read_text());assert producer['producerCommit']==git(root,'rev-parse','HEAD') and producer['producerTree']==git(root,'rev-parse','HEAD^{tree}')
 for f,digest in producer['sourceHashes'].items():assert sha(here/f)==digest
 rows=artifacts();own=[row for row in rows if row.get('reason')=='compiler-artifact' and row.get('target',{}).get('name')=='agent-browser'];assert own and all(row.get('features')==[] for row in own),'ordinary root artifact missing/features changed'
 if a.gate=='controls':
  receipt=json.loads((evidence/'controls/receipt.json').read_text());binary=json.loads((evidence/'test-binary.json').read_text())
  assert sha(pathlib.Path(os.environ['CARGO_TARGET_DIR'])/binary['relativePath'])==binary['sha256'],'test binary changed'
  assert receipt['accepted'] is True and receipt['binarySHA256']==binary['sha256']
  assert [x['test'] for x in receipt['results']]==pins['tests'] and all(x['accepted'] and x['returncode']==0 for x in receipt['results'])
 dump('gate-receipt.json',{'gate':a.gate,'accepted':True,'cargoArtifactsSHA256':sha(evidence/'cargo-artifacts.jsonl'),'compilerStderrSHA256':sha(evidence/'compiler-stderr.log'),'compilerArgvSHA256':sha(evidence/'compiler-argv.txt'),'nativeTree':pins['tree']})
