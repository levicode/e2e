/**
 * Public protected-capture adapter contracts, including the closed-root mask refusal boundary.
 * The real NativeSurface/NativeClient framed peer below proves no adapter fallback or pixel read
 * after native policy refusal, not closed-root discovery, source masking or restoration itself.
 * Those producer obligations remain in integration/closed-shadow.test.ts and the exact native
 * closed-shadow/mask/restoration gates. No private Playwright registry or selector mock remains.
 * Conditional retirement: original closed-shadow:1/2/3 require their paired producer receipts.
 */
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestError, type OperationContext } from 'e2e/engine';
import { NativeSurface } from '../../src/native-surface.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeProtocolPeer } from '../helpers/native-protocol-peer.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'policy', attemptId: 'attempt', origin: 'test' });
const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 1000 });
afterEach(() => vi.restoreAllMocks());

describe('NativeSurface clean policy boundary', () => {
  // These preserve the adapter half of legacy semantic-fallback policy cases.
  // Native branch/error-priority, no-capture and restoration proofs remain separate obligations.
  it.each([false, true])('preserves a clean policy refusal without adapter fallback (pixels=%s)', async pixels => {
    let peer!: NativeProtocolPeer;
    vi.mocked(connectNativeProcess).mockImplementationOnce(async (config, context, onEvent) => {
      peer = new NativeProtocolPeer(config.capabilities, request => {
        if (request.command === 'scope.open') return { data: { identityScope: 'scope', recoveryIdentity: { browser: 'browser', context: 'context', page: 'page' } } };
        if (request.command === 'browser.observe') return { error: 'policy-denied' };
        if (request.command === 'page.title') return { data: { title: 'still usable' } };
        return { data: null };
      });
      return peer.connect(context, onEvent);
    });
    const surface = new NativeSurface({});
    await surface.init({ runId: 'policy', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: operation().signal, log: () => {} });
    try {
      await surface.startAttempt({ attemptId: 'attempt', artifactsDir: tmpdir(), signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
      const initial = peer.requests.length;
      const failure: unknown = await surface.observe(operation(), { pixels, pixelFallback: true }).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(TestError);
      expect(failure).toMatchObject({ code: 'POLICY_DENIED', category: 'test', retryable: false });
      expect(peer.requests.slice(initial).map(request => request.command)).toEqual(['browser.observe']);
      expect(peer.requests.at(-1)?.args['options']).toEqual({ pixels, pixelFallback: true });
      await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'still usable' });
      expect(peer.requests.some(request => request.command === 'capture.screenshot' || request.command === 'blob.read')).toBe(false);
    } finally { await surface.dispose(cleanup()); }
  });
});
