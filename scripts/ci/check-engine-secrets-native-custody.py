"""Closed, source-bound secrets native custody. No business verdict or absence inference."""
import hashlib,importlib.util,json,os,pathlib,re,stat
class Invalid(ValueError):pass
def need(ok,reason):
    if not ok:raise Invalid(reason)
def integer(v,lo=0,hi=9007199254740991):return type(v)is int and lo<=v<=hi
def exact(v,keys):need(type(v)is dict and set(v)==set(keys),'invalid-keys')
def unique(items):
    out={}
    for k,v in items:need(k not in out,'duplicate-key');out[k]=v
    return out
def parse(data):
    try:return json.loads(data,object_pairs_hook=unique)
    except Invalid:raise
    except Exception:raise Invalid('invalid-json') from None
def read(p,maximum):
    p=pathlib.Path(p);need(all(not x.is_symlink() for x in [p,*p.parents]),'symlink')
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        a=os.fstat(fd);need(stat.S_ISREG(a.st_mode) and a.st_nlink==1 and a.st_uid==os.geteuid() and a.st_size<=maximum,'file-shape')
        with os.fdopen(os.dup(fd),'rb') as stream:data=stream.read(maximum+1)
        b=os.fstat(fd);need(len(data)==a.st_size and (a.st_size,a.st_ino,a.st_dev,a.st_mtime_ns,a.st_ctime_ns,a.st_uid,a.st_mode,a.st_nlink)==(b.st_size,b.st_ino,b.st_dev,b.st_mtime_ns,b.st_ctime_ns,b.st_uid,b.st_mode,b.st_nlink),'changed-file')
        return data
    finally:os.close(fd)
def sha(b):return hashlib.sha256(b).hexdigest()
def rule(v,r):
    if r=='bool':return type(v)is bool
    if 'nullable'in r:return v is None or rule(v,r['nullable'])
    if 'int'in r:return integer(v,0,r['int'])
    if 'enum'in r:return any(type(v)is type(x) and v==x for x in r['enum'])
    if 'array'in r:return type(v)is list and len(v)==r['length'] and all(rule(x,r['array']) for x in v)
    if 'tuple'in r:return type(v)is list and len(v)==len(r['tuple']) and all(rule(x,y) for x,y in zip(v,r['tuple']))
    if 'oneOf'in r:return any(rule(v,x) for x in r['oneOf'])
    if 'object'in r:return type(v)is dict and set(v)<=set(r['object']) and set(r.get('required',[]))<=set(v) and all(rule(x,r['object'][k]) for k,x in v.items())
    return False
def load_script(name):
    file=pathlib.Path(__file__).with_name(name+'.py');spec=importlib.util.spec_from_file_location(name,file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def verify(root,envelope,expected,binary_hash,wrapper_hash):
    root=pathlib.Path(root);need(os.environ.get('E2E_ENGINE_SECRETS_CAPTURE')=='1','not-enabled')
    need(envelope.get('artifactEnvelope')=='accepted' and envelope.get('diagnosticContract')=='secrets-native-custody-v2' and envelope.get('identity')==expected,'invalid-envelope')
    nonce=envelope.get('captureNonce');need(type(nonce)is str and re.fullmatch('[a-f0-9]{64}',nonce),'invalid-nonce')
    directory=root/'engine-secrets-native'/nonce;need(directory.is_dir() and not directory.is_symlink(),'missing-native-archive')
    children=list((root/'engine-secrets-native').iterdir());need(len(children)==1 and children[0]==directory,'extra-native-region')
    meta=parse(read(directory/'custody.json',8192))
    exact(meta,{'schemaVersion','suite','captureNonce','traceDirectory','consumerRun','consumerAttempt','selector','nodeVersion','sourceCommit','sourceTree','nativeSHA256','wrapperSHA256','proxyPids','coverage','exhaustive'})
    need(meta['schemaVersion']==1 and meta['suite']=='engine-secrets' and meta['captureNonce']==nonce and meta['coverage']=='observed-only' and meta['exhaustive'] is False,'invalid-custody')
    for k in ['consumerRun','consumerAttempt','selector','nodeVersion','sourceCommit','sourceTree']:need(meta[k]==expected[k],'identity-mismatch')
    need(meta['nativeSHA256']==binary_hash and meta['wrapperSHA256']==wrapper_hash,'runtime-mismatch')
    trace=pathlib.Path(meta['traceDirectory']);need(trace.is_absolute() and trace.name=='native-trace' and trace.parent.name=='.e2e' and re.fullmatch('p-[a-f0-9]{12}',trace.parent.parent.name),'trace-directory-invalid')
    bindings=envelope.get('processBindings');need(type(bindings)is list and 0<len(bindings)<=32,'missing-bindings')
    owners={};pids=set()
    for b in bindings:
        pid=b['proxyPid'];key=(b['workerOrdinal'],b['client']);need(integer(pid,1,2**32-1) and key not in owners and pid not in pids,'ambiguous-binding');owners[key]=pid;pids.add(pid)
    need({key[0] for key in owners}==set(range(1,envelope.get('workerBindings',0)+1)),'missing-worker-process')
    need(type(meta['proxyPids'])is list and meta['proxyPids']==sorted(pids),'binding-census-mismatch')
    global_files=list((root/'invocations').iterdir());need(0<len(global_files)<=1024 and all(re.fullmatch(r'(invocation|daemon)-[1-9][0-9]*[.]json',p.name) for p in global_files),'global-invocation-census')
    selected=set()
    for file in global_files:
        if not file.name.startswith('invocation-'):continue
        receipt=parse(read(file,4096))
        exact(receipt,{'schemaVersion','pid','nonce','traceDirectory','nativeExecutable','nativeSHA256','wrapperSHA256','run','attempt','sourceCommit','sourceTree'})
        if receipt['traceDirectory']==str(trace):
            need(integer(receipt['pid'],1,2**32-1) and file.name==f"invocation-{receipt['pid']}.json" and receipt['pid'] not in selected,'global-invocation-binding');selected.add(receipt['pid'])
    need(selected==pids,'missing-process-binding')
    names={p.name for p in directory.iterdir()};need(names=={'custody.json'}|{f'{kind}-{p}.{ext}' for p in pids for kind,ext in [('native','jsonl'),('query','jsonl'),('invocation','json'),('daemon','json')]},'file-census-mismatch')
    schema=parse(read(pathlib.Path(__file__).with_name('native-closed-trace-schema.json'),128*1024));fields={'object':schema['fields'],'required':schema['required']}
    daemon_pids=set();nonces=set();total=0;loss=False;rows_by_pid={};files=[]
    for pid in sorted(pids):
        invbytes=read(directory/f'invocation-{pid}.json',4096);inv=parse(invbytes)
        exact(inv,{'schemaVersion','pid','nonce','traceDirectory','nativeExecutable','nativeSHA256','wrapperSHA256','run','attempt','sourceCommit','sourceTree'})
        need(inv['schemaVersion']==2 and inv['pid']==pid and inv['traceDirectory']==str(trace) and pathlib.Path(inv['nativeExecutable']).is_absolute(),'invalid-invocation')
        need(inv['nativeSHA256']==binary_hash and inv['wrapperSHA256']==wrapper_hash and inv['run']==expected['consumerRun'] and inv['attempt']==expected['consumerAttempt'] and inv['sourceCommit']==expected['sourceCommit'] and inv['sourceTree']==expected['sourceTree'],'invocation-identity')
        need(type(inv['nonce'])is str and re.fullmatch('[a-f0-9]{64}',inv['nonce']) and inv['nonce'] not in nonces,'invocation-nonce');nonces.add(inv['nonce'])
        need(invbytes==read(root/'invocations'/f'invocation-{pid}.json',4096),'foreign-invocation')
        mapbytes=read(directory/f'daemon-{pid}.json',1024);mapping=parse(mapbytes)
        exact(mapping,{'schemaVersion','kind','proxyPID','daemonPID','nonce','invocationSHA256'})
        daemon=mapping['daemonPID'];need(mapping['schemaVersion']==1 and mapping['kind']=='spawn-owned-daemon' and mapping['proxyPID']==pid and mapping['nonce']==inv['nonce'] and mapping['invocationSHA256']==sha(invbytes) and integer(daemon,1,2**32-1) and daemon!=pid and daemon not in daemon_pids,'invalid-daemon-mapping');daemon_pids.add(daemon)
        need(mapbytes==read(root/'invocations'/f'daemon-{pid}.json',1024),'foreign-daemon-mapping')
        rows_by_pid[pid]=[]
        for kind,maxrows,maxbytes in [('native',2048,256*1024),('query',128,64*1024)]:
            name=f'{kind}-{pid}.jsonl';data=read(directory/name,maxbytes);total+=len(data);need(total<=10*1024*1024,'native-total-cap');need(data.endswith(b'\n'),'partial-line');lines=data.splitlines(keepends=True);need(0<len(lines)<=maxrows,'native-row-cap')
            for i,line in enumerate(lines):
                need(len(line)<=512 and line.endswith(b'\n'),'native-line-cap');row=parse(line);need(rule(row,fields) and row['schemaVersion']==2 and row['pid']==daemon and row['source']=='native','native-schema')
                if i==0:need(row['phase']=='CaptureStarted' and row['record']==0,'missing-start')
                loss |= row['record']!=i or row['droppedBefore']!=0 or row['suppressedBefore']!=0 or row['overflow'] is not False or row['phase'] in ('CaptureLimitReached','TargetObservationLost')
                rows_by_pid[pid].append(row)
            files.append({'kind':kind,'proxyPid':pid,'daemonPid':daemon,'rows':len(lines),'bytes':len(data),'sha256':sha(data)})
    # Native operation IDs are usable only inside this independently joined process.
    joins=[]
    for row in envelope.get('nativeJoinRows',[]):
        pid=owners.get((row['workerOrdinal'],row['client']));need(pid is not None,'unbound-client')
        if row['kind']=='query':
            hits=[x for x in rows_by_pid[pid] if x.get('generation')==row['generation'] and x.get('operationSeq')==row['operationSeq'] and x['phase'] in ('QueryScopeRefusal','QueryReadFailure')]
            joins.append({'workerOrdinal':row['workerOrdinal'],'caseOrdinal':row['caseOrdinal'],'client':row['client'],'generation':row['generation'],'operationSeq':row['operationSeq'],'nativeWitnesses':hits,'origin':'unjoined'})
    return {'schemaVersion':1,'suite':'engine-secrets','processCustody':'verified','traceDirectory':str(trace),'proxyPids':sorted(pids),'daemonPids':sorted(daemon_pids),'captureNonce':nonce,'traceCoverage':'incomplete' if loss else 'observed','exhaustive':False,'noAbsenceInference':True,'files':files,'queryJoins':joins}

def verify_from_evidence(root):
    root=pathlib.Path(root);evidence=root.parents[2];checker=load_script('check-engine-secrets-envelope')
    expected={'consumerRun':os.environ.get('GITHUB_RUN_ID',''),'consumerAttempt':os.environ.get('GITHUB_RUN_ATTEMPT',''),'selector':os.environ.get('NODE_SELECTOR',''),'nodeVersion':read(evidence/'node.version',256).decode().strip(),'sourceCommit':read(evidence/'source.commit',256).decode().strip(),'sourceTree':read(evidence/'source.tree',256).decode().strip(),'caseSchema':'engine-secrets-five-v1'}
    with (root/'test-e2e.log').open('rb') as stream:envelope=checker.verify_log(stream,expected)
    pins=parse(read(pathlib.Path(__file__).with_name('full-standard-runtime-pins.json'),65536));need(pins.get('configured') is True,'runtime-not-configured')
    return verify(root,envelope,expected,pins['ordinary']['binarySha256'],sha(read(evidence/'tools'/'popup-trace.sh',65536)))
