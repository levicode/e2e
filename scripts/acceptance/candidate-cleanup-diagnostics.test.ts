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
test('inventory snapshots accept only the reviewed closed points and bounded observed facts', () => {
  for (const inventoryPoint of ['restart-begin', 'restart-ready', 'settlement-refused']) {
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

function targetInventoryRecords() {
  return [
    ...completed(),
    inventory(4, { inventoryOrdinal: 1, inventoryUnconfigured: 1 }),
    record('TargetInventorySummary', 5, { generation: 0, inventoryPoint: 'restart-ready', inventoryOrdinal: 1, targetCount: 1, targetSampled: 1, targetObserved: true }),
    record('TargetAttribution', 6, { generation: 0, inventoryPoint: 'restart-ready', inventoryOrdinal: 1, attachmentOrdinal: 3, targetOrdinal: 2, targetKind: 'service-worker', targetOrigin: 'auto-attach', parentAttachmentOrdinal: 1, rootAttachmentOrdinal: 1 }),
    record('TargetInventory', 7, { generation: 0, inventoryPoint: 'restart-ready', inventoryOrdinal: 1, attachmentOrdinal: 3, targetPurpose: 'application', targetClassification: 'unreserved-application', targetConfigured: false, targetResumed: false }),
  ];
}
test('target evidence joins exact PID, inventory ordinal and attachment without claiming a product pass', () => {
  const values = targetInventoryRecords();
  for (const value of values) assert.equal(validCleanupRecord(value), true);
  const result = inspectCleanupBytes(lines(...values));
  assert.equal(result.status, 'complete-observed-snapshots');
  assert.equal(result.records.at(-1)!.targetConfigured, false);
  assert.equal(result.records[3]!.cleanupResult, 'failed');
  const other = values.map(v => ({ ...v, pid: 43 }));
  assert.equal(inspectCleanupBytes(lines(...values.flatMap((v, i) => [v, other[i]]))).status, 'complete-observed-snapshots');
});
test('target diagnostics refuse raw IDs, URLs, wrong enums and impersonated scalar fields', () => {
  const valid = targetInventoryRecords();
  for (const [index, change] of [
    [6, { targetId: 'private-marker' }], [6, { url: 'https://private-marker' }],
    [6, { targetKind: 'private-marker' }], [6, { targetKind: ['service-worker'] }],
    [6, { targetOrigin: {} }], [6, { attachmentOrdinal: 0 }], [6, { targetOrdinal: 65536 }],
    [7, { targetClassification: 'private-marker' }], [7, { targetConfigured: 'false' }],
    [5, { targetCount: 17, targetSampled: 17 }], [5, { targetObserved: true, targetCount: 2 }],
  ] as const) {
    const changed = valid.map((v, i) => i === index ? { ...v, ...change } : v);
    assert.equal(validCleanupRecord(changed[index]), false);
    const result = inspectCleanupBytes(lines(...changed));
    assert.equal(result.status, 'unknown');
    assert.ok(!JSON.stringify(result.records).includes('private-marker'));
  }
});
test('target partial rows, conflicting joins, dropped observations and count mismatch stay unknown', () => {
  const valid = targetInventoryRecords();
  for (const values of [valid.slice(0, -1), valid.filter((_, i) => i !== 5),
    valid.map((v, i) => i === 7 ? { ...v, attachmentOrdinal: 4 } : v),
    valid.map((v, i) => i === 7 ? { ...v, inventoryPoint: 'restart-begin' } : v),
    valid.map((v, i) => i === 7 ? { ...v, targetConfigured: true } : v),
    valid.map((v, i) => i === 5 ? { ...v, targetObserved: false } : v),
    [...valid, record('TargetObservationLost', 8, { generation: 0 })],
  ]) assert.equal(inspectCleanupBytes(lines(...values)).status, 'unknown');
});
test('configuration failure, ACK and detach stages accept only closed failure codes', () => {
  for (const targetStage of ['registered', 'configure-started', 'configure-ack', 'configure-failed', 'resumed', 'detached', 'restart-retiring', 'purpose-assigned']) {
    const value = record('TargetLifecycle', 4, { generation: 1, attachmentOrdinal: 3, targetStage, targetPurpose: 'application', targetClassification: 'reservation-remainder', targetConfigured: false, targetResumed: false, ...(targetStage === 'configure-failed' ? { error: 'browser-failure' } : {}) });
    assert.equal(validCleanupRecord(value), true);
    assert.equal(inspectCleanupBytes(lines(...completed(), value)).status, 'complete-observed-snapshots');
    assert.equal(validCleanupRecord({ ...value, error: 'private-marker' }), false);
  }
});
