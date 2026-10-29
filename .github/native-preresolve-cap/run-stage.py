#!/usr/bin/env python3
"""Finite hosted native controls, all expected PASS; not browser acceptance."""
import argparse, hashlib, json, pathlib, subprocess
p=argparse.ArgumentParser();p.add_argument('--executable',required=True);p.add_argument('--output',required=True);a=p.parse_args()
pins=json.loads(pathlib.Path(__file__).with_name('pins.json').read_text());tests=pins['tests']
assert len(tests)==15 and len(set(tests))==15
exe=pathlib.Path(a.executable).resolve(strict=True);out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=False)
receipt={'binarySHA256':hashlib.sha256(exe.read_bytes()).hexdigest(),'results':[],'accepted':False,'expected':'all15PASS'}
def save(): (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
def call(args,name):
 try:r=subprocess.run([str(exe),*args],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30,check=False)
 except subprocess.TimeoutExpired as error:
  (out/(name+'.log')).write_bytes((error.stdout or b'')[:1024*1024]);raise RuntimeError('test process timeout is a failure') from None
 if len(r.stdout)>1024*1024:raise RuntimeError('test log exceeded retained limit')
 (out/(name+'.log')).write_bytes(r.stdout)
 return r.returncode,r.stdout.decode('utf-8',errors='strict')
try:
 code,listing=call(['--list','--format','terse'],'collection');assert code==0,'test collection failed'
 for test in tests:assert listing.splitlines().count(test+': test')==1,'missing or duplicate exact test'
 for index,test in enumerate(tests):
  code,log=call([test,'--exact','--nocapture','--test-threads=1'],str(index))
  accepted=(code==0 and 'test result: ok. 1 passed; 0 failed;' in log and 'READONLY_CAPACITY_BASELINE_WITNESS' not in log)
  receipt['results'].append({'test':test,'returncode':code,'accepted':accepted,'logSHA256':hashlib.sha256(log.encode()).hexdigest()});save()
  assert accepted,'unexpected native control failure; inspect evidence before changes'
 receipt['accepted']=True;save()
finally:save()
