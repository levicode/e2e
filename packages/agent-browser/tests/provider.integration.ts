/** Real local Chromium behind the structural hosted-browser SPI; no hosted account or credentials are used. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openHost, type E2EHost, type E2ESession } from 'e2e/runner';
import type { EngineFixtureContext, EngineHandle, OperationContext } from 'e2e/engine';
import { agentBrowser, type Browser, type BrowserProvider, type BrowserLease } from '../dist/index.js';
import { CdpConnection } from '../src/cdp.ts';
import { launchChromium, type OwnedBrowser } from '../src/launch.ts';

type ServiceBrowser = { lease: BrowserLease; owned: OwnedBrowser; observer: CdpConnection; targetId: string; sessionId: string; released: boolean };
function operation(signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs: 30_000, runId: 'provider-integration', attemptId: 'fixture', origin: 'test' };
}
function translatedEngineError(error: unknown, publicCode: string, engineCode: string): boolean {
  assert.ok(error instanceof Error && 'code' in error && error.code === publicCode);
  assert.ok('retryable' in error && error.retryable === false);
  assert.ok(error.cause instanceof Error && 'code' in error.cause && error.cause.code === engineCode);
  assert.ok('retryable' in error.cause && error.cause.retryable === false);
  return true;
}
async function evaluate<T>(record: ServiceBrowser, expression: string): Promise<T> {
  const result = await record.observer.send<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, operation(), record.sessionId);
  assert.equal(result.exceptionDetails, undefined);
  return result.result.value;
}
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'The expected real-browser state did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function contexts(record: ServiceBrowser): Promise<string[]> {
  return (await record.observer.send<{ browserContextIds: string[] }>('Target.getBrowserContexts', {}, operation())).browserContextIds;
}
/** Seeds the default context before leasing, as a provider prepare hook may do. */
function service(origin: string): { provider: BrowserProvider; records: ServiceBrowser[]; releaseErrors: string[] } {
  const records: ServiceBrowser[] = [];
  const releaseErrors: string[] = [];
  const provider: BrowserProvider = {
    name: 'local-chromium-service-fixture', scope: 'attempt',
    async acquire(request) {
      const owned = await launchChromium({
        executable: request.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', env: request.env,
        args: request.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
      }, operation(request.signal));
      let observer: CdpConnection | undefined;
      try {
        observer = await CdpConnection.connect(owned.endpoint, operation(request.signal));
        await observer.verifyChromium(operation(request.signal));
        const target = (await observer.listTargets(operation())).find((entry) => entry.type === 'page');
        assert.ok(target, 'The leased browser must expose its prepared default page');
        const sessionId = await observer.attachTarget(target.targetId, operation());
        const lease = { id: `service-${records.length}`, cdpEndpoint: owned.endpoint };
        const record = { lease, owned, observer, targetId: target.targetId, sessionId, released: false };
        records.push(record);
        await observer.send('Page.enable', {}, operation(), sessionId);
        await observer.send('Page.navigate', { url: `${origin}/prepared` }, operation(), sessionId);
        await waitFor(async () => {
          try { return await evaluate<boolean>(record, `location.href==='${origin}/prepared' && document.readyState==='complete'`); }
          catch { return false; }
        });
        await evaluate(record, 'localStorage.setItem("providerSeed","provider-seed");document.cookie="providerSeed=seed; Path=/";true');
        return lease;
      } catch (error) { observer?.close(); await owned.close(); throw error; }
    },
    async release(lease) {
      const record = records.find((entry) => entry.lease === lease);
      assert.ok(record, 'Only the process that acquired a lease may release its exact original object');
      assert.equal(record.released, false, 'Each lease is released exactly once');
      record.released = true;
      try {
        assert.deepEqual(await contexts(record), [], 'Every attempt-created context must be gone before releasing its lease');
      } catch (error) { releaseErrors.push(error instanceof Error ? error.message : 'Provider cleanup assertion failed'); }
      finally { record.observer.close(); await record.owned.close(); }
    },
  };
  return { provider, records, releaseErrors };
}

/** A retained fixture deliberately keeps a live signal; attempt identity must still prevent cross-attempt use. */
function retainedFixture(engine: EngineHandle, runId: string, attemptId: string, origin: string): { browser: Browser; signal: AbortSignal } {
  const signal = new AbortController().signal;
  const context = {
    targetName: 'browser', app: { site: '127.0.0.1', resolveUrl: (url: string) => new URL(url, origin).href },
    timeouts: { test: 120_000, action: 30_000, assertion: 30_000 }, signal,
    operation: (timeoutMs = 30_000) => ({ runId, attemptId, signal, timeoutMs, origin: 'test' as const }),
    fixture: (_name: string, value: object) => value, expectable: (value: object) => value,
    attachArtifact: () => undefined, attachViewport: () => undefined,
    locator: () => { throw new Error('Retained fixture test uses no locators'); },
    screen: () => { throw new Error('Retained fixture test uses no screen queries'); },
  } as unknown as EngineFixtureContext;
  return { browser: engine.fixtures!.browser!(context) as Browser, signal };
}

async function serverFixture(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    if (request.url === '/sentinel-api') { response.setHeader('content-type', 'application/json'); response.end('{"owner":"service"}'); return; }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>${request.url === '/prepared' ? 'Provider prepared page' : 'Attempt page'}</title><h1>Browser provider fixture</h1><button id="button">Exact target</button>`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Preserve the original assertion and every resource cleanup failure. */
async function preservingCleanup(body: () => Promise<void>, cleanup: readonly (() => Promise<void>)[]): Promise<void> {
  const errors: unknown[] = [];
  try { await body(); } catch (error) { errors.push(error); }
  for (const action of cleanup) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Provider integration body and cleanup failed');
}

for (const scope of [undefined, 'worker'] as const) {
  test(`${scope ?? 'default'}-scope browser provider is rejected before acquisition`, () => {
    let acquired = 0; let released = 0;
    const provider: BrowserProvider = {
      name: 'forbidden-shared-provider', ...(scope === undefined ? {} : { scope }),
      async acquire() { acquired++; throw new Error('Shared provider acquisition must not run'); },
      async release() { released++; },
    };
    assert.throws(() => agentBrowser({ browser: provider }), { code: 'INVALID_CONFIG' });
    assert.equal(acquired, 0); assert.equal(released, 0);
  });
}

for (const scope of [undefined, 'worker'] as const) {
  test(`${scope ?? 'default'}-scope BrowserConnect is rejected before endpoint resolution`, () => {
    let resolutions = 0; let reconnects = 0;
    const cdpEndpoint = async () => { resolutions++; throw new Error('Shared endpoint resolution must not run'); };
    assert.throws(() => agentBrowser({ connect: { cdpEndpoint, ...(scope === undefined ? {} : { scope }) } }), { code: 'INVALID_CONFIG' });
    // An explicit worker scope cannot be broadened by the legacy second callback.
    if (scope === 'worker') assert.throws(() => agentBrowser({ connect: { scope, cdpEndpoint,
      reconnectEndpoint: async () => { reconnects++; throw new Error('Shared endpoint reconnection must not run'); },
    } }), { code: 'INVALID_CONFIG' });
    assert.equal(resolutions, 0); assert.equal(reconnects, 0);
  });
}

test('real dedicated attempt provider preserves prepared state, exact target agreement, and lease cleanup', { timeout: 240_000 }, async () => {
  assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'The exact-ref agent-browser binary is mandatory; provider integration never silently skips');
  const fixture = await serverFixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-provider-integration-'));
  const leased = service(fixture.origin);
  let host: E2EHost<{ browser: Browser }> | undefined;
  let retained: { browser: Browser; signal: AbortSignal } | undefined;
  const engine = agentBrowser({ executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE!, browser: leased.provider });
  await preservingCleanup(async () => {
    host = await openHost<{ browser: Browser }>({ cwd: directory, env: { ...process.env, E2E_TELEMETRY_DISABLED: '1' }, config: {
      projectId: 'real-dedicated-attempt-provider', targets: [{ name: 'browser', platform: 'web', app: { url: `${fixture.origin}/app` }, engine }],
      workers: 1, retries: 0, timeout: 120_000, launchTimeout: 90_000, actionTimeout: 30_000,
      cache: 'off', trace: 'on', video: 'off',
    } });
    for (let index = 0; index < 2; index += 1) {
      const session: E2ESession<{ browser: Browser }> = await host.openSession({ name: `dedicated provider attempt ${index}` });
      await preservingCleanup(async () => {
        const browser = session.fixtures.browser;
        const record = leased.records.at(-1)!;
        assert.equal(await browser.url(), `${fixture.origin}/prepared`, 'The exclusive provider-prepared page must not be replaced on initial launch');
        assert.equal(await browser.evaluate('localStorage.getItem("providerSeed")'), 'provider-seed');
        assert.equal((await browser.cookies()).some((cookie) => cookie.name === 'providerSeed'), true);
        if (index === 0) retained = retainedFixture(engine, session.runId, session.attemptId, fixture.origin);
        else {
          assert.ok(retained);
          assert.equal(retained.signal.aborted, false);
          await assert.rejects(retained.browser.evaluate("(() => {document.title='late old fixture';return true})()"), { code: 'INVALID_STATE' });
          assert.notEqual(await browser.title(), 'late old fixture');
        }
        await browser.goto('/app');
        assert.equal(await browser.evaluate('localStorage.getItem("attemptValue")'), null, 'Attempt state cannot leak from the previous attempt');
        await browser.evaluate(`(() => {localStorage.setItem('attemptValue','attempt-${index}');document.cookie='attemptCookie=${index}; Path=/';document.title='exact-attempt-${index}';return true})()`);
        const snapshot = await engine.observe!({ ...operation(), runId: session.runId, attemptId: session.attemptId });
        assert.equal(snapshot.location, `${fixture.origin}/app`, 'The public snapshot path must observe the selected leased target');
        const pages = (await record.observer.listTargets(operation())).filter((target) => target.type === 'page' && target.url === `${fixture.origin}/app`);
        assert.equal(pages.length, 1, 'Exactly one page in the dedicated browser must be the public engine action target');
        const selected = await record.observer.attachTarget(pages[0]!.targetId, operation());
        await preservingCleanup(async () => {
          const exact = await record.observer.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, operation(), selected);
          assert.equal(exact.result.value, `exact-attempt-${index}`);
        }, [async () => { await record.observer.send('Target.detachFromTarget', { sessionId: selected }, operation()); }]);
        if (index === 0) {
          await browser.addInitScript('window.attemptInitializer=true');
          await browser.route('**/sentinel-api', (route) => route.fulfill({ json: { owner: 'attempt' } }));
          assert.deepEqual(await browser.evaluate(`fetch('${fixture.origin}/sentinel-api').then(response=>response.json())`), { owner: 'attempt' });
          await session.fixtures.app.restart();
          assert.equal(await browser.evaluate('localStorage.getItem("attemptValue")'), 'attempt-0');
          assert.equal((await browser.cookies()).some((cookie) => cookie.name === 'attemptCookie' && cookie.value === '0'), true);
          assert.equal((await record.observer.listTargets(operation())).some((target) => target.targetId === record.targetId), false, 'Restart must stop the old exclusive default page before replacing its context');
          await session.fixtures.app.clearState();
          assert.equal(await browser.evaluate('localStorage.getItem("attemptValue")'), null);
          assert.equal(await browser.evaluate('localStorage.getItem("providerSeed")'), null);
          assert.equal((await browser.cookies()).length, 0);
        }
      }, [async () => { assert.deepEqual(await session.close(), []); }]);
      assert.equal(leased.records.length, index + 1);
      assert.equal(leased.records.at(-1)!.released, true);
    }
    assert.deepEqual(await host.close(), []); host = undefined;
    assert.equal(leased.records.length, 2);
    assert.ok(leased.records.every((record) => record.released));
    assert.deepEqual(leased.releaseErrors, []);
  }, [
    async () => { if (host) assert.deepEqual(await host.close(), []); },
    async () => { await preservingCleanup(async () => {}, leased.records.map(record => async () => { record.observer.close(); await record.owned.close(); })); },
    async () => { fixture.server.closeAllConnections(); await new Promise<void>((resolve) => fixture.server.close(() => resolve())); },
    async () => { await rm(directory, { recursive: true, force: true }); },
    async () => { assert.deepEqual(leased.releaseErrors, []); },
  ]);
});

for (const form of ['explicit-attempt', 'legacy-reconnect-implied-attempt'] as const) {
  test(`${form} BrowserConnect uses a dedicated endpoint and never recovers an uncertain action`, { timeout: 240_000 }, async () => {
    assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'The exact-ref agent-browser binary is mandatory');
    const fixture = await serverFixture();
    const directory = await mkdtemp(path.join(tmpdir(), 'e2e-connect-attempt-'));
    const leased = service(fixture.origin);
    let resolutions = 0; let reconnects = 0;
    let host: E2EHost<{ browser: Browser }> | undefined;
    const cdpEndpoint = async (signal: AbortSignal) => {
      resolutions += 1;
      return (await leased.provider.acquire({ runId: 'connect-attempt', targetName: 'browser', slot: 0, slots: 1, env: process.env, signal, log: () => undefined })).cdpEndpoint;
    };
    const connect = form === 'explicit-attempt' ? { scope: 'attempt' as const, cdpEndpoint } : {
      cdpEndpoint, reconnectEndpoint: async () => { reconnects++; throw new Error('A reconnect must never be attempted'); },
    };
    const engine = agentBrowser({ executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE!, connect });
    await preservingCleanup(async () => {
      host = await openHost<{ browser: Browser }>({ cwd: directory, env: { ...process.env, E2E_TELEMETRY_DISABLED: '1' }, config: {
        projectId: `real-${form}-connect`, targets: [{ name: 'browser', platform: 'web', app: { url: `${fixture.origin}/app` }, engine }],
        workers: 1, retries: 0, timeout: 120_000, launchTimeout: 90_000, actionTimeout: 30_000, cache: 'off', trace: 'on', video: 'off',
      } });
      const first: E2ESession<{ browser: Browser }> = await host.openSession({ name: 'connect uncertain first attempt' });
      await preservingCleanup(async () => {
        assert.equal(resolutions, 1);
        assert.equal(await first.fixtures.browser.url(), `${fixture.origin}/prepared`);
        let downloadTriggers = 0;
        await assert.rejects(first.fixtures.browser.waitForDownload(async () => { downloadTriggers++; }), { code: 'UNSUPPORTED_CAPABILITY' });
        assert.equal(downloadTriggers, 0, 'Raw connect cannot dispatch a download without a transfer capability');
        const record = leased.records[0]!;
        // Keep a real mutation dispatched while the independent service closes that exact page.
        const pending = first.fixtures.browser.evaluate('new Promise(resolve=>{window.failureStarted=true;setTimeout(()=>resolve(true),10000)})');
        const rejected = assert.rejects(pending, error => translatedEngineError(error, 'ACTION_FAILED', 'ACTION_MAY_HAVE_COMMITTED'));
        await preservingCleanup(async () => {
          await waitFor(() => evaluate<boolean>(record, 'window.failureStarted===true'));
          await record.observer.send('Target.closeTarget', { targetId: record.targetId }, operation());
        }, [async () => { await rejected; }]);
        await assert.rejects(first.fixtures.browser.url(), error => translatedEngineError(error, 'APP_NOT_OPEN', 'INVALID_STATE'));
        assert.equal(resolutions, 1); assert.equal(reconnects, 0);
        await record.observer.verifyChromium(operation());
      }, [async () => { assert.deepEqual(await first.close(), [], 'An uncertain input must still clean up its dedicated session'); }]);
      assert.equal(resolutions, 1, 'Closing a failed attempt must not provision its replacement');
      const second: E2ESession<{ browser: Browser }> = await host.openSession({ name: 'connect explicit next attempt' });
      await preservingCleanup(async () => {
        assert.equal(resolutions, 2);
        assert.equal(await second.fixtures.browser.url(), `${fixture.origin}/prepared`);
        assert.equal(await second.fixtures.browser.evaluate('localStorage.getItem("providerSeed")'), 'provider-seed');
        await second.fixtures.app.clearState();
        assert.equal(resolutions, 2, 'Explicit reset within an attempt reuses its existing endpoint');
        assert.equal(reconnects, 0);
      }, [async () => { assert.deepEqual(await second.close(), []); }]);
      assert.deepEqual(await host.close(), []); host = undefined;
      assert.equal(resolutions, 2); assert.equal(reconnects, 0);
      for (const record of leased.records) {
        assert.equal(record.released, false, 'A connect callback does not grant ownership of its browser process');
        assert.deepEqual(await contexts(record), []);
        await record.observer.verifyChromium(operation());
      }
    }, [
      async () => { if (host) assert.deepEqual(await host.close(), []); },
      async () => { await preservingCleanup(async () => {}, leased.records.map(record => async () => { await leased.provider.release(record.lease, { runId: 'connect-attempt', targetName: 'browser', env: process.env, signal: operation().signal, log: () => undefined }); })); },
      async () => { fixture.server.closeAllConnections(); await new Promise<void>((resolve) => fixture.server.close(() => resolve())); },
      async () => { await rm(directory, { recursive: true, force: true }); },
      async () => { assert.deepEqual(leased.releaseErrors, []); },
    ]);
    assert.deepEqual(leased.releaseErrors, []);
  });
}
