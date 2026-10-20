import assert from 'node:assert/strict';
import test from 'node:test';
import { callbackLifetime, guardCallbackScope, runCallbackScope } from '../src/callback-scope.ts';

test('callback scope follows awaited continuations without contaminating callers', async () => {
  const owner = {};
  let active = true;
  let release: (() => void) | undefined;
  const pending = runCallbackScope(owner, () => { assert.ok(active, 'Retired callback'); }, async () => {
    guardCallbackScope(owner);
    await new Promise<void>(resolve => { release = resolve; });
    guardCallbackScope(owner);
  });
  active = false;
  guardCallbackScope(owner);
  assert.ok(release); release();
  await assert.rejects(pending, /Retired callback/);
  guardCallbackScope(owner);
});

test('nested callback scopes preserve other owners and compose their own guards', async () => {
  const first = {};
  const second = {};
  let firstCalls = 0;
  let secondCalls = 0;
  let freshCalls = 0;
  await runCallbackScope(first, () => { firstCalls++; }, async () => {
    await runCallbackScope(second, () => { secondCalls++; }, async () => {
      await Promise.resolve();
      guardCallbackScope(first); guardCallbackScope(second);
      await runCallbackScope(first, () => { freshCalls++; }, async () => {
        await Promise.resolve();
        guardCallbackScope(first); guardCallbackScope(second);
      });
      guardCallbackScope(first);
    });
    guardCallbackScope(second);
  });
  assert.equal(firstCalls, 3);
  assert.equal(secondCalls, 2);
  assert.equal(freshCalls, 1);
});

test('callback lifetime blocks retired, cancelled, and expired continuations without retiring callers', async () => {
  const owner = {};
  const controller = new AbortController();
  const operation = { signal: controller.signal, timeoutMs: 1_000, runId: 'r', attemptId: 'a', origin: 'test' as const };
  const lifetime = callbackLifetime(operation);
  let release!: () => void;
  const pending = runCallbackScope(owner, lifetime.guard, async () => {
    guardCallbackScope(owner);
    await new Promise<void>(resolve => { release = resolve; });
    guardCallbackScope(owner);
  });
  lifetime.retire();
  lifetime.retire();
  release();
  await assert.rejects(pending, { code: 'INVALID_STATE', retryable: false });
  guardCallbackScope(owner);
  const aborted = callbackLifetime(operation);
  controller.abort();
  assert.throws(aborted.guard, { code: 'CANCELLED', retryable: false });
  const expired = callbackLifetime({ ...operation, signal: new AbortController().signal, timeoutMs: 0 });
  assert.throws(expired.guard, { code: 'OPERATION_TIMEOUT', retryable: false });
});

test('nested callbacks cannot replace an expired ancestor guard for the same surface', () => {
  const owner = {};
  assert.throws(() => runCallbackScope(owner, () => { throw new Error('Expired ancestor'); }, () => {
    runCallbackScope(owner, () => {}, () => guardCallbackScope(owner));
  }), /Expired ancestor/);
});
