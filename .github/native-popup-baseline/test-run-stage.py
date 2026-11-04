import importlib.util,json,pathlib
p=pathlib.Path(__file__).with_name('run-stage.py');s=importlib.util.spec_from_file_location('gate',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
b='ack-before-complete-retained';f={'p':[1,0,1,0,1,1,0,1],'t':[1,1,0],'h':[0,0,1],'v':42,'e':8}
r=[{'generation':1,'operationSeq':39,'facts':dict(f,s='entry',c='entry',w='equal')},{'generation':1,'operationSeq':39,'facts':dict(f,s='capture',c='pending',w='unk')}]
marker='POPUP_CAPTURE_BASELINE_WITNESS boundary='+b+' error=scope-unavailable effects=not-dispatched application_evaluate_dispatches=0 cleanup=joined receipts='+json.dumps(r)+'\n'
passed=marker+'test result: ok. 1 passed; 0 failed;'
red=marker+'baseline capture/pending refusal, not a matched preparation wait\ntest result: FAILED. 0 passed; 1 failed;'
assert m.accepted_log(0,passed,0,b);assert m.accepted_log(101,red,101,b)
for code,log,want in [(1,red,101),(101,'timeout',101),(101,red.replace('cleanup=joined','cleanup=failed'),101),(101,red.replace('effects=not-dispatched','effects=unknown'),101),(101,red.replace('application_evaluate_dispatches=0','application_evaluate_dispatches=1'),101),(101,red.replace('pending','other'),101),(101,red+marker,101),(101,red+'POPUP_PREPARATION_C0_WITNESS',101),(0,red,0),(101,passed,101)]:assert not m.accepted_log(code,log,want,b)
for change in [lambda x:x[1].update(operationSeq=40),lambda x:x[1]['facts'].update(c='other'),lambda x:x[1]['facts'].update(v=43),lambda x:x[0]['facts'].update(p=[0]*8)]:
 x=json.loads(json.dumps(r));change(x);bad=red.replace(json.dumps(r),json.dumps(x));assert not m.accepted_log(101,bad,101,b)
print('PASS 16 exact causal-oracle positive/negative pure controls; no native execution')
# Exercise always-run audit independently: bad source must not hide bad binary.
import contextlib,hashlib,io,os,runpy,shutil,sys,tempfile
from unittest.mock import patch
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);here=root/'gate';here.mkdir();ev=root/'evidence';ev.mkdir();target=root/'target';target.mkdir();native=root/'native-source';native.mkdir()
 (native/'proof.rs').write_text('actual source');(target/'fake-binary').write_bytes(b'actual binary')
 pins={'schemaVersion':1,'repository':'levicode/agent-browser','toolchain':'1.99.1','profile':'ci','features':[],'commit':'a'*40,'tree':'b'*40,'files':{'proof.rs':'0'*64}}
 (here/'pins.json').write_text(json.dumps(pins));shutil.copyfile(p.with_name('ci.py'),here/'ci.py')
 (ev/'test-binary.json').write_text(json.dumps({'relativePath':'fake-binary','sha256':'0'*64}))
 def git_fake(argv,**kwargs):
  return ('c'*40+'\n') if 'rev-parse' in argv else ' M proof.rs\n'
 with patch.dict(os.environ,{'GITHUB_WORKSPACE':str(root),'GATE_EVIDENCE':str(ev),'CARGO_TARGET_DIR':str(target)}),patch.object(sys,'argv',['ci.py','audit','--gate','controls']),patch('subprocess.check_output',side_effect=git_fake):
  try:runpy.run_path(str(here/'ci.py'),run_name='__main__')
  except SystemExit as e:assert e.code==1
  else:raise AssertionError('bad custody accepted')
 proof=json.loads((ev/'custody-after.json').read_text());assert not proof['sourceVerified'] and proof['binary']['actual']==hashlib.sha256(b'actual binary').hexdigest() and not proof['binary']['matches']
print('PASS independent failure-path source and binary custody collection')
