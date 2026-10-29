#!/usr/bin/env python3
"""Exact baseline witnesses and expected-RED C0; never accept arbitrary failure."""
import argparse,hashlib,json,pathlib,re,subprocess

def accepted_log(code,log,expected,boundary):
 if code!=expected or 'POPUP_PREPARATION_C0_WITNESS' in log:return False
 rows=re.findall(r'POPUP_CAPTURE_BASELINE_WITNESS boundary=([^ ]+) error=scope-unavailable effects=not-dispatched application_evaluate_dispatches=0 cleanup=joined receipts=(\[[^\n]+\])',log)
 if len(rows)!=1 or rows[0][0]!=boundary:return False
 try:
  r=json.loads(rows[0][1]);assert len(r)==2
  for x in r:
   assert x['generation']==1 and type(x['operationSeq']) is int and x['operationSeq']>0
   assert x['facts']['p']==[1,0,1,0,1,1,0,1] and x['facts']['t']==[1,1,0] and x['facts']['h']==[0,0,1]
  assert r[0]['operationSeq']==r[1]['operationSeq']
  assert r[0]['facts']['v']==r[1]['facts']['v'] and r[0]['facts']['e']==r[1]['facts']['e']
  assert r[0]['facts']['s']=='entry' and r[0]['facts']['c']=='entry' and r[0]['facts']['w']=='equal'
  assert r[1]['facts']['s']=='capture' and r[1]['facts']['c']=='pending'
 except (ValueError,KeyError,TypeError,AssertionError):return False
 if expected==0:return 'test result: ok. 1 passed; 0 failed;' in log
 return (expected==101 and 'test result: FAILED. 0 passed; 1 failed;' in log and 'baseline capture/pending refusal, not a matched preparation wait' in log)

def main():
 p=argparse.ArgumentParser();p.add_argument('--executable',required=True);p.add_argument('--output',required=True);a=p.parse_args()
 pins=json.loads(pathlib.Path(__file__).with_name('pins.json').read_text());tests=pins['tests']
 assert len(tests)==len(set(tests))==4 and pins['expectedCodes']==[0,0,101,101]
 exe=pathlib.Path(a.executable).resolve(strict=True);out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=False)
 receipt={'binarySHA256':hashlib.sha256(exe.read_bytes()).hexdigest(),'results':[],'accepted':False,'expected':'2PASS+2exactBaselineRED'}
 def save():(out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 def call(args,name):
  try:r=subprocess.run([str(exe),*args],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=45,check=False)
  except subprocess.TimeoutExpired as e:
   (out/(name+'.log')).write_bytes((e.stdout or b'')[:1024*1024]);raise RuntimeError('timeout is not causal RED') from None
  if len(r.stdout)>1024*1024:
   (out/(name+'.log')).write_bytes(r.stdout[:1024*1024])
   (out/(name+'.overflow.json')).write_text(json.dumps({'truncated':True,'totalBytes':len(r.stdout),'retainedBytes':1024*1024,'fullSHA256':hashlib.sha256(r.stdout).hexdigest()}))
   raise RuntimeError('log exceeds retention limit; bounded prefix and overflow receipt retained')
  (out/(name+'.log')).write_bytes(r.stdout);return r.returncode,r.stdout.decode('utf-8',errors='strict')
 try:
  code,listing=call(['--list','--format','terse'],'collection');assert code==0
  for t in tests:assert listing.splitlines().count(t+': test')==1,'missing/duplicate exact test'
  for i,(t,expected,boundary)in enumerate(zip(tests,pins['expectedCodes'],pins['boundaries'],strict=True)):
   code,log=call([t,'--exact','--include-ignored','--nocapture','--test-threads=1'],str(i));ok=accepted_log(code,log,expected,boundary)
   receipt['results'].append({'test':t,'returncode':code,'expectedCode':expected,'accepted':ok,'logSHA256':hashlib.sha256(log.encode()).hexdigest()});save()
   assert ok,'control did not meet exact causal oracle'
  receipt['accepted']=True;save()
 finally:save()
if __name__=='__main__':main()
