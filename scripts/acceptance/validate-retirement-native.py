#!/usr/bin/env python3
"""Run only in an authorized isolated candidate, never called by local review.
Requires installed Rust1.99.1, Node and locked deps; no browser, install or CI.
"""
import argparse,subprocess,pathlib,json,os,hashlib,time
p=argparse.ArgumentParser();p.add_argument('--native-root',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);p.add_argument('--target-dir',type=pathlib.Path,required=True);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
expected='23d4de87258f4635e92abdc5b554d278f5a20f8a';tests=json.loads(pathlib.Path(__file__).with_name('retirement-native-exact-tests.json').read_text());env={**os.environ,'RUST_MIN_STACK':'16777216','CARGO_TARGET_DIR':str(a.target_dir.resolve())};sha=lambda x:hashlib.sha256(x).hexdigest()
def git(*v):return subprocess.check_output(['git','-C',str(a.native_root),*v])
def snapshot():
 assert git('write-tree').decode().strip()==expected
 rows=[]
 for row in git('ls-files','-s').decode().splitlines():
  meta,path=row.split('\t');mode,oid,stage=meta.split();f=a.native_root/path;b=os.readlink(f).encode() if mode=='120000' else f.read_bytes();assert hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()==oid,path;rows.append({'path':path,'sha256':sha(b),'bytes':len(b)})
 return {'tree':expected,'files':rows}
assert subprocess.check_output(['rustc','--version'],env=env).decode().startswith('rustc 1.99.1 ')
subprocess.run(['node','--version'],check=True,env=env)
before=snapshot();(a.output/'source-before.json').write_text(json.dumps(before)+'\n')
command=['cargo','test','--locked','-j','2','--profile','ci','--no-default-features','--bin','agent-browser','--no-run','--message-format=json']
with (a.output/'compile.jsonl').open('wb') as out,(a.output/'compile.stderr').open('wb') as err:code=subprocess.run(command,cwd=a.native_root/'cli',env=env,stdout=out,stderr=err).returncode
assert code==0,'new-tree compilation failed; do not reuse old harness'
artifacts=[]
for line in (a.output/'compile.jsonl').read_text().splitlines():
 try:r=json.loads(line)
 except ValueError:continue
 if r.get('reason')=='compiler-artifact' and r.get('target',{}).get('name')=='agent-browser' and r.get('profile',{}).get('test') and r.get('executable'):artifacts.append(r['executable'])
assert len(set(artifacts))==1,artifacts
binary=pathlib.Path(artifacts[-1]);digest=sha(binary.read_bytes());listed=subprocess.check_output([str(binary),'--list'],env=env,text=True);available={line[:-6] for line in listed.splitlines() if line.endswith(': test')};assert all(t in available for t in tests)
receipts=[]
for i,test in enumerate(tests):
 assert snapshot()==before and sha(binary.read_bytes())==digest
 command=[str(binary),test,'--exact','--nocapture','--test-threads=1'];start=time.time();log=a.output/f'exact-{i:02}.log'
 with log.open('wb') as f:code=subprocess.run(command,cwd=a.native_root/'cli',env=env,stdout=f,stderr=subprocess.STDOUT).returncode
 result=log.read_text();assert code==0 and '1 passed; 0 failed; 0 ignored' in result,(test,code)
 assert snapshot()==before and sha(binary.read_bytes())==digest
 receipts.append({'test':test,'exit':code,'seconds':time.time()-start,'tree':expected,'harnessSha256':digest,'log':log.name,'logSha256':sha(log.read_bytes())});(a.output/'receipts.json').write_text(json.dumps(receipts,indent=2)+'\n')
with (a.output/'detach-controls.log').open('wb') as log:
 code=subprocess.run(['node','--test',str(a.native_root/'cli/tests/fixtures/native-action-detach-witness.test.cjs')],env=env,stdout=log,stderr=subprocess.STDOUT).returncode
assert code==0 and 'pass 8' in (a.output/'detach-controls.log').read_text()
after=snapshot();assert after==before;(a.output/'source-after.json').write_text(json.dumps(after)+'\n');print('34 exact native tests and8 pure detach controls completed on exact candidate tree',expected)
