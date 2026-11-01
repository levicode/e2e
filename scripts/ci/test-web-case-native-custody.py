"""Pure temporary-file controls; fake native bytes are never executed."""
import copy,hashlib,importlib.util,json,os,pathlib,re,tempfile,unittest
from unittest.mock import patch
HERE=pathlib.Path(__file__).parent
spec=importlib.util.spec_from_file_location('web_capture',HERE/'check-web-case-native-custody.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
def write(p,value):
 p.parent.mkdir(parents=True,exist_ok=True,mode=0o700);p.write_bytes(value if isinstance(value,bytes) else (json.dumps(value,separators=(',',':'))+'\n').encode());p.chmod(0o600)
def fixture(workspace):
 e=workspace/'evidence';scripts=workspace/'scripts/ci';native=workspace/'fake-native';write(native,b'NEVER_EXECUTE');digest=hashlib.sha256(b'NEVER_EXECUTE').hexdigest();wrapper=b'WRAPPER_NEVER_EXECUTE';whash=hashlib.sha256(wrapper).hexdigest()
 for file,data in [('source.commit',b'a'*40+b'\n'),('source.tree',b'b'*40+b'\n'),('node.version',b'v24.8.0\n')]:write(e/file,data)
 write(e/'tools/web-native-trace.sh',wrapper);write(scripts/'native-trace-wrapper.sh',wrapper);write(scripts/'full-standard-runtime-pins.json',{'configured':True,'ordinary':{'binarySha256':digest}})
 expected={'run':'123','attempt':'1','selector':'24','nodeVersion':'v24.8.0','sourceCommit':'a'*40,'sourceTree':'b'*40};write(e/'fixtures/24/web/binding.json',{**expected,'lane':'web','nativeSha256':{'ordinary':digest}})
 (e/'web-case-native').mkdir(mode=0o700)
 results=[]
 for i,(case,(file,title)) in enumerate(c.CASES.items(),1):
  root=e/'web-case-native'/case;root.mkdir(mode=0o700);pid=100+i;daemon=200+i;nonce=str(i)*64
  project=root/('p-'+nonce[:12]);project.mkdir(mode=0o700);private=project/'.e2e';private.mkdir(mode=0o700);trace=private/'native-trace';trace.mkdir(mode=0o700)
  # Pure model of the actual native directory suffix guard, before a simulated mapping is authored.
  assert trace.is_absolute() and trace.name=='native-trace' and trace.parent.name=='.e2e' and re.fullmatch('p-[a-f0-9]{12}',trace.parent.parent.name)
  header={'schemaVersion':1,'caseId':case,'nonce':nonce,'traceDirectory':str(trace),**expected,'nativeExecutable':str(native),'nativeSHA256':digest,'wrapperSHA256':whash};write(root/'case.json',header);write(root/'finished.json',{'schemaVersion':1,'caseId':case,'nonce':nonce,'state':'scope-finished'})
  inv={'schemaVersion':2,'pid':pid,'nonce':str(i+3)*64,**{k:header[k] for k in ['traceDirectory','nativeExecutable','nativeSHA256','wrapperSHA256','run','attempt','sourceCommit','sourceTree']}};raw=(json.dumps(inv,separators=(',',':'))+'\n').encode();write(e/'fixture-invocations'/f'invocation-{pid}.json',raw);write(e/'fixture-invocations'/f'daemon-{pid}.json',{'schemaVersion':1,'kind':'spawn-owned-daemon','proxyPID':pid,'daemonPID':daemon,'nonce':inv['nonce'],'invocationSHA256':hashlib.sha256(raw).hexdigest()})
  start={'schemaVersion':2,'source':'native','pid':daemon,'record':0,'operationSeq':0,'phase':'CaptureStarted','droppedBefore':0,'emittedBefore':0,'suppressedBefore':0,'overflow':False};terminal={**start,'record':1,'emittedBefore':1,'phase':'TerminalCleanupCheckpoint','terminalCleanupStage':'shutdown-joins','terminalCleanupOk':False}
  write(trace/f'native-{pid}.jsonl',b''.join((json.dumps(x,separators=(',',':'))+'\n').encode() for x in [start,terminal]));write(trace/f'query-{pid}.jsonl',start)
  results.append({'name':str(workspace/'packages/web/tests/integration'/file),'assertionResults':[{'title':title,'status':'failed'}]})
 write(e/'web/ordinary/results.json',{'testResults':results});return e,{'GITHUB_WORKSPACE':str(workspace),'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','NODE_SELECTOR':'24'}
class Controls(unittest.TestCase):
 def test_three_owned_failed_cases_are_observed_not_business_pass(self):
  with tempfile.TemporaryDirectory() as d:
   e,env=fixture(pathlib.Path(d))
   with patch.dict(os.environ,env):p=c.verify(e)
   self.assertEqual(len(p['cases']),3);self.assertFalse(p['exhaustive']);self.assertTrue(p['noAbsenceInference']);self.assertTrue(all(x['originalBusinessStatus']=='failed' for x in p['cases']))
 def test_missing_mixed_unknown_partial_and_loss_refuse(self):
  for edit in ['missing-case','extra-case','wrong-case','unfinished','wrong-runtime','wrong-nonce','foreign-daemon','extra-invocation','extra-trace','unknown-field','loss','overflow','partial','missing-shutdown','wrong-node','wrong-result','wrong-source','reused-case-nonce','reused-invocation-nonce','old-layout','foreign-trace-directory','wrong-project-prefix','extra-private-entry','project-symlink','private-mode']:
   with self.subTest(edit=edit),tempfile.TemporaryDirectory() as d:
    e,env=fixture(pathlib.Path(d));root=e/'web-case-native/hung-recovery';project=root/('p-'+'1'*12);private=project/'.e2e';trace=private/'native-trace';p=trace/'native-101.jsonl'
    if edit=='missing-case':(root/'finished.json').unlink()
    elif edit=='extra-case':(e/'web-case-native/foreign').mkdir(mode=0o700)
    elif edit in ['wrong-case','wrong-runtime']:
     target=root/'case.json';row=json.loads(target.read_text());row['caseId' if edit=='wrong-case' else 'nativeSHA256']='foreign';write(target,row)
    elif edit=='unfinished':write(root/'finished.json',{})
    elif edit in ['wrong-nonce','foreign-daemon']:
     target=e/'fixture-invocations/daemon-101.json';row=json.loads(target.read_text());row['nonce' if edit=='wrong-nonce' else 'daemonPID']='f'*64 if edit=='wrong-nonce' else 202;write(target,row)
    elif edit=='reused-case-nonce':
     for file in ['case.json','finished.json']:
      target=e/'web-case-native/lifecycle-open-cancel'/file;row=json.loads(target.read_text());row['nonce']='1'*64;write(target,row)
    elif edit=='reused-invocation-nonce':
     target=e/'fixture-invocations/invocation-102.json';row=json.loads(target.read_text());row['nonce']='4'*64;write(target,row)
     mapped=e/'fixture-invocations/daemon-102.json';row=json.loads(mapped.read_text());row.update(nonce='4'*64,invocationSHA256=hashlib.sha256(target.read_bytes()).hexdigest());write(mapped,row)
    elif edit=='extra-invocation':write(e/'fixture-invocations/invocation-999.json',{})
    elif edit=='extra-trace':write(trace/'native-999.jsonl',{})
    elif edit=='old-layout':
     trace.rename(root/'trace');private.rmdir();project.rmdir()
     target=root/'case.json';row=json.loads(target.read_text());row['traceDirectory']=str(root/'trace');write(target,row)
    elif edit=='foreign-trace-directory':
     target=root/'case.json';row=json.loads(target.read_text());row['traceDirectory']=str(e/'web-case-native/lifecycle-open-cancel'/('p-'+'2'*12)/'.e2e/native-trace');write(target,row)
    elif edit=='wrong-project-prefix':project.rename(root/('p-'+'a'*12))
    elif edit=='extra-private-entry':write(private/'foreign',b'extra')
    elif edit=='project-symlink':
     foreign=e/'foreign';project.rename(foreign);project.symlink_to(foreign,target_is_directory=True)
    elif edit=='private-mode':private.chmod(0o755)
    elif edit=='partial':p.write_bytes(p.read_bytes().rstrip(b'\n'))
    elif edit=='wrong-node':env['NODE_SELECTOR']='26'
    elif edit=='wrong-source':env['GITHUB_SHA']='c'*40
    elif edit=='wrong-result':write(e/'web/ordinary/results.json',{'testResults':[]})
    else:
     rows=[json.loads(x) for x in p.read_text().splitlines()]
     if edit=='unknown-field':rows[-1]['payload']='PRIVATE_CANARY'
     elif edit=='loss':rows[-1]['droppedBefore']=1
     elif edit=='overflow':rows[-1]['overflow']=True
     elif edit=='missing-shutdown':rows=rows[:1]
     write(p,b''.join((json.dumps(x,separators=(',',':'))+'\n').encode() for x in rows))
    with patch.dict(os.environ,env),self.assertRaises((ValueError,OSError)):c.verify(e)
# Focused fixtures are mock files and mocked read-only Git facts, never native execution.
def hung_fixture(workspace):
 import shutil
 old,env=fixture(workspace)
 root=workspace/'.artifacts/hung-enrollment-diagnostic';root.mkdir(parents=True,mode=0o700)
 evidence=root/'evidence';old.rename(evidence)
 for case in ['lifecycle-open-cancel','popup-replacement']:shutil.rmtree(evidence/'web-case-native'/case)
 for pid in [102,103]:
  for prefix in ['invocation','daemon']:(evidence/'fixture-invocations'/f'{prefix}-{pid}.json').unlink()
 env.update(GITHUB_REPOSITORY='levicode/e2e',NODE_SELECTOR='26.13.0',E2E_WEB_THREE_CASE_NATIVE_CAPTURE='1',E2E_HUNG_DIAGNOSTIC_EVIDENCE_ROOT=str(evidence))
 expected={'run':'123','attempt':'1','selector':'26.13.0','nodeVersion':'v26.13.0','sourceCommit':'a'*40,'sourceTree':'b'*40}
 write(evidence/'node.version',b'v26.13.0\n')
 runtime=root/'native-runtime';native=runtime/'agent-browser';write(native,b'NEVER_EXECUTE');digest=c.v.sha(native.read_bytes())
 native_source=root/'native-source';target=root/'target/ci/agent-browser';write(target,b'NEVER_EXECUTE')
 write(native_source/'cli/Cargo.toml',b'NOT_A_CARGO_PROJECT');write(native_source/'cli/src/main.rs',b'NOT_RUST')
 compilation={'profile':'ci','features':[],'manifestPath':str(native_source/'cli/Cargo.toml'),'sourcePath':str(native_source/'cli/src/main.rs'),'executable':str(target)}
 compiler=[{'reason':'compiler-artifact','target':{'name':'agent-browser','kind':['bin'],'src_path':compilation['sourcePath']},'profile':{'test':False},'features':[],'manifest_path':compilation['manifestPath'],'executable':compilation['executable']},{'reason':'build-finished','success':True}]
 write(runtime/'compiler.jsonl',b''.join((json.dumps(row)+'\n').encode() for row in compiler));write(runtime/'rustc.txt',b'MOCK RUSTC NEVER RUN\n')
 manifest={'schemaVersion':1,'kind':'source-built-ci-runtime','acceptanceEvidence':False,'source':{'commit':'a'*40,'tree':'b'*40},'repository':'levicode/e2e','runId':'123','runAttempt':'1','platform':'linux','architecture':'x64','nativeRepository':'levicode/agent-browser','nativeSource':{'commit':c.HUNG_NATIVE_COMMIT,'tree':c.HUNG_NATIVE_TREE},'compilation':compilation,'binarySha256':digest,'compilerSha256':c.v.sha((runtime/'compiler.jsonl').read_bytes()),'rustcSha256':c.v.sha((runtime/'rustc.txt').read_bytes())}
 write(runtime/'manifest.json',manifest);write(evidence/'native-manifest.sha256',(c.v.sha((runtime/'manifest.json').read_bytes())+'\n').encode())
 write(evidence/'fixtures/26.13.0/web/binding.json',{**expected,'lane':'web','nativeSha256':{'ordinary':digest}})
 case=evidence/'web-case-native/hung-recovery';trace=case/('p-'+'1'*12)/'.e2e/native-trace'
 header=json.loads((case/'case.json').read_text());header.update(expected,traceDirectory=str(trace),nativeExecutable=str(native));write(case/'case.json',header)
 invpath=evidence/'fixture-invocations/invocation-101.json';inv=json.loads(invpath.read_text());inv.update({key:header[key] for key in ['traceDirectory','nativeExecutable','nativeSHA256','wrapperSHA256','run','attempt','sourceCommit','sourceTree']});write(invpath,inv)
 mapping=evidence/'fixture-invocations/daemon-101.json';row=json.loads(mapping.read_text());row['invocationSHA256']=c.v.sha(invpath.read_bytes());write(mapping,row)
 filename=str(workspace/'packages/web/tests/integration/cdp-recovery.test.ts')
 write(evidence/'web/ordinary/collection.json',[{'file':filename,'name':'CDP session recovery > '+c.HUNG_TITLE,'projectName':'integration'}])
 write(evidence/'web/ordinary/results.json',{'testResults':[{'name':filename,'assertionResults':[{'title':c.HUNG_TITLE,'ancestorTitles':['CDP session recovery'],'fullName':c.HUNG_FULL_NAME,'status':'failed'},{'title':'unselected original declaration','status':'skipped'}]}]})
 start=json.loads((trace/'query-101.jsonl').read_text());rows=[start]
 for stage in ['enrollment-index-frontier','enrollment-proof','shutdown-joins']:rows.append({**start,'record':len(rows),'emittedBefore':len(rows),'phase':'TerminalCleanupCheckpoint','terminalCleanupStage':stage,'terminalCleanupOk':False})
 write(trace/'native-101.jsonl',b''.join((json.dumps(row,separators=(',',':'))+'\n').encode() for row in rows))
 def git(directory,*args):
  directory=pathlib.Path(directory)
  if directory==workspace:
   return {('rev-parse','HEAD'):'a'*40,('rev-parse','HEAD^{tree}'):'b'*40,('status','--porcelain'):''}[args]
  assert directory==native_source
  return {('rev-parse','HEAD'):c.HUNG_NATIVE_COMMIT,('rev-parse','HEAD^{tree}'):c.HUNG_NATIVE_TREE,('status','--porcelain'):''}[args]
 return evidence,env,git

class FocusedControls(unittest.TestCase):
 def test_hung_failure_remains_failure_with_real_custody_shape(self):
  with tempfile.TemporaryDirectory() as d:
   evidence,env,git=hung_fixture(pathlib.Path(d))
   # New mode must never depend on old fullmatrix runtime pins.
   (pathlib.Path(d)/'scripts/ci/full-standard-runtime-pins.json').unlink()
   with patch.dict(os.environ,env),patch.object(c,'_git',side_effect=git):result=c.verify_hung(evidence)
   self.assertEqual(len(result['cases']),1);self.assertEqual(result['cases'][0]['originalBusinessStatus'],'failed')
   self.assertEqual(result['cases'][0]['firstEnrollmentRefusal'],'enrollment-index-frontier')
   self.assertFalse(result['fullNativeGate']);self.assertFalse(result['installedAcceptance']);self.assertTrue(result['noAbsenceInference'])
 def test_default_three_case_census_does_not_accept_focused_input(self):
  with tempfile.TemporaryDirectory() as d:
   evidence,env,git=hung_fixture(pathlib.Path(d))
   with patch.dict(os.environ,env),self.assertRaises(ValueError):c.verify(evidence)
 def test_success_without_enrollment_refusal_is_not_a_root_cause(self):
  with tempfile.TemporaryDirectory() as d:
   evidence,env,git=hung_fixture(pathlib.Path(d));p=evidence/'web/ordinary/results.json';result=json.loads(p.read_text());result['testResults'][0]['assertionResults'][0]['status']='passed';write(p,result)
   trace=next((evidence/'web-case-native/hung-recovery').glob('p-*/.e2e/native-trace/native-*.jsonl'));rows=[json.loads(x) for x in trace.read_text().splitlines()];rows=[rows[0],{**rows[-1],'record':1,'emittedBefore':1,'terminalCleanupOk':True}];write(trace,b''.join((json.dumps(row)+'\n').encode() for row in rows))
   with patch.dict(os.environ,env),patch.object(c,'_git',side_effect=git):result=c.verify_hung(evidence)
   self.assertIsNone(result['cases'][0]['firstEnrollmentRefusal']);self.assertFalse(result['cases'][0]['enrollmentRefusalObserved'])
 def test_focused_wrong_identity_missing_closed_proof_and_extra_execution_refuse(self):
  cases=['wrong-root','not-opted-in','wrong-node','foreign-source','dirty-source','foreign-native','dirty-native','manifest-extra','manifest-source','manifest-native','manifest-hash','compiler-fault','compiler-test','compiler-source','compiler-multiple','compiler-incomplete','binary-changed','compiler-binary-changed','collection-extra','collection-wrong-title','executed-extra','result-wrong-title','result-skipped','unknown-stage','stage-success','missing-substage','missing-outer','duplicate-substage','wrong-daemon','missing-mapping','capture-loss']
  for edit in cases:
   with self.subTest(edit=edit),tempfile.TemporaryDirectory() as d:
    workspace=pathlib.Path(d);evidence,env,git=hung_fixture(workspace);runtime=evidence.parent/'native-runtime';original_git=git
    if edit in ['foreign-source','dirty-source','foreign-native','dirty-native']:
     def git(directory,*args):
      if edit=='foreign-source' and pathlib.Path(directory)==workspace and args==('rev-parse','HEAD'):return 'f'*40
      if edit=='dirty-source' and pathlib.Path(directory)==workspace and args==('status','--porcelain'):return '?? evidence/'
      if edit=='foreign-native' and pathlib.Path(directory)!=workspace and args==('rev-parse','HEAD'):return 'f'*40
      if edit=='dirty-native' and pathlib.Path(directory)!=workspace and args==('status','--porcelain'):return ' M cli/src/main.rs'
      return original_git(directory,*args)
    elif edit=='wrong-root':env['E2E_HUNG_DIAGNOSTIC_EVIDENCE_ROOT']=str(workspace/'evidence')
    elif edit=='not-opted-in':env['E2E_WEB_THREE_CASE_NATIVE_CAPTURE']='0'
    elif edit=='wrong-node':env['NODE_SELECTOR']='26'
    elif edit.startswith('manifest-'):
     path=runtime/'manifest.json';value=json.loads(path.read_text())
     if edit=='manifest-extra':value['fullNativeGate']=True
     elif edit=='manifest-source':value['source']['commit']='f'*40
     elif edit=='manifest-native':value['nativeSource']['commit']='f'*40
     else:value['runAttempt']='2'
     write(path,value)
     if edit!='manifest-hash':write(evidence/'native-manifest.sha256',(c.v.sha(path.read_bytes())+'\n').encode())
    elif edit in ['compiler-fault','compiler-test','compiler-source','compiler-multiple','compiler-incomplete']:
     path=runtime/'compiler.jsonl';rows=[json.loads(x) for x in path.read_text().splitlines()]
     if edit=='compiler-fault':rows[0]['features']=['acceptance-faults']
     elif edit=='compiler-test':rows[0]['profile']['test']=True
     elif edit=='compiler-source':rows[0]['target']['src_path']='/foreign/main.rs'
     elif edit=='compiler-multiple':rows.insert(0,copy.deepcopy(rows[0]))
     else:rows[-1]['success']=False
     write(path,b''.join((json.dumps(row)+'\n').encode() for row in rows));manifest=runtime/'manifest.json';value=json.loads(manifest.read_text());value['compilerSha256']=c.v.sha(path.read_bytes());write(manifest,value);write(evidence/'native-manifest.sha256',(c.v.sha(manifest.read_bytes())+'\n').encode())
    elif edit=='binary-changed':write(runtime/'agent-browser',b'OTHER_NEVER_EXECUTE')
    elif edit=='compiler-binary-changed':write(evidence.parent/'target/ci/agent-browser',b'OTHER_NEVER_EXECUTE')
    elif edit.startswith('collection-'):
     path=evidence/'web/ordinary/collection.json';value=json.loads(path.read_text())
     if edit=='collection-extra':value.append(copy.deepcopy(value[0]))
     else:value[0]['name']='other'
     write(path,value)
    elif edit in ['executed-extra','result-wrong-title','result-skipped']:
     path=evidence/'web/ordinary/results.json';value=json.loads(path.read_text());rows=value['testResults'][0]['assertionResults']
     if edit=='executed-extra':rows.append(copy.deepcopy(rows[0]))
     elif edit=='result-wrong-title':rows[0]['ancestorTitles']=['foreign']
     else:rows[0]['status']='skipped'
     write(path,value)
    elif edit=='missing-mapping':(evidence/'fixture-invocations/daemon-101.json').unlink()
    elif edit=='wrong-daemon':
     path=evidence/'fixture-invocations/daemon-101.json';row=json.loads(path.read_text());row['daemonPID']=999;write(path,row)
    else:
     path=next((evidence/'web-case-native/hung-recovery').glob('p-*/.e2e/native-trace/native-*.jsonl'));rows=[json.loads(x) for x in path.read_text().splitlines()]
     if edit=='unknown-stage':rows[1]['terminalCleanupStage']='enrollment-FAKE'
     elif edit=='stage-success':rows[1]['terminalCleanupOk']=True
     elif edit=='missing-substage':rows.pop(1)
     elif edit=='missing-outer':rows.pop(2)
     elif edit=='duplicate-substage':rows.insert(1,copy.deepcopy(rows[1]))
     elif edit=='capture-loss':rows[-1]['droppedBefore']=1
     for i,row in enumerate(rows):row.update(record=i,emittedBefore=i)
     write(path,b''.join((json.dumps(row)+'\n').encode() for row in rows))
    with patch.dict(os.environ,env),patch.object(c,'_git',side_effect=git),self.assertRaises((ValueError,OSError)):c.verify_hung(evidence)

if __name__=='__main__':unittest.main()
