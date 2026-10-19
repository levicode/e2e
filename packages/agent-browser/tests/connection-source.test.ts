import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineError } from 'e2e/engine';
import { ConnectionSource, validateConnect } from '../src/connection-source.ts';

const signal = (): AbortSignal => new AbortController().signal;
const attempt = (attemptId = 'a') => ({ attemptId, signal: signal() });

test('plain connect resolves once per worker and reuses its exact endpoint across attempts', async () => {
  let called = 0;
  const source = new ConnectionSource({ cdpEndpoint: async () => { called++; return 'wss://browser.example/devtools/browser/id?private=token'; } });
  source.init({ signal: signal() });
  assert.equal(source.scope, 'worker');
  assert.equal(called, 0);
  await source.startAttempt(attempt('first'));
  const endpoint = await source.endpoint(signal());
  assert.equal(await source.endpoint(signal()), endpoint);
  source.endAttempt();
  await source.startAttempt(attempt('second'));
  assert.equal(await source.endpoint(signal()), endpoint);
  assert.equal(called, 1);
  source.dispose();
});

test('reconnect-shaped connect provisions once per explicit attempt but never calls reconnect', async () => {
  let provisioned = 0;
  let reconnected = 0;
  const source = new ConnectionSource({
    cdpEndpoint: async () => `ws://browser.example/attempt-${++provisioned}`,
    reconnectEndpoint: async () => { reconnected++; return 'ws://browser.example/recovered'; },
  });
  source.init({ signal: signal() });
  assert.equal(source.scope, 'attempt');
  await source.startAttempt(attempt('first'));
  assert.equal(await source.endpoint(signal()), 'ws://browser.example/attempt-1');
  assert.equal(await source.endpoint(signal()), 'ws://browser.example/attempt-1');
  source.poisonAttempt();
  await assert.rejects(source.endpoint(signal()), { code: 'INVALID_STATE' });
  await assert.rejects(source.startAttempt(attempt('hidden-retry')), { code: 'INVALID_STATE' });
  assert.equal(provisioned, 1); assert.equal(reconnected, 0);
  source.endAttempt();
  await source.startAttempt(attempt('second'));
  assert.equal(await source.endpoint(signal()), 'ws://browser.example/attempt-2');
  assert.equal(reconnected, 0);
  source.dispose();
});

test('explicit attempt scope provisions a fresh endpoint per attempt without a reconnect callback', async () => {
  let provisioned = 0;
  const source = new ConnectionSource({ scope: 'attempt', cdpEndpoint: async () => `ws://browser.example/attempt-${++provisioned}` });
  source.init({ signal: signal() });
  assert.equal(source.scope, 'attempt');
  assert.equal(provisioned, 0);
  await source.startAttempt(attempt('first'));
  assert.equal(await source.endpoint(signal()), 'ws://browser.example/attempt-1');
  assert.equal(await source.endpoint(signal()), 'ws://browser.example/attempt-1');
  source.poisonAttempt();
  await assert.rejects(source.endpoint(signal()), { code: 'INVALID_STATE' });
  assert.equal(provisioned, 1);
  source.endAttempt();
  await source.startAttempt(attempt('second'));
  assert.equal(await source.endpoint(signal()), 'ws://browser.example/attempt-2');
  assert.equal(provisioned, 2);
  source.dispose();
});

test('explicit scope takes precedence over the legacy reconnect shape in the internal connection source', () => {
  const source = new ConnectionSource({ scope: 'worker', cdpEndpoint: async () => 'ws://browser.example/worker', reconnectEndpoint: async () => 'ws://browser.example/recovered' });
  assert.equal(source.scope, 'worker');
  source.dispose();
});

test('invalid shapes and private callback errors are replaced with static diagnostics', async () => {
  for (const value of [undefined, {}, [], { cdpEndpoint: 'secret' }, { cdpEndpoint: async () => '', private: true }, { cdpEndpoint: async () => '', reconnectEndpoint: 2 }, { cdpEndpoint: async () => '', scope: 'secret' }, { cdpEndpoint: async () => '', scope: null }]) {
    assert.throws(() => validateConnect(value), (error: unknown) => error instanceof Error && !String(error.stack).includes('secret') && 'code' in error && error.code === 'INVALID_CONFIG');
  }
  const source = new ConnectionSource({ cdpEndpoint: async () => { throw new Error('private credentials in callback'); } });
  source.init({ signal: signal() });
  await assert.rejects(source.startAttempt(attempt()), (error: unknown) => error instanceof EngineError && error.code === 'ENGINE_FAILURE' && !String(error.stack).includes('private') && error.cause === undefined);
  source.dispose();
});

test('endpoint validation rejects wrong schemes, fragments, empty and non-string results without echoing them', async () => {
  for (const value of ['', 'file:///private-token', 'https://browser.example/#private-token', 3, null]) {
    const source = new ConnectionSource({ cdpEndpoint: async () => value as string });
    source.init({ signal: signal() });
    await assert.rejects(source.startAttempt(attempt()), (error: unknown) => error instanceof EngineError && error.code === 'ENGINE_FAILURE' && !String(error.stack).includes('private-token'));
    source.dispose();
  }
});

test('failed worker provisioning is cached rather than silently repeated', async () => {
  let count = 0;
  const source = new ConnectionSource({ cdpEndpoint: async () => { count++; throw new Error('failed'); } });
  source.init({ signal: signal() });
  await assert.rejects(source.startAttempt(attempt('first')), { code: 'ENGINE_FAILURE' });
  source.endAttempt();
  await assert.rejects(source.startAttempt(attempt('second')), { code: 'ENGINE_FAILURE' });
  assert.equal(count, 1);
  source.dispose();
});

test('an ended attempt rejects a late endpoint without contaminating the next attempt', async () => {
  let late: ((value: string) => void) | undefined;
  let calls = 0;
  const source = new ConnectionSource({
    cdpEndpoint: async () => ++calls === 1 ? await new Promise<string>((resolve) => { late = resolve; }) : 'ws://browser.example/new',
    reconnectEndpoint: async () => { throw new Error('Never called'); },
  });
  source.init({ signal: signal() });
  const first = source.startAttempt(attempt('first'));
  await Promise.resolve();
  source.endAttempt();
  await assert.rejects(first, { code: 'CANCELLED' });
  await source.startAttempt(attempt('second'));
  assert.ok(late); late('ws://browser.example/old');
  await Promise.resolve();
  assert.equal(await source.endpoint(signal()), 'ws://browser.example/new');
  assert.equal(calls, 2);
  source.dispose();
});

test('callback deadline aborts its signal without retrying or adopting late success', async () => {
  let callbackSignal: AbortSignal | undefined;
  let late: ((value: string) => void) | undefined;
  const source = new ConnectionSource({ cdpEndpoint: async (abort) => { callbackSignal = abort; return await new Promise<string>((resolve) => { late = resolve; }); } });
  source.init({ signal: signal() });
  await assert.rejects(source.startAttempt({ ...attempt(), timeoutMs: 15 }), { code: 'OPERATION_TIMEOUT' });
  assert.equal(callbackSignal?.aborted, true);
  assert.ok(late); late('ws://browser.example/too-late');
  await assert.rejects(source.endpoint(signal()), { code: 'OPERATION_TIMEOUT' });
  source.dispose();
});

test('cancellation is checked before callbacks and remains tied to the original attempt signal', async () => {
  let count = 0;
  const source = new ConnectionSource({ cdpEndpoint: async () => { count++; return 'ws://browser.example/current'; } });
  source.init({ signal: signal() });
  await assert.rejects(source.startAttempt({ attemptId: 'cancelled', signal: AbortSignal.abort('private reason') }), { code: 'CANCELLED' });
  assert.equal(count, 0);
  const controller = new AbortController();
  await source.startAttempt({ attemptId: 'active', signal: controller.signal });
  controller.abort();
  await assert.rejects(source.endpoint(signal()), { code: 'CANCELLED' });
  source.dispose();
});

test('config callback references and scope are snapshotted before user mutation', async () => {
  const config = { cdpEndpoint: async () => 'ws://browser.example/original', reconnectEndpoint: undefined as ((signal: AbortSignal) => Promise<string>) | undefined };
  const source = new ConnectionSource(config);
  config.cdpEndpoint = async () => 'ws://browser.example/replacement';
  config.reconnectEndpoint = async () => 'ws://browser.example/reconnect';
  source.init({ signal: signal() });
  await source.startAttempt(attempt());
  assert.equal(source.scope, 'worker');
  assert.equal(await source.endpoint(signal()), 'ws://browser.example/original');
  source.dispose();
});

test('explicit attempt scope remains snapshotted after the config becomes worker-scoped', async () => {
  let calls = 0;
  const config = { scope: 'attempt' as 'worker' | 'attempt', cdpEndpoint: async () => `ws://browser.example/original-${++calls}` };
  const source = new ConnectionSource(config);
  config.scope = 'worker';
  config.cdpEndpoint = async () => 'ws://browser.example/replacement';
  source.init({ signal: signal() });
  assert.equal(source.scope, 'attempt');
  await source.startAttempt(attempt('first'));
  assert.equal(await source.endpoint(signal()), 'ws://browser.example/original-1');
  source.endAttempt();
  await source.startAttempt(attempt('second'));
  assert.equal(await source.endpoint(signal()), 'ws://browser.example/original-2');
  source.dispose();
});
