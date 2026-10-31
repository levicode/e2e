"""Pure envelope controls; no browser/native or report payloads."""
import copy, importlib.util, io, json, os, pathlib, sys, tempfile, types, unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('validator',pathlib.Path(__file__).with_name('check-engine-secrets-envelope.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
EXPECTED={'consumerRun':'123','consumerAttempt':'1','selector':'24.22.1','nodeVersion':'v24.22.1','sourceCommit':'a'*40,'sourceTree':'b'*40,'caseSchema':'engine-secrets-five-v1'}
def fixture():
    env={'schemaVersion':1,'suite':'engine-secrets','captureNonce':'c'*64,'diagnosticContract':'secrets-native-custody-v2','nativeCapture':'ready',**EXPECTED};rows=[]
    for n in range(1,6):
        base={'v':1,'workerOrdinal':1 if n%2 else 2,'caseOrdinal':n,'surface':1,'attempt':n}
        rows.append({**base,'kind':'start'});rows.append({**base,'kind':'cleanup',**{k:True for k in v.CLEAN},'connectingCleanupFailurePresent':False,'reason':'complete','dirty':'unknown'})
    for n in range(1,6):
        failed=n in {2,3};row={'v':1,'kind':'case','caseOrdinal':n,'status':'failed' if failed else 'passed','attemptCount':1,'attemptStatus':'failed' if failed else 'passed','phase':'body' if failed else 'not-present','errorCode':'ASSERTION_FAILED' if failed else 'not-present','cleanup':'complete','secondaryErrorCount':0,'secondaryErrors':[]}
        if n==1:row.update(runErrorCount=0,runErrors=[])
        rows.append(row)
    custody={'schemaVersion':1,'suite':'engine-secrets','baseConsumer':v.BASE,'projection':'complete','lifecycle':'observed','coverage':'observed-only','exhaustive':False,'noAbsenceInference':True,'invalidRecords':0,'overflow':False,'rows':15,'workerBindings':2,'surfaceBindings':2,'attemptBindings':5,'nativeOrigin':'unknown','began':True,'nativeArchive':'copied'}
    return env,rows,custody
def line(kind,row):return (v.P+kind+' '+json.dumps(row,separators=(',',':'))+'\n').encode()
def encode(env,rows,custody):return b'original unrelated log\n'+line('_BEGIN',env)+b''.join(line('',r) for r in rows)+line('_CUSTODY',custody)+line('_END',env)
def check(data,expected=EXPECTED):return v.verify_log(io.BytesIO(data),expected)
class Controls(unittest.TestCase):
    def test_failed_cases_are_valid_evidence_not_business_success(self):
        result=check(encode(*fixture()));self.assertEqual(result['artifactEnvelope'],'accepted');self.assertEqual(result['cases'][2]['status'],'failed');self.assertFalse(result['exhaustive']);self.assertTrue(result['logReadComplete'])
    def test_identity_mismatches(self):
        for key in EXPECTED:
            with self.subTest(key=key):
                env,rows,c=fixture();env[key]='wrong';self.assertEqual(check(encode(env,rows,c))['artifactEnvelope'],'incomplete')
    def test_boundaries(self):
        env,rows,c=fixture();valid=encode(env,rows,c)
        for data in [b'',valid.split(line('_END',env))[0],valid+line('_BEGIN',env),line('_CUSTODY',c)+valid,valid+line('',rows[0]),valid+line('_END',env),valid.replace(line('_END',env),line('_END',{**env,'captureNonce':'d'*64}))]:
            with self.subTest(size=len(data)):self.assertEqual(check(data)['artifactEnvelope'],'incomplete')
    def test_caps_duplicate_keys_and_unknown_fields(self):
        env,rows,c=fixture()
        for data in [encode(env,rows*5,c),encode(env,[{**rows[0],'payload':'private-canary'},*rows[1:]],c),line('_BEGIN',{**env,'extra':'private-canary'}),b'ENGINE_SECRETS_DIAGNOSTIC_BEGIN '+b'x'*2048+b'\n',encode(env,rows,c).replace(b'"kind":"start"',b'"kind":"start","kind":"start"',1)]:
            with self.subTest(size=len(data)):
                result=check(data);self.assertEqual(result['artifactEnvelope'],'incomplete');self.assertNotIn('private-canary',json.dumps(result))
    def test_five_case_and_owner_constraints(self):
        for edit in ['missing','duplicate','unknownstatus','unknowncleanup','unjoined','wrongworker','wrongcase','missingterminal']:
            env,rows,c=fixture()
            if edit=='missing':rows.pop()
            elif edit=='duplicate':rows[-1]=copy.deepcopy(rows[-2])
            elif edit=='unknownstatus':rows[-1]['status']='private-canary'
            elif edit=='unknowncleanup':rows[-1]['cleanup']='private-canary'
            elif edit=='unjoined':rows[1]['attempt']=16
            elif edit=='wrongworker':rows[1]['workerOrdinal']=3
            elif edit=='wrongcase':rows[1]['caseOrdinal']=2
            else:rows.pop(1)
            c['rows']=len(rows)
            with self.subTest(edit=edit):self.assertEqual(check(encode(env,rows,c))['artifactEnvelope'],'incomplete')
    def test_custody_never_promotes_incomplete_or_exhaustive_claim(self):
        for key,value in [('lifecycle','complete'),('lifecycle','incomplete'),('projection','incomplete'),('rows',14),('workerBindings',1),('exhaustive',True),('noAbsenceInference',False),('invalidRecords',1),('overflow',True),('began',False),('baseConsumer','d'*40)]:
            env,rows,c=fixture();c[key]=value
            with self.subTest(key=key,value=value):self.assertEqual(check(encode(env,rows,c))['artifactEnvelope'],'incomplete')
    def test_loss_and_unknown_query_missing_witness(self):
        env,rows,c=fixture();rows.insert(0,{'v':1,'kind':'capture-loss','worker':'unjoined','reason':'client-cap'});c['rows']=16;self.assertEqual(check(encode(env,rows,c))['artifactEnvelope'],'incomplete')
        env,rows,c=fixture();rows[-3]['errorCode']='ACTION_MAY_HAVE_COMMITTED';self.assertEqual(check(encode(env,rows,c))['artifactEnvelope'],'incomplete')
    def test_symlink_small_identity_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d);(p/'real').write_text('a'*40);(p/'link').symlink_to(p/'real')
            with self.assertRaises(v.Invalid):v.small(p/'link')
    def test_run_cleanup_failure_needs_observed_evidence(self):
        env,rows,c=fixture();rows[-1]['cleanup']='failed';self.assertEqual(check(encode(env,rows,c))['artifactEnvelope'],'incomplete')
        env,rows,c=fixture();rows[-5].update(runErrorCount=1,runErrors=[{'phase':'cleanup','errorCode':'unknown'}]);self.assertEqual(check(encode(env,rows,c))['artifactEnvelope'],'incomplete')
    def test_coordinator_runs_new_validator_after_old_failure_without_replacing_business_exit(self):
        path=pathlib.Path(__file__).with_name('check-original-capture-invocations.py')
        spec=importlib.util.spec_from_file_location('coordinator',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        for old_failure,new_code,business in [(True,0,'7'),(False,1,'0'),(False,0,'7')]:
            with self.subTest(old_failure=old_failure,new_code=new_code),tempfile.TemporaryDirectory() as directory:
                previous=os.getcwd();os.chdir(directory)
                try:
                    root=pathlib.Path('evidence');root.mkdir();(root/'test-e2e.exit').write_text(business+'\n')
                    verify=patch.object(module,'verify',side_effect=RuntimeError('controlled') if old_failure else None,return_value=[])
                    with patch.dict(os.environ,{'E2E_ENGINE_SECRETS_CAPTURE':'1'}),verify,patch.object(module.subprocess,'run',return_value=types.SimpleNamespace(returncode=new_code)) as run,patch.object(sys,'argv',['check','unused']):
                        with self.assertRaises(SystemExit) as stopped:module.main()
                    self.assertEqual(stopped.exception.code,int(old_failure or bool(new_code)))
                    self.assertEqual(run.call_count,2)
                    self.assertEqual(run.call_args_list[0].args[0],[sys.executable,'scripts/ci/check-engine-secrets-envelope.py','--evidence','evidence'])
                    self.assertEqual(run.call_args_list[1].args[0],[sys.executable,'scripts/ci/check-unserved-model-envelope.py','--evidence','evidence'])
                    self.assertTrue(all(call.kwargs=={'check':False} for call in run.call_args_list))
                    result=json.loads((root/'original-capture-status.json').read_text());self.assertEqual(result['originalPackageTestExit'],business)
                    self.assertEqual((root/'test-e2e.exit').read_text(),business+'\n');self.assertTrue(result['behaviorAndDiagnosticGatesAreSeparate'])
                finally:os.chdir(previous)
    def test_disabled_diagnostic_does_not_pollute_legacy_gate(self):
        path=pathlib.Path(__file__).with_name('check-original-capture-invocations.py')
        spec=importlib.util.spec_from_file_location('legacy',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            previous=os.getcwd();os.chdir(directory)
            try:
                pathlib.Path('evidence').mkdir();pathlib.Path('evidence/test-e2e.exit').write_text('0\n')
                with patch.dict(os.environ,{'E2E_ENGINE_SECRETS_CAPTURE':'0'}),patch.object(module,'verify',return_value=[]),patch.object(module.subprocess,'run') as run,patch.object(sys,'argv',['check','unused']):
                    with self.assertRaises(SystemExit) as stopped:module.main()
                self.assertEqual(stopped.exception.code,0);run.assert_not_called()
                result=json.loads(pathlib.Path('evidence/original-capture-status.json').read_text());self.assertEqual(result['engineSecretsCapture']['status'],'not-enabled')
            finally:os.chdir(previous)
    def test_each_finally_validator_runs_even_if_the_other_throws(self):
        path=pathlib.Path(__file__).with_name('check-original-capture-invocations.py');spec=importlib.util.spec_from_file_location('parallel_status',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        for responses in [[RuntimeError('controlled'),types.SimpleNamespace(returncode=0)],[types.SimpleNamespace(returncode=0),RuntimeError('controlled')]]:
            with tempfile.TemporaryDirectory() as directory:
                previous=os.getcwd();os.chdir(directory)
                try:
                    pathlib.Path('evidence').mkdir();pathlib.Path('evidence/test-e2e.exit').write_text('7\n')
                    with patch.dict(os.environ,{'E2E_ENGINE_SECRETS_CAPTURE':'1'}),patch.object(module,'verify',return_value=[]),patch.object(module.subprocess,'run',side_effect=responses) as run,patch.object(sys,'argv',['check','unused']):
                        with self.assertRaises(SystemExit) as stopped:module.main()
                    self.assertEqual(stopped.exception.code,1);self.assertEqual(run.call_count,2)
                    status=json.loads(pathlib.Path('evidence/original-capture-status.json').read_text());self.assertIn('engineSecretsCapture',status);self.assertIn('unservedModelCapture',status);self.assertEqual(status['originalPackageTestExit'],'7');self.assertEqual(pathlib.Path('evidence/test-e2e.exit').read_text(),'7\n')
                finally:os.chdir(previous)
    def test_failure_digest_is_explicitly_only_read_prefix(self):
        result=check(b'ENGINE_SECRETS_DIAGNOSTIC_BEGIN invalid\nremaining original log\n')
        self.assertFalse(result['logReadComplete']);self.assertIn('readPrefixSha256',result);self.assertNotIn('originalLogSha256',result)
    def test_cli_status_separates_valid_failed_business_from_diagnostic_acceptance(self):
        helper_spec=importlib.util.spec_from_file_location('native_fixture',pathlib.Path(__file__).with_name('test-engine-secrets-native-custody.py'));helper=importlib.util.module_from_spec(helper_spec);helper_spec.loader.exec_module(helper)
        with tempfile.TemporaryDirectory() as directory:
            workspace=pathlib.Path(directory);root=helper.cli_fixture(workspace)
            with patch.dict(os.environ,{'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','NODE_SELECTOR':'24.22.1','E2E_ENGINE_SECRETS_CAPTURE':'1'}),patch.object(sys,'argv',['validator','--evidence',str(root)]),patch.object(v,'__file__',str(workspace/'scripts/ci/check-engine-secrets-envelope.py')),patch('builtins.print'):
                self.assertEqual(v.main(),0)
            status=json.loads((root/'engine-secrets-capture-status.json').read_text());self.assertEqual(status['originalPackageTestExit'],7);self.assertEqual(status['artifactEnvelope'],'accepted');self.assertEqual(status['nativeCustody']['processCustody'],'verified');self.assertEqual((root/'test-e2e.exit').read_text(),'7\n')
    def test_invalid_retirement_and_cleanup_conjunction(self):
        env,rows,c=fixture();rows[1]['released']=False;self.assertEqual(check(encode(env,rows,c))['artifactEnvelope'],'incomplete')
        env,rows,c=fixture();owner={k:rows[0][k] for k in ['v','workerOrdinal','caseOrdinal','surface','attempt']};rows.insert(1,{**owner,'kind':'retirement','stage':'publication','before':'value','after':'value'});c['rows']=16;self.assertEqual(check(encode(env,rows,c))['artifactEnvelope'],'incomplete')
    def test_new_native_contract_and_conflict_are_strict(self):
        env,rows,c=fixture();valid=encode(env,rows,c)
        for data in [valid+b'NATIVE_DIAGNOSTIC_CAPTURE_CONFLICT {"schemaVersion":1,"status":"incomplete"}\n',valid.replace(b'secrets-native-custody-v2',b'v1'),valid.replace(b'"nativeArchive":"copied"',b'"nativeArchive":"incomplete"'),valid.replace(b'"nativeCapture":"ready"',b'"nativeCapture":"unavailable"')]:
            self.assertEqual(check(data)['artifactEnvelope'],'incomplete')
if __name__=='__main__':unittest.main()
