"""Derive EXPECTED from independent pre-exec wrapper receipts, never trace count."""
import hashlib,json,os,pathlib,re,subprocess,sys

def regular(p):
    assert p.is_file() and not p.is_symlink(), f'not regular: {p}'
    return p

def digest(p):return hashlib.sha256(regular(p).read_bytes()).hexdigest()

def unique(pairs):
    result={}
    for key,value in pairs:
        assert key not in result, 'duplicate custody key'
        result[key]=value
    return result

def closed_json(p,maximum):
    data=regular(p).read_bytes();assert len(data)<=maximum and data.endswith(b'\n')
    return json.loads(data,object_pairs_hook=unique)

def verify(root):
    root=pathlib.Path(root);assert root.is_dir() and not root.is_symlink()
    # A failed/duplicate pre-exec receipt may never reuse earlier same-run custody.
    log=regular(root/'test-e2e.log')
    with log.open('rb') as stream:
        while line:=stream.readline(1_048_577):
            assert len(line)<=1_048_576 and b'NATIVE_INVOCATION_CUSTODY_FAILED' not in line, 'pre-exec invocation custody failed'
    inv=root/'invocations';assert inv.is_dir() and not inv.is_symlink()
    files=list(inv.iterdir());assert 0<len(files)<=1024, 'missing/overflow invocation receipts'
    assert all(re.fullmatch(r'(invocation|daemon)-[1-9][0-9]*[.]json',p.name) for p in files), 'unexpected custody file'
    wrappers=[p for p in files if p.name.startswith('invocation-')]
    mappings=[p for p in files if p.name.startswith('daemon-')]
    assert 0<len(wrappers)<=512 and len(wrappers)==len(mappings), 'missing/extra spawned-daemon mapping'
    expected_source=pathlib.Path('evidence/source.commit').read_text().strip()
    expected_tree=pathlib.Path('evidence/source.tree').read_text().strip()
    pins=json.loads(pathlib.Path('scripts/ci/full-standard-runtime-pins.json').read_text());assert pins['configured'] is True
    binary_hash=pins['ordinary']['binarySha256'];wrapper_hash=digest(pathlib.Path('evidence/tools/popup-trace.sh'))
    groups={};pids=set();daemon_pids=set();nonces=set();mapping_by_proxy={}
    keys={'schemaVersion','pid','nonce','traceDirectory','nativeExecutable','nativeSHA256','wrapperSHA256','run','attempt','sourceCommit','sourceTree'}
    for p in wrappers:
        assert re.fullmatch(r'invocation-[1-9][0-9]*\.json',p.name)
        assert regular(p).stat().st_size<=4096
        row=closed_json(p,4096);assert set(row)==keys and type(row['schemaVersion']) is int and row['schemaVersion']==2
        pid=row['pid'];assert type(pid) is int and pid>0 and p.name==f'invocation-{pid}.json' and pid not in pids
        pids.add(pid)
        assert type(row['nonce']) is str and re.fullmatch('[0-9a-f]{64}',row['nonce']) and row['nonce'] not in nonces
        nonces.add(row['nonce'])
        mapping=closed_json(inv/f'daemon-{pid}.json',1024)
        assert set(mapping)=={'schemaVersion','kind','proxyPID','daemonPID','nonce','invocationSHA256'}
        assert type(mapping['schemaVersion']) is int and mapping['schemaVersion']==1 and mapping['kind']=='spawn-owned-daemon'
        assert type(mapping['proxyPID']) is int and mapping['proxyPID']==pid
        daemon=mapping['daemonPID'];assert type(daemon) is int and 0<daemon<=2**32-1 and daemon!=pid and daemon not in daemon_pids
        assert mapping['nonce']==row['nonce'] and mapping['invocationSHA256']==digest(p), 'stale or mismatched spawned-daemon mapping'
        daemon_pids.add(daemon);mapping_by_proxy[pid]=daemon
        assert row['run']==os.environ['GITHUB_RUN_ID'] and row['attempt']==os.environ['GITHUB_RUN_ATTEMPT']
        assert row['sourceCommit']==expected_source and row['sourceTree']==expected_tree
        assert row['nativeSHA256']==binary_hash and row['wrapperSHA256']==wrapper_hash
        assert pathlib.Path(row['nativeExecutable']).is_absolute()
        source=pathlib.Path(row['traceDirectory']);assert source.is_absolute() and source.name=='native-trace' and source.parent.name=='.e2e'
        assert re.fullmatch('p-[0-9a-f]{12}',source.parent.parent.name)
        groups.setdefault(str(source),set()).add(pid)
    used=set();plan=[]
    for name in ['popup-init-order','popup-init-order-borrowed','replaced-nodes']:
        d=root/name
        if name=='replaced-nodes':
            runs=[p for p in d.iterdir() if p.name!='query-capture-validation.json'];assert len(runs)==1 and runs[0].is_dir() and not runs[0].is_symlink() and runs[0].name.startswith('run-')
            trace=runs[0]/'native-trace'
        else:
            regular(d/'report.json');trace=d/'runner/native-trace'
        assert trace.is_dir() and not trace.is_symlink()
        ordinary=set();query=set()
        for p in trace.iterdir():
            regular(p);match=re.fullmatch(r'(native|query)-([1-9][0-9]*)\.jsonl',p.name);assert match
            (ordinary if match[1]=='native' else query).add(int(match[2]))
            # Filenames belong to the independent wrapper invocation; native
            # records belong to its authenticated fresh Child::id(), not $$.
            proxy=int(match[2]);assert proxy in mapping_by_proxy
            assert p.stat().st_size<=512*512
            lines=0
            with p.open('rb') as stream:
                for line in stream:
                    assert len(line)<=512 and line.endswith(b'\n')
                    row=json.loads(line,object_pairs_hook=unique)
                    assert type(row.get('pid')) is int and row['pid']==mapping_by_proxy[proxy], 'trace PID does not match spawned-daemon mapping'
                    if lines==0:assert row.get('phase')=='CaptureStarted' and type(row.get('record')) is int and row['record']==0
                    lines+=1
            assert lines>0, 'missing native capture start'
        observed=ordinary|query;assert observed, f'no captured process for {name}'
        # Locate ownership by any observed process, then require ALL independent
        # wrapper invocations in that ownership group, including missing traces.
        matching=[k for k,v in groups.items() if v&observed]
        assert len(matching)==1, f'ambiguous invocation group for {name}'
        key=matching[0];assert key not in used;used.add(key)
        expected=groups[key];assert ordinary==query==expected, f'missing/extra process trace for {name}'
        plan.append({'fixture':name,'expected':len(expected),'pids':sorted(expected),'daemonPIDs':sorted(mapping_by_proxy[p] for p in expected),'traceDirectory':key})
    assert used==set(groups),'unassigned invocation group'
    (root/'expected-processes.json').write_text(json.dumps(plan,indent=2)+'\n')
    return plan

def main():
    root=pathlib.Path(sys.argv[1]);summary={'schemaVersion':1,'diagnosticEvidenceOnly':True,'doesNotAdjudicateFieldRootFix':True,'fixtures':[]}
    summary['originalPackageTestExit']=None
    summary['originalPackageTestOutcome']='not-run-or-missing'
    status=1
    try:
        original=pathlib.Path('evidence/test-e2e.exit')
        summary['originalPackageTestExit']=original.read_text().strip() if original.is_file() and not original.is_symlink() else None
        summary['originalPackageTestOutcome']=('passed' if summary['originalPackageTestExit']=='0' else 'not-run-or-missing' if summary['originalPackageTestExit'] is None else 'failed')
        plan=verify(root);status=0
        for row in plan:
            name=row['fixture'];args=[sys.executable,'scripts/ci/check-critical-query-traces.py',str(row['expected'])]
            if name=='replaced-nodes':
                archive=root/name;args += [str(archive),'--field-only','--field-log',str(root/'test-e2e.log')]
            else:
                archive=root/name/'runner/native-trace';args += [str(archive)]
            # All original validators run even if one rejects; never hide failures.
            code=subprocess.run(args,check=False).returncode
            result=archive/'query-capture-validation.json'
            validation=json.loads(regular(result).read_text()) if result.exists() else {}
            assert isinstance(validation,dict), 'invalid validator report'
            errors=validation.get('errors',['validator report missing'])
            assert isinstance(errors,list) and all(type(x) is str for x in errors), 'invalid validator errors'
            field_summary=validation.get('fieldOnly',{})
            assert isinstance(field_summary,dict), 'invalid field-only validator summary'
            target_count=field_summary.get('targetedFailures',0)
            assert type(target_count) is int and target_count>=0, 'invalid field-only target count'
            complete=code==0 and validation.get('completeEvidence') is True and not errors
            missing_target=any(x=='field capture: missing targeted settled field failure' for x in errors)
            summary['fixtures'].append({'fixture':name,'expectedProcesses':row['expected'],'validatorExit':code,
                'completeEvidence':complete,'diagnosticOutcome':('complete' if complete else 'not-observed/incomplete' if missing_target else 'rejected/incomplete'),
                'targetedFailureWitnessObserved':(True if target_count>0 else False if missing_target else None) if name=='replaced-nodes' else None,'errors':errors})
            status=int(bool(status or not complete))
    except Exception as exc:
        # Malformed evidence and unexpected coordinator failures are also RED.
        summary['custodyFailure']=type(exc).__name__+': '+str(exc);status=1
    finally:
        summary['diagnosticGateExit']=status
        summary['behaviorAndDiagnosticGatesAreSeparate']=True
        pathlib.Path('evidence/original-capture-status.json').write_text(json.dumps(summary,indent=2)+'\n')
    raise SystemExit(status)

if __name__=='__main__':main()
