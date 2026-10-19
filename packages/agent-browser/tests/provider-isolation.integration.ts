/** Real Chromium, transparent protocol forwarding, and an observer outside the adapter's connection. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { OperationContext, SemanticNode } from 'e2e/engine';
import { openHost, type E2EHost } from 'e2e/runner';
import { agentBrowser, type Browser, type BrowserProvider } from '../dist/index.js';
import { CdpConnection } from '../src/cdp.ts';
import { launchChromium } from '../src/launch.ts';
import { cdpAuditProxy } from './cdp-audit-proxy.ts';

const operation = (): OperationContext => ({ runId: 'isolation-audit', attemptId: 'observer', origin: 'test', signal: new AbortController().signal, timeoutMs: 30_000 });
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 15_000;
  while (!await check()) {
    assert.ok(Date.now() < until, 'The real target did not finish its expected page work');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function evaluate<T>(observer: CdpConnection, session: string, expression: string): Promise<T> {
  const result = await observer.send<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, operation(), session);
  assert.equal(result.exceptionDetails, undefined);
  return result.result.value;
}
async function withCleanup(work: () => Promise<void>, cleanup: readonly (() => Promise<unknown> | void)[]): Promise<void> {
  const failures: unknown[] = [];
  try { await work(); } catch (error) { failures.push(error); }
  for (const close of cleanup) { try { await close(); } catch (error) { failures.push(error); } }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Original acceptance failure and cleanup failures');
}
function* walk(node: SemanticNode): Generator<SemanticNode> { yield node; for (const child of node.children ?? []) yield* walk(child); }

test('shared worker endpoints refuse before acquisition and leave real foreign pages completely untouched', { timeout: 120_000 }, async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>Foreign sentinel</title><script>window.started=true</script>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owned = await launchChromium({ executable: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', env: process.env,
    args: process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
  }, operation());
  t.after(() => owned.close());
  const observer = await CdpConnection.connect(owned.endpoint, operation());
  t.after(() => observer.close());
  const proxy = await cdpAuditProxy(owned.endpoint);
  t.after(() => proxy.close());
  const sessions: { id: string; url: string }[] = [];
  const seed = async (targetId: string, suffix: string): Promise<void> => {
    const id = await observer.attachTarget(targetId, operation());
    const url = `${origin}/${suffix}`; sessions.push({ id, url });
    await observer.send('Page.enable', {}, operation(), id);
    await observer.send('Page.navigate', { url }, operation(), id);
    await waitFor(async () => { try { return await evaluate<boolean>(observer, id, 'window.started===true'); } catch { return false; } });
    await evaluate(observer, id, 'localStorage.setItem("sentinel","unchanged");document.cookie="sentinel=unchanged; Path=/";true');
  };
  const defaultPage = (await observer.listTargets(operation())).find(target => target.type === 'page'); assert.ok(defaultPage);
  const foreign = await observer.send<{ browserContextId: string }>('Target.createBrowserContext', {}, operation());
  const extra = await observer.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId: foreign.browserContextId }, operation());
  await seed(defaultPage.targetId, 'foreign-default'); await seed(extra.targetId, 'foreign-context');
  let acquired = 0; let released = 0; let connected = 0;
  const provider: BrowserProvider = { name: 'shared-refusal-sentinel', scope: 'worker',
    async acquire() { acquired++; return { id: 'foreign-service', cdpEndpoint: proxy.endpoint }; },
    async release() { released++; },
  };
  // Refusal is the explicitly documented compatibility boundary, not a claim
  // that shared first-popup interception can satisfy the no-touch contract.
  assert.throws(() => agentBrowser({ browser: provider }), { code: 'INVALID_CONFIG' });
  assert.throws(() => agentBrowser({ browser: { ...provider, scope: undefined } }), { code: 'INVALID_CONFIG' });
  assert.throws(() => agentBrowser({ connect: { cdpEndpoint: async () => { connected++; return proxy.endpoint; } } }), { code: 'INVALID_CONFIG' });
  const late = await observer.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' }, operation());
  await seed(late.targetId, 'foreign-late');
  for (const session of sessions) {
    assert.deepEqual(await evaluate(observer, session.id, '({url:location.href,title:document.title,seed:localStorage.getItem("sentinel"),cookie:document.cookie,ready:window.started})'), {
      url: session.url, title: 'Foreign sentinel', seed: 'unchanged', cookie: 'sentinel=unchanged', ready: true,
    });
  }
  assert.deepEqual((await observer.send<{ browserContextIds: string[] }>('Target.getBrowserContexts', {}, operation())).browserContextIds, [foreign.browserContextId]);
  assert.equal(acquired, 0); assert.equal(released, 0); assert.equal(connected, 0);
  assert.deepEqual(proxy.commands, [], 'A refused endpoint must receive no discovery, attachment, probe, input, storage or closure command');
  assert.deepEqual(proxy.attachments, [], 'Even temporary foreign attachment or pause is forbidden');
  assert.deepEqual(proxy.errors, []);
});

test('dedicated attempt provider preserves nested OOPIF default refs and popup first-request initialization', { timeout: 300_000 }, async (t) => {
  assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'The strict-ref binary is mandatory; isolation acceptance cannot skip');
  const childServer = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/frame'
      ? '<!doctype html><iframe id="nested" src="/deep"></iframe>'
      : '<!doctype html><button id="deep" onclick="window.deepHit=true">Nested owned target</button>');
  });
  await new Promise<void>((resolve, reject) => { childServer.once('error', reject); childServer.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { childServer.closeAllConnections(); await new Promise<void>(resolve => childServer.close(() => resolve())); });
  const childOrigin = `http://child.audit.test:${(childServer.address() as AddressInfo).port}`;
  const server = createServer((request, response) => {
    if (request.url === '/api') { response.setHeader('content-type', 'application/json'); response.end('{"owner":"service"}'); return; }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>Isolation fixture</title><button id="open">Open popup</button>
    ${request.url === '/app' ? `<iframe id="isolated" src="${childOrigin}/frame"></iframe>` : ''}<script>
      window.started=true;window.apiResult=null;fetch('/api').then(response=>response.json()).then(value=>window.apiResult=value);
      document.getElementById('open').onclick=event=>{window.popupClick={trusted:event.isTrusted,opened:window.open('/owned-popup')!==null}};
    </script>`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://main.audit.test:${(server.address() as AddressInfo).port}`;
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-cdp-isolation-'));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const owned = await launchChromium({ executable: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', env: process.env,
    // Separate same-site hostnames keep the app-site policy intact and force a real OOPIF.
    // Chromium ignores ports in isolate-origins, so two ports of one IP are insufficient.
    // Both reserved test names resolve only to this fixture's loopback servers.
    args: ['--site-per-process', '--isolate-origins=http://child.audit.test', '--host-resolver-rules=MAP *.audit.test 127.0.0.1', '--no-proxy-server', ...(process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
  }, operation());
  t.after(() => owned.close());
  const observer = await CdpConnection.connect(owned.endpoint, operation());
  t.after(() => observer.close());
  const proxy = await cdpAuditProxy(owned.endpoint);
  t.after(() => proxy.close());
  let host: E2EHost<{ browser: Browser }> | undefined;
  let acquired = 0; let released = 0;
  await withCleanup(async () => {
    const lease = { id: 'dedicated-service', cdpEndpoint: proxy.endpoint };
    const provider: BrowserProvider = { name: 'transparent-cdp-audit', scope: 'attempt',
      async acquire() { acquired++; return lease; },
      async release(value) { assert.equal(value, lease); released++; },
    };
    const engine = agentBrowser({ executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE!, browser: provider });
    host = await openHost<{ browser: Browser }>({ cwd: directory, env: { ...process.env, E2E_TELEMETRY_DISABLED: '1' }, config: {
      projectId: 'dedicated-cdp-wire-audit', targets: [{ name: 'browser', platform: 'web', engine, app: { url: `${origin}/app` } }],
      workers: 1, retries: 0, timeout: 180_000, launchTimeout: 90_000, actionTimeout: 30_000,
      cache: 'off', trace: 'on', video: 'off',
    } });
    const attempt = await host.openSession({ name: 'Dedicated protocol acceptance' });
    await withCleanup(async () => {
      const browser = attempt.fixtures.browser;
      await browser.addInitScript('window.attemptOwner="owned"');
      await browser.route('**/api', route => route.fulfill({ json: { owner: 'attempt' } }));
      await browser.route('**/owned-popup', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Intercepted popup</title><script>window.initWasEarly=window.attemptOwner==="owned";window.navigationOwner="attempt";fetch("/api").then(response=>response.json()).then(value=>window.apiResult=value)</script>' }));
      await browser.goto('/app');
      await waitFor(async () => await browser.evaluate('window.apiResult?.owner==="attempt"'));
      let frameTarget: string | undefined;
      await waitFor(async () => {
        frameTarget = (await observer.listTargets(operation())).find(target => target.type === 'iframe' && target.url === `${childOrigin}/frame`)?.targetId;
        return frameTarget !== undefined;
      });
      const frameSession = await observer.attachTarget(frameTarget!, operation());
      await withCleanup(async () => {
        await waitFor(async () => {
          try { return await evaluate<boolean>(observer, frameSession, '!!document.querySelector("#nested")?.contentWindow?.document.getElementById("deep")'); }
          catch { return false; }
        });
        const context = { ...operation(), runId: attempt.runId, attemptId: attempt.attemptId };
        const observed = await engine.observe!(context);
        const deep = [...walk(observed.root)].find(node => node.selector === '#deep');
        assert.ok(deep, 'The production scoped native snapshot must include the nested owned OOPIF target');
        await engine.perform!(deep.ref, { kind: 'tap' }, context);
        assert.equal(await evaluate(observer, frameSession, 'document.querySelector("#nested").contentWindow.deepHit===true'), true);
      }, [() => observer.send('Target.detachFromTarget', { sessionId: frameSession }, operation())]);
      const popupContext = { ...operation(), runId: attempt.runId, attemptId: attempt.attemptId };
      const popupObservation = await engine.observe!(popupContext);
      const popupButton = [...walk(popupObservation.root)].find(node => node.selector === '#open');
      assert.ok(popupButton, 'The default production observation must expose the popup trigger');
      await engine.perform!(popupButton.ref, { kind: 'tap' }, popupContext);
      assert.deepEqual(await browser.evaluate('window.popupClick'), { trusted: true, opened: true }, 'Exact native input must create the popup before interception assertions');
      let popup: string | undefined;
      await waitFor(async () => {
        popup = (await observer.listTargets(operation())).find(target => target.url === `${origin}/owned-popup`)?.targetId;
        return popup !== undefined;
      });
      const popupSession = await observer.attachTarget(popup!, operation());
      await withCleanup(async () => {
        await waitFor(async () => {
          try { return await evaluate<boolean>(observer, popupSession, 'window.apiResult?.owner==="attempt" && window.attemptOwner==="owned" && window.initWasEarly===true && window.navigationOwner==="attempt"'); }
          catch { return false; }
        });
      }, [() => observer.send('Target.detachFromTarget', { sessionId: popupSession }, operation())]);

      await attempt.fixtures.app.restart();
      await attempt.fixtures.app.clearState();
    }, [async () => { assert.deepEqual(await attempt.close(), []); }]);
    assert.deepEqual(await host.close(), []); host = undefined;
    assert.equal(acquired, 1); assert.equal(released, 1);
    const contexts = await observer.send<{ browserContextIds: string[] }>('Target.getBrowserContexts', {}, operation());
    assert.deepEqual(contexts.browserContextIds, [], 'Dedicated attempt cleanup must remove every replacement context');
    assert.ok(proxy.commands.some(command => command.method === 'Runtime.evaluate'), 'The proxy must actually observe production companion traffic');
    assert.ok(proxy.commands.some(command => command.method === 'Accessibility.getFullAXTree'), 'The native snapshot connection must also traverse the proxy');
    assert.equal(proxy.commands.some(command => command.method === 'Browser.close'), false, 'The adapter must release the provider lease without terminating its service browser');
    assert.deepEqual(proxy.errors, []);
  }, [
    async () => { if (host) assert.deepEqual(await host.close(), []); },
    () => proxy.close(), () => observer.close(), () => owned.close(),
    async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
    () => rm(directory, { recursive: true, force: true }),
  ]);
});
