"""Finite paired-control CI custody. No API calls, browser startup or product fixes."""
import argparse, hashlib, json, os, pathlib, re, subprocess
P=argparse.ArgumentParser();P.add_argument('command',choices=['prepare','verify-source','select-executable','postcheck']);P.add_argument('--stage',choices=['baseline','candidate'],required=True);a=P.parse_args()
root=pathlib.Path(os.environ['GITHUB_WORKSPACE']).resolve();here=pathlib.Path(__file__).resolve().parent;pins=json.loads((here/'pins.json').read_text());pin=pins['stages'][a.stage]
evidence=pathlib.Path(os.environ['PAIR_EVIDENCE']).resolve();native=root/'native-source'
def git(directory,*args):return subprocess.check_output(['git','-C',str(directory),*args],text=True).strip()
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def dump(name,value):
 with (evidence/name).open('x') as f:json.dump(value,f,indent=2);f.write('\n')
def source():
 assert git(native,'rev-parse','HEAD')==pin['commit'],'wrong native commit'
 assert git(native,'rev-parse','HEAD^{tree}')==pin['tree'],'wrong native tree'
 assert git(native,'status','--porcelain')=='','native source changed'
 for path,digest in pin['files'].items():assert sha(native/path)==digest,path
 return {'nativeCommit':pin['commit'],'nativeTree':pin['tree'],'files':pin['files'],'cargoLockSHA256':sha(native/'cli/Cargo.lock')}
assert pins['schemaVersion']==1 and pins['repository']=='levicode/agent-browser'
assert pins['toolchain']=='1.99.1' and pins['profile']=='ci' and pins['features']==[]
assert re.fullmatch('[0-9a-f]{40}',pin['commit']) and pin['commit']!='0'*40,'unresolved or invalid native commit'
assert re.fullmatch('[0-9a-f]{40}',pin['tree'])
if a.command=='prepare':
 assert git(root,'status','--porcelain')=='','producer checkout must be clean'
 evidence.mkdir(parents=True,exist_ok=False)
 producer={'stage':a.stage,'runId':os.environ['GITHUB_RUN_ID'],'runAttempt':os.environ['GITHUB_RUN_ATTEMPT'],'producerCommit':git(root,'rev-parse','HEAD'),'producerTree':git(root,'rev-parse','HEAD^{tree}'),'pinsSHA256':sha(here/'pins.json'),'runnerSHA256':sha(here/'run-stage.py'),'ciSHA256':sha(pathlib.Path(__file__)),'controlsPatchSHA256':pins['controlsPatchSHA256'],'fixPatchSHA256':pins['fixPatchSHA256']}
 dump('producer.json',producer)
 with open(os.environ['GITHUB_OUTPUT'],'a') as f:f.write('native_commit='+pin['commit']+'\n')
elif a.command=='verify-source':dump('source-before.json',source())
elif a.command=='select-executable':
 candidates=[]
 for line in (evidence/'cargo-artifacts.jsonl').read_text().splitlines():
  row=json.loads(line)
  if row.get('reason')=='compiler-artifact' and row.get('target',{}).get('name')=='agent-browser' and 'bin' in row.get('target',{}).get('kind',[]) and row.get('profile',{}).get('test') is True and row.get('executable'):
   assert row.get('features')==[],'nonordinary test artifact';candidates.append(row)
 assert len(candidates)==1,'require exactly one freshly compiled ordinary test executable'
 row=candidates[0];exe=pathlib.Path(row['executable']).resolve(strict=True);target=pathlib.Path(os.environ['CARGO_TARGET_DIR']).resolve(strict=True)
 assert exe.is_relative_to(target) and exe.is_file(),'executable outside fresh target'
 dump('test-binary.json',{'sha256':sha(exe),'targetName':row['target']['name'],'features':row['features'],'profile':row['profile'],'relativePath':str(exe.relative_to(target))})
 with open(os.environ['GITHUB_OUTPUT'],'a') as f:f.write('executable='+str(exe)+'\n')
elif a.command=='postcheck':
 dump('source-after.json',source());assert git(root,'diff','HEAD','--name-only')=='','producer tracked source changed'
 producer=json.loads((evidence/'producer.json').read_text());assert producer['producerCommit']==git(root,'rev-parse','HEAD') and producer['producerTree']==git(root,'rev-parse','HEAD^{tree}')
 for filename,key in [('pins.json','pinsSHA256'),('run-stage.py','runnerSHA256'),('ci.py','ciSHA256')]:assert sha(here/filename)==producer[key]
 receipt=json.loads((evidence/'controls/receipt.json').read_text());binary=json.loads((evidence/'test-binary.json').read_text());assert sha(pathlib.Path(os.environ['CARGO_TARGET_DIR'])/binary['relativePath'])==binary['sha256'],'test executable changed';assert receipt['accepted'] is True and receipt['stage']==a.stage and receipt['binarySHA256']==binary['sha256']
 with open(os.environ['GITHUB_OUTPUT'],'a') as f:f.write('accepted=true\n')
