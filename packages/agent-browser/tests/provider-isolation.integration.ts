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
function* walk(node: SemanticNode): Generator<SemanticNode> { yield node; for (const child of node.children ?? []) yield* walk(child); }

test('shared provider never attaches to or pauses foreign pages, while owned popup first requests remain intercepted', { timeout: 300_000 }, async (t) => {
  assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'The strict-ref binary is mandatory; isolation acceptance cannot skip');
  const childServer = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/frame'
      ? '<!doctype html><iframe id="nested" src="/deep"></iframe>'
      : '<!doctype html><button id="deep" onclick="window.deepHit=true">Nested owned target</button>');
  });
  await new Promise<void>((resolve, reject) => { childServer.once('error', reject); childServer.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { childServer.closeAllConnections(); await new Promise<void>(resolve => childServer.close(() => resolve())); });
  const childOrigin = `http://127.0.0.1:${(childServer.address() as AddressInfo).port}`;
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
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-cdp-isolation-'));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const owned = await launchChromium({ executable: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', env: process.env,
    // A same-site isolated origin keeps the public app-site policy intact while requiring an actual OOPIF.
    args: ['--site-per-process', `--isolate-origins=${childOrigin}`, ...(process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
  }, operation());
  t.after(() => owned.close());
  const observer = await CdpConnection.connect(owned.endpoint, operation());
  t.after(() => observer.close());
  const proxy = await cdpAuditProxy(owned.endpoint);
  t.after(() => proxy.close());
  const foreignIds = new Set<string>();
  const foreignSessions: string[] = [];
  let host: E2EHost<{ browser: Browser }> | undefined;
  let acquired = 0; let released = 0;
  try {
    const foreignContext = await observer.send<{ browserContextId: string }>('Target.createBrowserContext', {}, operation());
    const seed = async (targetId: string, url: string) => {
      foreignIds.add(targetId);
      const session = await observer.attachTarget(targetId, operation()); foreignSessions.push(session);
      await observer.send('Page.enable', {}, operation(), session);
      await observer.send('Page.navigate', { url }, operation(), session);
      await waitFor(async () => {
        try { return await evaluate<boolean>(observer, session, 'window.started===true && window.apiResult?.owner==="service"'); }
        catch { return false; }
      });
      await evaluate(observer, session, 'localStorage.setItem("sentinel","unchanged");document.cookie="sentinel=unchanged; Path=/";true');
    };
    const defaultPage = (await observer.listTargets(operation())).find(target => target.type === 'page'); assert.ok(defaultPage);
    await seed(defaultPage.targetId, `${origin}/foreign-default`);
    const extra = await observer.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId: foreignContext.browserContextId }, operation());
    await seed(extra.targetId, `${origin}/foreign-context`);
    const lease = { id: 'shared-service', cdpEndpoint: proxy.endpoint };
    const provider: BrowserProvider = { name: 'transparent-cdp-audit', scope: 'worker',
      async acquire() { acquired++; return lease; },
      async release(value) { assert.equal(value, lease); released++; },
    };
    const engine = agentBrowser({ executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE!, browser: provider });
    host = await openHost<{ browser: Browser }>({ cwd: directory, env: { ...process.env, E2E_TELEMETRY_DISABLED: '1' }, config: {
      projectId: 'shared-cdp-wire-audit', targets: [{ name: 'browser', platform: 'web', engine, app: { url: `${origin}/app` } }],
      workers: 1, retries: 0, timeout: 180_000, launchTimeout: 90_000, actionTimeout: 30_000,
      cache: 'off', trace: 'on', video: 'off',
    } });
    const attempt = await host.openSession({ name: 'Foreign protocol isolation' });
    try {
      const browser = attempt.fixtures.browser;
      await browser.addInitScript('window.attemptOwner="owned"');
      await browser.route('**/api', route => route.fulfill({ json: { owner: 'attempt' } }));
      await browser.route('**/owned-popup', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Intercepted popup</title><script>window.navigationOwner="attempt";fetch("/api").then(response=>response.json()).then(value=>window.apiResult=value)</script>' }));
      await browser.goto('/app');
      await waitFor(async () => await browser.evaluate('window.apiResult?.owner==="attempt"'));
      let frameTarget: string | undefined;
      await waitFor(async () => {
        frameTarget = (await observer.listTargets(operation())).find(target => target.type === 'iframe' && target.url === `${childOrigin}/frame`)?.targetId;
        return frameTarget !== undefined;
      });
      const frameSession = await observer.attachTarget(frameTarget!, operation());
      try {
        await waitFor(async () => {
          try { return await evaluate<boolean>(observer, frameSession, '!!document.querySelector("#nested")?.contentWindow?.document.getElementById("deep")'); }
          catch { return false; }
        });
        const context = { ...operation(), runId: attempt.runId, attemptId: attempt.attemptId };
        const observed = await engine.observe!(context);
        const deep = [...walk(observed.root)].find(node => node.attributes?.id === 'deep');
        assert.ok(deep, 'The production scoped native snapshot must include the nested owned OOPIF target');
        await engine.perform!(deep.ref, { kind: 'tap' }, context);
        assert.equal(await evaluate(observer, frameSession, 'document.querySelector("#nested").contentWindow.deepHit===true'), true);
      } finally { await observer.send('Target.detachFromTarget', { sessionId: frameSession }, operation()); }
      const popupContext = { ...operation(), runId: attempt.runId, attemptId: attempt.attemptId };
      const popupObservation = await engine.observe!(popupContext);
      const popupButton = [...walk(popupObservation.root)].find(node => node.attributes?.id === 'open');
      assert.ok(popupButton, 'The default production observation must expose the popup trigger');
      await engine.perform!(popupButton.ref, { kind: 'tap' }, popupContext);
      assert.deepEqual(await browser.evaluate('window.popupClick'), { trusted: true, opened: true }, 'Exact native input must create the popup before interception assertions');
      let popup: string | undefined;
      await waitFor(async () => {
        popup = (await observer.listTargets(operation())).find(target => target.url === `${origin}/owned-popup`)?.targetId;
        return popup !== undefined;
      });
      const popupSession = await observer.attachTarget(popup!, operation());
      try {
        await waitFor(async () => {
          try { return await evaluate<boolean>(observer, popupSession, 'window.apiResult?.owner==="attempt" && window.attemptOwner==="owned" && window.navigationOwner==="attempt"'); }
          catch { return false; }
        });
      } finally { await observer.send('Target.detachFromTarget', { sessionId: popupSession }, operation()); }

      // This page is created outside the adapter while interception is active. Even a
      // short auto-attach pause followed by resume/detach is a failed isolation contract.
      const late = await observer.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' }, operation());
      await seed(late.targetId, `${origin}/foreign-late`);
      await attempt.fixtures.app.restart();
      await attempt.fixtures.app.clearState();
    } finally { assert.deepEqual(await attempt.close(), []); }
    assert.deepEqual(await host.close(), []); host = undefined;
    assert.equal(acquired, 1); assert.equal(released, 1);
    for (const session of foreignSessions) {
      assert.deepEqual(await evaluate(observer, session, '({seed:localStorage.getItem("sentinel"),cookie:document.cookie,owner:window.attemptOwner??null,api:window.apiResult})'), {
        seed: 'unchanged', cookie: 'sentinel=unchanged', owner: null, api: { owner: 'service' },
      });
    }
    const contexts = await observer.send<{ browserContextIds: string[] }>('Target.getBrowserContexts', {}, operation());
    assert.deepEqual(contexts.browserContextIds, [foreignContext.browserContextId]);
    assert.ok(proxy.commands.some(command => command.method === 'Runtime.evaluate'), 'The proxy must actually observe production companion traffic');
    assert.ok(proxy.commands.some(command => command.method === 'Accessibility.getFullAXTree'), 'The native snapshot connection must also traverse the proxy');
    assert.deepEqual(proxy.attachments.filter(event => foreignIds.has(event.targetId)), [], 'An adapter connection must never attach to a foreign target, even if it immediately resumes/detaches it');
    const forbidden = proxy.commands.filter(command => {
      if (command.targetId !== undefined && foreignIds.has(command.targetId)) return true;
      if (command.method === 'Browser.close') return true;
      if (command.method === 'Target.createTarget' || command.method === 'Target.disposeBrowserContext'
        || command.method === 'Browser.setDownloadBehavior' || /^Storage\.(?:getCookies|setCookies|clearCookies)$/.test(command.method)) {
        return typeof command.params.browserContextId !== 'string' || !proxy.createdContexts.has(command.params.browserContextId);
      }
      return false;
    });
    assert.deepEqual(forbidden.map(command => ({ method: command.method, targetId: command.targetId })), [], 'No foreign page probe, domain setup, input, navigation, closure or default-context storage command is allowed');
    assert.deepEqual(proxy.errors, []);
  } finally {
    await host?.close();
    await proxy.close(); observer.close(); await owned.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
