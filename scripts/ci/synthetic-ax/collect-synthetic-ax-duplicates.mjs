// CI-only, single fresh synthetic page. Never attach to an existing browser.
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { summarizeAX } from './ax-duplicate-summary.mjs';
const expectedChrome = '8ea0ecbfc1ac0dc0e957de722babf9b72f8e86cb8643308ff17a491d59bdaa80';
const origin = 'http://127.0.0.1:4271';
const result = { schemaVersion: 1, kind: 'synthetic-single-page-ax-duplicate-control', outcome: 'failed', failureStage: 'admission', cleanupComplete: false };
let stage = 'admission', browser, context, server;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fileHash(file) { const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex'); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms = 12_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function main() {
  if (process.env.CI !== 'true' || process.env.AX_SYNTHETIC_DIAGNOSTIC !== '1') throw new Error('admission');
  delete process.env.DEBUG; delete process.env.PWDEBUG;
  const root = process.cwd();
  if (!/^[a-f0-9]{40}$/.test(process.env.E2E_SOURCE_SHA ?? '') || !/^[a-f0-9]{40}$/.test(process.env.E2E_SOURCE_TREE ?? '')) throw new Error('source');
  stage = 'source-pin';
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const sha = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  if (sha !== process.env.E2E_SOURCE_SHA || tree !== process.env.E2E_SOURCE_TREE || git('status', '--porcelain', '--untracked-files=no', '--', 'apps/testbed/app') !== '') throw new Error('source');
  const fixture = path.join(root, 'apps/testbed/app/pages/controls.mjs');
  result.sourceSha = sha; result.sourceTree = tree; result.fixtureSha256 = await fileHash(fixture);
  stage = 'chrome-pin';
  const executablePath = process.env.AX_CHROME_EXECUTABLE;
  if (!executablePath || !path.isAbsolute(executablePath) || await fileHash(executablePath) !== expectedChrome) throw new Error('chrome');
  result.chromeSha256 = expectedChrome;
  stage = 'playwright-pin';
  const require = createRequire(path.join(root, 'packages/web/package.json'));
  const playwrightPackage = require('playwright-core/package.json');
  if (playwrightPackage.version !== '1.64.1') throw new Error('playwright');
  result.playwrightVersion = '1.64.1';
  const { chromium } = require('playwright-core');
  stage = 'owned-server-start';
  server = spawn(process.execPath, ['app/server.mjs'], { cwd: path.join(root, 'apps/testbed'), env: { ...process.env, PORT: '4271' }, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error('server-timeout')), 10_000);
    const stop = () => { clearTimeout(timer); reject(new Error('server')); };
    server.once('error', stop); server.once('exit', stop);
    server.stdout.on('data', chunk => {
      text += chunk.toString();
      if (text.length > 1024) { clearTimeout(timer); reject(new Error('server-output')); }
      if (text.includes('playground listening on http://127.0.0.1:4271')) { clearTimeout(timer); resolve(); }
    });
  });
  stage = 'owned-browser-start';
  browser = await chromium.launch({ executablePath, headless: true, timeout: 15_000, args: ['--no-sandbox'] });
  if (browser.version() !== '156.0.8078.73') throw new Error('version');
  result.chromeVersion = '156.0.8078.73';
  context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === origin ? route.continue() : route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  stage = 'fixture-navigation';
  await page.goto(`${origin}/controls`, { waitUntil: 'load', timeout: 12_000 });
  if (page.url() !== `${origin}/controls` || page.frames().length !== 1) throw new Error('fixture');
  const menu = page.getByRole('menu', { name: 'File actions', includeHidden: true });
  if (await menu.isVisible()) throw new Error('initial-state');
  const cdp = await context.newCDPSession(page);
  const frameReply = await bounded(cdp.send('Page.getFrameTree'));
  const frameId = frameReply?.frameTree?.frame?.id;
  if (typeof frameId !== 'string' || !frameId) throw new Error('frame');
  stage = 'before-ax';
  result.before = summarizeAX(await bounded(cdp.send('Accessibility.getFullAXTree', { frameId })));
  stage = 'single-original-secondary-click';
  await page.getByText('report.pdf', { exact: true }).click({ button: 'right', timeout: 12_000 });
  stage = 'opened-state';
  if (!await menu.isVisible() || await page.getByRole('status', { name: 'File state' }).textContent() !== 'menu open') throw new Error('opened-state');
  if (page.url() !== `${origin}/controls` || page.frames().length !== 1) throw new Error('frame');
  const afterFrame = await bounded(cdp.send('Page.getFrameTree'));
  if (afterFrame?.frameTree?.frame?.id !== frameId) throw new Error('frame-changed');
  result.menuOpened = true; result.sameFrame = true; result.secondaryClickCount = 1;
  stage = 'after-ax';
  result.after = summarizeAX(await bounded(cdp.send('Accessibility.getFullAXTree', { frameId })));
  stage = 'synthetic-screenshot-summary';
  const png = await page.screenshot({ type: 'png', timeout: 12_000 });
  result.screenshotSummary = { sha256: hash(png), viewportWidth: 1280, viewportHeight: 720, saved: false };
  result.outcome = result.after.duplicateRows === 0 ? 'not-reproduced' : result.after.conflictingRows === 0 ? 'parsed-identical-duplicates' : 'conflicting-duplicates';
  delete result.failureStage;
}
try { await main(); } catch { result.outcome = 'failed'; result.failureStage = stage; }
finally {
  let clean = true;
  try { if (context) await bounded(context.close(), 8000); } catch { clean = false; }
  try { if (browser) await bounded(browser.close(), 8000); } catch { clean = false; }
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(2000)]);
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(2000)]); }
    if (server.exitCode === null && server.signalCode === null) clean = false;
  }
  result.cleanupComplete = clean;
  if (!clean) { result.outcome = 'failed'; result.failureStage = 'cleanup'; }
  // Only this closed constructed object is emitted; never print Error/CDP/page data.
  const output = JSON.stringify(result, null, 2) + '\n';
  process.stdout.write(output);
  if (result.outcome === 'failed') process.exitCode = 1;
}
