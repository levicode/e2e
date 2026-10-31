/** Fail closed on the original six checks plus #28's five installed public obligations. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { closeSync, constants, copyFileSync, fstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function validateInstalledPublicProof(value: unknown, project: string, evidence: string, encoderBinding: Record<string, unknown>): void {
  const proof = value as Record<string, any>;
  assert.equal(proof?.status, 'passed'); assert.equal(proof.checks, 11);
  for (const key of ['runtimeOverrideAbsent', 'publicBrowserActionPassed', 'callbackPassed', 'cleanupConfirmed', 'surfaceOfPassed', 'locateTapPassed']) assert.equal(proof[key], true, key);
  assert.equal(proof.report?.run?.status, 'passed');
  const coverage = proof.coverage;
  assert.ok(coverage && typeof coverage === 'object');
  const files: Record<string, { source: string; sha256: string; bytes: number }> = {};
  const retain = (file: unknown, name: string) => {
    assert.equal(typeof file, 'string');
    const absolute = realpathSync(resolve(project, file as string));
    const rel = relative(realpathSync(project), absolute);
    assert.ok(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'Proof escapes installed consumer');
    const bytes = readFileSync(absolute);
    files[name] = { source: absolute, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    copyFileSync(absolute, join(evidence, name));
    return bytes;
  };
  assert.equal(retain(proof.screenshotPath, 'installed-candidate.png').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  for (const pixels of [coverage.mask?.observation, coverage.mask?.artifact]) {
    assert.equal(pixels?.width, 640); assert.equal(pixels.height, 480);
    assert.deepEqual(pixels.protected, [0, 0, 0]); assert.deepEqual(pixels.public, [255, 0, 0]);
  }
  assert.deepEqual(coverage.mask.artifact.fresh, [0, 255, 0]);
  assert.equal(retain(coverage.mask.path, 'installed-mask.png').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const media = coverage.media;
  assert.equal(media?.frame?.width, 640); assert.equal(media.frame.height, 480);
  assert.ok(Number.isFinite(media.frame.padded) && media.frame.padded >= 0 && media.frame.padded < 0.01);
  assert.ok(Number.isFinite(media.frame.inked) && media.frame.inked > 0.01 && media.frame.inked <= 1);
  const video = retain(media.path, 'installed-video.webm'); assert.equal(video.length, media.bytes);
  assert.equal(video.subarray(0, 4).toString('hex'), '1a45dfa3');
  const encoderReceipt = JSON.parse(retain(media.encoderReceiptPath, 'installed-encoder-receipt.json').toString());
  validateEncoderReceipt(encoderReceipt, encoderBinding, media, createHash('sha256').update(video).digest('hex'));
  assert.deepEqual(JSON.parse(retain(media.encoderBindingPath, 'installed-encoder-binding.json').toString()), encoderBinding);
  for (const [name, hash] of Object.entries(encoderBinding['observerSources'] as Record<string, string>)) {
    assert.match(name, /^installed-encoder-(?:proof\.py|proc\.c)$/);
    assert.equal(createHash('sha256').update(retain(name, name)).digest('hex'), hash);
  }
  const download = coverage.download;
  assert.equal(download?.suggestedFilename, 'installed.bin');
  const downloaded = retain(download.absolutePath, 'installed-download.bin');
  assert.deepEqual(downloaded, Buffer.from('installed\nsynthetic download\u0000\u00ff\n')); assert.equal(download.bytes, downloaded.length);
  const state = coverage.state;
  assert.equal(state?.bootstrapRequests, 0);
  assert.deepEqual(state.restored, { phase: 'restored', first: { cookie: 'native-fixture=synthetic', local: 'stored' }, created: false, version: 3, indexes: ['byLabel'], record: { cycle: true, typedKind: 'Uint16Array', typed: [1, 65535], blob: 'fixture-payload', blobType: 'text/plain' } });
  assert.ok(JSON.parse(retain(state.path, 'installed-state.json').toString()));
  const cache = coverage.cache;
  assert.ok(cache?.recordedModelCalls > 0); assert.equal(cache.replayedModelCalls, 0); assert.equal(cache.replayedActions, 2); assert.equal(cache.entryUnchanged, true);
  assert.equal(JSON.parse(retain(cache.cachePath, 'installed-cache-entry.json').toString()).schemaVersion, 'trace-1');
  for (const [key, name, expected] of [['recordReport', 'installed-cache-record.report.json', 'missed'], ['replayReport', 'installed-cache-replay.report.json', 'self-finalized']] as const) {
    const report = JSON.parse(retain(cache[key], name).toString()); assert.equal(report.run.status, 'passed');
    const steps = report.run.results.flatMap((result: any) => result.attempts).flatMap((attempt: any) => attempt.steps).filter((step: any) => step.api === 'agent.act');
    assert.equal(steps.length, 1); assert.equal(steps[0].status, 'passed'); assert.equal(steps[0].cache.mode, expected);
    if (expected === 'self-finalized') { assert.equal(steps[0].cache.replayedActions, 2); assert.equal(steps[0].cache.totalActions, 2); assert.equal(steps[0].metrics.modelCalls, 0); assert.match(steps[0].explanation, /zero-turn/); }
    else { assert.equal(steps[0].cache.reason, 'no-entry'); assert.ok(steps[0].metrics.modelCalls > 0); }
  }
  writeFileSync(join(evidence, 'installed-coverage-files.json'), JSON.stringify(files, null, 2));
}

/** Same segment-aware boundary as the Linux clean-consumer gate; equality is not outside. */
export function outside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Real paths permit pnpm's in-project .pnpm store, but never checkout/external package links. */
export function assertInstalledConsumerIsolation(project: string, checkout: string, entries: readonly string[] = []): void {
  const projectRoot = realpathSync(project);
  assert.ok(outside(realpathSync(checkout), projectRoot), 'Installed consumer must be outside checkout');
  if (entries.length === 0) return;
  const modules = realpathSync(join(projectRoot, 'node_modules'));
  assert.ok(!outside(projectRoot, modules) && modules !== projectRoot, 'Consumer node_modules escapes project');
  for (const entry of entries) {
    const actual = realpathSync(entry);
    assert.ok(!outside(modules, actual) && actual !== modules, 'Installed package resolution escapes consumer node_modules');
  }
}

/** Acceptance material only: never changes PATH or the installed runtime selection. */
export function prepareInstalledEncoderProof(project: string, nativeExecutable: string, manifestSha256: string, manifest: { source: { commit: string; tree: string }; nativeSource: unknown; native: { sha256: string } }): Record<string, unknown> {
  const checkout = fileURLToPath(new URL('../..', import.meta.url));
  const git = (args: string[]): Buffer => {
    const result = spawnSync('git', ['-c', 'protocol.allow=never', '-C', checkout, ...args], { env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, shell: false, timeout: 10_000, maxBuffer: 1024 * 1024 });
    assert.equal(result.error, undefined, 'Verifier source identity unavailable');
    assert.equal(result.status, 0, 'Verifier source identity failed');
    return result.stdout;
  };
  const commit = git(['rev-parse', 'HEAD']).toString().trim();
  const tree = git(['rev-parse', 'HEAD^{tree}']).toString().trim();
  assert.match(commit, /^[a-f0-9]{40}$/); assert.match(tree, /^[a-f0-9]{40}$/);
  assert.equal(commit, manifest.source.commit, 'Installed verifier must use the same product commit');
  assert.equal(tree, manifest.source.tree, 'Installed verifier must use the same product tree');
  assert.equal(git(['status', '--porcelain', '--untracked-files=no']).length, 0, 'Verifier checkout has tracked edits');
  const verifierFiles: Record<string, string> = {};
  for (const name of ['installed-encoder-proof.py', 'installed-encoder-proc.c', 'installed-encoder-proof.test.py', 'fixtures/installed-candidate.mjs', 'candidate-installed.ts', 'candidate-runtime-install.ts', 'installed-public-proof.ts', 'installed-public-proof.test.ts']) {
    const bytes = readFileSync(new URL(name, import.meta.url));
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert.equal(createHash('sha256').update(git(['show', `HEAD:scripts/acceptance/${name}`])).digest('hex'), hash, 'Verifier bytes differ from its recorded commit');
    verifierFiles[`scripts/acceptance/${name}`] = hash;
  }
  const verifierSource = { commit, tree, files: verifierFiles };
  const observerSources: Record<string, string> = {};
  for (const name of ['installed-encoder-proof.py', 'installed-encoder-proc.c']) {
    const source = fileURLToPath(new URL(name, import.meta.url));
    copyFileSync(source, join(project, name));
    observerSources[name] = createHash('sha256').update(readFileSync(source)).digest('hex');
  }
  const native = realpathSync(nativeExecutable);
  assert.equal(createHash('sha256').update(readFileSync(native)).digest('hex'), manifest.native.sha256);
  let helperSha256: string | null = null;
  if (process.platform === 'darwin') {
    const helper = join(project, 'installed-encoder-proc');
    const compiled = spawnSync('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-Werror', join(project, 'installed-encoder-proc.c'), '-o', helper], { shell: false, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 });
    assert.equal(compiled.error, undefined, 'Mac encoder observer compiler unavailable');
    assert.equal(compiled.status, 0, 'Mac encoder observer compilation failed');
    helperSha256 = createHash('sha256').update(readFileSync(helper)).digest('hex');
  } else assert.equal(process.platform, 'linux');
  const binding = { schemaVersion: 1, platform: process.platform, arch: process.arch, nonce: randomUUID(), manifestSha256, source: manifest.source, verifierSource, nativeSource: manifest.nativeSource, nativeExecutable: native, nativeSha256: manifest.native.sha256, observerSources, helperSha256 };
  writeFileSync(join(project, 'installed-encoder-binding.json'), JSON.stringify(binding), { mode: 0o444, flag: 'wx' });
  return binding;
}

/** Receipt verification is synthetic-testable; only real owned observation can produce platform proof. */
export function validateEncoderReceipt(value: unknown, binding: Record<string, unknown>, media: Record<string, any>, webmSha256: string): void {
  const receipt = value as Record<string, any>;
  assert.equal(receipt?.schemaVersion, 1);
  assert.equal(receipt.proofKind, 'owned-execution-source-associated-media');
  assert.equal(receipt.limits, 'not-fd-byte-stream-proof');
  assert.deepEqual(receipt.binding, binding); assert.equal(receipt.nonce, binding['nonce']);
  const verifier = binding['verifierSource'] as { commit: string; tree: string; files: Record<string, string> };
  assert.match(verifier.commit, /^[a-f0-9]{40}$/); assert.match(verifier.tree, /^[a-f0-9]{40}$/);
  assert.equal(Object.keys(verifier.files).length, 8);
  assert.equal(verifier.commit, (binding['source'] as { commit: string }).commit);
  assert.equal(verifier.tree, (binding['source'] as { tree: string }).tree);
  for (const hash of Object.values(verifier.files)) assert.match(hash, /^[a-f0-9]{64}$/);
  assert.ok(['linux', 'darwin'].includes(receipt.platform));
  assert.equal(receipt.platform, binding['platform']); assert.equal(receipt.arch, binding['arch']);
  assert.deepEqual(Object.keys(binding['observerSources'] as object).toSorted(), ['installed-encoder-proc.c', 'installed-encoder-proof.py']);
  assert.equal(receipt.encoderGone, true); assert.equal(receipt.executableUnchanged, true);
  assert.equal(receipt.observerChildrenReaped, true);
  const { fixture, proxy, daemon, encoder } = receipt;
  for (const process of [fixture, proxy, daemon, encoder.process]) {
    for (const field of ['pid', 'ppid', 'uid', 'group', 'session']) assert.ok(Number.isSafeInteger(process[field]) && process[field] >= 0, field);
    assert.equal(typeof process.start, 'string'); assert.ok(process.start.length > 0);
    assert.ok(isAbsolute(process.exe));
    assert.equal(process.uid, fixture.uid);
  }
  assert.equal(new Set([fixture.pid, proxy.pid, daemon.pid, encoder.process.pid]).size, 4);
  assert.equal(proxy.ppid, fixture.pid); assert.equal(daemon.ppid, proxy.pid); assert.equal(encoder.process.ppid, daemon.pid);
  assert.equal(proxy.exe, binding['nativeExecutable']); assert.equal(daemon.exe, binding['nativeExecutable']);
  assert.equal(proxy.exeSha256, binding['nativeSha256']); assert.equal(daemon.exeSha256, binding['nativeSha256']);
  assert.match(receipt.encoderSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.version.executable, encoder.process.exe); assert.equal(receipt.version.sha256, receipt.encoderSha256);
  assert.deepEqual(receipt.version.argv, ['-version']); assert.match(receipt.version.firstLine, /^ffmpeg version [^\r\n]{1,1009}$/);
  assert.equal(encoder.argv[0], encoder.process.exe);
  const args: string[] = encoder.argv;
  assert.deepEqual(args.slice(1, 14), ['-y', '-hide_banner', '-loglevel', 'error', '-fpsprobesize', '0', '-probesize', '32', '-analyzeduration', '0', '-f', 'image2pipe', '-c:v']);
  assert.ok(['ppm', 'mjpeg', 'png'].includes(args[14]!));
  assert.equal(args[15], '-framerate'); assert.match(args[16]!, /^[1-9][0-9]*(?:\.[0-9]+)?$/);
  assert.deepEqual(args.slice(17, 20), ['-i', 'pipe:0', '-vf']);
  assert.match(args[20]!, /^(?:pad=ceil\(iw\/2\)\*2:ceil\(ih\/2\)\*2|scale=[1-9][0-9]*:[1-9][0-9]*:force_original_aspect_ratio=decrease,pad=ceil\([1-9][0-9]*\/2\)\*2:ceil\([1-9][0-9]*\/2\)\*2:0:0)$/);
  assert.deepEqual(args.slice(21, 33), ['-fps_mode', 'vfr', '-c:v', 'libvpx', '-crf', '18', '-b:v', '8000k', '-deadline', 'realtime', '-cpu-used', '4']);
  let tail = args.slice(33);
  if (tail[0] === '-fs') { assert.match(tail[1]!, /^[1-9][0-9]*$/); tail = tail.slice(2); }
  assert.equal(tail.length, 5); assert.deepEqual(tail.slice(0, 3), ['-pix_fmt', 'yuv420p', '-threads']); assert.ok(['1', '4'].includes(tail[3]!));
  assert.equal(tail[4], encoder.privateOutput); assert.ok(isAbsolute(encoder.privateOutput));
  assert.match(encoder.privateOutput, /\/agent-browser-action-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/video\.webm$/i);
  const times = [receipt.armed, receipt.ready, encoder.firstObserved, encoder.lastObserved, receipt.media.finished, receipt.finished];
  for (const time of times) assert.ok(Number.isSafeInteger(time) && time > 0);
  for (let index = 1; index < times.length; index++) assert.ok(times[index] >= times[index - 1], 'Encoder window order');
  assert.equal(receipt.media.nativeStopReturnedSuccessfully, true); assert.equal(receipt.media.decodedMediaPassed, true);
  assert.equal(receipt.media.nonce, binding['nonce']); assert.equal(receipt.media.segmentPath, 'video/video.webm');
  assert.equal(receipt.media.publicPath, media.path); assert.equal(receipt.media.webmSha256, webmSha256);
  assert.equal(receipt.media.runId, media.runId); assert.equal(receipt.media.attemptId, media.attemptId); assert.equal(receipt.media.startedAt, media.startedAt);
}

/** Acceptance environment prerequisite, not a product dependency or acceptance verdict. */
export const INSTALLED_AI_VERSION = '7.0.153';
export function installedConsumerMetadata() {
  return { name: 'native-candidate-installed-consumer', private: true, type: 'module', dependencies: { ai: INSTALLED_AI_VERSION } };
}

/** Resolve from the actual installed core, never import/execute the SDK or consult checkout helpers. */
export function inspectInstalledSdkPrerequisite(project: string, coreEntry: string) {
  const receipt = {
    schemaVersion: 1, evidence: 'sdk-prerequisite-not-acceptance', resolver: 'node-createRequire-core-entry',
    expectedVersion: INSTALLED_AI_VERSION, version: null as string | null,
    coreInsideConsumer: false, resolvedFromCore: false, sdkInsideConsumer: false, metadataInsideConsumer: false,
    versionMatches: false, consumerRun: 'unrun-at-prerequisite-check', status: 'failed', reason: 'core-unavailable',
  };
  try {
    const root = realpathSync(project); const core = realpathSync(coreEntry);
    receipt.coreInsideConsumer = core !== root && !outside(root, core);
    if (!receipt.coreInsideConsumer) { receipt.reason = 'core-outside-consumer'; return receipt; }
    receipt.reason = 'sdk-unresolved';
    const entry = realpathSync(createRequire(core).resolve('ai'));
    receipt.resolvedFromCore = true;
    receipt.sdkInsideConsumer = entry !== root && !outside(root, entry);
    if (!receipt.sdkInsideConsumer) { receipt.reason = 'sdk-outside-consumer'; return receipt; }
    receipt.reason = 'metadata-unavailable';
    let directory = dirname(entry);
    for (let depth = 0; depth < 16 && directory !== root && !outside(root, directory); depth++, directory = dirname(directory)) {
      const metadata = join(directory, 'package.json');
      let fd: number;
      try { fd = openSync(metadata, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; receipt.reason = 'metadata-invalid'; return receipt; }
      receipt.reason = 'metadata-invalid';
      const bytes = Buffer.alloc(65_537);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 65_536) { receipt.reason = 'metadata-invalid'; return receipt; }
        const canonical = realpathSync(metadata);
        if (outside(root, canonical)) { receipt.reason = 'metadata-outside-consumer'; return receipt; }
        receipt.metadataInsideConsumer = true;
        const length = readSync(fd, bytes, 0, bytes.length, 0);
        if (length > 65_536) { receipt.reason = 'metadata-invalid'; return receipt; }
        const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
        if (!value || typeof value !== 'object' || !('name' in value) || value.name !== 'ai' || !('version' in value) || typeof value.version !== 'string' || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value.version)) { receipt.reason = 'metadata-invalid'; return receipt; }
        receipt.version = value.version;
        receipt.versionMatches = value.version === INSTALLED_AI_VERSION;
        receipt.status = receipt.versionMatches ? 'verified' : 'failed';
        receipt.reason = receipt.versionMatches ? 'exact-peer-visible-from-core' : 'version-mismatch';
        return receipt;
      } finally { bytes.fill(0); closeSync(fd); }
    }
  } catch { /* Preserve only the closed stage reason; never serialize a path or arbitrary error. */ }
  return receipt;
}

/** Validate a retained prerequisite receipt without accepting it as browser/encoder evidence. */
export function validateInstalledSdkPrerequisite(value: unknown): ReturnType<typeof inspectInstalledSdkPrerequisite> {
  const fail = (): never => { throw new Error('Invalid installed SDK prerequisite receipt'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const r = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'evidence', 'resolver', 'expectedVersion', 'version', 'coreInsideConsumer', 'resolvedFromCore', 'sdkInsideConsumer', 'metadataInsideConsumer', 'versionMatches', 'consumerRun', 'status', 'reason'];
  if (Object.keys(r).length !== keys.length || keys.some(key => !Object.hasOwn(r, key))) return fail();
  if (r['schemaVersion'] !== 1 || r['evidence'] !== 'sdk-prerequisite-not-acceptance' || r['resolver'] !== 'node-createRequire-core-entry' || r['expectedVersion'] !== INSTALLED_AI_VERSION || r['consumerRun'] !== 'unrun-at-prerequisite-check') return fail();
  const flags = ['coreInsideConsumer', 'resolvedFromCore', 'sdkInsideConsumer', 'metadataInsideConsumer', 'versionMatches'];
  if (flags.some(key => typeof r[key] !== 'boolean')) return fail();
  if (r['version'] !== null && (typeof r['version'] !== 'string' || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(r['version']))) return fail();
  const reasons = ['core-unavailable', 'core-outside-consumer', 'sdk-unresolved', 'sdk-outside-consumer', 'metadata-unavailable', 'metadata-invalid', 'metadata-outside-consumer', 'version-mismatch', 'exact-peer-visible-from-core'];
  if (typeof r['reason'] !== 'string' || !reasons.includes(r['reason']) || !['verified', 'failed'].includes(r['status'] as string)) return fail();
  if ((r['resolvedFromCore'] && !r['coreInsideConsumer']) || (r['sdkInsideConsumer'] && !r['resolvedFromCore']) || (r['metadataInsideConsumer'] && !r['sdkInsideConsumer'])) return fail();
  if (r['version'] !== null && !r['metadataInsideConsumer']) return fail();
  if (r['versionMatches'] !== (r['version'] === INSTALLED_AI_VERSION)) return fail();
  const verified = flags.every(key => r[key] === true) && r['version'] === INSTALLED_AI_VERSION;
  if ((r['status'] === 'verified') !== verified || (r['reason'] === 'exact-peer-visible-from-core') !== verified) return fail();
  if ((r['reason'] === 'version-mismatch') !== (r['version'] !== null && r['version'] !== INSTALLED_AI_VERSION)) return fail();
  return value as ReturnType<typeof inspectInstalledSdkPrerequisite>;
}

export const INSTALLED_RUN_DIAGNOSTIC_ENUMS = {
  "codes": [
    "ACTION_FAILED",
    "ACTION_MAY_HAVE_COMMITTED",
    "APP_ALREADY_RUNNING",
    "APP_NOT_OPEN",
    "APP_UNREACHABLE",
    "ASSERTION_FAILED",
    "ASSERTION_INCONCLUSIVE",
    "AUTHENTICATION_FAILED",
    "AUTH_CREDENTIAL_INVALID",
    "AUTH_CREDENTIAL_UNAVAILABLE",
    "AUTOMATION_UNSUPPORTED",
    "CANCELLED",
    "CLEANUP_TIMEOUT",
    "COLLECTION_ERROR",
    "COLLECTION_FAILED",
    "CONFIG_AMBIGUOUS",
    "CONFIG_LOAD_FAILED",
    "CONFIG_NOT_FOUND",
    "CONTEXT_OVERFLOW",
    "ENGINE_FAILURE",
    "ENVIRONMENT_UNAVAILABLE",
    "ERROR",
    "FRAME_AMBIGUOUS",
    "FRAME_NOT_FOUND",
    "INTERRUPTED",
    "INVALID_ARGUMENT",
    "INVALID_CONFIG",
    "INVALID_GLOB",
    "INVALID_STATE",
    "LAUNCH_TIMEOUT",
    "LOCATOR_AMBIGUOUS",
    "LOCATOR_NOT_FOUND",
    "MODEL_OUTPUT_INVALID",
    "MODEL_PROVIDER_FAILED",
    "MODEL_REFUSED",
    "MODEL_UNAVAILABLE",
    "NODE_STALE",
    "NOT_ACTIONABLE",
    "NO_TESTS",
    "NO_TESTS_FOUND",
    "OPERATION_TIMEOUT",
    "POLICY_DENIED",
    "REPLAY_STALE",
    "REPORT_WRITE_FAILED",
    "RUNNER_BUSY",
    "SECRET_UNAVAILABLE",
    "SEED_DATA_MISSING",
    "SESSION_CONTRACT",
    "STEP_BUDGET_EXHAUSTED",
    "STEP_NO_CONCLUSION",
    "STEP_TIMEOUT",
    "TEST_SETUP_FAILED",
    "TEST_TIMEOUT",
    "UNHANDLED_REJECTION",
    "UNSUPPORTED_CAPABILITY"
  ],
  "categories": [
    "test",
    "configuration",
    "infrastructure",
    "internal",
    "interrupted"
  ],
  "phases": [
    "config",
    "collection",
    "filter",
    "launch",
    "beforeAll",
    "beforeEach",
    "body",
    "afterEach",
    "afterAll",
    "cleanup",
    "report"
  ],
  "runStatuses": [
    "passed",
    "failed",
    "blocked",
    "error",
    "interrupted"
  ],
  "stepStatuses": [
    "passed",
    "failed",
    "blocked",
    "timed-out",
    "cancelled"
  ],
  "cacheModes": [
    "self-finalized",
    "agent-concluded",
    "missed"
  ],
  "cacheReasons": [
    "retry",
    "no-entry",
    "invalid-entry",
    "truncated",
    "wrong-context",
    "gap",
    "target-not-found",
    "target-ambiguous",
    "viewport-changed",
    "action-failed",
    "action-uncertain",
    "end-mismatch"
  ],
  "eventKinds": [
    "poll",
    "observation",
    "model",
    "policy",
    "engine",
    "schema",
    "navigation"
  ],
  "eventNames": [
    "back",
    "check",
    "dismissKeyboard",
    "doubleTap",
    "dragTo",
    "hover",
    "hoverAt",
    "longPress",
    "navigate",
    "press",
    "pressKey",
    "scroll",
    "scrollIntoView",
    "scrollUntil",
    "secondaryTap",
    "selectOption",
    "setInputFiles",
    "tap",
    "tapAt",
    "type",
    "typeSecret",
    "typeText",
    "uncheck",
    "vision.pixels",
    "secret.registered",
    "secret.sink",
    "secret.purpose",
    "secret.fill",
    "relocate",
    "page",
    "waitFor",
    "upload.path"
  ],
  "eventStatuses": [
    "passed",
    "failed",
    "cancelled"
  ]
} as const;

/** Closed partial diagnostic only. This never grants installed acceptance. */
export function validateInstalledRunClosed(value: unknown): Record<string, any> {
  const fail = (): never => { throw new Error('Invalid installed run closed diagnostic'); };
  const object = (v: unknown, keys: string[]): Record<string, any> => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail();
    const actual = Object.keys(v).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) return fail();
    return v as Record<string, any>;
  };
  const member = (v: unknown, values: readonly unknown[]) => { if (!values.includes(v)) fail(); };
  const count = (v: unknown, max: number, nullable = true) => {
    if (nullable && v === null) return;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) fail();
  };
  const duration = (v: unknown) => { if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 86_400_000)) fail(); };
  const array = (v: unknown, max: number): any[] => { if (!Array.isArray(v) || v.length > max || Object.keys(v).length !== v.length || !Array.from({ length: v.length }, (_, i) => Object.hasOwn(v, i)).every(Boolean)) return fail(); return v; };
  const e = INSTALLED_RUN_DIAGNOSTIC_ENUMS;
  try {
    const r = object(value, ['schemaVersion', 'evidence', 'stage', 'projection', 'exitCode', 'status', 'resultCount', 'truncated', 'errors', 'steps', 'files']);
    if (r.schemaVersion !== 2 || r.evidence !== 'partial-diagnostic-not-acceptance') fail();
    member(r.stage, ['record', 'replay']); member(r.projection, ['complete', 'failed']);
    member(r.exitCode, [0, 1, 2, 3, 4, 130, null]); member(r.status, [...e.runStatuses, 'unknown']);
    count(r.resultCount, 16); member(r.truncated, [true, false]);
    for (const raw of array(r.errors, 32)) {
      const item = object(raw, ['scope', 'resultIndex', 'attemptIndex', 'stepIndex', 'code', 'category', 'phase']);
      member(item.scope, ['run', 'attempt', 'secondary', 'step']);
      member(item.code, [...e.codes, 'other']); member(item.category, [...e.categories, 'unknown']); member(item.phase, [...e.phases, 'unknown']);
      if (item.scope === 'run') { if (item.resultIndex !== null || item.attemptIndex !== null || item.stepIndex !== null) fail(); }
      else {
        count(item.resultIndex, 15, false); count(item.attemptIndex, 3, false);
        if (r.resultCount === null || item.resultIndex >= r.resultCount) fail();
        if (item.scope === 'step') count(item.stepIndex, 63, false); else if (item.stepIndex !== null) fail();
      }
    }
    let totalEvents = 0; const identities = new Set<string>();
    for (const raw of array(r.steps, 16)) {
      const step = object(raw, ['resultIndex', 'attemptIndex', 'stepIndex', 'api', 'status', 'durationMs', 'cache', 'metrics', 'eventsState', 'eventsTruncated', 'events']);
      count(step.resultIndex, 15, false); count(step.attemptIndex, 3, false); count(step.stepIndex, 63, false);
      if (r.resultCount === null || step.resultIndex >= r.resultCount || step.api !== 'agent.act') fail();
      const identity = `${step.resultIndex}:${step.attemptIndex}:${step.stepIndex}`;
      if (identities.has(identity)) fail(); identities.add(identity);
      member(step.status, [...e.stepStatuses, 'unknown']); duration(step.durationMs);
      const cache = object(step.cache, ['mode', 'reason', 'replayedActions', 'totalActions']);
      member(cache.mode, [...e.cacheModes, 'unknown']); member(cache.reason, [...e.cacheReasons, 'unknown']); count(cache.replayedActions, 1_000_000); count(cache.totalActions, 1_000_000);
      const metrics = object(step.metrics, ['modelCalls']); count(metrics.modelCalls, 1_000_000);
      member(step.eventsState, ['recorded', 'unknown']); member(step.eventsTruncated, [true, false]);
      const events = array(step.events, 64);
      if (step.eventsState === 'unknown' && (events.length !== 0 || step.eventsTruncated)) fail();
      if (step.eventsTruncated && !r.truncated) fail();
      totalEvents += events.length; if (totalEvents > 64) fail();
      events.forEach((rawEvent, index) => {
        const event = object(rawEvent, ['eventIndex', 'kind', 'name', 'code', 'status', 'durationMs']);
        if (event.eventIndex !== index) fail();
        member(event.kind, [...e.eventKinds, 'unknown']); member(event.name, [...e.eventNames, 'other', 'unknown']);
        member(event.code, [...e.codes, 'other', 'unknown']); member(event.status, [...e.eventStatuses, 'unknown']); duration(event.durationMs);
      });
    }
    const files = object(r.files, ['calls', 'cache']);
    const calls = object(files.calls, ['status', 'before', 'after', 'delta']);
    member(calls.status, ['verified', 'unknown']);
    if (calls.status === 'unknown') { if (calls.before !== null || calls.after !== null || calls.delta !== null) fail(); }
    else { count(calls.before, 209_715, false); count(calls.after, 209_715, false); count(calls.delta, 209_715, false); if (calls.after - calls.before !== calls.delta) fail(); }
    const cache = object(files.cache, ['status', 'bytesEqual', 'mtimeEqual']); member(cache.status, ['verified', 'unknown']);
    if (cache.status === 'unknown') { if (cache.bytesEqual !== null || cache.mtimeEqual !== null) fail(); }
    else { member(cache.bytesEqual, [true, false]); member(cache.mtimeEqual, [true, false]); }
    if (r.stage === 'record' && (calls.status !== 'unknown' || cache.status !== 'unknown')) fail();
    if (r.projection === 'failed' && (r.exitCode !== null || r.status !== 'unknown' || r.resultCount !== null || r.truncated || r.errors.length || r.steps.length || calls.status !== 'unknown' || cache.status !== 'unknown')) fail();
    return r;
  } catch { return fail(); }
}
