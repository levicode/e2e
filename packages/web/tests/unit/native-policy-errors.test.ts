/** Public policy classification only; a framed peer does not prove native mask coverage or cleanup. */
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineError, TestError, type OperationContext } from 'e2e/engine';
import { NativeSurface } from '../../src/native-surface.ts';
import { BrowserChannel, isNativeNotDispatched, resultError } from '../../src/native/browser-channel.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { serverMessage, type Effects, type NativeResult, type ScopeState } from '../../src/native/protocol.ts';
import { NativeProtocolPeer } from '../helpers/native-protocol-peer.ts';
import { NativeInteropResources } from '../helpers/native-interop-resources.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'policy', attemptId: 'attempt', origin: 'test' });
const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 1000 });
afterEach(() => vi.restoreAllMocks());

function policyResult(effects: Effects, scopeState: ScopeState): NativeResult {
  const result: NativeResult = { type: 'result', id: 'policy', generation: 1, operationSeq: 1, ok: false, error: { code: 'policy-denied' }, effects, scopeState };
  expect(serverMessage({ ...result })).toEqual(result);
  return result;
}

const matrix = [
  ['not-dispatched', 'usable', 'POLICY_DENIED'],
  ['completed', 'usable', 'ENGINE_FAILURE'],
  ['not-dispatched', 'quarantined', 'ENGINE_FAILURE'],
  ['completed', 'quarantined', 'ENGINE_FAILURE'],
  ['unknown', 'quarantined', 'ACTION_MAY_HAVE_COMMITTED'],
  ['not-dispatched', 'closed', 'ENGINE_FAILURE'],
  ['completed', 'closed', 'ENGINE_FAILURE'],
  ['unknown', 'closed', 'ACTION_MAY_HAVE_COMMITTED'],
] as const;

describe('native policy error classification', () => {
  it.each(matrix)('keeps %s / %s policy evidence as %s', (effects, scopeState, code) => {
    const failure = resultError(policyResult(effects, scopeState));
    expect(failure).toMatchObject({ code, retryable: false });
    expect(failure instanceof TestError).toBe(code === 'POLICY_DENIED');
    expect(failure instanceof EngineError).toBe(code !== 'POLICY_DENIED');
    expect(isNativeNotDispatched(failure)).toBe(code === 'POLICY_DENIED');
    if (code === 'POLICY_DENIED') expect(failure).toMatchObject({ category: 'test' });
  });

  it('does not grant clean ownership from a caller-crafted or copied policy error', () => {
    const genuine = resultError(policyResult('not-dispatched', 'usable'));
    const impostor = new TestError('POLICY_DENIED', 'The native browser operation was denied by policy');
    expect(isNativeNotDispatched(impostor)).toBe(false);
    expect(isNativeNotDispatched(Object.assign(new Error(), genuine))).toBe(false);
    expect(isNativeNotDispatched({ code: 'POLICY_DENIED', retryable: false, category: 'test' })).toBe(false);
    expect(isNativeNotDispatched(genuine)).toBe(true);
  });

  it('never accepts unknown effects with a usable scope as policy evidence', () => {
    expect(() => serverMessage({ type: 'result', id: 'policy', generation: 1, operationSeq: 1, ok: false, error: { code: 'policy-denied' }, effects: 'unknown', scopeState: 'usable' })).toThrow();
  });
});

describe.each(['engine', 'browser'] as const)('framed %s policy boundary', kind => {
  it.each(matrix)('preserves %s / %s classification and transport retirement', async (effects, scopeState, code) => {
    const peer = new NativeProtocolPeer([], request => request.command === 'page.title'
      ? { data: { title: 'still usable' } }
      : { error: 'policy-denied', effects, scopeState });
    const disposed = vi.spyOn(peer, 'dispose');
    const client = await peer.connect(operation(), () => {});
    const engine = new EngineChannel(client);
    const browser = new BrowserChannel(client, { identityScope: () => 'scope', operation });
    try {
      const pending = kind === 'engine'
        ? engine.command('browser.observe', { identityScope: 'scope', options: { pixelFallback: true }, testIdAttribute: 'data-testid', secureFieldSelector: 'input[type=password]' }, operation())
        : browser.command('page.reload', {}, operation());
      // Only protected reads may restore a completed prefix and retain its policy reason.
      // The generic resultError and BrowserChannel matrices above/below stay unchanged.
      const expectedCode = kind === 'engine' && effects === 'completed' && scopeState === 'usable' ? 'POLICY_DENIED' : code;
      await expect(pending).rejects.toMatchObject({ code: expectedCode, retryable: false });
      const failure: unknown = await pending.catch((cause: unknown) => cause);
      expect(isNativeNotDispatched(failure)).toBe(effects === 'not-dispatched' && scopeState === 'usable');
      expect(peer.requests.map(request => request.command)).toEqual([kind === 'engine' ? 'browser.observe' : 'page.reload']);
      if (scopeState === 'usable') {
        expect(disposed).not.toHaveBeenCalled();
        await expect(browser.command('page.title', {}, operation())).resolves.toEqual({ title: 'still usable' });
      } else {
        expect(disposed).toHaveBeenCalledOnce();
        const frames = peer.frames.length;
        await expect(browser.command('page.title', {}, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
        expect(peer.frames).toHaveLength(frames);
      }
    } finally {
      if (scopeState === 'usable') await client.close(operation());
      else await expect(client.close(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    }
  });
});

describe('NativeSurface clean policy boundary', () => {
  it('retains a cleanly refused unopened client without trusting the policy code alone', async () => {
    let peer!: NativeProtocolPeer;
    const resources = new NativeInteropResources();
    resources.refuseNext('scope.interop.prepare', 'policy-denied');
    const connectPW = vi.spyOn(chromium, 'connectOverCDP').mockImplementation(endpoint => resources.connectPlaywright(endpoint));
    vi.mocked(connectNativeProcess).mockImplementationOnce(async (config, context, onEvent) => {
      peer = new NativeProtocolPeer(config.capabilities, request => resources.respond(request, call => {
        if (call.command === 'scope.configure' || call.command === 'network.routes.replace') return { data: null };
        return undefined;
      }), { close: () => resources.closeNative() });
      return peer.connect(context, onEvent);
    });
    const surface = new NativeSurface({});
    await surface.init({ runId: 'policy', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: operation().signal, log: () => {} });
    const disposed = vi.spyOn(peer, 'dispose');
    const attempt = (attemptId: string) => ({ attemptId, artifactsDir: tmpdir(), signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
    try {
      await expect(surface.startAttempt(attempt('denied'))).rejects.toMatchObject({ code: 'POLICY_DENIED', category: 'test' });
      expect(disposed).not.toHaveBeenCalled();
      expect(peer.requests.map(request => request.command)).toEqual(['scope.interop.prepare']);
      expect(connectPW).not.toHaveBeenCalled();
      expect(resources.snapshot()).toEqual({ prepared: false, nativeContexts: 0, playwrightClients: 0, playwrightContexts: 0, contextCloseEvents: 0 });
      await surface.endAttempt(cleanup());
      await expect(surface.startAttempt(attempt('next'))).resolves.toBeUndefined();
      expect(peer.requests.filter(request => request.command === 'scope.interop.prepare')).toHaveLength(2);
      expect(peer.requests.map(request => request.command)).toEqual(['scope.interop.prepare', 'scope.interop.prepare', 'scope.interop.adopt', 'scope.configure', 'network.routes.replace']);
      expect(connectPW).toHaveBeenCalledOnce();
      expect(resources.snapshot()).toEqual({ prepared: false, nativeContexts: 1, playwrightClients: 1, playwrightContexts: 1, contextCloseEvents: 0 });
      expect(disposed).not.toHaveBeenCalled();
    } finally { await surface.dispose(cleanup()); }
    expect(peer.requests.map(request => request.command)).toEqual(['scope.interop.prepare', 'scope.interop.prepare', 'scope.interop.adopt', 'scope.configure', 'network.routes.replace', 'scope.interop.retire', 'scope.end']);
    expect(resources.snapshot()).toEqual({ prepared: false, nativeContexts: 0, playwrightClients: 0, playwrightContexts: 0, contextCloseEvents: 1 });
  });


});
