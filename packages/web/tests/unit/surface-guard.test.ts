/** Native operation admission: preserve callback classification and cancellation without a browser. */
import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestError, type OperationContext } from 'e2e/engine';
import { NativeSurface } from '../../src/native-surface.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeInteropResources } from '../helpers/native-interop-resources.ts';
import { NativeProtocolPeer } from '../helpers/native-protocol-peer.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
const operation = (signal = new AbortController().signal): OperationContext => ({ signal, timeoutMs: 1000, runId: 'run', attemptId: 'a1', origin: 'test' });
const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 1000 });
let surface: NativeSurface;
let peer: NativeProtocolPeer;
let holdTitle: boolean;
let failedClient: boolean;
beforeEach(async () => {
  holdTitle = false; failedClient = false;
  const resources = new NativeInteropResources();
  vi.spyOn(chromium, 'connectOverCDP').mockImplementation(endpoint => resources.connectPlaywright(endpoint));
  vi.mocked(connectNativeProcess).mockImplementation(async (options, context, onEvent) => {
    peer = new NativeProtocolPeer(options.capabilities, async frame => {
      if (frame.command.startsWith('scope.interop.') || frame.command === 'scope.end') return resources.respond(frame);
      if (frame.command === 'page.title') { if (holdTitle) return new Promise(() => {}); return { data: { title: 'ok' } }; }
      if (frame.command === 'scope.configure' || frame.command === 'network.routes.replace') return { data: null };
      throw new Error(`Unexpected guard command: ${frame.command}`);
    }, { close: () => resources.closeNative() });
    return peer.connect(context, onEvent);
  });
  surface = new NativeSurface({});
  await surface.init({ runId: 'run', targetName: 'web', projectRoot: '/tmp', app: {}, env: {}, headed: false, workerSlot: 0, signal: operation().signal, log: () => {} });
  await surface.startAttempt({ attemptId: 'a1', artifactsDir: '/tmp/synthetic-guard-artifacts', signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
});
afterEach(async () => {
  if (failedClient) await expect(surface.dispose(cleanup())).rejects.toMatchObject({ code: 'CANCELLED' });
  else await surface.dispose(cleanup());
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('native surface operation admission', () => {
  it('rethrows a latched error once, with its own classification, before dispatching anything', async () => {
    const violation = new TestError('ACTION_FAILED', 'route handler returned without deciding');
    surface.latch.latch(violation); const before = peer.requests.length;
    await expect(surface.command('page.title', {}, operation())).rejects.toBe(violation);
    expect(peer.requests).toHaveLength(before);
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'ok' });
  });
  it('refuses an already-cancelled operation as CANCELLED', async () => {
    const controller = new AbortController(); controller.abort(); const before = peer.requests.length;
    await expect(surface.command('page.title', {}, operation(controller.signal))).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
    expect(peer.requests).toHaveLength(before);
  });
  it('stops waiting on a dispatched call once the operation aborts mid-flight', async () => {
    vi.useFakeTimers();
    holdTitle = true; const controller = new AbortController();
    const pending = surface.command('page.title', {}, operation(controller.signal));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(0);
    expect(peer.requests.some(frame => frame.command === 'page.title')).toBe(true);
    failedClient = true; controller.abort();
    // No result ever arrives: retain the unchanged 5s cancellation-settlement
    // boundary without racing Vitest's own 5s wall-clock test timeout.
    let settled = false; void pending.catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(4999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(peer.frames.some(frame => frame['type'] === 'cancel')).toBe(true);
  });
});
