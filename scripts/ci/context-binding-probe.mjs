// Standalone feasibility probe; not an E2E or exact-native acceptance test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const packagePath = process.env.PW_PACKAGE ?? '/workspace/shared/e2e-native-first/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core';
const { chromium } = await import(pathToFileURL(join(packagePath, 'index.mjs')).href);
const packageInfo = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
assert.equal(packageInfo.version, '1.64.1', 'This source-backed probe is pinned to playwright-core 1.64.1');
const profile = await mkdtemp(join(tmpdir(), 'surface-context-probe-'));
const chrome = spawn(process.env.CHROME_BIN ?? '/usr/bin/chromium', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
chrome.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_384); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = { node: process.version, playwright: packageInfo.version, chromiumLaunches: 1, cases: [] };
let raw;
let browser;
let successful = false;
const requiredCases = ['naive-attach-context-mismatch', 'real-context-rendezvous-feasibility', 'cross-client-viewport-cache-divergence', 'native-style-context-disposal-retires-pages'];
async function bounded(promise, stage, cancel = () => {}) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => { try { cancel(); } catch {} reject(new Error(`Probe timeout: ${stage}`)); }, 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

class Cdp {
  next = 0;
  pending = new Map();
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener('message', event => {
      const value = JSON.parse(event.data);
      if (!value.id) return;
      const entry = this.pending.get(value.id);
      if (!entry) return;
      this.pending.delete(value.id);
      clearTimeout(entry.timeout);
      if (value.error) entry.reject(new Error(JSON.stringify(value.error)));
      else entry.resolve(value.result);
    });
    ws.addEventListener('close', () => {
      for (const entry of this.pending.values()) { clearTimeout(entry.timeout); entry.reject(new Error('CDP disconnected')); }
      this.pending.clear();
    });
  }
  static async connect(endpoint) {
    const ws = new WebSocket(endpoint);
    await bounded(new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); }), 'initial CDP connect', () => ws.close());
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

async function targetInfo(context, page) {
  const session = await context.newCDPSession(page);
  try { return (await session.send('Target.getTargetInfo')).targetInfo; }
  finally { await session.detach(); }
}

try {
  const deadline = Date.now() + 12_000;
  let endpoint;
  while (Date.now() < deadline) {
    endpoint = stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
    if (endpoint) break;
    if (chrome.exitCode !== null || chrome.signalCode !== null) throw new Error(`Chromium exited before CDP readiness: exit=${chrome.exitCode} signal=${chrome.signalCode}; stderr=${stderr}`);
    await sleep(25);
  }
  if (!endpoint) throw new Error(`Chromium did not advertise CDP; stderr=${stderr}`);
  raw = await Cdp.connect(endpoint);
  result.chromium = (await raw.send('Browser.getVersion')).product;

  // Case A: native-style owner creates an isolated context before PW attaches.
  const { browserContextId: nativeContextId } = await raw.send('Target.createBrowserContext');
  const { targetId: nativeTargetId } = await raw.send('Target.createTarget', { url: 'about:blank', browserContextId: nativeContextId });
  await raw.send('Storage.setCookies', { browserContextId: nativeContextId, cookies: [{ name: 'binding_probe', value: 'isolated', domain: 'probe.invalid', path: '/' }] });
  browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 5_000 });
  const naiveContext = browser.contexts()[0];
  assert(naiveContext);
  naiveContext.setDefaultTimeout(5_000);
  let nativePage;
  for (const page of naiveContext.pages()) {
    const info = await targetInfo(naiveContext, page);
    if (info.targetId === nativeTargetId) nativePage = page;
  }
  assert(nativePage, 'PW did not expose the native-created target');
  const cookieViaWrapper = (await naiveContext.cookies()).find(cookie => cookie.name === 'binding_probe');
  const wrongNewPage = await naiveContext.newPage();
  const wrongNewTarget = await targetInfo(naiveContext, wrongNewPage);
  const mismatch = cookieViaWrapper === undefined && wrongNewTarget.browserContextId !== nativeContextId;
  assert(mismatch, 'Expected the statically identified native isolated-context mismatch');
  result.cases.push({ name: 'naive-attach-context-mismatch', pass: true, nativeContextId, nativeTargetId, wrapperHasNativePage: true, wrapperCookieFound: false, wrapperNewPageContextId: wrongNewTarget.browserContextId });
  await wrongNewPage.close();
  await bounded(browser.close(), 'naive PW disconnect'); browser = undefined;
  assert.equal((await raw.send('Target.getTargetInfo', { targetId: nativeTargetId })).targetInfo.targetId, nativeTargetId);
  await raw.send('Target.disposeBrowserContext', { browserContextId: nativeContextId });

  // Case B: PW creates a genuine isolated context; the raw owner adopts exact IDs.
  // A production rendezvous would let native authorize/journal this creation before publication.
  browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 5_000 });
  const context = await browser.newContext({ viewport: { width: 801, height: 601 } });
  context.setDefaultTimeout(5_000);
  const page = await context.newPage();
  const identity = await targetInfo(context, page);
  const allContexts = await raw.send('Target.getBrowserContexts');
  assert(allContexts.browserContextIds.includes(identity.browserContextId));
  const { sessionId } = await raw.send('Target.attachToTarget', { targetId: identity.targetId, flatten: true });
  await page.setContent('<button id="change" onclick="window.count=(window.count||0)+1">Change</button>');
  await page.getByRole('button', { name: 'Change' }).click();
  const fromRaw = await raw.send('Runtime.evaluate', { expression: 'window.count', returnByValue: true }, sessionId);
  assert.equal(fromRaw.result.value, 1);
  await raw.send('Runtime.evaluate', { expression: 'window.fromRaw = "same-document"', returnByValue: true }, sessionId);
  assert.equal(await page.evaluate(() => window.fromRaw), 'same-document');
  await context.addCookies([{ name: 'binding_probe', value: 'rendezvous', domain: 'probe.invalid', path: '/' }]);
  assert.equal((await raw.send('Storage.getCookies', { browserContextId: identity.browserContextId })).cookies.find(cookie => cookie.name === 'binding_probe')?.value, 'rendezvous');
  const other = await context.newPage();
  const otherIdentity = await targetInfo(context, other);
  assert.equal(otherIdentity.browserContextId, identity.browserContextId);
  assert.notEqual(otherIdentity.targetId, identity.targetId);
  assert.equal(page.context(), context);
  result.cases.push({ name: 'real-context-rendezvous-feasibility', pass: true, contextId: identity.browserContextId, selectedTargetId: identity.targetId, siblingTargetId: otherIdentity.targetId, bidirectionalDocumentState: true, cookieIsolation: true, realPageContextIdentity: true });

  // Source-backed concern check: raw viewport changes do not update PW synchronous cache.
  await raw.send('Emulation.setDeviceMetricsOverride', { width: 913, height: 713, deviceScaleFactor: 1, mobile: false }, sessionId);
  const actualViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const cachedViewport = page.viewportSize();
  assert.deepEqual(actualViewport, { width: 913, height: 713 });
  assert.deepEqual(cachedViewport, { width: 801, height: 601 });
  result.cases.push({ name: 'cross-client-viewport-cache-divergence', pass: true, actualViewport, cachedViewport });

  const closed = Promise.all([page.waitForEvent('close'), other.waitForEvent('close')]);
  await raw.send('Target.disposeBrowserContext', { browserContextId: identity.browserContextId });
  await closed;
  assert(page.isClosed() && other.isClosed());
  let oldMutationRejected = false;
  try { await page.evaluate(() => window.fromRaw = 'late'); } catch { oldMutationRejected = true; }
  assert(oldMutationRejected);
  result.cases.push({ name: 'native-style-context-disposal-retires-pages', pass: true, oldMutationRejected, chromiumOwnerStillConnected: !!(await raw.send('Browser.getVersion')).product });
  successful = true;
} catch (error) {
  result.failure = String(error?.stack ?? error);
} finally {
  if (browser) await bounded(browser.close(), 'final PW disconnect').catch(error => { result.cleanupFailure = String(error); });
  if (raw) { await raw.send('Browser.close').catch(() => {}); try { raw.ws.close(); } catch (error) { result.cleanupFailure = String(error); } }
  for (let i = 0; i < 80 && chrome.exitCode === null && chrome.signalCode === null; i++) await sleep(25);
  if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGTERM');
  for (let i = 0; i < 80 && chrome.exitCode === null && chrome.signalCode === null; i++) await sleep(25);
  if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL');
  for (let i = 0; i < 200 && chrome.exitCode === null && chrome.signalCode === null; i++) await sleep(25);
  result.cleanup = { ownedChromiumExited: chrome.exitCode !== null || chrome.signalCode !== null, exitCode: chrome.exitCode, signal: chrome.signalCode };
  if (result.cleanup.ownedChromiumExited) await rm(profile, { recursive: true, force: true });
  console.log(JSON.stringify(result, null, 2));
  const allCasesPassed = result.cases.length === requiredCases.length && result.cases.every((entry, index) => entry.name === requiredCases[index] && entry.pass === true);
  process.exitCode = successful && allCasesPassed && result.cleanup.ownedChromiumExited && result.cleanupFailure === undefined ? 0 : 1;
}
