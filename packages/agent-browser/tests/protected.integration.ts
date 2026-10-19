/** Synthetic HTTP proof for protected previews; never contacts a private service. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentBrowserSurface } from '../src/surface.ts';
import type { CdpConnection, CdpTarget } from '../src/cdp.ts';
import type { OperationContext } from 'e2e/engine';

const operation = (): OperationContext => ({ runId: 'protected-fixture', attemptId: 'protected', origin: 'test', timeoutMs: 30_000, signal: new AbortController().signal });

test('headers and Basic credentials cover first navigation and popups without leaking off-site', { timeout: 180_000 }, async () => {
  assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'The real test requires the pinned patched executable');
  const requests: { host: string; path: string; protectedHeader?: string; authorization?: string }[] = [];
  const popupTrace: string[] = [];
  let origin = '';
  let offsite = '';
  const auth = `Basic ${Buffer.from('synthetic-user:synthetic-password').toString('base64')}`;
  const server = createServer((request, response) => {
    const requestPath = request.url ?? '/';
    if (requestPath === '/popup') popupTrace.push(`server:popup:protected-header=${typeof request.headers['x-preview-key'] === 'string'}`);
    requests.push({ host: request.headers.host ?? '', path: requestPath, ...(typeof request.headers['x-preview-key'] === 'string' ? { protectedHeader: request.headers['x-preview-key'] } : {}), ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) });
    response.setHeader('access-control-allow-origin', '*');
    if (requestPath === '/redirect') { response.writeHead(302, { location: `${offsite}/redirect-target` }); response.end(); return; }
    if (requestPath.startsWith('/auth') && request.headers.authorization !== auth) { response.writeHead(401, { 'www-authenticate': 'Basic realm="synthetic-fixture"' }); response.end('challenge'); return; }
    if (requestPath === '/configuration') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>Protected fixture</title><script>window.scriptWasEarly=window.configuredBeforeApp===true</script>');
      return;
    }
    response.end('synthetic response');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  offsite = origin.replace('127.0.0.1', 'localhost');
  const artifacts = await mkdtemp(path.join(tmpdir(), 'e2e-protected-fixture-'));
  const surface = new AgentBrowserSurface({
    executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE!, executablePath: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium',
    args: process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
    headers: { 'X-Preview-Key': 'synthetic-preview-value' },
    basicAuth: { username: 'synthetic-user', password: 'synthetic-password' },
    locale: 'en-GB', timezoneId: 'Europe/London', colorScheme: 'dark',
    initScripts: ['window.configuredBeforeApp=true'],
  });
  const log: string[] = [];
  try {
    await surface.init({ runId: 'protected-fixture', targetName: 'protected', projectRoot: artifacts, app: { site: '127.0.0.1' }, env: process.env, headed: false, workerSlot: 0, signal: operation().signal, log: () => undefined });
    await surface.startAttempt({ attemptId: 'protected', artifactsDir: artifacts, signal: operation().signal, resolveSecret: () => Promise.reject(new Error('Fixture uses no Secret provider')), appLog: entry => log.push(entry.text), navigation: line => log.push(line), environment: () => undefined });
    // Record only public protocol method/session identities and booleans, never credentials.
    // The sequence distinguishes an unthrottled popup from a lost Fetch override on CI.
    const connection = surface.cdp;
    const send = connection.send.bind(connection);
    connection.send = <T = Record<string, unknown>>(method: string, params: Record<string, unknown>, context: OperationContext, sessionId?: string): Promise<T> => {
      if (['Page.enable', 'Network.enable', 'Fetch.enable', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger', 'Page.addScriptToEvaluateOnNewDocument'].includes(method)) {
        popupTrace.push(`send:${sessionId ?? 'browser'}:${method}`);
      } else if (method === 'Fetch.continueRequest') {
        const values = params.headers as { name: string; value: string }[] | undefined;
        popupTrace.push(`continue:${sessionId ?? 'browser'}:${String(params.requestId)}:protected-header=${values?.some(header => header.name.toLowerCase() === 'x-preview-key') ?? false}`);
      }
      return send<T>(method, params, context, sessionId);
    };
    const watched = new Set<string>();
    const watch = (cdp: CdpConnection, sessionId?: string): void => {
      const key = sessionId ?? 'browser';
      if (watched.has(key)) return;
      watched.add(key);
      cdp.on<{ sessionId: string; targetInfo: CdpTarget; waitingForDebugger: boolean }>('Target.attachedToTarget', event => {
        popupTrace.push(`attached:${event.sessionId}:${event.targetInfo.type}:waiting=${event.waitingForDebugger}`);
        watch(cdp, event.sessionId);
      }, sessionId);
      if (sessionId !== undefined) cdp.on<{ requestId: string; request: { url: string } }>('Fetch.requestPaused', event => {
        popupTrace.push(`paused:${sessionId}:${event.requestId}:popup=${event.request.url === `${origin}/popup`}`);
      }, sessionId);
    };
    watch(connection);
    for (const session of surface.routes.sessions()) watch(connection, session.sessionId);
    await surface.open(`${origin}/configuration`, operation());
    assert.equal(requests.find(entry => entry.path === '/configuration')?.protectedHeader, 'synthetic-preview-value');
    assert.deepEqual(await surface.evaluate('[window.scriptWasEarly,navigator.language,Intl.DateTimeFormat().resolvedOptions().timeZone,matchMedia("(prefers-color-scheme: dark)").matches]', operation(), false), [true, 'en-GB', 'Europe/London', true]);
    assert.equal(await surface.evaluate(`fetch('${origin}/auth').then(response=>response.status)`, operation()), 200);
    assert.equal(await surface.evaluate(`fetch('${offsite}/auth-offsite').then(response=>response.status)`, operation()), 401);
    await surface.evaluate(`Promise.all([fetch('${offsite}/offsite'), fetch('${origin}/redirect')]).then(()=>true)`, operation());
    await surface.evaluate(`(()=>{window.open('${origin}/popup');return true})()`, operation());
    const until = Date.now() + 10_000;
    while (!requests.some(entry => entry.path === '/popup') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    const popup = requests.find(entry => entry.path === '/popup');
    assert.ok(popup, `The first popup request must reach the server. Protocol sequence: ${JSON.stringify(popupTrace)}`);
    assert.equal(popup.protectedHeader, 'synthetic-preview-value', `The first popup request must include the protected header. Protocol sequence: ${JSON.stringify(popupTrace)}`);
    const other = requests.filter(entry => entry.host.startsWith('localhost:'));
    assert.ok(other.some(entry => entry.path === '/redirect-target'));
    assert.ok(other.every(entry => entry.protectedHeader === undefined && entry.authorization === undefined));
    assert.ok(!JSON.stringify(log).includes('synthetic-password'));
    await surface.restart(operation());
    await surface.open(`${origin}/configuration`, operation());
    assert.equal(await surface.evaluate('window.scriptWasEarly', operation(), false), true);
  } finally {
    try { await surface.dispose({ signal: operation().signal, timeoutMs: 15_000 }); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(artifacts, { recursive: true, force: true }); }
  }
});
