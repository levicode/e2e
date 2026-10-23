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

function inventory(ordinal: number, facts: Record<string, unknown> = {}) {
  return record('InventorySnapshot', ordinal, { generation: 0, inventoryPoint: 'restart-ready', inventorySealed: false, inventoryIntegrityLost: false, inventoryReservations: 0, inventoryUnconfigured: 0, inventoryObserved: true, ...facts });
}
function screenshot(ordinal: number, facts: Record<string, unknown> = {}) {
  return record('ScreenshotFirstFailure', ordinal, { generation: 1, screenshotStage: 'capture', capturePhase: 'post-capture-validation', inventoryAfterFailure: 'changed', error: 'stale-scope', ...facts });
}
function readonlyPreparation(ordinal: number, facts: Record<string, unknown> = {}) {
  return record('ReadonlyPrepareFailure', ordinal, { generation: 1, entryUs: 900_000, ack: 'none', window: 'not-entered', deadline: true, zeroInput: true, cleanup: 'not-observed', error: 'deadline-exceeded', ...facts });
}
test('readonly preparation timing has bounded closed fields and explicit receipt currency', () => {
  assert.equal(validCleanupRecord(readonlyPreparation(1)), true);
  for (const ack of ['current', 'retired']) assert.equal(validCleanupRecord(readonlyPreparation(1, { ack, ackUs: 0, wakeUs: 40_000, failUs: 0 })), true);
  for (const facts of [{ entryUs: -1 }, { entryUs: 60_000_001 }, { ackUs: 20 }, { ack: 'current' }, { ack: ['current'] }, { ack: 'private' }, { wakeUs: null }, { failUs: 0.5 }, { failUs: 60_000_001 }, { window: 'private' }, { deadline: 'true' }, { zeroInput: false }, { cleanup: 'clean' }, { error: 'private' }, { target: 'private' }, { operationSeq: 0 }]) {
    assert.equal(validCleanupRecord(readonlyPreparation(1, facts)), false);
  }
  const maximal = readonlyPreparation(Number.MAX_SAFE_INTEGER, { generation: Number.MAX_SAFE_INTEGER, operationSeq: Number.MAX_SAFE_INTEGER, emittedBefore: Number.MAX_SAFE_INTEGER, droppedBefore: Number.MAX_SAFE_INTEGER, suppressedBefore: Number.MAX_SAFE_INTEGER, pid: 4294967295, entryUs: 60_000_000, ackUs: 60_000_000, ack: 'retired', wakeUs: 60_000_000, failUs: 60_000_000, deadline: false, cleanup: 'failure-observed', error: 'redirect-body-unavailable' });
  assert.equal(validCleanupRecord(maximal), true);
  assert.equal(lines(maximal).length, 505);
  assert.equal(lines({ ...maximal, error: 'unsupported-capability' }).length, 502);
  assert.ok(lines(maximal).length <= 512);
});
test('readonly preparation failure is retained after failed assertion without deadline or cleanup inference', t => {
  const out = directory(t); const capture = prepareCleanupCapture(binding, {});
  const failure = new Error('original preparation assertion'); let observed: unknown;
  try {
    appendFileSync(capture.file, lines(...completed(), readonlyPreparation(4, { ack: 'current', ackUs: 280_000, wakeUs: 42_000, failUs: 275_000, window: 'entered' })));
    throw failure;
  } catch (error) { observed = error; }
  collectCleanupCapture(out, 'web-browser', capture, true);
  assert.equal(observed, failure);
  const saved = JSON.parse(readFileSync(join(out, 'web-browser.cleanup-diagnostics.json'), 'utf8'));
  const fact = saved.records.at(-1);
  assert.equal(fact.phase, 'ReadonlyPrepareFailure'); assert.equal(fact.failUs, 275_000);
  assert.equal(fact.deadline, true); assert.equal(fact.cleanup, 'not-observed');
  assert.equal(saved.caseAssociation, 'unproven'); assert.equal(saved.processCoverage, 'unproven'); assert.equal(saved.releaseEligible, false);
  assert.deepEqual(inspectCleanupBytes(lines(record('CaptureStarted', 0), readonlyPreparation(1))).reasons, ['no-cleanup-attempt']);
});
test('readonly preparation gaps and private fields remain unknown', () => {
  for (const value of [readonlyPreparation(4, { droppedBefore: 1 }), readonlyPreparation(4, { overflow: true }), readonlyPreparation(5), readonlyPreparation(4, { sessionId: 'private-marker' })]) {
    const result = inspectCleanupBytes(lines(...completed(), value));
    assert.equal(result.status, 'unknown');
    assert.ok(!JSON.stringify(result.records).includes('private-marker'));
  }
});
test('screenshot failures use only closed stages, capture phases and aftermath relationships', () => {
  for (const inventoryAfterFailure of ['not-sampled', 'unavailable', 'unchanged', 'changed']) {
    assert.equal(validCleanupRecord(screenshot(1, { inventoryAfterFailure })), true);
  }
  for (const facts of [{ screenshotStage: 'private' }, { capturePhase: 'private' }, { inventoryAfterFailure: 'private' }, { error: 'private' }, { screenshotStage: ['capture'] }, { capturePhase: ['admission'] }, { inventoryAfterFailure: ['changed'] }, { operationSeq: 0 }, { targetId: 'private' }, { revision: 7 }, { screenshotStage: 'prepare-scope', capturePhase: 'admission' }]) {
    assert.equal(validCleanupRecord(screenshot(1, facts)), false);
  }
  const maximal = screenshot(Number.MAX_SAFE_INTEGER, { generation: Number.MAX_SAFE_INTEGER, operationSeq: Number.MAX_SAFE_INTEGER, emittedBefore: Number.MAX_SAFE_INTEGER, droppedBefore: Number.MAX_SAFE_INTEGER, suppressedBefore: Number.MAX_SAFE_INTEGER, screenshotStage: 'animation-stabilization', capturePhase: 'not-entered', pid: 4294967295, error: 'unsupported-capability' });
  assert.equal(validCleanupRecord(maximal), true);
  assert.ok(lines(maximal).length <= 512);
});
test('screenshot evidence survives a failed assertion without becoming cleanup or case proof', t => {
  const out = directory(t); const capture = prepareCleanupCapture(binding, {});
  const failure = new Error('original assertion'); let observed: unknown;
  try {
    appendFileSync(capture.file, lines(...completed(), screenshot(4)));
    throw failure;
  } catch (error) { observed = error; }
  const result = collectCleanupCapture(out, 'web-browser', capture, true);
  assert.equal(observed, failure); assert.equal(result.status, 'complete-observed-snapshots');
  const saved = JSON.parse(readFileSync(join(out, 'web-browser.cleanup-diagnostics.json'), 'utf8'));
  assert.equal(saved.records.at(-1).phase, 'ScreenshotFirstFailure');
  assert.equal(saved.records.at(-1).error, 'stale-scope');
  assert.equal(saved.caseAssociation, 'unproven'); assert.equal(saved.processCoverage, 'unproven'); assert.equal(saved.releaseEligible, false);
  const only = inspectCleanupBytes(lines(record('CaptureStarted', 0), screenshot(1)));
  assert.deepEqual(only.reasons, ['no-cleanup-attempt']);
  assert.equal(only.records.length, 2);
});
test('screenshot evidence gaps and private fields cannot be repaired by a later cleanup result', () => {
  for (const value of [screenshot(4, { droppedBefore: 1 }), screenshot(4, { overflow: true }), screenshot(5), screenshot(4, { sessionId: 'private-marker' })]) {
    const result = inspectCleanupBytes(lines(...completed(), value));
    assert.equal(result.status, 'unknown');
    assert.ok(!JSON.stringify(result.records).includes('private-marker'));
  }
});
test('inventory snapshots accept only the two closed points and bounded observed facts', () => {
  for (const inventoryPoint of ['restart-ready', 'settlement-refused']) {
    for (const count of [0, 8192]) {
      const value = inventory(1, { inventoryPoint, generation: Number.MAX_SAFE_INTEGER, inventorySealed: true, inventoryIntegrityLost: true, inventoryReservations: count, inventoryUnconfigured: count });
      assert.equal(validCleanupRecord(value), true);
      assert.ok(lines(value).length <= 512);
    }
  }
  assert.equal(validCleanupRecord(inventory(1, { operationSeq: 0 })), true);
});
test('independent inventory snapshots interleave without changing cleanup lifecycle state', () => {
  const values = [record('CaptureStarted', 0), inventory(1), record('CleanupStarted', 2), inventory(3, { inventoryPoint: 'settlement-refused', inventorySealed: true, inventoryReservations: 1 }), record('CleanupFirstFailure', 4, { cleanupComponent: 'dialog' }), inventory(5), record('CleanupResult', 6, { cleanupResult: 'failed', error: 'cleanup-failed' }), inventory(7)];
  const result = inspectCleanupBytes(lines(...values));
  assert.equal(result.status, 'complete-observed-snapshots');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.records.length, values.length);
  assert.equal(result.records[3]!.inventorySealed, true, 'complete evidence does not mean healthy inventory');
});
test('inventory-only evidence cannot invent cleanup coverage or a capture start', () => {
  const only = inspectCleanupBytes(lines(record('CaptureStarted', 0), inventory(1)));
  assert.equal(only.status, 'unknown');
  assert.deepEqual(only.reasons, ['no-cleanup-attempt']);
  assert.equal(only.records.length, 2);
  const missing = inspectCleanupBytes(lines(inventory(0)));
  assert.equal(missing.status, 'unknown');
  assert.ok(missing.reasons.includes('missing-capture-start'));
  assert.ok(!missing.reasons.includes('invalid-lifecycle'));
});
test('unobserved inventory remains unknown even alongside completed cleanup', t => {
  const unobserved = inventory(4, { inventoryObserved: false });
  assert.equal(validCleanupRecord(unobserved), true);
  const inspected = inspectCleanupBytes(lines(...completed(), unobserved));
  assert.equal(inspected.status, 'unknown');
  assert.deepEqual(inspected.reasons, ['inventory-unobserved']);
  const out = directory(t); const capture = prepareCleanupCapture(binding, {});
  appendFileSync(capture.file, lines(...completed(), unobserved));
  const result = collectCleanupCapture(out, 'web-browser', capture, true);
  assert.equal(result.status, 'unknown');
  const saved = JSON.parse(readFileSync(join(out, 'web-browser.cleanup-diagnostics.json'), 'utf8'));
  assert.equal(saved.records.at(-1).inventoryObserved, false);
  assert.equal(saved.releaseEligible, false);
  assert.equal(saved.processCoverage, 'unproven');
  assert.equal(saved.caseAssociation, 'unproven');
});
test('inventory rejects missing fields, extra payload or cleanup identity, and wrong closed types', () => {
  const valid = inventory(1);
  for (const key of ['generation', 'inventoryPoint', 'inventorySealed', 'inventoryIntegrityLost', 'inventoryReservations', 'inventoryUnconfigured', 'inventoryObserved']) {
    const missing: Record<string, unknown> = { ...valid }; delete missing[key];
    assert.equal(validCleanupRecord(missing), false, `missing ${key}`);
  }
  for (const facts of [
    { inventoryPoint: 'private-marker' }, { inventoryPoint: ['restart-ready'] }, { inventoryPoint: { toString: 'restart-ready' } }, { inventoryPoint: null },
    { generation: -1 }, { generation: '0' }, { generation: Number.MAX_SAFE_INTEGER + 1 },
    { inventorySealed: 'false' }, { inventoryIntegrityLost: 0 }, { inventoryObserved: null }, { inventoryObserved: [] },
    { inventoryReservations: -1 }, { inventoryReservations: 8193 }, { inventoryReservations: 0.5 }, { inventoryReservations: '0' },
    { inventoryUnconfigured: -1 }, { inventoryUnconfigured: 8193 }, { inventoryUnconfigured: {} }, { inventoryUnconfigured: true },
    { targetId: 'private-marker' }, { cleanupOwner: 1 }, { cleanupAttempt: 1 }, { cleanupLifecycle: 'restart' }, { cleanupResult: 'passed' }, { error: 'cleanup-failed' },
  ]) {
    const changed = inventory(4, facts);
    assert.equal(validCleanupRecord(changed), false, JSON.stringify(facts));
    const inspected = inspectCleanupBytes(lines(...completed(), changed));
    assert.equal(inspected.status, 'unknown');
    assert.ok(inspected.reasons.includes('invalid-record'));
    assert.equal(inspected.records.length, 4, 'invalid payload must not enter saved records');
    assert.ok(!JSON.stringify(inspected).includes('private-marker'));
  }
});
test('inventory preserves sequence, overflow, emission and pending cleanup refusal rules', () => {
  for (const facts of [{ record: 5 }, { emittedBefore: 3 }, { droppedBefore: 1 }, { suppressedBefore: 1 }, { overflow: true }, { pid: 43 }]) {
    assert.equal(inspectCleanupBytes(lines(...completed(), inventory(4, facts))).status, 'unknown');
  }
  const pending = inspectCleanupBytes(lines(record('CaptureStarted', 0), record('CleanupStarted', 1), inventory(2)));
  assert.equal(pending.status, 'unknown'); assert.ok(pending.reasons.includes('missing-terminal'));
  const orphan = inspectCleanupBytes(lines(record('CaptureStarted', 0), inventory(1), record('CleanupResult', 2, { cleanupResult: 'passed' })));
  assert.equal(orphan.status, 'unknown'); assert.ok(orphan.reasons.includes('invalid-lifecycle'));
});

test('saturated native inventory counts are retained as unknown, never healthy or silently truncated by collector', () => {
  for (const facts of [
    { inventoryReservations: 8192 }, { inventoryUnconfigured: 8192 },
    { inventoryReservations: 8192, inventoryUnconfigured: 8192, inventorySealed: true, inventoryIntegrityLost: true },
  ]) {
    const value = inventory(4, { ...facts, inventoryObserved: false });
    assert.equal(validCleanupRecord(value), true);
    const result = inspectCleanupBytes(lines(...completed(), value));
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.reasons, ['inventory-unobserved']);
    assert.deepEqual(result.records.at(-1), value);
  }
});
