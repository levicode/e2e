/** Synthetic validator controls only: never an installed browser acceptance receipt. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateEncoderReceipt, validateInstalledPublicProof } from './installed-public-proof.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'installed-proof-pure-')); const project = join(root, 'consumer'); const evidence = join(root, 'evidence');
  mkdirSync(project); mkdirSync(evidence);
  const put = (name: string, data: string | Buffer) => { const p = join(project, name); writeFileSync(p, data); return p; };
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const pixels = { width: 640, height: 480, protected: [0, 0, 0], public: [255, 0, 0], fresh: [0, 255, 0] };
  const report = (replay: boolean) => ({ run: { status: 'passed', results: [{ attempts: [{ steps: [{ api: 'agent.act', status: 'passed', cache: { mode: replay ? 'self-finalized' : 'missed', reason: replay ? undefined : 'no-entry', replayedActions: replay ? 2 : 0, totalActions: 2 }, metrics: { modelCalls: replay ? 0 : 2 }, explanation: 'zero-turn' }] }] }] } });
  const video = Buffer.from('1a45dfa3', 'hex'); const download = Buffer.from('installed\nsynthetic download\u0000\u00ff\n');
  const proof = { status: 'passed', checks: 11, runtimeOverrideAbsent: true, publicBrowserActionPassed: true, callbackPassed: true, cleanupConfirmed: true, surfaceOfPassed: true, locateTapPassed: true, report: { run: { status: 'passed' } }, screenshotPath: put('screenshot.png', png), coverage: {
    mask: { observation: pixels, artifact: structuredClone(pixels), path: put('mask.png', png) },
    media: { path: put('video.webm', video), bytes: video.length, frame: { width: 640, height: 480, padded: 0, inked: 0.5 } },
    download: { suggestedFilename: 'installed.bin', absolutePath: put('download.bin', download), bytes: download.length },
    state: { path: put('state.json', '{}'), bootstrapRequests: 0, restored: { phase: 'restored', first: { cookie: 'native-fixture=synthetic', local: 'stored' }, created: false, version: 3, indexes: ['byLabel'], record: { cycle: true, typedKind: 'Uint16Array', typed: [1, 65535], blob: 'fixture-payload', blobType: 'text/plain' } } },
    cache: { cachePath: put('cache.json', JSON.stringify({ schemaVersion: 'trace-1' })), recordedModelCalls: 2, replayedModelCalls: 0, replayedActions: 2, entryUnchanged: true, recordReport: put('record.json', JSON.stringify(report(false))), replayReport: put('replay.json', JSON.stringify(report(true))) },
  } };
  const observerSources: Record<string, string> = {};
  for (const name of ['installed-encoder-proof.py', 'installed-encoder-proc.c']) { const bytes = readFileSync(new URL(name, import.meta.url)); put(name, bytes); observerSources[name] = createHash('sha256').update(bytes).digest('hex'); }
  const binding = { schemaVersion: 1, platform: 'linux', arch: 'x64', nonce: 'synthetic-nonce', nativeExecutable: '/native', nativeSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), source: { commit: 'c'.repeat(40), tree: '2'.repeat(40) }, verifierSource: { commit: 'c'.repeat(40), tree: '2'.repeat(40), files: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`synthetic-${index}`, '3'.repeat(64)])) }, nativeSource: { commit: 'd'.repeat(40) }, observerSources, helperSha256: null };
  const media = Object.assign(proof.coverage.media, { runId: 'run', attemptId: 'attempt', startedAt: '2026-10-31T00:00:00Z', encoderReceiptPath: join(project, 'encoder.json'), encoderBindingPath: put('binding.json', JSON.stringify(binding)) });
  const process = (pid: number, ppid: number, exe: string) => ({ pid, ppid, uid: 1000, start: String(pid), group: pid, session: pid, exe });
  const output = '/tmp/agent-browser-action-12345678-abcd-1234-abcd-123456789abc/video.webm';
  const argv = ['/ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-fpsprobesize', '0', '-probesize', '32', '-analyzeduration', '0', '-f', 'image2pipe', '-c:v', 'png', '-framerate', '25', '-i', 'pipe:0', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-fps_mode', 'vfr', '-c:v', 'libvpx', '-crf', '18', '-b:v', '8000k', '-deadline', 'realtime', '-cpu-used', '4', '-pix_fmt', 'yuv420p', '-threads', '1', output];
  const receipt = { schemaVersion: 1, platform: 'linux', arch: 'x64', proofKind: 'owned-execution-source-associated-media', limits: 'not-fd-byte-stream-proof', binding, nonce: binding.nonce, fixture: process(1, 0, '/node'), proxy: { ...process(2, 1, '/native'), exeSha256: binding.nativeSha256 }, daemon: { ...process(3, 2, '/native'), exeSha256: binding.nativeSha256 }, encoder: { process: process(4, 3, '/ffmpeg'), argv, privateOutput: output, firstObserved: 1002, lastObserved: 1003 }, encoderSha256: 'e'.repeat(64), version: { executable: '/ffmpeg', sha256: 'e'.repeat(64), argv: ['-version'], firstLine: 'ffmpeg version synthetic' }, armed: 1000, ready: 1001, finished: 1005, media: { nonce: binding.nonce, runId: media.runId, attemptId: media.attemptId, startedAt: media.startedAt, publicPath: media.path, segmentPath: 'video/video.webm', webmSha256: createHash('sha256').update(video).digest('hex'), nativeStopReturnedSuccessfully: true, decodedMediaPassed: true, finished: 1004 }, encoderGone: true, executableUnchanged: true, observerChildrenReaped: true };
  put('encoder.json', JSON.stringify(receipt));
  return { root, project, evidence, proof, binding, receipt, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('synthetic complete envelope retains twelve evidence files with digests', () => {
  const f = fixture(); try { validateInstalledPublicProof(f.proof, f.project, f.evidence, f.binding); const files = JSON.parse(readFileSync(join(f.evidence, 'installed-coverage-files.json'), 'utf8')); assert.equal(Object.keys(files).length, 12); for (const file of Object.values(files) as { sha256: string }[]) assert.match(file.sha256, /^[a-f0-9]{64}$/); } finally { f.close(); }
});

const negatives: Record<string, (f: ReturnType<typeof fixture>) => void> = {
  'old six-check result': f => { f.proof.checks = 6; },
  'non-boolean original flag': f => { Object.assign(f.proof, { surfaceOfPassed: 'true' }); },
  'masked public pixels': f => { f.proof.coverage.mask.artifact.public = [0, 0, 0]; },
  'unmasked secret pixels': f => { f.proof.coverage.mask.observation.protected = [255, 0, 0]; },
  'stale background': f => { f.proof.coverage.mask.artifact.fresh = [0, 0, 255]; },
  'video wrong viewport': f => { f.proof.coverage.media.frame.width = 320; },
  'video blank': f => { f.proof.coverage.media.frame.inked = 0; },
  'video padding': f => { f.proof.coverage.media.frame.padded = 0.5; },
  'video NaN': f => { f.proof.coverage.media.frame.inked = NaN; },
  'video corrupt': f => { writeFileSync(f.proof.coverage.media.path, 'nope'); },
  'download incorrect bytes': f => { writeFileSync(f.proof.coverage.download.absolutePath, 'wrong'); },
  'state first-script missing cookie': f => { f.proof.coverage.state.restored.first.cookie = ''; },
  'state lost typed value': f => { f.proof.coverage.state.restored.record.typed[1] = 1; },
  'state bootstrap request': f => { f.proof.coverage.state.bootstrapRequests = 1; },
  'cache called model': f => { f.proof.coverage.cache.replayedModelCalls = 1; },
  'cache no recorded model': f => { f.proof.coverage.cache.recordedModelCalls = 0; },
  'cache mutated': f => { f.proof.coverage.cache.entryUnchanged = false; },
  'cache wrong action count': f => { f.proof.coverage.cache.replayedActions = 1; },
  'cache false replay report': f => { const p = f.proof.coverage.cache.replayReport; const report = JSON.parse(readFileSync(p, 'utf8')); report.run.results[0].attempts[0].steps[0].metrics.modelCalls = 1; writeFileSync(p, JSON.stringify(report)); },
  'outside-project evidence': f => { const p = join(f.root, 'outside.png'); writeFileSync(p, Buffer.from('89504e470d0a1a0a', 'hex')); f.proof.screenshotPath = p; },
};
for (const [name, mutate] of Object.entries(negatives)) test(`rejects ${name}`, () => { const f = fixture(); try { mutate(f); assert.throws(() => validateInstalledPublicProof(f.proof, f.project, f.evidence, f.binding)); } finally { f.close(); } });
for (const missing of ['mask', 'media', 'download', 'state', 'cache']) test(`rejects missing ${missing}`, () => { const f = fixture(); try { delete (f.proof.coverage as Record<string, unknown>)[missing]; assert.throws(() => validateInstalledPublicProof(f.proof, f.project, f.evidence, f.binding)); } finally { f.close(); } });

test('generated installed-only files parse without executing fixture, browser, or runner', () => {
  const source = readFileSync(new URL('fixtures/installed-candidate.mjs', import.meta.url), 'utf8');
  const root = mkdtempSync(join(tmpdir(), 'installed-generated-syntax-'));
  try {
    const templates = [...source.matchAll(/writeFileSync\('(installed-cache[^']+)'\s*,\s*(String\.raw)?`([\s\S]*?)`\);/g)];
    assert.equal(templates.length, 3);
    for (const [, name, raw, body] of templates) {
      const text = new Function('appURL', `return ${raw ? 'String.raw' : ''}\`${body}\`;`)('http://127.0.0.1:1234');
      const p = join(root, name!.replaceAll('/', '-')); writeFileSync(p, text);
      const checked = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' }); assert.equal(checked.status, 0, checked.stderr);
    }
    assert.match(source, /from 'e2e\/runner'/); assert.match(source, /from '@e2e-dev\/web'/);
    assert.doesNotMatch(source, /from ['"][^'"]*(?:packages\/|\/src\/|helpers\/)/);
    assert.match(source, /const screenshotPath = resolvePath\(session\.artifactsDir, await app\.screenshot\('installed-candidate'\)\);\s*const capture = readFileSync\(screenshotPath\);/);
    assert.ok(source.indexOf('closed = true; checks++;') < source.indexOf('coverage.state = await installedState(url)'), 'State reset must not pre-close the original cleanup oracle page');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('isolation accepts real npm and pnpm entries only within external project node_modules', async () => {
  const { assertInstalledConsumerIsolation } = await import('./installed-public-proof.ts');
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'installed-isolation-'));
  try {
    const checkout = join(root, 'repo'); const project = join(root, 'repo-consumer'); mkdirSync(checkout); mkdirSync(project);
    const modules = join(project, 'node_modules'); const npm = join(modules, 'e2e'); const pnpm = join(modules, '.pnpm', 'web@1', 'node_modules', '@e2e-dev', 'web');
    mkdirSync(npm, { recursive: true }); mkdirSync(pnpm, { recursive: true });
    writeFileSync(join(npm, 'runner.js'), ''); writeFileSync(join(pnpm, 'index.js'), '');
    mkdirSync(join(modules, '@e2e-dev')); symlinkSync(pnpm, join(modules, '@e2e-dev/web'), 'dir');
    assert.doesNotThrow(() => assertInstalledConsumerIsolation(project, checkout, [join(npm, 'runner.js'), join(modules, '@e2e-dev/web/index.js')]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of ['same checkout', 'nested checkout', 'project symlink to checkout', 'package symlink to checkout', 'package symlink external', 'node_modules symlink external', 'prefix disguise']) test(`isolation rejects ${scenario}`, async () => {
  const { assertInstalledConsumerIsolation } = await import('./installed-public-proof.ts');
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'installed-isolation-negative-'));
  try {
    const checkout = join(root, 'repo'); let project = join(root, 'consumer'); mkdirSync(checkout); mkdirSync(project);
    const outside = join(root, 'external'); mkdirSync(outside); writeFileSync(join(outside, 'entry.js'), ''); writeFileSync(join(checkout, 'entry.js'), '');
    const modules = join(project, 'node_modules'); let entry = join(modules, 'entry.js');
    if (scenario === 'same checkout') project = checkout;
    else if (scenario === 'nested checkout') { project = join(checkout, 'consumer'); mkdirSync(project); }
    else if (scenario === 'project symlink to checkout') { rmSync(project, { recursive: true }); symlinkSync(checkout, project, 'dir'); }
    else if (scenario === 'node_modules symlink external') symlinkSync(outside, modules, 'dir');
    else {
      mkdirSync(modules);
      if (scenario === 'package symlink to checkout') symlinkSync(join(checkout, 'entry.js'), entry);
      if (scenario === 'package symlink external') symlinkSync(join(outside, 'entry.js'), entry);
      if (scenario === 'prefix disguise') { const fake = modules + '-elsewhere'; mkdirSync(fake); entry = join(fake, 'entry.js'); writeFileSync(entry, ''); }
    }
    assert.throws(() => assertInstalledConsumerIsolation(project, checkout, scenario.includes('checkout') && !scenario.includes('package') ? [] : [entry]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const encoderNegatives: Record<string, (f: ReturnType<typeof fixture>) => void> = {
  'old version-only record': f => { f.receipt.encoder.argv = ['/ffmpeg', '-version']; },
  'wrong nonce': f => { f.receipt.nonce = 'foreign'; },
  'wrong platform': f => { f.receipt.platform = 'darwin'; },
  'wrong native parent': f => { f.receipt.daemon.ppid = 1; },
  'wrong native executable': f => { f.receipt.proxy.exe = '/spoof'; },
  'wrong encoder uid': f => { f.receipt.encoder.process.uid = 99; },
  'unreaped observer helper': f => { f.receipt.observerChildrenReaped = false; },
  'still live encoder': f => { f.receipt.encoderGone = false; },
  'mutated encoder binary': f => { f.receipt.executableUnchanged = false; },
  'PATH version instead of observed binary': f => { f.receipt.version.executable = 'ffmpeg'; },
  'sample before ready': f => { f.receipt.encoder.firstObserved = 999; },
  'finish before last sample': f => { f.receipt.media.finished = 1002; },
  'stale public media': f => { f.receipt.media.webmSha256 = 'f'.repeat(64); },
  'wrong public path': f => { f.receipt.media.publicPath = '/other.webm'; },
  'wrong run': f => { f.receipt.media.runId = 'other'; },
  'native stop not confirmed': f => { f.receipt.media.nativeStopReturnedSuccessfully = false; },
  'decode not confirmed': f => { f.receipt.media.decodedMediaPassed = false; },
  'fd proof overclaim': f => { f.receipt.limits = 'direct'; },
  'extra input': f => { f.receipt.encoder.argv.splice(17, 0, '-i', 'file:secret'); },
  'unexpected output': f => { f.receipt.encoder.privateOutput = '/tmp/other.webm'; },
};
for (const [name, mutate] of Object.entries(encoderNegatives)) test(`encoder rejects ${name}`, () => {
  const f = fixture(); try { mutate(f); assert.throws(() => validateEncoderReceipt(f.receipt, f.binding, f.proof.coverage.media, f.receipt.media.webmSha256 === 'f'.repeat(64) ? 'e'.repeat(64) : createHash('sha256').update(readFileSync(f.proof.coverage.media.path)).digest('hex'))); } finally { f.close(); }
});

const encoderControlArgs = (path: string) => ['-B', path];

test('owned encoder observer and actual C parser pass synthetic controls without process observation', () => {
  const result = spawnSync('python3', encoderControlArgs(fileURLToPath(new URL('installed-encoder-proof.test.py', import.meta.url))), { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, shell: false });
  assert.equal(result.error, undefined, 'Python/host C compiler required for acceptance pure controls');
  assert.equal(result.status, 0, result.stderr);
});

// Exercise the actual launcher policy in a clean disposable source checkout, not the caller's repository.
test('encoder pure controls leave committed source clean, including untracked bytecode', t => {
  const root = mkdtempSync(join(tmpdir(), 'encoder-clean-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['installed-encoder-proof.test.py', 'installed-encoder-proof.py', 'installed-encoder-proc.c']) {
    writeFileSync(join(root, name), readFileSync(new URL(name, import.meta.url)));
  }
  const env = { ...process.env };
  delete env.PYTHONDONTWRITEBYTECODE; delete env.PYTHONPYCACHEPREFIX;
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'user.name=Pure Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'synthetic source');
  assert.equal(git('status', '--porcelain', '-uall'), '');
  const result = spawnSync('python3', encoderControlArgs(join(root, 'installed-encoder-proof.test.py')), { cwd: root, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, shell: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git('status', '--porcelain', '-uall'), '', 'pure controls must not dirty tracked or untracked source');
});
