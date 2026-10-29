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

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['prepare', 'source', 'toolchain', 'binary', 'inventory', 'results', 'audit', 'accept'])
    parser.add_argument('--gate', required=True, choices=['default', 'fault', 'boundaries'])
    args = parser.parse_args()
    root = Path(os.environ['GITHUB_WORKSPACE']).resolve()
    evidence = root / os.environ['REGRESSION_EVIDENCE']
    native = root / os.environ['REGRESSION_NATIVE']
    pins = json.loads((HERE / 'pins.json').read_text())
    assert pins['toolchain'] == '1.99.1' and pins['profile'] == 'ci'
    assert re.fullmatch('[0-9a-f]{40}', pins['commit']) and pins['commit'] != '0' * 40
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
    elif args.command == 'results':
        expected = json.loads((evidence / 'inventory.json').read_text())
        report = results((evidence / 'full-suite.log').read_text(), int((evidence / 'full-suite.exit').read_text()), expected)
        report.update({'nativeCommit': pins['commit'], 'nativeTree': pins['tree'], 'profile': 'ci', 'features': features,
                       'binarySHA256': json.loads((evidence / 'test-binary.json').read_text())['sha256'],
                       'logSHA256': digest(evidence / 'full-suite.log'), 'logBytes': (evidence / 'full-suite.log').stat().st_size,
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
        required += [p + suffix for p in BOUNDARIES for suffix in ['.log', '.exit']] if args.gate == 'boundaries' else ['harness.jsonl', 'harness-build.log', 'harness-build.exit', 'test-binary.json', 'all-tests.list', 'all-tests.stderr.log', 'all-tests.exit', 'ignored-tests.list', 'ignored-tests.stderr.log', 'ignored-tests.exit', 'inventory.json', 'full-suite.log', 'full-suite.exit', 'result.json']
        for name in required:
            path = evidence / name
            item = {'captureMissing': not path.is_file(), 'bytes': None, 'sha256': None, 'captureLoss': None}
            if path.is_file():
                item['bytes'] = attempt('capture-size-' + name, lambda path=path: path.stat().st_size)
                item['sha256'] = attempt('capture-hash-' + name, lambda path=path: digest(path))
            report['captures'][name] = item
        if args.gate != 'boundaries':
            result = attempt('full-suite-result', lambda: metadata_file('result.json', {'accepted': bool, 'captureLoss': bool}))
            report['fullSuiteAccepted'] = bool(result and result.get('accepted'))
            report['captures']['full-suite.log']['captureLoss'] = result.get('captureLoss') if result else None
        report['missingCaptures'] = [n for n, v in report['captures'].items() if v['captureMissing']]
        report['captureLossMeaning'] = 'null means not independently establishable; absent/incomplete result never means no loss'
        report['custodyAccepted'] = (report['sourceVerified'] and report['producerVerified'] and not report['errors'] and not report['missingCaptures'] and bool(report['toolchain']) and all(x['matches'] for x in report['toolchain'].values()) and (args.gate == 'boundaries' or bool(report['binary'] and report['binary']['matches'])))
        dump('custody-after.json', report)
        assert report['custodyAccepted'], 'independent custody incomplete or changed'
    elif args.command == 'accept':
        assert json.loads((evidence / 'custody-after.json').read_text())['custodyAccepted'] is True
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
