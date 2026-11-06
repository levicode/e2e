import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UAT_UNUSABLE_EXIT, verifyExitCode } from '../src/verify-exit.ts';

test('verify keeps 2 for unusable settings and maps a run CLI error away from it', () => {
  assert.equal(UAT_UNUSABLE_EXIT, 2);
  assert.equal(verifyExitCode(0, false), 0);
  assert.equal(verifyExitCode(1, false), 1);
  assert.equal(verifyExitCode(2, false), 3);
  assert.equal(verifyExitCode(3, false), 3);
  assert.equal(verifyExitCode(0, true), 2);
  assert.equal(verifyExitCode(2, true), 2);
});
