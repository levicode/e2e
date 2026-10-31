/** Fail closed on the original six checks plus #28's five installed public obligations. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function validateInstalledPublicProof(value: unknown, project: string, evidence: string): void {
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
