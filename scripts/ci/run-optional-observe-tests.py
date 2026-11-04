"""Focused same-build harness receipts, not the full default/feature acceptance gate."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

harness = Path(sys.argv[1]).resolve(strict=True)
inventory = json.loads(Path(sys.argv[2]).read_text())
out = Path(sys.argv[3]).resolve()
out.mkdir(parents=True, exist_ok=True)
cwd = Path(os.environ['GITHUB_WORKSPACE']) / 'native' / 'cli'
assert (cwd / 'Cargo.toml').is_file()
names = inventory['selectors']
assert len(names) == inventory['count'] == len(set(names))
env = {key: value for key, value in os.environ.items() if key not in {'GH_TOKEN', 'GITHUB_TOKEN'}}
listing = subprocess.run([str(harness), '--list'], env=env, cwd=cwd, capture_output=True, text=True, timeout=30)
(out / 'harness-list.log').write_text(listing.stdout + listing.stderr)
assert listing.returncode == 0
actual = {line.removesuffix(': test') for line in listing.stdout.splitlines() if line.endswith(': test')}
assert set(names) <= actual, sorted(set(names) - actual)
rows = []
for i, name in enumerate(names, 1):
    cleanup = out / f'test-{i:02d}.cleanup.jsonl'
    fd = os.open(cleanup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    command = [str(harness), '--exact', name, '--nocapture', '--test-threads=1']
    timed_out = False
    try:
        result = subprocess.run(command, env=env | {'AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE': str(cleanup)}, cwd=cwd, capture_output=True, text=True, timeout=180)
        log, code = result.stdout + result.stderr, result.returncode
    except subprocess.TimeoutExpired as error:
        timed_out = True
        log = (error.stdout or b'').decode(errors='replace') + (error.stderr or b'').decode(errors='replace')
        code = 124
    (out / f'test-{i:02d}.log').write_text(log)
    counts = re.findall(r'test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;', log)
    passed = code == 0 and counts == [('1', '0', '0')]
    row = {'name': name, 'command': command, 'exit': code, 'timedOut': timed_out, 'counts': counts, 'passed': passed, 'logSha256': hashlib.sha256(log.encode()).hexdigest()}
    rows.append(row)
    (out / 'results.json').write_text(json.dumps({'harnessSha256': hashlib.sha256(harness.read_bytes()).hexdigest(), 'features': ['acceptance-faults'], 'notFullAcceptance': True, 'expected': len(names), 'results': rows}, indent=2) + '\n')
    print(json.dumps(row), flush=True)
sys.exit(0 if all(row['passed'] for row in rows) else 1)
