#!/usr/bin/env python3
"""Nine exact framed response/watermark fixtures: every case must really pass.
No production build, browser run, acceptance retirement or release proof.
"""
import hashlib, json, os, re, signal, subprocess, sys, tempfile, time
from pathlib import Path
HERE=Path(__file__).resolve().parent
PINS=json.loads((HERE/'pins.json').read_text())
EVIDENCE=Path(os.environ.get('EVIDENCE_DIR','.'))
ACTIVE_GROUPS=set()
COMPILE_PHASES=['recipe-identity','source-before','source-patch','toolchain','format','clippy','acceptance-tests-check','proxy-feature-check','default-harness-compile','default-harness-inventory']

def terminate_owned(signum, _frame):
    for group in tuple(ACTIVE_GROUPS):
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass
    raise SystemExit(128 + signum)

def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def execute(name, seconds, command):
    """Keep the real exit and timeout; reap only this command's owned process group."""
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    result = {'command': command, 'exit': None, 'timed_out': False}
    save(EVIDENCE / f'{name}.command.json', command)
    started = time.monotonic()
    with (EVIDENCE / f'{name}.stdout.log').open('w') as out, (EVIDENCE / f'{name}.stderr.log').open('w') as err:
        try:
            with subprocess.Popen(command, stdout=out, stderr=err, start_new_session=True) as process:
                ACTIVE_GROUPS.add(process.pid)
                try:
                    process.wait(timeout=seconds)
                except subprocess.TimeoutExpired:
                    result['timed_out'] = True
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
                finally:
                    ACTIVE_GROUPS.discard(process.pid)
                result['exit'] = process.returncode
        except OSError as error:
            result['error'] = str(error)
        except (SystemExit, KeyboardInterrupt) as error:
            result['interrupted'] = True
            result['exit'] = error.code if isinstance(error, SystemExit) else 130
    result['elapsed_seconds'] = round(time.monotonic() - started, 3)
    status = 124 if result['timed_out'] else result['exit']
    if status is None:
        status = 127
    (EVIDENCE / f'{name}.exit').write_text(f'{status}\n')
    save(EVIDENCE / f'{name}.result.json', result)
    for kind in ('stdout', 'stderr'):
        print((EVIDENCE / f'{name}.{kind}.log').read_text(errors='replace'), end='', flush=True)
    print(f"{name}: exit={status}; timed_out={result['timed_out']}", flush=True)
    if result.get('interrupted'):
        raise SystemExit(status)
    return status

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()

def source_identity(root, applied):
    validate_pins()
    root = Path(root).resolve()
    assert git(root, 'rev-parse', 'HEAD') == PINS['publishedNativeSha']
    parents = [line[7:] for line in git(root, 'cat-file', '-p', 'HEAD').splitlines() if line.startswith('parent ')]
    assert parents == [PINS['baseNativeSha']], 'Source commit must have exactly the reviewed a2c48b8 RED base parent'
    assert git(root, 'rev-parse', 'HEAD^1^{tree}') == PINS['baseNativeTree']
    assert git(root, 'rev-parse', 'HEAD^{tree}') == PINS['candidateTree']
    assert digest(root / 'cli/Cargo.lock') == PINS['nativeLockSha256']
    assert not git(root, 'status', '--porcelain', '--untracked-files=all'), 'Source checkout must remain pristine'
    ignored = subprocess.check_output(['git','-C',str(root),'ls-files','--others','--ignored','--exclude-standard'],text=True).splitlines()
    placeholder='packages/dashboard/out/index.html'
    assert ignored in ([],[placeholder]), 'Unexpected ignored source/build input'
    if ignored:
        assert (root/placeholder).read_bytes()==b'<!DOCTYPE html><html><body><p>Dashboard not built. Run: cd packages/dashboard &amp;&amp; pnpm build</p></body></html>\n'
    assert git(root, 'write-tree') == PINS['candidateTree']
    assert git(root, 'diff', '--name-only', 'HEAD^1', 'HEAD').splitlines() == [row['path'] for row in PINS['changedFiles']]
    for row in PINS['changedFiles']:
        assert digest(root / row['path']) == row['afterSha256']
        exists = subprocess.run(['git', '-C', str(root), 'cat-file', '-e', 'HEAD^1:' + row['path']], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        assert exists == (row['beforeSha256'] is not None), 'Base file presence mismatch'
        if exists:
            data = subprocess.check_output(['git', '-C', str(root), 'show', 'HEAD^1:' + row['path']])
            assert hashlib.sha256(data).hexdigest() == row['beforeSha256']
    return {'publishedHead': PINS['publishedNativeSha'], 'baseHead': PINS['baseNativeSha'], 'baseTree': PINS['baseNativeTree'], 'effectiveTree': PINS['candidateTree'], 'onlyTestOverlay': False, 'productionSourceChanged': True, 'lockSha256': PINS['nativeLockSha256']}

def apply_overlay(root):
    # Source changes are already committed. Reverse the complete patch in a
    # private index to the exact a2c48b8 RED base, never to an older formal baseline.
    source_identity(root, False)
    patch = HERE / 'source-change.patch'
    assert digest(patch) == PINS['patchSha256']
    with tempfile.TemporaryDirectory(prefix='native-terminal-source-patch-') as temporary:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(temporary) / 'index'))
        command = ['git', '-C', str(root)]
        subprocess.run(command + ['read-tree', PINS['baseNativeTree']], env=env, check=True)
        subprocess.run(command + ['apply', '--cached', '--check', '--whitespace=error', str(patch)], env=env, check=True)
        subprocess.run(command + ['apply', '--cached', '--whitespace=error', str(patch)], env=env, check=True)
        assert subprocess.check_output(command + ['write-tree'], env=env, text=True).strip() == PINS['candidateTree']
        subprocess.run(command + ['apply', '--cached', '--reverse', '--check', '--whitespace=error', str(patch)], env=env, check=True)
        subprocess.run(command + ['apply', '--cached', '--reverse', '--whitespace=error', str(patch)], env=env, check=True)
        assert subprocess.check_output(command + ['write-tree'], env=env, text=True).strip() == PINS['baseNativeTree']
    value = source_identity(root, True)
    value.update(patchSha256=PINS['patchSha256'], patchInputs=PINS['patchInputs'], productionSourceChanged=True, forwardPatchMatchesCandidateTree=True, reversePatchRestoresExactBaseTree=True)
    save(EVIDENCE / 'source-patch-identity.json', value)

def capture_harness(root, configuration):
    validate_cases()
    config = PINS['configurations'][configuration]
    phase = configuration + '-harness-compile'
    selected = [case for case in PINS['cases'] if case['configuration'] == configuration]
    root = Path(root).resolve()
    source_identity(root, True)
    assert (EVIDENCE / (phase + '.exit')).read_text().strip() == '0'
    rows = [json.loads(line) for line in (EVIDENCE / (phase + '.stdout.log')).read_text().splitlines() if line.strip()]
    finished = [row for row in rows if row.get('reason') == 'build-finished']
    assert len(finished) == 1 and finished[0].get('success') is True
    artifacts = [row for row in rows if row.get('reason') == 'compiler-artifact' and row.get('executable')]
    assert len(artifacts) == 1, 'Only the selected unit-test harness is allowed'
    row = artifacts[0]
    assert row['target']['name'] == 'agent-browser' and row['target']['kind'] == ['bin']
    assert row['target']['src_path'] == str(root / 'cli/src/main.rs') and row['manifest_path'] == str(root / 'cli/Cargo.toml')
    assert row['features'] == config['features'] and row['profile']['test'] is True
    assert row['profile']['opt_level'] == '0' and row['profile']['debug_assertions'] is True
    binary = Path(row['executable']).resolve(strict=True)
    assert binary.parent == Path(os.environ['CARGO_TARGET_DIR']).resolve() / config['targetDirectory']
    assert binary.is_file() and os.access(binary, os.X_OK)
    with binary.open('rb') as stream:
        header = stream.read(20)
    assert header[:6] == bytes.fromhex('7f454c460201') and int.from_bytes(header[18:20], 'little') == 62
    before = digest(binary)
    status = execute('list-' + configuration + '-harness', 60, [str(binary), '--list', '--format', 'pretty', '--color', 'never'])
    output = (EVIDENCE / ('list-' + configuration + '-harness.stdout.log')).read_text()
    inventory = re.findall(r'(?m)^(.+): test$', output)
    assert status == 0 and len(inventory) == len(set(inventory))
    for case in selected:
        assert inventory.count(case['name']) == 1, f"Exact test missing: {case['name']}"
    if configuration == 'default':
        assert not any(case['name'] in inventory for case in PINS['cases'] if case['configuration'] == 'faults'), 'Feature-gated tests appeared in default harness'
    assert before == digest(binary)
    save(EVIDENCE / (configuration + '-harness-binding.json'), {'binary': str(binary), 'sha256': before, 'cargoArtifact': row, 'source': source_identity(root, True), 'inventory': inventory, 'selectedExactTests': selected, 'configuration': configuration, 'features': config['features'], 'cargoProfile': 'dev', 'productionImageBuilt': False})

def verify_binding(binding, configuration):
    validate_cases()
    expected = {'publishedHead': PINS['publishedNativeSha'], 'baseHead': PINS['baseNativeSha'], 'baseTree': PINS['baseNativeTree'], 'effectiveTree': PINS['candidateTree'], 'onlyTestOverlay': False, 'productionSourceChanged': True, 'lockSha256': PINS['nativeLockSha256']}
    assert binding['source'] == expected, 'Harness source binding mismatch'
    assert binding['selectedExactTests'] == [row for row in PINS['cases'] if row['configuration'] == configuration]
    assert binding['configuration'] == configuration and binding['features'] == PINS['configurations'][configuration]['features'] and binding['cargoProfile'] == 'dev'

def verify_saved_case(case):
    saved = json.loads((EVIDENCE / (case['id'] + '.ledger.json')).read_text())
    binding = json.loads((EVIDENCE / (case['configuration'] + '-harness-binding.json')).read_text())
    verify_binding(binding, case['configuration'])
    result = json.loads((EVIDENCE / (case['id'] + '.result.json')).read_text())
    command = [binding['binary'], '--exact', case['name'], '--test-threads=1', '--format', 'pretty', '--color', 'never']
    assert result['command'] == command and saved['command'] == command
    assert saved['harnessSha256Before'] == saved['harnessSha256After'] == binding['sha256']
    actual = inspect_case(case, (EVIDENCE / (case['id'] + '.stdout.log')).read_text(), (EVIDENCE / (case['id'] + '.stderr.log')).read_text(), result, binding['sha256'], saved['harnessSha256After'])
    assert all(saved[key] == value for key, value in actual.items()), 'Ledger does not match raw evidence'
    return actual

def validate_cases():
    encoded=json.dumps(PINS['cases'],sort_keys=True,separators=(',',':')).encode()
    assert PINS.get('casesFrozen') is True and hashlib.sha256(encoded).hexdigest()==PINS['casesSha256']
    assert [(c['id'],c['expected'],c['configuration']) for c in PINS['cases']]==[(f'response-{i+1}','passed','default') for i in range(9)]
    assert [c['name'] for c in PINS['cases']]==['native::client_browser::state_lifecycle_tests::restart_transport_tests::response_entry_tests::response_entry_applied_network_positive_reads_full_text_and_json', 'native::client_browser::state_lifecycle_tests::restart_transport_tests::response_entry_tests::response_entry_unapplied_network_waits_then_reads_full_text_and_json', 'native::client_browser::state_lifecycle_tests::restart_transport_tests::response_entry_tests::response_entry_pending_network_preserves_original_deadline_without_dispatch', 'native::client_browser::state_lifecycle_tests::restart_transport_tests::response_entry_tests::response_entry_pending_network_preserves_user_cancel_without_dispatch', 'native::client_browser::state_lifecycle_tests::restart_transport_tests::response_entry_tests::response_entry_does_not_chase_later_received_network_events', 'native::client_browser::state_lifecycle_tests::restart_transport_tests::response_entry_tests::response_entry_rejects_loader_change_during_ingress_wait', 'native::client_browser::state_lifecycle_tests::restart_transport_tests::response_entry_tests::response_entry_rejects_realm_change_during_ingress_wait', 'native::client_browser::state_lifecycle_tests::restart_transport_tests::response_entry_tests::response_entry_rejects_exact_session_detach_during_ingress_wait', 'native::client_debt::tests::eval_ingress_observation_preserves_existing_live_window']
    assert PINS['configurations']=={'default':{'features':[],'profile':'dev','targetDirectory':'debug/deps'}}

def validate_pins():
    assert PINS.get('enabled') is True and PINS.get('sourceBindingFrozen') is True, 'UNRESOLVED source binding'
    validate_cases()
    assert PINS['baseNativeSha']=='a2c48b8529d44434214c56aef31540bc3fedfeaa'
    assert PINS['baseNativeTree']=='e69a73e73b5587a49906910332ba4a2c9eed5da9'
    assert PINS['publishedNativeSha']=='1f41d03e4ea200fe33e1733b256d2b5a6f4bc886'
    assert PINS['candidateTree']=='8041af95f5fc686cefbe10a31456b6c33d19e626'
    assert PINS['onlyTestOverlay'] is False and PINS['productionSourceChanged'] is True and PINS['productionImageBuilt'] is False
    assert [f['path'] for f in PINS['changedFiles']]==['cli/src/native/client_browser.rs', 'cli/src/native/client_browser_response_entry_tests.rs', 'cli/src/native/client_debt.rs', 'cli/src/native/client_enrollment.rs', 'cli/src/native/client_eval_network_watermark_tests.rs']
    assert digest(HERE/'source-change.patch')==PINS['patchSha256']=='1575ccdd6154f7cf2c119b8a2da511e79744a69f8664d3092438cf8393168156'

def inspect_case(case, stdout, stderr, result, harness_sha, post_sha):
    """Exact libtest stdout is evidence, not just a process exit or expected label."""
    outcomes = re.findall(r'(?m)^test (\S+) \.\.\. (ok|ignored(?:, [^\n]*)?|FAILED)$', stdout)
    summaries = re.findall(r'(?m)^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in [0-9.]+s$', stdout)
    actual = 'unknown'
    if len(summaries) == 1 and len(outcomes) == 1 and outcomes[0][0] == case['name'] and re.findall(r'(?m)^running (\d+) tests?$', stdout) == ['1']:
        word, passed, failed, ignored, measured, _filtered = summaries[0]
        if ignored == measured == '0' and not result.get('timed_out') and not result.get('interrupted') and harness_sha == post_sha:
            if word == 'ok' and (passed, failed) == ('1', '0') and outcomes[0][1] == 'ok' and result.get('exit') == 0:
                actual = 'passed'
            elif word == 'FAILED' and (passed, failed) == ('0', '1') and outcomes[0][1] == 'FAILED' and result.get('exit') == 101:
                actual = 'failed'
    expected_observed = case['expected'] == 'passed' and actual == 'passed'
    return {'id': case['id'], 'test': case['name'], 'category': case['category'], 'expected': case['expected'], 'actual': actual,
            'configuration': case['configuration'], 'features': PINS['configurations'][case['configuration']]['features'], 'expectedObservationConfirmed': expected_observed, 'testPassed': actual == 'passed',
            'classification': 'expected-pass-observed' if expected_observed else 'unexpected-failure' if actual == 'failed' else 'unknown', 'process': result,
            'harnessSha256Before': harness_sha, 'harnessSha256After': post_sha, 'sourceTree': PINS['candidateTree'],
            'originalE2eRetired': False, 'fullNativeSuitePassed': False, 'productionAcceptance': False}

def run_case(case_id):
    validate_pins()
    case=next(row for row in PINS['cases'] if row['id']==case_id)
    for prerequisite in PINS['cases'][:PINS['cases'].index(case)]:
        positive=verify_saved_case(prerequisite)
        assert prerequisite['expected']=='passed' and positive['actual']=='passed' and positive['expectedObservationConfirmed'], 'Every earlier exact positive control must actually pass first'
    binding=json.loads((EVIDENCE/(case['configuration']+'-harness-binding.json')).read_text())
    verify_binding(binding,case['configuration'])
    binary=Path(binding['binary']); assert digest(binary)==binding['sha256']
    command=[str(binary),'--exact',case['name'],'--test-threads=1','--format','pretty','--color','never']
    status=execute(case_id,120,command)
    result=json.loads((EVIDENCE/f'{case_id}.result.json').read_text())
    receipt=inspect_case(case,(EVIDENCE/f'{case_id}.stdout.log').read_text(),(EVIDENCE/f'{case_id}.stderr.log').read_text(),result,binding['sha256'],digest(binary))
    receipt['command']=command
    save(EVIDENCE/f'{case_id}.ledger.json',receipt)
    # A raw 101 stays failed. Only exact 1 pass / 0 ignored / exit 0 succeeds.
    return status if status else (0 if receipt['testPassed'] else 1)

def summarize():
    validate_pins()
    phases=COMPILE_PHASES+['source-after-pure']
    states={p:(EVIDENCE/(p+'.exit')).read_text().strip() if (EVIDENCE/(p+'.exit')).exists() else 'missing' for p in phases}
    cases=[]
    for case in PINS['cases']:
        try: cases.append(verify_saved_case(case))
        except (OSError,ValueError,KeyError,AssertionError): cases.append({'id':case['id'],'actual':'unknown','testPassed':False,'expectedObservationConfirmed':False})
    observed=all(v=='0' for v in states.values()) and all(c['testPassed'] and c['expectedObservationConfirmed'] for c in cases) and [c['actual'] for c in cases]==['passed']*9
    value={'verifiedSuccess':observed,'allTestsPassed':all(c['actual']=='passed' for c in cases),'nativeSha':PINS['publishedNativeSha'],'nativeTree':PINS['candidateTree'],
           'runId':int(os.environ['GITHUB_RUN_ID']),'runAttempt':int(os.environ['GITHUB_RUN_ATTEMPT']),'recipeSha':os.environ['GITHUB_WORKFLOW_SHA'],
           'passedTestCount':sum(c['actual']=='passed' for c in cases),'failedTestCount':sum(c['actual']=='failed' for c in cases),'unknownTestCount':sum(c['actual']=='unknown' for c in cases),
           'selectedCaseCount':9,'productionSourceChanged':True,'onlyTestOverlay':False,'phases':states,'cases':cases,'productionImageBuilt':False,'fullNativeSuitePassed':False,'originalE2eRetired':False,
           'scope':'Nine exact dev controls for the fixed entry watermark; no browser cause, full native suite, or production-image acceptance'}
    save(EVIDENCE/'response-entry-verified.json',value)
    return 0 if observed else 1

def main():
    mode,*args=sys.argv[1:]
    if mode=='run': return execute(args[0],int(args[1]),args[2:])
    if mode=='guard':
        validate_pins()
        values={'NATIVE_SHA':PINS['publishedNativeSha'],'NATIVE_TREE':PINS['candidateTree'],'NATIVE_LOCK_SHA256':PINS['nativeLockSha256']}
        with open(os.environ['GITHUB_ENV'],'a') as stream:
            for k,v in values.items(): stream.write(f'{k}={v}\n')
    elif mode=='recipe':
        validate_pins(); root=Path(args[0]); assert git(root,'rev-parse','HEAD')==args[1] and not git(root,'status','--porcelain')
        save(EVIDENCE/'recipe-binding.json',{'commit':args[1],'tree':git(root,'rev-parse','HEAD^{tree}'),'helperSha256':digest(Path(__file__)),'pinsSha256':digest(HERE/'pins.json'),'patchSha256':digest(HERE/'source-change.patch')})
    elif mode=='source':
        if len(args)>1 and args[1]=='pristine': assert not git(args[0],'ls-files','--others','--ignored','--exclude-standard'), 'Initial source contains ignored input'
        print(json.dumps(source_identity(args[0],True)))
    elif mode=='apply': apply_overlay(args[0])
    elif mode=='harness': capture_harness(args[0],'default')
    elif mode=='case': return run_case(args[0])
    elif mode=='summary': return summarize()
    elif mode=='aggregate':
        states={p:(EVIDENCE/(p+'.exit')).read_text().strip() for p in args}
        verified=json.loads((EVIDENCE/'response-entry-verified.json').read_text())
        accepted=all(v=='0' for v in states.values()) and verified['verifiedSuccess'] and verified['allTestsPassed'] and verified['passedTestCount']==9 and verified['failedTestCount']==verified['unknownTestCount']==0
        save(EVIDENCE/'aggregate.json',{'verifiedSuccess':accepted,'phases':states,'allTestsPassed':verified['allTestsPassed'],'productionImageBuilt':False,'releaseEligible':False})
        assert accepted
    else: raise AssertionError('Only closed dev-validation recipe modes are supported')
    return 0
if __name__=='__main__':
    signal.signal(signal.SIGTERM,terminate_owned); signal.signal(signal.SIGINT,terminate_owned)
    sys.exit(main())
