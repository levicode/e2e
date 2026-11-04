/** Framed SDK contract controls; native owner/debt authority is tested in Rust. */
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { chromium } from 'playwright-core';
import { type EngineAttemptContext } from 'e2e/engine';
import { web } from '../../src/index.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { serverMessage } from '../../src/native/protocol.ts';
import { NativeFrameError } from '../../src/native/frames.ts';
import { NativeProtocolPeer, type PeerOutcome, type PeerRequest } from '../helpers/native-protocol-peer.ts';
import { NativeInteropResources } from '../helpers/native-interop-resources.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
const capability = 'browser.observe-continuation/1';
const operation = () => ({ timeoutMs: 1000, signal: new AbortController().signal, runId: 'run', attemptId: 'a1', origin: 'test' as const });
const cleanup = () => ({ timeoutMs: 1000, signal: new AbortController().signal });
let peer: NativeProtocolPeer | undefined;
const snapshot = () => ({ identityScope: 'scope-1', revision: '1', viewport: { width: 100, height: 80 }, root: { ref: { id: '@e1', revision: '1' }, role: 'document' } });
const receipt = (sequence: number) => ({ version: 1, token: 'one-use-token', retiredOperationSeq: sequence });
const refusal = (frame: PeerRequest): PeerOutcome => ({ error: 'stale-scope', observeContinuation: receipt(frame.operationSeq) });
async function fixture(custom: (frame: PeerRequest) => PeerOutcome | Promise<PeerOutcome | undefined> | undefined, advertised = true) {
  const resources = new NativeInteropResources({ endpoint: 'ws://synthetic.test/open', browserIdentity: 'opaque-browser-1', allocateScopeIdentity: () => 'scope-1', allocateContextIdentity: () => ({ contextId: 'cdp-context-1', targetId: 'cdp-page-1' }) });
  vi.spyOn(chromium, 'connectOverCDP').mockImplementation(endpoint => resources.connectPlaywright(endpoint));
  vi.mocked(connectNativeProcess).mockImplementation(async (settings, budget, onEvent) => {
    peer = new NativeProtocolPeer([...new Set([...settings.capabilities, ...(advertised ? [capability] : [])])], request => resources.respond(request, async frame => {
      const response = await custom(frame); if (response !== undefined) return response;
      if (frame.command === 'page.activate') return { data: { activated: true } };
      if (frame.command === 'session.environment') return { data: { identityScope: 'scope-1', browser: 'Chromium/156.0' } };
      if (['scope.configure', 'network.routes.replace', 'context.viewport', 'context.media', 'page.navigate'].includes(frame.command)) return { data: null };
      throw new Error(`Unexpected command ${frame.command}`);
    }), { close: () => resources.closeNative() });
    return peer.connect(budget, onEvent);
  });
  const engine = web({ connect: { cdpEndpoint: () => 'ws://synthetic.test/open' } });
  await engine.init!({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: new AbortController().signal, log: () => undefined });
  const context: EngineAttemptContext = { attemptId: 'a1', artifactsDir: tmpdir(), signal: new AbortController().signal, resolveSecret: async () => { throw new Error('No secrets'); }, appLog: () => undefined, navigation: () => undefined, environment: () => undefined };
  await engine.startAttempt!(context);
  await engine.session!.open!('https://synthetic.test/', operation());
  return engine;
}
afterEach(() => { peer?.dispose(); peer = undefined; vi.restoreAllMocks(); vi.mocked(connectNativeProcess).mockReset(); });

test('continues one clean native-fenced observation with a fresh sequence and unchanged options', async () => {
  let count = 0; const options = { pixels: false, pixelFallback: true };
  const engine = await fixture(frame => {
    if (frame.command !== 'browser.observe') return undefined;
    if (++count === 1) { options.pixels = true; return refusal(frame); }
    return { data: snapshot() };
  });
  try {
    await expect(engine.observe!(operation(), options)).resolves.toMatchObject({ identityScope: 'scope-1' });
    const calls = peer!.requests.filter(frame => frame.command === 'browser.observe');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.operationSeq).toBeGreaterThan(calls[0]!.operationSeq);
    expect(calls[0]!.args['options']).toEqual({ pixels: false, pixelFallback: true });
    expect(calls[1]!.args).toEqual({ ...calls[0]!.args, continuation: receipt(calls[0]!.operationSeq) });
  } finally { await engine.dispose!(cleanup()).catch(() => undefined); }
});

test('retries one clean stale-scope observation and returns the second refusal', async () => {
  const engine = await fixture(frame => frame.command === 'browser.observe' ? { error: 'stale-scope' } : undefined);
  try {
    await expect(engine.observe!(operation())).rejects.toMatchObject({ code: 'INVALID_STATE', retryable: false });
    expect(peer!.requests.filter(frame => frame.command === 'browser.observe')).toHaveLength(2);
    expect(peer!.requests.filter(frame => frame.command === 'browser.observe')[1]!.operationSeq)
      .toBeGreaterThan(peer!.requests.filter(frame => frame.command === 'browser.observe')[0]!.operationSeq);
  } finally { await engine.dispose!(cleanup()).catch(() => undefined); }
});

test('never retries an unproven stale-scope observation', async () => {
  for (const effects of ['unknown', 'completed'] as const) {
    const engine = await fixture(frame => frame.command === 'browser.observe' ? { error: 'stale-scope', effects } : undefined);
    try {
      await expect(engine.observe!(operation())).rejects.toBeInstanceOf(Error);
      expect(peer!.requests.filter(frame => frame.command === 'browser.observe')).toHaveLength(1);
    } finally { await engine.dispose!(cleanup()).catch(() => undefined); }
  }
});

test('never chains a second continuation receipt', async () => {
  const engine = await fixture(frame => frame.command === 'browser.observe' ? refusal(frame) : undefined);
  try {
    await expect(engine.observe!(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(peer!.requests.filter(frame => frame.command === 'browser.observe')).toHaveLength(2);
  } finally { await engine.dispose!(cleanup()).catch(() => undefined); }
});

const valid = () => ({ type: 'result', id: 'r1', generation: 1, operationSeq: 1, ok: false, error: { code: 'stale-scope' }, effects: 'not-dispatched', scopeState: 'usable', observeContinuation: receipt(1) });
test('accepts only negotiated exact clean observation continuation envelopes', () => {
  expect(serverMessage(valid(), [capability])).toMatchObject({ observeContinuation: receipt(1) });
  expect(() => serverMessage(valid(), [])).toThrow(NativeFrameError);
  for (const changed of [
    { effects: 'completed' }, { effects: 'unknown' }, { scopeState: 'quarantined' }, { error: { code: 'scope-unavailable' } },
    { observeContinuation: { ...receipt(1), retiredOperationSeq: 2 } }, { observeContinuation: { ...receipt(1), token: '' } },
    { observeContinuation: { ...receipt(1), extra: true } }, { observeContinuation: { ...receipt(1), version: 2 } },
    { retention: { version: 1, retiredOperationSeq: 1, producerState: 'retired', inputDebt: 0, objectDebt: 0 } },
  ]) expect(() => serverMessage({ ...valid(), ...changed }, [capability])).toThrow(NativeFrameError);
});

test('does not restart the caller deadline or read changed flags for the continued capture', async () => {
  let remaining = 1000; let count = 0;
  const engine = await fixture(frame => {
    if (frame.command !== 'browser.observe') return undefined;
    if (++count === 1) { remaining = 125; return refusal(frame); }
    return { data: snapshot() };
  });
  try {
    await engine.observe!({ ...operation(), get timeoutMs() { return remaining; } });
    const calls = peer!.requests.filter(frame => frame.command === 'browser.observe');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.timeoutMs).toBeLessThanOrEqual(125);
    expect(calls[1]!.timeoutMs).toBeGreaterThan(0);
  } finally { await engine.dispose!(cleanup()).catch(() => undefined); }
});

test('does not issue the continuation after caller budget exhaustion', async () => {
  let remaining = 1000;
  const engine = await fixture(frame => {
    if (frame.command !== 'browser.observe') return undefined;
    remaining = 0; return refusal(frame);
  });
  try {
    await expect(engine.observe!({ ...operation(), get timeoutMs() { return remaining; } })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(peer!.requests.filter(frame => frame.command === 'browser.observe')).toHaveLength(1);
  } finally { await engine.dispose!(cleanup()).catch(() => undefined); }
});

test('does not issue the continuation after caller cancellation', async () => {
  const controller = new AbortController();
  const engine = await fixture(frame => {
    if (frame.command !== 'browser.observe') return undefined;
    controller.abort(); return refusal(frame);
  });
  try {
    await expect(engine.observe!({ ...operation(), signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(peer!.requests.filter(frame => frame.command === 'browser.observe')).toHaveLength(1);
  } finally { await engine.dispose!(cleanup()).catch(() => undefined); }
});

test('rejects a continuation attached to an action response without replaying the action', async () => {
  const actionPeer = new NativeProtocolPeer([capability], frame => refusal(frame));
  const client = await actionPeer.connect(operation(), () => {});
  try {
    await expect(client.request('browser.perform', { identityScope: 'scope-1' }, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(actionPeer.requests).toHaveLength(1);
  } finally { actionPeer.dispose(); }
});

test('a continuation refusal is not also retried as a clean stale-scope', async () => {
  let count = 0;
  const engine = await fixture(frame => frame.command === 'browser.observe' ? ++count === 1 ? refusal(frame) : { error: 'stale-scope' } : undefined);
  try {
    await expect(engine.observe!(operation())).rejects.toMatchObject({ code: 'INVALID_STATE', retryable: false });
    expect(peer!.requests.filter(frame => frame.command === 'browser.observe')).toHaveLength(2);
  } finally { await engine.dispose!(cleanup()).catch(() => undefined); }
});

test('rejects the old observation owner after a page replacement before consuming its receipt', async () => {
  let count = 0;
  const engine = await fixture(async frame => {
    if (frame.command !== 'browser.observe') return undefined;
    count++;
    await peer!.event('scope.page-reopened', { version: 1, identityScope: 'scope-1', previousPageIdentity: 'cdp-page-1', recoveryIdentity: { browser: 'opaque-browser-1', context: 'cdp-context-1', page: 'cdp-page-2' } });
    return refusal(frame);
  });
  try {
    await expect(engine.observe!(operation())).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(count).toBe(1);
  } finally { await engine.dispose!(cleanup()).catch(() => undefined); }
});

test('rejects an observation continuation offered inside a native callback', async () => {
  const callbackPeer = new NativeProtocolPeer([capability], frame => refusal(frame));
  let callbackFailure: unknown;
  const client = await callbackPeer.connect(operation(), async () => {
    callbackFailure = await client.request('browser.observe', { identityScope: 'scope-1', options: {} }, operation()).catch(error => error);
  });
  try {
    await callbackPeer.event('network.request', {}, { token: 'callback-token', timeoutMs: 1000 });
    expect(callbackFailure).toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(callbackPeer.requests).toHaveLength(1);
  } finally { callbackPeer.dispose(); }
});
