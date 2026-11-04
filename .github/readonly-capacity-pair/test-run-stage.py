"""Pure oracle controls: subprocess.run is mocked for every call."""
import json, pathlib, runpy, subprocess, sys, tempfile, unittest.mock as mock
SCRIPT=pathlib.Path(__file__).with_name('run-stage.py')
NAMES=['native::cdp::client::tests::readonly_empty_group_acks_exhaust_cleanup_before_reference_admission','native::client_observation::tests::stopped_worlds_with_exact_release_ack_leave_fresh_fields_usable','native::client_observation::tests::cancelled_fresh_fields_resolve_retains_group_until_late_disposal_ack','native::client_observation::tests::stopped_worlds_without_release_ack_do_not_poison_later_fresh_fields']
MARKER='READONLY_CAPACITY_BASELINE_WITNESS cleanup_commands=32 object_debt=1 input_debt=0 resolve_count=1 sample_count=1'
INVARIANT='stopped before DOM.resolveNode: empty cleanup must not exhaust later real-group disposal capacity'
CASES=[('baseline','valid',True),('candidate','valid',True),('baseline','missing-marker',False),('baseline','wrong-failure',False),('baseline','all-green',False),('candidate','red',False),('candidate','missing-test',False),('baseline','timeout',False)]
for stage,mode,expected in CASES:
 with tempfile.TemporaryDirectory() as tmp:
  root=pathlib.Path(tmp);exe=root/'not-executed';exe.write_bytes(b'pure fake binary identity');out=root/'out'
  def fake(args,**_kwargs):
   if '--list' in args:
    names=NAMES if mode!='missing-test' else NAMES[:-1]
    return subprocess.CompletedProcess(args,0,('\n'.join(n+': test' for n in names)).encode())
   index=NAMES.index(args[1]);red=index==3 and (stage=='baseline' and mode!='all-green' or mode=='red')
   if mode=='timeout' and index==3:raise subprocess.TimeoutExpired(args,30,output=b'')
   log='test result: ok. 1 passed; 0 failed;'
   if red:log=(MARKER if mode!='missing-marker' else '')+'\n'+(INVARIANT if mode!='wrong-failure' else 'other')+'\nfailures:\n    '+NAMES[3]+'\ntest result: FAILED. 0 passed; 1 failed;'
   return subprocess.CompletedProcess(args,101 if red else 0,log.encode())
  accepted=True
  with mock.patch.object(sys,'argv',[str(SCRIPT),'--stage',stage,'--executable',str(exe),'--output',str(out)]),mock.patch('subprocess.run',side_effect=fake):
   try:runpy.run_path(str(SCRIPT),run_name='__main__')
   except (AssertionError,RuntimeError):accepted=False
  assert accepted==expected,(stage,mode,accepted)
  assert json.load(open(out/'receipt.json'))['accepted']==expected
print('8 pure mocked oracle controls passed; zero subprocesses executed')
