#!/usr/bin/env python3
"""Acceptance-only owned encoder witness. No global process scan or product hooks."""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import time

LIMIT = 65536
IDENTITY = ('pid', 'ppid', 'uid', 'start', 'group', 'session', 'exe')


STOP_REQUESTED = False
OWNED_CHILDREN = set()
WINDOW_NONCE = None


def request_stop(_signal, _frame):
    # Do not raise inside Popen before its handle can be registered.
    global STOP_REQUESTED
    STOP_REQUESTED = True


def check_stop():
    require(not STOP_REQUESTED, 'observer-stopped')


def spawn_probe(argv):
    check_stop()
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    OWNED_CHILDREN.add(child)
    return child


def retire_probe(child):
    # Only a handle created by this sampler. No PID/group/system sweep.
    if child.poll() is None:
        try:
            child.kill()
        except ProcessLookupError:
            pass
    try:
        child.wait(timeout=.5)
    finally:
        if child.poll() is not None:
            OWNED_CHILDREN.discard(child)
        if child.stdout:
            child.stdout.close()


def write_exit(window):
    atomic_json(window / 'exit.json', dict(schemaVersion=1, nonce=WINDOW_NONCE,
                stopRequested=STOP_REQUESTED, ownedChildrenReaped=not OWNED_CHILDREN))


def require(value, reason):
    if not value:
        raise ValueError(reason)


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(LIMIT), b''):
            h.update(chunk)
    return h.hexdigest()


def read_json(path):
    data = Path(path).read_bytes()
    require(len(data) <= LIMIT, 'marker-too-large')
    return json.loads(data)


def atomic_json(path, value):
    tmp = Path(str(path) + '.tmp')
    tmp.write_text(json.dumps(value, sort_keys=True))
    tmp.replace(path)


def same(a, b):
    require(all(a.get(k) == b.get(k) for k in IDENTITY), 'process-identity-changed')


def linux_snapshot(pid):
    root = Path('/proc') / str(pid)
    raw = (root / 'stat').read_text()
    rest = raw[raw.rindex(')') + 2:].split()
    uid = next(line.split()[1] for line in (root / 'status').read_text().splitlines() if line.startswith('Uid:'))
    return dict(pid=int(pid), ppid=int(rest[1]), uid=int(uid), group=int(rest[2]), session=int(rest[3]),
                start=rest[19], state=rest[0], exe=os.path.realpath(root / 'exe'))


def linux_children(parent):
    before = linux_snapshot(parent['pid']); same(parent, before)
    children = set()
    for thread in (Path('/proc') / str(parent['pid']) / 'task').iterdir():
        try:
            children.update(int(p) for p in (thread / 'children').read_text().split())
        except FileNotFoundError:
            # Threads may retire; parent identity must remain unchanged.
            continue
    same(parent, linux_snapshot(parent['pid']))
    require(len(children) <= 1024, 'child-list-overflow')
    result = []
    for pid in sorted(children):
        try:
            child = linux_snapshot(pid)
        except FileNotFoundError:
            continue
        require(child['ppid'] == parent['pid'] and child['uid'] == parent['uid'], 'child-owner-mismatch')
        result.append(child)
    return result


def parse_argv(raw):
    require(raw and len(raw) <= LIMIT and raw.endswith(b'\0'), 'argv-truncated')
    parts = raw[:-1].split(b'\0')
    require(1 <= len(parts) <= 64 and all(0 < len(p) <= 4096 for p in parts), 'argv-shape')
    return [p.decode('utf-8', errors='strict') for p in parts]


def encoding(argv):
    """Closed argv grammar matching the reviewed WebM encoder constructor."""
    require(isinstance(argv, list) and 1 <= len(argv) <= 64, 'argv-shape')
    if argv[1:] == ['-version']:
        return None
    require(len(argv) in (38, 40), 'encoding-argc')
    prefix = ['-y', '-hide_banner', '-loglevel', 'error', '-fpsprobesize', '0', '-probesize', '32', '-analyzeduration', '0', '-f', 'image2pipe', '-c:v']
    require(argv[1:14] == prefix, 'encoding-prefix')
    require(argv[14] in ('ppm', 'mjpeg', 'png'), 'input-codec')
    require(argv[15] == '-framerate' and re.fullmatch(r'[1-9][0-9]*(?:\.[0-9]+)?', argv[16]), 'framerate')
    require(argv[17:20] == ['-i', 'pipe:0', '-vf'], 'encoding-input')
    require(re.fullmatch(r'(?:pad=ceil\(iw/2\)\*2:ceil\(ih/2\)\*2|scale=[1-9][0-9]*:[1-9][0-9]*:force_original_aspect_ratio=decrease,pad=ceil\([1-9][0-9]*/2\)\*2:ceil\([1-9][0-9]*/2\)\*2:0:0)', argv[20]), 'filter')
    require(argv[21:28] == ['-fps_mode', 'vfr', '-c:v', 'libvpx', '-crf', '18', '-b:v'], 'webm-codec')
    require(argv[28] == '8000k', 'webm-bitrate')
    require(argv[29:33] == ['-deadline', 'realtime', '-cpu-used', '4'], 'webm-policy')
    tail = argv[33:]
    if tail[:1] == ['-fs']:
        require(len(tail) >= 2 and re.fullmatch(r'[1-9][0-9]*', tail[1]), 'output-limit')
        tail = tail[2:]
    require(len(tail) == 5 and tail[:3] == ['-pix_fmt', 'yuv420p', '-threads'] and tail[3] in ('1', '4'), 'encoder-tail')
    output = tail[4]
    require(os.path.isabs(output) and re.fullmatch(r'.*/agent-browser-action-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/video\.webm', output), 'private-output')
    return output


def validate_chain(fixture, proxy, daemon, native):
    require(proxy['ppid'] == fixture['pid'] and daemon['ppid'] == proxy['pid'], 'native-chain')
    require(len({fixture['pid'], proxy['pid'], daemon['pid']}) == 3, 'pid-alias')
    for child in (proxy, daemon):
        require(child['uid'] == fixture['uid'] and child['exe'] == native, 'native-owner-executable')


def select_native(children, native):
    selected = [c for c in children if c['exe'] == native]
    require(len(selected) == 1, 'native-child-ambiguous')
    return selected[0]


class Observer:
    def __init__(self, binding, fixture):
        self.binding = binding
        self.fixture_pid = fixture
        self.native = os.path.realpath(binding['nativeExecutable'])
        candidate = shutil.which('ffmpeg')
        require(candidate, 'ffmpeg-not-on-path')
        self.encoder = os.path.realpath(candidate)
        self.encoder_hash = digest(self.encoder)
        require(digest(self.native) == binding['nativeSha256'], 'native-hash')
        self.mac = sys.platform == 'darwin'
        require(sys.platform in ('linux', 'darwin'), 'unsupported-platform')

    def mac_frame(self, tracked=None):
        helper = Path(__file__).with_name('installed-encoder-proc')
        require(digest(helper) == self.binding['helperSha256'], 'helper-hash')
        args = [str(helper), str(self.fixture_pid), self.native, self.encoder]
        if tracked: args.extend([str(tracked['pid']), tracked['start']])
        child = spawn_probe(args)
        deadline = time.monotonic() + 2
        try:
            while True:
                check_stop()
                remaining = deadline - time.monotonic()
                require(remaining > 0, 'mac-owned-snapshot-timeout')
                try:
                    output, _ = child.communicate(timeout=min(.1, remaining))
                    break
                except subprocess.TimeoutExpired:
                    continue
            check_stop()
            require(child.returncode == 0 and len(output) <= LIMIT, 'mac-owned-snapshot-failed')
            return json.loads(output)
        finally:
            retire_probe(child)

    def frame(self, tracked=None):
        check_stop()
        if self.mac:
            frame = self.mac_frame(tracked)
        else:
            fixture = linux_snapshot(self.fixture_pid)
            require(os.getppid() == fixture['pid'] and fixture['uid'] == os.getuid(), 'fixture-parent')
            proxy = select_native(linux_children(fixture), self.native)
            daemon = select_native(linux_children(proxy), self.native)
            encoders = []
            for child in linux_children(daemon):
                if child['exe'] != self.encoder:
                    continue
                before = linux_snapshot(child['pid']); same(child, before)
                with (Path('/proc') / str(child['pid']) / 'cmdline').open('rb') as stream:
                    argv = parse_argv(stream.read(LIMIT + 1))
                same(before, linux_snapshot(child['pid']))
                argv[0] = self.encoder
                child['argv'] = argv
                encoders.append(child)
            frame = dict(fixture=fixture, proxy=proxy, daemon=daemon, encoders=encoders)
            if tracked:
                try:
                    actual = linux_snapshot(tracked['pid']); same(tracked, actual)
                    frame['tracked'] = 'zombie' if actual['state'] == 'Z' else 'live'
                except FileNotFoundError:
                    require(not (Path('/proc') / str(tracked['pid'])).exists(), 'tracked-process-unreadable')
                    frame['tracked'] = 'gone'
        validate_chain(frame['fixture'], frame['proxy'], frame['daemon'], self.native)
        require(frame['fixture']['pid'] == self.fixture_pid and frame['fixture']['uid'] == os.getuid(), 'fixture-owner')
        for child in frame['encoders']:
            require(child['ppid'] == frame['daemon']['pid'] and child['uid'] == frame['fixture']['uid'] and child['exe'] == self.encoder, 'encoder-owner')
        return frame


def record_sample(seen, frame, encoder, now):
    for child in frame['encoders']:
        output = encoding(child['argv'])
        if output is None:
            continue
        require(child['exe'] == encoder, 'encoder-executable')
        parent = Path(output).parent
        # Observe metadata only. Never read native's private output.
        require(parent.is_dir() and not parent.is_symlink() and Path(os.path.realpath(parent)).name == parent.name, 'output-parent-symlink')
        require(parent.stat().st_uid == child['uid'], 'output-owner')
        if Path(output).exists():
            require(not Path(output).is_symlink() and Path(os.path.realpath(output)).parent == Path(os.path.realpath(parent)), 'output-symlink')
        key = (child['pid'], child['start'])
        if seen:
            require(key in seen, 'multiple-encoders')
            same(next(iter(seen.values()))['process'], child)
            require(next(iter(seen.values()))['argv'] == child['argv'], 'encoder-argv-changed')
        else:
            seen[key] = dict(process={k: child[k] for k in IDENTITY}, argv=child['argv'], privateOutput=output,
                             firstObserved=now, lastObserved=now)
        seen[key]['lastObserved'] = now


def version_of(executable, expected_hash):
    require(digest(executable) == expected_hash, 'encoder-mutated-before-version')
    # File output is bounded by reader; a verbose/hung probe is killed and rejected.
    proc = spawn_probe([executable, '-version'])
    try:
        check_stop()
        import selectors
        sel = selectors.DefaultSelector(); sel.register(proc.stdout, selectors.EVENT_READ)
        chunks = bytearray(); deadline = time.monotonic() + 3
        while True:
            check_stop()
            require(time.monotonic() < deadline, 'version-timeout')
            ready = sel.select(min(.1, max(0, deadline - time.monotonic())))
            if not ready:
                continue
            piece = os.read(proc.stdout.fileno(), 4096)
            if not piece:
                break
            chunks.extend(piece); require(len(chunks) <= 16384, 'version-too-large')
        # EOF does not prove process retirement. Preserve the original deadline
        # and keep cooperative stop responsive while the owned child is live.
        while True:
            check_stop()
            remaining = deadline - time.monotonic()
            require(remaining > 0, 'version-timeout')
            try:
                returncode = proc.wait(timeout=min(.1, remaining))
                break
            except subprocess.TimeoutExpired:
                continue
        check_stop()
        require(returncode == 0, 'version-failed')
        line = chunks.decode('utf-8', errors='strict').splitlines()[0]
        require(line.startswith('ffmpeg version ') and len(line) <= 1024, 'version-format')
        require(digest(executable) == expected_hash, 'encoder-mutated-after-version')
        return dict(executable=executable, argv=['-version'], firstLine=line, sha256=expected_hash)
    finally:
        if 'sel' in locals(): sel.close()
        retire_probe(proc)


def run(binding_path, window):
    global WINDOW_NONCE
    check_stop()
    binding = read_json(binding_path); arm = read_json(window / 'arm.json')
    WINDOW_NONCE = arm['nonce']
    require(set(binding['observerSources']) == {'installed-encoder-proof.py', 'installed-encoder-proc.c'}, 'observer-sources')
    for name, expected in binding['observerSources'].items():
        require(digest(Path(__file__).with_name(name)) == expected, 'observer-source-hash')
    arch = {'x86_64': 'x64', 'arm64': 'arm64', 'aarch64': 'arm64'}.get(os.uname().machine)
    require(binding['platform'] == sys.platform and binding['arch'] == arch, 'platform-binding')
    require(arm['nonce'] == binding['nonce'] and arm['fixturePid'] == os.getppid(), 'arm-binding')
    require(arm['segmentPath'] == 'video/video.webm', 'segment-path')
    require(isinstance(arm['deadlineUnixMs'], int) and 0 < arm['deadlineUnixMs'] - time.time() * 1000 <= 120000, 'deadline')
    observer = Observer(binding, arm['fixturePid'])
    first = observer.frame()
    for layer in ('proxy', 'daemon'): first[layer]['exeSha256'] = binding['nativeSha256']
    require(not first['encoders'], 'encoder-before-arm')
    require(arm['armed'] <= int(time.time() * 1000) <= arm['deadlineUnixMs'], 'arm-time')
    ready = int(time.time() * 1000)
    atomic_json(window / 'ready.json', dict(nonce=arm['nonce'], ready=ready))
    seen = {}
    while not (window / 'finished.json').exists():
        check_stop()
        require(time.time() * 1000 < arm['deadlineUnixMs'], 'window-deadline')
        frame = observer.frame()
        for layer in ('fixture', 'proxy', 'daemon'): same(first[layer], frame[layer])
        record_sample(seen, frame, observer.encoder, int(time.time() * 1000))
        time.sleep(.01)
    finished = read_json(window / 'finished.json')
    require(ready <= finished['finished'] <= arm['deadlineUnixMs'], 'finished-time')
    require(finished['nonce'] == arm['nonce'] and finished['runId'] == arm['runId'] and finished['attemptId'] == arm['attemptId'], 'finished-binding')
    require(finished['nativeStopReturnedSuccessfully'] is True and finished['decodedMediaPassed'] is True, 'media-not-proven')
    require(finished['segmentPath'] == arm['segmentPath'] and isinstance(finished['startedAt'], (int, float, str)), 'finished-segment')
    require(len(seen) == 1, 'no-encoding-observation')
    sample = next(iter(seen.values()))
    frame = observer.frame(sample['process'])
    for layer in ('fixture', 'proxy', 'daemon'): same(first[layer], frame[layer])
    require(frame.get('tracked') in ('gone', 'zombie'), 'tracked-encoder-not-gone')
    for child in frame['encoders']:
        if encoding(child['argv']) is not None:
            require(child['pid'] == sample['process']['pid'] and child['start'] == sample['process']['start'] and child.get('state') == 'Z', 'unexpected-final-encoder')
    require(not any(c['pid'] == sample['process']['pid'] and c['start'] == sample['process']['start'] and c.get('state') != 'Z' for c in frame['encoders']), 'encoder-still-live')
    media = Path(finished['publicPath']).resolve(strict=True)
    require(media.is_relative_to(window.parent.resolve()) and digest(media) == finished['webmSha256'], 'public-media-hash')
    require(digest(observer.native) == binding['nativeSha256'], 'native-mutated')
    version = version_of(observer.encoder, observer.encoder_hash)
    require(time.time() * 1000 <= arm['deadlineUnixMs'], 'window-deadline')
    require(not OWNED_CHILDREN, 'observer-child-not-reaped')
    receipt = dict(schemaVersion=1, proofKind='owned-execution-source-associated-media', limits='not-fd-byte-stream-proof',
                   binding=binding, nonce=arm['nonce'], platform=sys.platform, arch=arch,
                   fixture=first['fixture'], proxy=first['proxy'], daemon=first['daemon'], encoder=sample,
                   encoderSha256=observer.encoder_hash, version=version, armed=arm['armed'], ready=ready, finished=int(time.time() * 1000),
                   media=finished, encoderGone=True, executableUnchanged=True, observerChildrenReaped=not OWNED_CHILDREN)
    atomic_json(window / 'receipt.json', receipt)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        require(len(sys.argv) == 3, 'usage')
        run(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception as error:
        # No argv, environment, or raw OS buffers in failure messages.
        reason = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[a-z-]+', str(error)) else 'owned-encoder-observation-failed'
        print(reason, file=sys.stderr)
        sys.exit(1)

    finally:
        if len(sys.argv) == 3:
            try:
                write_exit(Path(sys.argv[2]))
            except Exception:
                print('observer-exit-receipt-failed', file=sys.stderr)
                sys.exit(1)
