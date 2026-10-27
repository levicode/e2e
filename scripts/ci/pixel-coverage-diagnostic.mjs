/** Independent, read-only reproduction of native mask discovery; never product/consumer acceptance. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [e2eRoot, nativeRoot, outputDir] = process.argv.slice(2);
const chrome = process.env.CHROME_BIN ?? process.env.CHROMIUM_EXECUTABLE_PATH;
const report = { schemaVersion: 1, kind: 'independent-native-mask-reader-reproduction', acceptanceEvidence: false, status: 'not-run', stages: [], failures: [] };
let stage = 'arguments';
let profile;
let child;
let cdp;
let app;
let session;
let group;
let oldRate;
let sequence = 0;
const pending = new Map();
let exited;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => { const error = new Error('closed diagnostic refusal'); error.code = code; return error; };
const scalarFailure = error => ['arguments','chrome-launch','chrome-endpoint','cdp-connect','cdp-command','cdp-timeout','fixture-ready','source-extraction','snapshot-schema','resolve-object','reader-exception','reader-schema','cleanup'].includes(error?.code) ? error.code : 'diagnostic-failure';

async function command(method, params = {}, sessionId = session) {
  const id = ++sequence;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(fail('cdp-timeout')); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  });
  cdp.send(JSON.stringify({ id, method, params, ...(typeof sessionId === 'string' ? { sessionId } : {}) }));
  return result;
}
function hasRareIndex(rare, index) {
  return rare !== undefined && Array.isArray(rare.index) && rare.index.includes(index);
}
function nodeFacts(document, strings, index, objectId) {
  const shadow = document.nodes.shadowRootType;
  const shadowIndex = shadow?.index?.indexOf(index) ?? -1;
  return { nodeType: document.nodes.nodeType[index] === 1 ? 1 : 0,
    pseudoPresent: hasRareIndex(document.nodes.pseudoType, index),
    userAgent: shadowIndex < 0 ? false : strings[shadow.value[shadowIndex]] === 'user-agent',
    objectId: typeof objectId === 'string' };
}
function readerStatus(response) {
  if (response.exceptionDetails !== undefined) return 'reader-exception';
  const result = response.result?.value;
  return result && Number.isSafeInteger(result.count) && Array.isArray(result.masks) && Array.isArray(result.secure)
    && typeof result.opaque === 'boolean' && typeof result.unsafeGeometry === 'boolean' ? 'reader-returned' : 'reader-schema';
}
const BRAND_PROBE = `function(){
 let node=false,connected=false,owned=false,rect=false,style=false,ancestor=false;
 try{connected=Object.getOwnPropertyDescriptor(Node.prototype,'isConnected').get.call(this);node=true;}catch{}
 if(node){try{owned=Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get.call(this)===document;}catch{}
 try{const r=this.getBoundingClientRect();rect=[r.x,r.y,r.width,r.height].every(Number.isFinite);}catch{}
 try{style=!!getComputedStyle(this);}catch{}
 try{for(let p=this;p;){p.matches('input[type="password" i]');p=p.parentElement||(p.getRootNode().host||null);}ancestor=true;}catch{}}
 return {node,connected,owned,rect,style,ancestor};
}`;

try {
  if (!e2eRoot || !nativeRoot || !outputDir || !chrome || !path.isAbsolute(chrome)) throw fail('arguments');
  await mkdir(outputDir, { recursive: true });
  stage = 'source-extraction';
  const nativeSource = await readFile(path.join(nativeRoot, 'cli/src/native/client_capture.rs'), 'utf8');
  const reader = /const MASK_READER: &str = r#"([\s\S]*?)"#;/.exec(nativeSource)?.[1];
  if (!reader) throw fail('source-extraction');
  report.readerSourceSha256 = createHash('sha256').update(reader).digest('hex');
  const { startFixtureApp } = await import(pathToFileURL(path.join(e2eRoot, 'packages/e2e/tests/helpers/fixture-app.ts')).href);
  app = await startFixtureApp();
  stage = 'chrome-launch';
  profile = await mkdtemp(path.join(tmpdir(), 'safe-mask-diag-'));
  child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--use-mock-keychain', '--disable-gpu', '--disable-extensions', '--disable-component-extensions-with-background-pages', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', shell: false });
  exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', () => resolve(null)); });
  let launchError = false;
  child.once('error', () => { launchError = true; });
  stage = 'chrome-endpoint';
  let lines;
  for (let index = 0; index < 200; index++) {
    if (launchError || child.exitCode !== null || child.signalCode !== null) throw fail('chrome-launch');
    try { lines = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break; } catch {}
    await sleep(50);
  }
  if (!lines || !/^\d+$/.test(lines[0]) || !lines[1]?.startsWith('/devtools/browser/')) throw fail('chrome-endpoint');
  stage = 'cdp-connect';
  cdp = new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
  await Promise.race([new Promise((resolve, reject) => { cdp.addEventListener('open', resolve, { once: true }); cdp.addEventListener('error', () => reject(fail('cdp-connect')), { once: true }); }), sleep(10000).then(() => { throw fail('cdp-timeout'); })]);
  cdp.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const wait = pending.get(message.id);
    if (!wait) return;
    pending.delete(message.id);
    if (message.error) wait.reject(fail('cdp-command')); else wait.resolve(message.result);
  });
  cdp.addEventListener('close', () => { for (const wait of pending.values()) wait.reject(fail('cdp-command')); pending.clear(); });
  const target = (await command('Target.getTargets')).targetInfos.find(target => target.type === 'page');
  if (!target) throw fail('cdp-command');
  session = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: app.url });
  stage = 'fixture-ready';
  let ready = false;
  for (let index = 0; index < 200; index++) {
    const result = await command('Runtime.evaluate', { expression: "document.readyState === 'complete' && [...document.querySelectorAll('button')].some(node => node.textContent === 'Late arrival')", returnByValue: true });
    if (result.result?.value === true) { ready = true; break; }
    await sleep(50);
  }
  if (!ready) throw fail('fixture-ready');
  await command('Animation.enable');
  oldRate = (await command('Animation.getPlaybackRate')).playbackRate;
  await command('Animation.setPlaybackRate', { playbackRate: 0 });
  stage = 'snapshot';
  const snapshot = await command('DOMSnapshot.captureSnapshot', { computedStyles: [] });
  if (!Array.isArray(snapshot.strings) || !Array.isArray(snapshot.documents)) throw fail('snapshot-schema');
  for (const document of snapshot.documents) {
    const frameId = snapshot.strings[document.frameId];
    const types = document.nodes?.nodeType;
    const backends = document.nodes?.backendNodeId;
    if (typeof frameId !== 'string' || !Array.isArray(types) || !Array.isArray(backends) || types.length !== backends.length) throw fail('snapshot-schema');
    stage = 'isolated-world';
    const realm = (await command('Page.createIsolatedWorld', { frameId, worldName: 'agent-browser-protected-capture' })).executionContextId;
    if (!Number.isSafeInteger(realm)) throw fail('snapshot-schema');
    const indices = types.flatMap((type, index) => type === 1 ? [index] : []);
    group = 'safe-mask-independent-diagnostic';
    for (let offset = 0; offset < indices.length; offset += 64) {
      const batch = indices.slice(offset, offset + 64);
      const handles = [];
      for (const index of batch) {
        stage = 'resolve-node';
        const resolved = await command('DOM.resolveNode', { backendNodeId: backends[index], executionContextId: realm, objectGroup: group });
        const objectId = resolved.object?.objectId;
        if (typeof objectId !== 'string') {
          report.failures.push({ site: 'resolve-object', ...nodeFacts(document, snapshot.strings, index, objectId) });
          throw fail('resolve-object');
        }
        handles.push({ index, objectId });
      }
      stage = 'mask-reader';
      const response = await command('Runtime.callFunctionOn', { executionContextId: realm, functionDeclaration: reader, arguments: [{ value: 'input[type="password" i]' }, ...handles.map(({ objectId }) => ({ objectId }))], returnByValue: true, objectGroup: group });
      const status = readerStatus(response);
      if (status !== 'reader-returned') {
        // Same source function, one previously resolved object at a time.
        // Store only bounded failure classification and native snapshot booleans.
        for (const { index, objectId } of handles) {
          const one = await command('Runtime.callFunctionOn', { executionContextId: realm, functionDeclaration: reader, arguments: [{ value: 'input[type="password" i]' }, { objectId }], returnByValue: true, objectGroup: group });
          const oneStatus = readerStatus(one);
          if (oneStatus === 'reader-returned') continue;
          const probe = await command('Runtime.callFunctionOn', { objectId, functionDeclaration: BRAND_PROBE, returnByValue: true, objectGroup: group });
          const value = probe.result?.value;
          const brand = Object.fromEntries(['node','connected','owned','rect','style','ancestor'].map(key => [key, value?.[key] === true]));
          report.failures.push({ site: oneStatus, ...nodeFacts(document, snapshot.strings, index, objectId), ...brand });
          if (report.failures.length === 8) break;
        }
        throw fail(status);
      }
      report.stages.push({ site: 'mask-reader', returned: true, opaque: response.result.value.opaque, unsafeGeometry: response.result.value.unsafeGeometry });
    }
    await command('Runtime.releaseObjectGroup', { objectGroup: group });
    group = undefined;
  }
  report.status = 'reader-passed';
} catch (error) {
  report.status = 'refused';
  report.firstFailure = { site: stage, code: scalarFailure(error) };
} finally {
  let cleanup = true;
  if (cdp?.readyState === WebSocket.OPEN) {
    if (group) { try { await command('Runtime.releaseObjectGroup', { objectGroup: group }); } catch { cleanup = false; } }
    if (Number.isFinite(oldRate)) { try { await command('Animation.setPlaybackRate', { playbackRate: oldRate }); } catch { cleanup = false; } }
    try { await command('Browser.close', {}, false); } catch { /* Browser.close may acknowledge by closing transport. */ }
    cdp.close();
  }
  if (child) {
    await Promise.race([exited, sleep(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([exited, sleep(3000)]); }
    if (child.exitCode === null && child.signalCode === null) cleanup = false;
  }
  if (app) { try { await app.close(); } catch { cleanup = false; } }
  if (profile && cleanup) await rm(profile, { recursive: true, force: true });
  report.cleanup = cleanup;
  // Output is a bounded, explicit scalar schema. Never print caught errors.
  if (outputDir) {
    const json = JSON.stringify(report, null, 2);
    if (Buffer.byteLength(json) > 8192) throw fail('diagnostic-failure');
    await writeFile(path.join(outputDir, 'pixel-coverage-diagnostic.json'), `${json}\n`, { mode: 0o600 });
  }
  process.exitCode = cleanup ? 0 : 1;
}
