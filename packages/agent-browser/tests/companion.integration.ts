/** Real public-CLI/CDP agreement checks. CI supplies the reviewed binary and a runnable Chromium. */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { OperationContext } from 'e2e/engine';
import { CdpConnection } from '../src/cdp.ts';
import { launchChromium, type OwnedBrowser } from '../src/launch.ts';
import { NetworkHub, type NetworkOptions } from '../src/network.ts';
import { installDiagnostics } from '../src/diagnostics.ts';
import type { AppLogEntry } from 'e2e/engine';
import { CliTransport } from '../src/transport.ts';

/** Creates fresh budgets; every test owns one disposable Chromium process. */
function operation(timeoutMs = 15_000): OperationContext {
  return { signal: new AbortController().signal, timeoutMs, runId: 'companion-integration', attemptId: 'one', origin: 'test' };
}

/** Local pages exercise first-popup requests, OOPIF child fetches, and incomplete streamed bodies. */
async function fixtureServer(): Promise<{ server: Server; origin: string; frameOrigin: string }> {
  const server = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'authorization,content-type,x-preview');
    response.setHeader('access-control-allow-methods', 'GET,POST,PUT,OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/protected') {
      if (request.headers.authorization !== `Basic ${Buffer.from('integration-user:integration-password').toString('base64')}`) {
        response.writeHead(401, { 'www-authenticate': 'Basic realm="integration"' });
        response.end('authorization required');
      } else { response.setHeader('content-type', 'application/json'); response.end('{"authorized":true}'); }
    } else if (pathname === '/redirect') {
      const address = server.address() as AddressInfo;
      response.writeHead(302, { location: `http://localhost:${address.port}/headers` });
      response.end();
    } else if (pathname === '/headers') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ authorization: request.headers.authorization ?? null, preview: request.headers['x-preview'] ?? null }));
    } else if (pathname === '/diagnostic-popup') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>Diagnostic popup</title><script>console.warn("popup diagnostic");setTimeout(()=>{throw new Error("popup runtime error")},0)</script>');
    } else if (pathname === '/missing') {
      response.writeHead(404); response.end('missing');
    } else if (pathname === '/broken') {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '10000' });
      response.write('partial body');
      setTimeout(() => response.destroy(), 40);
    } else if (pathname === '/frame') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>Child frame</title><script>fetch("/api?child").then(r=>r.text()).then(text=>document.title=text)</script>');
    } else if (pathname === '/echo') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ method: request.method, header: request.headers['x-test'], body: Buffer.concat(chunks).toString() })); });
    } else {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>Network fixture</title><body>Ready</body>');
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  const port = (server.address() as AddressInfo).port;
  return { server, origin: `http://127.0.0.1:${port}`, frameOrigin: `http://localhost:${port}` };
}

/** Hooks one public CLI session and one public CDP companion to the same existing target. */
async function withCompanion(run: (value: {
  cli: CliTransport; cdp: CdpConnection; hub: NetworkHub; sessionId: string; targetId: string;
  origin: string; frameOrigin: string; endpoint: string;
}) => Promise<void>, configuration?: (origin: string) => Pick<NetworkOptions, 'authorization' | 'siteHeaders' | 'configuredHeaderNames'>): Promise<void> {
  assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'Supply the reviewed agent-browser binary; browser verification must not silently skip');
  const fixture = await fixtureServer();
  let owned: OwnedBrowser | undefined;
  let cli: CliTransport | undefined;
  let cdp: CdpConnection | undefined;
  let hub: NetworkHub | undefined;
  try {
    owned = await launchChromium({
      executable: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', env: process.env,
      args: ['--site-per-process', ...(process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
    }, operation());
    cdp = await CdpConnection.connect(owned.endpoint, operation());
    await cdp.verifyChromium(operation());
    const initial = (await cdp.listTargets(operation())).find(target => target.type === 'page');
    assert.ok(initial, 'The dedicated browser must expose its initial target');
    cli = new CliTransport({ executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE, cdp: owned.endpoint,
      cdpTarget: initial.targetId, cdpContext: initial.browserContextId ?? null });
    await cli.run(['open', fixture.origin], operation(), { mutating: true });
    const { tabs } = await cli.run<{ tabs: { targetId: string; active: boolean }[] }>(['tab', 'list'], operation());
    const active = tabs.find((tab) => tab.active);
    assert.equal(active?.targetId, initial.targetId, 'Native scope must remain bound to the selected target');
    assert.ok(active);
    hub = new NetworkHub(cdp, { operation, resolveUrl: (url) => new URL(url, fixture.origin).href, resolvePath: (path) => path, ...configuration?.(fixture.origin) });
    await hub.start(operation());
    const sessionId = await hub.useTarget(active.targetId, operation());
    assert.ok((await cdp.listTargets(operation())).some((target) => target.targetId === active.targetId));
    await run({ cli, cdp, hub, sessionId, targetId: active.targetId, origin: fixture.origin, frameOrigin: fixture.frameOrigin, endpoint: owned.endpoint });
  } finally {
    hub?.close();
    cdp?.close();
    try { await cli?.close(operation()); }
    finally {
      await owned?.close();
      await new Promise<void>((resolve) => { fixture.server.closeAllConnections(); fixture.server.close(() => resolve()); });
    }
  }
}

/** Waits for an observed event count rather than guessing when popup/frame initialization completes. */
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Expected target network event did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Constant fixture stages locate failures without exposing command payloads. */
async function fixtureStep<T>(stage: string, work: Promise<T>): Promise<T> {
  try { return await work; }
  catch (cause) { throw new Error(`Companion fixture stage failed: ${stage}`, { cause }); }
}

/** A real input event grants popup activation; plain eval must not bypass Chromium's popup policy. */
async function clickPopup(
  cli: CliTransport, cdp: CdpConnection, sessionId: string, url: string,
  beforeOpen = '', afterOpen = '',
): Promise<void> {
  await cli.run(['eval', '--', `(() => {
    if (document.getElementById('e2e-companion-popup-trigger')) throw new Error('Duplicate popup fixture button');
    const button = document.createElement('button');
    button.id = 'e2e-companion-popup-trigger'; button.textContent = 'Open companion test popup';
    button.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647';
    button.onclick = event => {
      ${beforeOpen}
      globalThis.__e2ePopupClick = { trusted: event.isTrusted, opened: window.open(${JSON.stringify(url)}) !== null };
      ${afterOpen}
    };
    document.body.append(button); return true;
  })()`], operation(), { mutating: true });
  await cli.run(['click', '#e2e-companion-popup-trigger'], operation(), { mutating: true });
  const result = await cdp.send<{ result: { value: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', {
    expression: 'globalThis.__e2ePopupClick', returnByValue: true,
  }, operation(), sessionId);
  assert.equal(result.exceptionDetails, undefined);
  assert.deepEqual(result.result.value, { trusted: true, opened: true }, 'Native click must create a popup before waiting for its interception or diagnostics');
}

test('public CDP companion observes and fulfills the exact request issued by agent-browser on its active target', { timeout: 60_000 }, async () => {
  await withCompanion(async ({ cli, hub, origin }) => {
    await hub.route('**/api', (route) => route.fulfill({ status: 201, json: { sharedTarget: true } }), operation());
    const waiting = hub.waitForResponse('**/api', operation());
    const [response] = await Promise.all([
      waiting,
      cli.run(['eval', `fetch('${origin}/api').then(response=>response.json())`], operation(), { mutating: true }),
    ]);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { sharedTarget: true });
    await hub.settle(operation());
  });
});

test('routes intercept the first popup navigation and a cross-origin OOPIF fetch before renderer execution', { timeout: 60_000 }, async () => {
  await withCompanion(async ({ cli, cdp, hub, sessionId, origin, frameOrigin }) => {
    let popupNavigations = 0;
    let frameRequests = 0;
    await hub.route('**/popup', (route) => {
      popupNavigations += 1;
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Intercepted popup</title>' });
    }, operation());
    await hub.route('**/api?child', (route) => { frameRequests += 1; return route.fulfill({ body: 'Intercepted child' }); }, operation());
    await clickPopup(cli, cdp, sessionId, `${origin}/popup`, '', `const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(`${frameOrigin}/frame`)}; document.body.append(frame);`);
    await until(() => popupNavigations === 1 && frameRequests === 1);
    await hub.settle(operation());
    const targets = await cdp.listTargets(operation());
    assert.ok(targets.some((target) => target.type === 'iframe'), 'Cross-site fixture must run in an OOPIF');
    assert.equal(targets.filter((target) => target.type === 'page').length, 2, 'Only the original tab and requested popup may exist');
    assert.ok(hub.sessions().some((entry) => entry.type === 'iframe'));
  });
});

test('asynchronous LIFO routes can continue with rewritten method, body, and headers', { timeout: 60_000 }, async () => {
  await withCompanion(async ({ cli, hub, origin }) => {
    const order: string[] = [];
    await hub.route('**/intercept', async (route) => {
      order.push('older');
      await new Promise((resolve) => setTimeout(resolve, 15));
      await route.continue({ url: `${origin}/echo`, method: 'POST', postData: 'héllo', headers: { 'content-type': 'text/plain', 'x-test': 'rewritten' } });
    }, operation());
    await hub.route('**/intercept', async (route) => { order.push('newer'); await route.fallback(); }, operation());
    await cli.run(['eval', `fetch('${origin}/intercept').then(r=>r.json()).then(value=>{window.echoResult=value;return value})`], operation(), { mutating: true });
    await hub.settle(operation());
    const result = await cli.run<{ result: unknown }>(['eval', 'window.echoResult'], operation());
    assert.deepEqual(result.result, { method: 'POST', header: 'rewritten', body: 'héllo' });
    assert.deepEqual(order, ['newer', 'older']);
  });
});

test('a truncated network response rejects body reads instead of returning an empty success', { timeout: 60_000 }, async () => {
  await withCompanion(async ({ cli, hub, origin }) => {
    const waiting = hub.waitForResponse('**/broken', operation());
    const [response] = await Promise.all([
      waiting,
      cli.run(['eval', `fetch('${origin}/broken').then(()=>true)`], operation(), { mutating: true }),
    ]);
    assert.equal(response.status, 200);
    await assert.rejects(response.text(), { code: 'ACTION_FAILED' });
    await assert.rejects(response.text(), { code: 'ACTION_FAILED' });
  });
});

test('server Basic auth and scoped headers work without routes and do not follow a cross-site redirect', { timeout: 60_000 }, async () => {
  await withCompanion(async ({ cli, hub, origin, frameOrigin }) => {
    const allowed = await cli.run<{ result: unknown }>(['eval', `fetch('${origin}/protected').then(response=>response.json())`], operation(), { mutating: true });
    assert.deepEqual(allowed.result, { authorized: true });
    const redirected = await cli.run<{ result: unknown }>(['eval', `fetch('${origin}/redirect').then(response=>response.json())`], operation(), { mutating: true });
    assert.deepEqual(redirected.result, { authorization: null, preview: null });
    const own = await cli.run<{ result: unknown }>(['eval', `fetch('${frameOrigin}/headers',{headers:{Authorization:'Bearer application-owned'}}).then(response=>response.json())`], operation(), { mutating: true });
    assert.deepEqual(own.result, { authorization: 'Bearer application-owned', preview: null });
    await hub.settle(operation());
  }, (origin) => ({
    authorization: (url) => new URL(url).origin === origin ? { username: 'integration-user', password: 'integration-password' } : undefined,
    siteHeaders: (url) => new URL(url).origin === origin ? { 'x-preview': 'synthetic-preview-value' } : undefined,
    configuredHeaderNames: ['x-preview'],
  }));
});

test('diagnostics capture actual main-tab and popup console, runtime, HTTP errors, and origins', { timeout: 60_000 }, async () => {
  await withCompanion(async ({ cli, cdp, hub, sessionId, targetId, origin }) => {
    const log: AppLogEntry[] = [];
    const navigations: string[] = [];
    const origins = new Set<string>();
    const cleanup = await installDiagnostics(cdp, hub, {
      signal: new AbortController().signal, appLog: (entry) => log.push(entry), navigation: (line) => navigations.push(line),
    }, { activeTarget: () => targetId, onOrigin: (value) => origins.add(value) }, operation());
    try {
      await clickPopup(cli, cdp, sessionId, `${origin}/diagnostic-popup`, `console.log('main diagnostic'); fetch(${JSON.stringify(`${origin}/missing`)});`);
      await until(() => log.some((entry) => entry.source === 'error' && entry.text.includes('popup runtime error'))
        && log.some((entry) => entry.source === 'network' && entry.text.includes('/missing 404')));
      assert.ok(log.some((entry) => entry.source === 'console' && entry.text === 'main diagnostic'));
      assert.ok(log.some((entry) => entry.source === 'console' && entry.level === 'warning' && entry.text === 'popup diagnostic'));
      assert.ok(navigations.some((line) => line.includes('opened a new tab')));
      assert.ok(origins.has(origin));
    } finally { cleanup(); }
  });
});

test('an exclusively owned browser routes the selected context and its first popup navigation', { timeout: 60_000 }, async () => {
  await withCompanion(async ({ cli: initialCli, cdp: previousConnection, hub, targetId: originalTarget, origin, endpoint }) => {
    // This low-level fixture owns the entire disposable browser, including its original tab.
    // Browser-wide attachment is necessary to pause a popup before its first navigation.
    hub.close();
    previousConnection.close();
    await initialCli.close(operation());
    const cdp = await CdpConnection.connect(endpoint, operation());
    const { browserContextId } = await cdp.send<{ browserContextId: string }>('Target.createBrowserContext', {}, operation());
    let scoped: NetworkHub | undefined;
    let cli: CliTransport | undefined;
    try {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId }, operation());
      cli = new CliTransport({ executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE!, cdp: endpoint, cdpTarget: targetId, cdpContext: browserContextId });
      const initialized: string[] = [];
      scoped = new NetworkHub(cdp, {
        operation, resolveUrl: (url) => new URL(url, origin).href, resolvePath: (file) => file, browserContextId, browserExclusive: true,
      });
      scoped.onTarget((target) => { initialized.push(target.targetId); });
      await scoped.start(operation());
      const scopedSession = await scoped.useTarget(targetId, operation());
      let interceptions = 0;
      await scoped.route('**/scoped-api', (route) => { interceptions += 1; return route.fulfill({ json: { scoped: true } }); }, operation());
      await fixtureStep('bind scoped tab', cli.run(['tab', targetId], operation(), { mutating: true }));
      await fixtureStep('navigate scoped tab', cli.run(['open', origin], operation(), { mutating: true }));
      const selected = await fixtureStep('read scoped tab identity', cli.run<{ tabs: { targetId: string; active: boolean }[] }>(['tab', 'list'], operation()));
      assert.equal(selected.tabs.find((target) => target.active)?.targetId, targetId);
      const response = await fixtureStep('fetch scoped route', cli.run<{ result: unknown }>(['eval', `fetch('${origin}/scoped-api').then(response=>response.json())`], operation(), { mutating: true }));
      assert.deepEqual(response.result, { scoped: true });
      assert.equal(interceptions, 1);
      assert.equal(initialized.includes(originalTarget), false);
      const foreignObserver = await CdpConnection.connect(endpoint, operation());
      const foreignSession = await foreignObserver.attachTarget(originalTarget, operation());
      try {
        const foreign = await foreignObserver.send<{ result: { value: string } }>('Runtime.evaluate', {
          expression: `fetch('${origin}/scoped-api').then(response=>response.text())`, awaitPromise: true, returnByValue: true,
        }, operation(), foreignSession);
        assert.match(foreign.result.value, /Network fixture/);
        assert.equal(interceptions, 1, 'Other owned context requests must not enter this attempt route registry');
      } finally { foreignObserver.close(); }
      await fixtureStep('first popup input', clickPopup(cli, cdp, scopedSession, `${origin}/scoped-api`));
      await until(() => interceptions === 2);
      await scoped.settle(operation());
      assert.ok(scoped.sessions().every((session) => session.targetId !== originalTarget));
    } finally {
      scoped?.close();
      await cli?.close(operation());
      try {
        await cdp.send('Target.disposeBrowserContext', { browserContextId }, operation());
        assert.ok((await cdp.listTargets(operation())).some((target) => target.targetId === originalTarget), 'Context disposal must preserve the other owned original context');
      } finally { cdp.close(); }
    }
  });
});
