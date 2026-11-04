#!/usr/bin/env python3
"""Exact candidate controls: every selected test must PASS, never arbitrary failure."""
import argparse,hashlib,json,pathlib,re,subprocess

C0_MARKER='POPUP_PREPARATION_C0_WITNESS'
BASELINE_MARKER='POPUP_CAPTURE_BASELINE_WITNESS'

def matched_preparation(value):
 # This is the pinned Rust Debug output of Option<serde_json::Value>, not eval.
 match=re.fullmatch(r'Some\(Object \{(.+)\}\)',value)
 if not match:return False
 fields={};pieces=match[1].strip().split(', ')
 for piece in pieces:
  item=re.fullmatch(r'"(generation|operationSeq|session|target)": (Number\(([1-9][0-9]*)\)|String\("(capture-popup(?:-session)?)"\))',piece)
  if not item or item[1] in fields:return False
  fields[item[1]]=int(item[3]) if item[3] else item[4]
 return (set(fields)=={'generation','operationSeq','session','target'} and fields['generation']==1
         and type(fields['operationSeq']) is int and 0<fields['operationSeq']<(1<<53)
         and fields['session']=='capture-popup-session' and fields['target']=='capture-popup')

def accepted_log(code,log,boundary=None):
 if code!=0 or BASELINE_MARKER in log:return False
 if len(re.findall(r'^running 1 test$',log,re.M))!=1:return False
 summaries=re.findall(r'^test result: ([^\n]+)$',log,re.M)
 if len(summaries)!=1 or not re.fullmatch(r'ok\. 1 passed; 0 failed; 0 ignored; 0 measured; [0-9]+ filtered out; finished in [0-9.]+s',summaries[0]):return False
 if boundary is None:return C0_MARKER not in log
 if log.count(C0_MARKER)!=1:return False
 rows=re.findall(r'POPUP_PREPARATION_C0_WITNESS boundary=([^ ]+) application_evaluate_dispatches=([0-9]+) cleanup=([^ ]+) preparation=([^\n]+)',log)
 return len(rows)==1 and rows[0][:3]==(boundary,'1','joined') and matched_preparation(rows[0][3])

def main():
 p=argparse.ArgumentParser();p.add_argument('--executable',required=True);p.add_argument('--output',required=True);a=p.parse_args()
 pins=json.loads(pathlib.Path(__file__).with_name('pins.json').read_text());tests=pins['tests']
 assert len(tests)==len(set(tests))>2 and pins['expectedCodes']==[0]*len(tests)
 assert len(pins['c0Boundaries'])==2 and set(pins['c0Boundaries'])<=set(tests)
 assert len(pins['excludedBaselineOnlyWitnesses'])==2 and not set(pins['excludedBaselineOnlyWitnesses'])&set(tests)
 assert pins['perTestTimeoutSeconds']==45 and pins['logRetainedBytes']==1024*1024
 exe=pathlib.Path(a.executable).resolve(strict=True);out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=False)
 receipt={'binarySHA256':hashlib.sha256(exe.read_bytes()).hexdigest(),'results':[],'accepted':False,'expected':'allSelectedPASS; twoExactC0MatchedWaitSingleDispatchJoinedCleanup'}
 def save():(out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 def call(args,name):
  # File-backed capture avoids holding arbitrary test output in memory. Retain
  # only the bounded prefix, plus total length/full digest if truncation occurs.
  log_path=out/(name+'.log');timed_out=False
  with log_path.open('xb') as log_file:
   try:r=subprocess.run([str(exe),*args],stdout=log_file,stderr=subprocess.STDOUT,timeout=45,check=False)
   except subprocess.TimeoutExpired:timed_out=True;r=None
  size=log_path.stat().st_size;digest=hashlib.sha256()
  with log_path.open('rb') as f:
   for chunk in iter(lambda:f.read(65536),b''):digest.update(chunk)
  if size>1024*1024:
   with log_path.open('r+b') as f:f.truncate(1024*1024)
   (out/(name+'.overflow.json')).write_text(json.dumps({'truncated':True,'totalBytes':size,'retainedBytes':1024*1024,'fullSHA256':digest.hexdigest(),'timedOut':timed_out})+'\n')
  return (None if timed_out else r.returncode),log_path.read_bytes().decode('utf-8',errors='strict'),timed_out,size>1024*1024
 try:
  code,listing,timed,overflow=call(['--list','--format','terse'],'collection');assert code==0 and not timed and not overflow
  for t in tests+pins['excludedBaselineOnlyWitnesses']:assert listing.splitlines().count(t+': test')==1,'missing/duplicate exact test'
  receipt['collectionSHA256']=hashlib.sha256(listing.encode()).hexdigest();save()
  for i,t in enumerate(tests):
   # No --include-ignored: baseline-only refusal witnesses stay ignored in the
   # ordinary binary, while all selected controls must actually run once.
   code,log,timed,overflow=call([t,'--exact','--nocapture','--test-threads=1'],str(i));ok=not timed and not overflow and accepted_log(code,log,pins['c0Boundaries'].get(t))
   receipt['results'].append({'test':t,'returncode':code,'expectedCode':0,'accepted':ok,'timedOut':timed,'overflow':overflow,'logSHA256':hashlib.sha256(log.encode()).hexdigest()});save()
  assert all(row['accepted'] for row in receipt['results']),'selected control did not meet exact PASS oracle'
  receipt['accepted']=True;save()
 finally:save()
if __name__=='__main__':main()
