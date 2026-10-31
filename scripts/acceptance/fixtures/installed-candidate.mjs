/** Runs only from the clean installed consumer project, never the monorepo graph. */
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve as resolvePath } from 'node:path';
import { openHost, run } from 'e2e/runner';
import { web, surfaceOf } from '@e2e-dev/web';

assert.equal(process.env.E2E_AGENT_BROWSER_EXECUTABLE, undefined, 'Must use the installed verified runtime descriptor');
assert.equal(process.env.NODE_PATH, undefined);
assert.equal(process.env.NODE_OPTIONS, undefined);
const stateReports = new Map();
const stateRequests = [];
const stateApp = `<!doctype html><link rel="icon" href="data:,"><script>
(async () => {
  const phase = new URL(location.href).searchParams.get('phase');
  const first = { cookie: document.cookie, local: localStorage.getItem('native-fixture') };
  try {
    if (phase === 'seed') { document.cookie = 'native-fixture=synthetic; Path=/; SameSite=Lax'; localStorage.setItem('native-fixture', 'stored'); }
    let created = false;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('native-roundtrip', phase === 'seed' ? 3 : undefined);
      request.onupgradeneeded = () => { created = true; const store = request.result.createObjectStore('records', { keyPath: 'id' }); store.createIndex('byLabel', 'label', { unique: true }); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    if (phase === 'seed') {
      const record = { id: 'main', label: 'persisted', typed: new Uint16Array([1, 65535]), blob: new Blob(['fixture-payload'], { type: 'text/plain' }) }; record.self = record;
      await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(record); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    }
    const store = db.transaction('records').objectStore('records');
    const value = await new Promise((resolve, reject) => { const request = store.index('byLabel').get('persisted'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const report = { phase, first, created, version: db.version, indexes: Array.from(store.indexNames), record: value ? { cycle: value.self === value, typedKind: value.typed.constructor.name, typed: Array.from(value.typed), blob: await value.blob.text(), blobType: value.blob.type } : null };
    db.close();
    await fetch('/report', { method: 'POST', body: JSON.stringify(report) });
  } catch (error) { await fetch('/report', { method: 'POST', body: JSON.stringify({ phase, error: String(error) }) }); }
})();
</script>`;
const downloadBytes = Buffer.from('installed\nsynthetic download\u0000\u00ff\n');
const server = createServer((request, response) => {
  stateRequests.push(request.url);
  if (request.url === '/report') {
    let body = '';
    request.on('data', chunk => { body += chunk.toString(); });
    request.on('end', () => { const report = JSON.parse(body); stateReports.set(report.phase, report); response.end('recorded'); });
    return;
  }
  if (request.url?.startsWith('/?phase=')) { response.writeHead(200, { 'content-type': 'text/html' }); response.end(stateApp); return; }
  if (request.url === '/installed.bin') { response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="installed.bin"' }); response.end(downloadBytes); return; }
  if (request.url === '/cache') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Installed cache</title><button onclick="document.querySelector(\'output\').textContent=Number(document.querySelector(\'output\').textContent)+1">Increment</button><output role="status" aria-label="Counter">0</output>'); return; }

  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>Installed native candidate</title><button onclick="this.textContent=\'Saved\'">Save</button><input type="password" value="synthetic-private-value">');
});
await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
const url = `http://127.0.0.1:${server.address().port}`;
let host; let session; let closed = false; let checks = 0;
const coverage = {};
const operation = () => ({ signal: new AbortController().signal, timeoutMs: 15_000, runId: session.runId, attemptId: session.attemptId, origin: 'test' });
async function readState(phase) {
  const deadline = Date.now() + 10_000;
  while (!stateReports.has(phase)) { assert.ok(Date.now() < deadline, `No state report: ${phase}`); await new Promise(done => setTimeout(done, 20)); }
  return stateReports.get(phase);
}
// Decode the actual artifact bytes in the installed browser; no repo PNG helper or extra dependency.
async function pngPixels(browser, pngBytes) {
  return browser.evaluate(async bytes => {
    const image = new Image();
    const objectURL = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    try {
      image.src = objectURL; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const pixel = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
      return { width: image.width, height: image.height, protected: pixel(100, 40), public: pixel(100, 120), fresh: pixel(300, 180) };
    } finally { URL.revokeObjectURL(objectURL); }
  }, [...pngBytes]);
}


/** Retire resources with the existing cleanup-failure precedence. */
async function cleanup() {
  const failures = [];
  if (!closed) {
    try { if (session) failures.push(...await session.close()); } catch (error) { failures.push(error); }
    try { if (host) failures.push(...await host.close()); } catch (error) { failures.push(error); }
  }
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  if (failures.length) throw new AggregateError(failures, 'Installed consumer cleanup failed');
}

try {
  const engine = web({ viewport: { width: 640, height: 480 } });
  host = await openHost({ cwd: process.cwd(), config: { targets: [{ name: 'installed', engine, app: { url } }] } });
  session = await host.openSession({ name: 'installed candidate public browser contract', timeout: 120_000 });
  const { browser, screen, app } = session.fixtures;
  await app.open();
  assert.equal(await browser.title(), 'Installed native candidate');
  const live = surfaceOf(engine);
  assert.ok(live, 'Installed Web must expose its actual Playwright surface');
  const page = live.page(); const context = live.context();
  const browserConnection = context.browser(); assert.ok(browserConnection);
  assert.equal(page.context(), context);
  assert.equal(await page.title(), 'Installed native candidate');
  assert.ok(context.pages().includes(page)); checks++;
  await screen.getByRole('button', { name: 'Save' }).tap();
  assert.equal(await browser.locator('button').textContent(), 'Saved'); checks++;
  await browser.route('**/callback', async route => {
    assert.equal(await browser.title(), 'Installed native candidate');
    await route.fulfill({ body: 'installed callback' });
  });
  assert.equal(await browser.evaluate(() => fetch('/callback').then(response => response.text())), 'installed callback'); checks++;
  await browser.setCookies([{ name: 'candidate', value: 'synthetic', url }]);
  assert.ok((await browser.cookies()).some(cookie => cookie.name === 'candidate' && cookie.value === 'synthetic')); checks++;
  const screenshotPath = resolvePath(session.artifactsDir, await app.screenshot('installed-candidate'));
  const capture = readFileSync(screenshotPath);
  assert.equal(capture.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); checks++;
  // #28: preserve the six original checks; these five are additional installed-graph obligations.
  await browser.evaluate(() => {
    const a = document.createElement('a'); a.id = 'installed-download'; a.href = '/installed.bin'; a.download = 'installed.bin'; a.textContent = 'Download'; document.body.append(a);
  });
  const download = await browser.waitForDownload(() => browser.locator('#installed-download').tap());
  assert.equal(download.suggestedFilename, 'installed.bin');
  assert.deepEqual(readFileSync(download.absolutePath), downloadBytes);
  coverage.download = { suggestedFilename: download.suggestedFilename, absolutePath: download.absolutePath, bytes: downloadBytes.length }; checks++;

  const field = 'position:absolute;left:20px;width:160px;height:40px;border:0;padding:0;background:#f00;color:#f00';
  const content = `<body style="margin:0;background:blue"><input type="password" value="synthetic-private-value" style="${field};top:20px"><input aria-label="Public" value="plain" style="${field};top:100px"></body>`;
  await browser.evaluate(frameHTML => { document.body.innerHTML = ''; const frame = document.createElement('iframe'); frame.srcdoc = frameHTML; frame.style.cssText = 'position:absolute;left:0;top:0;width:400px;height:240px;border:0'; document.body.append(frame); }, content);
  const readyBy = Date.now() + 10_000;
  while (!await browser.evaluate(() => document.querySelector('iframe')?.contentDocument?.querySelector('input')?.value === 'synthetic-private-value')) { assert.ok(Date.now() < readyBy); await new Promise(done => setTimeout(done, 20)); }
  const observed = await engine.observe(operation(), { pixels: true });
  assert.ok(observed.maskedRegionCount >= 1);
  assert.ok(!JSON.stringify(observed.root).includes('synthetic-private-value'));
  const pixels = await pngPixels(browser, observed.pixels.data);
  assert.equal(pixels.width, 640); assert.equal(pixels.height, 480);
  assert.deepEqual(pixels.protected, [0, 0, 0]); assert.deepEqual(pixels.public, [255, 0, 0]);
  await browser.evaluate(() => { document.querySelector('iframe').contentDocument.body.style.background = '#00ff00'; });
  const maskPath = resolvePath(session.artifactsDir, await app.screenshot('installed-mask'));
  const masked = await pngPixels(browser, readFileSync(maskPath));
  assert.equal(masked.width, 640); assert.equal(masked.height, 480);
  assert.deepEqual(masked.protected, [0, 0, 0]); assert.deepEqual(masked.public, [255, 0, 0]); assert.deepEqual(masked.fresh, [0, 255, 0]);
  assert.equal(await browser.evaluate(() => document.querySelector('iframe').contentDocument.querySelector('input').value), 'synthetic-private-value');
  coverage.mask = { path: maskPath, observation: pixels, artifact: masked }; checks++;

  await engine.artifacts.startVideo(operation());
  await browser.evaluate(async () => {
    const started = performance.now();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Video fixture did not paint')), 5_000);
      let frame = 0;
      const paint = () => { document.body.style.backgroundColor = frame++ % 2 ? '#0000ff' : '#00ff00'; if (performance.now() - started >= 1_000) { clearTimeout(timer); resolve(); } else requestAnimationFrame(paint); };
      requestAnimationFrame(paint);
    });
  });
  const segments = await engine.artifacts.stopVideo(operation());
  assert.equal(segments.length, 1);
  const segment = segments[0]; assert.equal(segment.path, 'video/video.webm');
  assert.ok(Number.isFinite(Date.parse(segment.startedAt)));
  const videoPath = resolvePath(session.artifactsDir, segment.path); const video = readFileSync(videoPath);
  assert.ok(video.length > 0); assert.equal(video.subarray(0, 4).toString('hex'), '1a45dfa3');
  const frame = await browser.evaluate(async bytes => {
    const videoElement = document.createElement('video'); videoElement.muted = true;
    const objectURL = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/webm' }));
    try {
      videoElement.src = objectURL;
      await new Promise((resolve, reject) => { videoElement.addEventListener('loadedmetadata', resolve, { once: true }); videoElement.addEventListener('error', () => reject(new Error('Recording did not decode')), { once: true }); });
      await videoElement.play();
      await new Promise(resolve => { videoElement.addEventListener('ended', resolve, { once: true }); setTimeout(resolve, 5_000); });
      const canvas = document.createElement('canvas'); canvas.width = videoElement.videoWidth; canvas.height = videoElement.videoHeight;
      const canvasContext = canvas.getContext('2d'); canvasContext.drawImage(videoElement, 0, 0);
      const { data } = canvasContext.getImageData(0, 0, canvas.width, canvas.height);
      let padded = 0; let inked = 0;
      for (let i = 0; i < data.length; i += 4) { const [r, g, b] = data.slice(i, i + 3); if (r === g && g === b && r > 120 && r < 136) padded++; else if (r < 200 || g < 200 || b < 200) inked++; }
      return { width: canvas.width, height: canvas.height, padded: padded / (data.length / 4), inked: inked / (data.length / 4) };
    } finally { videoElement.pause(); videoElement.removeAttribute('src'); videoElement.load(); URL.revokeObjectURL(objectURL); }
  }, [...video]);
  assert.equal(frame.width, 640); assert.equal(frame.height, 480); assert.ok(frame.padded < 0.01); assert.ok(frame.inked > 0.01);
  coverage.media = { path: videoPath, bytes: video.length, frame }; checks++;

  assert.deepEqual(await session.close(), []);
  assert.equal(page.isClosed(), true, 'Session cleanup must close the actual owned Page');
  assert.equal(session.report()?.run.status, 'passed');
  assert.deepEqual(await host.close(), []);
  assert.equal(browserConnection.isConnected(), false, 'Host cleanup must disconnect the actual browser transport');
  closed = true; checks++;
  coverage.state = await installedState(url); checks++;
  coverage.cache = await installedCache(url); checks++;
  writeFileSync('installed-public-result.json' , JSON.stringify({ status: 'passed', checks, coverage, screenshotPath, runtimeOverrideAbsent: true, publicBrowserActionPassed: true, callbackPassed: true, surfaceOfPassed: true, locateTapPassed: true, cleanupConfirmed: true, report: session.report() }, null, 2));
} finally {
  await cleanup();
}

async function installedCache(appURL) {
  mkdirSync('installed-cache-tests');
  writeFileSync('installed-cache-tests/cache.e2e.ts', `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
test('installed cache replay', async ({ app, agent, screen }) => {
  await app.open('/cache');
  await agent.act('increment the counter twice');
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('2');
});
`);
  writeFileSync('installed-cache-model.mjs', String.raw`import { appendFileSync } from 'node:fs';
let callCounter = 0;
export default {
  specificationVersion: 'v4', provider: 'installed-scripted', modelId: 'installed-cache', supportedUrls: {},
  async doStream() { throw new Error('scripted models do not stream'); },
  async doGenerate(options) {
    appendFileSync('installed-model-calls.log', 'call\n');
    const toolResults = options.prompt.filter(m => m.role === 'tool').flatMap(m => m.content).map(p => typeof p.output?.value === 'string' ? p.output.value : JSON.stringify(p.output?.value)).join('\n');
    let calls;
    if (toolResults.includes('text="2"')) calls = [{ toolName: 'complete_step', input: { status: 'passed', summary: 'incremented twice' } }];
    else {
      if (toolResults) throw new Error('Scripted counter did not reach its end state');
      const prompt = options.prompt.filter(m => m.role === 'user').flatMap(m => m.content).filter(p => p.type === 'text').map(p => p.text).join('\n');
      const line = prompt.split('\n').find(line => line.includes('button "Increment"'));
      const target = /#(\S+)/u.exec(line ?? '')?.[1];
      if (!target) throw new Error('Increment target missing from public model prompt');
      calls = [{ toolName: 'tap', input: { target } }, { toolName: 'tap', input: { target } }];
    }
    return { content: calls.map((c, i) => ({ type: 'tool-call', toolCallId: 'installed_' + (++callCounter), toolName: c.toolName, input: JSON.stringify(c.input) })), finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 }, totalTokens: 120 }, warnings: [] };
  }
};
`);
  writeFileSync('installed-cache.config.ts', `import { web } from '@e2e-dev/web';
import model from './installed-cache-model.mjs';
export default { tests: 'installed-cache-tests/*.e2e.ts', agents: { default: { model } }, cache: 'read-write', retries: 0, targets: [{ name: 'installed', engine: web(), app: { url: ${JSON.stringify(appURL)} } }] };
`);
  const record = await run({ cwd: process.cwd(), config: 'installed-cache.config.ts' });
  assert.equal(record.exitCode, 0); assert.equal(record.status, 'passed');
  const steps = result => result.report.run.results.flatMap(testResult => testResult.attempts).flatMap(attempt => attempt.steps).filter(step => step.api === 'agent.act');
  const [miss] = steps(record); assert.equal(steps(record).length, 1);
  assert.equal(miss.cache.mode, 'missed'); assert.equal(miss.cache.reason, 'no-entry'); assert.ok(miss.metrics.modelCalls > 0);
  const modelCalls = readFileSync('installed-model-calls.log', 'utf8'); assert.ok(modelCalls.length > 0);
  const files = readdirSync('.e2e/cache').filter(file => file.endsWith('.json'));
  assert.equal(files.length, 1);
  const cachePath = resolvePath('.e2e/cache', files[0]); const bytes = readFileSync(cachePath); const mtime = statSync(cachePath).mtimeMs;
  const replay = await run({ cwd: process.cwd(), config: 'installed-cache.config.ts' });
  assert.equal(replay.exitCode, 0); assert.equal(replay.status, 'passed');
  assert.equal(readFileSync('installed-model-calls.log', 'utf8'), modelCalls);
  const [hit] = steps(replay); assert.equal(steps(replay).length, 1);
  assert.equal(hit.status, 'passed'); assert.equal(hit.cache.mode, 'self-finalized');
  assert.equal(hit.cache.replayedActions, 2); assert.equal(hit.cache.totalActions, 2); assert.equal(hit.metrics.modelCalls, 0); assert.match(hit.explanation, /zero-turn/);
  assert.deepEqual(readFileSync(cachePath), bytes); assert.equal(statSync(cachePath).mtimeMs, mtime);
  writeFileSync('installed-cache-record.report.json', JSON.stringify(record.report, null, 2));
  writeFileSync('installed-cache-replay.report.json', JSON.stringify(replay.report, null, 2));
  return { cachePath, recordReport: 'installed-cache-record.report.json', replayReport: 'installed-cache-replay.report.json', recordedModelCalls: miss.metrics.modelCalls, replayedModelCalls: hit.metrics.modelCalls, replayedActions: hit.cache.replayedActions, entryUnchanged: true };
}

async function installedState(appURL) {
  const engine = web();
  let stateHost; let stateSession;
  let bodyFailed = false; let bodyFailure; let result;
  try {
    stateHost = await openHost({ cwd: process.cwd(), config: { targets: [{ name: 'installed-state', engine, app: { url: appURL } }] } });
    stateSession = await stateHost.openSession({ name: 'installed persistent state', timeout: 60_000 });
    const stateOperation = () => ({ signal: new AbortController().signal, timeoutMs: 15_000, runId: stateSession.runId, attemptId: stateSession.attemptId, origin: 'test' });
  await engine.session.reset(stateOperation());
  await engine.session.open(`${appURL}/?phase=seed`, stateOperation());
  assert.ok(!Object.hasOwn(await readState('seed'), 'error'));
  const state = await engine.state.capture(stateOperation());
  const statePath = resolvePath(stateSession.artifactsDir, 'installed-state.json');
  writeFileSync(statePath, JSON.stringify(state));
  await engine.session.reset(stateOperation());
  await engine.session.open(`${appURL}/?phase=empty`, stateOperation());
  const empty = await readState('empty');
  assert.deepEqual(empty.first, { cookie: '', local: null }); assert.equal(empty.record, null);
  const beforeRestore = [...stateRequests];
  await engine.state.restore(JSON.parse(readFileSync(statePath, 'utf8')), stateOperation());
  assert.deepEqual(stateRequests, beforeRestore, 'State bootstrap must not make app requests');
  await engine.session.open(`${appURL}/?phase=restored`, stateOperation());
  const restored = await readState('restored');
  assert.deepEqual(restored, { phase: 'restored', first: { cookie: 'native-fixture=synthetic', local: 'stored' }, created: false, version: 3, indexes: ['byLabel'], record: { cycle: true, typedKind: 'Uint16Array', typed: [1, 65535], blob: 'fixture-payload', blobType: 'text/plain' } });
  result = { path: statePath, restored, bootstrapRequests: 0 };
  } catch (error) {
    bodyFailed = true; bodyFailure = error;
  }
  {
    const failures = [];
    try { if (stateSession) failures.push(...await stateSession.close()); } catch (error) { failures.push(error); }
    try { if (stateHost) failures.push(...await stateHost.close()); } catch (error) { failures.push(error); }
    if (failures.length) {
      if (bodyFailed) failures.unshift(bodyFailure);
      throw new AggregateError(failures, 'Installed state cleanup failed');
    }
  }
  if (bodyFailed) throw bodyFailure;
  return result;
}
