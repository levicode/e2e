/** Synthetic validator controls only: never an installed browser acceptance receipt. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync as sdkSymlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateInstalledRunClosed, INSTALLED_RUN_DIAGNOSTIC_ENUMS, validateInstalledSdkPrerequisite, INSTALLED_AI_VERSION, installedConsumerMetadata, inspectInstalledSdkPrerequisite, validateEncoderReceipt, validateInstalledPublicProof } from './installed-public-proof.ts';

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

test('actual installed run failure diagnostic retains only closed facts before unchanged assertions', async () => {
  const source = readFileSync(new URL('fixtures/installed-candidate.mjs', import.meta.url), 'utf8');
  const match = source.match(/\/\/ BEGIN installed run closed diagnostic[^\n]*\n([\s\S]*?)\/\/ END installed run closed diagnostic/);
  assert.ok(match);
  const closed = new Function(`${match[1]}\nreturn installedRunClosed;`)() as (stage: string, result: unknown) => any;
  const secret = 'PRIVATE_MESSAGE_PATH_TOKEN';
  const error = { code: 'MODEL_UNAVAILABLE', category: 'configuration', phase: 'body', message: secret, stack: secret, source: { file: secret }, details: { token: secret } };
  const value = { exitCode: 2, status: 'blocked', report: { run: { errors: [{ ...error, code: secret, category: secret, phase: secret }], results: [{ name: secret, attempts: [{ error, secondaryErrors: [error], steps: [{ error, explanation: secret, metrics: { modelCalls: 123 } }] }] }] } } };
  const receipt = closed('record', value);
  assert.equal(receipt.exitCode, 2); assert.equal(receipt.stage, 'record'); assert.equal(receipt.resultCount, 1);
  assert.deepEqual(receipt.errors.map((item: any) => item.scope), ['run', 'attempt', 'secondary', 'step']);
  assert.equal(receipt.errors[0].code, 'other'); assert.equal(receipt.errors[0].category, 'unknown'); assert.equal(receipt.errors[0].phase, 'unknown');
  assert.equal(receipt.errors[1].code, 'MODEL_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_MESSAGE_PATH_TOKEN|message|stack|explanation|source|details/);
  const overflow = closed('replay', { exitCode: 999, status: secret, report: { run: { errors: Array.from({ length: 100 }, () => ({ ...error })), results: Array.from({ length: 100 }, () => ({ attempts: Array.from({ length: 10 }, () => ({ error: { ...error } })) })) } } });
  assert.equal(overflow.errors.length, 32); assert.equal(overflow.resultCount, 16); assert.equal(overflow.truncated, true);
  assert.equal(overflow.exitCode, null); assert.equal(overflow.status, 'unknown');
  assert.deepEqual(closed('record', {}).errors, []); assert.throws(() => closed(secret, {}), /Invalid installed run stage/);
  const cacheFunction = source.slice(source.indexOf('async function installedCache(appURL)'), source.indexOf('async function installedState(appURL)'));
  const lines: string[] = [];
  const actualCache = new Function('mkdirSync', 'writeFileSync', 'run', 'assert', 'console', 'installedRunClosed', `${cacheFunction}\nreturn installedCache;`)(() => {}, () => {}, async () => value, assert, { log: (line: string) => lines.push(line) }, closed) as (url: string) => Promise<unknown>;
  await assert.rejects(actualCache('http://127.0.0.1:1234'), /2 !== 0/);
  assert.equal(lines.length, 1, 'actual first-record failure must emit once before original assertion throws');
  assert.ok(lines[0]!.startsWith('INSTALLED_RUN_CLOSED '));
  assert.deepEqual(JSON.parse(lines[0]!.slice('INSTALLED_RUN_CLOSED '.length)), receipt);

  for (const stage of ['record', 'replay']) {
    assert.ok(source.indexOf(`installedRunClosed('${stage}', ${stage}`) < source.indexOf(`assert.equal(${stage}.exitCode, 0)`));
    assert.ok(source.includes(`assert.equal(${stage}.exitCode, 0); assert.equal(${stage}.status, 'passed');`));
  }
});

function sdkFixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'installed-sdk-pure-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'consumer'); const core = join(project, 'node_modules', 'e2e'); mkdirSync(core, { recursive: true });
  writeFileSync(join(core, 'package.json'), JSON.stringify({ name: 'e2e', type: 'module' }));
  const entry = join(core, 'runner.js'); writeFileSync(entry, 'throw new Error("must not execute core");');
  const marker = join(root, 'executed');
  const install = (directory: string, version: string, name = 'ai') => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
    writeFileSync(join(directory, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('must not execute SDK');`);
  };
  return { root, project, core, entry, marker, install };
}

test('SDK prerequisite uses exact locked consumer peer metadata, not a product dependency change', () => {
  assert.equal(INSTALLED_AI_VERSION, '7.0.153');
  const product = JSON.parse(readFileSync(new URL('../../packages/e2e/package.json', import.meta.url), 'utf8'));
  assert.equal(product.devDependencies.ai, INSTALLED_AI_VERSION); assert.equal(product.peerDependencies.ai, '^7.0.0'); assert.equal(product.peerDependenciesMeta.ai.optional, true);
  assert.ok(readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8').includes(`  ai@${INSTALLED_AI_VERSION}:`));
  assert.deepEqual(installedConsumerMetadata(), { name: 'native-candidate-installed-consumer', private: true, type: 'module', dependencies: { ai: '7.0.153' } });
  const source = readFileSync(new URL('candidate-installed.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/await installBundle\(/g) ?? []).length, 1);
  assert.ok(source.indexOf('JSON.stringify(installedConsumerMetadata())') < source.indexOf('await installBundle('));
  const saved = source.indexOf("writeFileSync(join(evidence, 'installed-sdk-prerequisite.json')");
  assert.ok(saved > source.indexOf('inspectInstalledSdkPrerequisite(project, coreEntry)'));
  assert.ok(saved < source.indexOf("if (sdkPrerequisite.status !== 'verified')"));
  assert.ok(saved < source.indexOf('before = await verifyHeldoutCandidate(options)'));
  assert.ok(source.includes("spawnSync(process.execPath, ['installed-candidate.mjs']"));
});

test('SDK prerequisite resolves from actual core context without executing either package', t => {
  const f = sdkFixture(t);
  f.install(join(f.project, 'node_modules', 'ai'), '9.9.9');
  f.install(join(f.core, 'node_modules', 'ai'), INSTALLED_AI_VERSION);
  const receipt = inspectInstalledSdkPrerequisite(f.project, f.entry);
  assert.equal(receipt.status, 'verified'); assert.equal(receipt.version, '7.0.153');
  assert.equal(receipt.coreInsideConsumer, true); assert.equal(receipt.resolvedFromCore, true); assert.equal(receipt.sdkInsideConsumer, true); assert.equal(receipt.metadataInsideConsumer, true);
  assert.equal(receipt.consumerRun, 'unrun-at-prerequisite-check'); assert.equal(receipt.evidence, 'sdk-prerequisite-not-acceptance');
  assert.equal(existsSync(f.marker), false);
  assert.ok(!JSON.stringify(receipt).includes(f.root));
});

test('SDK prerequisite rejects core-visible wrong version even if project peer is correct', t => {
  const f = sdkFixture(t); f.install(join(f.project, 'node_modules', 'ai'), INSTALLED_AI_VERSION); f.install(join(f.core, 'node_modules', 'ai'), '7.0.134');
  const receipt = inspectInstalledSdkPrerequisite(f.project, f.entry);
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.reason, 'version-mismatch'); assert.equal(receipt.version, '7.0.134'); assert.equal(existsSync(f.marker), false);
});

test('SDK prerequisite fails closed for absent peer, external resolution and invalid metadata without secret output', t => {
  const f = sdkFixture(t);
  assert.equal(inspectInstalledSdkPrerequisite(f.project, f.entry).reason, 'sdk-unresolved');
  const external = join(f.root, 'PRIVATE_EXTERNAL_SECRET'); f.install(external, INSTALLED_AI_VERSION);
  const sdk = join(f.core, 'node_modules', 'ai'); mkdirSync(join(f.core, 'node_modules')); sdkSymlinkSync(external, sdk, 'dir');
  const outsideReceipt = inspectInstalledSdkPrerequisite(f.project, f.entry);
  assert.equal(outsideReceipt.reason, 'sdk-outside-consumer'); assert.equal(outsideReceipt.status, 'failed'); assert.equal(outsideReceipt.sdkInsideConsumer, false);
  assert.doesNotMatch(JSON.stringify(outsideReceipt), /PRIVATE_EXTERNAL_SECRET|must not execute|index.js/);
  const invalidFixture = sdkFixture(t); invalidFixture.install(join(invalidFixture.core, 'node_modules', 'ai'), 'PRIVATE_VERSION_SECRET');
  const invalid = inspectInstalledSdkPrerequisite(invalidFixture.project, invalidFixture.entry);
  assert.equal(invalid.status, 'failed'); assert.equal(invalid.reason, 'metadata-invalid'); assert.equal(invalid.version, null); assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_VERSION_SECRET/);
  assert.equal(inspectInstalledSdkPrerequisite(f.project, join(external, 'index.js')).reason, 'core-outside-consumer');
  assert.equal(existsSync(f.marker), false);
});

test('retained SDK prerequisite validator accepts failures as failures, rejects spoofed success and unsafe fields', t => {
  const f = sdkFixture(t);
  const missing = inspectInstalledSdkPrerequisite(f.project, f.entry);
  assert.equal(validateInstalledSdkPrerequisite(missing).status, 'failed');
  f.install(join(f.core, 'node_modules', 'ai'), INSTALLED_AI_VERSION);
  const valid = inspectInstalledSdkPrerequisite(f.project, f.entry);
  assert.equal(validateInstalledSdkPrerequisite(valid).status, 'verified');
  for (const value of [undefined, { ...valid, message: 'PRIVATE_SECRET' }, { ...valid, version: 'PRIVATE_SECRET' }, { ...valid, reason: 'PRIVATE_SECRET' }, { ...valid, resolvedFromCore: false }, { ...valid, metadataInsideConsumer: false }, { ...valid, consumerRun: 'passed' }, { ...missing, status: 'verified' }, { ...valid, expectedVersion: '7.0.134' }]) {
    assert.throws(() => validateInstalledSdkPrerequisite(value), { message: 'Invalid installed SDK prerequisite receipt' });
  }
  const wrong = sdkFixture(t); wrong.install(join(wrong.core, 'node_modules', 'ai'), '7.0.134');
  assert.equal(validateInstalledSdkPrerequisite(inspectInstalledSdkPrerequisite(wrong.project, wrong.entry)).reason, 'version-mismatch');
});

// Pure extraction of diagnostic functions only. Never imports or runs the installed SDK/fixture.
function diagnosticFunctions() {
  const source = readFileSync(new URL('fixtures/installed-candidate.mjs', import.meta.url), 'utf8');
  const block = source.match(/\/\/ BEGIN installed run closed diagnostic[^\n]*\n([\s\S]*?)\/\/ END installed run closed diagnostic/)!;
  const closed = new Function(`${block[1]}\nreturn installedRunClosed;`)() as (stage: string, value: any, files?: any) => any;
  return { source, block: block[1]!, closed };
}
function sampleRun(events: any = [{ kind: 'engine', name: 'tap', code: 'ENGINE_FAILURE', status: 'failed', durationMs: 12 }]) {
  return { exitCode: 3, status: 'error', report: { run: { results: [{ attempts: [{ error: { code: 'APP_UNREACHABLE', category: 'infrastructure', phase: 'body' }, steps: [{ api: 'app.open', status: 'passed' }, { api: 'agent.act', status: 'failed', durationMs: 21, cache: { mode: 'agent-concluded', reason: 'action-failed', replayedActions: 1, totalActions: 2 }, metrics: { modelCalls: 0 }, events }] }] }] } } };
}

test('v2 preserves final and underlying phase codes, public cache fields, ordinals and honest missing facts', () => {
  const { closed } = diagnosticFunctions(); const projected = closed('replay', sampleRun());
  validateInstalledRunClosed(projected);
  assert.equal(projected.status, 'error'); assert.equal(projected.errors[0].code, 'APP_UNREACHABLE');
  assert.equal(projected.steps[0].stepIndex, 1); assert.equal(projected.steps[0].events[0].code, 'ENGINE_FAILURE');
  assert.equal(projected.steps[0].cache.reason, 'action-failed'); assert.equal(projected.steps[0].metrics.modelCalls, 0);
  assert.equal(projected.files.calls.status, 'unknown'); assert.equal(projected.files.calls.delta, null);
  const absent = closed('replay', sampleRun(null)); validateInstalledRunClosed(absent);
  assert.equal(absent.steps[0].eventsState, 'unknown'); assert.deepEqual(absent.steps[0].events, []);
  const empty = closed('replay', sampleRun([])); assert.equal(empty.steps[0].eventsState, 'recorded');
  const unknown = closed('replay', {}); validateInstalledRunClosed(unknown); assert.equal(unknown.resultCount, null);
});

test('v2 closed enums include every declared code and scrub arbitrary event/error data', () => {
  const { closed } = diagnosticFunctions();
  for (const code of INSTALLED_RUN_DIAGNOSTIC_ENUMS.codes) {
    const value = sampleRun([{ kind: 'engine', name: 'tap', code, status: 'cancelled', durationMs: 0 }]);
    value.report.run.results[0]!.attempts[0]!.error.code = code;
    const r = closed('replay', value); validateInstalledRunClosed(r); assert.equal(r.errors[0].code, code); assert.equal(r.steps[0].events[0].code, code);
  }
  const secret = 'PRIVATE_NAME_TOKEN_PATH';
  const r = closed('replay', sampleRun([{ kind: secret, name: secret, code: secret, status: secret, durationMs: -1, message: secret, stack: secret, target: secret, URL: secret, detail: secret, metadata: { token: secret } }, {}]));
  validateInstalledRunClosed(r); assert.doesNotMatch(JSON.stringify(r), /PRIVATE_NAME_TOKEN_PATH|message|stack|target|URL|detail|metadata/);
  assert.equal(r.steps[0].events[0].name, 'other'); assert.equal(r.steps[0].events[0].code, 'other'); assert.equal(r.steps[0].events[1].code, 'unknown'); assert.equal(r.steps[0].events[0].durationMs, null);
});

test('v2 enforces total event cap, step/error caps and bounded malformed fallback', () => {
  const { closed } = diagnosticFunctions(); const value = sampleRun(Array.from({ length: 60 }, () => ({ code: 'CANCELLED' })));
  const attempt = value.report.run.results[0]!.attempts[0]!;
  attempt.steps.push({ ...attempt.steps[1]!, events: Array.from({ length: 20 }, () => ({})) });
  const r = closed('replay', value); validateInstalledRunClosed(r);
  assert.equal(r.steps[0].events.length, 60); assert.equal(r.steps[1].events.length, 4); assert.equal(r.steps[1].eventsTruncated, true); assert.equal(r.truncated, true);
  const hostile = { get report() { throw new Error('SECRET'); } };
  const fallback = closed('replay', hostile); validateInstalledRunClosed(fallback); assert.equal(fallback.projection, 'failed'); assert.equal(fallback.exitCode, null);
  const huge = sampleRun(); huge.report.run.results = Array.from({ length: 20 }, () => ({ attempts: Array.from({ length: 10 }, () => ({ ...attempt, steps: Array.from({ length: 70 }, () => attempt.steps[1]!) })) }));
  const bounded = closed('replay', huge); validateInstalledRunClosed(bounded); assert.equal(bounded.resultCount, 16); assert.equal(bounded.steps.length, 16); assert.equal(bounded.errors.length, 32); assert.equal(bounded.truncated, true);
});

test('v2 validator rejects secret fields, unknown tokens, overflow and contradictory receipts', () => {
  const { closed } = diagnosticFunctions();
  const mutations: Array<(r: any) => void> = [
    r => { r.message = 'SECRET'; }, r => { r.status = 'SECRET'; }, r => { r.errors[0].code = 'SECRET'; },
    r => { r.errors[0].phase = 'SECRET'; }, r => { r.errors[0].resultIndex = 10; },
    r => { r.steps[0].cache.entry = 'SECRET'; }, r => { r.steps[0].metrics.modelCalls = -1; },
    r => { r.steps[0].events[0].name = 'SECRET'; }, r => { r.steps[0].events[0].code = 'SECRET'; },
    r => { r.steps[0].events[0].detail = 'SECRET'; }, r => { r.steps[0].events[0].metadata = {}; },
    r => { r.steps[0].events[0].eventIndex = 1; }, r => { r.steps[0].events[0].durationMs = Infinity; },
    r => { r.steps[0].eventsState = 'unknown'; }, r => { r.steps[0].eventsTruncated = true; },
    r => { r.steps[0].events = Array.from({ length: 65 }, (_, eventIndex) => ({ ...r.steps[0].events[0], eventIndex })); },
    r => { r.steps.push(structuredClone(r.steps[0])); }, r => { r.files.calls.delta = 0; },
    r => { r.files.calls = { status: 'verified', before: 2, after: 1, delta: -1 }; },
    r => { r.projection = 'failed'; }, r => { r.exitCode = 99; }, r => { r.resultCount = 17; },
    r => { r.steps[0].events = new Array(1); },
  ];
  for (const mutate of mutations) { const r = closed('replay', sampleRun()); mutate(r); assert.throws(() => validateInstalledRunClosed(r), { message: 'Invalid installed run closed diagnostic' }); }
});

test('bounded known-file diagnostics distinguish missing/invalid from zero and never expose contents or paths', async t => {
  const fs = await import('node:fs'); const { block } = diagnosticFunctions();
  const root = mkdtempSync(join(tmpdir(), 'installed-diagnostic-file-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const callsPath = join(root, 'calls'); const cachePath = join(root, 'cache'); const bytes = Buffer.from('PRIVATE_CACHE_BYTES');
  writeFileSync(cachePath, bytes); const mtime = fs.statSync(cachePath).mtimeMs;
  let retained: Buffer | undefined;
  const bounded = new Function('openSync', 'constants', 'fstatSync', 'readSync', 'closeSync', `${block}\nreturn installedCacheFiles;`)(
    (p: string, flags: number) => fs.openSync(p === 'installed-model-calls.log' ? callsPath : p, flags), fs.constants, fs.fstatSync,
    (fd: number, b: Buffer, ...args: [number, number, null]) => { retained = b; return fs.readSync(fd, b, ...args); }, fs.closeSync,
  ) as (before: string, path: string, bytes: Buffer, mtime: number) => any;
  const missing = bounded('call\n', cachePath, bytes, mtime); assert.equal(missing.calls.status, 'unknown'); assert.equal(missing.calls.delta, null);
  writeFileSync(callsPath, 'call\ncall\n'); const valid = bounded('call\n', cachePath, bytes, mtime);
  assert.deepEqual(valid.calls, { status: 'verified', before: 1, after: 2, delta: 1 }); assert.deepEqual(valid.cache, { status: 'verified', bytesEqual: true, mtimeEqual: true });
  assert.ok(retained!.every(byte => byte === 0)); assert.equal(bytes.toString(), 'PRIVATE_CACHE_BYTES');
  assert.doesNotMatch(JSON.stringify(valid), /PRIVATE_CACHE_BYTES|installed-diagnostic-file|callsPath|cachePath/);
  for (const invalid of ['SECRET', 'call\n\n', 'call', 'call\n\0', '']) {
    writeFileSync(callsPath, invalid); assert.equal(bounded('call\n', cachePath, bytes, mtime).calls.status, 'unknown');
  }
  writeFileSync(callsPath, ''); assert.equal(bounded('', cachePath, bytes, mtime).calls.delta, 0);
  writeFileSync(callsPath, 'x'.repeat(1_048_577)); assert.equal(bounded('', cachePath, bytes, mtime).calls.status, 'unknown');
  fs.rmSync(callsPath); fs.symlinkSync(cachePath, callsPath); assert.equal(bounded('', cachePath, bytes, mtime).calls.status, 'unknown');
  fs.rmSync(callsPath);
  const fifo = spawnSync('mkfifo', [callsPath], { encoding: 'utf8', timeout: 2_000 }); assert.equal(fifo.status, 0, 'mkfifo required for safe FIFO control');
  // Child hard deadline makes a regression to blocking open a bounded test failure.
  const fifoControl = `const fs = require('node:fs'); const realOpen = fs.openSync; const openSync = (p, flags) => realOpen(p === 'installed-model-calls.log' ? ${JSON.stringify(callsPath)} : p, flags); const { constants, fstatSync, readSync, closeSync } = fs; ${block}; const r = installedCacheFiles('call\\n', ${JSON.stringify(callsPath)}, Buffer.from('cache'), 0); if (r.calls.status !== 'unknown' || r.cache.status !== 'unknown') process.exit(2);`;
  const checkedFifo = spawnSync(process.execPath, ['-e', fifoControl], { encoding: 'utf8', timeout: 2_000 });
  assert.equal(checkedFifo.error, undefined, 'known FIFO must not block diagnostic open'); assert.equal(checkedFifo.status, 0, checkedFifo.stderr);
  const blockingMutation = spawnSync(process.execPath, ['-e', fifoControl.replace(' | constants.O_NONBLOCK', '')], { encoding: 'utf8', timeout: 250, killSignal: 'SIGKILL' });
  assert.equal((blockingMutation.error as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT', 'negative mutation must expose the former blocking open');

  writeFileSync(cachePath, 'different'); const changed = bounded('', cachePath, bytes, mtime); assert.equal(changed.cache.bytesEqual, false);
  const { closed } = diagnosticFunctions(); validateInstalledRunClosed(closed('replay', sampleRun(), valid));
  let statCalls = 0;
  const changing = new Function('openSync', 'constants', 'fstatSync', 'readSync', 'closeSync', `${block}\nreturn installedCacheFiles;`)(
    (p: string, flags: number) => fs.openSync(p === 'installed-model-calls.log' ? cachePath : p, flags), fs.constants,
    (fd: number) => { const stat = fs.fstatSync(fd); if (++statCalls % 2 === 0) stat.mtimeMs += 1; return stat; }, fs.readSync, fs.closeSync,
  );
  const unstable = changing('call\n', cachePath, bytes, mtime); assert.equal(unstable.calls.status, 'unknown'); assert.equal(unstable.cache.status, 'unknown');

});

test('actual extracted installedCache keeps original replay assertion primary even if stdout fails', async () => {
  const { source, closed } = diagnosticFunctions();
  const cacheFunction = source.slice(source.indexOf('async function installedCache(appURL)'), source.indexOf('async function installedState(appURL)'));
  const record: any = sampleRun([]); record.exitCode = 0; record.status = 'passed';
  record.report.run.results[0].attempts[0].steps[1] = { api: 'agent.act', status: 'passed', cache: { mode: 'missed', reason: 'no-entry' }, metrics: { modelCalls: 2 } };
  const replay = sampleRun(); const bytes = Buffer.from('opaque cache');
  for (const throwStdout of [false, true]) {
    let runs = 0; const lines: string[] = [];
    const actual = new Function('mkdirSync', 'writeFileSync', 'run', 'assert', 'console', 'installedRunClosed', 'installedCacheFiles', 'readFileSync', 'readdirSync', 'resolvePath', 'statSync', `${cacheFunction}\nreturn installedCache;`)(
      () => {}, () => {}, async () => ++runs === 1 ? record : replay, assert,
      { log: (line: string) => { if (throwStdout) throw new Error('DIAGNOSTIC_OUTPUT_ONLY'); lines.push(line); } }, closed,
      () => ({ calls: { status: 'unknown', before: null, after: null, delta: null }, cache: { status: 'unknown', bytesEqual: null, mtimeEqual: null } }),
      (path: string) => path === 'installed-model-calls.log' ? 'call\n' : bytes, () => ['entry.json'], (...parts: string[]) => parts.join('/'), () => ({ mtimeMs: 10 }),
    );
    await assert.rejects(actual('http://127.0.0.1:1234'), /3 !== 0/); assert.equal(runs, 2);
    if (!throwStdout) { assert.equal(lines.length, 2); for (const line of lines) validateInstalledRunClosed(JSON.parse(line.slice('INSTALLED_RUN_CLOSED '.length))); }
  }
});

test('generated cache-run output is isolated from hosted evidence while default-output mutation loses evidence', async () => {
  const fs = await import('node:fs'); const path = await import('node:path');
  const { source, closed } = diagnosticFunctions();
  const cacheFunction = source.slice(source.indexOf('async function installedCache(appURL)'), source.indexOf('async function installedState(appURL)'));
  for (const defaultOutputMutation of [false, true]) {
    const f = fixture();
    try {
      const hostRoot = join(f.project, '.e2e/results/host'); mkdirSync(hostRoot, { recursive: true });
      const screenshot = join(hostRoot, 'original.png'); fs.renameSync(f.proof.screenshotPath, screenshot); f.proof.screenshotPath = screenshot;
      const originalScreenshot = readFileSync(screenshot);
      const cacheRoot = join(f.project, '.e2e/cache'); mkdirSync(cacheRoot, { recursive: true });
      const entry = join(cacheRoot, 'entry.json'); writeFileSync(entry, JSON.stringify({ schemaVersion: 'trace-1' }));
      const originalCache = readFileSync(entry); const originalMtime = fs.statSync(entry).mtimeMs;
      writeFileSync(join(f.project, 'installed-model-calls.log'), 'call\ncall\n');
      const report = (replay: boolean) => ({ run: { status: 'passed', results: [{ attempts: [{ steps: [{ api: 'agent.act', status: 'passed', cache: replay ? { mode: 'self-finalized', replayedActions: 2, totalActions: 2 } : { mode: 'missed', reason: 'no-entry' }, metrics: { modelCalls: replay ? 0 : 2 }, explanation: 'zero-turn' }] }] }] } });
      let runs = 0;
      // Evaluate only the actual generated configuration expression with inert model/engine values.
      // The SDK, browser, generated test and model implementation are never imported or executed.
      const fakeRun = async () => {
        const text = readFileSync(join(f.project, 'installed-cache.config.ts'), 'utf8');
        const config = new Function('web', 'model', text.replace(/^import[^\n]*\n/gm, '').replace('export default ', 'return '))(() => ({}), {});
        assert.equal(config.cache, 'read-write'); assert.equal(config.retries, 0);
        assert.equal(config.output, '.e2e/installed-cache-output'); assert.equal(config.tests, 'installed-cache-tests/*.e2e.ts');
        const output = path.resolve(f.project, defaultOutputMutation ? '.e2e' : config.output);
        const rel = path.relative(f.project, output); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
        const clearedResults = join(output, 'results');
        if (!defaultOutputMutation) {
          const hostFromResults = path.relative(clearedResults, hostRoot); const resultsFromHost = path.relative(hostRoot, clearedResults);
          assert.ok(hostFromResults.startsWith('..') && resultsFromHost.startsWith('..'), 'neither result tree contains the other');
        }
        // Same rm primitive/target shape as runner.ts; simulated cleanup, not a real run.
        rmSync(clearedResults, { recursive: true, force: true });
        const replay = runs++ === 1; return { exitCode: 0, status: 'passed', report: report(replay) };
      };
      const actualCache = new Function('mkdirSync', 'writeFileSync', 'run', 'assert', 'console', 'installedRunClosed', 'installedCacheFiles', 'readFileSync', 'readdirSync', 'resolvePath', 'statSync', `${cacheFunction}\nreturn installedCache;`)(
        (p: string) => mkdirSync(join(f.project, p)), (p: string, bytes: any) => writeFileSync(join(f.project, p), bytes), fakeRun, assert, { log: () => {} }, closed,
        () => ({ calls: { status: 'unknown', before: null, after: null, delta: null }, cache: { status: 'unknown', bytesEqual: null, mtimeEqual: null } }),
        (p: string, encoding?: any) => readFileSync(path.resolve(f.project, p), encoding), (p: string) => fs.readdirSync(join(f.project, p)), (...p: string[]) => path.resolve(f.project, ...p), (p: string) => fs.statSync(path.resolve(f.project, p)),
      );
      f.proof.coverage.cache = await actualCache('http://127.0.0.1:1234');
      assert.equal(runs, 2); assert.deepEqual(readFileSync(entry), originalCache); assert.equal(fs.statSync(entry).mtimeMs, originalMtime);
      if (defaultOutputMutation) {
        assert.equal(existsSync(hostRoot), false);
        assert.throws(() => validateInstalledPublicProof(f.proof, f.project, f.evidence, f.binding), { code: 'ENOENT' });
      } else {
        assert.deepEqual(readFileSync(screenshot), originalScreenshot);
        validateInstalledPublicProof(f.proof, f.project, f.evidence, f.binding);
        assert.equal(Object.keys(JSON.parse(readFileSync(join(f.evidence, 'installed-coverage-files.json'), 'utf8'))).length, 12);
        rmSync(hostRoot, { recursive: true });
        assert.throws(() => validateInstalledPublicProof(f.proof, f.project, f.evidence, f.binding), { code: 'ENOENT' }, 'missing host proof remains fatal even with isolated output');
      }
    } finally { f.close(); }
  }
});
