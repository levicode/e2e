"""Evidence validation/custody for reviewed r2 full-libtest machinery; not a test runner."""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
BOUNDARIES = ['native-format-check', 'native-default-clippy', 'native-feature-check', 'native-proxy-check']

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args], text=True).strip()

def listed(text):
    names = [line[:-6] for line in text.splitlines() if line.endswith(': test')]
    assert names and len(names) == len(set(names)), 'empty or duplicate test inventory'
    summary = re.findall(r'^(\d+) tests, (\d+) benchmarks$', text, re.M)
    assert summary == [(str(len(names)), '0')], 'missing, duplicate or inconsistent inventory trailer'
    return sorted(names)

def inventory(all_text, ignored_text, expected):
    all_names, ignored = listed(all_text), listed(ignored_text)
    assert all_names == expected['allTests'], 'full collection differs from source-derived exact inventory'
    assert ignored == expected['ignoredTests'], 'ignored set differs: no new silent skips permitted'
    assert set(ignored) <= set(all_names)
    return {'allTests': all_names, 'ignoredTests': ignored, 'total': len(all_names),
            'ignored': len(ignored), 'nonignored': len(all_names) - len(ignored)}

def results(text, code, expected):
    all_names, ignored = expected['allTests'], expected['ignoredTests']
    rows = re.findall(r'^test (\S+) \.\.\. (ok|FAILED|ignored)(?:,.*)?$', text, re.M)
    summaries = re.findall(r'^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;.*$', text, re.M)
    report = {'exit': code, 'summaries': summaries, 'observedTests': len(rows), 'expectedTests': len(all_names),
              'failedTests': [name for name, state in rows if state == 'FAILED'], 'accepted': False,
              'captureMissing': False, 'captureLoss': False, 'errors': []}
    names = [name for name, _ in rows]
    if Counter(names) != Counter(all_names):
        report['captureLoss'] = True
        report['errors'].append('result name set differs from complete collection')
        report['missingTests'] = sorted(set(all_names) - set(names))
        report['unexpectedTests'] = sorted(set(names) - set(all_names))
        report['duplicateTests'] = sorted(n for n, c in Counter(names).items() if c != 1)
    if sorted(n for n, s in rows if s == 'ignored') != ignored:
        report['errors'].append('ignored result set differs from exact reviewed ignore set')
    if len(summaries) != 1:
        report['captureLoss'] = True
        report['errors'].append('missing or duplicated full-suite summary')
    else:
        state, passed, failed, skipped, measured, filtered = summaries[0]
        counts = tuple(map(int, [passed, failed, skipped, measured, filtered]))
        report['counts'] = dict(zip(['passed', 'failed', 'ignored', 'measured', 'filtered'], counts))
        actual = Counter(state for _, state in rows)
        if counts != (actual['ok'], actual['FAILED'], actual['ignored'], 0, 0):
            report['errors'].append('summary and per-test results disagree or filtering occurred')
        if state != 'ok' or int(failed) != 0:
            report['errors'].append('suite failure')
    if code != 0:
        report['errors'].append('nonzero/timeout/signal suite exit')
    report['accepted'] = not report['errors']
    return report

def full_suite_capture_metadata(evidence):
    """The parser consumes raw stdout only; stderr remains independent mandatory evidence."""
    stdout = evidence / 'full-suite.log'
    stderr = evidence / 'full-suite.stderr.log'
    return {'logStream': 'stdout', 'logSHA256': digest(stdout), 'logBytes': stdout.stat().st_size,
            'stderrStream': 'stderr', 'stderrSHA256': digest(stderr), 'stderrBytes': stderr.stat().st_size}

def checked_full_suite_capture(evidence, report):
    actual = full_suite_capture_metadata(evidence)
    assert all(report.get(key) == value for key, value in actual.items()), 'full-suite raw stream receipt differs'
    return actual

# S6 adds evidence checks only: the existing compiler-selected harness is reused.
REQUIRED_NEW_COUNT = 20
RETAINED_REQUIRED_COUNT = 43
PURE_PROJECTION_COUNT = 23
PURE_CAPTURE_NAMES = [
    'raw-result.json', 'raw.log', 'run.exit', 'install.log', 'install.exit',
    'command.json', 'install-command.json', 'versions.json',
    'node-version.txt', 'pnpm-version.txt', 'vitest-version.txt',
]

def bound_identity(pins):
    for name in ['commit', 'tree']:
        value = pins.get(name)
        assert type(value) is str and re.fullmatch('[0-9a-f]{40}', value) and value != '0' * 40, 'unbound native ' + name
    assert pins['toolchain'] == '1.99.1' and pins['profile'] == 'ci'

def exact_names(value, count, label, rust=True):
    assert type(value) is list and len(value) == count and count > 0, label + ': missing/empty/wrong count'
    assert all(type(name) is str and name and name == name.strip() for name in value), label + ': invalid names'
    assert len(set(value)) == count, label + ': duplicate names'
    if rust:
        assert all(re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*(?:::[A-Za-z_][A-Za-z_0-9]*)+', name) for name in value), label + ': nonexact Rust names'
    return value

def required_controls(pins, collection):
    new = exact_names(pins.get('requiredNewTests'), REQUIRED_NEW_COUNT, 'new controls')
    retained = exact_names(pins.get('retainedRequiredTests'), RETAINED_REQUIRED_COUNT, 'retained controls')
    assert not set(new) & set(retained), 'new/retained controls overlap'
    all_names, ignored = collection['allTests'], collection['ignoredTests']
    assert type(all_names) is list and all_names and all_names == sorted(set(all_names)), 'invalid complete collection'
    assert type(ignored) is list and ignored == sorted(set(ignored)) and set(ignored) <= set(all_names)
    required = set(new + retained)
    assert required <= set(all_names), 'required controls absent from full inventory'
    assert not required & set(ignored), 'required controls must not be ignored'
    return {'accepted': True, 'requiredNewTests': new, 'retainedRequiredTests': retained,
            'newCount': len(new), 'retainedCount': len(retained), 'coverage': 'contained in full inventory; exact executions are reruns, not additional coverage'}

def checked_inventory(evidence, pins, gate):
    assert gate in ['default', 'fault']
    expected = json.loads((HERE / ('inventory-' + gate + '.json')).read_text())
    assert expected['nativeCommit'] == pins['commit'] and expected['nativeTree'] == pins['tree'], 'inventory source identity differs'
    assert expected['profile'] == 'ci' and expected['features'] == (['acceptance-faults'] if gate == 'fault' else [])
    for name in ['all-tests', 'ignored-tests']:
        assert (evidence / (name + '.exit')).read_text().strip() == '0', 'collection did not succeed'
    actual = inventory((evidence / 'all-tests.list').read_text(), (evidence / 'ignored-tests.list').read_text(), expected)
    saved = json.loads((evidence / 'inventory.json').read_text())
    assert all(saved.get(key) == value for key, value in actual.items()), 'inventory receipt differs from raw collection'
    assert saved.get('features') == expected['features'] and saved.get('profile') == 'ci'
    for key, filename in [('allListSHA256', 'all-tests.list'), ('ignoredListSHA256', 'ignored-tests.list')]:
        assert saved.get(key) == digest(evidence / filename), 'collection hash differs'
    return actual

def required_controls_report(evidence, pins, gate):
    report = required_controls(pins, checked_inventory(evidence, pins, gate))
    report.update({'nativeCommit': pins['commit'], 'nativeTree': pins['tree'], 'profile': 'ci', 'gate': gate,
                   'allListSHA256': digest(evidence / 'all-tests.list'), 'ignoredListSHA256': digest(evidence / 'ignored-tests.list')})
    return report

def selected_harness(evidence, target):
    metadata = json.loads((evidence / 'test-binary.json').read_text())
    assert metadata['fresh'] is False and metadata['features'] == ['acceptance-faults']
    assert metadata['cargoArtifactsSHA256'] == digest(evidence / 'harness.jsonl')
    assert metadata['compilerArgvSHA256'] == digest(evidence / 'compiler-argv.txt')
    assert (evidence / 'harness-build.exit').read_text().strip() == '0'
    rows = [json.loads(line) for line in (evidence / 'harness.jsonl').read_text().splitlines()]
    assert rows and rows[-1].get('reason') == 'build-finished' and rows[-1].get('success') is True
    assert [r['success'] for r in rows if r.get('reason') == 'build-finished'] == [True]
    candidates = [r for r in rows if r.get('reason') == 'compiler-artifact' and r.get('target', {}).get('name') == 'agent-browser'
                  and r.get('target', {}).get('kind') == ['bin'] and r.get('profile', {}).get('test') is True and r.get('executable')]
    assert len(candidates) == 1, 'missing/ambiguous compiler-selected harness'
    row = candidates[0]
    assert row['fresh'] is False and row['features'] == ['acceptance-faults']
    assert row['profile'] == metadata['profile']
    assert row['profile']['opt_level'] == '3' and row['profile']['debug_assertions'] is False and row['profile']['overflow_checks'] is False
    target = target.resolve(strict=True)
    binary = Path(row['executable']).resolve(strict=True)
    assert binary.is_file() and binary.is_relative_to(target), 'harness escaped fresh target'
    assert str(binary.relative_to(target)) == metadata['relativePath']
    assert (evidence / 'harness.path').read_text().strip() == str(binary), 'selected harness path differs'
    assert digest(binary) == metadata['sha256'], 'selected harness hash differs'
    return binary, metadata['sha256']

def exact_group_results_report(evidence, pins, target, collection, names, prefix):
    assert prefix in ['new-native-exact', 's9-native-exact'], 'unknown exact evidence group'
    binary, binary_sha = selected_harness(evidence, target)
    out = evidence / prefix
    assert listed((out / 'harness-list.log').read_text()) == collection['allTests'], 'exact runner collected another harness inventory'
    assert (evidence / (prefix + '.exit')).read_text().strip() == '0', 'exact runner failed/timed out'
    value = json.loads((out / 'results.json').read_text())
    assert value['harnessSha256'] == binary_sha and value['features'] == ['acceptance-faults']
    assert value['notFullAcceptance'] is True and type(value['expected']) is int and value['expected'] == len(names)
    rows = value['results']
    assert type(rows) is list and len(rows) == len(names) and [row['name'] for row in rows] == names, 'exact results missing/duplicated/reordered'
    assert [json.loads(line) for line in (evidence / (prefix + '.log')).read_text().splitlines()] == rows, 'exact command log differs from result receipt'
    captures = []
    for i, (name, row) in enumerate(zip(names, rows), 1):
        assert row['command'] == [str(binary), '--exact', name, '--nocapture', '--test-threads=1'], 'nonexact/foreign harness argv'
        assert type(row['exit']) is int and row['exit'] == 0 and row['timedOut'] is False and row['passed'] is True
        assert row['counts'] == [['1', '0', '0']], 'non-single PASS metadata'
        log_path, cleanup = out / f'test-{i:02d}.log', out / f'test-{i:02d}.cleanup.jsonl'
        log = log_path.read_text()
        assert digest(log_path) == row['logSha256'], 'exact raw log hash differs'
        assert re.findall(r'^test (\S+) \.\.\. (ok|FAILED|ignored)(?:,.*)?$', log, re.M) == [(name, 'ok')], 'exact raw result not one named PASS'
        summary = re.findall(r'^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;.*$', log, re.M)
        assert summary == [('ok', '1', '0', '0', '0', str(len(collection['allTests']) - 1))], 'exact result skipped/filtered/wrong counts'
        assert cleanup.is_file(), 'missing per-test cleanup capture'
        captures.append({'name': name, 'logSHA256': digest(log_path), 'cleanupSHA256': digest(cleanup)})
    return {'accepted': True, 'nativeCommit': pins['commit'], 'nativeTree': pins['tree'], 'profile': 'ci',
            'features': ['acceptance-faults'], 'binarySHA256': binary_sha, 'count': len(names), 'results': captures,
            'runnerResultsSHA256': digest(out / 'results.json'), 'runnerLogSHA256': digest(evidence / (prefix + '.log')),
            'coverage': 'reruns of controls already contained in each complete inventory; not additional coverage', 'browserAcceptance': False}

def exact_results_report(evidence, pins, target):
    collection = checked_inventory(evidence, pins, 'fault')
    required = required_controls(pins, collection)
    names = required['requiredNewTests']
    assert json.loads((evidence / 'new-native-exact-inventory.json').read_text()) == {'selectors': names, 'count': len(names)}
    assert json.loads((evidence / 'required-controls.json').read_text()) == required_controls_report(evidence, pins, 'fault')
    return exact_group_results_report(evidence, pins, target, collection, names, 'new-native-exact')

# S9 is an additional exact group, never a replacement for the original 20/43.
S9_REQUIRED_COUNT = 21

def s9_required_controls(pins, collection):
    bound_identity(pins)
    original = required_controls(pins, collection)
    names = exact_names(pins.get('s9RequiredTests'), S9_REQUIRED_COUNT, 'S9 controls')
    assert not set(names) & set(original['requiredNewTests'] + original['retainedRequiredTests']), 'S9/original controls overlap'
    assert set(names) <= set(collection['allTests']), 'S9 controls absent from full inventory'
    assert not set(names) & set(collection['ignoredTests']), 'S9 controls must not be ignored'
    return {'accepted': True, 's9RequiredTests': names, 's9Count': len(names),
            'coverage': 'contained in full inventory; exact executions are reruns, not additional coverage'}

def s9_required_controls_report(evidence, pins, gate):
    report = s9_required_controls(pins, checked_inventory(evidence, pins, gate))
    report.update({'nativeCommit': pins['commit'], 'nativeTree': pins['tree'], 'profile': 'ci', 'gate': gate,
                   'allListSHA256': digest(evidence / 'all-tests.list'), 'ignoredListSHA256': digest(evidence / 'ignored-tests.list')})
    return report

def s9_exact_results_report(evidence, pins, target):
    collection = checked_inventory(evidence, pins, 'fault')
    required = s9_required_controls(pins, collection)
    names = required['s9RequiredTests']
    assert json.loads((evidence / 's9-native-exact-inventory.json').read_text()) == {'selectors': names, 'count': len(names)}
    assert json.loads((evidence / 's9-required-controls.json').read_text()) == s9_required_controls_report(evidence, pins, 'fault')
    return exact_group_results_report(evidence, pins, target, collection, names, 's9-native-exact')


def pure_results_report(root, evidence, pins):
    projection = pins['pureProjection']
    assert projection['file'] == 'packages/e2e/tests/unit/attribute-field-assertions.test.ts'
    names = exact_names(projection.get('testNames'), PURE_PROJECTION_COUNT, 'pure projection controls', rust=False)
    assert projection['nodeMajor'] == 24 and projection['pnpmVersion'] == '12.3.4' and projection['vitestVersion'] == '5.0.5'
    out = evidence / 'attribute-projection'
    assert all((out / name).is_file() for name in PURE_CAPTURE_NAMES), 'missing pure capture'
    assert (out / 'run.exit').read_text().strip() == (out / 'install.exit').read_text().strip() == '0', 'pure run/frozen install failed'
    assert (out / 'raw.log').stat().st_size > 0 and (out / 'install.log').stat().st_size > 0, 'empty pure command captures'
    command = ['pnpm', '--filter', 'e2e', 'exec', 'vitest', 'run', 'tests/unit/attribute-field-assertions.test.ts',
               '--project', 'unit', '--reporter=json', '--outputFile=' + str(out / 'raw-result.json')]
    assert json.loads((out / 'command.json').read_text()) == command, 'non-unit/nonexact pure command'
    assert json.loads((out / 'install-command.json').read_text()) == ['pnpm', 'install', '--frozen-lockfile'], 'install lock not frozen'
    versions = json.loads((out / 'versions.json').read_text())
    assert type(versions) is dict and set(versions) == {'node', 'pnpm', 'vitest'}
    for key in ['node', 'pnpm', 'vitest']:
        assert type(versions[key]) is str and versions[key] == (out / (key + '-version.txt')).read_text().strip(), 'version raw capture differs'
    assert re.fullmatch(r'v24\.\d+\.\d+', versions['node']), 'wrong Node major'
    assert versions['pnpm'] == projection['pnpmVersion'], 'wrong pnpm version'
    assert re.match(r'^vitest/' + re.escape(projection['vitestVersion']) + r'\s', versions['vitest']), 'wrong Vitest version'
    raw = json.loads((out / 'raw-result.json').read_text())
    assert raw['success'] is True
    for key in ['numTotalTests', 'numPassedTests']:
        assert type(raw[key]) is int and raw[key] == len(names), 'wrong pure count'
    for key in ['numFailedTests', 'numPendingTests', 'numTodoTests', 'numFailedTestSuites', 'numPendingTestSuites']:
        assert type(raw[key]) is int and raw[key] == 0, 'pure failure/skip/todo'
    assert type(raw['numTotalTestSuites']) is int and raw['numTotalTestSuites'] > 0
    assert type(raw['numPassedTestSuites']) is int and raw['numPassedTestSuites'] == raw['numTotalTestSuites']
    assert raw.get('numRuntimeErrorTestSuites', 0) == 0 and raw.get('unhandledErrors', []) == [] and raw.get('testExecError') is None
    assert type(raw['testResults']) is list and len(raw['testResults']) == 1, 'wrong pure file count'
    suite = raw['testResults'][0]
    expected_file = (root / projection['file']).resolve(strict=True)
    assert type(suite['name']) is str and Path(suite['name']).is_absolute() and Path(suite['name']).resolve() == expected_file, 'wrong pure test file'
    assert suite['status'] == 'passed' and suite.get('message', '') == '' and suite.get('testExecError') is None
    assertions = suite['assertionResults']
    assert type(assertions) is list and len(assertions) == len(names)
    assert Counter(row['fullName'] for row in assertions) == Counter(names), 'pure exact names differ/duplicate'
    assert all(row['status'] == 'passed' and row['failureMessages'] == [] for row in assertions), 'pure assertion skipped or failed'
    producer = json.loads((evidence / 'producer.json').read_text())
    assert producer['gate'] == 'fault' and producer['profile'] == 'ci' and producer['features'] == ['acceptance-faults']
    assert producer['nativeCommit'] == pins['commit'] and producer['nativeTree'] == pins['tree']
    for key in ['commit', 'tree']:
        assert type(producer[key]) is str and re.fullmatch('[0-9a-f]{40}', producer[key]) and producer[key] != '0' * 40
    assert producer['files'][projection['file']] == digest(expected_file), 'pure source file differs from producer capture'
    assert type(projection.get('sourceSHA256')) is str and re.fullmatch('[0-9a-f]{64}', projection['sourceSHA256']) and digest(expected_file) == projection['sourceSHA256'], 'pure source file differs from reviewed pin'
    return {'accepted': True, 'producerCommit': producer['commit'], 'producerTree': producer['tree'],
            'nativeCommit': pins['commit'], 'nativeTree': pins['tree'], 'file': projection['file'],
            'sourceSHA256': digest(expected_file), 'count': len(names), 'testNames': names,
            'versions': versions, 'captures': {name: digest(out / name) for name in PURE_CAPTURE_NAMES}, 'browserAcceptance': False}

# Separate S7 pure group: the original attribute23 validator/schema is unchanged.
CLASS_CONFIG_FILE = '.github/native-full-regression/class-pure.config.ts'
CLASS_TEST_FILES = ['packages/e2e/tests/unit/fixture-attribute-sampling.test.ts',
                    'packages/web/tests/unit/class-sampling.test.ts',
                    'packages/web/tests/unit/class-owned-deadline.test.ts']
CLASS_SOURCE_FILES = [
    'docs/reference/engine.mdx', 'packages/e2e/src/engine/index.ts',
    'packages/e2e/src/locator/engine.ts', 'packages/e2e/src/run/fixtures.ts',
    'packages/e2e/tests/helpers/fixture-attribute-sampling.ts',
    'packages/web/tests/helpers/class-sampling.ts',
    *CLASS_TEST_FILES, 'packages/web/src/browser.ts',
    'packages/e2e/src/internal/time.ts', 'packages/e2e/src/run/budget.ts',
    'packages/e2e/src/expect/async.ts', 'packages/e2e/tests/helpers/fake-time.ts',
]
CLASS_CAPTURE_NAMES = ['raw-result.json', 'raw.log', 'run.exit', 'command.json',
                       'versions.json', 'node-version.txt', 'pnpm-version.txt', 'vitest-version.txt']
CLASS_SHARED_INSTALL_NAMES = ['install.log', 'install.exit', 'install-command.json']

CLASS_REPLACED_DIAGNOSTIC_NAMES = ['closed class sample diagnostics records prior completed sample without changing the thrown timeout (prior=false)', 'closed class sample diagnostics records prior completed sample without changing the thrown timeout (prior=true)']
CLASS_ADDITIONAL_DIAGNOSTIC_NAMES = ['closed class sample diagnostics records the same sample history with assertion-owned timeout attribution (prior=false)', 'closed class sample diagnostics records the same sample history with assertion-owned timeout attribution (prior=true)']
CLASS_OWNED_DEADLINE_NAMES = ['browser class assertion-owned deadline retains an actual mismatch when the final read starts with 99 ms', 'browser class assertion-owned deadline retains an actual mismatch when the final read starts with 100 ms', 'browser class assertion-owned deadline retains an actual mismatch when the final read starts with 135 ms', 'browser class assertion-owned deadline retains an actual mismatch when the final read starts with 200 ms', 'browser class assertion-owned deadline does not invent a prior mismatch when the first read times out', 'browser class assertion-owned deadline does not rewrite an early read timeout before its own deadline', 'browser class assertion-owned deadline preserves an earlier or equal parent deadline of 250 ms', 'browser class assertion-owned deadline preserves an earlier or equal parent deadline of 300 ms', 'browser class assertion-owned deadline preserves failure once the original parent also expired during settlement', 'browser class assertion-owned deadline does not borrow a replacement phase for a pending old-phase timeout', 'browser class assertion-owned deadline keeps parent cancellation selected after a prior mismatch', 'browser class assertion-owned deadline preserves ACTION_MAY_HAVE_COMMITTED rather than converting it to a mismatch', 'browser class assertion-owned deadline preserves CANCELLED rather than converting it to a mismatch', 'browser class assertion-owned deadline preserves ENGINE_FAILURE rather than converting it to a mismatch', 'browser class assertion-owned deadline preserves an outer policy refusal with a nested timeout', 'browser class assertion-owned deadline does not turn an unseen 100ms negation tail into a pass', 'browser class assertion-owned deadline retains the existing short-tail negation grace without another read', 'browser class assertion-owned deadline retains the older context fallback without claiming ownership', 'browser class assertion-owned deadline does not consult the new proof for a legacy getter without the sampler']

def class_results_report(root, evidence, pins):
    bound_identity(pins)
    projection = pins['classProjection']
    assert projection['configFile'] == CLASS_CONFIG_FILE, 'wrong class config path'
    assert projection['nodeMajor'] == 24 and projection['pnpmVersion'] == '12.3.4' and projection['vitestVersion'] == '5.0.5'
    groups = projection['files']
    assert type(groups) is list and len(groups) == 3, 'missing/extra class source groups'
    assert [group['file'] for group in groups] == CLASS_TEST_FILES, 'wrong/duplicate class test files'
    names_by_file = {group['file']: exact_names(group.get('testNames'), 20 if i < 2 else 19, 'class controls', rust=False) for i, group in enumerate(groups)}
    assert names_by_file[CLASS_TEST_FILES[2]] == CLASS_OWNED_DEADLINE_NAMES, 'wrong owned deadline identities'
    all_names = [name for path in CLASS_TEST_FILES[:2] for name in names_by_file[path]]
    assert len(set(all_names)) == 40, 'class names overlap between files'
    original_names = list(all_names)
    assert projection['replacedDiagnosticTests'] == CLASS_REPLACED_DIAGNOSTIC_NAMES, 'wrong diagnostic replacement source identities'
    diagnostics = projection['additionalDiagnosticTests']
    assert diagnostics == CLASS_ADDITIONAL_DIAGNOSTIC_NAMES, 'wrong additional class diagnostic identities'
    assert not set(diagnostics) & set(original_names), 'diagnostics overlap original class40'
    names_by_file[CLASS_TEST_FILES[1]] = names_by_file[CLASS_TEST_FILES[1]] + diagnostics
    all_names = original_names + diagnostics + names_by_file[CLASS_TEST_FILES[2]]
    assert not set(CLASS_REPLACED_DIAGNOSTIC_NAMES) & set(all_names), 'old diagnostic semantics not replaced'
    assert len(set(all_names)) == 61 and set(original_names) <= set(all_names), 'class40 plus attribution2 plus owned19 inventory differs'
    assert type(projection['sourceFiles']) is dict and set(projection['sourceFiles']) == set(CLASS_SOURCE_FILES), 'class reviewed source set differs'
    out, install = evidence / 'class-projection', evidence / 'attribute-projection'
    assert all((out / name).is_file() for name in CLASS_CAPTURE_NAMES), 'missing class capture'
    assert all((install / name).is_file() for name in CLASS_SHARED_INSTALL_NAMES), 'missing shared frozen install capture'
    assert (out / 'run.exit').read_text().strip() == (install / 'install.exit').read_text().strip() == '0', 'class run/frozen install failed'
    assert (out / 'raw.log').stat().st_size > 0 and (install / 'install.log').stat().st_size > 0, 'empty class/shared install log'
    command = ['pnpm', '--filter', 'e2e', 'exec', 'vitest', 'run', '--config', '../../' + CLASS_CONFIG_FILE,
               '--reporter=json', '--outputFile=' + str(out / 'raw-result.json')]
    assert json.loads((out / 'command.json').read_text()) == command, 'nonexact class command'
    assert json.loads((install / 'install-command.json').read_text()) == ['pnpm', 'install', '--frozen-lockfile'], 'shared install lock not frozen'
    versions = json.loads((out / 'versions.json').read_text())
    assert type(versions) is dict and set(versions) == {'node', 'pnpm', 'vitest'}
    for key in ['node', 'pnpm', 'vitest']:
        assert type(versions[key]) is str and versions[key] == (out / (key + '-version.txt')).read_text().strip(), 'class raw version differs'
    assert re.fullmatch(r'v24\.\d+\.\d+', versions['node']), 'wrong class Node major'
    assert versions['pnpm'] == projection['pnpmVersion'], 'wrong class pnpm version'
    assert re.match(r'^vitest/' + re.escape(projection['vitestVersion']) + r'\s', versions['vitest']), 'wrong class Vitest version'
    assert versions == json.loads((install / 'versions.json').read_text()), 'class tool versions differ from frozen install'
    raw = json.loads((out / 'raw-result.json').read_text())
    assert raw['success'] is True
    for key in ['numTotalTests', 'numPassedTests']:
        assert type(raw[key]) is int and raw[key] == 61, 'wrong class40 plus attribution2 plus owned19 count'
    for key in ['numFailedTests', 'numPendingTests', 'numTodoTests', 'numFailedTestSuites', 'numPendingTestSuites']:
        assert type(raw[key]) is int and raw[key] == 0, 'class failure/skip/todo'
    assert type(raw['numTotalTestSuites']) is int and raw['numTotalTestSuites'] > 0
    assert type(raw['numPassedTestSuites']) is int and raw['numPassedTestSuites'] == raw['numTotalTestSuites']
    assert raw.get('numRuntimeErrorTestSuites', 0) == 0 and raw.get('unhandledErrors', []) == [] and raw.get('testExecError') is None
    assert type(raw['testResults']) is list and len(raw['testResults']) == 3, 'wrong class result file count'
    expected_paths = {(root / path).resolve(strict=True): path for path in CLASS_TEST_FILES}
    observed_files = []
    for suite in raw['testResults']:
        assert type(suite['name']) is str and Path(suite['name']).is_absolute(), 'class test path not absolute'
        path = Path(suite['name']).resolve()
        assert path in expected_paths and path not in observed_files, 'wrong/duplicate class result file'
        observed_files.append(path)
        assert suite['status'] == 'passed' and suite.get('message', '') == '' and suite.get('testExecError') is None
        assertions = suite['assertionResults']
        assert type(assertions) is list and len(assertions) == len(names_by_file[expected_paths[path]]), 'class per-file count differs'
        assert Counter(row['fullName'] for row in assertions) == Counter(names_by_file[expected_paths[path]]), 'class exact names differ/duplicate'
        assert all(row['status'] == 'passed' and row['failureMessages'] == [] for row in assertions), 'class assertion skipped or failed'
    producer = json.loads((evidence / 'producer.json').read_text())
    assert producer['gate'] == 'fault' and producer['profile'] == 'ci' and producer['features'] == ['acceptance-faults']
    assert producer['nativeCommit'] == pins['commit'] and producer['nativeTree'] == pins['tree']
    for key in ['commit', 'tree']:
        assert type(producer[key]) is str and re.fullmatch('[0-9a-f]{40}', producer[key]) and producer[key] != '0' * 40
    source_hashes = dict(projection['sourceFiles'])
    source_hashes[CLASS_CONFIG_FILE] = projection['configSHA256']
    for group in groups:
        assert group['sourceSHA256'] == source_hashes[group['file']], 'class test/group source pin mismatch'
    for path, expected in source_hashes.items():
        assert type(expected) is str and re.fullmatch('[0-9a-f]{64}', expected), 'invalid reviewed class source hash'
        actual = digest(root / path)
        assert actual == expected == producer['files'][path], 'class source/config bytes differ from reviewed producer source'
    return {'accepted': True, 'producerCommit': producer['commit'], 'producerTree': producer['tree'],
            'nativeCommit': pins['commit'], 'nativeTree': pins['tree'], 'count': 61,
            'originalCount': 40, 'additionalDiagnosticCount': 2, 'ownedDeadlineCount': 19,
            'replacedDiagnosticNames': CLASS_REPLACED_DIAGNOSTIC_NAMES, 'ownedDeadlineNames': CLASS_OWNED_DEADLINE_NAMES,
            'originalNames': original_names, 'additionalDiagnosticNames': diagnostics,
            'files': groups, 'sourceFiles': source_hashes, 'versions': versions,
            'captures': {name: digest(out / name) for name in CLASS_CAPTURE_NAMES},
            'sharedFrozenInstall': {name: digest(install / name) for name in CLASS_SHARED_INSTALL_NAMES},
            'browserAcceptance': False}


def validation_receipt(fn):
    try:
        return fn()
    except Exception as error:
        return {'accepted': False, 'errors': [{'type': type(error).__name__, 'detail': str(error)[:1000]}],
                'browserAcceptance': False}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['prepare', 'source', 'toolchain', 'binary', 'inventory', 'required-controls', 'results', 'exact-results', 'pure-results', 'class-results', 's9-exact-results', 'audit', 'accept'])
    parser.add_argument('--gate', required=True, choices=['default', 'fault', 'boundaries'])
    args = parser.parse_args()
    root = Path(os.environ['GITHUB_WORKSPACE']).resolve()
    evidence = root / os.environ['REGRESSION_EVIDENCE']
    native = root / os.environ['REGRESSION_NATIVE']
    pins = json.loads((HERE / 'pins.json').read_text())
    bound_identity(pins)
    features = ['acceptance-faults'] if args.gate == 'fault' else []
    def dump(name, value):
        with (evidence / name).open('x') as out:
            json.dump(value, out, indent=2)
            out.write('\n')
    def source():
        assert git(native, 'rev-parse', 'HEAD') == pins['commit'], 'native commit changed'
        assert git(native, 'rev-parse', 'HEAD^{tree}') == pins['tree'], 'native tree changed'
        assert not git(native, 'status', '--porcelain'), 'native checkout dirty'
        actual = {f: digest(native / f) for f in pins['files']}
        assert actual == pins['files'], 'native frozen bytes changed'
        return {'commit': pins['commit'], 'tree': pins['tree'], 'files': actual}
    if args.command == 'prepare':
        assert not git(root, 'status', '--porcelain'), 'producer checkout dirty before evidence'
        evidence.mkdir(parents=True, exist_ok=False)
        for name in ['CARGO_TARGET_DIR', 'CARGO_HOME']:
            path = Path(os.environ[name])
            assert path.is_absolute() and not path.exists(), 'build/cache path is not fresh: ' + name
        producer = {'gate': args.gate, 'runId': os.environ['GITHUB_RUN_ID'], 'runAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
                    'commit': git(root, 'rev-parse', 'HEAD'), 'tree': git(root, 'rev-parse', 'HEAD^{tree}'),
                    'nativeCommit': pins['commit'], 'nativeTree': pins['tree'],
                    'files': {p: digest(root / p) for p in pins['producerFiles']},
                    'freshPaths': {k: os.environ[k] for k in ['CARGO_TARGET_DIR', 'CARGO_HOME']},
                    'profile': pins['profile'], 'features': features}
        dump('producer.json', producer)
    elif args.command == 'source':
        dump('source-before.json', source())
    elif args.command == 'toolchain':
        rustc = (evidence / 'rustc-version.txt').read_text()
        cargo = (evidence / 'cargo-version.txt').read_text()
        assert re.search(r'^release: 1\.99\.1$', rustc, re.M), 'wrong compiler release'
        assert re.match(r'cargo 1\.99\.1\b', cargo), 'wrong Cargo release'
        tool_paths = json.loads((evidence / 'toolchain-paths.json').read_text())
        dump('toolchain.json', {'requested': '1.99.1', 'rustcVersionSHA256': digest(evidence / 'rustc-version.txt'),
                               'cargoVersionSHA256': digest(evidence / 'cargo-version.txt'),
                               'binaries': {k: {'path': v, 'sha256': digest(Path(v))} for k, v in tool_paths.items()}})
    elif args.command == 'binary':
        assert (evidence / 'harness-build.exit').read_text().strip() == '0'
        rows = [json.loads(line) for line in (evidence / 'harness.jsonl').read_text().splitlines()]
        assert rows and rows[-1].get('reason') == 'build-finished' and rows[-1].get('success') is True
        assert [r['success'] for r in rows if r.get('reason') == 'build-finished'] == [True]
        candidates = [r for r in rows if r.get('reason') == 'compiler-artifact' and r.get('target', {}).get('name') == 'agent-browser'
                      and r.get('target', {}).get('kind') == ['bin'] and r.get('profile', {}).get('test') is True and r.get('executable')]
        assert len(candidates) == 1, 'missing or ambiguous compiler-selected test binary'
        row = candidates[0]
        assert row['fresh'] is False and row['features'] == features, 'cached/nonexact build'
        assert row['profile']['opt_level'] == '3' and row['profile']['debug_assertions'] is False and row['profile']['overflow_checks'] is False
        target = Path(os.environ['CARGO_TARGET_DIR']).resolve(strict=True)
        binary = Path(row['executable']).resolve(strict=True)
        assert binary.is_relative_to(target) and binary.is_file()
        dump('test-binary.json', {'sha256': digest(binary), 'relativePath': str(binary.relative_to(target)),
                                 'fresh': False, 'features': features, 'profile': row['profile'],
                                 'cargoArtifactsSHA256': digest(evidence / 'harness.jsonl'),
                                 'compilerArgvSHA256': digest(evidence / 'compiler-argv.txt')})
        (evidence / 'harness.path').write_text(str(binary) + '\n')
    elif args.command == 'inventory':
        for name in ['all-tests', 'ignored-tests']:
            assert (evidence / (name + '.exit')).read_text().strip() == '0', 'test collection failed'
        expected = json.loads((HERE / ('inventory-' + args.gate + '.json')).read_text())
        report = inventory((evidence / 'all-tests.list').read_text(), (evidence / 'ignored-tests.list').read_text(), expected)
        report.update({'features': features, 'profile': 'ci', 'sourceDerivedExpected': True,
                       'allListSHA256': digest(evidence / 'all-tests.list'), 'ignoredListSHA256': digest(evidence / 'ignored-tests.list')})
        dump('inventory.json', report)
    elif args.command == 'required-controls':
        report = required_controls_report(evidence, pins, args.gate)
        dump('required-controls.json', report)
        dump('new-native-exact-inventory.json', {'selectors': report['requiredNewTests'], 'count': report['newCount']})
        s9_report = s9_required_controls_report(evidence, pins, args.gate)
        dump('s9-required-controls.json', s9_report)
        dump('s9-native-exact-inventory.json', {'selectors': s9_report['s9RequiredTests'], 'count': s9_report['s9Count']})
    elif args.command == 'exact-results':
        assert args.gate == 'fault', 'same-build exact reruns are fault-only'
        report = validation_receipt(lambda: exact_results_report(evidence, pins, Path(os.environ['CARGO_TARGET_DIR'])))
        dump('new-native-exact-receipt.json', report)
        assert report['accepted'], 'new exact controls lack complete PASS evidence'
    elif args.command == 's9-exact-results':
        assert args.gate == 'fault', 'S9 same-build exact reruns are fault-only'
        report = validation_receipt(lambda: s9_exact_results_report(evidence, pins, Path(os.environ['CARGO_TARGET_DIR'])))
        dump('s9-native-exact-receipt.json', report)
        assert report['accepted'], 'S9 exact controls lack complete PASS evidence'
    elif args.command == 'pure-results':
        assert args.gate == 'fault', 'pure projection controls run once on fault producer'
        report = validation_receipt(lambda: pure_results_report(root, evidence, pins))
        dump('pure-projection-receipt.json', report)
        assert report['accepted'], 'pure projection controls lack complete PASS evidence'
    elif args.command == 'class-results':
        assert args.gate == 'fault', 'class pure controls run once on fault producer'
        report = validation_receipt(lambda: class_results_report(root, evidence, pins))
        dump('class-projection-receipt.json', report)
        assert report['accepted'], 'class pure controls lack complete PASS evidence'
    elif args.command == 'results':
        expected = json.loads((evidence / 'inventory.json').read_text())
        report = results((evidence / 'full-suite.log').read_text(), int((evidence / 'full-suite.exit').read_text()), expected)
        report.update({'nativeCommit': pins['commit'], 'nativeTree': pins['tree'], 'profile': 'ci', 'features': features,
                       'binarySHA256': json.loads((evidence / 'test-binary.json').read_text())['sha256'],
                       **full_suite_capture_metadata(evidence),
                       'browserAcceptance': False})
        dump('result.json', report)
        assert report['accepted'], 'full suite did not produce complete all-PASS evidence'
    elif args.command == 'audit':
        # Never copy the before receipt: collect every available fact independently, even after failures.
        evidence.mkdir(parents=True, exist_ok=True)
        report = {'gate': args.gate, 'errors': [], 'native': {}, 'files': {}, 'producer': {}, 'binary': None,
                  'toolchain': {}, 'captures': {}, 'sourceVerified': False, 'producerVerified': False}
        def attempt(label, fn):
            try:
                return fn()
            except Exception as error:
                report['errors'].append({'check': label, 'type': type(error).__name__, 'detail': str(error)[:1000]})
                return None
        for label, command in [('commit', ['rev-parse', 'HEAD']), ('tree', ['rev-parse', 'HEAD^{tree}']), ('status', ['status', '--porcelain'])]:
            report['native'][label] = attempt('native-' + label, lambda command=command: git(native, *command))
        for path, expected in pins['files'].items():
            actual = attempt('source-' + path, lambda path=path: digest(native / path))
            report['files'][path] = {'expected': expected, 'actual': actual, 'matches': actual == expected}
        report['sourceVerified'] = report['native'] == {'commit': pins['commit'], 'tree': pins['tree'], 'status': ''} and all(v['matches'] for v in report['files'].values())
        def metadata_file(name, schema):
            value = json.loads((evidence / name).read_text())
            assert isinstance(value, dict), 'receipt is not an object: ' + name
            for key, kind in schema.items():
                assert key in value and type(value[key]) is kind, 'receipt field missing/wrong type: ' + name + ':' + key
            return value
        before = attempt('producer-before', lambda: metadata_file('producer.json', {'commit': str, 'tree': str, 'files': dict}))
        for label, command in [('commit', ['rev-parse', 'HEAD']), ('tree', ['rev-parse', 'HEAD^{tree}']), ('trackedDiff', ['diff', 'HEAD', '--name-only'])]:
            report['producer'][label] = attempt('producer-' + label, lambda command=command: git(root, *command))
        report['producer']['files'] = {p: attempt('producer-file-' + p, lambda p=p: digest(root / p)) for p in pins['producerFiles']}
        report['producerVerified'] = before is not None and report['producer']['commit'] == before['commit'] and report['producer']['tree'] == before['tree'] and report['producer']['trackedDiff'] == '' and report['producer']['files'] == before['files']
        if args.gate != 'boundaries':
            metadata = attempt('binary-metadata', lambda: metadata_file('test-binary.json', {'sha256': str, 'relativePath': str}))
            if metadata:
                def current_binary():
                    target = Path(os.environ['CARGO_TARGET_DIR']).resolve()
                    binary = (target / metadata['relativePath']).resolve()
                    assert binary.is_relative_to(target), 'binary path escaped fresh target'
                    return digest(binary)
                actual = attempt('binary-current', current_binary)
                copied = attempt('binary-copy', lambda: digest(root / 'native-harness/agent-browser-tests'))
                report['binary'] = {'expected': metadata['sha256'], 'actual': actual, 'copy': copied, 'matches': actual == copied == metadata['sha256']}
        def toolchain_metadata():
            value = metadata_file('toolchain.json', {'binaries': dict})
            assert value['binaries'], 'empty toolchain metadata'
            for key, binary in value['binaries'].items():
                assert isinstance(key, str) and isinstance(binary, dict)
                assert isinstance(binary.get('path'), str) and isinstance(binary.get('sha256'), str)
            return value
        toolchain = attempt('toolchain-metadata', toolchain_metadata)
        if toolchain:
            for key, value in toolchain['binaries'].items():
                actual = attempt('toolchain-' + key, lambda value=value: digest(Path(value['path'])))
                report['toolchain'][key] = {'expected': value['sha256'], 'actual': actual, 'matches': actual == value['sha256']}
        required = ['producer.json', 'source-before.json', 'toolchain-install.log', 'toolchain-install.exit', 'rustc-version.txt', 'cargo-version.txt', 'toolchain.json', 'compiler-argv.txt']
        required += [p + suffix for p in BOUNDARIES for suffix in ['.log', '.exit']] if args.gate == 'boundaries' else ['harness.jsonl', 'harness-build.log', 'harness-build.exit', 'test-binary.json', 'all-tests.list', 'all-tests.stderr.log', 'all-tests.exit', 'ignored-tests.list', 'ignored-tests.stderr.log', 'ignored-tests.exit', 'inventory.json', 'full-suite.log', 'full-suite.stderr.log', 'full-suite.exit', 'result.json']
        if args.gate != 'boundaries':
            required += ['required-controls.json', 'new-native-exact-inventory.json']
            controls = attempt('required-controls-independent', lambda: required_controls_report(evidence, pins, args.gate))
            saved_controls = attempt('required-controls-receipt', lambda: json.loads((evidence / 'required-controls.json').read_text()))
            report['requiredControlsAccepted'] = bool(controls and controls == saved_controls)
            required += ['s9-required-controls.json', 's9-native-exact-inventory.json']
            s9_controls = attempt('s9-required-controls-independent', lambda: s9_required_controls_report(evidence, pins, args.gate))
            saved_s9_controls = attempt('s9-required-controls-receipt', lambda: json.loads((evidence / 's9-required-controls.json').read_text()))
            saved_s9_selectors = attempt('s9-exact-selectors', lambda: json.loads((evidence / 's9-native-exact-inventory.json').read_text()))
            report['s9RequiredControlsAccepted'] = bool(s9_controls and s9_controls == saved_s9_controls and saved_s9_selectors == {'selectors': s9_controls['s9RequiredTests'], 'count': s9_controls['s9Count']})
            if not report['s9RequiredControlsAccepted']:
                report['errors'].append({'check': 's9-required-controls-match', 'detail': 'S9 required control evidence absent or differs'})
            if not report['requiredControlsAccepted']:
                report['errors'].append({'check': 'required-controls-match', 'detail': 'required control evidence absent or differs'})
        if args.gate == 'fault':
            required += ['new-native-exact.exit', 'new-native-exact.log', 'new-native-exact-receipt.json',
                         'new-native-exact/harness-list.log', 'new-native-exact/results.json', 'pure-projection-receipt.json']
            required += [f'new-native-exact/test-{i:02d}' + suffix for i in range(1, REQUIRED_NEW_COUNT + 1) for suffix in ['.log', '.cleanup.jsonl']]
            required += ['attribute-projection/' + name for name in PURE_CAPTURE_NAMES]
            required += ['class-projection-receipt.json'] + ['class-projection/' + name for name in CLASS_CAPTURE_NAMES]
            exact = attempt('new-exact-independent', lambda: exact_results_report(evidence, pins, Path(os.environ['CARGO_TARGET_DIR'])))
            saved_exact = attempt('new-exact-receipt', lambda: json.loads((evidence / 'new-native-exact-receipt.json').read_text()))
            report['newExactAccepted'] = bool(exact and exact == saved_exact)
            required += ['s9-native-exact.exit', 's9-native-exact.log', 's9-native-exact-receipt.json',
                         's9-native-exact/harness-list.log', 's9-native-exact/results.json']
            required += [f's9-native-exact/test-{i:02d}' + suffix for i in range(1, S9_REQUIRED_COUNT + 1) for suffix in ['.log', '.cleanup.jsonl']]
            s9_exact = attempt('s9-exact-independent', lambda: s9_exact_results_report(evidence, pins, Path(os.environ['CARGO_TARGET_DIR'])))
            saved_s9_exact = attempt('s9-exact-receipt', lambda: json.loads((evidence / 's9-native-exact-receipt.json').read_text()))
            report['s9ExactAccepted'] = bool(s9_exact and s9_exact == saved_s9_exact)
            if not report['s9ExactAccepted']:
                report['errors'].append({'check': 's9-exact-match', 'detail': 'raw S9 exact evidence absent or differs from validated receipt'})
            pure = attempt('pure-projection-independent', lambda: pure_results_report(root, evidence, pins))
            saved_pure = attempt('pure-projection-receipt', lambda: json.loads((evidence / 'pure-projection-receipt.json').read_text()))
            report['pureProjectionAccepted'] = bool(pure and pure == saved_pure)
            class_pure = attempt('class-projection-independent', lambda: class_results_report(root, evidence, pins))
            saved_class = attempt('class-projection-receipt', lambda: json.loads((evidence / 'class-projection-receipt.json').read_text()))
            report['classProjectionAccepted'] = bool(class_pure and class_pure == saved_class)
            for label, accepted in [('new-exact-match', report['newExactAccepted']), ('pure-projection-match', report['pureProjectionAccepted']), ('class-projection-match', report['classProjectionAccepted'])]:
                if not accepted:
                    report['errors'].append({'check': label, 'detail': 'raw evidence absent or differs from validated receipt'})
        for name in required:
            path = evidence / name
            item = {'captureMissing': not path.is_file(), 'bytes': None, 'sha256': None, 'captureLoss': None}
            if path.is_file():
                item['bytes'] = attempt('capture-size-' + name, lambda path=path: path.stat().st_size)
                item['sha256'] = attempt('capture-hash-' + name, lambda path=path: digest(path))
            report['captures'][name] = item
        if args.gate != 'boundaries':
            result = attempt('full-suite-result', lambda: metadata_file('result.json', {'accepted': bool, 'captureLoss': bool}))
            if result:
                attempt('full-suite-stream-custody', lambda: checked_full_suite_capture(evidence, result))
            report['fullSuiteAccepted'] = bool(result and result.get('accepted'))
            report['captures']['full-suite.log']['captureLoss'] = result.get('captureLoss') if result else None
        report['missingCaptures'] = [n for n, v in report['captures'].items() if v['captureMissing']]
        report['captureLossMeaning'] = 'null means not independently establishable; absent/incomplete result never means no loss'
        report['custodyAccepted'] = (report['sourceVerified'] and report['producerVerified'] and not report['errors'] and not report['missingCaptures'] and bool(report['toolchain']) and all(x['matches'] for x in report['toolchain'].values()) and (args.gate == 'boundaries' or bool(report['binary'] and report['binary']['matches'])))
        dump('custody-after.json', report)
        assert report['custodyAccepted'], 'independent custody incomplete or changed'
    elif args.command == 'accept':
        custody = json.loads((evidence / 'custody-after.json').read_text())
        assert custody['custodyAccepted'] is True
        if args.gate != 'boundaries':
            assert custody['requiredControlsAccepted'] is True
            assert custody['s9RequiredControlsAccepted'] is True
        if args.gate == 'fault':
            assert custody['newExactAccepted'] is True and custody['pureProjectionAccepted'] is True
            assert custody['s9ExactAccepted'] is True
            assert json.loads((evidence / 's9-native-exact-receipt.json').read_text())['accepted'] is True
            assert json.loads((evidence / 'new-native-exact-receipt.json').read_text())['accepted'] is True
            assert json.loads((evidence / 'pure-projection-receipt.json').read_text())['accepted'] is True
            assert custody['classProjectionAccepted'] is True
            assert json.loads((evidence / 'class-projection-receipt.json').read_text())['accepted'] is True
        if args.gate == 'boundaries':
            for boundary in BOUNDARIES:
                assert (evidence / (boundary + '.exit')).read_text().strip() == '0'
        else:
            assert json.loads((evidence / 'result.json').read_text())['accepted'] is True
        dump('gate-receipt.json', {'accepted': True, 'gate': args.gate, 'nativeCommit': pins['commit'], 'nativeTree': pins['tree'],
                                 'profile': 'ci', 'features': features, 'browserAcceptance': False,
                                 'custodySHA256': digest(evidence / 'custody-after.json')})

if __name__ == '__main__':
    main()
