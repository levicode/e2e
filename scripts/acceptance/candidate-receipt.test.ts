import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateReceiptProblem } from './candidate-receipt.ts';

test('final receipt never retains rejected JSON fragments but preserves existing validation labels', () => {
  let failure: unknown;
  try { JSON.parse('synthetic-private-fragment'); } catch (error) { failure = error; }
  assert.equal(candidateReceiptProblem(failure), 'Candidate receipt JSON is invalid');
  assert.equal(candidateReceiptProblem(new Error('Fault runtime identity is not separate and bound')), 'Error: Fault runtime identity is not separate and bound');
});
