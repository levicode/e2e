import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeTestEvidence } from './native-evidence.ts';
test('upstream ignored inventory remains visible, not counted as passing', () => {
  assert.deepEqual(nativeTestEvidence('test result: ok. 25 passed; 0 failed; 157 ignored\ntest result: ok. 0 passed; 0 failed; 0 ignored'), { passed: 25, ignored: 157 });
});
test('empty exact filter cannot attest execution', () => {
  for (const log of ['', 'test result: ok. 0 passed; 0 failed; 0 ignored', 'test result: FAILED. 25 passed; 1 failed; 0 ignored']) assert.throws(() => nativeTestEvidence(log));
});
