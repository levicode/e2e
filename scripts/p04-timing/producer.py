#!/usr/bin/env python3
"""Temporary P04 timing: strict gates + exact dev controls before same-run ci image. Never release proof."""
import hashlib, json, os, re, shutil, signal, subprocess, sys, tempfile, time
from pathlib import Path
HERE=Path(__file__).resolve().parent
PINS=json.loads((HERE/'producer-pins.json').read_text())
EVIDENCE=Path(os.environ.get('EVIDENCE_DIR','.'))
ACTIVE_GROUPS=set()
COMPILE_PHASES=['recipe-identity','source-before','source-patch','toolchain','format','clippy','acceptance-tests-check','proxy-feature-check','default-harness-compile','default-harness-inventory','faults-harness-compile','faults-harness-inventory','collector-controls']

def validate_cases():
    assert PINS.get('casesFrozen') is True, 'UNRESOLVED exact dev case names'
    encoded=json.dumps(PINS['cases'],sort_keys=True,separators=(',',':')).encode()
    assert hashlib.sha256(encoded).hexdigest()==PINS['casesSha256']
    assert len(PINS['cases'])==len({c['id'] for c in PINS['cases']})==len({c['name'] for c in PINS['cases']})==5
    assert all(c['expected']=='passed' and c['configuration'] in PINS['configurations'] for c in PINS['cases'])

def validate_pins():
    assert PINS.get('enabled') is True and PINS.get('sourceBindingFrozen') is True, 'UNRESOLVED disabled temporary probe source'
    validate_cases()
    assert PINS['baseNativeSha']=='0ea3dce92bec2e1d059f30b6839f444a42f6a4eb'
    assert PINS['baseNativeTree']=='f14d6ac9cc880094720fc4ea9707dd1a57bf2b95'
    for k in ['publishedNativeSha','candidateTree','e2eSha','e2eTree']: assert re.fullmatch('[a-f0-9]{40}',PINS[k])
    assert PINS['e2eSha']=='5adcc69574da30c539b585d92a793bca87fae2bc'
    assert len(PINS['changedFiles'])==6 and len({f['path'] for f in PINS['changedFiles']})==6
    assert re.fullmatch('[a-f0-9]{64}',PINS['patchSha256'])

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
    assert parents == [PINS['baseNativeSha']], 'Source commit must have exactly the reviewed 0ea3dce base parent'
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
    # private index to the exact 0ea3dce base, never to an older formal baseline.
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

def nested_timing_stdout(case, stdout):
    """Only this exact test runs the two serial opt-out/opt-in child harnesses."""
    name = 'native::client_browser::state_lifecycle_tests::restart_transport_tests::trace_retirement_tests::trace_timing_success_ack_and_real_restoration_emit_original_sink'
    if (case['id'], case['name'], case['configuration'], case['expected']) != ('timing-5', name, 'faults', 'passed'):
        return False
    lines = [line.rstrip() for line in stdout.splitlines() if line.strip()]
    fixed = {0: 'running 1 test', 1: f'test {name} ...', 2: 'running 1 test',
             3: f'test {name} ... ok', 5: 'running 1 test', 6: f'test {name} ... ok', 8: 'ok'}
    if len(lines) != 10 or any(lines[index] != text for index, text in fixed.items()):
        return False
    summaries = [re.fullmatch(r'test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; (\d+) filtered out; finished in \d+(?:\.\d+)?s', lines[index]) for index in (4, 7, 9)]
    return all(summaries) and len({match.group(1) for match in summaries}) == 1

def inspect_case(case, stdout, stderr, result, harness_sha, post_sha):
    """Exact libtest stdout is evidence, not just a process exit or expected label."""
    outcomes = re.findall(r'(?m)^test (\S+) \.\.\. (ok|ignored(?:, [^\n]*)?|FAILED)$', stdout)
    summaries = re.findall(r'(?m)^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in [0-9.]+s$', stdout)
    actual = 'unknown'
    if case['id'] == 'timing-5':
        if nested_timing_stdout(case, stdout) and result.get('exit') == 0 and not result.get('timed_out') and not result.get('interrupted') and harness_sha == post_sha:
            actual = 'passed'
    elif len(summaries) == 1 and len(outcomes) == 1 and outcomes[0][0] == case['name'] and re.findall(r'(?m)^running (\d+) tests?$', stdout) == ['1']:
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

def run_case(case_id):
    validate_pins()
    case = next(row for row in PINS['cases'] if row['id'] == case_id)
    binding = json.loads((EVIDENCE / (case['configuration'] + '-harness-binding.json')).read_text())
    verify_binding(binding, case['configuration'])
    binary = Path(binding['binary']); assert digest(binary) == binding['sha256']
    command = [str(binary), '--exact', case['name'], '--test-threads=1', '--format', 'pretty', '--color', 'never']
    status = execute(case_id, 120, command)
    result = json.loads((EVIDENCE / f'{case_id}.result.json').read_text())
    receipt = inspect_case(case, (EVIDENCE / f'{case_id}.stdout.log').read_text(), (EVIDENCE / f'{case_id}.stderr.log').read_text(), result, binding['sha256'], digest(binary))
    receipt['command'] = command
    save(EVIDENCE / f'{case_id}.ledger.json', receipt)
    # Only a genuine exact pass may produce a successful test step; exit 101 stays failed.
    return status if status else (0 if receipt['testPassed'] else 1)

def cargo_artifacts(name):
    assert (EVIDENCE / f"{name}.exit").read_text().strip() == "0", "Cargo gate did not pass"
    rows = [json.loads(line) for line in (EVIDENCE / f"{name}.stdout.log").read_text().splitlines() if line.strip()]
    finished = [row for row in rows if row.get("reason") == "build-finished"]
    assert len(finished) == 1 and finished[0].get("success") is True
    return [row for row in rows if row.get("reason") == "compiler-artifact" and row.get("executable")]

def production(destination, label):
    assert label == "production", "Only the genuine feature-free production image is permitted"
    features = [] if label == "production" else ["acceptance-faults"]
    root = Path.cwd().resolve()
    rows = [row for row in cargo_artifacts(f"{label}-build") if row.get("target", {}).get("name") == "agent-browser"]
    assert len(rows) == 1
    row = rows[0]
    binary = Path(row["executable"]).resolve(strict=True)
    assert row["manifest_path"] == str(root / "Cargo.toml")
    assert row["target"]["src_path"] == str(root / "src/main.rs")
    assert row["target"]["kind"] == ["bin"] and row["features"] == features and not row["profile"]["test"]
    assert row["profile"]["opt_level"] == "3" and row["profile"]["debug_assertions"] is False
    assert binary == Path(os.environ["CARGO_TARGET_DIR"]).resolve() / "ci/agent-browser"
    with binary.open("rb") as stream:
        header = stream.read(20)
    assert header[:6] == bytes.fromhex("7f454c460201") and int.from_bytes(header[18:20], "little") == 62
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    image = destination / "agent-browser"
    shutil.copyfile(binary, image)
    image.chmod(0o755)
    result = {key: os.environ[key] for key in ("NATIVE_SHA", "NATIVE_TREE", "NATIVE_LOCK_SHA256", "E2E_SHA", "E2E_TREE", "E2E_LOCK_SHA256", "RUSTUP_TOOLCHAIN", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKFLOW_SHA")}
    result.update(profile="ci", features=features, artifact_label=label, binary_sha256=digest(image), binary_bytes=image.stat().st_size,
                  cargo_artifact=row, helper_sha256=digest(Path(__file__)),
                  scope="unpromoted native validation artifact; browser/source-retirement/full acceptance NOT established",
                  distribution_eligible=False, dashboard_frontend_built=False)
    receipt_file=EVIDENCE/'native-focused-verified.json'
    receipt=json.loads(receipt_file.read_text())
    assert receipt['verifiedSuccess'] is True and receipt['nativeSha']==os.environ['NATIVE_SHA'] and receipt['nativeTree']==os.environ['NATIVE_TREE']
    assert receipt['runId']==int(os.environ['GITHUB_RUN_ID']) and receipt['runAttempt']==int(os.environ['GITHUB_RUN_ATTEMPT'])
    result['native_validation']={'mode':'same-run-temporary-p04-timing-dev-exact','run_id':receipt['runId'],'current_native_execution':True,'receipt_file':'native-focused-verified.json','receipt_sha256':digest(receipt_file)}
    result.update(scope='TEMPORARY removable diagnostic ci image: four strict gates and exact default/faults dev cases only',full_native_suite_passed=False,optimized_native_tests_executed=False,installed_distribution_verified=False,focused_runtime_cases=['P04'],requires_removal=True,release_eligible=False)
    shutil.copyfile(receipt_file,destination/'native-focused-verified.json')
    save(destination/'provenance.json',result)
    save(EVIDENCE/'production-provenance.json',result)

def summarize():
    validate_pins()
    phases=COMPILE_PHASES+['source-after-pure']
    states={p:(EVIDENCE/(p+'.exit')).read_text().strip() if (EVIDENCE/(p+'.exit')).exists() else 'missing' for p in phases}
    cases=[]
    for case in PINS['cases']:
        try: cases.append(verify_saved_case(case))
        except (OSError,ValueError,KeyError,AssertionError): cases.append({'id':case['id'],'actual':'unknown','testPassed':False})
    passed=all(v=='0' for v in states.values()) and all(c['testPassed'] for c in cases)
    value={'verifiedSuccess':passed,'nativeSha':PINS['publishedNativeSha'],'nativeTree':PINS['candidateTree'],'runId':int(os.environ['GITHUB_RUN_ID']),'runAttempt':int(os.environ['GITHUB_RUN_ATTEMPT']),'recipeSha':os.environ['GITHUB_WORKFLOW_SHA'],'passedTestCount':sum(c['actual']=='passed' for c in cases),'selectedCaseCount':len(PINS['cases']),'phases':states,'cases':cases,'fullNativeSuitePassed':False,'optimizedNativeTestsExecuted':False,'scope':'temporary diagnostic delta exact dev controls only; not prior native8/full-suite proof'}
    save(EVIDENCE/'native-focused-verified.json',value)
    return 0 if passed else 1

def main():
    mode,*args=sys.argv[1:]
    if mode=='run': return execute(args[0],int(args[1]),args[2:])
    if mode=='guard':
        validate_pins()
        values={'NATIVE_SHA':PINS['publishedNativeSha'],'NATIVE_TREE':PINS['candidateTree'],'NATIVE_LOCK_SHA256':PINS['nativeLockSha256'],'E2E_SHA':PINS['e2eSha'],'E2E_TREE':PINS['e2eTree'],'E2E_LOCK_SHA256':PINS['e2eLockSha256']}
        with open(os.environ['GITHUB_ENV'],'a') as stream:
            for k,v in values.items(): stream.write(f'{k}={v}\n')
    elif mode=='recipe':
        validate_pins(); root=Path(args[0]); assert git(root,'rev-parse','HEAD')==args[1] and not git(root,'status','--porcelain')
        save(EVIDENCE/'recipe-binding.json',{'commit':args[1],'tree':git(root,'rev-parse','HEAD^{tree}'),'helperSha256':digest(Path(__file__)),'pinsSha256':digest(HERE/'producer-pins.json'),'patchSha256':digest(HERE/'source-change.patch')})
    elif mode=='source':
        if len(args)>1 and args[1]=='pristine':
            assert not git(args[0],'ls-files','--others','--ignored','--exclude-standard'), 'Initial source contains ignored input'
        print(json.dumps(source_identity(args[0],True)))
    elif mode=='apply': apply_overlay(args[0])
    elif mode=='harness': capture_harness(args[0],args[1])
    elif mode=='case': return run_case(args[0])
    elif mode=='summary': return summarize()
    elif mode=='production':
        assert summarize()==0, 'Every new exact case and strict gate must actually pass before packaging'
        production(*args)
    elif mode=='integrity':
        directory=Path(args[0]);value=json.loads((directory/'provenance.json').read_text())
        assert digest(directory/'agent-browser')==value['binary_sha256']
        assert value['profile']=='ci' and value['features']==[]
        assert value['native_validation']['receipt_sha256']==digest(directory/'native-focused-verified.json')
        assert value['full_native_suite_passed'] is value['optimized_native_tests_executed'] is value['installed_distribution_verified'] is value['release_eligible'] is False
        assert value['requires_removal'] is True
    elif mode=='aggregate':
        states={p:(EVIDENCE/(p+'.exit')).read_text().strip() for p in args}
        save(EVIDENCE/'aggregate.json',{'accepted':all(v=='0' for v in states.values()),'phases':states,'releaseEligible':False})
        assert all(v=='0' for v in states.values())
    else: raise AssertionError('Closed diagnostic producer mode required')
    return 0
if __name__=='__main__':
    signal.signal(signal.SIGTERM,terminate_owned); signal.signal(signal.SIGINT,terminate_owned)
    sys.exit(main())
