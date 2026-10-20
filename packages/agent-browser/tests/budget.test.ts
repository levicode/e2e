import test from 'node:test';
import assert from 'node:assert/strict';
import type { OperationContext } from 'e2e/engine';
import { bounded, beforeDispatch } from '../src/budget.ts';

const context = (timeoutMs: number, signal = new AbortController().signal): OperationContext => ({ timeoutMs, signal, runId: 'budget', attemptId: 'budget', origin: 'test' });

test('composite contexts monotonically consume one deadline', async () => {
  const operation = bounded(context(80));
  const first = operation.timeoutMs;
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = operation.timeoutMs;
  assert.ok(second < first);
  assert.ok(second > 0);
  const nested = bounded(operation);
  assert.ok(nested.timeoutMs <= second);
  await new Promise((resolve) => setTimeout(resolve, 85));
  assert.equal(operation.timeoutMs, 0);
  assert.equal(nested.timeoutMs, 0);
  assert.throws(() => beforeDispatch(operation), { code: 'OPERATION_TIMEOUT', retryable: false });
});

test('pre-dispatch cancellation never becomes uncertain mutation', () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => beforeDispatch(context(100, controller.signal)), { code: 'CANCELLED', retryable: false });
  assert.throws(() => beforeDispatch(context(0)), { code: 'OPERATION_TIMEOUT', retryable: false });
});

test('callback settlement is bounded even when a user promise never resolves', async () => {
  const { within } = await import('../src/budget.ts');
  await assert.rejects(within(new Promise<never>(() => undefined), context(10)), { code: 'OPERATION_TIMEOUT', retryable: false });
  assert.equal(await within(Promise.resolve(42), context(100)), 42);
});
