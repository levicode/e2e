"""Synthetic closed custody controls: no browser/native execution or secret payload reads."""
import types,copy,hashlib,importlib.util,json,os,pathlib,shutil,subprocess,sys,tempfile,unittest
from unittest.mock import patch
HERE=pathlib.Path(__file__).parent
spec=importlib.util.spec_from_file_location('native_custody',HERE/'check-engine-secrets-native-custody.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
EXPECTED={'consumerRun':'123','consumerAttempt':'1','selector':'24.22.1','nodeVersion':'v24.22.1','sourceCommit':'a'*40,'sourceTree':'b'*40,'caseSchema':'engine-secrets-five-v1'}
NONCE='c'*64;BINARY='d'*64;WRAPPER=hashlib.sha256(b'wrapper').hexdigest()
def write(p,value):
    p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(value if isinstance(value,bytes) else (json.dumps(value,separators=(',',':'))+'\n').encode());p.chmod(0o600)
def fixture(root):
    archive=root/'engine-secrets-native'/NONCE;archive.mkdir(parents=True);invroot=root/'invocations';invroot.mkdir();trace=str(root/'original-project'/'p-012345abcdef'/'.e2e'/'native-trace')
    bindings=[];queries=[];schema=json.loads((HERE/'native-closed-trace-schema.json').read_text())
    for worker,pid in [(1,1001),(2,1002)]:
        base={'v':1,'workerOrdinal':worker,'caseOrdinal':worker,'surface':1,'attempt':worker}
        bindings.append({**base,'kind':'process-binding','client':1,'proxyPid':pid})
        queries.append({**base,'kind':'query','client':1,'generation':1,'operationSeq':23})
        inv={'schemaVersion':2,'pid':pid,'nonce':str(worker)*64,'traceDirectory':trace,'nativeExecutable':'/verified/native','nativeSHA256':BINARY,'wrapperSHA256':WRAPPER,'run':'123','attempt':'1','sourceCommit':'a'*40,'sourceTree':'b'*40}
        data=(json.dumps(inv,separators=(',',':'))+'\n').encode();mapping={'schemaVersion':1,'kind':'spawn-owned-daemon','proxyPID':pid,'daemonPID':pid+1000,'nonce':inv['nonce'],'invocationSHA256':hashlib.sha256(data).hexdigest()}
        for directory in [archive,invroot]:write(directory/f'invocation-{pid}.json',data);write(directory/f'daemon-{pid}.json',mapping)
        first={'schemaVersion':2,'source':'native','pid':pid+1000,'record':0,'operationSeq':0,'phase':'CaptureStarted','droppedBefore':0,'emittedBefore':0,'suppressedBefore':0,'overflow':False}
        failure={**first,'record':1,'operationSeq':23,'generation':1,'phase':'QueryScopeRefusal','queryScopeStage':schema['fields']['queryScopeStage']['enum'][0],'queryScopeReason':schema['fields']['queryScopeReason']['enum'][0]}
        for kind in ['native','query']:write(archive/f'{kind}-{pid}.jsonl',b''.join((json.dumps(x,separators=(',',':'))+'\n').encode() for x in ([first] if kind=='native' else [first,failure])))
    meta={'schemaVersion':1,'suite':'engine-secrets','captureNonce':NONCE,'traceDirectory':trace,**{k:v for k,v in EXPECTED.items() if k!='caseSchema'},'nativeSHA256':BINARY,'wrapperSHA256':WRAPPER,'proxyPids':[1001,1002],'coverage':'observed-only','exhaustive':False};write(archive/'custody.json',meta)
    env={'artifactEnvelope':'accepted','identity':EXPECTED,'diagnosticContract':'secrets-native-custody-v2','captureNonce':NONCE,'workerBindings':2,'processBindings':bindings,'nativeJoinRows':queries}
    return archive,env
def cli_fixture(workspace):
    root=workspace/'evidence';core=root/'fixtures'/'24.22.1'/'core';core.mkdir(parents=True);archive,projected=fixture(core)
    for filename,value in [('source.commit','a'*40),('source.tree','b'*40),('node.version','v24.22.1'),('test-e2e.exit','7')]:write(root/filename,(value+'\n').encode())
    write(root/'tools'/'popup-trace.sh',b'wrapper')
    scripts=workspace/'scripts'/'ci';scripts.mkdir(parents=True)
    for name in ['check-engine-secrets-envelope.py','check-engine-secrets-native-custody.py','native-closed-trace-schema.json']:shutil.copyfile(HERE/name,scripts/name)
    write(scripts/'full-standard-runtime-pins.json',{'configured':True,'ordinary':{'binarySha256':BINARY}})
    spec=importlib.util.spec_from_file_location('envelope_fixture',HERE/'test-engine-secrets-envelope.py');helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    env,rows,c=helper.fixture()
    for binding in reversed(projected['processBindings']):
        index=next(i for i,row in enumerate(rows) if row['kind']=='start' and row['caseOrdinal']==binding['caseOrdinal']);rows.insert(index+1,binding)
    c['rows']=len(rows);write(core/'test-e2e.log',helper.encode(env,rows,c))
    return root
def add_original_six(root):
    for i,name in enumerate(['popup-init-order','popup-init-order-borrowed','replaced-nodes','popup-swipe-pair','popup-swipe-borrowed-pair','on-action-delayed'],1):
        trace=root/name/('run-a/native-trace' if name=='replaced-nodes' else 'runner/native-trace')
        if name!='replaced-nodes':write(root/name/'report.json',{})
        for pid in [i*100+1,i*100+2]:
            daemon=pid*9+13
            inv={'schemaVersion':2,'pid':pid,'nonce':f'{pid:064x}','traceDirectory':f'/tmp/p-{i:012x}/.e2e/native-trace','nativeExecutable':'/verified/native','nativeSHA256':BINARY,'wrapperSHA256':WRAPPER,'run':'123','attempt':'1','sourceCommit':'a'*40,'sourceTree':'b'*40}
            data=(json.dumps(inv)+'\n').encode();write(root/'invocations'/f'invocation-{pid}.json',data);write(root/'invocations'/f'daemon-{pid}.json',{'schemaVersion':1,'kind':'spawn-owned-daemon','proxyPID':pid,'daemonPID':daemon,'nonce':inv['nonce'],'invocationSHA256':hashlib.sha256(data).hexdigest()})
            for kind in ['native','query']:write(trace/f'{kind}-{pid}.jsonl',{'pid':daemon,'record':0,'phase':'CaptureStarted','droppedBefore':0,'suppressedBefore':0,'overflow':False})
def original_checker(workspace):
    target=workspace/'scripts/ci/check-original-capture-invocations.py';shutil.copyfile(HERE/'check-original-capture-invocations.py',target)
    spec=importlib.util.spec_from_file_location('original_six',target);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
class Controls(unittest.TestCase):
    def test_direct_selector_matrix(self):
        for selector,node_version,accepted in [['22', 'v22.23.4', True], ['24', 'v24.22.1', True], ['26', 'v26.0.0', True], ['22.22.3', 'v22.22.3', True], ['24.8.0', 'v24.8.0', True], ['22.23.4', 'v22.23.4', True], ['24.22.1', 'v24.22.1', True], ['26.1.2', 'v26.1.2', True], ['26', 'v26.999.999', True], ['26.999.999', 'v26.999.999', True], ['22', 'v24.22.1', False], ['24', 'v26.0.0', False], ['26', 'v22.23.4', False], ['22.22.3', 'v22.22.4', False], ['24.8.0', 'v24.8.1', False], ['26.1.2', 'v26.1.3', False], ['20', 'v20.1.0', False], ['25.1.0', 'v25.1.0', False], ['27', 'v27.0.0', False], ['026', 'v26.0.0', False], ['26.01.0', 'v26.01.0', False], ['26.0.00', 'v26.0.00', False], ['26.1000.0', 'v26.1000.0', False], ['26', 'v26.1000.0', False], ['v26.0.0', 'v26.0.0', False], ['26', '26.0.0', False], ['26.0', 'v26.0.0', False], ['26.0.0.0', 'v26.0.0.0', False], ['26\n', 'v26.0.0', False], ['26.0.0', 'v26.0.0\n', False], [' 26', 'v26.0.0', False], ['26 ', 'v26.0.0', False], ['../26', 'v26.0.0', False], ['/26', 'v26.0.0', False], ['26.0.0-beta', 'v26.0.0-beta', False], ['26.0.0+build', 'v26.0.0+build', False]]:
            with self.subTest(selector=selector,nodeVersion=node_version),tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'E2E_ENGINE_SECRETS_CAPTURE':'1'}):
                root=pathlib.Path(d);a,e=fixture(root);expected=dict(EXPECTED,selector=selector,nodeVersion=node_version);e['identity']=expected
                meta=json.loads((a/'custody.json').read_text());meta.update(selector=selector,nodeVersion=node_version);write(a/'custody.json',meta)
                if accepted:self.assertEqual(v.verify(root,e,expected,BINARY,WRAPPER)['processCustody'],'verified')
                else:
                    with self.assertRaises(v.Invalid):v.verify(root,e,expected,BINARY,WRAPPER)
    def test_cli_selector_directory_and_native_custody_stay_bound(self):
        for selector,node_version,accepted in [['22', 'v22.23.4', True], ['24', 'v24.22.1', True], ['26', 'v26.0.0', True], ['22.22.3', 'v22.22.3', True], ['24.8.0', 'v24.8.0', True], ['22.23.4', 'v22.23.4', True], ['24.22.1', 'v24.22.1', True], ['26.1.2', 'v26.1.2', True], ['26', 'v26.999.999', True], ['26.999.999', 'v26.999.999', True], ['26', 'v24.22.1', False], ['24.8.0', 'v24.8.1', False]]:
            with self.subTest(selector=selector,nodeVersion=node_version),tempfile.TemporaryDirectory() as d:
                workspace=pathlib.Path(d);evidence=cli_fixture(workspace);old=evidence/'fixtures'/'24.22.1'/'core';core=evidence/'fixtures'/selector/'core'
                if core!=old:core.parent.mkdir(parents=True,exist_ok=True);old.rename(core)
                write(evidence/'node.version',(node_version+'\n').encode());meta=json.loads((core/'engine-secrets-native'/NONCE/'custody.json').read_text());meta.update(selector=selector,nodeVersion=node_version);write(core/'engine-secrets-native'/NONCE/'custody.json',meta)
                lines=[]
                for raw in (core/'test-e2e.log').read_text().splitlines():
                    if raw.startswith('ENGINE_SECRETS_DIAGNOSTIC_BEGIN ') or raw.startswith('ENGINE_SECRETS_DIAGNOSTIC_END '):
                        prefix,payload=raw.split(' ',1);row=json.loads(payload);row.update(selector=selector,nodeVersion=node_version);raw=prefix+' '+json.dumps(row,separators=(',',':'))
                    lines.append(raw)
                write(core/'test-e2e.log',('\n'.join(lines)+'\n').encode())
                env=dict(os.environ,GITHUB_RUN_ID='123',GITHUB_RUN_ATTEMPT='1',NODE_SELECTOR=selector,E2E_ENGINE_SECRETS_CAPTURE='1')
                result=subprocess.run([sys.executable,str(workspace/'scripts/ci/check-engine-secrets-envelope.py'),'--evidence',str(evidence)],env=env,capture_output=True,check=False)
                self.assertEqual(result.returncode,0 if accepted else 1);status=json.loads((evidence/'engine-secrets-capture-status.json').read_text());self.assertEqual((evidence/'test-e2e.exit').read_text(),'7\n')
                if accepted:self.assertEqual(status['identity']['selector'],selector);self.assertEqual(status['identity']['nodeVersion'],node_version);self.assertEqual(status['nativeCustody']['processCustody'],'verified')
    def test_owned_two_processes_same_operation_ids_join_only_by_pid(self):
        with tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'E2E_ENGINE_SECRETS_CAPTURE':'1'}):
            root=pathlib.Path(d);a,e=fixture(root);proof=v.verify(root,e,EXPECTED,BINARY,WRAPPER)
            self.assertEqual(proof['proxyPids'],[1001,1002]);self.assertEqual(proof['traceCoverage'],'observed');self.assertFalse(proof['exhaustive']);self.assertEqual([x['nativeWitnesses'][0]['pid'] for x in proof['queryJoins']],[2001,2002])
    def test_envelope_identity_and_disabled_never_grant(self):
        for field,value in [('artifactEnvelope','incomplete'),('diagnosticContract','v1'),('captureNonce','e'*64),('identity',{}),('workerBindings',3)]:
            with self.subTest(field=field),tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'E2E_ENGINE_SECRETS_CAPTURE':'1'}):
                root=pathlib.Path(d);a,e=fixture(root);e[field]=value
                with self.assertRaises(v.Invalid):v.verify(root,e,EXPECTED,BINARY,WRAPPER)
        with tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'E2E_ENGINE_SECRETS_CAPTURE':'0'}):
            root=pathlib.Path(d);a,e=fixture(root)
            with self.assertRaises(v.Invalid):v.verify(root,e,EXPECTED,BINARY,WRAPPER)
    def test_duplicate_foreign_missing_and_mixed_bindings_refused(self):
        for edit in ['duplicate','foreign','missing','same-client','crossworker']:
            with self.subTest(edit=edit),tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'E2E_ENGINE_SECRETS_CAPTURE':'1'}):
                root=pathlib.Path(d);a,e=fixture(root)
                if edit=='duplicate':e['processBindings'].append(copy.deepcopy(e['processBindings'][0]))
                elif edit=='foreign':e['processBindings'][0]['proxyPid']=999
                elif edit=='missing':e['processBindings'].pop()
                elif edit=='same-client':e['processBindings'][1]['workerOrdinal']=1
                else:e['nativeJoinRows'][0]['client']=2
                with self.assertRaises(v.Invalid):v.verify(root,e,EXPECTED,BINARY,WRAPPER)
    def test_receipt_nonce_hash_source_and_bytes_refused(self):
        for name,key,value in [('invocation-1001.json','nonce','f'*64),('invocation-1001.json','sourceCommit','e'*40),('invocation-1001.json','wrapperSHA256','e'*64),('daemon-1001.json','daemonPID',2002),('daemon-1001.json','invocationSHA256','e'*64),('daemon-1001.json','nonce','f'*64),('custody.json','traceDirectory','/foreign/native-trace')]:
            with self.subTest(key=key),tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'E2E_ENGINE_SECRETS_CAPTURE':'1'}):
                root=pathlib.Path(d);a,e=fixture(root);row=json.loads((a/name).read_text());row[key]=value;write(a/name,row)
                with self.assertRaises(v.Invalid):v.verify(root,e,EXPECTED,BINARY,WRAPPER)
    def test_unknown_fields_payload_and_file_shape_refused(self):
        for edit in ['unknown','schema-v1','duplicate-key','missing','extra','foreign-pid','symlink','hardlink','oversize','partial']:
            with self.subTest(edit=edit),tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'E2E_ENGINE_SECRETS_CAPTURE':'1'}):
                root=pathlib.Path(d);a,e=fixture(root);p=a/'native-1001.jsonl';data=p.read_bytes()
                if edit=='unknown':row=json.loads(data);row['payload']='PRIVATE_CANARY';write(p,row)
                elif edit=='schema-v1':row=json.loads(data);row['schemaVersion']=1;write(p,row)
                elif edit=='duplicate-key':write(p,data.replace(b'"pid":2001',b'"pid":2001,"pid":2001'))
                elif edit=='missing':p.unlink()
                elif edit=='extra':write(a/'native-999.jsonl',data)
                elif edit=='foreign-pid':row=json.loads(data);row['pid']=2002;write(p,row)
                elif edit=='symlink':p.unlink();p.symlink_to(a/'native-1002.jsonl')
                elif edit=='hardlink':os.link(p,a/'hardlink')
                elif edit=='oversize':write(p,b'x'*(256*1024+1))
                else:write(p,data.rstrip(b'\n'))
                with self.assertRaises((v.Invalid,OSError)):v.verify(root,e,EXPECTED,BINARY,WRAPPER)
    def test_loss_preserves_owned_identity_but_cannot_claim_trace_complete(self):
        with tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'E2E_ENGINE_SECRETS_CAPTURE':'1'}):
            root=pathlib.Path(d);a,e=fixture(root);p=a/'native-1001.jsonl';row=json.loads(p.read_text());row['droppedBefore']=2;write(p,row)
            proof=v.verify(root,e,EXPECTED,BINARY,WRAPPER);self.assertEqual(proof['processCustody'],'verified');self.assertEqual(proof['traceCoverage'],'incomplete');self.assertTrue(proof['noAbsenceInference'])
    def test_no_witness_is_not_no_action(self):
        with tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'E2E_ENGINE_SECRETS_CAPTURE':'1'}):
            root=pathlib.Path(d);a,e=fixture(root);e['nativeJoinRows'][0]['operationSeq']=999
            proof=v.verify(root,e,EXPECTED,BINARY,WRAPPER);self.assertEqual(proof['queryJoins'][0]['nativeWitnesses'],[]);self.assertEqual(proof['queryJoins'][0]['origin'],'unjoined')
    def test_full_native_proof_grants_only_secrets_group_and_keeps_six_plan(self):
        with tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'E2E_ENGINE_SECRETS_CAPTURE':'1','GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','NODE_SELECTOR':'24.22.1'}):
            workspace=pathlib.Path(d);evidence=cli_fixture(workspace);root=evidence/'fixtures/24.22.1/core';add_original_six(root);checker=original_checker(workspace);previous=os.getcwd();os.chdir(workspace)
            try:plan=checker.verify(root)
            finally:os.chdir(previous)
            self.assertEqual(len(plan),6);self.assertTrue(all(row['expected']==2 for row in plan));self.assertNotIn('engine-secrets',[row['fixture'] for row in plan])
    def test_secrets_ownership_never_discards_extra_or_broken_groups(self):
        for edit in ['foreign','disabled','missing-sidecar','duplicate-nonce','wrong-envelope','extra-same-scope']:
            with self.subTest(edit=edit),tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'E2E_ENGINE_SECRETS_CAPTURE':'1','GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','NODE_SELECTOR':'24.22.1'}):
                workspace=pathlib.Path(d);evidence=cli_fixture(workspace);root=evidence/'fixtures/24.22.1/core';add_original_six(root);checker=original_checker(workspace)
                if edit=='disabled':os.environ['E2E_ENGINE_SECRETS_CAPTURE']='0'
                elif edit=='missing-sidecar':(root/'invocations/daemon-1001.json').unlink()
                elif edit=='wrong-envelope':p=root/'test-e2e.log';p.write_bytes(p.read_bytes().replace(b'secrets-native-custody-v2',b'v1'))
                elif edit=='duplicate-nonce':
                    p=root/'invocations/invocation-1001.json';row=json.loads(p.read_text());row['nonce']=f'{101:064x}';write(p,row)
                else:
                    source=json.loads((root/'invocations/invocation-1001.json').read_text());source.update(pid=9999,nonce='f'*64)
                    if edit=='foreign':source['traceDirectory']='/tmp/p-ffffffffffff/.e2e/native-trace'
                    data=(json.dumps(source)+'\n').encode();write(root/'invocations/invocation-9999.json',data);write(root/'invocations/daemon-9999.json',{'schemaVersion':1,'kind':'spawn-owned-daemon','proxyPID':9999,'daemonPID':9998,'nonce':'f'*64,'invocationSHA256':hashlib.sha256(data).hexdigest()})
                previous=os.getcwd();os.chdir(workspace)
                try:
                    with self.assertRaises((AssertionError,ValueError,OSError)):checker.verify(root)
                finally:os.chdir(previous)
    def test_metadata_changes_during_descriptor_read_are_incomplete(self):
        for field in ['st_uid','st_mode','st_nlink','st_ctime_ns','st_mtime_ns']:
            with self.subTest(field=field),tempfile.TemporaryDirectory() as d:
                p=pathlib.Path(d)/'record';write(p,b'closed');original=os.fstat;calls=0
                def changed(fd):
                    nonlocal calls
                    value=original(fd);calls+=1
                    if calls==2:
                        attrs={key:getattr(value,key) for key in ['st_size','st_ino','st_dev','st_mtime_ns','st_ctime_ns','st_uid','st_mode','st_nlink']};attrs[field]+=1;return types.SimpleNamespace(**attrs)
                    return value
                with patch.object(v.os,'fstat',side_effect=changed):
                    with self.assertRaises(v.Invalid):v.read(p,512)
    def test_loss_can_grant_identity_but_diagnostic_cli_is_red_and_exit7_survives(self):
        with tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'E2E_ENGINE_SECRETS_CAPTURE':'1','GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','NODE_SELECTOR':'24.22.1'}):
            workspace=pathlib.Path(d);evidence=cli_fixture(workspace);root=evidence/'fixtures/24.22.1/core';add_original_six(root);checker=original_checker(workspace)
            target=root/'engine-secrets-native'/NONCE/'native-1001.jsonl';row=json.loads(target.read_text());row['droppedBefore']=1;write(target,row)
            spec=importlib.util.spec_from_file_location('loss_envelope',workspace/'scripts/ci/check-engine-secrets-envelope.py');cli=importlib.util.module_from_spec(spec);spec.loader.exec_module(cli)
            previous=os.getcwd();os.chdir(workspace)
            try:
                self.assertEqual(len(checker.verify(root)),6)
                with patch.object(sys,'argv',['validator','--evidence',str(evidence)]),patch('builtins.print'):self.assertEqual(cli.main(),1)
            finally:os.chdir(previous)
            status=json.loads((evidence/'engine-secrets-capture-status.json').read_text());self.assertEqual(status['artifactEnvelope'],'accepted');self.assertEqual(status['diagnosticStatus'],'incomplete');self.assertEqual(status['nativeCustody']['processCustody'],'verified');self.assertEqual(status['nativeCustody']['traceCoverage'],'incomplete');self.assertEqual(status['originalPackageTestExit'],7);self.assertEqual((evidence/'test-e2e.exit').read_text(),'7\n')
if __name__=='__main__':unittest.main()
