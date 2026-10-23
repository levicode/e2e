import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLEANUP_ENV, CLEANUP_BYTES, cleanCleanupEnvironment, collectCleanupCapture, inspectCleanupBytes, prepareCleanupCapture, validCleanupRecord } from './candidate-cleanup-diagnostics.ts';
const binding = { sourceRevision: 'a'.repeat(40), nativeSourceRevision: 'b'.repeat(40), testSourceDigest: 'c'.repeat(64), binarySha256: 'd'.repeat(64), collectorSha256: 'e'.repeat(64) };
function record(phase: string, ordinal: number, facts = {}) { return { schemaVersion: 2, source: 'native', pid: 42, record: ordinal, operationSeq: phase.startsWith('Capture') ? 0 : 7, phase, droppedBefore: 0, emittedBefore: ordinal, suppressedBefore: 0, overflow: false, ...(phase.startsWith('Cleanup') ? { generation: 1, cleanupOwner: 1, cleanupAttempt: 1, cleanupLifecycle: 'scope-end' } : {}), ...facts }; }
const lines = (...records: unknown[]) => Buffer.from(records.map(value => JSON.stringify(value) + '\n').join(''));
function completed() { return [record('CaptureStarted', 0), record('CleanupStarted', 1), record('CleanupFirstFailure', 2, { cleanupComponent: 'dialog' }), record('CleanupResult', 3, { cleanupResult: 'failed', error: 'cleanup-failed' })]; }
function directory(t: { after(fn: () => void): void }) { const dir = mkdtempSync(join(tmpdir(), 'cleanup-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
test('disabled environment removes inherited path without mutating caller', () => { const original = { [CLEANUP_ENV]: '/untrusted', KEEP: 'yes' }; assert.deepEqual(cleanCleanupEnvironment(original), { KEEP: 'yes' }); assert.equal(original[CLEANUP_ENV], '/untrusted'); });
test('closed schema rejects payloads, arbitrary components and error messages', () => {
  for (const item of completed()) assert.equal(validCleanupRecord(item), true);
  for (const item of [record('CleanupStarted', 1, { url: 'private' }), record('CleanupFirstFailure', 2, { cleanupComponent: 'private' }), record('CleanupResult', 3, { cleanupResult: 'failed', error: 'private' }), record('CleanupResult', 3, { cleanupResult: 'passed', error: 'cleanup-failed' }), record('CleanupStarted', 1, { cleanupOwner: 0 })]) assert.equal(validCleanupRecord(item), false);
});
test('original failed lifecycle is complete evidence, not a passing product result', () => { const result = inspectCleanupBytes(lines(...completed())); assert.equal(result.status, 'complete-observed-snapshots'); assert.equal(result.records.at(-1)!.cleanupResult, 'failed'); });
test('empty, truncated, dropped, overflow and missing terminal remain unknown', () => {
  for (const bytes of [Buffer.alloc(0), lines(...completed()).subarray(0, -1), lines(record('CaptureStarted', 0), record('CleanupStarted', 1)), lines(...completed().map((item, index) => index === 3 ? { ...item, droppedBefore: 1 } : item)), lines(...completed().map((item, index) => index === 3 ? { ...item, overflow: true } : item)), lines(record('CaptureLimitReached', 0)), Buffer.alloc(CLEANUP_BYTES + 1)]) assert.equal(inspectCleanupBytes(bytes).status, 'unknown');
});
test('duplicate PID/start, changed identity and out of order facts remain unknown', () => {
  for (const values of [[...completed(), record('CaptureStarted', 0)], [record('CaptureStarted', 0), record('CleanupStarted', 1), record('CleanupResult', 2, { generation: 2, cleanupResult: 'passed' })], [record('CleanupStarted', 0), record('CleanupResult', 1, { cleanupResult: 'passed' })]]) assert.equal(inspectCleanupBytes(lines(...values)).status, 'unknown');
});
test('independent process records can interleave without inventing case association', () => { const a = completed(); const b = completed().map(item => ({ ...item, pid: 43 })); assert.equal(inspectCleanupBytes(lines(...a.flatMap((item, index) => [item, b[index]]))).status, 'complete-observed-snapshots'); });
test('collector persists closed failure evidence with binding after failed functional suite', t => {
  const out = directory(t); const capture = prepareCleanupCapture(binding, {}); appendFileSync(capture.file, lines(...completed()));
  const result = collectCleanupCapture(out, 'web-browser', capture, true); assert.equal(result.status, 'complete-observed-snapshots');
  const saved = JSON.parse(readFileSync(join(out, 'web-browser.cleanup-diagnostics.json'), 'utf8')); assert.equal(saved.releaseEligible, false); assert.equal(saved.caseAssociation, 'unproven'); assert.equal(saved.processCoverage, 'unproven'); assert.deepEqual(saved.binding, binding); assert.equal(saved.records.at(-1).error, 'cleanup-failed');
});
test('source mutation cannot produce complete evidence', t => { const out = directory(t); const capture = prepareCleanupCapture(binding, {}); appendFileSync(capture.file, lines(...completed())); assert.equal(collectCleanupCapture(out, 'web-browser', capture, false).status, 'unknown'); });
test('symlink replacement and oversized raw files are refused', t => {
  const out = directory(t); const target = join(out, 'secret'); writeFileSync(target, 'private marker');
  const capture = prepareCleanupCapture(binding, {}); unlinkSync(capture.file); symlinkSync(target, capture.file); assert.equal(collectCleanupCapture(out, 'web-browser', capture, true).status, 'unknown');
  const huge = prepareCleanupCapture(binding, {}); writeFileSync(huge.file, Buffer.alloc(CLEANUP_BYTES + 1)); assert.equal(collectCleanupCapture(out, 'public-callbacks', huge, true).status, 'unknown');
});
test('invalid record content never enters collected artifact', t => { const out = directory(t); const capture = prepareCleanupCapture(binding, {}); appendFileSync(capture.file, '{"url":"private-marker"}\n'); const result = collectCleanupCapture(out, 'web-browser', capture, true); assert.equal(result.status, 'unknown'); assert.ok(!readFileSync(join(out, 'web-browser.cleanup-diagnostics.json'), 'utf8').includes('private-marker')); });
test('collector write failure never throws over original outcome', t => { const out = directory(t); const capture = prepareCleanupCapture(binding, {}); appendFileSync(capture.file, lines(...completed())); writeFileSync(join(out, 'web-browser.cleanup-diagnostics.json'), 'existing'); assert.equal(collectCleanupCapture(out, 'web-browser', capture, true).status, 'unknown'); });

test('parsed arrays and objects cannot impersonate closed string fields or terminal results', () => {
  for (const field of ['phase', 'cleanupLifecycle', 'cleanupComponent', 'cleanupResult']) {
    const original = field === 'cleanupComponent' ? record('CleanupFirstFailure', 2, { cleanupComponent: 'dialog' }) : record('CleanupResult', 2, { cleanupResult: 'passed' });
    for (const replacement of [[original[field as keyof typeof original]], { toString: 'CleanupResult' }]) {
      const changed = JSON.parse(JSON.stringify({ ...original, [field]: replacement }));
      assert.equal(validCleanupRecord(changed), false);
      assert.equal(inspectCleanupBytes(lines(record('CaptureStarted', 0), record('CleanupStarted', 1), changed)).status, 'unknown');
    }
  }
  const omitted = { ...record('CleanupResult', 2), phase: ['CleanupResult'] };
  assert.equal(validCleanupRecord(omitted), false);
});

test('concurrent growth cannot make the collector read beyond its fixed byte cap', t => {
  const out = directory(t); const capture = prepareCleanupCapture(binding, {}); appendFileSync(capture.file, lines(...completed()));
  const original = fs.readSync; let observedLimit = 0;
  t.mock.method(fs, 'readSync', ((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    observedLimit = length; appendFileSync(capture.file, Buffer.alloc(CLEANUP_BYTES));
    return original(fd, buffer, offset, length, position);
  }) as typeof fs.readSync); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(collectCleanupCapture(out, 'web-browser', capture, true).status, 'unknown');
  assert.equal(observedLimit, CLEANUP_BYTES + 1);
});
