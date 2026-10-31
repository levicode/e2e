"""Pure closed-envelope controls; no runner, browser, daemon, or network."""
import copy, importlib.util, io, json, os, pathlib, subprocess, sys, tempfile, unittest
spec=importlib.util.spec_from_file_location('unserved_validator',pathlib.Path(__file__).with_name('check-unserved-model-envelope.py'))
v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
ID=dict(consumerRun='123',consumerAttempt='1',selector='24.19.0',nodeVersion='v24.19.0',sourceCommit='a'*40,sourceTree='b'*40,caseSchema='unserved-model-two-v1')
ENV=dict(schemaVersion=1,suite='unserved-model-two-workers',captureNonce='c'*64,**ID)
CLEAN=dict(nativeRetired=True,finalizedCleanupProven=True,recordingsRetired=True,released=True,connectingCleanupFailurePresent=False,retiringAttemptCleared=True,reason='complete',dirty='unknown')
def fixture():
    rows=[]
    for n in (1,2):
        owner=dict(v=1,workerOrdinal=1,caseOrdinal=n,surface=1,attempt=n)
        rows += [dict(owner,kind='start'),dict(owner,kind='cleanup',**CLEAN)]
        case=dict(v=1,kind='case',caseOrdinal=n,status='interrupted',attemptCount=1,attemptStatus='interrupted',phase='body',errorCode='CANCELLED',cleanup='complete',secondaryErrorCount=0,secondaryErrors=[])
        if n==1:case.update(runErrorCount=1,runErrors=[dict(phase='body',errorCode='MODEL_UNAVAILABLE')])
        rows.append(case)
    custody=dict(schemaVersion=1,suite='unserved-model-two-workers',baseConsumer=v.BASE,projection='complete',lifecycle='observed',coverage='observed-only',exhaustive=False,noAbsenceInference=True,invalidRecords=0,overflow=False,rows=len(rows),workerBindings=1,surfaceBindings=1,attemptBindings=2,nativeOrigin='unknown',began=True)
    return rows,custody

def line(suffix,value): return (v.P+suffix+' '+json.dumps(value,separators=(',',':'))+'\n').encode()
def log(rows=None,custody=None):
    if rows is None:rows,custody=fixture()
    return line('_BEGIN',ENV)+b''.join(line('',r) for r in rows)+line('_CUSTODY',custody)+line('_END',ENV)
def result(data):return v.verify_log(io.BytesIO(data),ID)
class Controls(unittest.TestCase):
    def reject(self,data):self.assertEqual(result(data)['artifactEnvelope'],'incomplete')
    def test_two_owners_one_worker_is_valid(self):
        r=result(log());self.assertEqual(r['artifactEnvelope'],'accepted');self.assertFalse(r['exhaustive']);self.assertTrue(r['noAbsenceInference'])
    def test_second_worker_is_valid(self):
        rows,c=fixture()
        for r in rows:
            if r.get('caseOrdinal')==2 and r['kind']!='case':r['workerOrdinal']=2;r['attempt']=1
        c.update(workerBindings=2,surfaceBindings=2);self.assertEqual(result(log(rows,c))['artifactEnvelope'],'accepted')
    def test_failure_witness_is_not_model_failure(self):
        rows,c=fixture();owner={k:rows[3][k] for k in ['v','workerOrdinal','caseOrdinal','surface','attempt']}
        rows[4]['reason']='receipt-failed';rows[5]['cleanup']='failed';rows[5]['secondaryErrors']=[dict(phase='cleanup',errorCode='ENGINE_FAILURE')];rows[5]['secondaryErrorCount']=1
        rows[4:4]=[dict(owner,kind='retirement',stage='native-close',before='undefined',after='value'),dict(owner,kind='first-cause',stage='native-close',code='unknown',category='unknown')]
        c['rows']=len(rows);self.assertEqual(result(log(rows,c))['artifactEnvelope'],'accepted')
    def test_unresolved_without_fabricated_firstcause(self):
        rows,c=fixture();rows[4].update(nativeRetired=False,retiringAttemptCleared=False,reason='unresolved-custody');rows[5]['cleanup']='failed';self.assertEqual(result(log(rows,c))['artifactEnvelope'],'accepted')
    def test_loss_and_caps(self):
        for fault in ['tail-loss','65rows','64withloss','oversize','unterminated']:
            with self.subTest(fault=fault):
                rows,c=fixture()
                if fault=='tail-loss':rows.append(dict(v=1,kind='capture-loss',reason='capture-incomplete',worker='unjoined'));c.update(rows=len(rows),overflow=True,lifecycle='incomplete')
                if fault in ['65rows','64withloss']:
                    while len(rows)<(65 if fault=='65rows' else 63):rows.insert(2,dict(rows[0],kind='admission',stage='require-attempt',origin='unjoined',wire='absent'))
                    if fault=='64withloss':rows.append(dict(v=1,kind='capture-loss',reason='capture-incomplete',worker='unjoined'))
                    c['rows']=len(rows)
                data=log(rows,c)
                if fault=='oversize':data=line('_BEGIN',ENV)+(v.P+' '+(' '*2048)+'\n').encode()+line('_END',ENV)
                if fault=='unterminated':data=data.rstrip(b'\n')
                self.reject(data)
    def test_envelope_rejections(self):
        for fault in ['duplicate','missing-end','different-end','foreign-suite','foreign-nonce','foreign-source','missing-custody','extra-key','unavailable','post-end-row']:
            with self.subTest(fault=fault):
                data=log()
                if fault=='duplicate':data+=log()
                if fault=='missing-end':data=data[:data.rfind((v.P+'_END').encode())]
                if fault=='different-end':data=data.replace(line('_END',ENV),line('_END',dict(ENV,captureNonce='d'*64)))
                if fault=='foreign-suite':data=data.replace(b'unserved-model-two-workers',b'engine-secrets')
                if fault=='foreign-nonce':data=data.replace(line('_END',ENV),line('_END',dict(ENV,captureNonce='x'*64)))
                if fault=='foreign-source':data=data.replace(('a'*40).encode(),('d'*40).encode())
                if fault=='missing-custody':data=b'\n'.join(x for x in data.split(b'\n') if not x.startswith((v.P+'_CUSTODY').encode()))
                if fault=='extra-key':data=data.replace(line('_BEGIN',ENV),line('_BEGIN',dict(ENV,message='CANARY')))
                if fault=='unavailable':data=line('_UNAVAILABLE',dict(reason='overlapping-capture'))+data
                if fault=='post-end-row':data+=line('',fixture()[0][0])
                self.reject(data)
    def test_owner_cause_and_completeness_rejections(self):
        for fault in ['rebind','missing-start','missing-cleanup','same-pair','extra-field','cause-text','first-without-retirement','exhaustive','absence','overflow','projection','worker-cap','surface-cap','attempt-cap']:
            with self.subTest(fault=fault):
                rows,c=fixture()
                if fault=='rebind':rows[4]['attempt']=1
                if fault=='missing-start':rows.pop(3)
                if fault=='missing-cleanup':rows.pop(4)
                if fault=='same-pair':rows[3]['caseOrdinal']=1
                if fault=='extra-field':rows[0]['header']='CANARY'
                if fault in ['cause-text','first-without-retirement']:rows.insert(1,dict(rows[0],kind='first-cause',stage='native-close',code='CANARY' if fault=='cause-text' else 'unknown',category='unknown'))
                if fault=='exhaustive':c['exhaustive']=True
                if fault=='absence':c['noAbsenceInference']=False
                if fault=='overflow':c['overflow']=True
                if fault=='projection':c['projection']='incomplete'
                if fault=='worker-cap':rows[0]['workerOrdinal']=9
                if fault=='surface-cap':rows[0]['surface']=17
                if fault=='attempt-cap':rows[0]['attempt']=17
                c['rows']=len(rows);self.reject(log(rows,c))
    def test_retirement_requires_matching_firstcause_even_with_complete_cleanup(self):
        rows,c=fixture();owner={k:rows[0][k] for k in ['v','workerOrdinal','caseOrdinal','surface','attempt']};rows.insert(1,dict(owner,kind='retirement',stage='native-close',before='undefined',after='value'));c['rows']=len(rows);self.reject(log(rows,c))
    def test_shared_conflict_outside_either_boundary_always_rejects(self):
        for marker in [b'NATIVE_DIAGNOSTIC_CAPTURE_CONFLICT {"schemaVersion":1,"status":"incomplete"}\n',b'NATIVE_DIAGNOSTIC_CAPTURE_CONFLICT {"schemaVersion":1,"status":"incomplete","message":"CANARY"}\n',b'NATIVE_DIAGNOSTIC_CAPTURE_CONFLICT {"schemaVersion":2,"status":"complete"}\n']:
            self.reject(marker+log());self.reject(log()+marker);self.assertNotIn('CANARY',json.dumps(result(marker+log())))
    def test_duplicate_json_key_is_rejected(self):
        data=log().replace(b'"kind":"start"',b'"kind":"start","kind":"start"',1);self.reject(data)
    def test_other_suite_region_does_not_count_or_join(self):
        foreign=b'ENGINE_SECRETS_DIAGNOSTIC_BEGIN {}\nENGINE_SECRETS_DIAGNOSTIC_END {}\n'
        self.reject(foreign);self.assertEqual(result(foreign+log())['artifactEnvelope'],'accepted')
    def test_cli_route_with_original_log_and_identity_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);logdir=root/'fixtures'/'24.19.0'/'core';logdir.mkdir(parents=True)
            (logdir/'test-e2e.log').write_bytes(log())
            for name,value in [('node.version','v24.19.0'),('source.commit','a'*40),('source.tree','b'*40),('test-e2e.exit','1')]: (root/name).write_text(value+'\n')
            env=dict(os.environ,GITHUB_RUN_ID='123',GITHUB_RUN_ATTEMPT='1',NODE_SELECTOR='24.19.0')
            command=[sys.executable,str(pathlib.Path(__file__).with_name('check-unserved-model-envelope.py')),'--evidence',directory]
            good=subprocess.run(command,env=env,capture_output=True,text=True,check=False)
            self.assertEqual(good.returncode,0);status=json.loads((root/'unserved-model-capture-status.json').read_text());self.assertEqual(status['originalPackageTestExit'],1)
            (logdir/'test-e2e.log').write_bytes(log()+log())
            bad=subprocess.run(command,env=env,capture_output=True,text=True,check=False);self.assertEqual(bad.returncode,1)
            self.assertEqual(json.loads((root/'unserved-model-capture-status.json').read_text())['artifactEnvelope'],'incomplete')
    def test_summary_never_echoes_untrusted_data(self):
        data=log().replace(b'"kind":"start"',b'"kind":"CANARY"',1);self.assertNotIn('CANARY',json.dumps(result(data)))
if __name__=='__main__':unittest.main()
