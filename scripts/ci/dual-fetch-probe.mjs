// Focused coexistence witness: native-style Fetch headers plus real PW route.fallback.
// Uses one existing Chromium binary; does not run the exact native engine.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(work, ms, label) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Probe timeout (${ms} ms): ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function attemptCleanup(errors, label, work, ms = 3_000) {
  try { await bounded(work, ms, label); return true; }
  catch (error) { errors.push(`${label}: ${String(error)}`); return false; }
}
if (process.argv.includes('--self-test')) {
  assert.equal(await bounded(() => Promise.resolve(17), 100, 'resolved'), 17);
  await assert.rejects(bounded(() => new Promise(() => {}), 10, 'never'), /Probe timeout.*never/);
  await assert.rejects(bounded(() => Promise.reject(new Error('original')), 100, 'rejected'), /original/);
  const errors = [];
  assert.equal(await attemptCleanup(errors, 'cleanup timeout', () => new Promise(() => {}), 10), false);
  assert.equal(await attemptCleanup(errors, 'later cleanup', () => Promise.resolve(), 100), true);
  assert.equal(errors.length, 1);
  console.log(JSON.stringify({ timeoutHelperTests: 5, passed: 5, browserLaunches: 0 }));
  process.exit(0);
}

assert(process.env.PW_PACKAGE, 'PW_PACKAGE must name an installed playwright-core directory');
assert(process.env.CHROME_BIN, 'CHROME_BIN must name the existing Chromium executable');
const packagePath = process.env.PW_PACKAGE;
const packageInfo = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
assert.equal(packageInfo.version, '1.64.1');
const { chromium } = await import(pathToFileURL(join(packagePath, 'index.mjs')).href);
const profile = await mkdtemp(join(tmpdir(), 'surface-dual-fetch-'));
const result = { node: process.version, playwright: packageInfo.version, chromiumLaunches: 0, cases: [] };
const requests = [];
const ownedSockets = new Set();
const ownedBrowsers = new Set();
const pendingConnections = new Set();
const serverSockets = new Set();
let closing = false;
const checkOpen = () => { if (closing) throw new Error('Probe is shutting down'); };
const app = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname !== '/headers') { response.writeHead(204); response.end(); return; }
  const receipt = { case: url.searchParams.get('case'), header: request.headers['x-fixture-header'] ?? null };
  requests.push(receipt);
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(receipt));
});
app.on('connection', socket => { serverSockets.add(socket); socket.once('close', () => serverSockets.delete(socket)); });
let chrome;
let raw;
let browser;
let stderr = '';
let spawnError;

class Cdp {
  next = 0;
  pending = new Map();
  listeners = new Set();
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener('message', event => {
      const value = JSON.parse(event.data);
      if (!value.id) { for (const listener of this.listeners) listener(value); return; }
      const entry = this.pending.get(value.id);
      if (!entry) return;
      this.pending.delete(value.id); clearTimeout(entry.timeout);
      value.error ? entry.reject(new Error(JSON.stringify(value.error))) : entry.resolve(value.result);
    });
    ws.addEventListener('close', () => {
      for (const entry of this.pending.values()) { clearTimeout(entry.timeout); entry.reject(new Error('CDP disconnected')); }
      this.pending.clear();
    });
  }
  static async connect(endpoint) {
    checkOpen();
    const ws = new WebSocket(endpoint);
    ownedSockets.add(ws);
    ws.addEventListener('close', () => ownedSockets.delete(ws), { once: true });
    await bounded(() => new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); }), 5_000, 'CDP websocket open');
    checkOpen();
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 5_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

async function attachBrowser(endpoint) {
  checkOpen();
  const connecting = chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 5_000 });
  pendingConnections.add(connecting);
  connecting.then(value => { ownedBrowsers.add(value); }, () => {}).finally(() => pendingConnections.delete(connecting));
  const connected = await bounded(() => connecting, 7_000, 'Playwright connect');
  checkOpen();
  return connected;
}
async function closeBrowser(value, errors, label) {
  if (!value) return;
  await attemptCleanup(errors, label, () => value.close(), 3_000);
}
async function main() {
  await bounded(() => new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); }), 3_000, 'HTTP server listen');
  const baseURL = `http://127.0.0.1:${app.address().port}`;
  chrome = spawn(process.env.CHROME_BIN, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
  result.chromiumLaunches++;
  chrome.once('error', error => { spawnError = error; });
  chrome.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_384); });
  const deadline = Date.now() + 12_000;
  let endpoint;
  while (Date.now() < deadline) {
    endpoint = stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
    if (endpoint) break;
    if (spawnError) throw spawnError;
    if (chrome.exitCode !== null || chrome.signalCode !== null) throw new Error(`Chromium exited before readiness: ${stderr}`);
    await sleep(25);
  }
  assert(endpoint, `Chromium did not advertise CDP: ${stderr}`);
  raw = await Cdp.connect(endpoint);
  result.chromium = (await raw.send('Browser.getVersion')).product;
  for (const order of ['native-attached-first', 'playwright-attached-first']) {
    checkOpen();
    // Default-context binding is genuine for both clients. This isolates Fetch
    // coexistence from the already-proved pre-existing isolated-context mismatch.
    const { targetId } = await raw.send('Target.createTarget', { url: 'about:blank' });
    let native;
    let sessionId;
    let context;
    let page;
    const milestones = [];
    const caseCleanupErrors = [];
    let caseRecord;
    const attachNative = async () => {
      native = await Cdp.connect(endpoint);
      ({ sessionId } = await native.send('Target.attachToTarget', { targetId, flatten: true }));
      milestones.push('native-session-attached');
    };
    const attachPlaywright = async () => {
      browser = await attachBrowser(endpoint);
      for (const candidateContext of browser.contexts()) {
        for (const candidate of candidateContext.pages()) {
          const inspection = await candidateContext.newCDPSession(candidate);
          const { targetInfo } = await inspection.send('Target.getTargetInfo');
          await inspection.detach();
          if (targetInfo.targetId === targetId) { context = candidateContext; page = candidate; }
        }
      }
      assert(page && context, 'PW must expose the exact default-context target');
      context.setDefaultTimeout(5_000);
      milestones.push('playwright-page-attached');
    };
    if (order === 'native-attached-first') { await attachNative(); await attachPlaywright(); }
    else { await attachPlaywright(); await attachNative(); }
    const { targetInfo } = await native.send('Target.getTargetInfo', { targetId });
    const url = `${baseURL}/headers?case=${order}`;
    const events = [];
    const handlerErrors = [];
    const inFlight = new Set();
    let nativeCount = 0;
    let playwrightCount = 0;
    const listener = event => {
      if (event.sessionId !== sessionId || event.method !== 'Fetch.requestPaused') return;
      const { requestId, request, networkId } = event.params;
      const matches = request.url === url;
      if (matches) { nativeCount++; events.push({ actor: 'native-style-fetch', requestId, networkId: networkId ?? null }); }
      const headers = Object.entries({ ...request.headers, ...(matches ? { 'x-fixture-header': 'through-the-route' } : {}) }).map(([name, value]) => ({ name, value: String(value) }));
      const work = native.send('Fetch.continueRequest', { requestId, headers }, sessionId).catch(error => handlerErrors.push(String(error))).finally(() => inFlight.delete(work));
      inFlight.add(work);
    };
    native.listeners.add(listener);
    const nativeEnable = async () => {
      await native.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }], handleAuthRequests: true }, sessionId);
      milestones.push('native-fetch-enabled');
    };
    const playwrightEnable = async () => {
      await context.route('**/headers?case=*', async route => {
        if (route.request().url() === url) { playwrightCount++; events.push({ actor: 'playwright-route' }); }
        await route.fallback();
      });
      milestones.push('playwright-route-enabled');
    };
    try {
      if (order === 'native-attached-first') { await nativeEnable(); await playwrightEnable(); }
      else { await playwrightEnable(); await nativeEnable(); }
      // Native-style navigation must complete through the real asynchronous PW handler.
      // Attach a rejection handler immediately so a failed navigate cannot orphan it.
      const responsePromise = page.waitForResponse(response => response.url() === url).then(response => ({ response }), error => ({ error }));
      await native.send('Page.navigate', { url }, sessionId);
      const responseResult = await responsePromise;
      if (responseResult.error) throw responseResult.error;
      const body = await responseResult.response.json();
      await Promise.all([...inFlight]);
      const serverCount = requests.filter(request => request.case === order).length;
      const originalWitnessSatisfied = body.header === 'through-the-route' && nativeCount === 1 && playwrightCount === 1 && serverCount === 1 && handlerErrors.length === 0;
      caseRecord = { name: order, navigationCompleted: true, originalWitnessSatisfied, contextId: targetInfo.browserContextId, targetId, nativeCount, playwrightCount, serverCount, body, handlerErrors, milestones, events };
      result.cases.push(caseRecord);
    } catch (error) {
      caseRecord = { name: order, navigationCompleted: false, originalWitnessSatisfied: false, failure: String(error?.stack ?? error), nativeCount, playwrightCount, serverReceipts: requests.filter(request => request.case === order), handlerErrors, milestones, events };
      result.cases.push(caseRecord);
    } finally {
      await native.send('Fetch.disable', {}, sessionId).catch(() => {});
      await attemptCleanup(caseCleanupErrors, 'case Fetch continuations', () => Promise.all([...inFlight]));
      native.listeners.delete(listener);
      await native.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      try { native.ws.close(); } catch (error) { caseCleanupErrors.push(String(error)); }
      await closeBrowser(browser, caseCleanupErrors, 'case PW close'); browser = undefined;
      await attemptCleanup(caseCleanupErrors, 'case target close', () => raw.send('Target.closeTarget', { targetId }), 5_500);
      if (caseRecord) caseRecord.cleanupErrors = caseCleanupErrors;
    }
  }
}
try {
  await bounded(main, 45_000, 'whole measurement');
} catch (error) {
  result.failure = String(error?.stack ?? error);
} finally {
  closing = true;
  const errors = [];
  // No throwing cleanup operation may skip process reap or the final evidence.
  for (const value of ownedBrowsers) await closeBrowser(value, errors, 'final PW close');
  if (raw) await attemptCleanup(errors, 'owned Browser.close', () => raw.send('Browser.close'), 5_500);
  for (const socket of [...ownedSockets]) {
    try { socket.close(); } catch (error) { errors.push(`CDP close: ${String(error)}`); }
  }
  const exited = () => !chrome || spawnError !== undefined || chrome.exitCode !== null || chrome.signalCode !== null;
  const waitExit = async ms => {
    const deadline = Date.now() + ms;
    while (!exited() && Date.now() < deadline) await sleep(25);
    return exited();
  };
  const signalOwned = signal => {
    if (!chrome || exited()) return;
    try {
      if (process.platform !== 'win32') process.kill(-chrome.pid, signal);
      else chrome.kill(signal);
    } catch (error) { if (error.code !== 'ESRCH') errors.push(`owned process ${signal}: ${String(error)}`); }
  };
  if (!(await waitExit(2_000))) { signalOwned('SIGTERM'); await waitExit(2_000); }
  if (!exited()) { signalOwned('SIGKILL'); await waitExit(2_000); }
  if (!exited()) errors.push('Owned Chromium did not exit after SIGKILL; preserving its profile');
  // Chrome termination also settles connecting PW clients and websocket close handshakes.
  await attemptCleanup(errors, 'pending PW connections', () => Promise.allSettled([...pendingConnections]), 3_000);
  const socketDeadline = Date.now() + 2_000;
  while (ownedSockets.size > 0 && Date.now() < socketDeadline) await sleep(25);
  for (const socket of serverSockets) socket.destroy();
  await attemptCleanup(errors, 'HTTP server close', () => new Promise(resolve => app.close(resolve)), 3_000);
  const serverDeadline = Date.now() + 1_000;
  while (serverSockets.size > 0 && Date.now() < serverDeadline) await sleep(25);
  let profileRemoved = false;
  if (exited()) profileRemoved = await attemptCleanup(errors, 'profile removal', () => rm(profile, { recursive: true, force: true }), 3_000);
  const playwrightDisconnected = [...ownedBrowsers].every(value => !value.isConnected());
  result.cleanup = {
    ownedChromiumExited: exited(), exitCode: chrome?.exitCode ?? null, signal: chrome?.signalCode ?? null,
    cdpSocketsClosed: ownedSockets.size === 0, playwrightDisconnected,
    pendingConnectionsSettled: pendingConnections.size === 0,
    serverClosed: !app.listening && serverSockets.size === 0,
    profileRemoved, ...(profileRemoved ? {} : { preservedProfile: profile }), errors,
  };
  // Exit reports complete measurement/resource closure, not compatibility.
  const complete = !result.failure && result.cases.length === 2
    && result.cleanup.ownedChromiumExited && result.cleanup.cdpSocketsClosed
    && result.cleanup.playwrightDisconnected && result.cleanup.pendingConnectionsSettled
    && result.cleanup.serverClosed && result.cleanup.profileRemoved
    && !result.cases.some(item => item.cleanupErrors?.length) && errors.length === 0;
  process.stdout.write(JSON.stringify(result, null, 2) + '\n', () => process.exit(complete ? 0 : 1));
}
