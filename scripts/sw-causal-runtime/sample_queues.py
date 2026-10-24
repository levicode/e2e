"""One bounded metadata-only snapshot of two already-proven owned processes."""
import hashlib
import ipaddress
import json
import os
import re
import stat
import sys
import time
from pathlib import Path


class Unknown(Exception):
    pass


def endpoint(text, family):
    address, port = text.split(':')
    if not re.fullmatch(r'[0-9A-Fa-f]{4}', port):
        raise Unknown('invalid-endpoint')
    raw = bytes.fromhex(address)
    if len(raw) != (4 if family == 4 else 16):
        raise Unknown('invalid-address-size')
    raw = raw[::-1] if family == 4 else b''.join(raw[i:i + 4][::-1] for i in range(0, 16, 4))
    value = ipaddress.ip_address(raw)
    if isinstance(value, ipaddress.IPv6Address) and value.ipv4_mapped:
        value = value.ipv4_mapped
    return (str(value), int(port, 16))


def parse_row(line, family):
    f = line.split()
    if len(f) < 10 or not f[0].endswith(':') or not f[9].isdigit():
        raise Unknown('malformed-tcp-row')
    queue = f[4].split(':')
    if len(queue) != 2 or not all(re.fullmatch(r'[0-9A-Fa-f]{8}', q) for q in queue):
        raise Unknown('invalid-queue')
    return {'table': 'tcp' if family == 4 else 'tcp6', 'local': endpoint(f[1], family),
            'remote': endpoint(f[2], family), 'state': int(f[3], 16), 'uid': int(f[7]),
            'inode': int(f[9]), 'txBytes': int(queue[0], 16), 'rxBytes': int(queue[1], 16)}


def loopback(pair):
    return ipaddress.ip_address(pair[0]).is_loopback


def choose(rows, native_fds, chrome_fds, port, uid):
    matches = []
    for native in rows:
        if native['inode'] not in native_fds or native['uid'] != uid or native['state'] != 1:
            continue
        if native['remote'][1] != port or not loopback(native['local']) or not loopback(native['remote']):
            continue
        for peer in rows:
            if peer['inode'] not in chrome_fds or peer['uid'] != uid or peer['state'] != 1:
                continue
            if native['local'] != peer['remote'] or native['remote'] != peer['local']:
                continue
            for listener in rows:
                if (listener['inode'] in chrome_fds and listener['uid'] == uid and listener['state'] == 10
                        and listener['local'] == peer['local'] and loopback(listener['local'])):
                    matches.append((native, peer, listener))
    unique = {(a['inode'], b['inode'], c['inode']): (a, b, c) for a, b, c in matches}
    if len(unique) != 1:
        raise Unknown('no-unique-owned-listener-and-reverse-tuple')
    return next(iter(unique.values()))


def owner(expected, uid):
    pid = expected['pid']
    if not isinstance(pid, int) or pid <= 1:
        raise Unknown('invalid-owned-pid')
    path = Path('/proc', str(pid))
    raw = (path / 'stat').read_text()
    f = raw[raw.rfind(')') + 2:].split()
    if f[19] != expected['startTicks'] or f[0] in ['Z', 'X'] or path.stat().st_uid != uid:
        raise Unknown('owned-process-identity-changed')
    exe = os.readlink(path / 'exe')
    argv = (path / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
    if exe != expected['executable'] or argv != [x.encode() for x in expected['argv']]:
        raise Unknown('owned-process-executable-or-argv-changed')
    image = (path / 'exe').stat()
    image_id = {'dev': str(image.st_dev), 'ino': str(image.st_ino), 'bytes': str(image.st_size)}
    if image_id != expected['executableFileIdentity']:
        raise Unknown('owned-executable-file-identity-changed')
    return {'pid': pid, 'startTicks': f[19], 'uid': uid, 'exe': exe, 'argv': expected['argv'],
            'namespace': os.readlink(path / 'ns/net'), 'executableFileIdentity': image_id}


def socket_fds(pid):
    found = {}
    for path in Path('/proc', str(pid), 'fd').iterdir():
        try:
            target = os.readlink(path)
        except FileNotFoundError:
            continue
        match = re.fullmatch(r'socket:\[(\d+)\]', target)
        if match:
            found.setdefault(int(match[1]), []).append(int(path.name))
    return {k: sorted(v) for k, v in found.items()}


def port_file(profile):
    directory = Path(profile)
    s = directory.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid():
        raise Unknown('unowned-profile')
    fd = os.open(directory / 'DevToolsActivePort', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or not 1 <= before.st_size <= 512:
            raise Unknown('unowned-devtools-port-file')
        raw = os.read(fd, 513)
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise Unknown('devtools-port-file-changed')
        lines = raw.decode('ascii').splitlines()
        if len(lines) != 2 or not lines[0].isdigit() or not 0 < int(lines[0]) <= 65535 or not re.fullmatch(r'/devtools/browser/[A-Za-z0-9-]+', lines[1]):
            raise Unknown('devtools-port-file-invalid')
        return {'port': int(lines[0]), 'dev': before.st_dev, 'ino': before.st_ino,
                'bytes': before.st_size, 'mtimeNs': before.st_mtime_ns}
    finally:
        os.close(fd)


def sample(expected):
    started = time.monotonic_ns() // 1000
    result = {'schemaVersion': 1, 'startedMonotonicUs': started, 'status': 'unknown',
              'applicationBytesRead': 0, 'CDPConnectionsOpened': 0, 'commandCorrelation': 'unproven',
              'snapshotAtomic': False}
    try:
        uid = os.getuid()
        native = owner(expected['native'], uid)
        chrome = owner(expected['chrome'], uid)
        if native['namespace'] != chrome['namespace'] or native['namespace'] != os.readlink('/proc/self/ns/net'):
            raise Unknown('network-namespace-mismatch')
        port = port_file(expected['profile'])
        native_fds = socket_fds(native['pid'])
        chrome_fds = socket_fds(chrome['pid'])
        inodes = set(native_fds) | set(chrome_fds)
        rows = []
        table_started = time.monotonic_ns() // 1000
        for name, family in [('tcp', 4), ('tcp6', 6)]:
            for line in Path('/proc/net', name).read_text().splitlines()[1:]:
                fields = line.split()
                # Do not decode or retain unrelated endpoints.
                if len(fields) >= 10 and fields[9].isdigit() and int(fields[9]) in inodes:
                    rows.append(parse_row(line, family))
        table_finished = time.monotonic_ns() // 1000
        a, b, listener = choose(rows, native_fds, chrome_fds, port['port'], uid)
        if owner(expected['native'], uid) != native or owner(expected['chrome'], uid) != chrome or port_file(expected['profile']) != port:
            raise Unknown('process-or-port-identity-changed-during-read')
        native_after = socket_fds(native['pid'])
        chrome_after = socket_fds(chrome['pid'])
        for inode, before, after in [(a['inode'], native_fds, native_after),
                                     (b['inode'], chrome_fds, chrome_after),
                                     (listener['inode'], chrome_fds, chrome_after)]:
            if before.get(inode) != after.get(inode) or not before.get(inode):
                raise Unknown('selected-fd-inode-binding-changed')
        result.update({'status': 'mapped', 'nativeIdentity': native, 'chromeIdentity': chrome,
                       'ownedDevToolsPortFile': port, 'listener': {**listener, 'fds': chrome_fds[listener['inode']]},
                       'nativeSocket': {**a, 'fds': native_fds[a['inode']]},
                       'chromeAcceptedSocket': {**b, 'fds': chrome_fds[b['inode']]},
                       'tcpTablesReadStartedUs': table_started, 'tcpTablesReadFinishedUs': table_finished,
                       'identityAndSelectedFdLinksStableBeforeAfter': True, 'uniqueConnectionPair': True})
    except Unknown as e:
        result['reason'] = str(e)
    except OSError as e:
        result.update({'reason': 'owned-proc-or-port-file-unreadable', 'errno': e.errno})
    except (ValueError, KeyError, IndexError, UnicodeError):
        result['reason'] = 'invalid-owned-metadata'
    result['finishedMonotonicUs'] = time.monotonic_ns() // 1000
    return result


if __name__ == '__main__':
    try:
        value = json.loads(sys.stdin.read())
        result = sample(value)
        if len(sys.argv) > 1:
            if len(sys.argv) != 3 or sys.argv[1] != '--selftest-fault' or not value.get('syntheticFixture') or not all(any('fixture_child.py' in part for part in value[key]['argv']) for key in ['native','chrome']):
                raise ValueError('synthetic fault guard')
            if sys.argv[2] == 'invalid-json':
                print('controlled invalid json')
                sys.exit(0)
            if sys.argv[2] == 'timeout':
                time.sleep(5)
            else:
                raise ValueError('unknown synthetic fault')
        print(json.dumps(result, separators=(',', ':')))
    except Exception:
        print(json.dumps({'schemaVersion': 1, 'status': 'unknown', 'reason': 'invalid-observer-input'}))
