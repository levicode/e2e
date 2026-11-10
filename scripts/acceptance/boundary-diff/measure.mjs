#!/usr/bin/env node
/**
 * One boundary-diff measurement case.
 *
 * Compares the old Playwright 1.64.1 driver with the native agent-browser Web
 * engine on the same Chromium build for #23's six capacity/budget families.
 * Each case runs in its own process (see run.mjs), so one hang cannot take the
 * table down with it.
 *
 * Usage: node measure.mjs --case <id> --engine new|old
 *
 * Requires the built packages (`pnpm --filter e2e run build` and
 * `pnpm --filter @e2e-dev/web run build`) plus a trusted native build in
 * E2E_AGENT_BROWSER_EXECUTABLE. Set BOUNDARY_DIFF_CHROMIUM to the Chromium
 * executable both engines must use; when unset the harness uses Playwright's
 * own Chromium for the old engine and whatever the native runtime resolves for
 * the new one.
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CASES, MiB } from './cases.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const requireWeb = createRequire(resolve(ROOT, 'packages/web/package.json'));

const args = process.argv.slice(2);
const argument = (name) => { const index = args.indexOf(`--${name}`); return index === -1 ? undefined : args[index + 1]; };
const CASE = argument('case');
const ENGINE = argument('engine');
if (CASE === undefined || (ENGINE !== 'new' && ENGINE !== 'old')) {
  console.error('usage: node measure.mjs --case <id> --engine new|old');
  process.exit(2);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const summarize = (error) => ({ status: 'fail', code: error?.code ?? error?.name ?? 'unknown', message: String(error?.message ?? error).split('\n')[0].slice(0, 240) });
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

/** A local app with the bodies, downloads, and page triggers every case reads. */
async function appServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const size = Number(url.searchParams.get('n') ?? 0);
    if (url.pathname === '/big') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(size) });
      response.end(Buffer.alloc(size, 0x61));
      return;
    }
    if (url.pathname === '/dl') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="big.bin"', 'content-length': String(size) });
      response.end(Buffer.alloc(size, 0x61));
      return;
    }
    if (url.pathname === '/slow-fetch') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('slow-ok');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>boundary</title><body><h1 id="t">hello</h1></body>');
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** The native engine opened the way a worker opens it, plus the public browser fixture over it. */
async function newSession(base) {
  const { web } = await import(pathToFileURL(resolve(ROOT, 'packages/web/dist/index.js')).href);
  const executable = process.env['E2E_AGENT_BROWSER_EXECUTABLE'];
  if (executable === undefined || executable.length === 0) throw new Error('E2E_AGENT_BROWSER_EXECUTABLE must name a trusted native build');
  const engine = web();
  const signal = new AbortController().signal;
  const artifactsDir = mkdtempSync(join(tmpdir(), 'boundary-diff-'));
  const env = {
    ...process.env,
    E2E_AGENT_BROWSER_EXECUTABLE: executable,
    AGENT_BROWSER_SOCKET_DIR: `/tmp/boundary-diff-${process.pid}`,
    ...(process.env['BOUNDARY_DIFF_CHROMIUM'] === undefined ? {} : { AGENT_BROWSER_EXECUTABLE_PATH: process.env['BOUNDARY_DIFF_CHROMIUM'] }),
  };
  const op = (timeoutMs = 60_000) => ({ signal, timeoutMs, runId: 'boundary-diff', attemptId: 'boundary-diff', origin: 'test' });
  await engine.init({ runId: 'boundary-diff', targetName: 'web', projectRoot: ROOT, app: { site: '127.0.0.1' }, env, headed: false, workerSlot: 0, log: () => {}, signal });
  await engine.startAttempt({ attemptId: 'boundary-diff', artifactsDir, signal, resolveSecret: () => Promise.reject(new Error('this attempt declares no secrets')), appLog: () => {}, screen: () => {}, environment: () => {}, navigation: () => {} });
  const context = {
    targetName: 'web',
    fixture: (_name, target) => target,
    expectable: (target) => target,
    app: { site: '127.0.0.1', resolveUrl: (url) => new URL(url, `${base}/`).toString() },
    timeouts: { test: 60_000, action: 60_000, assertion: 60_000 },
    signal,
    operation: op,
    attachArtifact: () => {},
    attachViewport: () => {},
    locator: () => { throw new Error('this harness does not use locators'); },
    screen: () => { throw new Error('this harness does not use screens'); },
  };
  const browser = engine.fixtures.browser(context);
  const session = {
    kind: 'new', engine, browser, artifactsDir, op,
    evaluate: (fn, value) => value === undefined ? browser.evaluate(fn) : browser.evaluate(fn, value),
    goto: (url, options) => browser.goto(new URL(url, `${base}/`).toString(), options),
    addInitScript: (source) => browser.addInitScript(source),
    route: (pattern, handler) => browser.route(pattern, handler),
    onDialog: (handler) => browser.onDialog(handler),
    async usable() { try { await browser.evaluate(() => 1); return true; } catch { return false; } },
    async cleanup() {
      const out = { endAttempt: 'ok', dispose: 'ok' };
      try { await engine.endAttempt({ signal, timeoutMs: 20_000 }); } catch (error) { out.endAttempt = `${error?.code ?? 'unknown'}: ${String(error?.message).split('\n')[0].slice(0, 160)}`; }
      try { await engine.dispose({ signal, timeoutMs: 20_000 }); } catch (error) { out.dispose = `${error?.code ?? 'unknown'}: ${String(error?.message).split('\n')[0].slice(0, 160)}`; }
      try { rmSync(artifactsDir, { recursive: true, force: true }); } catch {}
      return out;
    },
  };
  session.addScripts = async (count, make) => { for (let index = 0; index < count; index += 1) await session.addInitScript(make(index)); };
  session.readResponseBody = async (size) => {
    const waiter = browser.waitForResponse('**/big*', { timeout: 60_000 });
    await sleep(300);
    await browser.evaluate((n) => { fetch('/big?n=' + n); }, size);
    const response = await waiter;
    return `body=${(await response.text()).length}`;
  };
  session.download = async (mib) => {
    const download = await browser.waitForDownload(async () => {
      await browser.evaluate((n) => {
        const anchor = document.createElement('a');
        anchor.href = '/dl?n=' + n;
        anchor.download = 'big.bin';
        document.body.appendChild(anchor);
        anchor.click();
      }, mib * MiB);
    }, { timeout: 120_000 });
    return { bytes: statSync(download.absolutePath).size };
  };
  session.captureState = async (fill) => {
    if (fill.localStorage !== undefined) {
      await browser.evaluate((n) => { localStorage.setItem('big', 'x'.repeat(n)); return localStorage.getItem('big').length; }, fill.localStorage);
    } else {
      await browser.evaluate((n) => {
        return new Promise((done, reject) => {
          const open = indexedDB.open('boundary-diff', 1);
          open.addEventListener('upgradeneeded', () => open.result.createObjectStore('state'));
          open.addEventListener('error', () => reject(open.error));
          open.addEventListener('success', () => {
            const database = open.result;
            const transaction = database.transaction('state', 'readwrite');
            transaction.objectStore('state').put('x'.repeat(n), 'big');
            transaction.addEventListener('complete', () => { database.close(); done(n); });
            transaction.addEventListener('error', () => reject(transaction.error));
          });
        });
      }, fill.indexedDb);
    }
    const state = await engine.state.capture(op());
    return `state=${bytes(state.data)}B`;
  };
  session.recordVideo = async (ms) => {
    await engine.artifacts.startVideo(op());
    await sleep(ms);
    const segments = await engine.artifacts.stopVideo(op(60_000));
    const files = segments.map((segment) => statSync(join(artifactsDir, segment.path)).size);
    return `segments=${segments.length} bytes=${files.join('+')}`;
  };
  return session;
}

/** Old Playwright 1.64.1 on the same Chromium: the baseline this repository replaced. */
async function oldSession(base, { video = false } = {}) {
  const entry = join(dirname(requireWeb.resolve('playwright-core')), 'index.mjs');
  const playwright = await import(pathToFileURL(entry).href);
  const chromiumPath = process.env['BOUNDARY_DIFF_CHROMIUM'] ?? playwright.chromium.executablePath();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath, headless: true });
  const tempDirs = [];
  const videoDir = video ? mkdtempSync(join(tmpdir(), 'boundary-diff-video-')) : undefined;
  if (videoDir !== undefined) tempDirs.push(videoDir);
  const contextOptions = videoDir === undefined ? {} : { recordVideo: { dir: videoDir } };
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const session = {
    kind: 'old', page, context, browser, videoDir,
    evaluate: (fn, value) => value === undefined ? page.evaluate(fn) : page.evaluate(fn, value),
    goto: (url, options) => page.goto(new URL(url, `${base}/`).toString(), options),
    addInitScript: (source) => context.addInitScript(source),
    route: (pattern, handler) => page.route(pattern, handler),
    onDialog: (handler) => { page.on('dialog', handler); },
    async usable() { try { await page.evaluate(() => 1); return true; } catch { return false; } },
    async cleanup() {
      const out = { context: 'ok', browser: 'ok' };
      try { await context.close(); } catch (error) { out.context = String(error?.message).split('\n')[0].slice(0, 160); }
      try { await browser.close(); } catch (error) { out.browser = String(error?.message).split('\n')[0].slice(0, 160); }
      for (const directory of tempDirs) { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
      return out;
    },
  };
  session.addScripts = async (count, make) => { for (let index = 0; index < count; index += 1) await session.addInitScript(make(index)); };
  session.readResponseBody = async (size) => {
    const waiter = page.waitForResponse('**/big*', { timeout: 60_000 });
    await sleep(300);
    await page.evaluate((n) => { fetch('/big?n=' + n); }, size);
    const response = await waiter;
    return `body=${(await response.body()).length}`;
  };
  session.download = async (mib) => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      page.evaluate((n) => {
        const anchor = document.createElement('a');
        anchor.href = '/dl?n=' + n;
        anchor.download = 'big.bin';
        document.body.appendChild(anchor);
        anchor.click();
      }, mib * MiB),
    ]);
    const directory = mkdtempSync(join(tmpdir(), 'boundary-diff-dl-'));
    tempDirs.push(directory);
    const target = join(directory, 'big.bin');
    await download.saveAs(target);
    return { bytes: statSync(target).size };
  };
  session.captureState = async (fill) => {
    if (fill.localStorage !== undefined) {
      await page.evaluate((n) => { localStorage.setItem('big', 'x'.repeat(n)); }, fill.localStorage);
    } else {
      await page.evaluate((n) => {
        return new Promise((done, reject) => {
          const open = indexedDB.open('boundary-diff', 1);
          open.addEventListener('upgradeneeded', () => open.result.createObjectStore('state'));
          open.addEventListener('error', () => reject(open.error));
          open.addEventListener('success', () => {
            const database = open.result;
            const transaction = database.transaction('state', 'readwrite');
            transaction.objectStore('state').put('x'.repeat(n), 'big');
            transaction.addEventListener('complete', () => { database.close(); done(n); });
            transaction.addEventListener('error', () => reject(transaction.error));
          });
        });
      }, fill.indexedDb);
    }
    const state = await context.storageState();
    return `state=${bytes(state)}B indexedDb=${JSON.stringify(state).includes('boundary-diff')}`;
  };
  session.recordVideo = async (ms) => {
    await sleep(ms);
    await context.close();
    const files = readdirSync(videoDir).filter((file) => file.endsWith('.webm')).map((file) => statSync(join(videoDir, file)).size);
    return `segments=${files.length} bytes=${files.join('+')}`;
  };
  return session;
}


const { server, base } = await appServer();
const definition = CASES[CASE];
const result = { case: CASE, engine: ENGINE, family: definition.family, scenario: definition.scenario };
const session = ENGINE === 'new' ? await newSession(base) : await oldSession(base, { video: definition.video === true });
const started = Date.now();
try {
  await session.goto('/');
  const value = await definition.run(session);
  result.outcome = { status: 'ok', value: value === undefined ? 'ok' : typeof value === 'string' ? value : JSON.stringify(value), ms: Date.now() - started };
} catch (error) {
  result.outcome = { ...summarize(error), ms: Date.now() - started };
}
result.usable = await session.usable();
result.cleanup = await session.cleanup();
server.closeAllConnections();
await new Promise((done) => server.close(done));
await new Promise((done) => process.stdout.write(`RESULT:${JSON.stringify(result)}\n`, done));
process.exit(0);
