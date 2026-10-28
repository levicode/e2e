/** Real native/PW fixture; this helper never replaces a browser or wire method. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EngineCleanupContext, EngineFixtureContext, Expectable, OperationContext } from 'e2e/engine';
import { web, surfaceOf, type Browser, type PlaywrightLiveSurface } from '../../src/index.ts';
import { launchRemoteChrome, closeRemoteChrome, type RemoteChrome } from './cdp-host.ts';
import { ignoreTrace, noSecrets } from './secrets.ts';

/** Bounds a test-owned wait without pretending that timeout cancels its work. */
export async function dialogBounded<T>(work: Promise<T>, label: string, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its test-only bound`)), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** A release gate whose caller retains and releases every pending wait. */
export function dialogGate<T = void>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Inspect the pinned real PW EventEmitter's public methods, never its fields.
 * PW's generated interfaces omit EventEmitter inventory methods. */
export function dialogListeners(target: object): readonly unknown[] {
  return (target as { listeners: (event: string) => readonly unknown[] }).listeners('dialog');
}

export interface NativeDialogFixture {
  readonly engine: ReturnType<typeof web>;
  readonly browser: Browser;
  readonly live: PlaywrightLiveSurface;
  readonly url: string;
  readonly operation: () => OperationContext;
  readonly facts: Record<string, boolean | number | string | null>;
}

/** Keep only known error codes; never persist an exception message or payload. */
function failureCode(cause: unknown): string {
  if (cause === null || typeof cause !== 'object') return 'OTHER';
  const code = 'code' in cause ? cause.code : undefined;
  if (typeof code === 'string' && ['ASSERTION_FAILED', 'INVALID_STATE', 'ENGINE_FAILURE', 'ACTION_FAILED', 'OPERATION_TIMEOUT', 'CANCELLED'].includes(code)) return code;
  return code === 'ERR_ASSERTION' || ('name' in cause && cause.name === 'AssertionError') ? 'TEST_ASSERTION' : 'OTHER';
}

/** Owns real resources through final retirement, retaining closed evidence on failure. */
export async function withNativeDialogFixture(
  name: string,
  kind: 'isolated' | 'persistent',
  run: (fixture: NativeDialogFixture) => Promise<void>,
): Promise<void> {
  const lifetime = new AbortController();
  const deadline = performance.now() + 45000;
  const expiry = setTimeout(() => lifetime.abort(), 45000);
  const operation = (): OperationContext => ({ runId: `dialog-${name}`, attemptId: 'one', origin: 'test', signal: lifetime.signal, timeoutMs: Math.max(1, deadline - performance.now()) });
  const cleanup = (): EngineCleanupContext => ({ signal: new AbortController().signal, timeoutMs: 30000 });
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'native-dialog-guard-'));
  const facts: NativeDialogFixture['facts'] = { schemaVersion: 1, name, runtime: 'not-run', cleanup: 'not-run' };
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(request.url === '/popup'
      ? '<!doctype html><title>Popup</title><script>globalThis.answer = prompt("popup prompt", "initial")</script><h1>Popup ready</h1>'
      : '<!doctype html><title>Dialog fixture</title><h1>Dialog fixture</h1>');
  });
  let remote: RemoteChrome | undefined;
  const engine = web(kind === 'persistent' ? { connect: {
    cdpEndpoint: () => { if (remote === undefined) throw new Error('host not ready'); return remote.endpoint; },
    reconnectEndpoint: () => { if (remote === undefined) throw new Error('host not ready'); return remote.endpoint; },
  } } : {});
  let failure: unknown;
  let work: Promise<void> | undefined;
  try {
    work = (async () => {
      if (kind === 'persistent') remote = await launchRemoteChrome();
      server.listen({ host: '127.0.0.1', port: 0, signal: lifetime.signal });
      await dialogBounded(once(server, 'listening'), 'fixture listen');
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('missing fixture address');
      const url = `http://127.0.0.1:${address.port}/`;
      await engine.init!({ runId: `dialog-${name}`, targetName: 'web', projectRoot: process.cwd(), app: { site: '127.0.0.1' }, env: process.env, headed: false, workerSlot: 0, signal: lifetime.signal, log: () => undefined });
      await engine.startAttempt!({ attemptId: 'one', artifactsDir, signal: lifetime.signal, resolveSecret: noSecrets, ...ignoreTrace });
      const context: EngineFixtureContext = {
        targetName: 'web',
        app: { site: '127.0.0.1', resolveUrl: relative => new URL(relative, url).href },
        timeouts: { test: 45000, action: 10000, assertion: 5000 },
        signal: lifetime.signal,
        operation: timeoutMs => { const current = operation(); return timeoutMs === undefined ? current : { ...current, timeoutMs: Math.min(current.timeoutMs, timeoutMs) }; },
        fixture: (_name, value) => value,
        expectable: <T extends object, E extends object>(value: T, _factory: () => E): T & Expectable<E> => value as T & Expectable<E>,
        attachArtifact: () => undefined,
        attachViewport: () => undefined,
        locator: () => { throw new Error('This gate does not mint harness locators'); },
        screen: () => { throw new Error('This gate does not mint harness screens'); },
      };
      const browser = engine.fixtures!['browser']!(context) as Browser;
      await run({ engine, browser, live: surfaceOf(engine)!, url, operation, facts });
    })();
    await dialogBounded(work, 'real dialog ownership gate', 45000);
    facts['runtime'] = 'passed';
  } catch (cause) { failure = cause; facts['runtime'] = 'failed'; facts['primaryFailureSource'] = 'runtime'; facts['primaryFailureCode'] = failureCode(cause); }
  finally {
    clearTimeout(expiry); lifetime.abort();
    try {
      await dialogBounded(engine.dispose!(cleanup()), 'native/PW retirement', 30000);
      if (work !== undefined) await dialogBounded(work.catch(() => undefined), 'retired gate settlement', 1000);
      facts['cleanup'] = 'passed';
    } catch (cause) { failure ??= cause; facts['cleanup'] = 'failed'; facts['primaryFailureSource'] ??= 'retirement'; facts['primaryFailureCode'] ??= failureCode(cause); }
    try {
      if (remote !== undefined) {
        facts['borrowedHostSurvived'] = remote.proc.exitCode === null && remote.proc.signalCode === null;
        await dialogBounded(closeRemoteChrome(remote), 'owned fixture host reap', 10000);
        facts['testHostReaped'] = remote.proc.exitCode !== null || remote.proc.signalCode !== null;
        assert.equal(facts['borrowedHostSurvived'], true, 'Engine retirement killed the borrowed host');
        assert.equal(facts['testHostReaped'], true, 'Owned fixture host was not reaped');
      }
    } catch (cause) { failure ??= cause; facts['cleanup'] = 'failed'; facts['primaryFailureSource'] ??= 'host-cleanup'; facts['primaryFailureCode'] ??= failureCode(cause); }
    try {
      server.closeAllConnections();
      if (server.listening) await dialogBounded(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 'fixture close', 2000);
      facts['serverClosed'] = !server.listening;
      assert.equal(facts['serverClosed'], true, 'Fixture server remained listening');
    } catch (cause) { failure ??= cause; facts['serverClosed'] = false; facts['primaryFailureSource'] ??= 'server-cleanup'; facts['primaryFailureCode'] ??= failureCode(cause); }
    const output = process.env['E2E_INTEROP_EVIDENCE_DIR'];
    if (output !== undefined) { mkdirSync(output, { recursive: true }); writeFileSync(path.join(output, `dialog-guard-${name}.json`), JSON.stringify(facts, null, 2)); }
    if (facts['cleanup'] === 'passed' && facts['serverClosed'] === true) rmSync(artifactsDir, { recursive: true, force: true });
  }
  if (failure !== undefined) throw failure;
}
