/** Fail closed on the original six checks plus #28's five installed public obligations. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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
