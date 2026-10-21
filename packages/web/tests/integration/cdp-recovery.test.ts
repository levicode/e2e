/** Real CDP transport drops preserve only the dedicated persistent context, never a replacement. */

import { randomUUID } from 'node:crypto';
import { connect as connectSocket, createServer, type AddressInfo, type Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser as HostBrowser } from 'playwright-core';
import type { EngineHandle, OperationContext } from 'e2e/engine';
import { web as webEngine, type WebConnectOptions, type WebOptions, type Browser } from '../../src/index.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { decodePng } from '../helpers/png.ts';
import { NativeClient } from '../../src/native/client.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { nativeBrowser } from '../helpers/native-browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

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
  const hostControls = new Map<RecoveryHost, HostBrowser>();
  const fixtures = new Map<EngineHandle, { browser: Browser; timeoutMs: number }>();
  let disconnectEvents = 0;

  beforeEach(() => {
    disconnectEvents = 0;
    const connect = NativeClient.connect;
    vi.spyOn(NativeClient, 'connect').mockImplementation((channel, capabilities, context, onEvent) =>
      connect(channel, capabilities, context, async event => {
        await onEvent(event);
        if (event.event === 'scope.disconnected') disconnectEvents += 1;
      }),
    );
  });

  /** Wait for the adapter to consume the real disconnection, not an arbitrary delay. */
  async function disconnect(remote: RecoveryHost): Promise<void> {
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

  afterEach(async () => {
    const failures: unknown[] = [];
    const settle = async (work: readonly Promise<unknown>[]) => {
      for (const result of await Promise.allSettled(work)) if (result.status === 'rejected') failures.push(result.reason);
    };
    await settle([...activeEngines].map(engine => engine.dispose!(cleanup())));
    await settle([...hostControls.values()].map(control => control.close()));
    await settle([...activeHosts].flatMap(remote => [remote.closeRelay(), closeRemoteChrome(remote)]));
    activeEngines.clear(); activeHosts.clear(); hostControls.clear(); fixtures.clear();
    vi.restoreAllMocks();
    if (failures.length > 0) throw new AggregateError(failures, 'Recovery fixture cleanup failed');
  });

  /** Registers the host before attempt setup, so a failed setup cannot leak Chrome. */
  async function host(): Promise<RecoveryHost> {
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
  async function hostControl(remote: RecoveryHost): Promise<HostBrowser> {
    const existing = hostControls.get(remote);
    if (existing !== undefined) return existing;
    const control = await chromium.connectOverCDP(remote.directEndpoint);
    hostControls.set(remote, control);
    return control;
  }

  /** Resolve the actual active target through a unique page marker, not a matching URL. */
  async function witness(engine: EngineHandle, remote: RecoveryHost) {
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

  /** Starts the engine's attempt against a host-provisioned browser. */
  async function start(connect: WebConnectOptions, options: Omit<WebOptions, 'connect'> = {}, open = true): Promise<EngineHandle> {
    const engine = webEngine({ ...options, connect });
    activeEngines.add(engine);
    await engine.init!({
      runId: 'run-recovery', targetName: 'web', projectRoot: process.cwd(),
      app: { site: new URL(app.url).hostname }, env: process.env, headed: false,
      workerSlot: 0, signal: new AbortController().signal, log: () => undefined,
    });
    await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    if (open) await engine.session!.open!(`${app.url}/login`, operation());
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

  it('dismisses an unhandled activated beforeunload on first open instead of silently accepting it', async () => {
    const remote = await host(); const page = await activatedHost(remote); const url = page.url();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint }, {}, false);
    expect(page.url()).toBe(url);
    await expect(engine.session!.open!(`${app.url}/login`, operation())).rejects.toBeDefined();
    expect(page.url()).toBe(url);
    expect(await page.locator('#activate-beforeunload').count()).toBe(1);
  });

  it('keeps the exact page, document state, storage, viewport, routes, and dialog handlers', async () => {
    const remote = await host();
    let provisioned = 0;
    let reconnected = 0;
    const engine = await start({
      cdpEndpoint: () => { provisioned += 1; return remote.endpoint; },
      reconnectEndpoint: () => { reconnected += 1; return remote.endpoint; },
    });
    try {
      const fixture = fixtureOf(engine);
      const original = await witness(engine, remote);
      await fixture.setViewport({ width: 800, height: 600 });
      await fixture.evaluate(() => {
        sessionStorage.setItem('attempt', 'kept');
        localStorage.setItem('login', 'kept');
        document.cookie = 'session=kept';
        (document.querySelector('input[name=user]') as HTMLInputElement).value = 'unsaved';
        return null;
      });
      const stale = (await engine.locate!(heading, operation()))[0]!;
      const observation = await engine.observe!(operation());
      // Another tab at the same URL makes URL-based selection ambiguous.
      const other = await original.page.context().newPage();
      await other.goto(await fixture.url());
      await other.locator('h1').evaluate((node) => { node.textContent = 'Wrong tab'; });

      await fixture.route('**/kept-route', (route) => route.fulfill({ body: 'route kept' }));
      await fixture.onDialog('accept');
      await disconnect(remote);

      expect((await engine.locate!(heading, operation()))[0]?.name).toBe('Login');
      expect(await fixture.evaluate(() => (window as unknown as { recoveryWitness: string }).recoveryWitness)).toBe(original.marker);
      const session = await original.page.context().newCDPSession(original.page);
      expect((await session.send('Target.getTargetInfo')).targetInfo.targetId).toBe(original.targetId);
      await session.detach();
      expect(await fixture.evaluate(() => (document.querySelector('input[name=user]') as HTMLInputElement).value)).toBe('unsaved');
      expect(await fixture.evaluate(() => [sessionStorage.getItem('attempt'), localStorage.getItem('login'), document.cookie]))
        .toEqual(['kept', 'kept', 'session=kept']);
      expect(await fixture.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 800, height: 600 });
      expect(await fixture.evaluate(async () => (await fetch('/kept-route')).text())).toBe('route kept');
      expect(await fixture.evaluate(() => confirm('Handler survived?'))).toBe(true);
      await expect(engine.perform!(stale.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      expect(observation.viewportRef).toBeDefined();
      await expect(engine.perform!(observation.viewportRef!, { kind: 'swipe', direction: 'down' }, operation()))
        .rejects.toMatchObject({ code: 'NODE_STALE' });
      await expect(engine.performAt!({ x: 1, y: 1 }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      await engine.observe!(operation());
      await engine.performAt!({ x: 1, y: 1 }, { kind: 'tap' }, operation());
      expect(provisioned).toBe(1);
      expect(reconnected).toBe(1);
    } finally {
      await engine.dispose!(cleanup());
      await expect(fixtureOf(engine).url()).rejects.toMatchObject({ code: 'CANCELLED' });
      await expect.poll(() => remote.connections()).toBe(0);
      expect(remote.proc.exitCode).toBeNull();
      expect(remote.proc.signalCode).toBeNull();
      await closeRemoteChrome(remote);
    }
  }, 60_000);

  it('emulates the configured and requested media on the persistent page, after reconnect too', async () => {
    const remote = await host();
    const engine = await start(
      { cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint },
      { colorScheme: 'dark' },
    );
    const media = () => fixtureOf(engine).evaluate(() => ({
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
    }));
    try {
      await fixtureOf(engine).emulateMedia({ reducedMotion: 'reduce' });
      expect(await media()).toEqual({ dark: true, reduce: true });
      const fixture = fixtureOf(engine);
      await fixture.evaluate(() => {
        (window as unknown as { recoveryPopup: Window | null }).recoveryPopup = window.open('/');
        return null;
      });
      await expect.poll(() => fixture.evaluate(() => {
        const popup = (window as unknown as { recoveryPopup: Window | null }).recoveryPopup;
        return popup !== null && popup.location.pathname === '/' && popup.document.readyState === 'complete';
      })).toBe(true);
      const popupReduced = () => fixture.evaluate(() => (window as unknown as { recoveryPopup: Window }).recoveryPopup.matchMedia('(prefers-reduced-motion: reduce)').matches);
      expect(await popupReduced()).toBe(true);
      await disconnect(remote);
      expect((await engine.locate!(heading, operation()))[0]?.name).toBe('Login');
      expect(await media()).toEqual({ dark: true, reduce: true });
      // The actual popup Window survives, not another page chosen by URL.
      expect(await fixture.evaluate(() => (window as unknown as { recoveryPopup: Window }).recoveryPopup.closed)).toBe(false);
      expect(await popupReduced()).toBe(true);
    } finally {
      await engine.dispose!(cleanup());
      await closeRemoteChrome(remote);
    }
  }, 60_000);

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

  it('fails an uncertain click without reconnecting or dispatching it twice', async () => {
    const remote = await host();
    let reconnected = 0;
    const engine = await start({
      cdpEndpoint: () => remote.endpoint,
      reconnectEndpoint: () => { reconnected += 1; return remote.endpoint; },
    });
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
          void disconnect(remote).then(() => debuggerSession.send('Debugger.resume')).then(() => resolve(), reject);
        });
      });
      const [button] = await engine.locate!({ kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'Purchase', exact: true } } }, operation());
      await expect(engine.perform!(button!.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ retryable: false });
      await transportDropped;
      expect(reconnected).toBe(0);
      await engine.observe!(operation());
      expect(await fixtureOf(engine).evaluate(() => sessionStorage.getItem('clicks'))).toBe('1');
      expect(reconnected).toBe(1);
    } finally {
      await engine.dispose!(cleanup());
      await closeRemoteChrome(remote);
    }
  }, 60_000);

  it('rejects a different browser and never falls back to the provisioning resolver', async () => {
    const remote = await host();
    const replacement = await host();
    let provisioned = 0;
    const engine = await start({
      cdpEndpoint: () => { provisioned += 1; return remote.endpoint; },
      reconnectEndpoint: () => replacement.endpoint,
    });
    try {
      await disconnect(remote);
      await expect(engine.observe!(operation())).rejects.toThrow(/different browser/);
      await expect(engine.observe!(operation())).rejects.toThrow(/different browser/);
      expect(provisioned).toBe(1);
      expect(replacement.proc.exitCode).toBeNull();
    } finally {
      await engine.dispose!(cleanup());
      await closeRemoteChrome(remote);
      await closeRemoteChrome(replacement);
    }
  }, 60_000);

  it('rejects a missing active target even when another tab has the same URL', async () => {
    const remote = await host();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint });
    try {
      const original = await witness(engine, remote);
      const other = await original.page.context().newPage();
      await other.goto(await fixtureOf(engine).url());
      await original.page.close();
      await disconnect(remote);
      await expect(engine.observe!(operation())).rejects.toThrow(/original page no longer exists/);
    } finally {
      await engine.dispose!(cleanup());
      await closeRemoteChrome(remote);
    }
  }, 60_000);

  it('bounds a hung reconnect resolver and propagates cancellation to it', async () => {
    const remote = await host();
    let signal: AbortSignal | undefined;
    const engine = await start({
      cdpEndpoint: () => remote.endpoint,
      reconnectEndpoint: (abort) => { signal = abort; return new Promise<string>(() => undefined); },
    });
    try {
      await disconnect(remote);
      await expect(engine.observe!(operation(50))).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
      expect(signal?.aborted).toBe(true);
    } finally {
      await engine.dispose!(cleanup());
      await closeRemoteChrome(remote);
    }
  }, 60_000);

  it('provisions a fresh browser for each attempt and refuses accidental reuse', async () => {
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
      await engine.endAttempt!(cleanup());
      fixtures.delete(engine);
      await engine.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
      await engine.session!.open!(`${app.url}/login`, operation());
      expect(await fixtureOf(engine).evaluate(() => localStorage.getItem('attempt'))).toBeNull();
      expect(provisioned).toBe(2);
      await engine.endAttempt!(cleanup());
      reuse = true;
      await expect(engine.startAttempt!({ attemptId: 'a3', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace }))
        .rejects.toThrow(/reused a browser/);
    } finally {
      await engine.dispose!(cleanup());
      await Promise.all(hosts.map(closeRemoteChrome));
    }
  }, 60_000);

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

  it('counts reconnect time against the operation budget', async () => {
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
    await expect(fixtureOf(engine, 1_000).evaluate(async () => {
      document.body.dataset['started'] = 'true';
      await new Promise((resolve) => setTimeout(resolve, 800));
      return 'too late';
    })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(await original.page.getAttribute('body', 'data-started')).toBe('true');
  });

  it('resumes video recording on the recovered page', async () => {
    const remote = await host();
    const engine = await start({ cdpEndpoint: () => remote.endpoint, reconnectEndpoint: () => remote.endpoint });
    await engine.artifacts!.startVideo!(operation());
    await engine.artifacts!.screenshot('before-reconnect', operation());
    await disconnect(remote);
    await engine.observe!(operation());
    await fixtureOf(engine).evaluate(() => { document.body.style.background = 'blue'; return null; });
    await engine.artifacts!.screenshot('after-reconnect', operation());
    // The first segment may be lost during disconnect; the new segment must finalize.
    await engine.artifacts!.stopVideo!(operation()).catch((cause: unknown) => {
      expect(cause).toMatchObject({ code: 'ENGINE_FAILURE' });
    });
    const video = path.join(artifactsDir, 'video/video-part2.webm');
    expect(existsSync(video)).toBe(true);
    expect(statSync(video).size).toBeGreaterThan(0);
  }, 60_000);

  it('recovers before arming a download waiter and runs its trigger once', async () => {
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
    const download = await fixtureOf(engine).waitForDownload(async () => {
      triggered += 1;
      const [link] = await engine.locate!({ kind: 'selector', selector: '#download' }, operation());
      await engine.perform!(link!.ref, { kind: 'tap' }, operation());
    });
    expect(triggered).toBe(1);
    expect(readFileSync(path.join(artifactsDir, download.path), 'utf8')).toBe('download kept');
    const failure = new Error('test trigger failed');
    await expect(fixtureOf(engine).waitForDownload(async () => { throw failure; })).rejects.toBe(failure);
  });

  it('allows direct test-code mouse input using current geometry while observation-derived taps stay stale', async () => {
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
    expect(await fixture.evaluate(() => document.body.dataset['clicks'] ?? null)).toBe('1');

    await expect(engine.performAt!(point, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    await engine.observe!(operation());
    await engine.performAt!(point, { kind: 'tap' }, operation());
    expect(await fixture.evaluate(() => document.body.dataset['clicks'] ?? null)).toBe('2');
  });

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

  it('rejects an observation that finishes during recovery and still requires new evidence', async () => {
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
      const oldObservation = engine.observe!(operation(), { pixels: true }).catch((cause: unknown) => cause);
      await pixelsReached;
      await disconnect(remote);
      const recovery = engine.locate!(heading, operation());
      await reconnectRequested;
      resumePixels();
      expect(await oldObservation).toMatchObject({ code: 'NODE_STALE' });
      resolveEndpoint(remote.endpoint);
      await recovery;
      await expect(engine.performAt!({ x: 20, y: 20 }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      await engine.observe!(operation());
      await engine.performAt!({ x: 20, y: 20 }, { kind: 'tap' }, operation());
    } finally {
      resumePixels();
      resolveEndpoint(remote.endpoint);
      pixelSpy.mockRestore();
    }
  });

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
