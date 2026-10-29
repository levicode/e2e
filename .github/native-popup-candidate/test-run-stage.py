"""Pure fake controls only. Never start a Rust/native/browser/socket process."""
import contextlib,hashlib,importlib.util,io,json,os,pathlib,runpy,shutil,subprocess,sys,tempfile
from unittest.mock import patch
p=pathlib.Path(__file__).with_name('run-stage.py');s=importlib.util.spec_from_file_location('gate',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
b='ack-before-complete-retained'
preparation='Some(Object {"generation": Number(1), "operationSeq": Number(39), "session": String("capture-popup-session"), "target": String("capture-popup")})'
marker='POPUP_PREPARATION_C0_WITNESS boundary='+b+' application_evaluate_dispatches=1 cleanup=joined preparation='+preparation+'\n'
summary='\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 123 filtered out; finished in 0.01s\n'
plain='running 1 test\ntest exact::name ... ok\n'+summary
good='running 1 test\ntest exact::name ... '+marker+'ok\n'+summary
assert m.accepted_log(0,good,b);assert m.accepted_log(0,plain)
checks=2
bad=[(101,good,b),(1,good,b),(None,good,b),(0,'timeout',b),(0,good.replace('cleanup=joined','cleanup=failed'),b),(0,good.replace('dispatches=1','dispatches=0'),b),(0,good.replace('dispatches=1','dispatches=2'),b),(0,good.replace('preparation='+preparation,'preparation=None'),b),(0,good.replace('Number(39)','Number(0)'),b),(0,good.replace('Number(1)','Number(2)'),b),(0,good.replace('capture-popup-session','wrong-session'),b),(0,good.replace('"target": String("capture-popup")','"target": String("other")'),b),(0,good.replace('"target": String("capture-popup")','"foreign": String("capture-popup")'),b),(0,good.replace('"generation": Number(1)','"generation": Number(1), "generation": Number(1)'),b),(0,good.replace('Number(39)','Number(9007199254740992)'),b),(0,good+marker,b),(0,good+'POPUP_CAPTURE_BASELINE_WITNESS',b),(0,good,'other'),(0,plain,b),(0,good,None),(0,plain.replace('1 passed; 0 failed; 0 ignored','0 passed; 0 failed; 1 ignored'),None),(0,plain.replace('0 failed','1 failed'),None),(0,plain.replace('running 1 test','running 0 tests'),None),(0,plain+summary,None),(0,plain.replace('test result: ok.','test result: FAILED.'),None),(0,good.replace('Number(39)','Number(true)'),b)]
for code,log,boundary in bad:assert not m.accepted_log(code,log,boundary),(code,log,boundary);checks+=1
assert m.matched_preparation('Some(Object {"target": String("capture-popup"), "session": String("capture-popup-session"), "operationSeq": Number(39), "generation": Number(1)})');checks+=1
print('PASS',checks,'exact candidate PASS/C0 oracle positive and adversarial fake controls')
# Exercise independent always-run custody: source failure cannot hide binary failure.
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);here=root/'gate';here.mkdir();ev=root/'evidence';ev.mkdir();target=root/'target';target.mkdir();native=root/'native-source';native.mkdir()
 (native/'proof.rs').write_text('actual source');(target/'fake-binary').write_bytes(b'actual binary')
 pins={'schemaVersion':1,'repository':'levicode/agent-browser','toolchain':'1.99.1','profile':'ci','features':[],'commit':'a'*40,'tree':'b'*40,'files':{'proof.rs':'0'*64}}
 (here/'pins.json').write_text(json.dumps(pins));shutil.copyfile(p.with_name('ci.py'),here/'ci.py')
 (ev/'test-binary.json').write_text(json.dumps({'relativePath':'fake-binary','sha256':'0'*64}))
 def git_fake(argv,**kwargs):return ('c'*40+'\n') if 'rev-parse' in argv else ' M proof.rs\n'
 with patch.dict(os.environ,{'GITHUB_WORKSPACE':str(root),'GATE_EVIDENCE':str(ev),'CARGO_TARGET_DIR':str(target)}),patch.object(sys,'argv',['ci.py','audit','--gate','controls']),patch('subprocess.check_output',side_effect=git_fake):
  try:runpy.run_path(str(here/'ci.py'),run_name='__main__')
  except SystemExit as e:assert e.code==1
  else:raise AssertionError('bad custody accepted')
 proof=json.loads((ev/'custody-after.json').read_text());assert not proof['sourceVerified'] and proof['binary']['actual']==hashlib.sha256(b'actual binary').hexdigest() and not proof['binary']['matches']
print('PASS independent failed-source and failed-binary custody collection')
# Run-stage fake collection, success, ignored selection, timeout and overflow
# invoke only mocked subprocess.run, using inert bytes as the purported binary.
pins=json.loads(p.with_name('pins.json').read_text())
for mode in ['pass','ignored','timeout','overflow','missing-collection','wrong-c0','arbitrary-fail']:
 with tempfile.TemporaryDirectory() as tmp:
  root=pathlib.Path(tmp);exe=root/'inert';exe.write_bytes(b'not executable; never executed');out=root/'out'
  def fake_run(argv,stdout,**kwargs):
   if '--list' in argv:
    names=pins['tests']+pins['excludedBaselineOnlyWitnesses'];data='\n'.join(t+': test' for t in names)+'\n'
    if mode=='missing-collection':data=data.replace(pins['tests'][0]+': test\n','')
    code=0
   else:
    test=argv[1];boundary=pins['c0Boundaries'].get(test)
    data=good.replace(b,boundary) if boundary else plain;code=0
    if test==pins['tests'][0]:
     if mode=='ignored':data=plain.replace('1 passed; 0 failed; 0 ignored','0 passed; 0 failed; 1 ignored')
     if mode=='overflow':data+='x'*(1024*1024)
     if mode=='timeout':stdout.write(b'partial');stdout.flush();raise subprocess.TimeoutExpired(argv,45)
     if mode=='arbitrary-fail':code=101
    if mode=='wrong-c0' and boundary:data=data.replace('dispatches=1','dispatches=0')
   stdout.write(data.encode());stdout.flush();return subprocess.CompletedProcess(argv,code)
  with patch.object(sys,'argv',['run-stage.py','--executable',str(exe),'--output',str(out)]),patch('subprocess.run',side_effect=fake_run):
   try:m.main()
   except AssertionError:assert mode!='pass'
   else:assert mode=='pass'
  result=json.loads((out/'receipt.json').read_text());assert result['accepted']==(mode=='pass')
  if mode!='missing-collection':assert len(result['results'])==len(pins['tests'])
  if mode=='overflow':
   overflow=json.loads((out/'0.overflow.json').read_text());assert overflow['truncated'] and overflow['totalBytes']>overflow['retainedBytes']==1024*1024;assert (out/'0.log').stat().st_size==1024*1024
  if mode=='timeout':assert result['results'][0]['timedOut'] and result['results'][0]['returncode'] is None
print('PASS 7 fake runner paths: success, ignored, timeout, overflow, missing collection, bad C0, arbitrary failure; no native execution')
