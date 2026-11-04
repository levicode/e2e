/** Real NativeSurface and NativeClient framing; native traversal semantics are tested in Rust. */
import { tmpdir } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { chromium } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineAppInfo, OperationContext } from 'e2e/engine';
import { NativeSurface } from '../../src/native-surface.ts';
import { NativeClient } from '../../src/native/client.ts';
import { ISOLATED_PAGE_REOPEN_CAPABILITY, PAGE_IDENTITY_FENCE_CAPABILITY, OBSERVE_FRAME_POLICY_CAPABILITY, REQUIRED_CAPABILITIES } from '../../src/native/capabilities.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import type { NativeEvent } from '../../src/native/protocol.ts';
import { NativeInteropResources } from '../helpers/native-interop-resources.ts';
import type { PeerRequest } from '../helpers/native-protocol-peer.ts';
import { noSecrets } from '../helpers/secrets.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));

afterEach(() => vi.restoreAllMocks());
const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'frame-policy', attemptId: 'attempt', origin: 'test' });
const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 1000 });

// Advertised and required capabilities are independent. A peer that uses the
// same array for both cannot prove rejection of an old native implementation.
function peer(advertised: readonly string[]) {
  const resources = new NativeInteropResources({ allocateScopeIdentity: () => 'scope' });
  vi.spyOn(chromium, 'connectOverCDP').mockImplementation(endpoint => resources.connectPlaywright(endpoint));
  const frames: Record<string, unknown>[] = [];
  const output = new PassThrough();
  const send = (message: unknown) => queueMicrotask(() => { if (!output.destroyed) output.write(JSON.stringify(message) + '\n'); });
  let revision = 0;
  const input = new Writable({ write(chunk: Buffer, _encoding, done) {
    try {
      const frame = JSON.parse(chunk.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (frame['type'] === 'hello') send({ type: 'ready', id: frame['id'], protocol: 'agent-browser-session/1', sessionId: 'frame-policy-peer', generation: 1, capabilities: advertised,
        limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
      else if (frame['type'] === 'close') { resources.closeNative(); send({ type: 'closed', id: frame['id'], generation: 1, scopeState: 'closed' }); }
      else if (frame['type'] === 'request') {
        void (async () => {
          const outcome = await resources.respond(frame as unknown as PeerRequest, request => {
            switch (request.command) {
              case 'scope.configure': case 'network.routes.replace': return { data: null };
              case 'page.activate': return { data: { activated: true } };
              case 'browser.observe': return { data: { identityScope: 'scope', revision: String(++revision), viewport: { width: 100, height: 80 }, root: { ref: { id: '@e1', revision: String(revision) }, role: 'document' } } };
              default: return undefined;
            }
          });
          send({ type: 'result', id: frame['id'], generation: 1, operationSeq: frame['operationSeq'],
            ...('data' in outcome ? { ok: true, data: outcome.data, effects: 'completed', scopeState: 'usable' }
              : { ok: false, error: { code: outcome.error }, effects: outcome.effects ?? 'not-dispatched', scopeState: outcome.scopeState ?? 'usable' }),
          });
        })().catch(cause => output.destroy(cause instanceof Error ? cause : new Error('Invalid frame-policy fixture response')));
      } else throw new Error('Unexpected frame-policy adapter frame');
      done();
    } catch (cause) { done(cause instanceof Error ? cause : new Error('Invalid adapter fixture frame')); }
  } });
  const dispose = vi.fn(() => { input.destroy(); output.destroy(); });
  return {
    frames, dispose,
    connect: (required: readonly string[], context = operation(), onEvent: (event: NativeEvent) => void | Promise<void> = () => {}) =>
      NativeClient.connect({ readable: output, writable: input, dispose }, required, context, onEvent),
  };
}

async function init(surface: NativeSurface, app: EngineAppInfo): Promise<void> {
  await surface.init({ runId: 'frame-policy', targetName: 'web', projectRoot: process.cwd(), app, env: {}, headed: false, workerSlot: 0, signal: operation().signal, log: () => {} });
}

function attachPeer(fixture: ReturnType<typeof peer>): void {
  vi.mocked(connectNativeProcess).mockImplementationOnce((options, context, onEvent) => fixture.connect(options.capabilities, context, onEvent));
}

describe('native observation frame-policy capability', () => {
  it('rejects an old native missing the required frame-policy contract before scope creation', async () => {
    expect(OBSERVE_FRAME_POLICY_CAPABILITY).toBe('browser.observe-frame-policy/1');
    const advertised = [...REQUIRED_CAPABILITIES, PAGE_IDENTITY_FENCE_CAPABILITY, ISOLATED_PAGE_REOPEN_CAPABILITY].filter(capability => capability !== OBSERVE_FRAME_POLICY_CAPABILITY);
    const fixture = peer(advertised);
    attachPeer(fixture);
    const surface = new NativeSurface({});
    try {
      await expect(init(surface, { site: 'example.test' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', retryable: false });
      expect(REQUIRED_CAPABILITIES.filter(capability => capability === OBSERVE_FRAME_POLICY_CAPABILITY)).toHaveLength(1);
      expect(fixture.frames.map(frame => frame['type'])).toEqual(['hello']);
      expect(fixture.frames[0]?.['requiredCapabilities']).toEqual([...REQUIRED_CAPABILITIES, PAGE_IDENTITY_FENCE_CAPABILITY, ISOLATED_PAGE_REOPEN_CAPABILITY]);
      expect(fixture.dispose).toHaveBeenCalledOnce();
    } finally { await surface.dispose(cleanup()); }
  });

  it('accepts the required contract plus additive native capabilities without changing the hello shape', async () => {
    const advertised = [...REQUIRED_CAPABILITIES, 'future.additive/1'];
    const fixture = peer(advertised);
    const client = await fixture.connect(REQUIRED_CAPABILITIES);
    try {
      expect(client.negotiation().capabilities).toEqual(advertised);
      expect(fixture.frames).toHaveLength(1);
      expect(fixture.frames[0]).toEqual({ type: 'hello', id: expect.any(String), protocol: 'agent-browser-session/1', requiredCapabilities: REQUIRED_CAPABILITIES });
    } finally { await client.close(operation()); }
    expect(fixture.frames.map(frame => frame['type'])).toEqual(['hello', 'close']);
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'example.test', 'EXACT.Configured.Site'])('sends app.site=%s only through scope.configure, never an observe override', async site => {
    const fixture = peer([...REQUIRED_CAPABILITIES, PAGE_IDENTITY_FENCE_CAPABILITY, ISOLATED_PAGE_REOPEN_CAPABILITY, 'future.additive/1']);
    attachPeer(fixture);
    const surface = new NativeSurface({});
    const app: { site?: string } = site === undefined ? {} : { site };
    await init(surface, app);
    try {
      await surface.startAttempt({ attemptId: 'attempt', artifactsDir: tmpdir(), signal: operation().signal, resolveSecret: noSecrets, appLog: () => {}, navigation: () => {}, environment: () => {} });
      const configured = fixture.frames.find(frame => frame['command'] === 'scope.configure');
      expect(configured?.['args']).toEqual({ identityScope: 'scope', testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]', requestPolicy: site === undefined ? {} : { site }, downloads: { source: 'local' } });
      const before = fixture.frames.filter(frame => frame['type'] === 'request').map(frame => frame['command']);
      expect(before).toEqual(['scope.interop.prepare', 'scope.interop.adopt', 'scope.configure', 'network.routes.replace']);
      // Mutation of caller-owned init data cannot rewrite the already configured
      // native policy through later observe requests. This is wire-flow evidence,
      // not a mock implementation of native same-site/default/depth semantics.
      app.site = 'later-caller-change.invalid';
      await expect(surface.observe(operation())).resolves.toMatchObject({ identityScope: 'scope' });
      await expect(surface.observe(operation(), { pixels: false, pixelFallback: false, comparable: true })).resolves.toMatchObject({ identityScope: 'scope' });
      const requests = fixture.frames.filter(frame => frame['type'] === 'request');
      expect(requests.map(frame => frame['command'])).toEqual([...before, 'browser.observe', 'browser.observe']);
      expect(requests.slice(-2).map(frame => frame['args'])).toEqual([
        { identityScope: 'scope', options: {}, testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]' },
        { identityScope: 'scope', options: { pixels: false, pixelFallback: false, comparable: true }, testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]' },
      ]);
      expect(requests.filter(frame => frame['command'] === 'scope.configure')).toHaveLength(1);
      expect(JSON.stringify(requests)).not.toContain('later-caller-change.invalid');
      expect(configured?.['args']).toEqual({ identityScope: 'scope', testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]', requestPolicy: site === undefined ? {} : { site }, downloads: { source: 'local' } });
    } finally { await surface.dispose(cleanup()); }
  });
});
