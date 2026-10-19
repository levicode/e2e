import assert from 'node:assert/strict';
import test from 'node:test';
import { guardCallbackScope, runCallbackScope } from '../src/callback-scope.ts';

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

test('nested callback scopes preserve other owners and refresh only their own generation', async () => {
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
  assert.equal(firstCalls, 2);
  assert.equal(secondCalls, 2);
  assert.equal(freshCalls, 1);
});
