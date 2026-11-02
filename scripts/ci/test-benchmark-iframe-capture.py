import importlib.util,json,pathlib,unittest,tempfile,os
from unittest.mock import patch
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('iframe',HERE/'benchmark-iframe-capture.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
BASE={'v':1,'case':'iframe-correct-code','proxyPid':123,'attempt':1,'record':0,'kind':'start'}
def wire(rows):return b''.join(json.dumps(r,separators=(',',':')).encode()+b'\n' for r in rows)
def result():return {**BASE,'record':1,'kind':'result','command':'browser.trace','generation':1,'operationSeq':7,'ok':False,'effects':'unknown','scopeState':'quarantined','code':'cleanup-failed'}
class Capture(unittest.TestCase):
 def test_prepare_copies_executable_without_changing_source_or_original_runtime(self):
  with tempfile.TemporaryDirectory() as td,patch.object(m.subprocess,'check_output',side_effect=lambda args,**kw: ('1' if args[-1]=='HEAD' else '2')*40+'\n'):
   ws=pathlib.Path(td);binary=ws/'binary';binary.write_bytes(b'original');envfile=ws/'env';envfile.write_text('')
   for name in m.FILES:
    p=ws/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((HERE.parents[1]/name).read_bytes())
   source=ws/'scripts/ci/native-trace-wrapper.sh';source.chmod(0o644)
   env={'GITHUB_SHA':'1'*40,'GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1','E2E_AGENT_BROWSER_EXECUTABLE':str(binary),'GITHUB_ENV':str(envfile)}
   with patch.dict(os.environ,env):m.prepare(ws)
   wrapper=ws/'evidence/benchmark-iframe/native-trace-wrapper.sh';self.assertEqual(wrapper.read_bytes(),source.read_bytes());self.assertEqual(wrapper.stat().st_mode&0o777,0o755);self.assertEqual(source.stat().st_mode&0o777,0o644);self.assertNotIn('\nE2E_AGENT_BROWSER_EXECUTABLE=',envfile.read_text());self.assertTrue(envfile.read_text().splitlines()[-1].startswith('E2E_BENCHMARK_CAPTURE_EXECUTABLE='))
 def test_head_mismatch_and_late_env_newline_never_activate_wrapper(self):
  for mode in ['head','newline','carriage']:
   with tempfile.TemporaryDirectory() as td,patch.object(m.subprocess,'check_output',side_effect=lambda args,**kw: ('3' if mode=='head' else '1' if args[-1]=='HEAD' else '2')*40+'\n'):
    ws=pathlib.Path(td);binary=ws/('binary'+('\nlate' if mode=='newline' else '\rlate' if mode=='carriage' else ''));binary.write_bytes(b'original');envfile=ws/'env';envfile.write_text('')
    for name in m.FILES:
     p=ws/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((HERE.parents[1]/name).read_bytes())
    env={'GITHUB_SHA':'1'*40,'GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1','E2E_AGENT_BROWSER_EXECUTABLE':str(binary),'GITHUB_ENV':str(envfile)}
    with patch.dict(os.environ,env):
     with self.assertRaises(Exception):m.prepare(ws)
    self.assertEqual(envfile.read_text(),'')
 def test_exact_ts_receipt(self):self.assertEqual(len(m.ts_rows(wire([BASE,result()]),123,1)),2)
 def test_rejects_unknown_payload_identity_and_loss(self):
  for change in [{'secret':'CANARY'},{'proxyPid':124},{'attempt':2},{'record':3},{'operationSeq':True},{'command':'ANY'},{'code':'CANARY'},{'ok':True},{'generation':0}]:
   with self.subTest(change=change):
    with self.assertRaises(Exception):m.ts_rows(wire([BASE,{**result(),**change}]),123,1)
  with self.assertRaises(Exception):m.ts_rows(wire([BASE]*128),123,1)
 def fixture(self,ws):
  root=ws/'evidence/benchmark-iframe';raw=root/'raw';raw.mkdir(parents=True);inv=ws/'evidence/fixture-invocations';inv.mkdir()
  binary=ws/'binary';binary.write_bytes(b'exact-binary')
  for name in m.FILES:
   p=ws/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((HERE.parents[1]/name).read_bytes())
  report=ws/'apps/web-benchmark/.e2e/report.json';report.parent.mkdir(parents=True);report.write_text(json.dumps({'run':{'results':[{'id':'d99d69d8e6ab5f0ee6f4c3be656009a010c438186a8f7984ec4e981ff7ca0124','attempts':[{'index':0},{'index':1,'steps':[],'error':{'phase':'launch','message':'An attempt is active or its provider recording cleanup is unresolved'}}]}]}}))
  env={'GITHUB_SHA':'1'*40,'GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1','E2E_DIAGNOSTIC_NATIVE_EXECUTABLE':str(binary)}
  with patch.dict(os.environ,env):b=m.binding(ws)
  (root/'binding.json').write_text(json.dumps(b));(root/'client-123-attempt-1.jsonl').write_bytes(wire([BASE,result(),{**BASE,'record':2,'kind':'terminal-error','code':'cleanup-failed'}]))
  iv={'schemaVersion':2,'nativeExecutable':str(binary),'pid':123,'nativeSHA256':b['nativeSHA256'],'sourceCommit':b['sourceCommit'],'sourceTree':b['sourceTree'],'run':'1','attempt':'1','wrapperSHA256':b['sources']['scripts/ci/native-trace-wrapper.sh'],'traceDirectory':str(raw),'nonce':'a'*64}
  ivraw=json.dumps(iv).encode();(inv/'invocation-123.json').write_bytes(ivraw);(inv/'daemon-123.json').write_text(json.dumps({'schemaVersion':1,'proxyPID':123,'daemonPID':456,'nonce':'a'*64,'invocationSHA256':m.sha(ivraw),'kind':'spawn-owned-daemon'}))
  base={'schemaVersion':2,'source':'native','pid':456,'record':0,'operationSeq':0,'phase':'CaptureStarted','droppedBefore':0,'emittedBefore':0,'suppressedBefore':0,'overflow':False}
  rows=[base,{**base,'record':1,'emittedBefore':1,'operationSeq':7,'phase':'CleanupStarted'},{**base,'record':2,'emittedBefore':2,'operationSeq':999,'phase':'CleanupStarted'},{**base,'record':3,'emittedBefore':3,'phase':'TerminalCleanupCheckpoint','terminalCleanupStage':'enrollment-proof','terminalCleanupOk':False,'terminalEnrollmentRefusal':'enrollment-watermark','terminalProofCounts':[7,9]},{**base,'record':4,'emittedBefore':4,'phase':'TerminalCleanupCheckpoint','terminalCleanupStage':'shutdown-joins','terminalCleanupOk':False}]
  (raw/'native-123.jsonl').write_bytes(wire(rows));(raw/'query-123.jsonl').write_bytes(wire([base]));return env,root
 def test_full_join_filters_other_operations_and_reuses_terminal_enum(self):
  with tempfile.TemporaryDirectory() as td,patch.object(m.subprocess,'check_output',side_effect=lambda args,**kw: ('1' if args[-1]=='HEAD' else '2')*40+'\n'):
   ws=pathlib.Path(td);env,root=self.fixture(ws)
   with patch.dict(os.environ,env):m.collect(ws)
   d=json.loads((ws/'evidence/benchmark-iframe-closed.json').read_text());self.assertEqual(d['state'],'observed');self.assertTrue(d['cases'][0]['terminalLinked']);self.assertEqual(d['launchBlockedAttempts'],[2]);self.assertNotIn(999,[r['operationSeq'] for r in d['cases'][0]['native']]);self.assertTrue(any('terminalEnrollmentRefusal'in r for r in d['cases'][0]['native']))
 def test_bad_daemon_or_unknown_native_row_discards_all_selected_rows(self):
  for mode in ['daemon','native']:
   with tempfile.TemporaryDirectory() as td,patch.object(m.subprocess,'check_output',side_effect=lambda args,**kw: ('1' if args[-1]=='HEAD' else '2')*40+'\n'):
    ws=pathlib.Path(td);env,root=self.fixture(ws)
    if mode=='daemon':(ws/'evidence/fixture-invocations/daemon-123.json').write_text('{}')
    else:
     with (root/'raw/native-123.jsonl').open('ab') as f:f.write(b'{"secret":"CANARY"}\n')
    with patch.dict(os.environ,env):m.collect(ws)
    data=(ws/'evidence/benchmark-iframe-closed.json').read_text();d=json.loads(data);self.assertEqual(d['state'],'incomplete');self.assertEqual(d['cases'],[]);self.assertNotIn('CANARY',data);self.assertEqual(d['failedStage'],'process-custody' if mode=='daemon' else 'native-closed-records')
 def test_absent_case_binding_is_distinguished_from_native_schema_failure(self):
  with tempfile.TemporaryDirectory() as td,patch.object(m.subprocess,'check_output',side_effect=lambda args,**kw: ('1' if args[-1]=='HEAD' else '2')*40+'\n'):
   ws=pathlib.Path(td);env,root=self.fixture(ws);(root/'client-123-attempt-1.jsonl').unlink()
   with patch.dict(os.environ,env):m.collect(ws)
   d=json.loads((ws/'evidence/benchmark-iframe-closed.json').read_text());self.assertEqual(d['failedStage'],'case-census');self.assertEqual(d['caseFileCount'],0);self.assertEqual(d['boundAttemptCount'],0);self.assertEqual(d['expectedAttemptCount'],1);self.assertEqual(d['cases'],[])
if __name__=='__main__':unittest.main()
