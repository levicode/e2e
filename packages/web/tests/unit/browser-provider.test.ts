/**
 * The browser provider seam without a real browser: a scripted provider and a
 * real NativeClient over an in-memory framed peer. Leases per slot, worker
 * hand-off, attachment endpoints, replacement after browser loss, per-attempt
 * leases, and release on every path. No browser conformance is implied.
 */

import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineError, withTimeout, type EngineAttemptContext, type EngineCleanupContext, type EngineFinishInfo, type EngineInitInfo, type EnginePrepareInfo, type OperationContext, type ProviderRecordContext, type ProviderRecording } from 'e2e/engine';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeProtocolPeer } from '../helpers/native-protocol-peer.ts';
import { NativeInteropResources } from '../helpers/native-interop-resources.ts';
import { web } from '../../src/index.ts';
import { LeasedBrowsers, type BrowserLease, type BrowserProvider, type BrowserReleaseContext, type BrowserRequest } from '../../src/provider.ts';
import { NativeSurface } from '../../src/native-surface.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));

interface ProviderPeer { peer: NativeProtocolPeer; resources?: NativeInteropResources; scope: string; dropBrowser(): Promise<void>; dropScope(): Promise<void> }
const peers: ProviderPeer[] = [];
let nextScope = 0;
let repeatedContext: string | undefined;
let failOpen = false;
let failEnd = false;
const videoBytes = Buffer.from('synthetic native WebM transfer');

/** Endpoints are asserted at actual scope attachment/recovery, not at proxy negotiation. */
function endpoints(): unknown[] {
  return peers.flatMap(({ peer }) => peer.requests)
    .filter(request => request.command === 'scope.reconnect' || (['scope.open', 'scope.interop.prepare'].includes(request.command) && request.args['source'] === 'connect'))
    .map(request => request.args['endpoint']);
}

/** A protocol transcript is a test oracle, not a browser or a compatibility Page. */
function installNativePeers(): void {
  vi.mocked(connectNativeProcess).mockReset().mockImplementation(async (options, operation, onEvent) => {
    const owner: ProviderPeer = {
      peer: undefined as unknown as NativeProtocolPeer,
      scope: '',
      dropBrowser: () => owner.peer.event('browser.disconnected', { reason: 'browser-connection-closed' }),
      dropScope: () => owner.peer.event('scope.disconnected', { identityScope: owner.scope, reason: 'browser-connection-closed' }),
    };
    const peerIndex = peers.length + 1;
    let resourceIdentity = 0;
    owner.peer = new NativeProtocolPeer(options.capabilities, request => {
      const command = request.command;
      if (command === 'scope.open' || command === 'scope.interop.prepare') {
        // Each native manager owns its own resource inventory and PW endpoint.
        // A worker's source:reuse keeps that manager, never a sibling's client.
        owner.resources ??= new NativeInteropResources({
          endpoint: command === 'scope.open' ? String(request.args['endpoint']) : `ws://synthetic-interop.invalid/provider-${peerIndex}`,
          browserIdentity: `browser-${peerIndex}`,
          allocateContextIdentity: () => {
            resourceIdentity = ++nextScope;
            return { contextId: repeatedContext ?? `context-${resourceIdentity}`, targetId: `page-${resourceIdentity}` };
          },
          allocateScopeIdentity: () => (owner.scope = `scope-${resourceIdentity}`),
        });
        // This fault precedes persistent attachment; no PW resource is allocated.
        if (command === 'scope.open' && failOpen) return { error: 'browser-failure', effects: 'not-dispatched', scopeState: 'usable' };
      }
      if (owner.resources === undefined) throw new Error('Provider command preceded native ownership');
      if (command === 'scope.end' && failEnd) return { error: 'cleanup-failed', effects: 'unknown', scopeState: 'quarantined' };
      return owner.resources.respond(request, frame => {
        const command = frame.command;
        // No frozen native recorder proof: this is a terminal refusal, not a usable scope reply.
        if (command === 'recording.finalized.collect') return { error: 'scope-unavailable', effects: 'not-dispatched', scopeState: 'quarantined' };
        if (command === 'scope.reconnect') {
          const identity = owner.resources!.currentIdentity()!;
          expect(frame.args).toMatchObject({ identityScope: owner.scope,
            expectedBrowserIdentity: identity.recoveryIdentity.browser,
            expectedContextIdentity: identity.contextId, expectedPageIdentity: identity.targetId });
          const next = `scope-${++nextScope}`;
          const data = owner.resources!.reconnectScope(owner.scope, next); owner.scope = next;
          return { data };
        }
        if (command === 'page.activate') return { data: { activated: true } };
        if (['scope.configure', 'network.routes.replace', 'recording.start'].includes(command)) return { data: null };
        if (command === 'blob.release') return { data: { released: true } };
        if (command === 'page.title') return { data: { title: 'reattached' } };
        if (command === 'recording.stop') return { data: { identityScope: owner.scope, segments: [{ identityScope: owner.scope, handle: 'provider-unit-video', size: videoBytes.length,
          sha256: createHash('sha256').update(videoBytes).digest('hex'), mediaType: 'video/webm', startedAt: '2026-09-28T10:00:00.000Z' }] } };
        if (command === 'blob.read') return { data: { base64: videoBytes.toString('base64'), nextOffset: videoBytes.length, eof: true } };
        throw new Error(`Unexpected provider peer command ${command}`);
      });
    }, { close: () => owner.resources?.closeNative() });
    peers.push(owner);
    return owner.peer.connect(operation, onEvent);
  });
}

/** A scripted provider: leases `lease-<n>` against `wss://<n>.example`, remembering every call. */
function provider(options: { scope?: 'worker' | 'attempt'; failSlot?: number; failRelease?: boolean; reconnect?: boolean; sweep?: 'open' | 'fail' } = {}) {
  const acquired: BrowserRequest[] = [];
  const released: BrowserLease[] = [];
  const open = new Map<string, BrowserLease>();
  const swept: BrowserReleaseContext[] = [];
  let sequence = 0;
  const impl: BrowserProvider = {
    name: 'toy-cloud',
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    async acquire(request) {
      acquired.push(request);
      if (request.slot === options.failSlot) throw new Error(`no capacity for slot ${request.slot}`);
      request.log('starting');
      const n = sequence++;
      const lease = {
        id: `lease-${n}`,
        cdpEndpoint: `wss://${n}.example`,
        ...(options.reconnect === true ? { reconnectEndpoint: `wss://${n}.example/reconnect` } : {}),
        // A provider's own bookkeeping never reaches a worker.
        secret: 'x'.repeat(100),
      } as BrowserLease;
      open.set(lease.id, lease);
      return lease;
    },
    async release(lease) {
      released.push(lease);
      if (options.failRelease === true) throw new Error('stop failed');
      open.delete(lease.id);
    },
    ...(options.sweep === undefined
      ? {}
      : {
          async sweep(context: BrowserReleaseContext) {
            swept.push(context);
            if (options.sweep === 'fail') throw new Error('list failed');
            const ids = [...open.keys()];
            open.clear();
            return ids;
          },
        }),
  };
  return { impl, acquired, released, swept };
}

const prepareInfo = (slots: number, log: (line: string) => void = () => undefined, env: Record<string, string> = { BROWSER_TOKEN: 't' }): EnginePrepareInfo => ({
  runId: 'run-1',
  targetName: 'web',
  projectRoot: '/project',
  app: {},
  slots,
  env,
  signal: new AbortController().signal,
  headed: false,
  log,
});
const finishInfo = (log: (line: string) => void = () => undefined): EngineFinishInfo => ({
  runId: 'run-1',
  targetName: 'web',
  env: { BROWSER_TOKEN: 't' },
  signal: new AbortController().signal,
  timeoutMs: 5_000,
  log,
});
const initInfo = (workerSlot: number, env: Readonly<Record<string, string | undefined>> = {}, log: (line: string) => void = () => undefined): EngineInitInfo => ({
  runId: 'run-1',
  targetName: 'web',
  projectRoot: '/project',
  app: {},
  env,
  headed: false,
  workerSlot,
  signal: new AbortController().signal,
  log,
});
const attempt = (attemptId: string): EngineAttemptContext => ({ attemptId, artifactsDir: '/tmp/e2e-provider-artifacts', signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
const cleanup = (): EngineCleanupContext => ({ timeoutMs: 1_000, signal: new AbortController().signal });
const operation = (): OperationContext => ({ timeoutMs: 1_000, signal: new AbortController().signal, runId: 'run-1', attemptId: 'a1', origin: 'test' });

/** The variable `prepare` wrote for the `web` target, found by its readable prefix (the suffix is a digest of the name). */
function leasesVariableIn(env: Readonly<Record<string, string | undefined>>): string {
  const key = Object.keys(env).find((candidate) => /^E2E_WEB_BROWSERS_WEB_[0-9A-F]{8}$/.test(candidate));
  if (key === undefined) throw new Error(`no leases variable in ${Object.keys(env).join(', ')}`);
  return key;
}

/** Runs `prepare` and returns the environment it left for the workers. */
async function prepared(cloud: BrowserProvider, slots: number): Promise<{ runner: NativeSurface; env: Record<string, string> }> {
  const runner = new NativeSurface({ browser: cloud });
  const result = await runner.prepare(prepareInfo(slots));
  return { runner, env: (result?.env ?? {}) as Record<string, string> };
}

beforeEach(() => {
  peers.length = 0; nextScope = 0; repeatedContext = undefined; failOpen = false; failEnd = false;
  installNativePeers();
  // The only PW substitute is this fixture's resource-level CDP connection.
  vi.spyOn(chromium, 'connectOverCDP').mockImplementation(async endpoint => {
    const resources = peers.findLast(owner => owner.resources?.endpoint === endpoint)?.resources;
    if (resources === undefined) throw new Error('No provider resource owns this CDP endpoint');
    return resources.connectPlaywright(endpoint);
  });
});
afterEach(() => { for (const { peer } of peers) peer.dispose(); vi.restoreAllMocks(); });

describe('web({ browser: provider })', () => {
  it('rejects a provider without a name, the two methods, or a known scope', () => {
    expect(() => web({ browser: { name: '' } as unknown as BrowserProvider })).toThrow(/non-empty `name`/);
    expect(() => web({ browser: { name: 'x', acquire: async () => ({}) } as unknown as BrowserProvider })).toThrow(
      /provider "x" must implement release\(\)/,
    );
    expect(() => web({ browser: { ...provider().impl, scope: 'run' } as unknown as BrowserProvider })).toThrow(
      /has scope "run"; use "worker" or "attempt"/,
    );
    expect(() => web({ browser: provider({ scope: 'attempt' }).impl })).not.toThrow();
  });

  it('rejects downloads that are not a directory and a read() or whose dir is relative, and takes an absolute POSIX or Windows dir', () => {
    const read = async () => new Uint8Array();
    for (const downloads of [null, { dir: '', read }, { dir: '/downloads' }]) {
      expect(() => web({ browser: { ...provider().impl, downloads } as unknown as BrowserProvider })).toThrow(
        /provider "toy-cloud" has downloads that are not \{ dir, read\(\) \}/,
      );
    }
    expect(() => web({ browser: { ...provider().impl, downloads: { dir: '/downloads', read } } })).not.toThrow();
    expect(() => web({ browser: { ...provider().impl, downloads: { dir: 'downloads', read } } })).toThrow(
      /provider "toy-cloud" has downloads.dir "downloads"; name an absolute path on the browser's machine/,
    );
    expect(() => web({ browser: { ...provider().impl, downloads: { dir: 'C:\\Users\\kernel\\Downloads', read } } })).not.toThrow();
  });

  it('rejects a provider together with connect: two browser sources', () => {
    expect(() => web({ browser: provider().impl, connect: { cdpEndpoint: () => 'ws://x' } })).toThrow(/two browser sources/);
  });

  it('rejects creation-time headers, credentials, user agent, locale, and time zone with an attempt-scoped provider, as persistent connect does', () => {
    const cloud = provider({ scope: 'attempt' }).impl;
    expect(() => web({ browser: cloud, headers: { 'x-preview': 'synthetic' } })).toThrow(/persistent context/);
    expect(() => web({ browser: cloud, basicAuth: { username: 'user', password: 'synthetic' } })).toThrow(/persistent context/);
    expect(() => web({ browser: cloud, userAgent: 'synthetic playwright' })).toThrow(/persistent context/);
    expect(() => web({ browser: cloud, locale: 'de-DE' })).toThrow(/persistent context; locale requires/);
    expect(() => web({ browser: cloud, timezoneId: 'Europe/Berlin' })).toThrow(/persistent context; timezoneId requires/);
    expect(() => web({ browser: provider().impl, headers: { 'x-preview': 'synthetic' } })).not.toThrow();
  });

  it('declares context replacement for worker scope and not for attempt scope, and a finish hook for both', async () => {
    const perWorker = web({ browser: provider().impl });
    expect(perWorker.state).toBeDefined();
    expect(perWorker.session?.reset).toBeTypeOf('function');
    expect(perWorker.finish).toBeTypeOf('function');
    const perAttempt = web({ browser: provider({ scope: 'attempt' }).impl });
    expect(perAttempt.state).toBeUndefined();
    await expect(perAttempt.session!.reset!(operation())).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message:
        'app.clearState() is unavailable with browser provider "toy-cloud" with scope "attempt": it replaces the browser context, and the attempt rides one persistent context; every attempt already starts on a fresh browser, and scope "worker" can clear one mid-test',
    });
    expect(perAttempt.session?.restart).toBeTypeOf('function');
  });
});

describe('worker scope', () => {
  it('leases one browser per slot at prepare, hands the declared fields to the workers, and each worker attaches to its own', async () => {
    const cloud = provider();
    const runner = new NativeSurface({ browser: cloud.impl });
    const lines: string[] = [];
    const result = await runner.prepare(prepareInfo(2, (line) => lines.push(line)));
    expect(result?.workers).toBe(2);
    expect(cloud.acquired.map((request) => [request.slot, request.slots, request.attemptId, request.runId, request.targetName])).toEqual([
      [0, 2, undefined, 'run-1', 'web'],
      [1, 2, undefined, 'run-1', 'web'],
    ]);
    expect(cloud.acquired[0]!.env).toEqual({ BROWSER_TOKEN: 't' });
    expect(lines).toEqual([
      'leasing 2 browser(s) from toy-cloud',
      'toy-cloud (1 of 2): starting',
      'toy-cloud (2 of 2): starting',
      'toy-cloud: leased lease-0',
      'toy-cloud: leased lease-1',
    ]);
    const env = result?.env ?? {};
    const variable = leasesVariableIn(env);
    expect(JSON.parse(env[variable]!)).toEqual({
      slots: 2,
      leases: [
        { id: 'lease-0', cdpEndpoint: 'wss://0.example' },
        { id: 'lease-1', cdpEndpoint: 'wss://1.example' },
      ],
    });
    // Nothing was attached in the runner: leasing is not connecting.
    expect(endpoints()).toEqual([]);
    expect(connectNativeProcess).not.toHaveBeenCalled();

    // A worker reads its slot's lease from the environment and attaches to that endpoint.
    const worker = new NativeSurface({ browser: cloud.impl });
    await worker.init(initInfo(1, { [variable]: env[variable] }));
    expect(connectNativeProcess).toHaveBeenCalledTimes(1);
    await worker.startAttempt(attempt('a1'));
    expect(endpoints()).toEqual(['wss://1.example']);
    const owner = peers[0]!;
    expect(owner.peer.requests.map(request => request.command)).toEqual([
      'scope.interop.prepare', 'scope.interop.adopt', 'scope.configure', 'network.routes.replace',
    ]);
    expect(owner.peer.requests[0]!.args).toMatchObject({ source: 'connect', context: 'isolated', endpoint: 'wss://1.example' });
    expect(chromium.connectOverCDP).toHaveBeenCalledWith(owner.resources!.endpoint, { timeout: expect.any(Number), noDefaults: true });
    expect(owner.resources!.snapshot()).toMatchObject({ nativeContexts: 1, playwrightContexts: 1, playwrightClients: 1 });
    await worker.endAttempt(cleanup());
    expect(owner.peer.requests.slice(-2).map(request => request.command)).toEqual(['scope.interop.retire', 'scope.end']);
    expect(owner.resources!.snapshot()).toMatchObject({ nativeContexts: 0, playwrightContexts: 0, playwrightClients: 1, contextCloseEvents: 1 });
    await worker.dispose(cleanup());
    expect(owner.resources!.snapshot()).toMatchObject({ playwrightClients: 0 });
    // The worker acquired nothing of its own, so it released nothing.
    expect(cloud.acquired).toHaveLength(2);
    expect(cloud.released).toEqual([]);

    // The runner releases what it leased, handing back the provider's own objects.
    const finished: string[] = [];
    await runner.finish(finishInfo((line) => finished.push(line)));
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0', 'lease-1']);
    expect(cloud.released[0]).toHaveProperty('secret');
    expect(finished).toEqual(['toy-cloud: released 2 browser(s)']);
    await runner.finish(finishInfo());
    expect(cloud.released).toHaveLength(2);
  });

  it('leases nothing for a target with no slots', async () => {
    const cloud = provider();
    const runner = new NativeSurface({ browser: cloud.impl });
    expect(await runner.prepare(prepareInfo(0))).toEqual({});
    expect(cloud.acquired).toEqual([]);
    await runner.finish(finishInfo());
    expect(cloud.released).toEqual([]);
  });

  it('holds the slots that leased when another fails, so finish releases them, and fails the run before any test', async () => {
    const cloud = provider({ failSlot: 1 });
    const runner = new NativeSurface({ browser: cloud.impl });
    await expect(runner.prepare(prepareInfo(2))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "toy-cloud" could not lease a browser: no capacity for slot 1'),
    });
    await runner.finish(finishInfo());
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0']);
  });

  it('treats an acquire that throws before its first await like any other failed slot', async () => {
    const sync: BrowserProvider = {
      name: 'sync',
      acquire(request) {
        if (request.slot === 1) throw new Error('token missing');
        return Promise.resolve({ id: `l-${request.slot}`, cdpEndpoint: 'wss://d.example' });
      },
      async release() {},
    };
    const runner = new NativeSurface({ browser: sync });
    await expect(runner.prepare(prepareInfo(2))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('token missing'),
    });
  });

  it('reports a release failure once every lease was tried', async () => {
    const cloud = provider({ failRelease: true });
    const runner = new NativeSurface({ browser: cloud.impl });
    await runner.prepare(prepareInfo(2));
    await expect(runner.finish(finishInfo())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "toy-cloud" could not release a browser: stop failed'),
    });
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0', 'lease-1']);
  });

  it('rejects leases too large for a worker environment, by bytes', async () => {
    const oversized: BrowserProvider = {
      name: 'huge',
      async acquire(request) {
        // Multi-byte characters: the cap is on bytes, not string length.
        return { id: `l-${request.slot}`, cdpEndpoint: `wss://d.example/${'ż'.repeat(9_000)}` };
      },
      async release() {},
    };
    const runner = new NativeSurface({ browser: oversized });
    await expect(runner.prepare(prepareInfo(1))).rejects.toMatchObject({
      message: expect.stringContaining('the worker environment carries at most 16384'),
    });
  });

  it('refuses a lease without an id and a cdpEndpoint, or with a reconnectEndpoint that is not one, and still releases nothing for it', async () => {
    for (const lease of [{}, { id: 'bare' }, { cdpEndpoint: 'wss://d.example' }, { id: ' ', cdpEndpoint: 'wss://d.example' }, { id: 'x', cdpEndpoint: 'wss://d.example', reconnectEndpoint: 7 }]) {
      const released: BrowserLease[] = [];
      const odd: BrowserProvider = { name: 'odd', acquire: async () => lease as unknown as BrowserLease, release: async (granted) => { released.push(granted); } };
      const runner = new NativeSurface({ browser: odd });
      await expect(runner.prepare(prepareInfo(1))).rejects.toMatchObject({
        message: expect.stringContaining('browser provider "odd" returned a lease without an id and a cdpEndpoint'),
      });
      await runner.finish(finishInfo());
      expect(released).toEqual([]);
    }
  });

  it('fails init when prepare left nothing it can read, or the slot is outside the leases', async () => {
    const cloud = provider();
    const { env } = await prepared(cloud.impl, 1);
    const variable = leasesVariableIn(env);
    await expect(new NativeSurface({ browser: cloud.impl }).init(initInfo(0))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "toy-cloud" prepared nothing for target "web"'),
    });
    for (const raw of ['not json', '[]', '{"slots":1,"leases":[{"id":"x"}]}', '{"slots":-1,"leases":[]}']) {
      await expect(new NativeSurface({ browser: cloud.impl }).init(initInfo(0, { [variable]: raw }))).rejects.toMatchObject({
        message: expect.stringContaining('prepared nothing for target "web"'),
      });
    }
    await expect(new NativeSurface({ browser: cloud.impl }).init(initInfo(1, { [variable]: env[variable] }))).rejects.toMatchObject({
      message: expect.stringContaining('worker slot 1 is outside the 1 browser(s) "toy-cloud" leased'),
    });
    expect(endpoints()).toEqual([]);
    expect(connectNativeProcess).not.toHaveBeenCalled();
  });

  it('leases a replacement in the worker once its browser dropped, releases only what the worker acquired, and the rest on dispose', async () => {
    const cloud = provider();
    const { runner, env } = await prepared(cloud.impl, 2);
    const variable = leasesVariableIn(env);
    const worker = new NativeSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, { [variable]: env[variable] }));
    await worker.startAttempt(attempt('a1'));
    await worker.endAttempt(cleanup());
    // A connected browser is kept across attempts: no new lease.
    expect(cloud.acquired).toHaveLength(2);

    await peers[0]!.dropBrowser();
    await worker.startAttempt(attempt('a2'));
    expect(endpoints()).toEqual(['wss://0.example', 'wss://2.example']);
    // The replacement is asked for the same slot, from the worker, with no attempt id.
    expect(cloud.acquired.at(-1)).toMatchObject({ slot: 0, slots: 2, runId: 'run-1', targetName: 'web' });
    expect(cloud.acquired.at(-1)?.attemptId).toBeUndefined();
    // The dead lease came from prepare: the runner's finish releases it, not the worker.
    expect(cloud.released).toEqual([]);
    await worker.endAttempt(cleanup());

    await peers[1]!.dropBrowser();
    await worker.startAttempt(attempt('a3'));
    // A dead replacement is the worker's own to release.
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-2']);
    await worker.endAttempt(cleanup());
    await worker.dispose(cleanup());
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-2', 'lease-3']);

    await runner.finish(finishInfo());
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-2', 'lease-3', 'lease-0', 'lease-1']);
  });

  it.each(['protocol failure', 'unproven scope disconnect', 'unproven worker disconnect'] as const)('never buys a replacement lease after %s', async (fault) => {
    const cloud = provider();
    const { runner, env } = await prepared(cloud.impl, 1);
    const worker = new NativeSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, env));
    await worker.startAttempt(attempt('a1'));
    const owner = peers[0]!;
    if (fault === 'protocol failure') owner.peer.protocolFailure();
    else if (fault === 'unproven scope disconnect') await owner.peer.event('scope.disconnected', { identityScope: owner.scope, reason: 'unproven-transport-error' });
    else await owner.peer.event('browser.disconnected', { reason: 'unproven-transport-error' });
    await expect(worker.endAttempt(cleanup())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    expect(cloud.acquired).toHaveLength(1);
    expect(cloud.released).toEqual([]);
    await expect(worker.startAttempt(attempt('a2'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(endpoints()).toEqual(['wss://0.example']);
    expect(cloud.acquired).toHaveLength(1);
    await expect(worker.dispose(cleanup())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(cloud.released).toEqual([]);
    await runner.finish(finishInfo());
    expect(cloud.released.map(lease => lease.id)).toEqual(['lease-0']);
  });

  it('reports the progress a replacement lease logs through the worker\'s line to the reporter', async () => {
    const cloud = provider();
    const { env } = await prepared(cloud.impl, 1);
    const lines: string[] = [];
    const worker = new NativeSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, env, (line) => lines.push(line)));
    await worker.startAttempt(attempt('a1'));
    await worker.endAttempt(cleanup());
    expect(lines).toEqual([]);
    await peers.at(-1)!.dropBrowser();
    await worker.startAttempt(attempt('a2'));
    expect(lines).toEqual(['toy-cloud: starting']);
    await worker.dispose(cleanup());
  });

  it('releases the replacement only after confirmed close even when scope end failed', async () => {
    const cloud = provider();
    const { env } = await prepared(cloud.impl, 1);
    const worker = new NativeSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, env));
    await worker.startAttempt(attempt('initial'));
    await worker.endAttempt(cleanup());
    await peers.at(-1)!.dropBrowser();
    await worker.startAttempt(attempt('a1'));
    expect(cloud.acquired).toHaveLength(2);
    failEnd = true;
    await expect(worker.dispose(cleanup())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    expect(peers.at(-1)!.peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-1']);
  });

  it('gives back a replacement that arrives after the worker was disposed, and never commits it', async () => {
    const cloud = provider();
    const { env } = await prepared(cloud.impl, 1);
    let grant!: () => void;
    const granted = new Promise<void>((resolve) => { grant = resolve; });
    const inner = cloud.impl.acquire.bind(cloud.impl);
    let requested = false;
    cloud.impl.acquire = async (request) => { requested = true; await granted; return inner(request); };
    const worker = new NativeSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, env));
    await worker.startAttempt(attempt('initial'));
    await worker.endAttempt(cleanup());
    await peers.at(-1)!.dropBrowser();
    // Disposing ends the pending attempt, so the start fails as soon as dispose runs.
    const starting = worker.startAttempt(attempt('a1')).catch((cause: unknown) => cause);
    try {
      await expect.poll(() => requested).toBe(true);
      // The cleanup budget bounds retirement even while the provider has not granted the lease.
      await worker.dispose({ timeoutMs: 50, signal: new AbortController().signal });
      expect(await withTimeout(starting, 1_000, () => new Error('Pending lease did not cancel with its worker'))).toMatchObject({ code: 'CANCELLED' });
      expect(cloud.released).toEqual([]);
    } finally { grant(); await starting; }
    await expect.poll(() => cloud.released.map((lease) => lease.id)).toEqual(['lease-1']);
    expect(endpoints()).toEqual(['wss://0.example']);
  });

  it('fails the attempt start, naming the provider, when no replacement can be leased', async () => {
    const cloud = provider();
    const { env } = await prepared(cloud.impl, 1);
    const worker = new NativeSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, env));
    await worker.startAttempt(attempt('initial'));
    await worker.endAttempt(cleanup());
    await peers.at(-1)!.dropBrowser();
    cloud.impl.acquire = async () => { throw new Error('quota exhausted'); };
    await expect(worker.startAttempt(attempt('a1'))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "toy-cloud" could not lease a browser: quota exhausted'),
    });
    await worker.endAttempt(cleanup());
    await worker.dispose(cleanup());
    expect(cloud.released).toEqual([]);
  });
});

describe('attempt scope', () => {
  it('leases nothing at prepare, hands the workers the slot count alone, and attaches nothing at init', async () => {
    const cloud = provider({ scope: 'attempt' });
    const runner = new NativeSurface({ browser: cloud.impl });
    const result = await runner.prepare(prepareInfo(2));
    expect(result?.workers).toBeUndefined();
    const env = result?.env ?? {};
    expect(JSON.parse(env[leasesVariableIn(env)]!)).toEqual({ slots: 2, leases: [] });
    expect(await runner.prepare(prepareInfo(0))).toEqual({});
    await runner.init(initInfo(0, env));
    expect(cloud.acquired).toEqual([]);
    expect(endpoints()).toEqual([]);
    expect(connectNativeProcess).not.toHaveBeenCalled();
    await runner.finish(finishInfo());
    expect(cloud.released).toEqual([]);
  });

  it('leases a browser per attempt with the attempt id, attaches to it, and releases it at endAttempt, once', async () => {
    const cloud = provider({ scope: 'attempt' });
    const { env } = await prepared(cloud.impl, 2);
    const worker = new NativeSurface({ browser: cloud.impl });
    const lines: string[] = [];
    await worker.init(initInfo(1, { ...env, BROWSER_TOKEN: 't' }, (line) => lines.push(line)));
    await worker.startAttempt(attempt('a1'));
    expect(cloud.acquired.map((request) => [request.slot, request.slots, request.attemptId, request.env])).toEqual([[1, 2, 'a1', { ...env, BROWSER_TOKEN: 't' }]]);
    // Its progress reaches the reporter through the worker, as a lease from prepare does through the runner.
    expect(lines).toEqual(['toy-cloud: starting']);
    expect(endpoints()).toEqual(['wss://0.example']);
    await worker.endAttempt(cleanup());
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0']);
    expect(cloud.released[0]).toHaveProperty('secret');
    await worker.endAttempt(cleanup());
    expect(cloud.released).toHaveLength(1);

    await worker.startAttempt(attempt('a2'));
    expect(cloud.acquired.at(-1)).toMatchObject({ attemptId: 'a2' });
    expect(endpoints()).toEqual(['wss://0.example', 'wss://1.example']);
    await worker.dispose(cleanup());
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0', 'lease-1']);
  });

  it('trusts every lease to be a fresh browser, even one whose default context id an earlier lease had', async () => {
    const cloud = provider({ scope: 'attempt' });
    repeatedContext = 'snapshot-context';
    const { env } = await prepared(cloud.impl, 1);
    const worker = new NativeSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, env));
    await worker.startAttempt(attempt('a1'));
    await worker.endAttempt(cleanup());
    await worker.startAttempt(attempt('a2'));
    await worker.endAttempt(cleanup());
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0', 'lease-1']);
    await worker.dispose(cleanup());
  });

  it('releases the lease at endAttempt after a start that failed to attach', async () => {
    const cloud = provider({ scope: 'attempt' });
    failOpen = true;
    const worker = new NativeSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, (await prepared(cloud.impl, 1)).env));
    await expect(worker.startAttempt(attempt('a1'))).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(chromium.connectOverCDP).not.toHaveBeenCalled();
    expect(peers[0]!.resources!.snapshot()).toMatchObject({ nativeContexts: 0, playwrightContexts: 0, playwrightClients: 0 });
    expect(cloud.acquired).toHaveLength(1);
    expect(cloud.released).toEqual([]);
    const ended = await worker.endAttempt(cleanup()).then(() => ({ ok: true }), (cause: unknown) => ({ ok: false, cause }));
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0']);
    expect(ended).toEqual({ ok: true });
  });

  it('fails the attempt start, naming the provider, when the lease is refused, and endAttempt has nothing to release', async () => {
    const cloud = provider({ scope: 'attempt', failSlot: 0 });
    const worker = new NativeSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, (await prepared(cloud.impl, 1)).env));
    await expect(worker.startAttempt(attempt('a1'))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "toy-cloud" could not lease a browser: no capacity for slot 0'),
    });
    expect(endpoints()).toEqual([]);
    expect(connectNativeProcess).not.toHaveBeenCalled();
    await worker.endAttempt(cleanup());
    expect(cloud.released).toEqual([]);
  });

  it('reports an acquire that gave up on the aborted attempt as CANCELLED, not a provider failure', async () => {
    const cloud = provider({ scope: 'attempt' });
    cloud.impl.acquire = async (request) => {
      await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('aborted by the service client');
    };
    const worker = new NativeSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, (await prepared(provider({ scope: 'attempt' }).impl, 1)).env));
    const controller = new AbortController();
    const starting = worker.startAttempt({ attemptId: 'a1', artifactsDir: '/tmp/e2e-provider-artifacts', signal: controller.signal, resolveSecret: noSecrets, ...ignoreTrace });
    controller.abort();
    await expect(starting).rejects.toMatchObject({ code: 'CANCELLED' });
    await worker.endAttempt(cleanup());
    expect(cloud.released).toEqual([]);
  });

  it('gives back a lease that arrives after the attempt was cancelled or ended, and never commits it', async () => {
    for (const how of ['aborted', 'ended'] as const) {
      const cloud = provider({ scope: 'attempt' });
      let grant!: () => void;
      const granted = new Promise<void>((resolve) => { grant = resolve; });
      const inner = cloud.impl.acquire.bind(cloud.impl);
      cloud.impl.acquire = async (request) => { await granted; return inner(request); };
      const worker = new NativeSurface({ browser: cloud.impl });
      await worker.init(initInfo(0, (await prepared(provider({ scope: 'attempt' }).impl, 1)).env));
      const controller = new AbortController();
      const starting = worker.startAttempt({ attemptId: 'a1', artifactsDir: '/tmp/e2e-provider-artifacts', signal: controller.signal, resolveSecret: noSecrets, ...ignoreTrace });
      if (how === 'aborted') controller.abort();
      else await worker.endAttempt(cleanup());
      grant();
      await expect(starting).rejects.toMatchObject({ code: 'CANCELLED', message: expect.stringContaining('arrived after the attempt ended; released') });
      expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0']);
      expect(endpoints()).toEqual([]);
      expect(connectNativeProcess).not.toHaveBeenCalled();
      // The next attempt starts clean and leases its own browser.
      await worker.startAttempt(attempt('a2'));
      expect(cloud.acquired.at(-1)).toMatchObject({ attemptId: 'a2' });
      await worker.dispose(cleanup());
      expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0', 'lease-1']);
      for (const { peer } of peers) peer.requests.length = 0;
      vi.mocked(connectNativeProcess).mockClear();
    }
  });

  it('retains a failed release as the same cleanup error without releasing or acquiring again', async () => {
    const cloud = provider({ scope: 'attempt', failRelease: true });
    const worker = new NativeSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, (await prepared(cloud.impl, 1)).env));
    await worker.startAttempt(attempt('a1'));
    const first = await worker.endAttempt(cleanup()).catch((cause: unknown) => cause);
    expect(first).toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "toy-cloud" could not release browser lease-0: stop failed'),
    });
    await expect(worker.endAttempt(cleanup())).rejects.toBe(first);
    await expect(worker.dispose(cleanup())).rejects.toBe(first);
    await expect(worker.startAttempt(attempt('a2'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(cloud.released).toHaveLength(1);
    expect(cloud.acquired).toHaveLength(1);
  });

  it('reattaches through the lease\'s reconnectEndpoint after the transport drops, and through cdpEndpoint without one', async () => {
    for (const reconnect of [true, false]) {
      for (const { peer } of peers) peer.dispose();
      peers.length = 0;
      const cloud = provider({ scope: 'attempt', reconnect });
      const worker = new NativeSurface({ browser: cloud.impl });
      await worker.init(initInfo(0, (await prepared(cloud.impl, 1)).env));
      await worker.startAttempt(attempt('a1'));
      await peers[0]!.dropScope();
      await expect(worker.command('page.title', {}, operation())).resolves.toEqual({ title: 'reattached' });
      expect(endpoints()).toEqual([
        'wss://0.example',
        reconnect ? 'wss://0.example/reconnect' : 'wss://0.example',
      ]);
      // Recovery is the same browser: no second lease.
      expect(cloud.acquired).toHaveLength(1);
      await worker.dispose(cleanup());
      expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0']);
    }
  });
});

describe('leases a worker left open', () => {
  it('rejects a sweep that is not a function', () => {
    expect(() => web({ browser: { ...provider().impl, sweep: 'all' } as unknown as BrowserProvider })).toThrow(
      /provider "toy-cloud" has a sweep that is not a function/,
    );
  });

  it('has the provider sweep up an attempt\'s browser once the worker died holding it', async () => {
    const cloud = provider({ scope: 'attempt', sweep: 'open' });
    const { runner, env } = await prepared(cloud.impl, 1);
    const worker = new NativeSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, env));
    await worker.startAttempt(attempt('a1'));
    // The worker is killed here: neither endAttempt nor dispose runs.
    const lines: string[] = [];
    await runner.finish(finishInfo((line) => lines.push(line)));
    expect(cloud.swept).toHaveLength(1);
    expect(cloud.swept[0]).toMatchObject({ runId: 'run-1', targetName: 'web', env: { BROWSER_TOKEN: 't' } });
    expect(lines).toEqual(['toy-cloud: released 1 browser(s) a worker left open: lease-0']);
  });

  it('sweeps after releasing what prepare leased, so only a dead worker\'s replacement is left to find', async () => {
    const cloud = provider({ sweep: 'open' });
    const { runner, env } = await prepared(cloud.impl, 1);
    const worker = new NativeSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, env));
    await worker.startAttempt(attempt('a1'));
    await worker.endAttempt(cleanup());
    await peers.at(-1)!.dropBrowser();
    await worker.startAttempt(attempt('a2'));
    const lines: string[] = [];
    await runner.finish(finishInfo((line) => lines.push(line)));
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0']);
    expect(lines).toEqual(['toy-cloud: released 1 browser(s)', 'toy-cloud: released 1 browser(s) a worker left open: lease-1']);
  });

  it('logs nothing when every worker gave its leases back, and sweeps nothing for a target with no slots', async () => {
    const cloud = provider({ scope: 'attempt', sweep: 'open' });
    const { runner, env } = await prepared(cloud.impl, 1);
    const worker = new NativeSurface({ browser: cloud.impl });
    await worker.init(initInfo(0, env));
    await worker.startAttempt(attempt('a1'));
    await worker.endAttempt(cleanup());
    await worker.dispose(cleanup());
    const lines: string[] = [];
    await runner.finish(finishInfo((line) => lines.push(line)));
    expect(cloud.swept).toHaveLength(1);
    expect(lines).toEqual([]);

    const idle = new NativeSurface({ browser: cloud.impl });
    await idle.prepare(prepareInfo(0));
    await idle.finish(finishInfo());
    expect(cloud.swept).toHaveLength(1);
  });

  it('sweeps even when a release failed and reports the release failure, and only logs a sweep that failed', async () => {
    const failing = provider({ failRelease: true, sweep: 'open' });
    const { runner } = await prepared(failing.impl, 1);
    await expect(runner.finish(finishInfo())).rejects.toMatchObject({ message: expect.stringContaining('could not release a browser: stop failed') });
    expect(failing.swept).toHaveLength(1);

    const broken = provider({ scope: 'attempt', sweep: 'fail' });
    const { runner: sweeper } = await prepared(broken.impl, 1);
    const lines: string[] = [];
    await expect(sweeper.finish(finishInfo((line) => lines.push(line)))).resolves.toBeUndefined();
    expect(lines).toEqual(['toy-cloud: could not release the browsers a worker left open: list failed']);
  });

  it('sweeps nothing when prepare failed and no worker started', async () => {
    const cloud = provider({ failSlot: 0, sweep: 'open' });
    const runner = new NativeSurface({ browser: cloud.impl });
    await expect(runner.prepare(prepareInfo(1))).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    await runner.finish(finishInfo());
    expect(cloud.swept).toEqual([]);
  });
});

describe('recording', () => {
  /** A provider that records: `stop` writes `replay.mp4`, or whatever name it is told to report. */
  function recordingProvider(options: { failStart?: boolean; report?: string; scope?: 'worker' | 'attempt' } = {}) {
    const cloud = provider(options.scope === undefined ? {} : { scope: options.scope });
    const recorded: { lease: BrowserLease; context: ProviderRecordContext }[] = [];
    const stopped: string[] = [];
    const impl: BrowserProvider = {
      ...cloud.impl,
      async record(lease, context): Promise<ProviderRecording> {
        recorded.push({ lease, context });
        if (options.failStart === true) throw new Error('recordings unavailable');
        return {
          startedAt: '2026-09-28T10:00:00.000Z',
          async stop({ dir }) {
            stopped.push(lease.id);
            writeFileSync(path.join(dir, 'replay.mp4'), 'mp4');
            return options.report === undefined ? { file: 'replay.mp4' } : { file: options.report };
          },
        };
      },
    };
    return { impl, recorded, stopped, released: cloud.released };
  }

  const artifactDirs: string[] = [];
  afterEach(() => {
    for (const dir of artifactDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A worker holding slot 0's lease, attempt `a1` started in a fresh artifact directory, removed after the test. */
  async function recordingWorker(impl: BrowserProvider) {
    const { env } = await prepared(impl, 1);
    const worker = new NativeSurface({ browser: impl });
    await worker.init(initInfo(0, env));
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-provider-recording-'));
    artifactDirs.push(artifactsDir);
    await worker.startAttempt({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    return { worker, artifactsDir };
  }

  it('rejects a record that is not a function', () => {
    expect(() => web({ browser: { ...provider().impl, record: 'yes' } as unknown as BrowserProvider })).toThrow(/record that is not a function/);
  });

  it('records the attempt through the provider instead of the screencast, as one segment in the attempt directory', async () => {
    const cloud = recordingProvider();
    const { worker, artifactsDir } = await recordingWorker(cloud.impl);
    await worker.startVideo(operation());
    expect(cloud.recorded.map(({ lease, context }) => [lease.id, context.attemptId, context.runId, context.targetName])).toEqual([['lease-0', 'a1', 'run-1', 'web']]);
    const segments = await worker.stopVideo(operation());
    expect(segments).toEqual([{ path: 'video/replay.mp4', startedAt: '2026-09-28T10:00:00.000Z' }]);
    expect(readFileSync(path.join(artifactsDir, 'video', 'replay.mp4'), 'utf8')).toBe('mp4');
    expect(existsSync(path.join(artifactsDir, 'video', 'video.webm'))).toBe(false);
    expect(peers.flatMap(({ peer }) => peer.requests).filter(request => request.command === 'recording.start')).toEqual([]);
    await worker.endAttempt(cleanup());
    expect(cloud.stopped).toEqual(['lease-0']);
    await worker.dispose(cleanup());
  });

  it('turns a recording the provider keeps into a link segment, with nothing written locally', async () => {
    const cloud = provider();
    const linking: BrowserProvider = {
      ...cloud.impl,
      async record(): Promise<ProviderRecording> {
        return { startedAt: '2026-09-28T10:00:00.000Z', stop: async () => ({ url: 'https://recordings.example/r1.mp4', mediaType: 'video/mp4' }) };
      },
    };
    const { worker, artifactsDir } = await recordingWorker(linking);
    await worker.startVideo(operation());
    expect(await worker.stopVideo(operation())).toEqual([
      { url: 'https://recordings.example/r1.mp4', mediaType: 'video/mp4', startedAt: '2026-09-28T10:00:00.000Z' },
    ]);
    expect(existsSync(path.join(artifactsDir, 'video', 'video.webm'))).toBe(false);
    expect(peers.flatMap(({ peer }) => peer.requests).filter(request => request.command === 'recording.start')).toEqual([]);
    await worker.dispose(cleanup());
  });

  it('transfers native recorder bytes when the provider does not record', async () => {
    const { worker, artifactsDir } = await recordingWorker(provider().impl);
    await worker.startVideo(operation());
    const segments = await worker.stopVideo(operation());
    expect(segments.map((segment) => ('path' in segment ? segment.path : segment.url))).toEqual(['video/video.webm']);
    expect(existsSync(path.join(artifactsDir, 'video', 'video.webm'))).toBe(true);
    expect(readFileSync(path.join(artifactsDir, 'video', 'video.webm'))).toEqual(videoBytes);
    expect(peers.flatMap(({ peer }) => peer.requests).filter(request => request.command === 'blob.release')).toHaveLength(1);
    await worker.dispose(cleanup());
  });

  it('stops a recording the attempt never collected when the attempt ends', async () => {
    const cloud = recordingProvider();
    const { worker } = await recordingWorker(cloud.impl);
    await worker.startVideo(operation());
    await worker.endAttempt(cleanup());
    expect(cloud.stopped).toEqual(['lease-0']);
    await worker.dispose(cleanup());
  });

  it('stops a recording that started after the attempt ended, and keeps nothing of it', async () => {
    const cloud = recordingProvider();
    let resume!: () => void;
    const record = cloud.impl.record!.bind(cloud.impl);
    const late: BrowserProvider = {
      ...cloud.impl,
      async record(lease, context) {
        await new Promise<void>((resolve) => { resume = resolve; });
        return record(lease, context);
      },
    };
    const { worker } = await recordingWorker(late);
    const starting = worker.startVideo(operation());
    await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
    const ended = worker.endAttempt(cleanup());
    resume();
    await expect(starting).rejects.toMatchObject({ code: 'CANCELLED' });
    await ended;
    expect(cloud.stopped).toEqual(['lease-0']);
    await worker.dispose(cleanup());
  });

  it('reports a recording that failed to start once the attempt was cancelled as CANCELLED, not a provider failure', async () => {
    const cancelling: BrowserProvider = {
      ...provider().impl,
      async record() {
        throw new Error('aborted by the signal');
      },
    };
    const { env } = await prepared(cancelling, 1);
    const leases = new LeasedBrowsers(cancelling);
    leases.init(initInfo(0, env));
    const controller = new AbortController();
    controller.abort();
    await expect(leases.recorder('a1')!(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(leases.recorder('a1')!(new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('refuses, at the start and named, a recording without a start time and a stop', async () => {
    const malformed = await recordingWorker({ ...provider().impl, record: async () => undefined as unknown as ProviderRecording });
    await expect(malformed.worker.startVideo(operation())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "toy-cloud" returned a recording of browser lease-0 without a start time and a stop()'),
    });
    await malformed.worker.dispose(cleanup());
  });

  it('shares a stop that timed out and is still in flight, so ending the attempt never stops a recording twice', async () => {
    let stops = 0;
    let finish!: () => void;
    const slow: BrowserProvider = {
      ...provider().impl,
      async record(): Promise<ProviderRecording> {
        return {
          startedAt: '2026-09-28T10:00:00.000Z',
          async stop({ dir }) {
            stops += 1;
            await new Promise<void>((resolve) => { finish = resolve; });
            writeFileSync(path.join(dir, 'replay.mp4'), 'mp4');
            return { file: 'replay.mp4' };
          },
        };
      },
    };
    const { worker } = await recordingWorker(slow);
    await worker.startVideo(operation());
    // The runner's cleanup budget runs out while the provider is still stopping; the close then waits for that same stop.
    const budget = new AbortController();
    const collecting = worker.stopVideo({ ...operation(), signal: budget.signal });
    await vi.waitFor(() => expect(stops).toBe(1));
    budget.abort();
    const ending = worker.endAttempt({ ...cleanup(), timeoutMs: 5_000 });
    try {
      await expect(withTimeout(collecting, 1_000, () => new Error('Provider stop ignored caller cancellation'))).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally {
      finish();
      await collecting.catch(() => undefined);
      await ending;
    }
    expect(stops).toBe(1);
    await worker.dispose(cleanup());
  });

  it('keeps a recording whose stop failed, so ending the attempt stops it once more', async () => {
    const cloud = recordingProvider();
    let failures = 1;
    const record = cloud.impl.record!.bind(cloud.impl);
    const flaky: BrowserProvider = {
      ...cloud.impl,
      async record(lease, context) {
        const recording = await record(lease, context);
        return {
          startedAt: recording.startedAt,
          async stop(stopContext) {
            if (failures-- > 0) throw new Error('download interrupted');
            return recording.stop(stopContext);
          },
        };
      },
    };
    const { worker } = await recordingWorker(flaky);
    await worker.startVideo(operation());
    await expect(worker.stopVideo(operation())).rejects.toThrow('download interrupted');
    await worker.endAttempt(cleanup());
    expect(cloud.stopped).toEqual(['lease-0']);
    await worker.dispose(cleanup());
  });

  it('names the provider when a recording cannot start, and refuses a stop that names no file it wrote', async () => {
    const failing = await recordingWorker(recordingProvider({ failStart: true }).impl);
    await expect(failing.worker.startVideo(operation())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "toy-cloud" could not start recording browser lease-0: recordings unavailable'),
    });
    await failing.worker.dispose(cleanup());
    for (const report of ['../escape.mp4', 'missing.mp4']) {
      const options = { report, scope: 'attempt' as const };
      const cloud = recordingProvider(options);
      const { worker } = await recordingWorker(cloud.impl);
      const peer = peers.at(-1)!.peer;
      await worker.startVideo(operation());
      const invalidArtifact = {
        code: 'ENGINE_FAILURE',
        message: expect.stringContaining('browser provider "toy-cloud" recording lease lease-0 finished without naming a file it wrote'),
      };
      await expect(worker.stopVideo(operation())).rejects.toMatchObject(invalidArtifact);
      // Legacy ProviderVideo.abandon swallowed this secondary error. Native cleanup
      // retains artifact ownership without stopped proof, but still releases the billed lease.
      const failure = await worker.dispose(cleanup()).catch((cause: unknown) => cause);
      expect(failure).toMatchObject(invalidArtifact);
      expect(cloud.released.map(lease => lease.id)).toEqual(['lease-0']);
      await expect(worker.startAttempt(attempt('unproven-cleanup'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
      // The same provider stop is repeatable and can return a validated artifact on retry.
      options.report = 'replay.mp4';
      await expect(worker.endAttempt(cleanup())).rejects.toBe(failure);
      expect(cloud.stopped).toEqual(['lease-0', 'lease-0', 'lease-0']);
      expect(cloud.released.map(lease => lease.id)).toEqual(['lease-0']);
      await expect(worker.endAttempt(cleanup())).rejects.toBe(failure);
      await expect(worker.dispose(cleanup())).rejects.toBe(failure);
      await expect(worker.startAttempt(attempt('still-not-reusable'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(cloud.released).toHaveLength(1);
      expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    }
  });
});

it('publishes pending lease custody before a provider synchronously re-enters cleanup', async () => {
  let leases!: LeasedBrowsers;
  let retirement!: Promise<void>;
  let finishRelease!: () => void;
  const releaseReceipt = new Promise<void>(resolve => { finishRelease = resolve; });
  const cleanupSignal = AbortSignal.abort();
  const release = vi.fn(async (_lease: BrowserLease, context: BrowserReleaseContext) => {
    expect(context.signal).toBe(cleanupSignal);
    await releaseReceipt;
  });
  const impl: BrowserProvider = {
    name: 'reentrant-acquire', scope: 'attempt',
    acquire: async () => {
      retirement = leases.endAttempt({ signal: cleanupSignal, timeoutMs: 0 });
      return { id: 'late-owned', cdpEndpoint: 'ws://synthetic.test/browser' };
    }, release,
  };
  const { env } = await prepared(impl, 1);
  leases = new LeasedBrowsers(impl); leases.init(initInfo(0, env));
  const starting = leases.startAttempt(attempt('reentrant')).catch((cause: unknown) => cause);
  try {
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(leases.endAttempt(cleanup())).toBe(retirement);
    expect(() => leases.init(initInfo(0, env))).toThrow(/cleanup remains unresolved/);
    finishRelease();
    await retirement;
    expect(await starting).toMatchObject({ code: 'CANCELLED' });
    expect(() => leases.init(initInfo(0, env))).not.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
  } finally { finishRelease(); await starting; }
});

it.each(['attempt', 'init'] as const)('captures worker cleanup authority before synchronous %s acquire abort notification', async lifetime => {
  let markedSignal: AbortSignal | undefined; let signalAtAbort: AbortSignal | undefined; let releaseSignal: AbortSignal | undefined;
  let finishRelease!: () => void; const receipt = new Promise<void>(resolve => { finishRelease = resolve; });
  let acquisitions = 0; let releases = 0;
  const cloud: BrowserProvider = {
    name: 'sync-worker-acquire', scope: 'worker',
    acquire(request) {
      if (acquisitions++ === 0) return Promise.resolve({ id: 'prepared', cdpEndpoint: 'wss://prepared.example' });
      return new Promise(resolve => request.signal.addEventListener('abort', () => {
        signalAtAbort = markedSignal;
        resolve({ id: 'late', cdpEndpoint: 'wss://late.example' });
      }, { once: true }));
    },
    async release(_lease, context) { releases++; releaseSignal = context.signal; await receipt; },
  };
  const retire = LeasedBrowsers.prototype.retireWorkerAcquisition;
  vi.spyOn(LeasedBrowsers.prototype, 'retireWorkerAcquisition').mockImplementation(function (this: LeasedBrowsers, context, owner, observer) {
    markedSignal = context.signal; retire.call(this, context, owner, observer);
  });
  if (lifetime === 'init') {
    const endpoint = LeasedBrowsers.prototype.endpoint;
    vi.spyOn(LeasedBrowsers.prototype, 'endpoint').mockImplementation(async function (this: LeasedBrowsers, signal, owner) {
      // Exercise init-owned replacement while preserving real provider acquire/release.
      await endpoint.call(this, signal, owner); return endpoint.call(this, signal, owner);
    });
  }
  const { runner, env } = await prepared(cloud, 1); const worker = new NativeSurface({ browser: cloud });
  let starting: Promise<unknown>;
  try {
    if (lifetime === 'attempt') {
      await worker.init(initInfo(0, env)); await worker.startAttempt(attempt('a1')); await worker.endAttempt(cleanup());
      await peers[0]!.dropBrowser(); markedSignal = undefined;
      starting = worker.startAttempt(attempt('a2')).catch((cause: unknown) => cause);
    } else starting = worker.init(initInfo(0, env)).catch((cause: unknown) => cause);
    await vi.waitFor(() => expect(acquisitions).toBe(2));
    const budget = { signal: AbortSignal.abort(), timeoutMs: 0 };
    await (lifetime === 'attempt' ? worker.endAttempt(budget) : worker.dispose(budget)).catch(() => undefined);
    await vi.waitFor(() => expect(releases).toBe(1));
    expect(signalAtAbort).toBeDefined(); expect(releaseSignal).toBe(signalAtAbort); expect(releaseSignal!.aborted).toBe(true);
    await expect(worker.init(initInfo(0, env))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    finishRelease(); await starting;
    await worker.dispose(cleanup()); expect(releases).toBe(1);
  } finally {
    finishRelease(); await worker.dispose(cleanup()).catch(() => undefined); await runner.finish(finishInfo());
  }
});

it.each(['current lease', 'recorder'] as const)('does not turn pending replacement into permission to hide held %s cleanup timeout', async held => {
  const cloud = provider(); let stop!: () => void; let releaseCurrent!: () => void;
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  const currentReleased = new Promise<void>(resolve => { releaseCurrent = resolve; });
  cloud.impl.record = async () => ({ startedAt: new Date().toISOString(), async stop() { await stopped; return { url: 'https://fixture.invalid/worker-video.mp4', mediaType: 'video/mp4' }; } });
  const originalRelease = cloud.impl.release.bind(cloud.impl);
  cloud.impl.release = async (lease, context) => { await originalRelease(lease, context); if (lease.id === 'lease-1' && held === 'current lease') await currentReleased; };
  const { runner, env } = await prepared(cloud.impl, 1); const worker = new NativeSurface({ browser: cloud.impl });
  let grant!: () => void; const granted = new Promise<void>(resolve => { grant = resolve; });
  let requested = false; let opening: Promise<unknown> | undefined;
  try {
    await worker.init(initInfo(0, env)); await worker.startAttempt(attempt('a1'));
    if (held === 'current lease') {
      await worker.endAttempt(cleanup()); await peers.at(-1)!.dropBrowser();
      await worker.startAttempt(attempt('a2')); await worker.endAttempt(cleanup()); await peers.at(-1)!.dropBrowser();
    } else await worker.startVideo(operation());
    const acquire = cloud.impl.acquire.bind(cloud.impl);
    cloud.impl.acquire = async request => { requested = true; await granted; return acquire(request); };
    opening = (held === 'current lease' ? worker.startAttempt(attempt('a3'))
      : (worker as unknown as { leases: LeasedBrowsers }).leases.endpoint(new AbortController().signal, 'attempt')).catch((cause: unknown) => cause);
    await expect.poll(() => requested).toBe(true);
    await expect(worker.dispose({ timeoutMs: 20, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await expect(worker.init(initInfo(0, env))).rejects.toMatchObject({ code: 'INVALID_STATE' });
  } finally {
    grant(); stop(); releaseCurrent(); await opening;
    await worker.dispose(cleanup()); await runner.finish(finishInfo());
  }
});

it('does not treat an acquired late worker lease with a pending release receipt as acquisition-only waiting', async () => {
  const cloud = provider(); const { runner, env } = await prepared(cloud.impl, 1); const worker = new NativeSurface({ browser: cloud.impl });
  let grant!: () => void; const granted = new Promise<void>(resolve => { grant = resolve; });
  let finishRelease!: () => void; const releaseReceipt = new Promise<void>(resolve => { finishRelease = resolve; });
  const acquire = cloud.impl.acquire.bind(cloud.impl); const release = cloud.impl.release.bind(cloud.impl);
  let requested = false; let opening: Promise<unknown> | undefined;
  cloud.impl.acquire = async request => { requested = true; await granted; return acquire(request); };
  cloud.impl.release = async (lease, context) => { await release(lease, context); if (lease.id === 'lease-1') await releaseReceipt; };
  try {
    await worker.init(initInfo(0, env)); await worker.startAttempt(attempt('a1')); await worker.endAttempt(cleanup()); await peers.at(-1)!.dropBrowser();
    opening = worker.startAttempt(attempt('a2')).catch((cause: unknown) => cause); await expect.poll(() => requested).toBe(true);
    const disposal = worker.dispose({ timeoutMs: 100, signal: new AbortController().signal });
    const rejected = expect(disposal).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    grant(); await rejected;
    expect(cloud.released.map(lease => lease.id)).toEqual(['lease-1']);
    await expect(worker.init(initInfo(0, env))).rejects.toMatchObject({ code: 'INVALID_STATE' });
  } finally { grant(); finishRelease(); await opening; await worker.dispose(cleanup()); await runner.finish(finishInfo()); }
});

it('reports a real late release timeout after an acquisition-only dispose caller has left normally', async () => {
  const cloud = provider(); const { runner, env } = await prepared(cloud.impl, 1); const worker = new NativeSurface({ browser: cloud.impl });
  const primary = new EngineError('OPERATION_TIMEOUT', 'actual late release failed', { retryable: false });
  let grant!: () => void; const granted = new Promise<void>(resolve => { grant = resolve; });
  const acquire = cloud.impl.acquire.bind(cloud.impl); const release = cloud.impl.release.bind(cloud.impl);
  let requested = false; let opening: Promise<unknown> | undefined;
  cloud.impl.acquire = async request => { requested = true; await granted; return acquire(request); };
  cloud.impl.release = async (lease, context) => { await release(lease, context); if (lease.id === 'lease-1') throw primary; };
  try {
    await worker.init(initInfo(0, env)); await worker.startAttempt(attempt('a1')); await worker.endAttempt(cleanup()); await peers.at(-1)!.dropBrowser();
    opening = worker.startAttempt(attempt('a2')).catch((cause: unknown) => cause); await expect.poll(() => requested).toBe(true);
    const caller = worker.dispose({ timeoutMs: 20, signal: new AbortController().signal });
    const owner = (worker as unknown as { disposing?: Promise<void> }).disposing;
    expect(owner).toBeDefined(); const receipt = owner!.catch((cause: unknown) => cause);
    await caller; await expect(worker.init(initInfo(0, env))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    grant(); await opening; expect(await receipt).toBe(primary);
    await expect(worker.dispose(cleanup())).rejects.toBe(primary);
    await expect(worker.init(initInfo(0, env))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(cloud.released.map(lease => lease.id)).toEqual(['lease-1']);
  } finally { grant(); await opening; await worker.dispose(cleanup()).catch(() => undefined); await runner.finish(finishInfo()); }
});

it('preserves an earlier worker rollback failure while a held recorder fails later', async () => {
  const cloud = provider(); let rejectStop!: (cause: unknown) => void;
  const stop = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  cloud.impl.record = async () => ({ startedAt: new Date().toISOString(), stop: () => stop });
  const { runner, env } = await prepared(cloud.impl, 1); const worker = new NativeSurface({ browser: cloud.impl });
  const primary = new Error('worker rollback failed first'); const secondary = new Error('recorder failed second');
  let grant!: () => void; const granted = new Promise<void>(resolve => { grant = resolve; });
  const acquire = cloud.impl.acquire.bind(cloud.impl); const release = cloud.impl.release.bind(cloud.impl);
  let requested = false; let opening: Promise<unknown> | undefined;
  cloud.impl.acquire = async request => { requested = true; await granted; return acquire(request); };
  cloud.impl.release = async (lease, context) => { await release(lease, context); if (lease.id === 'lease-1') throw primary; };
  try {
    await worker.init(initInfo(0, env)); await worker.startAttempt(attempt('a1')); await worker.startVideo(operation());
    opening = (worker as unknown as { leases: LeasedBrowsers }).leases.endpoint(new AbortController().signal, 'attempt').catch((cause: unknown) => cause);
    await expect.poll(() => requested).toBe(true);
    const disposing = worker.dispose(cleanup()).catch((cause: unknown) => cause);
    grant(); await expect.poll(() => cloud.released.some(lease => lease.id === 'lease-1')).toBe(true);
    await new Promise(resolve => setImmediate(resolve)); rejectStop(secondary);
    const failure = await disposing; expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', cause: primary });
    await expect(worker.dispose(cleanup())).rejects.toBe(failure);
  } finally { grant(); rejectStop(secondary); await opening; await worker.dispose(cleanup()).catch(() => undefined); await runner.finish(finishInfo()); }
});

it('observes held-current release failure before a later recorder error while acquisition still waits', async () => {
  const cloud = provider(); let rejectStop!: (cause: unknown) => void;
  const stop = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  cloud.impl.record = async () => ({ startedAt: new Date().toISOString(), stop: () => stop });
  const { runner, env } = await prepared(cloud.impl, 1); const worker = new NativeSurface({ browser: cloud.impl });
  const primary = new Error('held current release failed first'); const secondary = new Error('recorder failed second');
  let grant!: () => void; const granted = new Promise<void>(resolve => { grant = resolve; });
  const acquire = cloud.impl.acquire.bind(cloud.impl); const release = cloud.impl.release.bind(cloud.impl);
  let requested = false; let opening: Promise<unknown> | undefined;
  try {
    await worker.init(initInfo(0, env)); await worker.startAttempt(attempt('a1')); await worker.endAttempt(cleanup()); await peers.at(-1)!.dropBrowser();
    await worker.startAttempt(attempt('a2')); await worker.startVideo(operation());
    cloud.impl.acquire = async request => { requested = true; await granted; return acquire(request); };
    cloud.impl.release = async (lease, context) => { await release(lease, context); if (lease.id === 'lease-1') throw primary; };
    opening = (worker as unknown as { leases: LeasedBrowsers }).leases.endpoint(new AbortController().signal, 'attempt').catch((cause: unknown) => cause);
    await expect.poll(() => requested).toBe(true);
    const caller = worker.dispose({ timeoutMs: 20, signal: new AbortController().signal }).catch((cause: unknown) => cause);
    const owner = (worker as unknown as { disposing?: Promise<void> }).disposing;
    expect(owner).toBeDefined(); const receipt = owner!.catch((cause: unknown) => cause);
    expect(await caller).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await expect.poll(() => cloud.released.some(lease => lease.id === 'lease-1')).toBe(true);
    await new Promise(resolve => setImmediate(resolve)); rejectStop(secondary); grant();
    const failure = await receipt; expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', cause: primary });
    await expect(worker.dispose(cleanup())).rejects.toBe(failure);
  } finally { grant(); rejectStop(secondary); await opening; await worker.dispose(cleanup()).catch(() => undefined); await runner.finish(finishInfo()); }
});

it.each(['same-turn', 'one-reaction', 'same-turn-repeat'] as const)('retirement: current release first without pending acquire (%s)', async order => {
  const cloud = provider(); let rejectStop!: (cause: unknown) => void; let rejectRelease!: (cause: unknown) => void;
  const stop = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  const currentRelease = new Promise<void>((_resolve, reject) => { rejectRelease = reject; });
  cloud.impl.record = async () => ({ startedAt: new Date().toISOString(), stop: () => stop });
  const { runner, env } = await prepared(cloud.impl, 1); const worker = new NativeSurface({ browser: cloud.impl });
  const primary = new Error('held release first, no acquire'); const secondary = new Error('recorder second, no acquire');
  const release = cloud.impl.release.bind(cloud.impl); let requested = false;
  try {
    await worker.init(initInfo(0, env)); await worker.startAttempt(attempt('a1')); await worker.endAttempt(cleanup()); await peers.at(-1)!.dropBrowser();
    await worker.startAttempt(attempt('a2')); await worker.startVideo(operation());
    cloud.impl.release = (lease, context) => { if (lease.id !== 'lease-1') return release(lease, context); requested = true; return currentRelease; };
    const caller = worker.dispose({ timeoutMs: 20, signal: new AbortController().signal }).catch((cause: unknown) => cause);
    const owner = (worker as unknown as { disposing?: Promise<void> }).disposing;
    expect(owner).toBeDefined(); const receipt = owner!.catch((cause: unknown) => cause);
    expect(await caller).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await expect.poll(() => requested).toBe(true);
    rejectRelease(primary); if (order === 'one-reaction') await Promise.resolve(); rejectStop(secondary);
    const failure = await receipt; expect((failure as Error).message).toContain(primary.message); expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', cause: primary });
    await expect(worker.dispose(cleanup())).rejects.toBe(failure);
  } finally { rejectRelease(primary); rejectStop(secondary); await worker.dispose(cleanup()).catch(() => undefined); await runner.finish(finishInfo()); }
});

it.each(['same-turn', 'one-reaction', 'same-turn-repeat'] as const)('retirement: attempt release first before recorder (%s)', async order => {
  const cloud = provider({ scope: 'attempt' }); let rejectStop!: (cause: unknown) => void; let rejectRelease!: (cause: unknown) => void;
  const stop = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  const currentRelease = new Promise<void>((_resolve, reject) => { rejectRelease = reject; });
  cloud.impl.record = async () => ({ startedAt: new Date().toISOString(), stop: () => stop });
  const { runner, env } = await prepared(cloud.impl, 1); const worker = new NativeSurface({ browser: cloud.impl });
  const primary = new Error('held release first, no acquire'); const secondary = new Error('recorder second, no acquire');
  const release = cloud.impl.release.bind(cloud.impl); let requested = false;
  try {
    await worker.init(initInfo(0, env)); await worker.startAttempt(attempt('a1')); await worker.startVideo(operation());
    cloud.impl.release = (lease, context) => { if (lease.id !== 'lease-0') return release(lease, context); requested = true; return currentRelease; };
    const caller = worker.dispose({ timeoutMs: 20, signal: new AbortController().signal }).catch((cause: unknown) => cause);
    const owner = (worker as unknown as { disposing?: Promise<void> }).disposing;
    expect(owner).toBeDefined(); const receipt = owner!.catch((cause: unknown) => cause);
    expect(await caller).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await expect.poll(() => requested).toBe(true);
    rejectRelease(primary); if (order === 'one-reaction') await Promise.resolve(); rejectStop(secondary);
    const failure = await receipt; expect((failure as Error).message).toContain(primary.message); expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', cause: primary });
    await expect(worker.dispose(cleanup())).rejects.toBe(failure);
  } finally { rejectRelease(primary); rejectStop(secondary); await worker.dispose(cleanup()).catch(() => undefined); await runner.finish(finishInfo()); }
});

/** Probes operate through NativeSurface; only the exact old PW close receipt is held. */
function deferredProbe<T>() {
  let resolve!: (value: T) => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((fulfilled, rejected) => { resolve = fulfilled; reject = rejected; });
  return { promise, resolve, reject };
}
const probeCleanup = (): EngineCleanupContext => ({ timeoutMs: 5_000, signal: new AbortController().signal });

async function replacementWithHeldClose() {
  const cloud = provider(); const { runner, env } = await prepared(cloud.impl, 1);
  const worker = new NativeSurface({ browser: cloud.impl });
  await worker.init(initInfo(0, env)); await worker.startAttempt(attempt('a1')); await worker.endAttempt(probeCleanup());
  const old = peers[0]!;
  const raw = await vi.mocked(chromium.connectOverCDP).mock.results[0]!.value;
  const close = raw.close.bind(raw); const held = deferredProbe<void>();
  const closing = vi.spyOn(raw, 'close').mockImplementation(async () => { await held.promise; await close(); });
  await old.dropBrowser();
  const starting = worker.startAttempt(attempt('a2')).then(() => undefined, (cause: unknown) => cause);
  await vi.waitFor(() => expect(closing).toHaveBeenCalledTimes(1));
  return { cloud, runner, worker, old, raw, held, closing, starting };
}

function expectReplacementStillFenced(state: Awaited<ReturnType<typeof replacementWithHeldClose>>) {
  expect(state.cloud.acquired).toHaveLength(1);
  expect(connectNativeProcess).toHaveBeenCalledTimes(1);
  expect(chromium.connectOverCDP).toHaveBeenCalledTimes(1);
  expect(state.closing).toHaveBeenCalledTimes(1);
  expect(state.old.peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  expect(state.old.resources!.snapshot()).toMatchObject({ nativeContexts: 0, playwrightContexts: 0, playwrightClients: 1 });
}

it('does not acquire or dial the replacement until the exact old PW close resolves', async () => {
  const state = await replacementWithHeldClose();
  try {
    expectReplacementStillFenced(state);
    let completed = false; void state.starting.then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(completed).toBe(false);
    expectReplacementStillFenced(state);
    state.held.resolve(); expect(await state.starting).toBeUndefined();
    expect(state.cloud.acquired).toHaveLength(2); expect(chromium.connectOverCDP).toHaveBeenCalledTimes(2);
    expect(state.old.resources!.snapshot()).toMatchObject({ playwrightClients: 0 });
    await state.worker.dispose(probeCleanup());
    expect(state.cloud.released.map(lease => lease.id)).toEqual(['lease-1']);
  } finally { state.held.resolve(); await state.starting; await state.worker.dispose(probeCleanup()).catch(() => undefined); await state.runner.finish(finishInfo()); }
});

it.each(['endAttempt', 'dispose', 'both'] as const)('concurrent %s joins a held old PW close with enough cleanup budget and cannot acquire a replacement', async kind => {
  const state = await replacementWithHeldClose();
  const cleanups: Promise<void>[] = []; let completed = 0;
  try {
    expectReplacementStillFenced(state);
    if (kind !== 'dispose') cleanups.push(state.worker.endAttempt(probeCleanup()).then(() => { completed++; }));
    if (kind !== 'endAttempt') cleanups.push(state.worker.dispose(probeCleanup()).then(() => { completed++; }));
    await new Promise(resolve => setImmediate(resolve));
    expect(completed).toBe(0); expectReplacementStillFenced(state);
    state.held.resolve();
    expect(await state.starting).toMatchObject({ code: 'CANCELLED' });
    await Promise.all(cleanups); expect(completed).toBe(cleanups.length);
    expect(state.cloud.acquired).toHaveLength(1); expect(chromium.connectOverCDP).toHaveBeenCalledTimes(1);
    expect(state.closing).toHaveBeenCalledTimes(1);
    expect(state.old.resources!.snapshot()).toMatchObject({ playwrightClients: 0 });
  } finally { state.held.resolve(); await state.starting; await Promise.allSettled(cleanups); await state.worker.dispose(probeCleanup()).catch(() => undefined); await state.runner.finish(finishInfo()); }
});

it('retains an actual old PW close rejection for concurrent and repeated cleanup without acquiring a replacement', async () => {
  const state = await replacementWithHeldClose();
  const primary = new Error('exact old PW disconnect failed');
  const ending = state.worker.endAttempt(probeCleanup()).catch((cause: unknown) => cause);
  const disposal = state.worker.dispose(probeCleanup()).catch((cause: unknown) => cause);
  try {
    await new Promise(resolve => setImmediate(resolve)); expectReplacementStillFenced(state);
    state.held.reject(primary);
    expect(await state.starting).toBe(primary); expect(await ending).toBe(primary); expect(await disposal).toBe(primary);
    await expect(state.worker.dispose(probeCleanup())).rejects.toBe(primary);
    await expect(state.worker.endAttempt(probeCleanup())).rejects.toBe(primary);
    await expect(state.worker.startAttempt(attempt('a3'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expectReplacementStillFenced(state);
    // Failed PW disconnect is custody, not a synthetic disconnect or close event.
    expect(state.raw.isConnected()).toBe(true);
  } finally { state.held.reject(primary); await state.starting; await ending; await disposal; await state.runner.finish(finishInfo()); }
});
