"""Exact original benchmark attempt custody; selected closed rows are not a verdict."""
import hashlib,importlib.util,json,os,pathlib,re,stat,subprocess,sys
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('hung',HERE/'collect-spec-hung-cleanup.py');hung=importlib.util.module_from_spec(spec);spec.loader.exec_module(hung)
CASE='iframe-form-iframe-form-the-code-read-from-d99d69d8e6ab5f0e'
FILES=['.github/native-candidate.json','.github/workflows/benchmark.yml','scripts/ci/benchmark-iframe-capture.py','scripts/ci/native-trace-wrapper.sh','scripts/ci/native-closed-trace-schema.json','scripts/ci/collect-spec-hung-cleanup.py','scripts/ci/check-engine-secrets-native-custody.py','packages/web/src/native/benchmark-iframe-diagnostics.ts','packages/web/src/native/process.ts','packages/web/src/native/client.ts','packages/web/src/native-surface.ts','apps/web-benchmark/tests/iframe-form.e2e.ts','apps/web-benchmark/e2e.config.ts']
def sha(b):return hashlib.sha256(b).hexdigest()
def read(p,cap=262144):
    st=p.lstat();assert stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_size<=cap and p.resolve()==p
    return p.read_bytes()
def binding(ws):
    assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=ws,text=True).strip()==os.environ['GITHUB_SHA']
    binary=pathlib.Path(os.environ['E2E_DIAGNOSTIC_NATIVE_EXECUTABLE'])
    pin=json.loads(read(ws/'.github/native-candidate.json'));assert pin['repository']=='levicode/agent-browser' and re.fullmatch('[a-f0-9]{40}',pin['commit'])
    result={'nativeCommit':pin['commit'],'sourceCommit':os.environ['GITHUB_SHA'],'sourceTree':subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=ws,text=True).strip(),'run':os.environ['GITHUB_RUN_ID'],'runAttempt':os.environ['GITHUB_RUN_ATTEMPT'],'nativeSHA256':sha(read(binary,128*1024*1024)),'sources':{p:sha(read(ws/p,4*1024*1024)) for p in FILES}}
    assert re.fullmatch('[a-f0-9]{40}',result['sourceCommit']) and re.fullmatch('[a-f0-9]{40}',result['sourceTree']) and re.fullmatch('[1-9][0-9]*',result['run']) and re.fullmatch('[1-9][0-9]*',result['runAttempt'])
    return result
def prepare(ws):
    root=ws/'evidence/benchmark-iframe';raw=root/'raw';inv=ws/'evidence/fixture-invocations'
    for p in [root,raw,inv]:p.mkdir(parents=True,mode=0o700,exist_ok=False)
    wrapper=root/'native-trace-wrapper.sh';wrapper.write_bytes(read(ws/'scripts/ci/native-trace-wrapper.sh'));wrapper.chmod(0o755)
    os.environ['E2E_DIAGNOSTIC_NATIVE_EXECUTABLE']=os.environ['E2E_AGENT_BROWSER_EXECUTABLE']
    b=binding(ws);assert re.fullmatch('[a-f0-9]{40}',b['sourceCommit']) and re.fullmatch('[a-f0-9]{40}',b['sourceTree']);assert re.fullmatch('[1-9][0-9]*',b['run']) and re.fullmatch('[1-9][0-9]*',b['runAttempt']);(root/'binding.json').write_text(json.dumps(b)+'\n')
    values={'E2E_BENCHMARK_IFRAME_CAPTURE':'1','E2E_DIAGNOSTIC_NATIVE_EXECUTABLE':os.environ['E2E_AGENT_BROWSER_EXECUTABLE'],'E2E_DIAGNOSTIC_DIR':str(raw),'E2E_DIAGNOSTIC_INVOCATIONS':str(inv),'E2E_CAPTURE_SOURCE_TREE':b['sourceTree'],'E2E_BENCHMARK_CAPTURE_EXECUTABLE':str(wrapper)}
    # Validate the whole payload first; only its last line activates the wrapper.
    assert all('\n' not in value and '\r' not in value for value in values.values())
    payload=''.join(key+'='+value+'\n' for key,value in values.items())
    with open(os.environ['GITHUB_ENV'],'a') as f:f.write(payload)
def ts_rows(data,pid,attempt):
    assert data.endswith(b'\n') and len(data)<=65536
    rows=[];lines=data.splitlines();assert 0<len(lines)<128
    for i,line in enumerate(lines):
        assert len(line)<=1024;r=hung.closed.parse(line)
        base={'v','case','proxyPid','attempt','record','kind'}
        assert all(type(r[k])is int for k in ['v','proxyPid','attempt','record'])
        assert r['v']==1 and r['case']=='iframe-correct-code' and r['proxyPid']==pid and r['attempt']==attempt and r['record']==i
        kind=r['kind'];assert kind in ['start','result','terminal-error']
        keys=set() if kind=='start' else {'code'} if kind=='terminal-error' else {'command','generation','operationSeq','ok','effects','scopeState','code'}
        assert set(r)==base|keys
        if kind=='start':assert i==0
        else:
            assert r['code'] in ['none','unknown','cleanup-failed','stale-reference','scope-unavailable','stale-scope','cancelled','deadline-exceeded','browser-failure','frame-not-found','invalid-frame']
        if kind=='result':
            assert r['command'] in ['browser.perform','browser.trace','browser.observe','fixture.query','fixture.read-fields','scope.end']
            assert type(r['generation'])is int and 0<r['generation']<=2**53-1 and type(r['operationSeq'])is int and 0<r['operationSeq']<=2**53-1
            assert type(r['ok'])is bool and r['effects'] in ['not-dispatched','completed','unknown'] and r['scopeState'] in ['usable','quarantined','closed']
            assert (r['code']=='none')==r['ok']
        rows.append(r)
    assert rows[0]['kind']=='start';return rows
def collect(ws):
    root=ws/'evidence/benchmark-iframe';out={'schemaVersion':1,'state':'incomplete','exhaustive':False,'businessAuthority':False,'perturbation':'opt-in scalar writes and native wrapper; no retries or deadlines changed','cases':[]}
    stage='source-binding'
    try:
        b=json.loads(read(root/'binding.json'));assert b==binding(ws);out['binding']=b
        stage='report-case'
        report=json.loads(read(ws/'apps/web-benchmark/.e2e/report.json',32*1024*1024))['run']
        hits=[r for r in report['results'] if r.get('id')=='d99d69d8e6ab5f0ee6f4c3be656009a010c438186a8f7984ec4e981ff7ca0124'];assert len(hits)==1
        blocked={a['index']+1 for a in hits[0]['attempts'] if a.get('error',{}).get('phase')=='launch' and a.get('error',{}).get('message')=='An attempt is active or its provider recording cleanup is unresolved' and not a.get('steps')}
        expected={a['index']+1 for a in hits[0]['attempts']}-blocked;out['launchBlockedAttempts']=sorted(blocked);seen=set();schema=json.loads(read(HERE/'native-closed-trace-schema.json'))
        case_files=sorted(root.glob('client-*-attempt-*.jsonl'));out['caseFileCount']=len(case_files)
        for p in case_files:
            stage='case-ts-records'
            m=re.fullmatch(r'client-([1-9][0-9]*)-attempt-([12])\.jsonl',p.name);assert m
            pid,attempt=map(int,m.groups());assert attempt in expected and attempt not in seen;seen.add(attempt)
            rows=ts_rows(read(p,65536),pid,attempt)
            stage='process-custody'
            inv=ws/'evidence/fixture-invocations';invraw=read(inv/f'invocation-{pid}.json',4096);iv=json.loads(invraw);mapping=json.loads(read(inv/f'daemon-{pid}.json',1024))
            assert set(iv)=={'schemaVersion','pid','nonce','traceDirectory','nativeExecutable','nativeSHA256','wrapperSHA256','run','attempt','sourceCommit','sourceTree'} and iv['schemaVersion']==2 and type(iv['pid'])is int and re.fullmatch('[a-f0-9]{64}',iv['nonce']) and iv['nativeExecutable']==os.environ['E2E_DIAGNOSTIC_NATIVE_EXECUTABLE']
            assert set(mapping)=={'schemaVersion','kind','proxyPID','daemonPID','nonce','invocationSHA256'} and mapping['schemaVersion']==1 and type(mapping['daemonPID'])is int and 0<mapping['daemonPID']<=2**32-1 and mapping['daemonPID']!=pid
            assert iv['pid']==pid and iv['nativeSHA256']==b['nativeSHA256'] and iv['sourceCommit']==b['sourceCommit'] and iv['sourceTree']==b['sourceTree'] and iv['run']==b['run'] and iv['attempt']==b['runAttempt']
            assert iv['wrapperSHA256']==b['sources']['scripts/ci/native-trace-wrapper.sh'] and iv['traceDirectory']==str(root/'raw')
            assert mapping['proxyPID']==pid and mapping['invocationSHA256']==sha(invraw) and mapping['nonce']==iv['nonce'] and mapping['kind']=='spawn-owned-daemon';daemon=mapping['daemonPID']
            seqs={r['operationSeq'] for r in rows if r['kind']=='result'}
            terminal=any(r['kind']=='result' and r['command']=='browser.trace' and r['scopeState']=='quarantined' for r in rows) and any(r['kind']=='terminal-error' for r in rows)
            selected=[]
            for kind in ['native','query']:
                stage=kind+'-closed-records'
                allrows,issues=hung.inspect(read(root/'raw'/f'{kind}-{pid}.jsonl'),schema)
                # query sinks have no independent shutdown join: retain all other integrity checks.
                if kind=='query':issues.discard('missing-shutdown-checkpoint')
                allowed={'empty','record-limit','invalid-record','missing-capture-start','process-or-record-gap','capture-loss','missing-shutdown-checkpoint'}
                if issues:out['closedIssues']=sorted(issues & allowed)
                assert not issues and all(r['pid']==daemon for r in allrows)
                selected.extend(r for r in allrows if r.get('operationSeq') in seqs or (kind=='native' and terminal and r['phase']=='TerminalCleanupCheckpoint'))
            out['cases'].append({'attempt':attempt,'proxyPid':pid,'daemonPid':daemon,'ts':rows,'native':selected,'terminalLinked':terminal,'noAbsenceInference':True})
        stage='case-census';out['boundAttemptCount']=len(seen);out['expectedAttemptCount']=len(expected)
        assert seen==expected;out['state']='observed'
    except Exception:out['cases']=[];out['reason']='binding-or-capture-incomplete';out['failedStage']=stage
    target=ws/'evidence/benchmark-iframe-closed.json';target.write_text(json.dumps(out,indent=2)+'\n')
    return 0
if __name__=='__main__':
    ws=pathlib.Path(os.environ['GITHUB_WORKSPACE']).resolve()
    if sys.argv[1]=='prepare':prepare(ws)
    else:sys.exit(collect(ws))
