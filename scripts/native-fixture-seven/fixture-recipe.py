#!/usr/bin/env python3
"""Exactly twelve SW late-detach repair fixtures. Every selected test must pass."""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
PINS = json.loads((HERE / 'pins.json').read_text())
EVIDENCE = Path(os.environ.get('EVIDENCE_DIR', '.'))
ACTIVE_GROUPS = set()
COMPILE_PHASES = ['recipe-identity', 'parser-self-tests', 'source-before', 'apply-overlay', 'toolchain', 'format', 'clippy', 'acceptance-tests-check', 'proxy-feature-check', 'default-harness-compile', 'default-harness-inventory']

# The existing compile helper's owned-process-group timeout/exit preservation.
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

def require_frozen_pins():
    assert PINS.get('pendingSourcePins') is False, 'Final native SHA/tree pins are pending; execution refused'
    for field in ('publishedNativeSha', 'candidateTree', 'baseNativeSha', 'baseNativeTree'):
        assert re.fullmatch(r'[0-9a-f]{40}', PINS[field]), 'Unfrozen source identity: ' + field
    for field in ('nativeLockSha256', 'patchSha256'):
        assert re.fullmatch(r'[0-9a-f]{64}', PINS[field]), 'Unfrozen hash: ' + field
    assert PINS['baseNativeSha'] == 'ffcfad2a81012f22c7d1f03f726dd7b6e920ce5e'
    assert PINS['baseNativeTree'] == '4e9a6d877503672174d38a859454bf007ea6bc45'
    assert PINS['candidateTree'] != PINS['baseNativeTree']
    assert PINS['productionSourceChanged'] is True
    assert [row['path'] for row in PINS['changedFiles']] == [
        'cli/src/native/cdp/client.rs', 'cli/src/native/client_enrollment.rs',
        'cli/src/native/client_network.rs']
    assert set(PINS['configurations']) == {'default'}
    assert PINS['configurations']['default'] == {'features': [], 'profile': 'dev', 'targetDirectory': 'debug/deps'}
    assert len(PINS['cases']) == 12 and all(row['expected'] == 'passed' for row in PINS['cases'])
    assert len({row['name'] for row in PINS['cases']}) == 12


def assert_source_binding(source):
    require_frozen_pins()
    assert source['publishedHead'] == PINS['publishedNativeSha']
    assert source['baseHead'] == PINS['baseNativeSha']
    assert source['baseTree'] == PINS['baseNativeTree']
    assert source['effectiveTree'] == PINS['candidateTree']
    assert source['lockSha256'] == PINS['nativeLockSha256']
    assert source['productionSourceChanged'] is True


def verify_selected_test_sources(root):
    for case in PINS['cases']:
        lines = (Path(root) / case['sourcePath']).read_text().splitlines()
        assert case['name'].startswith(case['sourceModule'] + '::')
        function = case['name'].split('::')[-1]
        starts = [i for i, line in enumerate(lines) if re.match(r'\s*async fn ' + re.escape(function) + r'\(', line)]
        assert len(starts) == 1, 'Selected test definition must be unique: ' + function
        index = starts[0]
        assert lines[index - 1].strip().startswith('#[tokio::test')
        assert lines[case['definitionLine'] - 1] == lines[index]
        attributes = []
        while index > 0 and lines[index - 1].strip().startswith('#['):
            index -= 1
            attributes.append(lines[index].strip())
        assert not any('ignore' in value for value in attributes)
        assert sum(line.strip() == 'mod tests {' for line in lines[:index]) == 1
        assert any(line.strip() == '#[cfg(test)]' for line in lines[:index])


def source_identity(root, applied):
    require_frozen_pins()
    root = Path(root).resolve()
    assert git(root, 'rev-parse', 'HEAD') == PINS['publishedNativeSha']
    parents = [line[7:] for line in git(root, 'cat-file', '-p', 'HEAD').splitlines() if line.startswith('parent ')]
    assert parents == [PINS['baseNativeSha']], 'Repair source must have exactly the published V2 regression base parent'
    assert git(root, 'rev-parse', 'HEAD^1^{tree}') == PINS['baseNativeTree']
    assert git(root, 'rev-parse', 'HEAD^{tree}') == PINS['candidateTree']
    assert digest(root / 'cli/Cargo.lock') == PINS['nativeLockSha256']
    assert not git(root, 'status', '--porcelain', '--untracked-files=all'), 'Source checkout must remain pristine'
    assert git(root, 'write-tree') == PINS['candidateTree']
    assert git(root, 'diff', '--name-only', 'HEAD^1', 'HEAD').splitlines() == [row['path'] for row in PINS['changedFiles']]
    for row in PINS['changedFiles']:
        assert digest(root / row['path']) == row['afterSha256']
        before = subprocess.check_output(['git', '-C', str(root), 'show', 'HEAD^1:' + row['path']])
        assert hashlib.sha256(before).hexdigest() == row['beforeSha256']
    verify_selected_test_sources(root)
    return {'publishedHead': PINS['publishedNativeSha'], 'baseHead': PINS['baseNativeSha'], 'baseTree': PINS['baseNativeTree'], 'effectiveTree': PINS['candidateTree'], 'productionSourceChanged': True, 'lockSha256': PINS['nativeLockSha256']}


def apply_overlay(root):
    # Reverse the reviewed three-file production repair in a private index.
    # Preserve the published V2 regression baseline and its historical RED.
    source_identity(root, False)
    patch = HERE / 'source-change.patch'
    assert digest(patch) == PINS['patchSha256']
    with tempfile.TemporaryDirectory(prefix='sw-late-detach-overlay-') as temporary:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(temporary) / 'index'))
        command = ['git', '-C', str(root)]
        subprocess.run(command + ['read-tree', PINS['candidateTree']], env=env, check=True)
        subprocess.run(command + ['apply', '--cached', '--reverse', '--check', '--whitespace=error', str(patch)], env=env, check=True)
        subprocess.run(command + ['apply', '--cached', '--reverse', '--whitespace=error', str(patch)], env=env, check=True)
        assert subprocess.check_output(command + ['write-tree'], env=env, text=True).strip() == PINS['baseNativeTree']
    value = source_identity(root, True)
    value.update(patchSha256=PINS['patchSha256'], productionSourceChanged=True, reversePatchRestoresPublishedBaseTree=True)
    save(EVIDENCE / 'source-change-identity.json', value)

def capture_harness(root, configuration):
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
    assert before == digest(binary)
    save(EVIDENCE / (configuration + '-harness-binding.json'), {'binary': str(binary), 'sha256': before, 'cargoArtifact': row, 'source': source_identity(root, True), 'inventory': inventory, 'selectedExactTests': selected, 'configuration': configuration, 'features': config['features'], 'cargoProfile': 'dev', 'productionImageBuilt': False})

def inspect_case(case, stdout, stderr, result, harness_sha, post_sha, source):
    """Exact libtest stdout is evidence, not just a process exit or expected label."""
    outcomes = re.findall(r'(?m)^test (\S+) \.\.\. (ok|ignored(?:, [^\n]*)?|FAILED)$', stdout)
    summaries = re.findall(r'(?m)^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in [0-9.]+s$', stdout)
    actual = 'unknown'
    try:
        assert_source_binding(source)
        source_matches = True
    except (AssertionError, KeyError, TypeError):
        source_matches = False
    if len(summaries) == 1 and len(outcomes) == 1 and outcomes[0][0] == case['name'] and re.findall(r'(?m)^running (\d+) tests?$', stdout) == ['1']:
        word, passed, failed, ignored, measured, _filtered = summaries[0]
        if source_matches and ignored == measured == '0' and not result.get('timed_out') and not result.get('interrupted') and harness_sha == post_sha:
            if word == 'ok' and (passed, failed) == ('1', '0') and outcomes[0][1] == 'ok' and result.get('exit') == 0:
                actual = 'passed'
            elif word == 'FAILED' and (passed, failed) == ('0', '1') and outcomes[0][1] == 'FAILED' and result.get('exit') == 101:
                actual = 'failed'
    expected_observed = actual == case['expected']
    return {'id': case['id'], 'test': case['name'], 'category': case['category'], 'expected': case['expected'], 'actual': actual,
            'configuration': case['configuration'], 'features': PINS['configurations'][case['configuration']]['features'], 'expectedObservationConfirmed': expected_observed, 'testPassed': actual == 'passed',
            'classification': 'expected-pass-observed' if case['expected'] == 'passed' and expected_observed else 'unexpected-pass' if actual == 'passed' else 'unexpected-failure' if actual == 'failed' else 'unknown', 'process': result,
            'harnessSha256Before': harness_sha, 'harnessSha256After': post_sha, 'sourceTree': source.get('effectiveTree'), 'sourceIdentityConfirmed': source_matches, 'productionSourceChanged': True,
            'originalE2eRetired': False, 'fullNativeSuitePassed': False, 'productionAcceptance': False}

def verify_saved_case(case):
    saved = json.loads((EVIDENCE / (case['id'] + '.ledger.json')).read_text())
    binding = json.loads((EVIDENCE / (case['configuration'] + '-harness-binding.json')).read_text())
    assert_source_binding(binding['source'])
    assert binding['source']['effectiveTree'] == PINS['candidateTree'] and binding['selectedExactTests'] == [row for row in PINS['cases'] if row['configuration'] == case['configuration']] and binding['configuration'] == case['configuration'] and binding['features'] == PINS['configurations'][case['configuration']]['features'] and binding['cargoProfile'] == 'dev'
    result = json.loads((EVIDENCE / (case['id'] + '.result.json')).read_text())
    command = [binding['binary'], '--exact', case['name'], '--test-threads=1', '--format', 'pretty', '--color', 'never']
    assert result['command'] == command and saved['command'] == command
    assert saved['harnessSha256Before'] == saved['harnessSha256After'] == binding['sha256']
    actual = inspect_case(case, (EVIDENCE / (case['id'] + '.stdout.log')).read_text(), (EVIDENCE / (case['id'] + '.stderr.log')).read_text(), result, binding['sha256'], saved['harnessSha256After'], binding['source'])
    assert all(saved[key] == value for key, value in actual.items()), 'Ledger does not match raw evidence'
    return actual

def run_case(case_id):
    case = next(row for row in PINS['cases'] if row['id'] == case_id)
    binding = json.loads((EVIDENCE / (case['configuration'] + '-harness-binding.json')).read_text())
    assert_source_binding(binding['source'])
    assert binding['source']['effectiveTree'] == PINS['candidateTree'] and binding['selectedExactTests'] == [row for row in PINS['cases'] if row['configuration'] == case['configuration']] and binding['configuration'] == case['configuration'] and binding['features'] == PINS['configurations'][case['configuration']]['features'] and binding['cargoProfile'] == 'dev'
    binary = Path(binding['binary']); assert digest(binary) == binding['sha256']
    command = [str(binary), '--exact', case['name'], '--test-threads=1', '--format', 'pretty', '--color', 'never']
    status = execute(case_id, 120, command)
    result = json.loads((EVIDENCE / f'{case_id}.result.json').read_text())
    receipt = inspect_case(case, (EVIDENCE / f'{case_id}.stdout.log').read_text(), (EVIDENCE / f'{case_id}.stderr.log').read_text(), result, binding['sha256'], digest(binary), binding['source'])
    receipt['command'] = command
    save(EVIDENCE / f'{case_id}.ledger.json', receipt)
    # Preserve all nonzero exits, including historical-style 101 failures.
    return status if status else (0 if receipt['testPassed'] and receipt['expectedObservationConfirmed'] else 1)

def summarize():
    phases = COMPILE_PHASES + ['source-after']
    states = {name: (EVIDENCE / f'{name}.exit').read_text().strip() if (EVIDENCE / f'{name}.exit').exists() else 'missing' for name in phases}
    cases = []
    for case in PINS['cases']:
        file = EVIDENCE / (case['id'] + '.ledger.json')
        try:
            cases.append(verify_saved_case(case))
        except (OSError, ValueError, KeyError, AssertionError):
            cases.append({'id': case['id'], 'test': case['name'], 'expected': case['expected'], 'actual': 'unknown' if file.exists() else 'not-run', 'expectedObservationConfirmed': False, 'testPassed': False})
    all_gates = all(value == '0' for value in states.values())
    outcome = {'scope': 'exactly twelve SW late-detach repair regressions, all expected PASS; reviewed production change; no browser, product image, seven-suite, query matcher, retirement or full acceptance', 'sourceTree': PINS['candidateTree'],
               'productionSourceChanged': True, 'strictGatesPassed': all_gates, 'phases': states, 'cases': cases,
               'expectedObservationsConfirmed': all_gates and all(case['expectedObservationConfirmed'] for case in cases),
               'passedTestCount': sum(case['actual'] == 'passed' for case in cases), 'failedTestCount': sum(case['actual'] == 'failed' for case in cases),
               'allTwelveTestsPassed': all_gates and all(case['testPassed'] for case in cases), 'fullNativeSuitePassed': False,
               'retirementCountChanged': False, 'productionBuildExecuted': False, 'releaseEligible': False}
    save(EVIDENCE / 'summary.json', outcome)
    print(json.dumps(outcome, indent=2))
    # Every selected exact test and every independent gate must pass.
    return 0 if outcome['allTwelveTestsPassed'] and outcome['expectedObservationsConfirmed'] else 1

def main():
    mode, *args = sys.argv[1:]
    require_frozen_pins()
    if mode == 'run':
        return execute(args[0], int(args[1]), args[2:])
    if mode == 'recipe':
        require_frozen_pins()
        root = Path(args[0]); sha = args[1]
        assert git(root, 'rev-parse', 'HEAD') == sha and not git(root, 'status', '--porcelain')
        save(EVIDENCE / 'recipe-binding.json', {'commit': sha, 'tree': git(root, 'rev-parse', 'HEAD^{tree}'), 'helperSha256': digest(Path(__file__)), 'pinsSha256': digest(HERE / 'pins.json'), 'patchSha256': digest(HERE / 'source-change.patch'), 'selfTestsSha256': digest(HERE / 'test-recipe.py')})
        return 0
    if mode == 'source':
        print(json.dumps(source_identity(args[0], args[1] == 'applied'), indent=2)); return 0
    if mode == 'apply':
        apply_overlay(args[0]); return 0
    if mode == 'harness':
        capture_harness(args[0], args[1]); return 0
    if mode == 'case':
        return run_case(args[0])
    if mode == 'summary':
        return summarize()
    raise AssertionError('Explicit closed fixture mode required')

if __name__ == '__main__':
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, terminate_owned)
    raise SystemExit(main())
