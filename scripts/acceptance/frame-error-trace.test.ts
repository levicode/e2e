import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeTraceVersion } from './candidate-semantic-trace.ts';

test('frame errors add closed scalar trace codes, never selectors or facts objects', () => {
  const trace = { schemaVersion: 1, pid: 12, record: 0, operationSeq: 1, phase: 'ResultQueued', droppedBefore: 0 };
  for (const error of ['frame-not-found', 'frame-ambiguous', 'invalid-arguments']) {
    assert.equal(nativeTraceVersion({ ...trace, error }), 1);
    assert.equal(nativeTraceVersion({ ...trace, error: { code: error, frameSelection: { index: 1, count: 0 } } }), undefined);
    assert.equal(nativeTraceVersion({ ...trace, error, frameSelection: { index: 1, count: 0 } }), undefined);
    assert.equal(nativeTraceVersion({ ...trace, error, selector: '#private' }), undefined);
  }
  assert.equal(nativeTraceVersion({ ...trace, error: 'frame-other' }), undefined);
});
