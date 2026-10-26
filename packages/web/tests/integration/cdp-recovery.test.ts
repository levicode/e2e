import { beginCaseCleanupCapture } from '../helpers/case-cleanup-capture.ts';
/** Real CDP transport drops preserve only the dedicated persistent context, never a replacement. */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { connect as connectSocket, createServer, type AddressInfo, type Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { chromium, type Browser as HostBrowser, type ConnectOverCDPOptions } from 'playwright-core';
import { EngineError, TestError, type EngineHandle, type OperationContext } from 'e2e/engine';
import { web as webEngine, type WebConnectOptions, type WebOptions, type Browser } from '../../src/index.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { decodePng } from '../helpers/png.ts';
import { NativeClient } from '../../src/native/client.ts';
import { NativeFrames as FrameReader } from '../../src/native/frames.ts';
import { MAX_FRAME_BYTES, serverMessage } from '../../src/native/protocol.ts';
import { BrowserChannel } from '../../src/native/browser-channel.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { nativeBrowser } from '../helpers/native-browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
import { beginSyntheticCase, validSyntheticFact, type SyntheticEvidence, type SyntheticFact, type SyntheticCaseId, type SyntheticCommand, type SyntheticPhase } from '../helpers/synthetic-evidence.ts';
import { observeSyntheticConnection, SyntheticRecoveryEvidence as RecoveryEvidence, type RecoverySection } from '../helpers/synthetic-native-outcomes.ts';
import { observeNativeTerminalClose, terminalCloseEvidence, type TerminalCloseEvidence } from '../helpers/native-terminal-close-observer.ts';

const recoveryEvidence = new AsyncLocalStorage<RecoveryEvidence>();
const recoveryTasks = new WeakMap<object, RecoveryEvidence>();
interface RecoveryContract { schemaVersion: 1; caseId: SyntheticCaseId; invalid: boolean; facts: SyntheticFact[]; terminalCleanup: TerminalCloseEvidence }
const recoveryContracts = new WeakMap<object, RecoveryContract>();
const terminalObservers = new WeakMap<object, Array<() => void>>();
const recoveryCaptures = new WeakMap<object, ReturnType<typeof beginCaseCleanupCapture>>();

/** Reuse the existing observer's bounded facts; this never enables the synthetic batch. */
function recoveryContractSink(context: TestContext, id: SyntheticCaseId): SyntheticEvidence {
  const sink = beginSyntheticCase(id);
  if (id !== 'P07' && id !== 'P08') return sink;
  const diagnostic = id === 'P08' && process.env['E2E_CDP_RECOVERY_DIAGNOSTIC'] === '1';
  const contract: RecoveryContract = { schemaVersion: 1, caseId: id, invalid: false, facts: [], terminalCleanup: terminalCloseEvidence() };
  recoveryContracts.set(context.task, contract);
  Object.assign(context.task.meta, { nativeRecoveryContract: contract }, diagnostic ? { nativeRecoveryDiagnostic: contract } : {});
  const capture = (fact: SyntheticFact): void => {
    if (fact.kind !== 'selected-operation' && fact.kind !== 'cleanup-native' && !(diagnostic && fact.kind === 'test-failure')) return;
    if (contract.facts.length >= (diagnostic ? 5 : 3) || !validSyntheticFact(fact, id)) { contract.invalid = true; return; }
    contract.facts.push(structuredClone(fact));
  };
  return {
    available: sink.available,
    record(fact) { capture(fact); sink.record(fact); },
    tryRecord(fact) { capture(fact); return sink.tryRecord(fact); },
    observe(observer) { sink.observe(observer); },
    finish(outcome) { sink.finish(outcome); },
    invalidate() { contract.invalid = true; sink.invalidate(); },
  };
}
function recoveryCase(id: SyntheticCaseId, body: () => Promise<void>) {
  return async (context: TestContext): Promise<void> => {
    const record = new RecoveryEvidence(recoveryContractSink(context, id));
    recoveryTasks.set(context.task, record);
    return record.observer.run(() => recoveryEvidence.run(record, async () => {
      try { await body(); record.passed('body'); }
      catch (cause) {
        if (record.outcome[record.section] !== 'passed' || !Object.values(record.outcome).includes('failed')) record.failed(record.section, cause);
        throw cause;
      }
      // Footer waits for the ORIGINAL afterEach backstop, including startup failure.
    }));
  };
}
function recoveryPhase(phase: SyntheticPhase, section?: RecoverySection): void {
  recoveryEvidence.getStore()?.enter(phase, section);
}

/** Only source-selected disputed calls, never broad operation tracing. */
function recoverySelect<T>(ordinal: number, command: SyntheticCommand, body: () => T): T {
  const observer = recoveryEvidence.getStore()?.observer;
  return observer ? observer.select(ordinal, command, body) : body();
}
function recoveryAssert<T>(ordinal: number, body: () => T): T {
  const observer = recoveryEvidence.getStore()?.observer;
  return observer ? observer.assert(ordinal, body) : body();
}

/** One operation's budget, independent of model calls or the runner's test timeout. */
function operation(timeoutMs = 10_000, signal = new AbortController().signal): OperationContext {
  return { timeoutMs, signal, runId: 'run-recovery', attemptId: 'a1', origin: 'test' };
}

/** Cleanup owns transports; the test host owns terminating Chrome. */
function cleanup() {
  return { timeoutMs: 10_000, signal: new AbortController().signal };
}

interface NativeRelay {
  readonly endpoint: string;
  readonly directEndpoint: string;
  disconnect(): void;
  connections(): number;
  closeRelay(): Promise<void>;
}

type RecoveryHost = RemoteChrome & NativeRelay;

/** Drop only the native adapter's real CDP sockets while its independent browser process survives. */
async function relay(source: string): Promise<NativeRelay> {
  const target = new URL(source);
  const sockets = new Set<Socket>();
  const server = createServer((downstream) => {
    const upstream = connectSocket({ host: target.hostname, port: Number(target.port) });
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.on('error', () => { downstream.destroy(); upstream.destroy(); });
      socket.on('close', () => { sockets.delete(socket); downstream.destroy(); upstream.destroy(); });
    }
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const endpoint = new URL(source);
  endpoint.port = String((server.address() as AddressInfo).port);
  const disconnect = () => { for (const socket of sockets) socket.destroy(); };
  let closing: Promise<void> | undefined;
  return { endpoint: endpoint.href, directEndpoint: source, disconnect, connections: () => sockets.size,
    closeRelay: () => closing ??= new Promise<void>((resolve, reject) => {
      disconnect();
      server.close((cause) => cause === undefined ? resolve() : reject(cause));
    }),
  };
}

const heading = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } } as const;

describe('native CDP fault relay', () => {
  it('forwards traffic, drops only its connected peers, and accepts a fresh connection', async () => {
    const server = createServer(socket => { socket.pipe(socket); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const source = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/browser/synthetic`;
    const transport = await relay(source);
    const clients: Socket[] = [];
    /** Open and exercise an actual TCP peer of the fault relay. */
    const peer = async (value: string) => {
      const socket = connectSocket(Number(new URL(transport.endpoint).port), '127.0.0.1');
      clients.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      const reply = new Promise<string>((resolve, reject) => { socket.once('data', chunk => resolve(chunk.toString())); socket.once('error', reject); });
      socket.write(value);
      expect(await reply).toBe(value);
      return socket;
    };
    try {
      expect(new URL(transport.endpoint).pathname).toBe('/devtools/browser/synthetic');
      expect(transport.directEndpoint).toBe(source);
      const first = await peer('first connection');
      const closed = new Promise<void>(resolve => first.once('close', () => resolve()));
      transport.disconnect();
      await closed;
      await expect.poll(() => transport.connections()).toBe(0);
      await peer('reconnected');
      expect(transport.connections()).toBe(2);
    } finally {
      for (const socket of clients) socket.destroy();
      await transport.closeRelay();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe('CDP session recovery', () => {
  let app: FixtureApp;
  let artifactsDir: string;
  const activeEngines = new Set<EngineHandle>();
  const activeHosts = new Set<RecoveryHost>();
  const hostControls = new Map<RecoveryHost, { browser: HostBrowser; noDefaults: boolean }>();
  const fixtures = new Map<EngineHandle, { browser: Browser; timeoutMs: number }>();
  const attemptArtifacts = new WeakMap<EngineHandle, string>();
  let disconnectEvents = 0;

  beforeEach(test => {
    if (test.task.name === 'bounds a hung reconnect resolver and propagates cancellation to it') {
      recoveryCaptures.set(test.task, beginCaseCleanupCapture('hung-recovery', test.task.meta as Record<string, unknown>));
    }
    disconnectEvents = 0;
    const observers: Array<() => void> = [];
    terminalObservers.set(test.task, observers);
    const connect = NativeClient.connect;
    vi.spyOn(NativeClient, 'connect').mockImplementation((channel, capabilities, context, onEvent) => {
      const promise = observeSyntheticConnection(connect(channel, capabilities, context, async event => {
        await onEvent(event);
        if (event.event === 'browser.disconnected') disconnectEvents += 1;
      }));
      void promise.then(client => {
        const contract = recoveryContracts.get(test.task);
        if (contract !== undefined) {
          if (observers.length !== 0) { contract.invalid = true; return; }
          observers.push(observeNativeTerminalClose(client, contract.terminalCleanup));
        }
      }, () => {}).catch(() => { const contract = recoveryContracts.get(test.task); if (contract) contract.invalid = true; });
      return promise;
    });
  });

  /** Wait for the adapter to consume the real disconnection, not an arbitrary delay. */
  async function disconnect(remote: RecoveryHost): Promise<void> {
    recoveryPhase('disconnect');
    const previous = disconnectEvents;
    remote.disconnect();
    await expect.poll(() => disconnectEvents, { timeout: 5_000 }).toBeGreaterThan(previous);
  }

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-cdp-recovery-'));
  });

  afterAll(async () => {
    await app?.close();
    if (artifactsDir !== undefined) rmSync(artifactsDir, { recursive: true, force: true });
  });

  afterEach(async context => {
    try {
    const diagnostic = recoveryTasks.get(context.task);
    diagnostic?.enter('backstop', 'cleanup');
    diagnostic?.evidence.record({ kind: 'ownership', phase: 'backstop', hosts: activeHosts.size, clients: activeEngines.size, relays: activeHosts.size, pendingCleanup: activeHosts.size + activeEngines.size + hostControls.size });
    const failures: unknown[] = [];
    const settle = async (work: readonly Promise<unknown>[]) => {
      for (const result of await Promise.allSettled(work)) if (result.status === 'rejected') { diagnostic?.observer.failure('cleanup', result.reason); failures.push(result.reason); }
    };
    await settle([...activeEngines].map(engine => engine.dispose!(cleanup())));
    await settle([...hostControls.values()].map(control => control.browser.close()));
    await settle([...activeHosts].flatMap(remote => [remote.closeRelay(), closeRemoteChrome(remote)]));
    activeEngines.clear(); activeHosts.clear(); hostControls.clear(); fixtures.clear();
    for (const restore of terminalObservers.get(context.task) ?? []) restore();
    terminalObservers.delete(context.task);
    vi.restoreAllMocks();
    if (diagnostic) {
      diagnostic.finishBackstop(failures.length > 0);
      recoveryTasks.delete(context.task);
    }
    const contract = recoveryContracts.get(context.task);
    recoveryContracts.delete(context.task);
    if (failures.length > 0) throw new AggregateError(failures, 'Recovery fixture cleanup failed');
    if (contract !== undefined) {
      expect(contract.invalid).toBe(false);
      const initial = contract.facts.find(fact => fact.kind === 'selected-operation' && fact.ordinal === 0);
      const repeated = contract.facts.find(fact => fact.kind === 'selected-operation' && fact.ordinal === 1);
      const ended = contract.facts.find(fact => fact.kind === 'cleanup-native');
      const state = initial?.kind === 'selected-operation' ? initial.firstResult?.scopeState : undefined;
      expect(['usable', 'quarantined']).toContain(state);
      const refusal = { operationSeq: expect.any(Number), ok: false, code: 'stale-scope', effects: 'not-dispatched', scopeState: state };
      expect(initial).toMatchObject({ kind: 'selected-operation', ordinal: 0, command: 'scope.reconnect', invoked: true,
        requestCount: 1, requestPending: 0, rejected: false, adapter: 'rejected', code: 'INVALID_STATE',
        reason: 'native-stale-scope', assertion: 'passed', firstResult: refusal, firstFailure: refusal });
      expect(repeated).toMatchObject({ kind: 'selected-operation', ordinal: 1, command: 'scope.reconnect', invoked: true,
        requestCount: 0, requestPending: 0, firstResult: null, firstFailure: null, rejected: false,
        adapter: 'rejected', code: 'INVALID_STATE', reason: 'native-stale-scope', assertion: 'passed' });
      if (state === 'usable') {
        expect(contract.facts).toHaveLength(3);
        expect(ended).toMatchObject({ kind: 'cleanup-native', command: 'scope.end', requestCount: 1, requestPending: 0,
          firstResult: { operationSeq: expect.any(Number), ok: true, code: null, effects: 'completed', scopeState: 'usable' },
          firstFailure: null, rejected: false });
      } else {
        // A quarantined owner may only use the terminal control lane. Never
        // disguise that as a reusable scope.end receipt or accept socket EOF.
        expect(contract.facts).toHaveLength(2);
        expect(ended).toBeUndefined();
        expect(contract.terminalCleanup).toEqual({ invalid: false, exchanges: 1, pending: 0,
          validatedClosed: 1, generationMatched: true, terminalAtExchange: true,
          ordinaryPendingAtExchange: 0, ordinaryPendingAfterClose: 0, settled: 'fulfilled' });
      }
    }
    } finally {
      recoveryCaptures.get(context.task)?.finish();
      recoveryCaptures.delete(context.task);
    }
  });

  /** Registers the host before attempt setup, so a failed setup cannot leak Chrome. */
  async function host(): Promise<RecoveryHost> {
    recoveryPhase('host');
    const chrome = await launchRemoteChrome();
    let remote: RecoveryHost;
    try { remote = { ...chrome, ...await relay(chrome.endpoint) }; } catch (cause) { await closeRemoteChrome(chrome); throw cause; }
    activeHosts.add(remote);
    return remote;
  }

  /** Supplies the engine fixture with the same operation budget as its caller. */
  function fixtureOf(engine: EngineHandle, timeoutMs = 10_000): Browser {
    const existing = fixtures.get(engine);
    if (existing !== undefined) { existing.timeoutMs = timeoutMs; return existing.browser; }
    const entry = { timeoutMs, browser: undefined as unknown as Browser };
    entry.browser = nativeBrowser(engine, () => operation(entry.timeoutMs), app.url);
    fixtures.set(engine, entry);
    return entry.browser;
  }

  /** A separate direct host connection is an oracle/fault injector, never the engine's adapter. */
  async function hostControl(remote: RecoveryHost, options: Pick<ConnectOverCDPOptions, 'noDefaults'> = {}): Promise<HostBrowser> {
    const existing = hostControls.get(remote);
    if (existing !== undefined) {
      if (options.noDefaults !== undefined && options.noDefaults !== existing.noDefaults) throw new Error('Host oracle defaults must be chosen before its first connection');
      return existing.browser;
    }
    const control = await chromium.connectOverCDP(remote.directEndpoint, options);
    hostControls.set(remote, { browser: control, noDefaults: options.noDefaults ?? false });
    return control;
  }

  it.each([false, true])('fixes host oracle defaults before its first attachment (noDefaults: %s)', async (noDefaults) => {
    const remote = { directEndpoint: 'ws://oracle.test/devtools/browser/synthetic' } as RecoveryHost;
    const control = { close: vi.fn().mockResolvedValue(undefined) } as unknown as HostBrowser;
    const connect = vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue(control);
    expect(await hostControl(remote, { noDefaults })).toBe(control);
    expect(connect).toHaveBeenCalledExactlyOnceWith(remote.directEndpoint, { noDefaults });
    expect(await hostControl(remote)).toBe(control);
    expect(await hostControl(remote, { noDefaults })).toBe(control);
    await expect(hostControl(remote, { noDefaults: !noDefaults })).rejects.toThrow('Host oracle defaults must be chosen before its first connection');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  /** Resolve the actual active target through a unique page marker, not a matching URL. */
  async function witness(engine: EngineHandle, remote: RecoveryHost) {
    recoveryPhase('witness');
    const marker = randomUUID();
    await fixtureOf(engine).evaluate((value) => { (window as unknown as { recoveryWitness: string }).recoveryWitness = value; return null; }, marker);
    const control = await hostControl(remote);
    const pages = control.contexts().flatMap(context => context.pages());
    const matches = [];
    for (const page of pages) {
      if (await page.evaluate(() => (window as unknown as { recoveryWitness?: string }).recoveryWitness).catch(() => undefined) === marker) matches.push(page);
    }
    expect(matches).toHaveLength(1);
    const page = matches[0]!;
    const session = await page.context().newCDPSession(page);
    const { targetInfo } = await session.send('Target.getTargetInfo');
    await session.detach();
    return { page, marker, targetId: targetInfo.targetId };
  }

  function freshArtifacts(engine: EngineHandle): string {
    const directory = mkdtempSync(path.join(artifactsDir, 'attempt-'));
    attemptArtifacts.set(engine, directory);
    return directory;
  }

  function artifactsOf(engine: EngineHandle): string {
    const directory = attemptArtifacts.get(engine);
    if (directory === undefined) throw new Error('No artifact directory for this attempt');
    return directory;
  }

  /** Starts the engine's attempt against a host-provisioned browser. */
  async function start(connect: WebConnectOptions | undefined, options: Omit<WebOptions, 'connect'> = {}, open = true): Promise<EngineHandle> {
    recoveryPhase('start', 'setup');
    const engine = webEngine({ ...options, ...(connect === undefined ? {} : { connect }) });
    activeEngines.add(engine);
    const info = { runId: 'run-recovery', targetName: 'web', projectRoot: process.cwd(),
      app: { site: new URL(app.url).hostname }, env: process.env, headed: false,
      signal: new AbortController().signal, log: () => undefined };
    const prepared = await engine.prepare!({ ...info, slots: 1 });
    await engine.init!({ ...info, env: { ...prepared?.env, ...info.env }, workerSlot: 0 });
    // Each engine attempt owns its artifacts; production intentionally refuses to overwrite video files.
    const attemptArtifactsDir = freshArtifacts(engine);
    await engine.startAttempt!({ attemptId: 'a1', artifactsDir: attemptArtifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    if (open) await engine.session!.open!(`${app.url}/login`, operation());
    recoveryEvidence.getStore()?.passed('setup');
    recoveryPhase('dispatch', 'body');
    return engine;
  }

  /** The host oracle must not auto-answer dialogs on behalf of the native adapter. */
  async function activatedHost(remote: RecoveryHost) {
    const control = await hostControl(remote);
    const page = control.contexts()[0]!.pages()[0]!;
    await page.goto(`${app.url}/login`);
    await page.evaluate(() => {
      const button = document.createElement('button'); button.id = 'activate-beforeunload';
      button.textContent = 'Activate host'; document.body.append(button);
      window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = ''; });
    });
    await page.locator('#activate-beforeunload').click();
    expect(await page.evaluate(() => navigator.userActivation.hasBeenActive)).toBe(true);
    page.on('dialog', () => {});
    return page;
  }

  it.each(['open', 'video'] as const)('leaves the host untouched until first %s and allows a pre-open dialog handler', async (first) => {
    const remote = await host(); const page = await activatedHost(remote); const url = page.url();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint }, {}, false);
    expect(page.url()).toBe(url);
    expect(await page.locator('#activate-beforeunload').count()).toBe(1);
    const dialogs: string[] = [];
    await fixtureOf(engine).onDialog(async dialog => { dialogs.push(dialog.type); await dialog.accept(); });
    if (first === 'open') await engine.session!.open!(`${app.url}/login`, operation());
    else {
      await engine.artifacts!.startVideo!(operation());
      await engine.artifacts!.stopVideo!(operation());
    }
    expect(dialogs).toEqual(['beforeunload']);
    expect(await page.locator('#activate-beforeunload').count()).toBe(0);
  });

  it('activates the borrowed first page through the registered dialog handler before provider recording', async () => {
    const remote = await host(); const page = await activatedHost(remote); const url = page.url();
    const events: string[] = [];
    const record = vi.fn(async () => {
      events.push('record'); expect(page.url()).toBe('about:blank');
      expect(await page.locator('#activate-beforeunload').count()).toBe(0);
      return { startedAt: '2026-10-21T00:00:00.000Z', stop: async () => ({ url: 'https://synthetic.test/recording.mp4', mediaType: 'video/mp4' }) };
    });
    const engine = await start(undefined, { browser: { name: 'activation-fixture', scope: 'attempt', acquire: async () => ({ id: 'activation-lease', cdpEndpoint: remote.endpoint }), release: async () => {}, record } }, false);
    expect(page.url()).toBe(url); expect(record).not.toHaveBeenCalled();
    await fixtureOf(engine).onDialog(async dialog => { events.push(dialog.type); await dialog.accept(); });
    await engine.artifacts!.startVideo!(operation());
    expect(events).toEqual(['beforeunload', 'record']); expect(record).toHaveBeenCalledTimes(1);
    await engine.artifacts!.stopVideo!(operation());
  });

  for (const first of ['open', 'video'] as const) it(`dismisses an unhandled activated beforeunload on first ${first} instead of silently accepting it`, recoveryCase(first === 'open' ? 'P02' : 'P03', async () => {
    const remote = await host(); const page = await activatedHost(remote); const url = page.url();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint }, {}, false);
    expect(page.url()).toBe(url);
    const activating = recoverySelect(0, first === 'open' ? 'page.navigate' : 'recording.start', () => first === 'open' ? engine.session!.open!(`${app.url}/login`, operation()) : engine.artifacts!.startVideo!(operation()));
    await recoveryAssert(0, () => expect(activating).rejects.toBeDefined());
    expect(page.url()).toBe(url);
    expect(await page.locator('#activate-beforeunload').count()).toBe(1);
  }));

  it('keeps the exact page, document state, storage, viewport, routes, and dialog handlers', recoveryCase('P04', async () => {
    // Synthetic-case-only diagnostic: bounded closed facts, never request args or error text.
    type Step = 'host' | 'start' | 'witness' | 'viewport' | 'seed-state' | 'initial-locate' | 'initial-observe' |
      'other-tab' | 'route' | 'dialog' | 'disconnect' | 'recovered-locate' | 'recovered-state' | 'stale-element' |
      'stale-viewport' | 'stale-coordinate' | 'recovered-observe' | 'recovered-action' | 'dispose' | 'close-host';
    let step: Step = 'host';
    let startupFailed = false;
    let startupStep: Step | 'none' = 'none';
    let bodyFailed = false;
    let cleanupFailed = false;
    let bodyStep: Step | 'none' = 'none';
    let cleanupStep: Step | 'none' = 'none';
    const preserveCleanupFailure = (cause: unknown): never => {
      cleanupFailed = true; cleanupStep = step;
      throw cause;
    };
    try {
      const remote = await host();
      let provisioned = 0;
      let reconnected = 0;
      step = 'start'; recoveryPhase('start', 'setup');
      const engine = await start({
        cdpEndpoint: () => { provisioned += 1; return remote.endpoint; },
        reconnectEndpoint: () => { reconnected += 1; return remote.endpoint; },
      });
      step = 'witness'; recoveryPhase('witness', 'body');
      try {
        const fixture = fixtureOf(engine);
        const original = await witness(engine, remote);
        // The independent oracle must not auto-dismiss native-owned dialogs.
        original.page.on('dialog', () => {});
        step = 'viewport'; recoveryPhase('viewport', 'body');
        await fixture.setViewport({ width: 800, height: 600 });
        step = 'seed-state'; recoveryPhase('seed-state', 'body');
        await fixture.evaluate(() => {
          sessionStorage.setItem('attempt', 'kept');
          localStorage.setItem('login', 'kept');
          document.cookie = 'session=kept';
          (document.querySelector('input[name=user]') as HTMLInputElement).value = 'unsaved';
          return null;
        });
        step = 'initial-locate'; recoveryPhase('initial-locate', 'body');
        const stale = (await engine.locate!(heading, operation()))[0]!;
        step = 'initial-observe'; recoveryPhase('initial-observe', 'body');
        const observation = await engine.observe!(operation());
        // Another tab at the same URL makes URL-based selection ambiguous.
        step = 'other-tab'; recoveryPhase('other-tab', 'body');
        const other = await original.page.context().newPage();
        await other.goto(await fixture.url());
        await other.locator('h1').evaluate((node) => { node.textContent = 'Wrong tab'; });

        step = 'route'; recoveryPhase('route', 'body');
        await fixture.route('**/kept-route', (route) => route.fulfill({ body: 'route kept' }));
        step = 'dialog'; recoveryPhase('dialog', 'body');
        await fixture.onDialog('accept');
        step = 'disconnect'; recoveryPhase('disconnect', 'body');
        await disconnect(remote);

        step = 'recovered-locate'; recoveryPhase('recovered-locate', 'body');
        expect((await engine.locate!(heading, operation()))[0]?.name).toBe('Login');
        step = 'recovered-state'; recoveryPhase('recovered-state', 'body');
        const marker = await recoverySelect(0, 'page.evaluate', () => fixture.evaluate(() => (window as unknown as { recoveryWitness: string }).recoveryWitness));
        recoveryAssert(0, () => expect(marker).toBe(original.marker));
        const session = await original.page.context().newCDPSession(original.page);
        expect((await session.send('Target.getTargetInfo')).targetInfo.targetId).toBe(original.targetId);
        await session.detach();
        const input = await recoverySelect(1, 'page.evaluate', () => fixture.evaluate(() => (document.querySelector('input[name=user]') as HTMLInputElement).value));
        recoveryAssert(1, () => expect(input).toBe('unsaved'));
        const storage = await recoverySelect(2, 'page.evaluate', () => fixture.evaluate(() => [sessionStorage.getItem('attempt'), localStorage.getItem('login'), document.cookie]));
        recoveryAssert(2, () => expect(storage).toEqual(['kept', 'kept', 'session=kept']));
        const viewport = await recoverySelect(3, 'page.evaluate', () => fixture.evaluate(() => ({ width: innerWidth, height: innerHeight })));
        recoveryAssert(3, () => expect(viewport).toEqual({ width: 800, height: 600 }));
        const route = await recoverySelect(4, 'page.evaluate', () => fixture.evaluate(async () => (await fetch('/kept-route')).text()));
        recoveryAssert(4, () => expect(route).toBe('route kept'));
        const dialog = await recoverySelect(5, 'page.evaluate', () => fixture.evaluate(() => confirm('Handler survived?')));
        recoveryAssert(5, () => expect(dialog).toBe(true));
        step = 'stale-element'; recoveryPhase('stale-element', 'body');
        await expect(engine.perform!(stale.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
        expect(observation.viewportRef).toBeDefined();
        step = 'stale-viewport'; recoveryPhase('stale-viewport', 'body');
        await expect(engine.perform!(observation.viewportRef!, { kind: 'swipe', direction: 'down' }, operation()))
          .rejects.toMatchObject({ code: 'NODE_STALE' });
        step = 'stale-coordinate'; recoveryPhase('stale-coordinate', 'body');
        await expect(engine.performAt!({ x: 1, y: 1 }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
        step = 'recovered-observe'; recoveryPhase('recovered-observe', 'body');
        await engine.observe!(operation());
        step = 'recovered-action'; recoveryPhase('recovered-action', 'body');
        await engine.performAt!({ x: 1, y: 1 }, { kind: 'tap' }, operation());
        expect(provisioned).toBe(1);
        expect(reconnected).toBe(1);
      } catch (cause) {
        bodyFailed = true; bodyStep = step;
        throw cause;
      } finally {
        step = 'dispose'; recoveryPhase('dispose', 'cleanup');
        try {
          await engine.dispose!(cleanup());
          await expect(fixtureOf(engine).url()).rejects.toMatchObject({ code: 'CANCELLED' });
          await expect.poll(() => remote.connections()).toBe(0);
          expect(remote.proc.exitCode).toBeNull();
          expect(remote.proc.signalCode).toBeNull();
          step = 'close-host'; recoveryPhase('close-host', 'cleanup');
          await closeRemoteChrome(remote);
        } catch (cause) {
          preserveCleanupFailure(cause);
        }
      }
    } catch (cause) {
      // Failed startup remains owned by afterEach's already registered host and engine.
      if (!bodyFailed && !cleanupFailed) { startupFailed = true; startupStep = step; }
      throw cause;
    } finally {
      const record = recoveryEvidence.getStore();
      if (startupFailed) { record?.enter(startupStep as Step, 'setup'); record?.failed('setup'); }
      if (bodyFailed) { record?.enter(bodyStep as Step, 'body'); record?.failed('body'); }
      else if (!startupFailed) record?.passed('body');
      if (cleanupFailed) { record?.enter(cleanupStep as Step, 'cleanup'); record?.failed('cleanup'); }

    }
  }), 60_000);

  it('emulates the configured and requested media on the persistent page, after reconnect too', recoveryCase('P05', async () => {
    const record = recoveryEvidence.getStore()!;
    const evidence = record.evidence;
    const outcome = record.outcome;
    let section: 'setup' | 'body' | 'cleanup' = 'setup';
    let phase: SyntheticPhase = 'host';
    /** Record only the current original operation, without inserting an awaited wrapper. */
    const enter = (next: SyntheticPhase): void => { phase = next; record.enter(phase, section); };
    const passed = (): void => evidence.record({ kind: 'phase', section, phase, state: 'passed' });
    enter('host');
    try {
      const remote = await host(); passed();
      enter('start');
      const engine = await start(
        { cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint },
        { colorScheme: 'dark' },
      ); passed();
      outcome.setup = 'passed'; section = 'body'; outcome.body = 'incomplete';
      const media = () => fixtureOf(engine).evaluate(() => ({
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
        reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
      }));
      try {
        enter('media-configure');
        await fixtureOf(engine).emulateMedia({ reducedMotion: 'reduce' }); passed();
        enter('media-read');
        expect(await media()).toEqual({ dark: true, reduce: true }); passed();
        const fixture = fixtureOf(engine);
        enter('popup-open');
        const opened = await fixture.evaluate(() => {
          (window as unknown as { recoveryPopup: Window | null }).recoveryPopup = window.open('/');
          const popup = (window as unknown as { recoveryPopup: Window | null }).recoveryPopup;
          let readFailed = false;
          const read = (getter: () => boolean): boolean | null => { try { return getter(); } catch { readFailed = true; return null; } };
          return { present: popup !== null, closed: read(() => popup!.closed),
            activationActive: read(() => navigator.userActivation.isActive), activationEver: read(() => navigator.userActivation.hasBeenActive), readState: readFailed ? 'failed' as const : 'ok' as const };
        });
        evidence.observe(() => ({ kind: 'popup-readiness', phase: 'open-return', sampleOrdinal: 0,
          ...opened, pathMatches: null, complete: null, predicate: null })); passed();
        enter('readiness');
        let sampleOrdinal = 0;
        await expect.poll(async () => {
          const sampled = await fixture.evaluate(() => {
            const popup = (window as unknown as { recoveryPopup: Window | null }).recoveryPopup;
            // Keep the original predicate and its throwing/short-circuit order before optional diagnostics.
            const predicate = popup !== null && popup.location.pathname === '/' && popup.document.readyState === 'complete';
            let readFailed = false;
            const read = (getter: () => boolean): boolean | null => { try { return getter(); } catch { readFailed = true; return null; } };
            return { predicate, present: popup !== null, closed: read(() => popup!.closed),
              pathMatches: read(() => popup!.location.pathname === '/'), complete: read(() => popup!.document.readyState === 'complete'),
              activationActive: read(() => navigator.userActivation.isActive), activationEver: read(() => navigator.userActivation.hasBeenActive), readState: readFailed ? 'failed' as const : 'ok' as const };
          });
          // No additional browser request; serialization and this continuation can still perturb polling cadence.
          if (sampleOrdinal < 15) evidence.observe(() => ({ kind: 'popup-readiness', phase: 'ready-sample', sampleOrdinal: ++sampleOrdinal, ...sampled }));
          else evidence.invalidate();
          return sampled.predicate;
        }).toBe(true); passed();
        const popupReduced = () => fixture.evaluate(() => (window as unknown as { recoveryPopup: Window }).recoveryPopup.matchMedia('(prefers-reduced-motion: reduce)').matches);
        enter('media-read'); expect(await popupReduced()).toBe(true); passed();
        enter('disconnect'); await disconnect(remote); passed();
        enter('recovered-locate'); expect((await engine.locate!(heading, operation()))[0]?.name).toBe('Login'); passed();
        enter('media-read'); expect(await media()).toEqual({ dark: true, reduce: true }); passed();
        // The actual popup Window survives, not another page chosen by URL.
        enter('popup'); expect(await fixture.evaluate(() => (window as unknown as { recoveryPopup: Window }).recoveryPopup.closed)).toBe(false); passed();
        enter('media-read'); expect(await popupReduced()).toBe(true); passed();
        outcome.body = 'passed';
      } catch (cause) {
        outcome.body = 'failed'; evidence.record({ kind: 'phase', section, phase, state: 'failed' });
        throw cause;
      } finally {
        section = 'cleanup'; outcome.cleanup = 'incomplete';
        enter('dispose'); await engine.dispose!(cleanup()); passed();
        enter('close-host'); await closeRemoteChrome(remote); passed();
        outcome.cleanup = 'passed';
      }
    } catch (cause) {
      // A body rejection propagating through successful cleanup is not a cleanup failure.
      if (section !== 'body' && outcome[section] !== 'passed') { outcome[section] = 'failed'; evidence.record({ kind: 'phase', section, phase, state: 'failed' }); }
      throw cause;
    }
  }), 60_000);

  it('runs configured and test init scripts once per document, after reconnect too', async () => {
    const remote = await host();
    const engine = await start(
      { cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint },
      { initScripts: ["(window.trail ??= []).push('config');"] },
    );
    const trail = () => fixtureOf(engine).evaluate(() => (window as { trail?: string[] }).trail ?? null);
    try {
      expect(await trail()).toEqual(['config']);
      const fixture = fixtureOf(engine);
      await fixture.addInitScript(() => { ((window as { trail?: string[] }).trail ??= []).push('test'); });
      await engine.session!.open!(`${app.url}/login`, operation());
      expect(await trail()).toEqual(['config', 'test']);

      await disconnect(remote);
      await engine.session!.open!(`${app.url}/login`, operation());
      expect(await trail()).toEqual(['config', 'test']);
    } finally {
      await engine.dispose!(cleanup());
      await closeRemoteChrome(remote);
    }
  }, 60_000);

  it('fails an uncertain click without reconnecting or dispatching it twice', recoveryCase('P06', async () => {
    const remote = await host();
    let reconnected = 0;
    const engine = await start({
      cdpEndpoint: () => remote.endpoint,
      reconnectEndpoint: () => { reconnected += 1; return remote.endpoint; },
    });
    let failurePhase: 'fixture' | 'locate' | 'perform' | 'transportDropped' | 'observe' | 'dispose' = 'fixture';
    let failed = false;
    let failure: unknown;
    try {
      const fixture = fixtureOf(engine);
      const original = await witness(engine, remote);
      await fixture.evaluate(() => {
        sessionStorage.setItem('clicks', '0');
        const button = document.createElement('button');
        button.textContent = 'Purchase';
        button.addEventListener('click', () => {
          sessionStorage.setItem('clicks', String(Number(sessionStorage.getItem('clicks')) + 1));
          // Pause after the mutation so the transport disappears before click completion.
          // oxlint-disable-next-line no-debugger -- a real CDP pause makes the disconnect deterministic
          debugger;
        });
        document.body.append(button);
        return null;
      });
      const debuggerSession = await original.page.context().newCDPSession(original.page);
      await debuggerSession.send('Debugger.enable');
      const transportDropped = new Promise<void>((resolve, reject) => {
        debuggerSession.once('Debugger.paused', () => {
          void (async () => {
            const outcomes = await Promise.allSettled([
              // The quarantined Unknown receipt may precede/suppress the EOF event.
              // This case waits for real socket loss plus the failed perform receipt;
              // only the later explicit Observe may reconnect the exact owner.
              Promise.resolve(remote.disconnect()),
              (async () => {
                const failures: unknown[] = [];
                try { await expect.poll(() => remote.connections(), { timeout: 5_000 }).toBe(0); }
                catch (cause) { failures.push(cause); }
                finally {
                  try { await debuggerSession.send('Debugger.resume'); }
                  catch (cause) { failures.push(cause); }
                }
                if (failures.length > 0) throw new AggregateError(failures, 'Debugger pause cleanup failed');
              })(),
            ]);
            const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason as unknown] : []);
            if (failures.length > 0) throw new AggregateError(failures, 'Transport drop or debugger cleanup failed');
          })().then(() => resolve(), reject);
        });
      });
      recoveryPhase('locate');
      failurePhase = 'locate';
      const [button] = await engine.locate!({ kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'Purchase', exact: true } } }, operation());
      recoveryPhase('perform');
      failurePhase = 'perform';
      await recoveryAssert(0, () => expect(recoverySelect(0, 'browser.perform', () => engine.perform!(button!.ref, { kind: 'tap' }, operation()))).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false }));
      failurePhase = 'transportDropped';
      await transportDropped;
      expect(reconnected).toBe(0);
      recoveryPhase('observe');
      failurePhase = 'observe';
      await engine.observe!(operation());
      expect(await fixtureOf(engine).evaluate(() => sessionStorage.getItem('clicks'))).toBe('1');
      expect(reconnected).toBe(1);
    } catch (cause) {
      console.error('P06_BODY_FAILURE', JSON.stringify({ phase: failurePhase, code: cause instanceof EngineError ? cause.code : 'unknown' }));
      recoveryEvidence.getStore()?.failed('body', cause);
      failed = true; failure = cause;
    } finally {
      recoveryEvidence.getStore()?.passed('body');
      recoveryPhase('dispose', 'cleanup');
      failurePhase = 'dispose';
      try {
        await engine.dispose!(cleanup());
        await closeRemoteChrome(remote);
        recoveryEvidence.getStore()?.passed('cleanup');
      }
      catch (cause) {
        console.error('P06_CLEANUP_FAILURE', JSON.stringify({ phase: failurePhase, code: cause instanceof EngineError ? cause.code : 'unknown' }));
        if (!failed) { failed = true; failure = cause; }
      }
    }
    if (failed) throw failure;
  }), 60_000);

  it('rejects a different browser and never falls back to the provisioning resolver', recoveryCase('P07', async () => {
    const remote = await host();
    const replacement = await host();
    let provisioned = 0;
    const engine = await start({
      cdpEndpoint: () => { provisioned += 1; return remote.endpoint; },
      reconnectEndpoint: () => replacement.endpoint,
    });
    try {
      await disconnect(remote);
      recoveryPhase('observe');
      let firstFailure: unknown;
      await recoveryAssert(0, async () => {
        firstFailure = await recoverySelect(0, 'scope.reconnect', () => engine.observe!(operation())).catch((cause: unknown) => cause);
        expect(firstFailure).toBeInstanceOf(EngineError);
        expect(firstFailure).toMatchObject({ code: 'INVALID_STATE', retryable: false });
      });
      recoveryPhase('observe');
      await recoveryAssert(1, () => expect(recoverySelect(1, 'scope.reconnect', () => engine.observe!(operation()))).rejects.toBe(firstFailure));
      expect(provisioned).toBe(1);
      expect(replacement.proc.exitCode).toBeNull();
    } catch (cause) {
      recoveryEvidence.getStore()?.failed('body', cause);
      throw cause;
    } finally {
      recoveryEvidence.getStore()?.passed('body');
      recoveryPhase('dispose', 'cleanup');
      await engine.dispose!(cleanup());
      await closeRemoteChrome(remote);
      await closeRemoteChrome(replacement);
      recoveryEvidence.getStore()?.passed('cleanup');
    }
  }), 60_000);

  it('rejects a missing active target even when another tab has the same URL', recoveryCase('P08', async () => {
    const remote = await host();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint });
    try {
      const original = await witness(engine, remote);
      const other = await original.page.context().newPage();
      const originalUrl = await fixtureOf(engine).url();
      await other.goto(originalUrl);
      expect(other).not.toBe(original.page);
      expect(original.page.url()).toBe(originalUrl);
      expect(other.url()).toBe(originalUrl);
      recoveryPhase('target-close');
      await original.page.close();
      expect(original.page.isClosed()).toBe(true);
      expect(other.isClosed()).toBe(false);
      await disconnect(remote);
      recoveryPhase('observe');
      let firstFailure: unknown;
      await recoveryAssert(0, async () => {
        firstFailure = await recoverySelect(0, 'scope.reconnect', () => engine.observe!(operation())).catch((cause: unknown) => cause);
        expect(firstFailure).toBeInstanceOf(EngineError);
        expect(firstFailure).toMatchObject({ code: 'INVALID_STATE', retryable: false });
      });
      recoveryPhase('observe');
      await recoveryAssert(1, () => expect(recoverySelect(1, 'scope.reconnect', () => engine.observe!(operation()))).rejects.toBe(firstFailure));
      expect(original.page.isClosed()).toBe(true);
      expect(other.isClosed()).toBe(false);
      expect(other.url()).toBe(originalUrl);
    } catch (cause) {
      recoveryEvidence.getStore()?.failed('body', cause);
      throw cause;
    } finally {
      recoveryEvidence.getStore()?.passed('body');
      recoveryPhase('dispose', 'cleanup');
      await engine.dispose!(cleanup());
      await closeRemoteChrome(remote);
      recoveryEvidence.getStore()?.passed('cleanup');
    }
  }), 60_000);

  it('bounds a hung reconnect resolver and propagates cancellation to it', async () => {
    const remote = await host();
    let signal: AbortSignal | undefined;
    let entered = false;
    let native: NativeClient | undefined;
    let phase = 'start';
    let failed = false;
    let failure: unknown;
    const cleanupFailures: unknown[] = [];
    let engine: EngineHandle | undefined;
    const state = () => ({ disconnectEvents, resolverEntered: entered, resolverAborted: signal?.aborted === true,
      recovery: native?.recoveryScope() !== undefined, terminal: native?.isTerminal() === true,
      failed: (native as unknown as { failure?: unknown } | undefined)?.failure !== undefined });
    const wire: Record<string, string | number | boolean | null>[] = [];
    let overflow = 0;
    let callOrdinal = 0;
    let wireClosed = false;
    const detach: (() => void)[] = [];
    const commands = new Set(['scope.open', 'scope.configure', 'scope.reconnect', 'scope.reset', 'scope.restart', 'scope.end',
      'session.environment', 'browser.trace', 'browser.observe', 'browser.query', 'browser.perform', 'browser.pointer',
      'browser.keyboard.press', 'browser.keyboard.type', 'page.activate', 'capture.screenshot', 'recording.start',
      'recording.stop', 'state.capture', 'state.restore', 'blob.read', 'fixture.query', 'fixture.read-fields']);
    /** Keep only closed metadata; diagnostic collection never changes a request outcome. */
    const record = (entry: Record<string, string | number | boolean | null>): void => {
      try {
        if (wireClosed) return;
        if (wire.length < 256) wire.push({ phase, ...entry }); else overflow += 1;
      } catch { /* The observer has no authority over the test. */ }
    };
    const connect = vi.mocked(NativeClient.connect).getMockImplementation()!;
    vi.mocked(NativeClient.connect).mockImplementation(async (...args) => {
      // Install after the original synchronous connect setup, without replacing its channel.
      const pending = connect(...args);
      const frames = new FrameReader(MAX_FRAME_BYTES);
      let negotiated: readonly string[] = [];
      let decodeFailed = false;
      const inbound = (chunk: Buffer): void => {
        if (decodeFailed || wireClosed) return;
        try {
          for (const frame of frames.read(chunk)) {
            const message = serverMessage(frame, negotiated);
            switch (message.type) {
              case 'ready':
                negotiated = args[1].filter(capability => message.capabilities.includes(capability));
                frames.limit(Math.min(MAX_FRAME_BYTES, message.limits.maxFrameBytes));
                record({ direction: 'inbound', type: message.type, generation: message.generation, scopeState: message.scopeState });
                break;
              case 'result':
                record({ direction: 'inbound', type: message.type, operationSeq: message.operationSeq, generation: message.generation,
                  ok: message.ok, effects: message.effects, scopeState: message.scopeState, errorCode: message.error?.code ?? null,
                  recovery: message.recovery !== undefined, retention: message.retention !== undefined });
                break;
              case 'control-result':
                record({ direction: 'inbound', type: message.type, generation: message.generation, accepted: message.accepted,
                  scopeState: message.scopeState, errorCode: message.error?.code ?? null });
                break;
              case 'event':
                record({ direction: 'inbound', type: message.type, generation: message.generation, sequence: message.sequence,
                  event: message.event === 'browser.disconnected' || message.event === 'scope.callbacks-retired' ? message.event : 'other' });
                break;
              case 'error':
                record({ direction: 'inbound', type: message.type, errorCode: message.error.code, scopeState: message.scopeState });
                break;
              case 'closed':
                record({ direction: 'inbound', type: message.type, generation: message.generation, scopeState: message.scopeState });
            }
          }
        } catch { decodeFailed = true; record({ direction: 'inbound', type: 'decode-failed' }); }
      };
      args[0].readable.on('data', inbound);
      detach.push(() => args[0].readable.removeListener('data', inbound));
      native = await pending;
      return native;
    });
    const request = NativeClient.prototype.request;
    const probe = vi.spyOn(NativeClient.prototype, 'request').mockImplementation(function (this: NativeClient, ...args) {
      const ordinal = ++callOrdinal;
      const command = commands.has(args[0]) ? args[0] : 'other';
      record({ direction: 'request', type: 'call', callOrdinal: ordinal, command });
      let pending: ReturnType<NativeClient['request']>;
      try { pending = request.apply(this, args); }
      catch (cause) { record({ direction: 'request', type: 'throw', callOrdinal: ordinal, command,
        errorCode: cause instanceof EngineError ? cause.code : 'other' }); throw cause; }
      void pending.then(result => record({ direction: 'request', type: 'result', callOrdinal: ordinal, command,
        operationSeq: result.operationSeq, generation: result.generation, ok: result.ok, effects: result.effects,
        scopeState: result.scopeState, errorCode: result.error?.code ?? null,
        recovery: result.recovery !== undefined, retention: result.retention !== undefined }),
      cause => record({ direction: 'request', type: 'reject', callOrdinal: ordinal, command,
        errorCode: cause instanceof EngineError ? cause.code : 'other' })).catch(() => {});
      return pending;
    });
    try {
      engine = await start({
        cdpEndpoint: () => remote.endpoint,
        reconnectEndpoint: (abort) => { entered = true; signal = abort; console.error('HUNG_RESOLVER_ENTER', JSON.stringify(state())); return new Promise<string>(() => undefined); },
      });
      phase = 'disconnect'; console.error('HUNG_PHASE', JSON.stringify({ phase, ...state() }));
      expect(native).toBeDefined();
      expect(native!.recoveryScope()).toBeUndefined();
      const previousDisconnects = disconnectEvents;
      remote.disconnect();
      // Like the original browser.close()/isConnected contract, wait for a real
      // loss observation, not necessarily an ordinary lifecycle event. An EOF
      // result may quarantine first, sealing the ordinary event sink; the real
      // NativeClient validates its exact pending owner before exposing recovery.
      await expect.poll(() => disconnectEvents > previousDisconnects || native!.recoveryScope() !== undefined,
        { timeout: 5_000 }).toBe(true);
      expect(native!.isTerminal()).toBe(false);
      console.error('HUNG_DISCONNECT_DONE', JSON.stringify(state()));
      phase = 'observe50';
      await expect(engine.observe!(operation(50))).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
      console.error('HUNG_TIMEOUT_ASSERTED', JSON.stringify(state()));
      phase = 'abort-assertion';
      expect(entered).toBe(true);
      expect(signal?.aborted).toBe(true);
      console.error('HUNG_BODY_PASSED', JSON.stringify(state()));
    } catch (cause) {
      failed = true; failure = cause;
      console.error('HUNG_FIRST_BODY', JSON.stringify({ phase, code: cause instanceof EngineError ? cause.code : 'unknown', ...state() }));
    } finally {
      let disposed = false;
      phase = 'dispose';
      if (engine !== undefined) {
        try { await engine.dispose!(cleanup()); disposed = true; console.error('HUNG_DISPOSE_PASSED', JSON.stringify({ phase, ...state() })); }
        catch (cause) { cleanupFailures.push(cause); console.error('HUNG_CLEANUP_FAILURE', JSON.stringify({ phase, code: cause instanceof EngineError ? cause.code : 'unknown', ...state() })); }
      } else console.error('HUNG_DISPOSE_SKIPPED', JSON.stringify({ phase, reason: 'start-not-completed', ...state() }));
      phase = 'close-remote';
      // Preserve the original cleanup ordering: a refused dispose leaves host
      // containment to the existing afterEach backstop, not a diagnostic bypass.
      if (disposed) {
        try { await closeRemoteChrome(remote); console.error('HUNG_CLOSE_REMOTE_PASSED', JSON.stringify({ phase, ...state() })); }
        catch (cause) { cleanupFailures.push(cause); console.error('HUNG_CLEANUP_FAILURE', JSON.stringify({ phase, code: cause instanceof EngineError ? cause.code : 'unknown', ...state() })); }
      } else console.error('HUNG_CLOSE_REMOTE_SKIPPED', JSON.stringify({ phase, reason: 'dispose-not-completed', ...state() }));
      wireClosed = true;
      for (const remove of detach) remove();
      console.error('HUNG_WIRE', JSON.stringify({ schemaVersion: 1, overflow, entries: wire }));
      probe.mockRestore(); vi.mocked(NativeClient.connect).mockImplementation(connect);
    }
    if (failed && cleanupFailures.length > 0) throw new AggregateError([failure, ...cleanupFailures], 'Hung resolver body and cleanup failed');
    if (failed) throw failure;
    if (cleanupFailures.length > 0) throw cleanupFailures[0];
  }, 60_000);

  it('provisions a fresh browser for each attempt and refuses accidental reuse', recoveryCase('P09', async () => {
    const hosts: RecoveryHost[] = [];
    let provisioned = 0;
    let reuse = false;
    const engine = await start({
      cdpEndpoint: async () => {
        provisioned += 1;
        if (!reuse) hosts.push(await host());
        return hosts.at(-1)!.endpoint;
      },
      reconnectEndpoint: () => hosts.at(-1)!.endpoint,
    });
    try {
      await fixtureOf(engine).evaluate(() => { localStorage.setItem('attempt', 'a1'); return null; });
      recoveryPhase('end');
      await engine.endAttempt!(cleanup());
      fixtures.delete(engine);
      recoveryPhase('start');
      await engine.startAttempt!({ attemptId: 'a2', artifactsDir: freshArtifacts(engine), signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
      await engine.session!.open!(`${app.url}/login`, operation());
      expect(await fixtureOf(engine).evaluate(() => localStorage.getItem('attempt'))).toBeNull();
      expect(provisioned).toBe(2);
      recoveryPhase('end');
      await engine.endAttempt!(cleanup());
      reuse = true;
      recoveryPhase('start');
      await recoveryAssert(3, () => expect(recoverySelect(3, 'scope.open', () => engine.startAttempt!({ attemptId: 'a3', artifactsDir: freshArtifacts(engine), signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace })))
        .rejects.toThrow(/reused a browser/));
    } catch (cause) {
      recoveryEvidence.getStore()?.failed('body', cause);
      throw cause;
    } finally {
      recoveryEvidence.getStore()?.passed('body');
      recoveryPhase('dispose', 'cleanup');
      await engine.dispose!(cleanup());
      await Promise.all(hosts.map(closeRemoteChrome));
      recoveryEvidence.getStore()?.passed('cleanup');
    }
  }), 60_000);

  it('shares recovery between concurrent operations while a cancelled waiter dispatches nothing', async () => {
    const remote = await host();
    let resolveEndpoint!: (endpoint: string) => void;
    let notifyRequested!: () => void;
    const endpoint = new Promise<string>((resolve) => { resolveEndpoint = resolve; });
    const requested = new Promise<void>((resolve) => { notifyRequested = resolve; });
    let reconnected = 0;
    const engine = await start({
      cdpEndpoint: () => remote.endpoint,
      reconnectEndpoint: () => {
        reconnected += 1;
        notifyRequested();
        return endpoint;
      },
    });
    await disconnect(remote);
    const first = engine.locate!(heading, operation());
    await requested;
    const controller = new AbortController();
    const cancelled = engine.session!.open!(`${app.url}/form`, operation(10_000, controller.signal));
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    resolveEndpoint(remote.endpoint);
    expect((await first)[0]?.name).toBe('Login');
    expect(await fixtureOf(engine).url()).toBe(`${app.url}/login`);
    expect(reconnected).toBe(1);
  });

  it('counts reconnect time against the operation budget', recoveryCase('P10', async () => {
    const remote = await host();
    const engine = await start({
      cdpEndpoint: () => remote.endpoint,
      reconnectEndpoint: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return remote.endpoint;
      },
    });
    const original = await witness(engine, remote);
    await disconnect(remote);
    // The witness graph captured its original 10s config. Use a new real graph, not a mutable callback, for this 1s operation.
    const budgeted = nativeBrowser(engine, () => operation(1_000), app.url);
    let published = false;
    const failure = await budgeted.evaluate(async () => {
      document.body.dataset['started'] = 'true';
      await new Promise((resolve) => setTimeout(resolve, 800));
      return 'too late';
    }).then(value => { published = true; return value; }).catch((cause: unknown) => cause);
    // Core's own timeout has no EngineError cause; a translated native timeout may have one.
    expect(failure).toBeInstanceOf(TestError);
    expect(failure).toMatchObject({ code: 'ACTION_FAILED', retryable: false });
    expect(await original.page.getAttribute('body', 'data-started')).toBe('true');
    expect(published).toBe(false);
  }));

  it('resumes video recording on the recovered page', recoveryCase('P11', async () => {
    const remote = await host();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint });
    recoveryPhase('recording-start');
    await engine.artifacts!.startVideo!(operation());
    recoveryPhase('screenshot');
    await engine.artifacts!.screenshot('before-reconnect', operation());
    await disconnect(remote);
    recoveryPhase('observe');
    await engine.observe!(operation());
    await fixtureOf(engine).evaluate(() => { document.body.style.background = 'blue'; return null; });
    recoveryPhase('screenshot');
    await engine.artifacts!.screenshot('after-reconnect', operation());
    // The first segment may be lost during disconnect; the new segment must finalize.
    recoveryPhase('recording-stop');
    await recoverySelect(0, 'recording.stop', () => engine.artifacts!.stopVideo!(operation())).catch((cause: unknown) => {
      recoveryAssert(0, () => expect(cause).toMatchObject({ code: 'ENGINE_FAILURE' }));
    });
    const video = path.join(artifactsOf(engine), 'video/video-part2.webm');
    expect(existsSync(video)).toBe(true);
    expect(statSync(video).size).toBeGreaterThan(0);
  }), 60_000);

  it('recovers before arming a download waiter and runs its trigger once', recoveryCase('P12', async () => {
    const boundaries = { kind: 'download-boundaries' as const, registrations: 0, deliveries: 0, triggers: 0, tap: 'not-observed' as 'not-observed' | 'pending' | 'passed' | 'failed' };
    try {
      const subscribe = BrowserChannel.prototype.subscribe;
      vi.spyOn(BrowserChannel.prototype, 'subscribe').mockImplementation(function (this: BrowserChannel, name, callback) {
        if (name !== 'download.started') return subscribe.call(this, name, callback);
        const remove = subscribe.call(this, name, event => {
          if (boundaries.deliveries < 8) boundaries.deliveries++; else recoveryEvidence.getStore()?.evidence.invalidate();
          return callback(event);
        });
        if (boundaries.registrations < 8) boundaries.registrations++; else recoveryEvidence.getStore()?.evidence.invalidate();
        return remove;
      });
    } catch { recoveryEvidence.getStore()?.evidence.invalidate(); }
    try {
      const remote = await host();
      const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint });
      await fixtureOf(engine).evaluate(() => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob(['download kept']));
        link.download = 'kept.txt';
        link.id = 'download';
        link.textContent = 'Download';
        document.body.append(link);
        return null;
      });
      await disconnect(remote);
      let triggered = 0;
      recoveryPhase('download-arm');
      const download = await fixtureOf(engine).waitForDownload(async () => {
        triggered += 1;
        boundaries.triggers = triggered;
        recoveryPhase('locate');
        const [link] = await engine.locate!({ kind: 'selector', selector: '#download' }, operation());
        recoveryPhase('perform');
        boundaries.tap = 'pending';
        try { await recoverySelect(0, 'browser.perform', () => engine.perform!(link!.ref, { kind: 'tap' }, operation())); boundaries.tap = 'passed'; }
        catch (cause) { boundaries.tap = 'failed'; throw cause; }
      });
      recoveryAssert(0, () => expect(triggered).toBe(1));
      expect(readFileSync(path.join(artifactsOf(engine), download.path), 'utf8')).toBe('download kept');
      const failure = new Error('test trigger failed');
      recoveryPhase('download-arm');
      await expect(fixtureOf(engine).waitForDownload(async () => { throw failure; })).rejects.toBe(failure);
    } finally { recoveryEvidence.getStore()?.evidence.record(boundaries); }
  }));

  it('allows direct test-code mouse input using current geometry while observation-derived taps stay stale', recoveryCase('P44', async () => {
    const remote = await host();
    let reconnected = 0;
    const engine = await start({
      cdpEndpoint: () => remote.endpoint,
      reconnectEndpoint: () => { reconnected += 1; return remote.endpoint; },
    });
    await fixtureOf(engine).evaluate(() => {
      const button = document.createElement('button');
      button.id = 'pointer-target';
      button.textContent = 'Count';
      button.style.cssText = 'position:fixed;left:20px;top:200px;width:120px;height:50px';
      button.addEventListener('click', () => {
        document.body.dataset['clicks'] = String(Number(document.body.dataset['clicks'] ?? 0) + 1);
      });
      document.addEventListener('wheel', (event) => {
        document.body.dataset['wheel'] = String(event.deltaY);
        event.preventDefault();
      }, { passive: false });
      document.body.append(button);
      return null;
    });
    await engine.observe!(operation());
    await fixtureOf(engine).evaluate(() => { document.querySelector<HTMLElement>('#pointer-target')!.style.left = '260px'; return null; });
    await disconnect(remote);

    const fixture = fixtureOf(engine);
    const point = await fixture.evaluate(() => {
      const bounds = document.querySelector('#pointer-target')!.getBoundingClientRect();
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    });
    expect(point.x).toBe(320);
    expect(reconnected).toBe(1);
    await fixture.mouse.move(point.x, point.y);
    await fixture.mouse.down();
    await fixture.mouse.up();
    await fixture.mouse.wheel(0, 25);
    await expect.poll(() => fixture.evaluate(() => document.body.dataset['wheel'] ?? null)).toBe('25');
    const clicks0 = await fixture.evaluate(() => document.body.dataset['clicks'] ?? null);
    recoveryEvidence.getStore()?.evidence.record({ kind: 'point-witness', ordinal: 0, count: /^[0-8]$/.test(clicks0 ?? '') ? Number(clicks0) : null });
    expect(clicks0).toBe('1');

    recoveryPhase('point-perform', 'body');
    await recoveryAssert(0, () => expect(recoverySelect(0, 'browser.pointer', () => engine.performAt!(point, { kind: 'tap' }, operation()))).rejects.toMatchObject({ code: 'NODE_STALE' }));
    await engine.observe!(operation());
    recoveryPhase('point-perform', 'body');
    await recoverySelect(1, 'browser.pointer', () => engine.performAt!(point, { kind: 'tap' }, operation()));
    const clicks1 = await fixture.evaluate(() => document.body.dataset['clicks'] ?? null);
    recoveryEvidence.getStore()?.evidence.record({ kind: 'point-witness', ordinal: 1, count: /^[0-8]$/.test(clicks1 ?? '') ? Number(clicks1) : null });
    recoveryAssert(1, () => expect(clicks1).toBe('2'));
  }));

  it('requires new evidence for focused engine keyboard input after recovery while direct test input remains available', async () => {
    const remote = await host();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint });
    await fixtureOf(engine).evaluate(() => {
      const field = document.createElement('input');
      field.id = 'keyboard-target';
      field.value = 'original';
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') document.body.dataset['enters'] = String(Number(document.body.dataset['enters'] ?? 0) + 1);
      });
      document.body.append(field);
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
      return null;
    });
    await engine.observe!(operation());
    await disconnect(remote);
    await expect(engine.keyboard!.type('replacement', { replace: true }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    await expect(engine.keyboard!.press('Enter', operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    const fixture = fixtureOf(engine);
    const value = () => fixture.evaluate(() => (document.querySelector('#keyboard-target') as HTMLInputElement).value);
    expect(await value()).toBe('original');
    expect(await fixture.evaluate(() => document.body.dataset['enters'] ?? '0')).toBe('0');
    await fixture.keyboard.type(' direct');
    await fixture.keyboard.press('Enter');
    expect(await value()).toBe('original direct');
    expect(await fixture.evaluate(() => document.body.dataset['enters'] ?? '0')).toBe('1');
    await expect(engine.keyboard!.press('Enter', operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    await engine.observe!(operation());
    await engine.keyboard!.type('replacement', { replace: true }, operation());
    await engine.keyboard!.press('Enter', operation());
    expect(await value()).toBe('replacement');
    expect(await fixture.evaluate(() => document.body.dataset['enters'] ?? '0')).toBe('2');
  });

  it('rejects an observation that finishes during recovery and still requires new evidence', recoveryCase('P13', async () => {
    const remote = await host();
    let resumePixels!: () => void;
    let pixelsStarted!: () => void;
    let pixelsFailed!: (cause: unknown) => void;
    let resolveEndpoint!: (endpoint: string) => void;
    let requested!: () => void;
    const pixelsPaused = new Promise<void>((resolve) => { resumePixels = resolve; });
    const pixelsReached = new Promise<void>((resolve, reject) => { pixelsStarted = resolve; pixelsFailed = reject; });
    const endpoint = new Promise<string>((resolve) => { resolveEndpoint = resolve; });
    const reconnectRequested = new Promise<void>((resolve) => { requested = resolve; });
    const engine = await start({
      cdpEndpoint: () => remote.endpoint,
      reconnectEndpoint: () => { requested(); return endpoint; },
    });
    const readBlob = EngineChannel.prototype.readBlob;
    const pixelSpy = vi.spyOn(EngineChannel.prototype, 'readBlob').mockImplementation(async function (this: EngineChannel, ...args) {
      const pixels = await readBlob.apply(this, args).catch((cause: unknown) => { pixelsFailed(cause); throw cause; });
      pixelsStarted();
      await pixelsPaused;
      return pixels;
    });
    try {
      recoveryPhase('observe');
      const oldObservation = engine.observe!(operation(), { pixels: true }).catch((cause: unknown) => cause);
      await pixelsReached;
      await disconnect(remote);
      recoveryPhase('locate');
      const recovery = engine.locate!(heading, operation());
      await reconnectRequested;
      resumePixels();
      expect(await oldObservation).toMatchObject({ code: 'NODE_STALE' });
      resolveEndpoint(remote.endpoint);
      await recovery;
      recoveryPhase('point-perform');
      await recoveryAssert(0, () => expect(recoverySelect(0, 'browser.pointer', () => engine.performAt!({ x: 20, y: 20 }, { kind: 'tap' }, operation()))).rejects.toMatchObject({ code: 'NODE_STALE' }));
      recoveryPhase('observe');
      await engine.observe!(operation());
      recoveryPhase('point-perform');
      await recoverySelect(1, 'browser.pointer', () => engine.performAt!({ x: 20, y: 20 }, { kind: 'tap' }, operation()));
    } catch (cause) {
      recoveryEvidence.getStore()?.failed('body', cause);
      throw cause;
    } finally {
      recoveryEvidence.getStore()?.passed('body');
      recoveryPhase('dispose', 'cleanup');
      resumePixels();
      resolveEndpoint(remote.endpoint);
      pixelSpy.mockRestore();
    }
  }));

  it('masks password fields in light and closed shadow DOM before and after reconnect', async () => {
    const remote = await host();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint });
    await fixtureOf(engine).evaluate(() => {
      document.body.innerHTML = '';
      document.body.style.background = 'blue';
      const field = document.createElement('input');
      field.type = 'password';
      field.value = 'private';
      field.style.cssText = 'position:fixed;left:20px;top:20px;width:180px;height:40px';
      document.body.append(field);
      const shadowHost = document.createElement('div');
      document.body.append(shadowHost);
      const root = shadowHost.attachShadow({ mode: 'closed' });
      const hiddenField = field.cloneNode(true) as HTMLInputElement;
      hiddenField.style.top = '80px';
      root.append(hiddenField);
      return null;
    });
    for (const reconnect of [false, true]) {
      if (reconnect) await disconnect(remote);
      const snapshot = await engine.observe!(operation(), { pixels: true });
      expect(snapshot.maskedRegionCount).toBe(2);
      expect(snapshot.pixels).toBeDefined();
      const image = decodePng(snapshot.pixels!.data);
      expect(image.pixelAt(40, 40)).toEqual([0, 0, 0, 255]);
      expect(image.pixelAt(40, 100)).toEqual([0, 0, 0, 255]);
      expect(image.pixelAt(300, 160)).toEqual([0, 0, 255, 255]);
    }
  });

  it('captures masked pixels from a borrowed background page without changing either tab focus or visibility', async () => {
    const remote = await host();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint });
    await fixtureOf(engine).evaluate(() => {
      document.body.style.background = 'blue';
      document.body.innerHTML = '<input id="private-field" type="password" value="private" style="position:fixed;left:20px;top:20px;width:180px;height:40px">';
      return null;
    });
    // Playwright otherwise emulates every attached page as focused and visible.
    // Disable that default before witness attaches, not from another CDP session.
    await hostControl(remote, { noDefaults: true });
    const original = await witness(engine, remote);
    const other = await original.page.context().newPage();
    try {
      await other.setContent(`<button id="host-button" onclick="this.textContent='usable'">other tab</button>`);
      await other.bringToFront(); // Host setup only, never capture restoration.
      const state = () => ({ visibility: document.visibilityState, focused: document.hasFocus(), active: document.activeElement?.tagName ?? null, activeId: document.activeElement?.id ?? null });
      const before = await Promise.all([original.page.evaluate(state), other.evaluate(state)]);
      expect(before[0]?.visibility).toBe('hidden');
      expect(before[1]?.visibility).toBe('visible');
      const snapshot = await engine.observe!(operation(), { pixels: true });
      expect(snapshot.pixels).toBeDefined();
      expect(snapshot.maskedRegionCount).toBe(1);
      const image = decodePng(snapshot.pixels!.data);
      expect(image.pixelAt(40, 40)).toEqual([0, 0, 0, 255]);
      expect(image.pixelAt(300, 160)).toEqual([0, 0, 255, 255]);
      expect(await Promise.all([original.page.evaluate(state), other.evaluate(state)])).toEqual(before);
      expect(await original.page.locator('#private-field').evaluate(node => getComputedStyle(node).opacity)).toBe('1');
      await other.getByRole('button', { name: 'other tab' }).click({ timeout: 2_000 });
      expect(await other.getByRole('button').textContent()).toBe('usable');
      expect(await fixtureOf(engine).evaluate(() => document.querySelector<HTMLInputElement>('#private-field')?.value ?? null)).toBe('private');
    } finally {
      await other.close();
    }
  });

  it('masks a new closed root after disconnected navigation without relying on a JavaScript tracking hook', async () => {
    const remote = await host();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint });
    const original = await witness(engine, remote);
    await disconnect(remote);
    await original.page.goto(`${app.url}/form`);
    await original.page.evaluate(() => {
      document.body.innerHTML = '';
      document.body.style.background = 'blue';
      const shadowHost = document.createElement('div');
      document.body.append(shadowHost);
      const root = shadowHost.attachShadow({ mode: 'closed' });
      root.innerHTML = '<input type="password" value="private" style="position:fixed;left:20px;top:20px;width:180px;height:40px">';
    });
    expect(await original.page.locator('body').count()).toBe(1);
    const snapshot = await engine.observe!(operation(), { pixels: true });
    expect(snapshot.location).toBe(`${app.url}/form`);
    expect(snapshot.maskedRegionCount).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(snapshot.root)).not.toContain('private');
    const image = decodePng(snapshot.pixels!.data);
    expect(image.pixelAt(40, 40)).toEqual([0, 0, 0, 255]);
    expect(image.pixelAt(300, 160)).toEqual([0, 0, 255, 255]);
  });

});
