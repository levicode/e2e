"""Pure oracle checks: every subprocess call is mocked; no native execution."""
import json, pathlib, runpy, subprocess, sys, tempfile, unittest.mock as mock
SCRIPT=pathlib.Path(__file__).with_name('run-stage.py');NAMES=json.loads(SCRIPT.with_name('pins.json').read_text())['tests']
CASES=[('valid',True),('nonzero',False),('zero-tests',False),('red-marker',False),('missing-test',False),('duplicate-test',False),('timeout',False),('oversized',False)]
for mode,expected in CASES:
 with tempfile.TemporaryDirectory() as tmp:
  root=pathlib.Path(tmp);exe=root/'not-executed';exe.write_bytes(b'pure fake binary');out=root/'out'
  def fake(args,**kwargs):
   assert kwargs['timeout']==30
   if '--list' in args:
    names=NAMES[:-1] if mode=='missing-test' else NAMES+[NAMES[0]] if mode=='duplicate-test' else NAMES
    return subprocess.CompletedProcess(args,0,('\n'.join(n+': test' for n in names)).encode())
   assert args[1] in NAMES and args[2:]==['--exact','--nocapture','--test-threads=1']
   if mode=='timeout':raise subprocess.TimeoutExpired(args,30,output=b'')
   log='test result: ok. 1 passed; 0 failed;'
   if mode=='zero-tests':log='test result: ok. 0 passed; 0 failed;'
   if mode=='red-marker':log+=' READONLY_CAPACITY_BASELINE_WITNESS'
   if mode=='oversized':log='x'*(1024*1024+1)
   return subprocess.CompletedProcess(args,101 if mode=='nonzero' else 0,log.encode())
  accepted=True
  with mock.patch.object(sys,'argv',[str(SCRIPT),'--executable',str(exe),'--output',str(out)]),mock.patch('subprocess.run',side_effect=fake):
   try:runpy.run_path(str(SCRIPT),run_name='__main__')
   except (AssertionError,RuntimeError):accepted=False
  assert accepted==expected,(mode,accepted)
  receipt=json.loads((out/'receipt.json').read_text());assert receipt['accepted']==expected
  if expected:assert [x['test'] for x in receipt['results']]==NAMES
print('8 mocked oracle controls passed; zero native subprocesses executed')
