import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createTimingInspector, validTiming } from './collector-timing.mjs';
const source = process.env.P04_E2E_SOURCE;
assert.ok(source, 'P04_E2E_SOURCE must name the exact formal source');
const { validCleanupRecord } = await import(pathToFileURL(`${source}/scripts/acceptance/candidate-cleanup-diagnostics.ts`).href);
const inspect = createTimingInspector(validCleanupRecord);
const common = { schemaVersion: 2, source: 'native', pid: 7, record: 0, operationSeq: 0,
  droppedBefore: 0, emittedBefore: 0, suppressedBefore: 0, overflow: false };
const start = { ...common, phase: 'CaptureStarted' };
const timing = [1000000, 800000, 1001000, 1000001, 1002000, 1255000, 1, false];
const failure = { ...common, record: 1, emittedBefore: 1, operationSeq: 29,
  phase: 'ScreenshotFirstFailure', generation: 1, screenshotStage: 'capture',
  capturePhase: 'raw-capture', inventoryAfterFailure: 'unchanged', error: 'deadline-exceeded', timing };
const raw = (...rows) => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');

test('real formal schema stays strict; local view preserves exact raw digest and clocks', () => {
  assert.equal(validCleanupRecord(failure), false);
  const input = raw(start, failure); const copy = Buffer.from(input); const value = inspect(input);
  assert.equal(value.status, 'complete'); assert.deepEqual(input, copy);
  assert.deepEqual(value.timings, [failure]); assert.equal(value.releaseEligible, false);
  assert.equal(value.cleanupAcceptance, 'unknown'); assert.equal(value.rawBytes, input.length);
});
test('worst legal shape fits 512 bytes including newline without larger budgets', () => {
  const n = Number.MAX_SAFE_INTEGER;
  const value = { ...failure, pid: 4294967295, record: n, operationSeq: n, generation: n,
    droppedBefore: n, emittedBefore: n, suppressedBefore: n,
    screenshotStage: 'animation-stabilization', capturePhase: 'not-entered',
    inventoryAfterFailure: 'unavailable', error: 'unsupported-capability',
    timing: [60000000, 60000000, 60000000, 60000000, 60000000, 60000000, 3, false] };
  assert.equal(raw(value).length, 512); assert.equal(validTiming(value.timing), true);
});
test('missing reply is unknown observation, not proof that Chrome never replied', () => {
  const value = inspect(raw(start, { ...failure, timing: [1000000, 800000, null, 1000001, 1250000, 1255000, 0, false] }));
  assert.equal(value.status, 'complete'); assert.equal(value.timings[0].timing[2], null);
  assert.equal(value.timings[0].timing[6], 0); assert.equal(value.cleanupAcceptance, 'unknown');
});
test('schema rejects extra slots, wrong types, forged zero origins and contradictory ACKs', () => {
  for (const value of [null, {}, [...timing, 0], timing.slice(1), [null, ...timing.slice(1)],
    [60000001, ...timing.slice(1)], [-1, ...timing.slice(1)], [1.5, ...timing.slice(1)],
    ['1', ...timing.slice(1)], [...timing.slice(0, 6), 4, false], [...timing.slice(0, 7), 0],
    [1, 1, null, null, null, null, 1, false], [1, 1, 2, null, null, null, 0, false],
    [1, 1, 2, null, 5, 4, 1, false]]) assert.equal(validTiming(value), false);
  assert.equal(inspect(raw(start, { ...failure, private: 'never-accepted' })).status, 'unknown');
  assert.equal(inspect(raw({ ...start, timing })).status, 'unknown');
});
test('loss, overflow, malformed, gaps, missing start, incomplete and oversized data stay unknown', () => {
  for (const input of [raw(start, { ...failure, droppedBefore: 1 }), raw(start, { ...failure, suppressedBefore: 1 }),
    raw(start, { ...failure, overflow: true }), raw(start, { ...failure, record: 2 }), raw(failure),
    raw(start, { ...failure, emittedBefore: 0 }),
    raw(start, { ...start, record: 1, emittedBefore: 1 }, { ...failure, record: 2, emittedBefore: 2 }),
    raw(start, start, failure),
    raw(start, { ...failure, timing: [null, null, null, null, null, null, 0, true] }),
    Buffer.from('{broken}\n'), Buffer.from('x'.repeat(256 * 1024 + 1)), raw(start, failure).subarray(0, -1)]) {
    assert.equal(inspect(input).status, 'unknown');
  }
});
test('success kind does not invent writer-before-reader ordering', () => {
  assert.equal(validTiming([1000, 500, 499, null, 501, 502, 1, false]), true);
  assert.equal(validTiming([null, null, null, null, null, null, 0, true]), true);
});
