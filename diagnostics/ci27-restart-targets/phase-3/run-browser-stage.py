#!/usr/bin/env python3
"""Observe only this stage's descendants; preserve the existing stage runner."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root = Path(__file__).resolve().parent
stage = sys.argv[1]
execution_status = {}
for line in Path('/proc/self/status').read_text().splitlines():
    name, _, value = line.partition(':')
    if name in ('Uid', 'NoNewPrivs', 'Seccomp'):
        execution_status[name] = value.strip()
helper = Path('/usr/lib/chromium/chrome-sandbox').stat()
with Path('/usr/lib/chromium/chromium').open('rb') as executable:
    elf_sha256 = hashlib.file_digest(executable, 'sha256').hexdigest()
context = {
    'temporaryLocalSyntheticAuthorization': True,
    'executionContext': 'exec_command require_escalated',
    'uid': os.getuid(),
    'executionStatus': execution_status,
    'chromiumSuidHelperBefore': {'uid': helper.st_uid, 'gid': helper.st_gid, 'mode': oct(helper.st_mode & 0o7777)},
    'chromiumElfSha256': elf_sha256,
    'ciEnvironment': {key: os.environ.get(key) for key in ('CI', 'GITHUB_ACTIONS', 'CONTINUOUS_INTEGRATION')},
    'chromiumExecutable': os.environ.get('E2E_CHROMIUM_EXECUTABLE'),
    'playwrightBrowsersPath': os.environ.get('PLAYWRIGHT_BROWSERS_PATH'),
    'chromiumVersion': subprocess.check_output(['/usr/bin/chromium', '--version'], text=True).strip(),
    'noOsSuidNamespaceChanges': True,
}
command = [sys.executable, str(root / 'run-stage.py'), *sys.argv[1:]]
process = subprocess.Popen(command)
known = {process.pid}
observed = {}
while True:
    entries = {}
    for item in Path('/proc').iterdir():
        if not item.name.isdecimal():
            continue
        try:
            fields = (item / 'stat').read_text().rsplit(')', 1)[1].split()
            entries[int(item.name)] = (int(fields[1]), item, fields[19])
        except (OSError, ValueError, IndexError):
            pass
    for _ in range(8):
        before = len(known)
        known.update(pid for pid, (parent, _, _) in entries.items() if parent in known)
        if len(known) == before:
            break
    for pid in known & entries.keys():
        _, item, start = entries[pid]
        key = f'{pid}:{start}'
        if key in observed:
            continue
        try:
            argv = (item / 'cmdline').read_bytes().decode().rstrip('\0').split('\0')
            if not argv or argv[0] not in ('/usr/lib/chromium/chromium', '/usr/bin/chromium'):
                continue
            status = {}
            for line in (item / 'status').read_text().splitlines():
                name, _, value = line.partition(':')
                if name in ('Uid', 'NoNewPrivs', 'Seccomp'):
                    status[name] = value.strip()
            observed[key] = {
                'pid': pid, 'argv': argv, 'status': status,
                'hasNoSandbox': '--no-sandbox' in argv,
                'browserRoot': not any(arg.startswith('--type=') for arg in argv),
            }
        except (OSError, UnicodeError):
            pass
    if process.poll() is not None:
        break
    time.sleep(0.025)
context['processes'] = list(observed.values())
context['browserArgvObserved'] = any(item['browserRoot'] for item in observed.values())
helper = Path('/usr/lib/chromium/chrome-sandbox').stat()
context['chromiumSuidHelperAfter'] = {'uid': helper.st_uid, 'gid': helper.st_gid, 'mode': oct(helper.st_mode & 0o7777)}
(root / f'{stage}.browser-context.json').write_text(json.dumps(context, indent=2) + '\n')
sys.exit(process.wait())
