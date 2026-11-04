import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { retainSyntheticCallbackScreenshot, SYNTHETIC_CALLBACK_SCREENSHOT_ENV, SYNTHETIC_CALLBACK_SCREENSHOT_FILE } from '../../packages/e2e/tests/helpers/synthetic-callback-screenshot.ts';
import { SYNTHETIC_BATCH_ENV, SYNTHETIC_BINDING_ENV } from '../../packages/web/tests/helpers/synthetic-evidence.ts';

/** Invented image bytes for helper verification, not browser execution evidence. */
function chunk(kind: string, data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0); result.write(kind, 4, 'ascii'); data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4);
  return result;
}
function png(width = 2, height = 2, pixels = Buffer.alloc((width * 3 + 1) * height)): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
/** The same fixed source, report location and one failure-artifact relationship as the integration hook. */
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'callback-screenshot-unit-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const output = join(root, 'output'); mkdirSync(output);
  const relative = 'callbacks-route-callback-reads-the-live-page-abcd1234/attempt-1/screenshots/001-failure.png';
  const original = join(project, '.e2e/results', relative); mkdirSync(dirname(original), { recursive: true });
  const bytes = png(); writeFileSync(original, bytes);
  const artifact: { id: string; kind: string; mediaType: string; redaction: string; path?: string; url?: string; ref?: string; size?: number; sha256?: string } = {
    id: 'attempt:artifact:0', kind: 'screenshot', mediaType: 'image/png', redaction: 'complete', path: relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const attempt = { index: 0, status: 'failed', failure: { screenshot: artifact.id }, artifacts: [artifact] };
  const result = { kind: 'test', file: 'tests/callbacks.e2e.ts', titlePath: ['route callback reads the live page while evaluate awaits fetch'], selected: true, repeat: 0, status: 'failed', attempts: [attempt] };
  const outcome = { reportPath: join(project, '.e2e/report.json'), config: { projectRoot: project, output: join(project, '.e2e') }, report: { run: { results: [result] } } };
  const target = join(output, SYNTHETIC_CALLBACK_SCREENSHOT_FILE);
  const env: NodeJS.ProcessEnv = {
    [SYNTHETIC_CALLBACK_SCREENSHOT_ENV]: target,
    [SYNTHETIC_BATCH_ENV]: '1',
    [SYNTHETIC_BINDING_ENV]: JSON.stringify({ runId: 'a'.repeat(32), suite: 'public-callbacks', sourceRevision: 'b'.repeat(40), testSourceDigest: 'c'.repeat(64), binarySha256: 'd'.repeat(64) }),
  };
  const replaceBytes = (value: Buffer) => {
    writeFileSync(original, value); artifact.size = value.length; artifact.sha256 = createHash('sha256').update(value).digest('hex');
  };
  return { root, project, output, original, bytes, artifact, attempt, result, outcome, target, env, replaceBytes, retain: () => retainSyntheticCallbackScreenshot(project, outcome, env) };
}

test('retains exactly the original C03 failure PNG before cleanup, without changing report or source', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t); const report = JSON.stringify(f.outcome);
  writeFileSync(join(dirname(f.original), '002-unrelated.png'), 'not retained');
  f.attempt.artifacts.push({ ...f.artifact, id: 'other', path: f.artifact.path!.replace('001-failure', '002-unrelated') });
  const withUnrelated = JSON.stringify(f.outcome);
  assert.equal(f.retain(), true); assert.deepEqual(readFileSync(f.target), f.bytes);
  assert.equal(statSync(f.target).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(f.original), f.bytes); assert.equal(JSON.stringify(f.outcome), withUnrelated);
  assert.notEqual(report, withUnrelated);
  rmSync(f.project, { recursive: true });
  assert.deepEqual(readFileSync(f.target), f.bytes); assert.equal(existsSync(join(f.output, '002-unrelated.png')), false);
});

test('requires an explicit synthetic public-callbacks binding and fixed absolute target', async t => {
  for (const mutation of [
    (f: ReturnType<typeof fixture>) => { delete f.env[SYNTHETIC_CALLBACK_SCREENSHOT_ENV]; },
    (f: ReturnType<typeof fixture>) => { delete f.env[SYNTHETIC_BATCH_ENV]; },
    (f: ReturnType<typeof fixture>) => { f.env[SYNTHETIC_BINDING_ENV] = '{'; },
    (f: ReturnType<typeof fixture>) => { f.env[SYNTHETIC_BINDING_ENV] = f.env[SYNTHETIC_BINDING_ENV]!.replace('public-callbacks', 'web-browser'); },
    (f: ReturnType<typeof fixture>) => { f.env[SYNTHETIC_CALLBACK_SCREENSHOT_ENV] = 'public-callbacks-C03-failure.png'; },
    (f: ReturnType<typeof fixture>) => { f.env[SYNTHETIC_CALLBACK_SCREENSHOT_ENV] = join(f.output, 'other.png'); },
    (f: ReturnType<typeof fixture>) => { f.env[SYNTHETIC_CALLBACK_SCREENSHOT_ENV] = `${f.output}/../output/${SYNTHETIC_CALLBACK_SCREENSHOT_FILE}`; },
    (f: ReturnType<typeof fixture>) => { f.env[SYNTHETIC_CALLBACK_SCREENSHOT_ENV] = join(f.project, SYNTHETIC_CALLBACK_SCREENSHOT_FILE); },
  ]) await t.test('rejects incomplete or redirected opt-in', st => { const f = fixture(st); mutation(f); assert.equal(f.retain(), false); assert.equal(existsSync(f.target), false); });
});

test('only the exact unique failed C03 result and its original failure artifact qualify', async t => {
  for (const mutation of [
    (f: ReturnType<typeof fixture>) => { f.result.file = 'tests/business.e2e.ts'; },
    (f: ReturnType<typeof fixture>) => { f.result.titlePath = ['different callback']; },
    (f: ReturnType<typeof fixture>) => { f.result.status = 'passed'; },
    (f: ReturnType<typeof fixture>) => { f.result.selected = false; },
    (f: ReturnType<typeof fixture>) => { f.result.repeat = 1; },
    (f: ReturnType<typeof fixture>) => { f.attempt.status = 'passed'; },
    (f: ReturnType<typeof fixture>) => { f.attempt.failure.screenshot = 'unrelated'; },
    (f: ReturnType<typeof fixture>) => { f.outcome.report.run.results.push(f.result); },
    (f: ReturnType<typeof fixture>) => { f.result.attempts.push(f.attempt); },
    (f: ReturnType<typeof fixture>) => { f.attempt.artifacts.push(f.artifact); },
    (f: ReturnType<typeof fixture>) => { f.artifact.kind = 'download'; },
    (f: ReturnType<typeof fixture>) => { f.artifact.mediaType = 'image/jpeg'; },
    (f: ReturnType<typeof fixture>) => { f.artifact.redaction = 'incomplete'; },
    (f: ReturnType<typeof fixture>) => { f.artifact.url = 'https://example.invalid/failure.png'; },
    (f: ReturnType<typeof fixture>) => { f.artifact.ref = 'remote-file'; },
    (f: ReturnType<typeof fixture>) => { f.outcome.config.projectRoot = f.root; },
    (f: ReturnType<typeof fixture>) => { f.outcome.config.output = f.output; },
    (f: ReturnType<typeof fixture>) => { f.outcome.reportPath = join(f.output, 'report.json'); },
  ]) await t.test('rejects changed evidence identity', st => { const f = fixture(st); mutation(f); assert.equal(f.retain(), false); assert.equal(existsSync(f.target), false); });
});

test('rejects source traversal, unexpected names and URL paths without copying', async t => {
  for (const path of ['../failure.png', '/tmp/failure.png', 'https://example.invalid/failure.png', 'file:///tmp/failure.png', 'owner/../owner/attempt-1/screenshots/001-failure.png', 'owner\\attempt-1\\screenshots\\001-failure.png', 'owner/attempt-1/screenshots/001-failure.jpg', 'owner/attempt-1/screenshots/001-other.png']) {
    await t.test(path, st => { const f = fixture(st); f.artifact.path = path; assert.equal(f.retain(), false); assert.equal(existsSync(f.target), false); });
  }
});

test('rejects source leaf symlinks, hardlinks and symlinked artifact ancestors', async t => {
  await t.test('leaf symlink', st => { const f = fixture(st); const elsewhere = join(f.root, 'outside.png'); writeFileSync(elsewhere, f.bytes); rmSync(f.original); symlinkSync(elsewhere, f.original); assert.equal(f.retain(), false); });
  await t.test('hardlink', st => { const f = fixture(st); linkSync(f.original, join(f.root, 'alias.png')); assert.equal(f.retain(), false); });
  await t.test('ancestor symlink', st => {
    const f = fixture(st); const elsewhere = join(f.root, 'elsewhere'); mkdirSync(elsewhere); writeFileSync(join(elsewhere, '001-failure.png'), f.bytes);
    rmSync(dirname(f.original), { recursive: true }); symlinkSync(elsewhere, dirname(f.original)); assert.equal(f.retain(), false);
  });
});

test('never overwrites an existing target, follows its symlink, or follows its parent symlink', async t => {
  await t.test('existing target', st => { const f = fixture(st); writeFileSync(f.target, 'original'); assert.equal(f.retain(), false); assert.equal(readFileSync(f.target, 'utf8'), 'original'); });
  await t.test('target symlink', st => { const f = fixture(st); symlinkSync(f.original, f.target); assert.equal(f.retain(), false); assert.deepEqual(readFileSync(f.original), f.bytes); });
  await t.test('parent symlink', st => { const f = fixture(st); const alias = join(f.root, 'alias'); symlinkSync(f.output, alias); f.env[SYNTHETIC_CALLBACK_SCREENSHOT_ENV] = join(alias, SYNTHETIC_CALLBACK_SCREENSHOT_FILE); assert.equal(f.retain(), false); assert.equal(existsSync(f.target), false); });
  await t.test('second retention', { skip: process.platform !== 'linux' }, st => { const f = fixture(st); assert.equal(f.retain(), true); assert.equal(f.retain(), false); assert.deepEqual(readFileSync(f.target), f.bytes); });
});

test('a concurrent output-parent replacement never redirects the write and removes only its anchored file', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t); const displaced = join(f.root, 'displaced-output'); const elsewhere = join(f.root, 'unrelated-directory'); mkdirSync(elsewhere);
  const open = fs.openSync; let replaced = false;
  fs.openSync = ((path, flags, mode) => {
    if (typeof path === 'string' && path.startsWith('/proc/self/fd/') && path.endsWith(`/${SYNTHETIC_CALLBACK_SCREENSHOT_FILE}`)) {
      replaced = true; renameSync(f.output, displaced); symlinkSync(elsewhere, f.output);
    }
    return open(path, flags, mode);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    assert.equal(f.retain(), false); assert.equal(replaced, true);
    assert.equal(existsSync(join(elsewhere, SYNTHETIC_CALLBACK_SCREENSHOT_FILE)), false);
    assert.equal(existsSync(join(displaced, SYNTHETIC_CALLBACK_SCREENSHOT_FILE)), false);
    assert.deepEqual(readFileSync(f.original), f.bytes);
  } finally { fs.openSync = open; syncBuiltinESMExports(); }
});

test('requires exact measured length/hash and a bounded complete PNG with bounded decoded pixels', async t => {
  for (const mutation of [
    (f: ReturnType<typeof fixture>) => { delete f.artifact.sha256; },
    (f: ReturnType<typeof fixture>) => { f.artifact.sha256 = 'f'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { delete f.artifact.size; },
    (f: ReturnType<typeof fixture>) => { f.artifact.size!++; },
    (f: ReturnType<typeof fixture>) => { f.artifact.size = 2 * 1024 * 1024 + 1; },
    (f: ReturnType<typeof fixture>) => { f.replaceBytes(Buffer.alloc(2 * 1024 * 1024 + 1)); },
    (f: ReturnType<typeof fixture>) => { f.replaceBytes(Buffer.from('not a png')); },
    (f: ReturnType<typeof fixture>) => { f.replaceBytes(f.bytes.subarray(0, -1)); },
    (f: ReturnType<typeof fixture>) => { const corrupt = Buffer.from(f.bytes); corrupt[29] = corrupt[29]! ^ 1; f.replaceBytes(corrupt); },
    (f: ReturnType<typeof fixture>) => { f.replaceBytes(Buffer.concat([f.bytes, Buffer.from('extra')])); },
    (f: ReturnType<typeof fixture>) => { f.replaceBytes(png(4097, 1, Buffer.alloc(0))); },
    (f: ReturnType<typeof fixture>) => { f.replaceBytes(png(4096, 4096, Buffer.alloc(0))); },
    (f: ReturnType<typeof fixture>) => { f.replaceBytes(png(0, 1, Buffer.alloc(0))); },
    (f: ReturnType<typeof fixture>) => { f.replaceBytes(png(2, 2, Buffer.alloc(0))); },
    (f: ReturnType<typeof fixture>) => { f.replaceBytes(png(2, 2, Buffer.alloc(1_000_000))); },
    (f: ReturnType<typeof fixture>) => { const pixels = Buffer.alloc(14); pixels[0] = 5; f.replaceBytes(png(2, 2, pixels)); },
  ]) await t.test('rejects malformed or unbounded image', st => { const f = fixture(st); mutation(f); assert.equal(f.retain(), false); assert.equal(existsSync(f.target), false); });
});

test('unavailable retention never changes the original assertion or prevents cleanup', t => {
  const f = fixture(t); const originalFailure = new Error('original C03 failure'); let cleaned = false;
  rmSync(f.original);
  assert.throws(() => {
    try { throw originalFailure; }
    finally { assert.equal(f.retain(), false); rmSync(f.project, { recursive: true }); cleaned = true; }
  }, error => error === originalFailure);
  assert.equal(cleaned, true); assert.equal(existsSync(f.project), false);
  assert.equal(retainSyntheticCallbackScreenshot(undefined, undefined, f.env), false);
});

test('integration hook preserves the original cleanup and assertions and runs retention first', () => {
  const source = readFileSync(new URL('../../packages/e2e/tests/integration/web-callback-contract.test.ts', import.meta.url), 'utf8');
  assert.match(source, /afterAll\(async \(\) => \{\s+retainSyntheticCallbackScreenshot\(project\?\.dir, outcome\);\s+project\?\.cleanup\(\);/);
  assert.match(source, /expect\(result.status, JSON.stringify\(\{ errors: outcome.report.run.errors, attempts: result.attempts \}\)\).toBe\('passed'\);/);
});
