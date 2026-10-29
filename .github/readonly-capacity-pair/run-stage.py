#!/usr/bin/env python3
"""Hosted-only finite oracle runner. Does not build, fetch, publish, or start a browser."""
import argparse, hashlib, json, pathlib, subprocess
p=argparse.ArgumentParser();p.add_argument('--stage',choices=['baseline','candidate'],required=True);p.add_argument('--executable',required=True);p.add_argument('--output',required=True);a=p.parse_args()
exe=pathlib.Path(a.executable).resolve(strict=True);out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=False)
tests=[
'native::cdp::client::tests::readonly_empty_group_acks_exhaust_cleanup_before_reference_admission',
'native::client_observation::tests::stopped_worlds_with_exact_release_ack_leave_fresh_fields_usable',
'native::client_observation::tests::cancelled_fresh_fields_resolve_retains_group_until_late_disposal_ack',
'native::client_observation::tests::stopped_worlds_without_release_ack_do_not_poison_later_fresh_fields',
]
marker='READONLY_CAPACITY_BASELINE_WITNESS cleanup_commands=32 object_debt=1 input_debt=0 resolve_count=1 sample_count=1'
invariant='stopped before DOM.resolveNode: empty cleanup must not exhaust later real-group disposal capacity'
receipt={'stage':a.stage,'binarySHA256':hashlib.sha256(exe.read_bytes()).hexdigest(),'results':[],'accepted':False}
def save(): (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
def call(args,name):
 try:
  r=subprocess.run([str(exe),*args],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30,check=False)
 except subprocess.TimeoutExpired as error:
  data=error.stdout or b'';(out/(name+'.log')).write_bytes(data[:1024*1024]);raise RuntimeError('test process timeout is not causal RED') from None
 if len(r.stdout)>1024*1024: raise RuntimeError('bounded test log exceeded; not causal RED')
 (out/(name+'.log')).write_bytes(r.stdout)
 return r.returncode,r.stdout.decode('utf-8',errors='strict')
try:
 code,listing=call(['--list','--format','terse'],'collection')
 assert code==0,'test collection failed'
 for test in tests: assert listing.splitlines().count(test+': test')==1, 'missing or duplicate exact test'
 for index,test in enumerate(tests):
  code,log=call([test,'--exact','--nocapture','--test-threads=1'],str(index))
  expected_red=a.stage=='baseline' and index==3
  if expected_red:
   # --nocapture inserts output between the test name and FAILED. Require the
   # exact failure list entry rather than relying on adjacency of progress text.
   accepted=(code==101 and marker in log and invariant in log and 'test result: FAILED. 0 passed; 1 failed;' in log and '\n    '+test+'\n' in log)
  else:
   accepted=(code==0 and 'test result: ok. 1 passed; 0 failed;' in log and marker not in log)
  receipt['results'].append({'test':test,'returncode':code,'expectedCausalRed':expected_red,'accepted':accepted,'logSHA256':hashlib.sha256(log.encode()).hexdigest()});save()
  assert accepted,'unexpected oracle; do not reinterpret or rerun until green'
 receipt['accepted']=True;save()
finally: save()
