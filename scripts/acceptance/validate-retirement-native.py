#!/usr/bin/env python3
"""Validate an exact native source tree with bounded, source-bound commands."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--native-root', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--target-dir', type=Path, required=True)
a = parser.parse_args()
a.native_root = a.native_root.resolve()
a.output.mkdir(parents=True, exist_ok=True)
a.output = a.output.resolve()
target = a.target_dir.resolve()
assert not target.exists() or (target.is_dir() and not any(target.iterdir())), 'target directory must start absent or empty'
target.mkdir(parents=True, exist_ok=True)
expected = '23d4de87258f4635e92abdc5b554d278f5a20f8a'
tests = json.loads(Path(__file__).with_name('retirement-native-exact-tests.json').read_text())
assert len(tests) == len(set(tests)) == 34
env = {**os.environ, 'RUST_MIN_STACK': '16777216', 'CARGO_TARGET_DIR': str(target)}
for key in ['RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS']:
    env.pop(key, None)
sha = lambda data: hashlib.sha256(data).hexdigest()

def git(*args):
    return subprocess.check_output(['git', '-C', str(a.native_root), *args], timeout=30)

def snapshot():
    assert git('write-tree').decode().strip() == expected
    rows = []
    for row in git('ls-files', '-s').decode().splitlines():
        meta, path = row.split('\t', 1)
        mode, oid, stage = meta.split()
        assert stage == '0'
        file = a.native_root / path
        data = os.readlink(file).encode() if mode == '120000' else file.read_bytes()
        assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == oid, path
        rows.append({'path': path, 'sha256': sha(data), 'bytes': len(data)})
    return {'tree': expected, 'files': rows}

before = snapshot()
(a.output / 'source-before.json').write_text(json.dumps(before) + '\n')
phases = []

def run_phase(name, command, timeout, json_stdout=False):
    assert snapshot() == before
    start = time.time()
    stdout_path = a.output / (name + ('.jsonl' if json_stdout else '.log'))
    stderr_path = a.output / (name + '.stderr') if json_stdout else stdout_path
    timed_out = False
    with stdout_path.open('wb') as out:
        err = stderr_path.open('wb') if json_stdout else out
        try:
            process = subprocess.Popen(command, cwd=a.native_root / 'cli', env=env,
                                       stdout=out, stderr=err, start_new_session=True)
            try:
                code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=30)
                code = 124
        finally:
            if json_stdout:
                err.close()
    unchanged = snapshot() == before
    record = {'stage': name, 'command': command, 'timeoutSeconds': timeout,
              'seconds': time.time() - start, 'exit': code, 'timedOut': timed_out,
              'tree': expected, 'sourceBeforeAfterEqual': unchanged,
              'stdout': stdout_path.name, 'stdoutSha256': sha(stdout_path.read_bytes()),
              'stderr': stderr_path.name, 'stderrSha256': sha(stderr_path.read_bytes())}
    phases.append(record)
    (a.output / 'phase-results.json').write_text(json.dumps(phases, indent=2) + '\n')
    print(name, code, flush=True)
    assert unchanged
    return code, stdout_path

code, version = run_phase('rust-version', ['rustc', '--version', '--verbose'], 30)
assert code == 0 and version.read_text().startswith('rustc 1.99.1 ')
assert run_phase('node-version', ['node', '--version'], 30)[0] == 0
common = ['--locked', '--profile', 'ci', '--no-default-features']
strict = [
    ('format', ['cargo', 'fmt', '--', '--check'], 180),
    ('default-clippy', ['cargo', 'clippy', *common, '--all-targets', '--', '-D', 'warnings'], 1200),
    ('faults-check', ['cargo', 'check', *common, '--features', 'acceptance-faults', '--tests'], 600),
    ('proxy-check', ['cargo', 'check', *common, '--features', 'acceptance-faults', '--test', 'client-proxy-fixture'], 600),
]
strict_codes = [run_phase(name, command, limit)[0] for name, command, limit in strict]
assert all(code == 0 for code in strict_codes), 'current source strict boundary failed'
command = ['cargo', 'test', '--locked', '-j', '2', '--profile', 'ci', '--no-default-features',
           '--bin', 'agent-browser', '--no-run', '--message-format=json']
code, compilation = run_phase('compile', command, 1800, json_stdout=True)
assert code == 0, 'new-tree compilation failed; do not reuse an old harness'
artifacts = []
for line in compilation.read_text().splitlines():
    try:
        row = json.loads(line)
    except ValueError:
        continue
    if (row.get('reason') == 'compiler-artifact' and row.get('target', {}).get('name') == 'agent-browser'
            and row.get('profile', {}).get('test') and row.get('executable')):
        artifacts.append(row['executable'])
assert len(set(artifacts)) == 1, artifacts
binary = Path(artifacts[-1]).resolve()
assert binary.is_relative_to(target)
digest = sha(binary.read_bytes())
code, listing = run_phase('test-list', [str(binary), '--list'], 60)
assert code == 0
available = {line[:-6] for line in listing.read_text().splitlines() if line.endswith(': test')}
assert all(test in available for test in tests)
receipts = []
for index, test in enumerate(tests):
    assert sha(binary.read_bytes()) == digest
    command = [str(binary), test, '--exact', '--nocapture', '--test-threads=1']
    code, log = run_phase(f'exact-{index:02}', command, 90)
    assert code == 0 and '1 passed; 0 failed; 0 ignored' in log.read_text(), (test, code)
    assert sha(binary.read_bytes()) == digest
    receipts.append({'test': test, 'exit': code, 'tree': expected, 'harnessSha256': digest,
                     'log': log.name, 'logSha256': sha(log.read_bytes())})
    (a.output / 'receipts.json').write_text(json.dumps(receipts, indent=2) + '\n')
code, detach = run_phase('detach-controls', ['node', '--test', '--test-reporter=tap',
    str(a.native_root / 'cli/tests/fixtures/native-action-detach-witness.test.cjs')], 60)
tap = detach.read_text()
assert code == 0
for field, count in [('tests', 8), ('pass', 8), ('fail', 0), ('cancelled', 0), ('skipped', 0), ('todo', 0)]:
    assert re.search(r'^# ' + field + r' ' + str(count) + r'\s*$', tap, re.MULTILINE), (field, tap)
after = snapshot()
assert after == before
(a.output / 'source-after.json').write_text(json.dumps(after) + '\n')
print('All4strict,34exact native and8pure controls passed on', expected)
