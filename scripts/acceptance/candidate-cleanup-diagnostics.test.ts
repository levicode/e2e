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

function targetAttribution(ordinal: number, facts: Record<string, unknown> = {}) {
  return record('TargetAttribution', ordinal, { generation: 1, operationSeq: 0, attachmentOrdinal: 2, targetOrdinal: 1, targetKind: 'page', targetOrigin: 'initial-discovery', parentAttachmentOrdinal: 0, rootAttachmentOrdinal: 0, ...facts });
}
function targetLifecycle(ordinal: number, facts: Record<string, unknown> = {}) {
  return record('TargetLifecycle', ordinal, { generation: 1, operationSeq: 0, attachmentOrdinal: 2, targetStage: 'configure-failed', targetPurpose: 'unclassified', targetClassification: 'pending-reservation', targetConfigured: false, targetResumed: false, ...facts });
}
function targetInventory(ordinal: number, facts: Record<string, unknown> = {}) {
  return record('TargetInventory', ordinal, { generation: 1, operationSeq: 0, inventoryPoint: 'restart-begin', inventoryOrdinal: 3, attachmentOrdinal: 2, targetPurpose: 'unclassified', targetClassification: 'pending-reservation', targetConfigured: false, targetResumed: false, ...facts });
}
function targetSummary(ordinal: number, facts: Record<string, unknown> = {}) {
  return record('TargetInventorySummary', ordinal, { generation: 1, operationSeq: 0, inventoryPoint: 'restart-begin', inventoryOrdinal: 3, targetCount: 1, targetSampled: 1, targetObserved: true, ...facts });
}
function targetSnapshot(ordinal: number, facts: Record<string, unknown> = {}) {
  return inventory(ordinal, { generation: 1, operationSeq: 0, inventoryPoint: 'restart-begin', inventoryOrdinal: 3, ...facts });
}
function targetGroup(first = 4) {
  return [targetSnapshot(first), targetSummary(first + 1), targetAttribution(first + 2, { inventoryPoint: 'restart-begin', inventoryOrdinal: 3 }), targetInventory(first + 3)];
}
function reindex(values: Record<string, unknown>[]) { return values.map((value, index) => ({ ...value, record: index, emittedBefore: index })); }

test('restart target phases match native closed fields, enum values and ordinal bounds', () => {
  const examples = [targetAttribution(1), targetLifecycle(2), targetLifecycle(3, { error: 'browser-failure' }), ...targetGroup(), record('TargetObservationLost', 8, { generation: 0, operationSeq: 0 })];
  for (const value of examples) assert.equal(validCleanupRecord(value), true);
  for (const targetKind of ['other', 'page', 'iframe', 'worker', 'shared-worker', 'service-worker', 'browser', 'browser-ui', 'tab', 'webview', 'background-page']) assert.equal(validCleanupRecord(targetAttribution(1, { targetKind })), true);
  for (const targetOrigin of ['unclassified', 'initial-discovery', 'auto-attach']) assert.equal(validCleanupRecord(targetAttribution(1, { targetOrigin })), true);
  for (const targetStage of ['registered', 'configure-started', 'configure-ack', 'configure-failed', 'resumed', 'detached', 'restart-retiring', 'purpose-assigned']) assert.equal(validCleanupRecord(targetLifecycle(1, { targetStage })), true);
  for (const targetPurpose of ['unclassified', 'application', 'state-bootstrap']) assert.equal(validCleanupRecord(targetLifecycle(1, { targetPurpose })), true);
  for (const targetClassification of ['pending-reservation', 'unreserved-application', 'reserved-application', 'reserved-bootstrap', 'reservation-remainder']) assert.equal(validCleanupRecord(targetLifecycle(1, { targetClassification })), true);
  assert.equal(validCleanupRecord(targetAttribution(1, { attachmentOrdinal: 65535, targetOrdinal: 0, parentAttachmentOrdinal: 65535, rootAttachmentOrdinal: 65535 })), true);
  assert.equal(validCleanupRecord(targetSummary(1, { targetCount: 8192, targetSampled: 16, targetObserved: false })), true);
});
test('target schema rejects missing fields, arbitrary payloads, false complete samples and invalid pairs', () => {
  for (const original of [targetAttribution(1), targetLifecycle(1), targetInventory(1), targetSummary(1), record('TargetObservationLost', 1, { generation: 1 })]) {
    for (const key of Object.keys(original)) { const value = { ...original } as Record<string, unknown>; delete value[key]; assert.equal(validCleanupRecord(value), false, key); }
    assert.equal(validCleanupRecord({ ...original, targetId: 'private-marker' }), false);
  }
  for (const value of [
    targetAttribution(1, { inventoryPoint: 'restart-begin' }), targetAttribution(1, { inventoryOrdinal: 3 }), targetAttribution(1, { targetKind: 'shared_worker' }), targetAttribution(1, { targetOrigin: ['auto-attach'] }), targetAttribution(1, { attachmentOrdinal: 65536 }), targetAttribution(1, { parentAttachmentOrdinal: -1 }),
    targetLifecycle(1, { targetStage: 'private' }), targetLifecycle(1, { targetPurpose: 'private' }), targetLifecycle(1, { targetClassification: [] }), targetLifecycle(1, { targetConfigured: 1 }), targetLifecycle(1, { targetResumed: 'false' }), targetLifecycle(1, { error: 'private' }),
    targetSummary(1, { targetCount: 8193 }), targetSummary(1, { targetCount: 17, targetSampled: 17 }), targetSummary(1, { targetCount: 0 }), targetSummary(1, { targetCount: 2, targetObserved: true }), targetSummary(1, { targetObserved: 'true' }), targetSummary(1, { inventoryOrdinal: 65536 }), targetInventory(1, { inventoryPoint: 'private' }), targetSnapshot(1, { inventoryOrdinal: -1 }),
  ]) assert.equal(validCleanupRecord(value), false);
});
test('complete target sample with unknown ancestry does not alter cleanup or case coverage', t => {
  const capture = prepareCleanupCapture(binding, {}); const out = directory(t);
  appendFileSync(capture.file, lines(...completed(), ...targetGroup(), targetAttribution(8), targetLifecycle(9, { error: 'browser-failure' })));
  assert.equal(collectCleanupCapture(out, 'web-browser', capture, true).status, 'complete-observed-snapshots');
  const saved = JSON.parse(readFileSync(join(out, 'web-browser.cleanup-diagnostics.json'), 'utf8'));
  assert.equal(saved.records.length, 10); assert.equal(saved.caseAssociation, 'unproven'); assert.equal(saved.processCoverage, 'unproven'); assert.equal(saved.releaseEligible, false);
  const only = inspectCleanupBytes(lines(...reindex([record('CaptureStarted', 0), ...targetGroup()])));
  assert.deepEqual(only.reasons, ['no-cleanup-attempt']);
});
test('target inventory joins require snapshot summary and exact paired sampled ordinals', () => {
  const group = targetGroup();
  for (const values of [group.slice(1), group.filter((_, index) => index !== 1), group.filter((_, index) => index !== 2), group.slice(0, -1), [...group, group[2]!], [...group, group[1]!], group.map((value, index) => index === 3 ? { ...value, attachmentOrdinal: 9 } : value), group.map((value, index) => index === 3 ? { ...value, generation: 2 } : value), group.map((value, index) => index === 3 ? { ...value, operationSeq: 2 } : value), group.map((value, index) => index === 3 ? { ...value, inventoryPoint: 'restart-ready' } : value), group.map((value, index) => index === 3 ? { ...value, inventoryOrdinal: 4 } : value)]) {
    const result = inspectCleanupBytes(lines(...reindex([...completed(), ...values])));
    assert.equal(result.status, 'unknown'); assert.ok(result.reasons.some(reason => reason.endsWith('target-inventory')));
  }
});
test('target zero ordinals loss and partial samples remain unknown without losing valid records', () => {
  for (const extra of [targetAttribution(4, { attachmentOrdinal: 0 }), targetAttribution(4, { targetOrdinal: 0 }), record('TargetObservationLost', 4, { generation: 1, operationSeq: 0 }), targetSnapshot(4, { inventoryOrdinal: 0 })]) {
    const result = inspectCleanupBytes(lines(...completed(), extra));
    assert.equal(result.status, 'unknown'); assert.equal(result.records.length, 5);
  }
  const incomplete = targetGroup().map(value => value.phase === 'TargetInventorySummary' ? { ...value, targetObserved: false, targetCount: 17 } : value);
  assert.ok(inspectCleanupBytes(lines(...completed(), ...incomplete)).reasons.includes('target-inventory-unobserved'));
  const truncated = lines(...completed(), ...targetGroup()).subarray(0, -8);
  assert.equal(inspectCleanupBytes(truncated).status, 'unknown');
  const privateRow = inspectCleanupBytes(lines(...completed(), targetAttribution(4, { sessionId: 'private-marker' })));
  assert.ok(!JSON.stringify(privateRow.records).includes('private-marker'));
});
test('target inventories can interleave and remain process-local without inventing order', () => {
  const first = targetGroup(); const second = targetGroup().map(value => ({ ...value, inventoryOrdinal: 4, inventoryPoint: 'restart-ready', operationSeq: 2 }));
  const values = reindex([...completed(), ...first.flatMap((value, index) => [value, second[index]!])]);
  assert.equal(inspectCleanupBytes(lines(...values)).status, 'complete-observed-snapshots');
  const otherProcess = reindex([record('CaptureStarted', 0), ...targetGroup()]).map(value => ({ ...value, pid: 43 }));
  assert.equal(inspectCleanupBytes(lines(...completed(), ...targetGroup(), ...otherProcess)).status, 'complete-observed-snapshots');
  assert.equal(inspectCleanupBytes(lines(...completed(), targetSnapshot(4), targetSummary(5, { targetCount: 0, targetSampled: 0 }))).status, 'complete-observed-snapshots');
});
test('target sample and serialized line limits remain unchanged', () => {
  const pairs = Array.from({ length: 16 }, (_, index) => [targetAttribution(0, { inventoryPoint: 'restart-begin', inventoryOrdinal: 3, attachmentOrdinal: index + 2, targetOrdinal: index + 1 }), targetInventory(0, { attachmentOrdinal: index + 2 })]).flat();
  const full = [...completed(), targetSnapshot(0), targetSummary(0, { targetCount: 16, targetSampled: 16 }), ...pairs];
  assert.equal(inspectCleanupBytes(lines(...reindex(full))).status, 'complete-observed-snapshots');
  assert.equal(inspectCleanupBytes(lines(...reindex([...full, targetAttribution(0, { inventoryPoint: 'restart-begin', inventoryOrdinal: 3, attachmentOrdinal: 18, targetOrdinal: 17 }), targetInventory(0, { attachmentOrdinal: 18 })]))).status, 'unknown');
  const limit = Number.MAX_SAFE_INTEGER;
  const numeric = { generation: limit, operationSeq: limit, emittedBefore: limit, droppedBefore: limit, suppressedBefore: limit, pid: 4294967295 };
  const oversized = [targetAttribution(limit, { ...numeric, inventoryPoint: 'settlement-refused', inventoryOrdinal: 65535, attachmentOrdinal: 65535, targetOrdinal: 65535, parentAttachmentOrdinal: 65535, rootAttachmentOrdinal: 65535, targetKind: 'background-page' }), targetLifecycle(limit, { ...numeric, attachmentOrdinal: 65535, targetStage: 'configure-started', targetPurpose: 'state-bootstrap', targetClassification: 'unreserved-application', error: 'redirect-body-unavailable' })];
  for (const row of oversized) {
    assert.equal(validCleanupRecord(row), true); assert.ok(lines(row).length > 512);
    const result = inspectCleanupBytes(lines(...completed(), row));
    assert.ok(result.reasons.includes('invalid-record')); assert.equal(result.records.length, 4);
  }
});

const atomicFacts = { generation: 1, pass: 'protected', sealed: false, revisionMismatch: true, reservations: false, delta: 3, events: [1, 0, 1, 1, 0, 0, 0], exact: true, lastEvent: 'info', lastTarget: 'other' };
function atomicPair() { return [record('CaptureStarted', 0), record('ScreenshotFirstFailure', 1, { generation: 1, screenshotStage: 'frame-inventory-fence', capturePhase: 'not-entered', inventoryAfterFailure: 'changed', error: 'stale-scope' }), record('FrameInventoryRejection', 2, atomicFacts)]; }
test('atomic inventory schema accepts every closed cause and retains legacy screenshot rows', () => {
  for (let mask = 1; mask < 8; mask++) assert.equal(validCleanupRecord(record('FrameInventoryRejection', 2, { ...atomicFacts, sealed: !!(mask & 1), revisionMismatch: !!(mask & 2), reservations: !!(mask & 4), ...(!(mask & 2) ? { delta: 0, events: Array(7).fill(0), lastEvent: 'none', lastTarget: 'unknown' } : {}) })), true);
  for (const [index, lastEvent] of ['attach', 'detach', 'info', 'navigate', 'same-document', 'frame-detach', 'unknown'].entries()) { const events = Array(7).fill(0); events[index] = 1; assert.equal(validCleanupRecord(record('FrameInventoryRejection', 2, { ...atomicFacts, delta: 1, events, lastEvent, exact: index !== 6, lastTarget: index === 6 ? 'unknown' : 'same' })), true); }
  assert.equal(validCleanupRecord(atomicPair()[1]), true);
  assert.deepEqual(inspectCleanupBytes(lines(...atomicPair().slice(0, 2))).reasons, ['no-cleanup-attempt']);
});
test('atomic inventory rejects arbitrary payload, malformed tuple, false exactness and empty causes', () => {
  const bad = [{ url: 'private' }, { targetId: 'private' }, { pass: 'retry' }, { sealed: false, revisionMismatch: false, reservations: false }, { operationSeq: 0 }, { delta: -1 }, { delta: 65536 }, { delta: 0 }, { events: [] }, { events: Array(8).fill(0) }, { events: [1, 0, 1, 1, 0, 0, 'private'] }, { events: [1, 0, 1, 1, 0, 0, 65536] }, { events: [0, 0, 0, 0, 0, 0, 3] }, { delta: 2 }, { lastEvent: 'none' }, { lastEvent: 'detach' }, { lastEvent: 'unknown', lastTarget: 'same' }, { lastTarget: 'private' }, { exact: 'true' }];
  for (const fields of bad) assert.equal(validCleanupRecord(record('FrameInventoryRejection', 2, { ...atomicFacts, ...fields })), false, JSON.stringify(fields));
  for (const key of ['delta', 'events', 'sealed', 'pass', 'lastEvent']) { const item: Record<string, unknown> = record('FrameInventoryRejection', 2, atomicFacts); delete item[key]; assert.equal(validCleanupRecord(item), false); }
});
test('atomic inventory missing baseline and unknown bucket remain unknown without zero filling', () => {
  const unknown: Record<string, unknown> = { ...atomicFacts, exact: false, lastEvent: 'unknown', lastTarget: 'unknown' }; delete unknown.events; delete unknown.delta;
  const result = inspectCleanupBytes(lines(...atomicPair().slice(0, 2), record('FrameInventoryRejection', 2, unknown)));
  assert.equal(result.status, 'unknown'); assert.ok(result.reasons.includes('frame-inventory-inexact')); assert.equal(Object.hasOwn(result.records.at(-1)!, 'events'), false); assert.equal(Object.hasOwn(result.records.at(-1)!, 'delta'), false);
  const withUnknown = inspectCleanupBytes(lines(...atomicPair().slice(0, 2), record('FrameInventoryRejection', 2, { ...atomicFacts, exact: false, delta: 1, events: [0, 0, 0, 0, 0, 0, 1], lastEvent: 'unknown', lastTarget: 'unknown' })));
  assert.equal(withUnknown.status, 'unknown'); assert.deepEqual(withUnknown.records.at(-1)!.events, [0, 0, 0, 0, 0, 0, 1]);
});
test('atomic inventory needs its matching first failure and cannot fabricate cleanup coverage', () => {
  const paired = inspectCleanupBytes(lines(...atomicPair()));
  assert.equal(paired.status, 'unknown'); assert.deepEqual(paired.reasons, ['no-cleanup-attempt']);
  for (const values of [[record('CaptureStarted', 0), record('FrameInventoryRejection', 1, atomicFacts)], [...atomicPair(), record('FrameInventoryRejection', 3, atomicFacts)], [...atomicPair(), { ...atomicPair()[1], record: 3, emittedBefore: 3 }], [...atomicPair().slice(0, 2), record('FrameInventoryRejection', 2, { ...atomicFacts, operationSeq: 8 })], [...atomicPair().slice(0, 2), record('FrameInventoryRejection', 2, { ...atomicFacts, generation: 2 })]]) { const result = inspectCleanupBytes(lines(...values)); assert.equal(result.status, 'unknown'); assert.ok(result.reasons.includes('unpaired-frame-inventory')); }
  const pending = inspectCleanupBytes(lines(...atomicPair(), record('CleanupStarted', 3)));
  assert.equal(pending.status, 'unknown');
});
test('atomic inventory preserves failed-assert evidence and source binding without acceptance promotion', t => {
  const out = directory(t); const capture = prepareCleanupCapture(binding, {}); appendFileSync(capture.file, lines(...atomicPair()));
  collectCleanupCapture(out, 'web-browser', capture, true);
  const saved = JSON.parse(readFileSync(join(out, 'web-browser.cleanup-diagnostics.json'), 'utf8'));
  assert.equal(saved.releaseEligible, false); assert.equal(saved.caseAssociation, 'unproven'); assert.equal(saved.processCoverage, 'unproven'); assert.deepEqual(saved.records.at(-1).events, atomicFacts.events); assert.deepEqual(saved.binding, binding);
});
test('atomic inventory maximal closed line is 507 bytes and the unchanged 512 cap rejects longer data', () => {
  const n = Number.MAX_SAFE_INTEGER;
  const item = record('FrameInventoryRejection', n, { ...atomicFacts, pid: 4294967295, generation: n, operationSeq: n, droppedBefore: n, emittedBefore: n, suppressedBefore: n, delta: 65535, events: Array(7).fill(65535), exact: false, lastEvent: 'same-document', lastTarget: 'unknown' });
  assert.equal(lines(item).length, 507); assert.equal(validCleanupRecord(item), true);
  const tooLong = Buffer.from(JSON.stringify(item) + ' '.repeat(6) + '\n'); assert.equal(tooLong.length, 513);
  const rejected = inspectCleanupBytes(tooLong); assert.ok(rejected.reasons.includes('invalid-record')); assert.equal(rejected.records.length, 0);
});

function workerAdmission(ordinal: number, admissionStep = 'network-enable', admissionState = 'enter', facts = {}) {
  return record('ServiceWorkerAdmission', ordinal, { operationSeq: 0, generation: 1, workerOrdinal: 1, waitingForDebugger: true, admissionStep, admissionState, ...facts });
}
test('worker admission accepts only closed scalar facts, tri-state debugger wait and autonomous seq0', () => {
  for (const waitingForDebugger of [true, false, 'unknown']) assert.equal(validCleanupRecord(workerAdmission(1, 'network-enable', 'enter', { waitingForDebugger })), true);
  for (const facts of [{ operationSeq: 10 }, { workerOrdinal: 0 }, { workerOrdinal: 9 }, { waitingForDebugger: null }, { waitingForDebugger: 'true' }, { admissionState: 'submitted' }, { admissionStep: 'private' }, { sessionId: 'private' }, { url: 'private' }, { error: 'browser-failure' }]) assert.equal(validCleanupRecord(workerAdmission(1, 'network-enable', 'enter', facts)), false);
  const maximal = workerAdmission(Number.MAX_SAFE_INTEGER, 'auxiliary-classification', 'failed', { generation: Number.MAX_SAFE_INTEGER, pid: 4294967295, emittedBefore: Number.MAX_SAFE_INTEGER, droppedBefore: Number.MAX_SAFE_INTEGER, suppressedBefore: Number.MAX_SAFE_INTEGER, waitingForDebugger: 'unknown' });
  assert.equal(validCleanupRecord(maximal), true); assert.ok(lines(maximal).length <= 512);
});
test('worker progress persists without a cleanup attempt or inferred wire submission', () => {
  const result = inspectCleanupBytes(lines(record('CaptureStarted', 0), workerAdmission(1, 'owned-attachment', 'done'), workerAdmission(2)));
  assert.equal(result.status, 'unknown'); assert.ok(result.reasons.includes('no-cleanup-attempt')); assert.ok(result.reasons.includes('worker-admission-incomplete'));
  assert.equal(result.records.at(-1)!.admissionState, 'enter');
});
test('worker completion and failure remain independent from cleanup coverage', () => {
  for (const [step, terminal] of [['configuration-committed', 'done'], ['network-enable', 'failed']]) {
    const result = inspectCleanupBytes(lines(...completed(), workerAdmission(4, 'owned-attachment', 'done'), workerAdmission(5, step, 'enter'), workerAdmission(6, step, terminal)));
    assert.equal(result.status, 'complete-observed-snapshots'); assert.equal(result.records[3]!.cleanupResult, 'failed');
    const alone = inspectCleanupBytes(lines(record('CaptureStarted', 0), workerAdmission(1, 'owned-attachment', 'done'), workerAdmission(2, step, 'enter'), workerAdmission(3, step, terminal)));
    assert.equal(alone.status, 'unknown'); assert.deepEqual(alone.reasons, ['no-cleanup-attempt']);
  }
});
test('missing, mixed or over-budget worker observations remain unknown', () => {
  const cases = [
    [workerAdmission(4, 'network-enable', 'done')],
    [workerAdmission(4, 'owned-attachment', 'done'), workerAdmission(5), workerAdmission(6, 'network-enable', 'done', { waitingForDebugger: false })],
    [workerAdmission(4, 'owned-attachment', 'done'), ...Array.from({ length: 32 }, (_, index) => workerAdmission(5 + index, 'network-enable', index % 2 ? 'done' : 'enter'))],
    [workerAdmission(4, 'owned-attachment', 'done'), workerAdmission(5, 'configuration-committed', 'enter'), workerAdmission(6, 'configuration-committed', 'done', { droppedBefore: 1 })],
  ];
  for (const extra of cases) assert.equal(inspectCleanupBytes(lines(...completed(), ...extra)).status, 'unknown');
});


test('terminal cleanup checkpoints are closed metadata and cannot prove cleanup', () => {
  const point = (ordinal: number, facts = {}) => record('TerminalCleanupCheckpoint', ordinal, { operationSeq: 0, terminalCleanupStage: 'final-commit', terminalCleanupOk: true, ...facts });
  for (const terminalCleanupStage of ['task-proof', 'owner-preconditions', 'runtime-release', 'persistent-probe', 'enrollment-proof', 'ledger-commands-present', 'physical-close', 'ordinary-close', 'shutdown-joins', 'final-commit']) {
    for (const terminalCleanupOk of [false, true]) assert.equal(validCleanupRecord(point(1, { terminalCleanupStage, terminalCleanupOk })), true);
  }
  for (const facts of [{ operationSeq: 1 }, { terminalCleanupStage: 'private' }, { terminalCleanupOk: 'true' }, { url: 'private' }, { generation: 1 }, { error: 'cleanup-failed' }]) assert.equal(validCleanupRecord(point(1, facts)), false);
  for (const key of ['terminalCleanupStage', 'terminalCleanupOk']) { const value: Record<string, unknown> = point(1); delete value[key]; assert.equal(validCleanupRecord(value), false); }
  const only = inspectCleanupBytes(lines(record('CaptureStarted', 0), point(1)));
  assert.equal(only.status, 'unknown'); assert.ok(only.reasons.includes('no-cleanup-attempt'));
  const existing = completed();
  const alongside = inspectCleanupBytes(lines(...existing, point(4)));
  assert.equal(alongside.status, 'complete-observed-snapshots');
  assert.equal(alongside.records.find(value => value.phase === 'CleanupResult')?.cleanupResult, 'failed');
});
