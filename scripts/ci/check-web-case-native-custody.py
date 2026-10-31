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
  root=capture/case;directory(root);v.need({p.name for p in root.iterdir()}=={'case.json','finished.json','trace'},'case-files')
  header=v.parse(v.read(root/'case.json',4096));v.exact(header,{'schemaVersion','caseId','nonce','traceDirectory','run','attempt','selector','nodeVersion','sourceCommit','sourceTree','nativeExecutable','nativeSHA256','wrapperSHA256'})
  v.need(header['schemaVersion']==1 and header['caseId']==case and type(header['nonce'])is str and re.fullmatch('[a-f0-9]{64}',header['nonce']) and all(header[k]==value for k,value in expected.items()),'case-header')
  v.need(header['nonce'] not in case_nonces,'reused-case-nonce');case_nonces.add(header['nonce'])
  v.need(header['nativeSHA256']==native_hash and header['wrapperSHA256']==wrapper_hash,'case-runtime')
  native=pathlib.Path(header['nativeExecutable']);v.need(native.is_absolute() and native.resolve()==native and v.sha(v.read(native,128*1024*1024))==native_hash,'native-unchanged')
  finish=v.parse(v.read(root/'finished.json',1024));v.exact(finish,{'schemaVersion','caseId','nonce','state'});v.need(finish=={'schemaVersion':1,'caseId':case,'nonce':header['nonce'],'state':'scope-finished'},'finish')
  trace=root/'trace';directory(trace);v.need(header['traceDirectory']==str(trace),'case-trace')
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
def main():
 evidence=pathlib.Path(sys.argv[1]);result={'schemaVersion':1,'diagnosticStatus':'incomplete','exhaustive':False,'noAbsenceInference':True}
 try:result=verify(evidence);status=0
 except Exception:status=1
 (evidence/'web-case-native-status.json').write_text(json.dumps(result,indent=2)+'\n');return status
if __name__=='__main__':sys.exit(main())
