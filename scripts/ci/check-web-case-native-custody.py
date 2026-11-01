"""Only three original ordinary Web cases; capture integrity, never business truth."""
import hashlib,importlib.util,json,os,pathlib,re,sys
HERE=pathlib.Path(__file__).parent
spec=importlib.util.spec_from_file_location('closed_custody',HERE/'check-engine-secrets-native-custody.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
CASES={
 'hung-recovery':('cdp-recovery.test.ts','bounds a hung reconnect resolver and propagates cancellation to it'),
 'lifecycle-open-cancel':('lifecycle.test.ts','cancels an in-flight native operation when its signal aborts'),
 'popup-replacement':('native-playwright-dialog-ownership.test.ts','keeps native decisions for script-created popups and an isolated replacement'),
}
def directory(p):
 v.need(p.is_absolute() and p.resolve()==p and p.is_dir() and not p.is_symlink(),'directory')
 for part in [p,*p.parents]:v.need(not part.is_symlink(),'directory-link')
 st=p.stat();v.need(st.st_uid==os.geteuid() and st.st_mode&0o777==0o700,'directory-owner')
def verify(evidence):
 evidence=pathlib.Path(evidence).resolve();workspace=evidence.parent
 v.need(evidence==workspace/'evidence' and str(workspace)==os.environ.get('GITHUB_WORKSPACE'),'workspace')
 source=v.read(evidence/'source.commit',128).decode().strip();tree=v.read(evidence/'source.tree',128).decode().strip();node=v.read(evidence/'node.version',128).decode().strip();selector=os.environ.get('NODE_SELECTOR','')
 v.need(re.fullmatch(r'(22|24|26)(?:\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2}))?',selector) and re.fullmatch(r'v(22|24|26)\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})',node),'node-shape')
 v.need((selector==node[1:]) if '.' in selector else selector==node[1:].split('.')[0],'node-binding')
 v.need(re.fullmatch('[a-f0-9]{40}',source) and re.fullmatch('[a-f0-9]{40}',tree) and source==os.environ.get('GITHUB_SHA'),'source')
 run=os.environ.get('GITHUB_RUN_ID');attempt=os.environ.get('GITHUB_RUN_ATTEMPT');v.need(type(run)is str and type(attempt)is str and re.fullmatch('[1-9][0-9]*',run) and re.fullmatch('[1-9][0-9]*',attempt),'run')
 expected={'run':run,'attempt':attempt,'selector':selector,'nodeVersion':node,'sourceCommit':source,'sourceTree':tree}
 binding=v.parse(v.read(evidence/'fixtures'/selector/'web'/'binding.json',65536));v.need(binding.get('lane')=='web' and all(binding.get(k)==value for k,value in expected.items()),'binding')
 pins=v.parse(v.read(workspace/'scripts/ci/full-standard-runtime-pins.json',65536));v.need(pins.get('configured')is True,'pins')
 native_hash=pins['ordinary']['binarySha256'];v.need(binding.get('nativeSha256',{}).get('ordinary')==native_hash,'binary-binding')
 wrapper_hash=v.sha(v.read(evidence/'tools/web-native-trace.sh',65536));v.need(wrapper_hash==v.sha(v.read(workspace/'scripts/ci/native-trace-wrapper.sh',65536)),'wrapper-binding')
 schema=v.parse(v.read(HERE/'native-closed-trace-schema.json',128*1024));rule={'object':schema['fields'],'required':schema['required']}
 results=v.parse(v.read(evidence/'web/ordinary/results.json',32*1024*1024));capture=evidence/'web-case-native';directory(capture);v.need({p.name for p in capture.iterdir()}==set(CASES),'case-census')
 invroot=evidence/'fixture-invocations';directory(invroot);used=set();daemons=set();case_nonces=set();invocation_nonces=set();rows=[]
 for case,(file,title) in CASES.items():
  hits=[test for suite in results.get('testResults',[]) if suite.get('name')==str(workspace/'packages/web/tests/integration'/file) for test in suite.get('assertionResults',[]) if test.get('title')==title]
  v.need(len(hits)==1 and hits[0].get('status') in ['passed','failed'],'case-result')
  root=capture/case;directory(root)
  header=v.parse(v.read(root/'case.json',4096));v.exact(header,{'schemaVersion','caseId','nonce','traceDirectory','run','attempt','selector','nodeVersion','sourceCommit','sourceTree','nativeExecutable','nativeSHA256','wrapperSHA256'})
  v.need(header['schemaVersion']==1 and header['caseId']==case and type(header['nonce'])is str and re.fullmatch('[a-f0-9]{64}',header['nonce']) and all(header[k]==value for k,value in expected.items()),'case-header')
  v.need(header['nonce'] not in case_nonces,'reused-case-nonce');case_nonces.add(header['nonce'])
  v.need(header['nativeSHA256']==native_hash and header['wrapperSHA256']==wrapper_hash,'case-runtime')
  native=pathlib.Path(header['nativeExecutable']);v.need(native.is_absolute() and native.resolve()==native and v.sha(v.read(native,128*1024*1024))==native_hash,'native-unchanged')
  finish=v.parse(v.read(root/'finished.json',1024));v.exact(finish,{'schemaVersion','caseId','nonce','state'});v.need(finish=={'schemaVersion':1,'caseId':case,'nonce':header['nonce'],'state':'scope-finished'},'finish')
  project_name='p-'+header['nonce'][:12];v.need({p.name for p in root.iterdir()}=={'case.json','finished.json',project_name},'case-files')
  project=root/project_name;directory(project);v.need({p.name for p in project.iterdir()}=={'.e2e'},'project-files')
  private=project/'.e2e';directory(private);v.need({p.name for p in private.iterdir()}=={'native-trace'},'private-files')
  trace=private/'native-trace';directory(trace);v.need(header['traceDirectory']==str(trace),'case-trace')
  names={p.name for p in trace.iterdir()};native_names=[name for name in names if re.fullmatch(r'native-[1-9][0-9]*\.jsonl',name)];v.need(len(native_names)==1,'proxy-census');pid=int(native_names[0][7:-6]);v.need(0<pid<=2**32-1 and names=={f'native-{pid}.jsonl',f'query-{pid}.jsonl'},'trace-census')
  invname=f'invocation-{pid}.json';mapname=f'daemon-{pid}.json';v.need(invname not in used,'reused-proxy');used|={invname,mapname}
  raw=v.read(invroot/invname,4096);inv=v.parse(raw);v.exact(inv,{'schemaVersion','pid','nonce','traceDirectory','nativeExecutable','nativeSHA256','wrapperSHA256','run','attempt','sourceCommit','sourceTree'})
  v.need(inv['schemaVersion']==2 and inv['pid']==pid and type(inv['nonce'])is str and re.fullmatch('[a-f0-9]{64}',inv['nonce']),'invocation')
  v.need(inv['nonce'] not in invocation_nonces,'reused-invocation-nonce');invocation_nonces.add(inv['nonce'])
  for key in ['traceDirectory','nativeExecutable','nativeSHA256','wrapperSHA256','run','attempt','sourceCommit','sourceTree']:v.need(inv[key]==header[key],'invocation-binding')
  mapping=v.parse(v.read(invroot/mapname,1024));v.exact(mapping,{'schemaVersion','kind','proxyPID','daemonPID','nonce','invocationSHA256'});daemon=mapping['daemonPID']
  v.need(mapping['schemaVersion']==1 and mapping['kind']=='spawn-owned-daemon' and mapping['proxyPID']==pid and v.integer(daemon,1,2**32-1) and daemon!=pid and daemon not in daemons and mapping['nonce']==inv['nonce'] and mapping['invocationSHA256']==v.sha(raw),'daemon-binding');daemons.add(daemon)
  files=[];terminal=False
  for kind,cap,bytecap in [('native',2048,256*1024),('query',128,64*1024)]:
   data=v.read(trace/f'{kind}-{pid}.jsonl',bytecap);v.need(data.endswith(b'\n'),'partial');lines=data.splitlines(keepends=True);v.need(0<len(lines)<=cap,'row-cap')
   for i,line in enumerate(lines):
    v.need(len(line)<=512 and line.endswith(b'\n'),'line-cap');row=v.parse(line)
    v.need(v.rule(row,rule) and v.new_failure_fields(row) and row['source']=='native' and row['pid']==daemon and row['record']==i and row['emittedBefore']==i,'closed-row')
    if i==0:v.need(row['phase']=='CaptureStarted','start')
    v.need(row['droppedBefore']==0 and row['suppressedBefore']==0 and row['overflow']is False and row['phase'] not in ['CaptureLimitReached','TargetObservationLost'],'capture-loss')
    if kind=='native' and row['phase']=='TerminalCleanupCheckpoint' and row.get('terminalCleanupStage')=='shutdown-joins':terminal=True
   files.append({'kind':kind,'rows':len(lines),'bytes':len(data),'sha256':v.sha(data)})
  v.need(terminal,'missing-shutdown-observation')
  rows.append({'caseId':case,'proxyPid':pid,'daemonPid':daemon,'originalBusinessStatus':hits[0]['status'],'files':files})
 v.need({p.name for p in invroot.iterdir()}==used,'orphan-invocation')
 return {'schemaVersion':1,'diagnosticStatus':'observed','processCustody':'verified','exhaustive':False,'noAbsenceInference':True,'cases':rows}
# Focused diagnostics deliberately do not consume or mutate ordinary runtime pins.
HUNG_NATIVE_COMMIT='0537c6550dfa9a32e4f6e80ba9d3872169cc5663'
HUNG_NATIVE_TREE='b5a280386db11396fc45e1d68471806b2fa91ee8'
HUNG_CASE='hung-recovery'
HUNG_TITLE='bounds a hung reconnect resolver and propagates cancellation to it'
HUNG_FULL_NAME='CDP session recovery '+HUNG_TITLE
HUNG_STAGES={
 'enrollment-eligibility','enrollment-connection-proof','enrollment-received-frontier',
 'enrollment-root-lock','enrollment-index-lock','enrollment-index-failure',
 'enrollment-index-unreconciled','enrollment-index-frontier','enrollment-pending-enrollment',
 'enrollment-pending-realms','enrollment-realm-tickets','enrollment-pending-restart',
 'enrollment-pending-blank','enrollment-retiring-pages','enrollment-session-state',
 'enrollment-original-root','enrollment-ancestry','enrollment-missing-ledger',
 'enrollment-cleanup-owner','enrollment-ledger-owner','enrollment-targets-owner',
 'enrollment-target-final-state','enrollment-ledger-final-state',
}
def _git(root,*args):
 import subprocess
 try:return subprocess.check_output(['git','-C',str(root),*args],env={**os.environ,'GIT_NO_LAZY_FETCH':'1'},stderr=subprocess.DEVNULL).decode().strip()
 except Exception:raise v.Invalid('git-identity') from None

def _hung_runtime(evidence):
 workspace=pathlib.Path(os.environ.get('GITHUB_WORKSPACE',''))
 v.need(workspace.is_absolute() and workspace.resolve()==workspace,'workspace')
 root=workspace/'.artifacts/hung-enrollment-diagnostic'
 v.need(evidence==root/'evidence' and evidence.resolve()==evidence,'focused-evidence-root')
 v.need(os.environ.get('E2E_HUNG_DIAGNOSTIC_EVIDENCE_ROOT')==str(evidence) and os.environ.get('E2E_WEB_THREE_CASE_NATIVE_CAPTURE')=='1','focused-opt-in')
 source=v.read(evidence/'source.commit',128).decode().strip();tree=v.read(evidence/'source.tree',128).decode().strip()
 v.need(re.fullmatch('[a-f0-9]{40}',source) and re.fullmatch('[a-f0-9]{40}',tree),'source-shape')
 v.need(source==os.environ.get('GITHUB_SHA')==_git(workspace,'rev-parse','HEAD') and tree==_git(workspace,'rev-parse','HEAD^{tree}'),'source-git')
 v.need(_git(workspace,'status','--porcelain')=='','source-pristine')
 node=v.read(evidence/'node.version',128).decode().strip()
 v.need(node=='v26.13.0' and os.environ.get('NODE_SELECTOR')=='26.13.0','exact-node')
 run=os.environ.get('GITHUB_RUN_ID');attempt=os.environ.get('GITHUB_RUN_ATTEMPT')
 v.need(type(run)is str and type(attempt)is str and re.fullmatch('[1-9][0-9]*',run) and re.fullmatch('[1-9][0-9]*',attempt),'run')
 v.need(os.environ.get('GITHUB_REPOSITORY')=='levicode/e2e','repository')
 runtime=root/'native-runtime';native_source=root/'native-source';target=root/'target/ci/agent-browser'
 v.need(native_source.is_dir() and native_source.resolve()==native_source,'native-source-directory')
 v.need(runtime.is_dir() and {p.name for p in runtime.iterdir()}=={'agent-browser','compiler.jsonl','rustc.txt','manifest.json'},'runtime-inventory')
 raw=v.read(runtime/'manifest.json',65536);digest=v.read(evidence/'native-manifest.sha256',128).decode().strip()
 v.need(re.fullmatch('[a-f0-9]{64}',digest) and digest==v.sha(raw),'runtime-manifest-hash')
 manifest=v.parse(raw)
 v.exact(manifest,{'schemaVersion','kind','acceptanceEvidence','source','repository','runId','runAttempt','platform','architecture','nativeRepository','nativeSource','compilation','binarySha256','compilerSha256','rustcSha256'})
 v.need(type(manifest['schemaVersion'])is int and manifest['schemaVersion']==1 and manifest['kind']=='source-built-ci-runtime' and manifest['acceptanceEvidence']is False,'runtime-kind')
 v.need(manifest['source']=={'commit':source,'tree':tree} and manifest['repository']=='levicode/e2e' and manifest['runId']==run and manifest['runAttempt']==attempt and manifest['platform']=='linux' and manifest['architecture']=='x64','runtime-source')
 v.need(manifest['nativeRepository']=='levicode/agent-browser' and manifest['nativeSource']=={'commit':HUNG_NATIVE_COMMIT,'tree':HUNG_NATIVE_TREE},'native-pin')
 v.need(_git(native_source,'rev-parse','HEAD')==HUNG_NATIVE_COMMIT and _git(native_source,'rev-parse','HEAD^{tree}')==HUNG_NATIVE_TREE and _git(native_source,'status','--porcelain')=='','native-checkout')
 compilation={'profile':'ci','features':[],'manifestPath':str(native_source/'cli/Cargo.toml'),'sourcePath':str(native_source/'cli/src/main.rs'),'executable':str(target)}
 v.need(manifest['compilation']==compilation,'compiler-paths')
 files={}
 for name,field,cap in [('agent-browser','binarySha256',128*1024*1024),('compiler.jsonl','compilerSha256',32*1024*1024),('rustc.txt','rustcSha256',65536)]:
  data=v.read(runtime/name,cap);v.need(data and type(manifest[field])is str and re.fullmatch('[a-f0-9]{64}',manifest[field]) and v.sha(data)==manifest[field],'runtime-file-hash');files[name]=data
 v.need(v.sha(v.read(target,128*1024*1024))==manifest['binarySha256'],'compiler-binary-copy')
 records=[v.parse(line) for line in files['compiler.jsonl'].splitlines()]
 v.need(records and all(type(row)is dict for row in records),'compiler-records')
 finished=[row for row in records if row.get('reason')=='build-finished']
 v.need(len(finished)==1 and finished[0].get('success')is True,'compiler-finished')
 artifacts=[row for row in records if row.get('reason')=='compiler-artifact' and type(row.get('target'))is dict and row['target'].get('name')=='agent-browser' and type(row.get('profile'))is dict and row['profile'].get('test')is False]
 v.need(len(artifacts)==1,'compiler-artifact-count');binary=artifacts[0]
 v.need(binary.get('features')==[] and binary['target'].get('kind')==['bin'] and binary.get('manifest_path')==compilation['manifestPath'] and binary['target'].get('src_path')==compilation['sourcePath'] and binary.get('executable')==compilation['executable'],'compiler-production-identity')
 return workspace,{'run':run,'attempt':attempt,'selector':'26.13.0','nodeVersion':node,'sourceCommit':source,'sourceTree':tree},manifest['binarySha256'],runtime/'agent-browser',digest

def _hung_census(evidence,workspace):
 expected_file=str(workspace/'packages/web/tests/integration/cdp-recovery.test.ts')
 collection=v.parse(v.read(evidence/'web/ordinary/collection.json',32*1024*1024))
 v.need(type(collection)is list and len(collection)==1 and collection[0].get('file')==expected_file and collection[0].get('name')=='CDP session recovery > '+HUNG_TITLE,'focused-collection')
 results=v.parse(v.read(evidence/'web/ordinary/results.json',32*1024*1024))
 v.need(type(results)is dict and type(results.get('testResults'))is list and results['testResults'],'focused-results')
 executed=[]
 for suite in results['testResults']:
  v.need(type(suite)is dict and type(suite.get('assertionResults'))is list and suite.get('testExecError')is None,'focused-suite')
  for row in suite['assertionResults']:
   v.need(type(row)is dict and row.get('status') in ['passed','failed','pending','skipped','todo','disabled'],'focused-result-status')
   if row['status'] in ['passed','failed']:executed.append((suite.get('name'),row))
 v.need(len(executed)==1 and executed[0][0]==expected_file,'focused-exactly-once')
 row=executed[0][1]
 v.need(row.get('title')==HUNG_TITLE and row.get('ancestorTitles')==['CDP session recovery'] and row.get('fullName')==HUNG_FULL_NAME,'focused-original-title')
 return results

def verify_hung(evidence):
 evidence=pathlib.Path(evidence)
 workspace,expected,native_hash,runtime_native,manifest_digest=_hung_runtime(evidence)
 selector=expected['selector']
 binding=v.parse(v.read(evidence/'fixtures'/selector/'web'/'binding.json',65536));v.need(binding.get('lane')=='web' and all(binding.get(k)==value for k,value in expected.items()),'binding')
 v.need(binding.get('nativeSha256',{}).get('ordinary')==native_hash,'binary-binding')
 wrapper_hash=v.sha(v.read(evidence/'tools/web-native-trace.sh',65536));v.need(wrapper_hash==v.sha(v.read(workspace/'scripts/ci/native-trace-wrapper.sh',65536)),'wrapper-binding')
 schema=v.parse(v.read(HERE/'native-closed-trace-schema.json',128*1024));rule={'object':schema['fields'],'required':schema['required']}
 stages=schema['fields']['terminalCleanupStage']['enum'];v.need(type(stages)is list and len(stages)==33 and set(stages)==HUNG_STAGES|{'task-proof','owner-preconditions','runtime-release','persistent-probe','enrollment-proof','ledger-commands-present','physical-close','ordinary-close','shutdown-joins','final-commit'},'focused-stage-closure')
 results=_hung_census(evidence,workspace);capture=evidence/'web-case-native';directory(capture);v.need({p.name for p in capture.iterdir()}=={HUNG_CASE},'case-census')
 invroot=evidence/'fixture-invocations';directory(invroot);used=set();daemons=set();case_nonces=set();invocation_nonces=set();rows=[]
 for case,(file,title) in {HUNG_CASE:CASES[HUNG_CASE]}.items():
  hits=[test for suite in results.get('testResults',[]) if suite.get('name')==str(workspace/'packages/web/tests/integration'/file) for test in suite.get('assertionResults',[]) if test.get('title')==title]
  v.need(len(hits)==1 and hits[0].get('status') in ['passed','failed'],'case-result')
  root=capture/case;directory(root)
  header=v.parse(v.read(root/'case.json',4096));v.exact(header,{'schemaVersion','caseId','nonce','traceDirectory','run','attempt','selector','nodeVersion','sourceCommit','sourceTree','nativeExecutable','nativeSHA256','wrapperSHA256'})
  v.need(header['schemaVersion']==1 and header['caseId']==case and type(header['nonce'])is str and re.fullmatch('[a-f0-9]{64}',header['nonce']) and all(header[k]==value for k,value in expected.items()),'case-header')
  v.need(header['nonce'] not in case_nonces,'reused-case-nonce');case_nonces.add(header['nonce'])
  v.need(header['nativeSHA256']==native_hash and header['wrapperSHA256']==wrapper_hash,'case-runtime')
  native=pathlib.Path(header['nativeExecutable']);v.need(native==runtime_native,'focused-runtime-path');v.need(native.is_absolute() and native.resolve()==native and v.sha(v.read(native,128*1024*1024))==native_hash,'native-unchanged')
  finish=v.parse(v.read(root/'finished.json',1024));v.exact(finish,{'schemaVersion','caseId','nonce','state'});v.need(finish=={'schemaVersion':1,'caseId':case,'nonce':header['nonce'],'state':'scope-finished'},'finish')
  project_name='p-'+header['nonce'][:12];v.need({p.name for p in root.iterdir()}=={'case.json','finished.json',project_name},'case-files')
  project=root/project_name;directory(project);v.need({p.name for p in project.iterdir()}=={'.e2e'},'project-files')
  private=project/'.e2e';directory(private);v.need({p.name for p in private.iterdir()}=={'native-trace'},'private-files')
  trace=private/'native-trace';directory(trace);v.need(header['traceDirectory']==str(trace),'case-trace')
  names={p.name for p in trace.iterdir()};native_names=[name for name in names if re.fullmatch(r'native-[1-9][0-9]*\.jsonl',name)];v.need(len(native_names)==1,'proxy-census');pid=int(native_names[0][7:-6]);v.need(0<pid<=2**32-1 and names=={f'native-{pid}.jsonl',f'query-{pid}.jsonl'},'trace-census')
  invname=f'invocation-{pid}.json';mapname=f'daemon-{pid}.json';v.need(invname not in used,'reused-proxy');used|={invname,mapname}
  raw=v.read(invroot/invname,4096);inv=v.parse(raw);v.exact(inv,{'schemaVersion','pid','nonce','traceDirectory','nativeExecutable','nativeSHA256','wrapperSHA256','run','attempt','sourceCommit','sourceTree'})
  v.need(inv['schemaVersion']==2 and inv['pid']==pid and type(inv['nonce'])is str and re.fullmatch('[a-f0-9]{64}',inv['nonce']),'invocation')
  v.need(inv['nonce'] not in invocation_nonces,'reused-invocation-nonce');invocation_nonces.add(inv['nonce'])
  for key in ['traceDirectory','nativeExecutable','nativeSHA256','wrapperSHA256','run','attempt','sourceCommit','sourceTree']:v.need(inv[key]==header[key],'invocation-binding')
  mapping=v.parse(v.read(invroot/mapname,1024));v.exact(mapping,{'schemaVersion','kind','proxyPID','daemonPID','nonce','invocationSHA256'});daemon=mapping['daemonPID']
  v.need(mapping['schemaVersion']==1 and mapping['kind']=='spawn-owned-daemon' and mapping['proxyPID']==pid and v.integer(daemon,1,2**32-1) and daemon!=pid and daemon not in daemons and mapping['nonce']==inv['nonce'] and mapping['invocationSHA256']==v.sha(raw),'daemon-binding');daemons.add(daemon)
  files=[];terminal=False;substage=None;outer_refused=False
  for kind,cap,bytecap in [('native',2048,256*1024),('query',128,64*1024)]:
   data=v.read(trace/f'{kind}-{pid}.jsonl',bytecap);v.need(data.endswith(b'\n'),'partial');lines=data.splitlines(keepends=True);v.need(0<len(lines)<=cap,'row-cap')
   for i,line in enumerate(lines):
    v.need(len(line)<=512 and line.endswith(b'\n'),'line-cap');row=v.parse(line)
    v.need(v.rule(row,rule) and v.new_failure_fields(row) and row['source']=='native' and row['pid']==daemon and row['record']==i and row['emittedBefore']==i,'closed-row')
    if i==0:v.need(row['phase']=='CaptureStarted','start')
    v.need(row['droppedBefore']==0 and row['suppressedBefore']==0 and row['overflow']is False and row['phase'] not in ['CaptureLimitReached','TargetObservationLost'],'capture-loss')
    if kind=='native' and row['phase']=='TerminalCleanupCheckpoint':
     stage=row.get('terminalCleanupStage')
     if stage=='shutdown-joins':terminal=True
     if stage in HUNG_STAGES:
      v.need(row.get('terminalCleanupOk')is False and row['operationSeq']==0 and substage is None and not outer_refused,'focused-first-refusal');substage=stage
     if stage=='enrollment-proof' and row.get('terminalCleanupOk')is False:
      v.need(substage is not None and not outer_refused,'focused-missing-first-refusal');outer_refused=True
   files.append({'kind':kind,'rows':len(lines),'bytes':len(data),'sha256':v.sha(data)})
  v.need(terminal,'missing-shutdown-observation');v.need(substage is None or outer_refused,'focused-missing-outer-refusal')
  rows.append({'caseId':case,'proxyPid':pid,'daemonPid':daemon,'originalBusinessStatus':hits[0]['status'],'files':files,'firstEnrollmentRefusal':substage,'enrollmentRefusalObserved':outer_refused})
 v.need({p.name for p in invroot.iterdir()}==used,'orphan-invocation')
 return {'schemaVersion':1,'diagnosticMode':'hung-enrollment','diagnosticStatus':'observed','processCustody':'verified','exhaustive':False,'noAbsenceInference':True,'fullNativeGate':False,'installedAcceptance':False,'nativeManifestSHA256':manifest_digest,'cases':rows}
def main():
 focused=len(sys.argv)==3 and sys.argv[1]=='--hung-diagnostic'
 v.need(focused or len(sys.argv)==2,'arguments')
 evidence=pathlib.Path(sys.argv[2] if focused else sys.argv[1]);result={'schemaVersion':1,'diagnosticStatus':'incomplete','exhaustive':False,'noAbsenceInference':True}
 try:result=verify_hung(evidence) if focused else verify(evidence);status=0
 except Exception:status=1
 (evidence/'web-case-native-status.json').write_text(json.dumps(result,indent=2)+'\n');return status
if __name__=='__main__':sys.exit(main())
