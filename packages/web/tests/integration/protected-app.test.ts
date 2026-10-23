/**
 * Reaching an app behind a gate: configured request headers reach the app's
 * site on every context the attempt opens, and never another site; basic-auth
 * credentials answer a challenge wherever one is issued. Driven through the engine hooks, as the attempt executor drives them; a
 * second fixture instance reached as `localhost` rather than `127.0.0.1`
 * stands in for a third-party site.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { secrets } from 'e2e';
import type { EngineAttemptContext, EngineCleanupContext, EngineFixtureContext, EngineHandle, OperationContext, Secret } from 'e2e/engine';
import { web, type Browser } from '../../src/index.ts';
import { PROTECTED_CREDENTIAL, startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
import { NativeClient } from '../../src/native/client.ts';
import { SyntheticNativeObserver } from '../helpers/synthetic-native-outcomes.ts';
import { beginSyntheticCase, serviceWorkerPromiseFact, type SyntheticOutcome } from '../helpers/synthetic-evidence.ts';

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(attemptId: string): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-protected', attemptId, origin: 'test' };
}

async function boot(
  engine: EngineHandle,
  app: FixtureApp,
  artifactsDir: string,
  attemptId: string,
  resolveSecret: (secret: Secret) => Promise<string> = noSecrets,
  appLog?: EngineAttemptContext['appLog'],
): Promise<void> {
  await engine.init!({
    runId: 'run-protected',
    targetName: 'web',
    projectRoot: process.cwd(),
    app: { site: new URL(app.url).hostname },
    env: process.env,
    headed: false,
    workerSlot: 0,
    log: () => undefined,
    signal: new AbortController().signal,
  });
  await engine.startAttempt!({ attemptId, artifactsDir, signal: new AbortController().signal, resolveSecret, ...ignoreTrace, ...(appLog === undefined ? {} : { appLog }) });
}

async function shutdown(engine: EngineHandle): Promise<void> {
  await engine.endAttempt!(cleanup());
  await engine.dispose!(cleanup());
}

const fixtures = new WeakMap<EngineHandle, { attemptId: string; browser: Browser }>();

/** Build the public browser fixture for the current attempt without a backend handle. */
function fixtureOf(engine: EngineHandle, app: FixtureApp, attemptId: string): Browser {
  const existing = fixtures.get(engine);
  if (existing?.attemptId === attemptId) return existing.browser;
  const browser = engine.fixtures!['browser']!({
    operation: () => operation(attemptId),
    app: { resolveUrl: (url: string) => new URL(url, app.url).href },
    expectable: (target: object) => target,
    fixture: (_name: string, target: object) => target,
  } as unknown as EngineFixtureContext) as Browser;
  fixtures.set(engine, { attemptId, browser });
  return browser;
}

/** Navigates and reads the page's one heading. */
async function headingAt(engine: EngineHandle, attemptId: string, url: string): Promise<string> {
  await engine.session!.open!(url, operation(attemptId));
  const nodes = await engine.locate!(
    { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } },
    operation(attemptId),
  );
  return nodes[0]?.name ?? '';
}

describe('web({ headers, basicAuth })', () => {
  let app: FixtureApp;
  let other: FixtureApp;
  let artifactsDir: string;

  beforeAll(async () => {
    [app, other] = await Promise.all([startFixtureApp(), startFixtureApp()]);
    // The same loopback server under another host name: `localhost` is a
    // site of its own, `127.0.0.1` another.
    other = { ...other, url: other.url.replace('127.0.0.1', 'localhost') };
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-protected-'));
  });

  afterAll(async () => {
    await Promise.all([app.close(), other.close()]);
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('sends the headers to the app\'s site only, on every context of the attempt', async () => {
    const engine = web({ headers: { 'X-Fixture-Header': 'let-me-in' } });
    try {
      await boot(engine, app, artifactsDir, 'h1');
      expect(await headingAt(engine, 'h1', `${app.url}/headers`)).toBe('let-me-in');
      // A third-party site gets the request without them.
      expect(await headingAt(engine, 'h1', `${other.url}/headers`)).toBe('none');
      // A state reset replaces the context; the headers come along.
      await engine.session!.reset!(operation('h1'));
      expect(await headingAt(engine, 'h1', `${app.url}/headers`)).toBe('let-me-in');
    } finally {
      await shutdown(engine);
    }
  });

  it('keeps the headers on a request an attempt route lets through', async () => {
    const engine = web({ headers: { 'x-fixture-header': 'through-the-route' } });
    try {
      await boot(engine, app, artifactsDir, 'h2');
      let routed = 0;
      // The public route still has to preserve the configured request policy.
      await fixtureOf(engine, app, 'h2').route('**/headers', async (route) => {
        routed += 1;
        await route.fallback();
      });
      expect(await headingAt(engine, 'h2', `${app.url}/headers`)).toBe('through-the-route');
      expect(routed).toBe(1);
    } finally {
      await shutdown(engine);
    }
  });

  it('blocks service workers under headers, since routing never sees a worker\'s requests', async () => {
    // Registers the fixture's worker and counts what the browser now holds:
    // the caught registration settles even when blocked; only the count proves registration.
    const registrations = async (): Promise<number> => {
      const registration = navigator.serviceWorker.register('/sw.js').catch(() => undefined);
      console.info('P41:service-worker:register-invoked');
      await registration;
      console.info('P41:service-worker:register-settled');
      const registrationsPromise = navigator.serviceWorker.getRegistrations();
      console.info('P41:service-worker:get-invoked');
      const registered = await registrationsPromise;
      console.info('P41:service-worker:get-settled');
      return registered.length;
    };
    const evidence = beginSyntheticCase('P41');
    const outcome: SyntheticOutcome = { setup: 'passed', body: 'incomplete', cleanup: 'not-started' };
    let branch: 'plain' | 'headers-blocked' = 'plain';
    let phase: 'boot' | 'navigate' | 'register-count' | 'shutdown-end' | 'shutdown-dispose' = 'boot';
    const observer = new SyntheticNativeObserver(evidence, () => phase === 'boot' ? 'start' : phase === 'register-count' ? 'registrations' : phase === 'shutdown-end' ? 'end' : phase === 'shutdown-dispose' ? 'dispose' : 'navigate');
    let restore = () => {};
    try {
      const connect = NativeClient.connect;
      const connection = vi.spyOn(NativeClient, 'connect').mockImplementation((...args) => observer.connection(connect(...args)));
      restore = () => connection.mockRestore();
    } catch { evidence.invalidate(); }
    /** These are source-configured branches, not observations of an internal worker rule. */
    const record = (state: 'enter' | 'passed' | 'failed', registeredCount: number | null = null): void =>
      evidence.record({ kind: 'service-worker', branch, phase, state, headersConfigured: branch === 'headers-blocked', registeredCount });
    /** Capture the configured branch, never raw console text or its projected location. */
    const promiseLog = (sourceBranch: 'plain' | 'headers-blocked'): EngineAttemptContext['appLog'] => entry => {
      try {
        const fact = serviceWorkerPromiseFact(sourceBranch, entry);
        if (fact !== null) evidence.record(fact);
      } catch { evidence.invalidate(); }
    };
    try {
      const plain = web();
      try {
        record('enter'); await boot(plain, app, artifactsDir, 's0', undefined, promiseLog('plain')); record('passed');
        phase = 'navigate'; record('enter'); await headingAt(plain, 's0', `${app.url}/`); record('passed');
        // The fixture itself can register one: 127.0.0.1 is a secure context.
        phase = 'register-count'; record('enter');
        const count = await observer.select(0, 'page.evaluate', () => fixtureOf(plain, app, 's0').evaluate(registrations)); record('passed', count);
        observer.assert(0, () => expect(count).toBe(1));
      } catch (cause) { observer.failure('body', cause); outcome.body = 'failed'; record('failed'); throw cause; }
      finally {
        outcome.cleanup = 'incomplete';
        try {
          phase = 'shutdown-end'; record('enter'); await plain.endAttempt!(cleanup()); record('passed');
          phase = 'shutdown-dispose'; record('enter'); await plain.dispose!(cleanup()); record('passed');
          outcome.cleanup = 'passed';
        // eslint-disable-next-line no-unsafe-finally -- Preserve the original cleanup exception precedence.
        } catch (cause) { observer.failure('cleanup', cause); outcome.cleanup = 'failed'; record('failed'); throw cause; }
      }
      branch = 'headers-blocked'; phase = 'boot';
      const engine = web({ headers: { 'x-fixture-header': 'no-workers' } });
      try {
        record('enter'); await boot(engine, app, artifactsDir, 's1', undefined, promiseLog('headers-blocked')); record('passed');
        phase = 'navigate'; record('enter'); await headingAt(engine, 's1', `${app.url}/`); record('passed');
        phase = 'register-count'; record('enter');
        const count = await fixtureOf(engine, app, 's1').evaluate(registrations); record('passed', count);
        expect(count).toBe(0);
        outcome.body = 'passed';
      } catch (cause) { observer.failure('body', cause); outcome.body = 'failed'; record('failed'); throw cause; }
      finally {
        outcome.cleanup = 'incomplete';
        try {
          phase = 'shutdown-end'; record('enter'); await engine.endAttempt!(cleanup()); record('passed');
          phase = 'shutdown-dispose'; record('enter'); await engine.dispose!(cleanup()); record('passed');
          outcome.cleanup = 'passed';
        // eslint-disable-next-line no-unsafe-finally -- Preserve the original cleanup exception precedence.
        } catch (cause) { observer.failure('cleanup', cause); outcome.cleanup = 'failed'; record('failed'); throw cause; }
      }
    } finally { observer.close(); try { restore(); } catch { evidence.invalidate(); } evidence.finish(outcome); }
  });

  it('answers a basic-auth challenge wherever one is issued', async () => {
    const unauthenticated = web();
    try {
      await boot(unauthenticated, app, artifactsDir, 'b0');
      expect(await headingAt(unauthenticated, 'b0', `${app.url}/protected`)).toBe('Unauthorized');
    } finally {
      await shutdown(unauthenticated);
    }
    const engine = web({ basicAuth: PROTECTED_CREDENTIAL });
    try {
      await boot(engine, app, artifactsDir, 'b1');
      expect(await headingAt(engine, 'b1', `${app.url}/protected`)).toBe('Protected');
      expect(await headingAt(engine, 'b1', `${other.url}/protected`)).toBe('Protected');
    } finally {
      await shutdown(engine);
    }
  });

  it('answers the challenge with a secrets.get() password the attempt resolves', async () => {
    const asked: string[] = [];
    const engine = web({ basicAuth: { username: PROTECTED_CREDENTIAL.username, password: secrets.get('previewPassword') } });
    try {
      await boot(engine, app, artifactsDir, 's1', async (secret) => {
        asked.push(secret.name);
        return PROTECTED_CREDENTIAL.password;
      });
      expect(await headingAt(engine, 's1', `${app.url}/protected`)).toBe('Protected');
      expect(asked).toEqual(['previewPassword']);
    } finally {
      await shutdown(engine);
    }
  });

  it('reports the configured user agent to the page, after a context reset too', async () => {
    const engine = web({ userAgent: 'Mozilla/5.0 e2e-probe playwright' });
    try {
      await boot(engine, app, artifactsDir, 'u0');
      await engine.session!.open!(app.url, operation('u0'));
      const browser = fixtureOf(engine, app, 'u0');
      expect(await browser.evaluate(() => navigator.userAgent)).toBe('Mozilla/5.0 e2e-probe playwright');
      await engine.session!.reset!(operation('u0'));
      await engine.session!.open!(app.url, operation('u0'));
      expect(await browser.evaluate(() => navigator.userAgent)).toBe('Mozilla/5.0 e2e-probe playwright');
    } finally {
      await shutdown(engine);
    }
  });

  it('runs the page in the configured locale and time zone, after a context reset too', async () => {
    const engine = web({ locale: 'de-DE', timezoneId: 'Asia/Tokyo' });
    const read = () =>
      fixtureOf(engine, app, 'l0').evaluate(() => ({
        language: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offset: new Date('2026-01-01T00:00:00Z').getTimezoneOffset(),
      }));
    const expected = { language: 'de-DE', timeZone: 'Asia/Tokyo', offset: -540 };
    try {
      await boot(engine, app, artifactsDir, 'l0');
      await engine.session!.open!(app.url, operation('l0'));
      expect(await read()).toEqual(expected);
      await engine.session!.reset!(operation('l0'));
      await engine.session!.open!(app.url, operation('l0'));
      expect(await read()).toEqual(expected);
    } finally {
      await shutdown(engine);
    }
  });
});
