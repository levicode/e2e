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
if __name__=='__main__':unittest.main()
