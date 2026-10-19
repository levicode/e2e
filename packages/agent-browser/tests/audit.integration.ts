/** Independent public-entrypoint acceptance tests; run in CI with the exact-ref binary. */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { inflateSync } from 'node:zlib';
import type { EngineFixtureContext, EngineHandle, LocatorExpression, OperationContext, SemanticNode, TextPattern } from 'e2e/engine';
import { agentBrowser, type AgentBrowserOptions, type Browser } from '../dist/index.js';

let server: Server;
let origin: string;
let replacedCheckboxClicks = 0;
let lostAcknowledgementClicks = 0;
const secret = 'synthetic-password-for-source-mask-audit';
const page = (body: string): string => `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:white;color:black}button{font-size:16px}</style>${body}`;

before(async () => {
  assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'CI must supply the built exact-ref binary; integration tests must not silently skip');
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/audit-replaced-click') { replacedCheckboxClicks++; response.end('recorded'); }
    else if (pathname === '/audit-lost-ack-click') { lostAcknowledgementClicks++; response.end('recorded'); }
    else if (pathname === '/glyph') response.end(page(`
      <style>.font-icon{display:block;width:40px;height:40px;cursor:pointer;background:#ddd}.font-icon::before{content:'\\e000';font-family:Arial}</style>
      <div style="height:1800px"></div><div id="glyph" class="font-icon"></div>
      <script>window.clicks=0;document.getElementById('glyph').addEventListener('click',()=>window.clicks++)</script>`));
    else if (pathname === '/overflow') response.end(page(`
      <style>.font-icon{display:block;width:40px;height:40px;cursor:pointer;background:#ddd}.font-icon::before{content:'\\e001'}</style>
      <div id="scroller" style="height:120px;overflow:auto"><div style="height:1200px"></div><div id="glyph" class="font-icon"></div></div>
      <script>window.clicks=0;document.getElementById('glyph').addEventListener('click',()=>window.clicks++)</script>`));
    else if (pathname === '/action-contract') response.end(page(`
      <button id="action" onclick="window.clickEvents.push({control:event.ctrlKey,shift:event.shiftKey,alt:event.altKey,meta:event.metaKey})">Business action</button>
      <input id="disabled" value="disabled-original" disabled><input id="readonly" value="readonly-original" readonly><input id="editable" value="editable-original">
      <script>window.clickEvents=[];window.keyEvents=[];for(const type of ['keydown','keyup'])document.addEventListener(type,event=>window.keyEvents.push({type:event.type,key:event.key,trusted:event.isTrusted}));document.getElementById('editable').focus()</script>`));
    else if (pathname === '/select-upload') response.end(page(`
      <select id="choice"><option value="initial">Initial</option><option value="target-label">Value route</option><option value="label-route">target-label</option><option value="index-route">Index route</option></select>
      <input id="files" type="file" multiple>
      <script>window.selectionEvents=[];window.fileEvents=[];for(const type of ['input','change']){
        document.getElementById('choice').addEventListener(type,()=>window.selectionEvents.push(type));
        document.getElementById('files').addEventListener(type,()=>window.fileEvents.push(type));
      }</script>`));
    else if (pathname === '/locators') response.end(page(`
      <h2 id="heading">Fixture heading</h2><label for="mail">Email label</label><input id="mail" placeholder="Write email" value="audit@example.invalid" data-testid="mail-field">
      <div id="row-a"><span>Alpha row</span><button id="alpha">Choose Alpha</button></div><div id="row-b"><span>Beta row</span><button id="beta">Choose Beta</button></div>
      <button id="hidden" style="display:none">Invisible action</button>
      <iframe id="locator-frame" src="/locator-frame" style="position:absolute;left:70px;top:240px;width:320px;height:200px;border:10px solid black;padding:5px"></iframe>`));
    else if (pathname === '/locator-frame') response.end(page('<button id="frame-one" onclick="window.frameClicks++">Frame action</button><button id="frame-two">Frame action</button><script>window.frameClicks=0</script>'));
    else if (pathname === '/configuration') response.end(page('<script>window.initWasEarly=window.auditBeforeApp===true</script>'));
    else if (pathname === '/stale') response.end(page('<button id="mutate" onclick="window.clicks++">Mutate once</button><script>window.clicks=0</script>'));
    else if (pathname === '/lost-ack') response.end(page('<button id="mutate" onclick="navigator.sendBeacon(\'/audit-lost-ack-click\')">Commit once</button>'));
    else if (pathname === '/controlled-check') response.end(page(`<input id="controlled" type="checkbox" onclick="window.clicks++;const element=this;const wanted=this.checked;event.preventDefault();setTimeout(()=>element.checked=wanted,250)"><script>window.clicks=0</script>`));
    else if (pathname === '/replaced-check') response.end(page(`<input id="controlled" type="checkbox" onclick="window.clicks++;navigator.sendBeacon('/audit-replaced-click');this.replaceWith(this.cloneNode(true))"><script>window.clicks=0</script>`));
    else if (pathname === '/masks') response.end(page(`
      <input id="password" type="password" value="${secret}" style="position:absolute;left:20px;top:20px;width:220px;height:40px;border:0;padding:0">
      <div id="open-host" style="position:absolute;left:20px;top:100px"></div>
      <iframe title="Mask child" src="/mask-frame" style="position:absolute;left:20px;top:180px;width:280px;height:80px;border:0"></iframe>
      <script>document.getElementById('open-host').attachShadow({mode:'open'}).innerHTML='<input type="password" value="${secret}" style="display:block;width:220px;height:40px;border:0;padding:0">'</script>`));
    else if (pathname === '/mask-frame') response.end(page(`<input type="password" value="${secret}" style="position:absolute;left:0;top:0;width:220px;height:40px;border:0;padding:0">`));
    else if (pathname === '/closed-mask') response.end(page(`<div id="closed-host"></div><script>document.getElementById('closed-host').attachShadow({mode:'closed'}).innerHTML='<input type="password" value="${secret}">'</script>`));
    else response.end(page('<h1>Storage audit</h1>'));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

function* walk(node: SemanticNode): Generator<SemanticNode> { yield node; for (const child of node.children ?? []) yield* walk(child); }
function context(attemptId = 'audit', timeoutMs = 30_000): OperationContext {
  return { signal: new AbortController().signal, timeoutMs, runId: 'independent-audit', attemptId, origin: 'test' };
}

/** Public fixture construction uses the same callbacks a runner supplies; no internal surface access. */
function fixture(engine: EngineHandle): Browser {
  const result = engine.fixtures?.browser?.({
    targetName: 'independent-audit',
    app: { site: '127.0.0.1', resolveUrl: (url: string) => new URL(url, origin).href },
    timeouts: { test: 120_000, action: 30_000, assertion: 30_000 },
    signal: new AbortController().signal,
    operation: (timeoutMs?: number) => context('audit', timeoutMs),
    fixture: (_name: string, value: object) => value,
    expectable: (value: object) => value,
    attachArtifact: () => undefined,
    attachViewport: () => undefined,
    locator: () => { throw new Error('This audit constructs raw SPI locators directly'); },
    screen: () => { throw new Error('This audit constructs raw SPI locators directly'); },
  } as unknown as EngineFixtureContext);
  assert.ok(result && 'evaluate' in result, 'The public browser fixture must expose evaluate');
  return result as Browser;
}

async function withEngine(run: (engine: EngineHandle, browser: Browser, artifactsDir: string) => Promise<void>, configure?: (artifactsDir: string) => Promise<Partial<AgentBrowserOptions>>): Promise<void> {
  const artifactsDir = await mkdtemp(path.join(tmpdir(), 'e2e-independent-audit-'));
  const engine = agentBrowser({
    executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE!,
    executablePath: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium',
    args: process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
    viewport: { width: 640, height: 480 },
    ...(configure ? await configure(artifactsDir) : {}),
  });
  const signal = new AbortController().signal;
  const failures: unknown[] = [];
  try {
    await engine.init!({ runId: 'independent-audit', targetName: 'audit', projectRoot: artifactsDir, app: { site: '127.0.0.1' }, env: process.env, headed: false, workerSlot: 0, signal, log: () => undefined });
    await engine.startAttempt!({ attemptId: 'audit', artifactsDir, signal, resolveSecret: () => Promise.reject(new Error('No engine secrets are configured')), appLog: () => undefined, navigation: () => undefined, environment: () => undefined });
    await run(engine, fixture(engine), artifactsDir);
  } catch (error) { failures.push(error); }
  try { await engine.endAttempt!({ signal: new AbortController().signal, timeoutMs: 15_000 }); }
  catch (error) { failures.push(error); }
  try { await engine.dispose!({ signal: new AbortController().signal, timeoutMs: 15_000 }); }
  catch (error) { failures.push(error); }
  try { await rm(artifactsDir, { recursive: true, force: true }); }
  catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Audit body or setup failed; cleanup failures are retained after the original error');
}

for (const endpoint of ['/glyph', '/overflow']) {
  test(`default observation retains unnamed font icon and exact ref autoscrolls once: ${endpoint}`, { timeout: 180_000 }, async () => {
    await withEngine(async (engine, browser) => {
      await engine.session!.open!(`${origin}${endpoint}`, context());
      const observed = await engine.observe!(context());
      const target = [...walk(observed.root)].find((node) => node.selector === '#glyph');
      assert.ok(target, 'Default snapshot must expose the generic clickable icon before any selector query or scroll');
      assert.equal(target.name ?? '', '', 'Fixture must remain an unnamed generic control');
      assert.equal(target.attributes?.role, undefined);
      assert.equal(target.attributes?.['aria-label'], undefined);
      assert.notEqual(target.role, 'button', 'The test must not gain an artificial button role');
      if (endpoint === '/glyph') assert.ok(target.rect && target.rect.y >= observed.viewport.height, 'The target must initially be below the viewport');
      await engine.perform!(target.ref, { kind: 'tap' }, context());
      const result = await browser.evaluate(`({clicks:window.clicks,scrolled:${endpoint === '/glyph' ? 'window.scrollY' : 'document.getElementById("scroller").scrollTop'}})`);
      assert.deepEqual(result, { clicks: 1, scrolled: (result as { scrolled: number }).scrolled });
      assert.ok((result as { scrolled: number }).scrolled > 0, 'The native action must autoscroll the owning scroll container');
    });
  });
}

test('an observed detached ref cannot mutate an indistinguishable replacement', { timeout: 180_000 }, async () => {
  await withEngine(async (engine, browser) => {
    await engine.session!.open!(`${origin}/stale`, context());
    const observation = await engine.observe!(context());
    const target = [...walk(observation.root)].find((node) => node.name === 'Mutate once' && node.role === 'button');
    assert.ok(target);
    await browser.evaluate('(() => { document.getElementById("mutate").replaceWith(document.getElementById("mutate").cloneNode(true)); return null; })()');
    await assert.rejects(engine.perform!(target.ref, { kind: 'tap' }, context()), (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error && error.code === 'NODE_STALE');
      return true;
    });
    assert.equal(await browser.evaluate('window.clicks'), 0, 'No stale fallback may click the replacement');
  });
});

test('lost acknowledgement after an actual click poisons the attempt and never repeats the server mutation', { timeout: 180_000 }, async () => {
  lostAcknowledgementClicks = 0;
  await withEngine(async (engine, browser) => {
    await engine.session!.open!(`${origin}/lost-ack`, context());
    const observation = await engine.observe!(context());
    const target = [...walk(observation.root)].find((node) => node.selector === '#mutate'); assert.ok(target);
    const started = Date.now();
    await assert.rejects(engine.perform!(target.ref, { kind: 'tap' }, context('audit', 5_000)), (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error && error.code === 'ACTION_MAY_HAVE_COMMITTED');
      assert.ok('retryable' in error && error.retryable === false);
      return true;
    });
    assert.ok(Date.now() - started < 15_000, 'The lost acknowledgement must respect the composite operation budget');
    const until = Date.now() + 5_000;
    while (Date.now() < until) { if (lostAcknowledgementClicks > 0) break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.equal(lostAcknowledgementClicks, 1, 'The real browser must have committed exactly one click before the injected lost acknowledgement');
    await assert.rejects(browser.evaluate('true'), { code: 'INVALID_STATE' });
    await assert.rejects(engine.perform!(target.ref, { kind: 'tap' }, context()), { code: 'INVALID_STATE' });
    assert.equal(lostAcknowledgementClicks, 1);
  }, async (artifactsDir) => {
    const wrapper = path.join(artifactsDir, 'withhold-click-ack.mjs');
    // Fault injection surrounds the real, version-gated CLI. It never emulates snapshot, input, or a browser reply.
    await writeFile(wrapper, `#!${process.execPath}\nimport { spawn } from 'node:child_process';
      const args=process.argv.slice(2);const child=spawn(${JSON.stringify(process.env.E2E_AGENT_BROWSER_EXECUTABLE)},args,{stdio:['ignore','pipe','pipe']});
      const output=[];const errors=[];child.stdout.on('data',data=>output.push(data));child.stderr.on('data',data=>errors.push(data));
      child.on('error',()=>process.exit(1));child.on('close',code=>{
        if(code===0&&args.includes('click')){setInterval(()=>{},1000);return;}
        process.stdout.write(Buffer.concat(output));process.stderr.write(Buffer.concat(errors));process.exitCode=code??1;
      });`, { mode: 0o700 });
    return { executable: wrapper };
  });
});

test('check waits for a controlled checkbox without issuing a second synthetic click', { timeout: 180_000 }, async () => {
  await withEngine(async (engine, browser) => {
    await engine.session!.open!(`${origin}/controlled-check`, context());
    const observation = await engine.observe!(context());
    const target = [...walk(observation.root)].find((node) => node.selector === '#controlled');
    assert.ok(target);
    await engine.perform!(target.ref, { kind: 'check' }, context());
    assert.deepEqual(await browser.evaluate('({clicks:window.clicks,checked:document.getElementById("controlled").checked})'), { clicks: 1, checked: true });
    const next = [...walk((await engine.observe!(context())).root)].find((node) => node.selector === '#controlled');
    assert.ok(next);
    await engine.perform!(next.ref, { kind: 'check' }, context());
    assert.equal(await browser.evaluate('window.clicks'), 1, 'Checking an already checked node must not click again');
  });
});

test('post-click node replacement cannot produce a retryable pre-dispatch stale proof', { timeout: 180_000 }, async () => {
  await withEngine(async (engine, browser) => {
    await engine.session!.open!(`${origin}/replaced-check`, context());
    const observation = await engine.observe!(context());
    const target = [...walk(observation.root)].find((node) => node.selector === '#controlled');
    assert.ok(target);
    replacedCheckboxClicks = 0;
    try { await engine.perform!(target.ref, { kind: 'check' }, context()); }
    catch (error) {
      assert.ok(error instanceof Error && 'code' in error && error.code === 'ACTION_MAY_HAVE_COMMITTED', 'A post-click stale read cannot claim input was never dispatched');
      assert.ok('retryable' in error && error.retryable === false);
      await assert.rejects(browser.evaluate('window.clicks'), { code: 'INVALID_STATE' });
    }
    const until = Date.now() + 5_000;
    while (Date.now() < until) { if (replacedCheckboxClicks > 0) break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.equal(replacedCheckboxClicks, 1, 'The synthetic server must receive exactly one click side effect, even when the outcome is uncertain');
  });
});

test('state restore replaces cookie, localStorage and IndexedDB; sessionStorage seeds only once', { timeout: 240_000 }, async () => {
  await withEngine(async (engine, browser) => {
    await engine.session!.open!(`${origin}/storage`, context());
    await browser.evaluate(async () => {
      localStorage.setItem('keep', 'A'); sessionStorage.setItem('keep', 'A'); document.cookie = 'keep=A;path=/';
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('audit-db', 1);
        request.addEventListener('upgradeneeded', () => request.result.createObjectStore('items'));
        request.addEventListener('error', () => reject(new Error('seed failed')));
        request.addEventListener('success', () => {
          const db = request.result; const tx = db.transaction('items', 'readwrite'); tx.objectStore('items').put({ value: 'A' }, 'keep');
          tx.addEventListener('complete', () => { db.close(); resolve(); }); tx.addEventListener('error', () => reject(new Error('seed failed')));
        });
      }); return true;
    });
    const saved = await engine.state!.capture(context());
    await browser.evaluate(async () => {
      localStorage.setItem('extra', 'B'); sessionStorage.setItem('extra', 'B'); document.cookie = 'extra=B;path=/';
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('audit-db'); request.addEventListener('error', () => reject(new Error('write failed')));
        request.addEventListener('success', () => { const db = request.result; const tx = db.transaction('items', 'readwrite'); tx.objectStore('items').put({ value: 'B' }, 'extra'); tx.addEventListener('complete', () => { db.close(); resolve(); }); tx.addEventListener('error', () => reject(new Error('write failed'))); });
      }); return true;
    });
    await engine.state!.restore(saved, context());
    await engine.session!.open!(`${origin}/storage`, context());
    const restored = await browser.evaluate(async () => {
      const entries = await new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open('audit-db'); request.addEventListener('error', () => reject(new Error('read failed')));
        request.addEventListener('success', () => { const db = request.result; const get = db.transaction('items').objectStore('items').getAllKeys(); get.addEventListener('success', () => { db.close(); resolve(get.result.map(String)); }); get.addEventListener('error', () => reject(new Error('read failed'))); });
      });
      return { local: Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])), session: Object.fromEntries(Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)])), cookies: document.cookie, keys: entries };
    });
    assert.deepEqual(restored, { local: { keep: 'A' }, session: { keep: 'A' }, cookies: 'keep=A', keys: ['keep'] });
    await browser.evaluate('(() => { sessionStorage.setItem("keep","after-restore"); return null; })()');
    await engine.session!.open!(`${origin}/storage?next`, context());
    assert.equal(await browser.evaluate('sessionStorage.getItem("keep")'), 'after-restore', 'A restore init script must not overwrite storage on each navigation');
    await engine.session!.reset!(context());
    await engine.session!.open!(`${origin}/storage`, context());
    assert.deepEqual(await browser.evaluate(async () => ({ local: Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])), session: Object.fromEntries(Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)])), cookies: document.cookie, databases: (await indexedDB.databases()).map((db) => db.name ?? "") })), { local: {}, session: {}, cookies: '', databases: [] });
  });
});

test('unknown check state and disabled/readonly fill refuse before mutating; tap modifiers and literal typing reach DOM events', { timeout: 180_000 }, async () => {
  await withEngine(async (engine, browser) => {
    await engine.session!.open!(`${origin}/action-contract`, context());
    const locate = async (selector: string): Promise<SemanticNode> => {
      const [node] = await engine.locate!({ kind: 'selector', selector }, context()); assert.ok(node); return node;
    };
    const business = await locate('#action');
    await assert.rejects(engine.perform!(business.ref, { kind: 'check' }, context()), { code: 'NOT_ACTIONABLE', retryable: false });
    assert.deepEqual(await browser.evaluate('window.clickEvents'), []);
    for (const selector of ['#disabled', '#readonly']) {
      const target = await locate(selector);
      await assert.rejects(engine.perform!(target.ref, { kind: 'fill', value: 'must-not-arrive', sensitive: false }, context()), { code: 'NOT_ACTIONABLE' });
    }
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll("input"),element=>element.value)'), ['disabled-original', 'readonly-original', 'editable-original']);
    const target = await locate('#action');
    await engine.perform!(target.ref, { kind: 'tap', modifiers: ['Control', 'Shift'] }, context());
    assert.deepEqual(await browser.evaluate('window.clickEvents'), [{ control: true, shift: true, alt: false, meta: false }]);
    const editable = await locate('#editable');
    await engine.perform!(editable.ref, { kind: 'focus' }, context());
    await browser.evaluate('(() => {window.keyEvents=[];return null})()');
    await engine.keyboard!.type('--session', { replace: true }, context());
    assert.equal(await browser.evaluate('document.getElementById("editable").value'), '--session');
    const keys = await browser.evaluate('window.keyEvents') as { type: string; key: string; trusted: boolean }[];
    assert.deepEqual(keys.slice(-'--session'.length * 2), [...'--session'].flatMap(key => [
      { type: 'keydown', key, trusted: true }, { type: 'keyup', key, trusted: true },
    ]), 'Literal text must emit an ordered trusted keydown/keyup pair for every ASCII character');
  });
});

const exact = (value: string): TextPattern => ({ kind: 'string', value, exact: true });

test('selection distinguishes string/label/value/index and file upload resolves project paths and clears', { timeout: 180_000 }, async () => {
  await withEngine(async (engine, browser, projectRoot) => {
    await engine.session!.open!(`${origin}/select-upload`, context());
    const choices = [
      [{ value: 'target-label' }, 'target-label'],
      [{ label: 'target-label' }, 'label-route'],
      [{ index: 3 }, 'index-route'],
      ['target-label', 'label-route'],
    ] as const;
    for (const [value, expected] of choices) {
      const [node] = await engine.locate!({ kind: 'selector', selector: '#choice' }, context()); assert.ok(node);
      await browser.evaluate('(() => {window.selectionEvents=[];return true})()');
      await engine.perform!(node.ref, { kind: 'selectOption', value }, context());
      assert.deepEqual(await browser.evaluate('({value:document.getElementById("choice").value,events:window.selectionEvents})'), { value: expected, events: ['input', 'change'] });
    }
    await writeFile(path.join(projectRoot, 'synthetic-upload.txt'), 'fixture upload content');
    await writeFile(path.join(projectRoot, 'synthetic-upload.json'), '{"fixture":true}');
    const [input] = await engine.locate!({ kind: 'selector', selector: '#files' }, context()); assert.ok(input);
    await engine.perform!(input.ref, { kind: 'setInputFiles', paths: ['synthetic-upload.txt', 'synthetic-upload.json'] }, context());
    assert.deepEqual(await browser.evaluate(async () => {
      const files = [...document.querySelector<HTMLInputElement>('#files')!.files!];
      return Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })));
    }), [{ name: 'synthetic-upload.txt', text: 'fixture upload content' }, { name: 'synthetic-upload.json', text: '{"fixture":true}' }]);
    assert.deepEqual(await browser.evaluate('window.fileEvents'), ['input', 'change']);
    const [currentInput] = await engine.locate!({ kind: 'selector', selector: '#files' }, context()); assert.ok(currentInput);
    await engine.perform!(currentInput.ref, { kind: 'setInputFiles', paths: [] }, context());
    assert.equal(await browser.evaluate('document.getElementById("files").files.length'), 0);
    assert.deepEqual(await browser.evaluate('window.fileEvents'), ['input', 'change', 'input', 'change']);
  });
});

test('deterministic locator AST supports query families, CSS, XPath, filters and wrapped frame scopes', { timeout: 240_000 }, async () => {
  await withEngine(async (engine, browser) => {
    await engine.session!.open!(`${origin}/locators`, context());
    const examples: [LocatorExpression, string][] = [
      [{ kind: 'query', query: { kind: 'role', value: exact('heading'), name: exact('Fixture heading'), level: 2 } }, 'heading'],
      [{ kind: 'query', query: { kind: 'label', value: exact('Email label') } }, 'mail'],
      [{ kind: 'query', query: { kind: 'placeholder', value: exact('Write email') } }, 'mail'],
      [{ kind: 'query', query: { kind: 'displayValue', value: exact('audit@example.invalid') } }, 'mail'],
      [{ kind: 'query', query: { kind: 'testId', value: exact('mail-field') } }, 'mail'],
      [{ kind: 'query', query: { kind: 'text', value: { kind: 'regexp', source: '^choose beta$', flags: 'i' } } }, 'beta'],
      [{ kind: 'selector', selector: '#alpha' }, 'alpha'],
      [{ kind: 'selector', selector: 'xpath=//button[@id="beta"]' }, 'beta'],
      [{ kind: 'filter', source: { kind: 'selector', selector: 'div' }, hasText: exact('Beta row'), has: { kind: 'selector', selector: '#beta' } }, 'row-b'],
      [{ kind: 'query', query: { kind: 'role', value: exact('button') }, scope: { kind: 'selector', selector: '#row-a' } }, 'alpha'],
    ];
    for (const [expression, id] of examples) {
      const matches = await engine.locate!(expression, context());
      assert.equal(matches.length, 1, JSON.stringify(expression));
      assert.equal(matches[0]!.attributes?.id, id);
    }
    assert.equal((await engine.locate!({ kind: 'query', query: { kind: 'role', value: exact('button'), name: exact('Invisible action') } }, context())).length, 0);
    const frameExpression: LocatorExpression = { kind: 'index', index: 'first', source: { kind: 'frame', selector: '#locator-frame', source: { kind: 'query', query: { kind: 'role', value: exact('button'), name: exact('Frame action') } } } };
    const [framed] = await engine.locate!(frameExpression, context());
    assert.ok(framed?.rect);
    assert.deepEqual(framed.framePath, ['#locator-frame']);
    const expected = await browser.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('#locator-frame')!;
      const outer = frame.getBoundingClientRect(); const inner = frame.contentDocument!.querySelector('#frame-one')!.getBoundingClientRect(); const style = getComputedStyle(frame);
      return { x: outer.x + frame.clientLeft + Number.parseFloat(style.paddingLeft) + inner.x, y: outer.y + frame.clientTop + Number.parseFloat(style.paddingTop) + inner.y };
    });
    assert.ok(Math.abs(framed.rect.x - expected.x) < 1 && Math.abs(framed.rect.y - expected.y) < 1, 'Frame rectangles must use top-level CSS coordinates including border and padding');
    await engine.perform!(framed.ref, { kind: 'tap' }, context());
    assert.equal(await browser.evaluate('document.querySelector("#locator-frame").contentWindow.frameClicks'), 1);
    await assert.rejects(engine.locate!({ kind: 'frame', selector: '#missing', source: { kind: 'selector', selector: 'button' } }, context()), { code: 'FRAME_NOT_FOUND' });
  });
});

test('attempt routes, init scripts, media, viewport and dialogs survive restart, reset and state replacement', { timeout: 240_000 }, async () => {
  await withEngine(async (engine, browser) => {
    const phase = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
      try { return await work(); } catch (cause) { throw new Error(`Configuration acceptance phase: ${label}`, { cause }); }
    };
    await phase('register initial script', () => browser.addInitScript('window.auditBeforeApp=true'));
    await phase('configure media', () => browser.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' }));
    await phase('configure viewport', () => browser.setViewport({ width: 700, height: 500 }));
    await phase('register dialog handler', () => browser.onDialog('dismiss'));
    await phase('register route', () => browser.route('**/configuration-api', (route) => route.fulfill({ body: 'attempt-route' })));
    await phase('initial navigation', () => engine.session!.open!(`${origin}/configuration`, context()));
    await phase('write initial storage', () => browser.evaluate('(() => { localStorage.setItem("audit-token", "captured-A"); return true; })()'));
    await phase('register destructive init script', () => browser.addInitScript('window.tokenBeforeInit=localStorage.getItem("audit-token");localStorage.setItem("audit-token","init-rewrite")'));
    const saved = await phase('capture state', () => engine.state!.capture(context()));
    assert.equal(await browser.evaluate('localStorage.getItem("audit-token")'), 'captured-A', 'Storage capture probes must not run the fixture init script against live storage');
    const verify = async (expectedToken: string | null, label: 'initial' | 'after restart' | 'after reset' | 'after restore'): Promise<void> => phase(`verify ${label}`, async () => {
      await phase(`verify ${label}: navigation`, () => engine.session!.open!(`${origin}/configuration`, context()));
      assert.deepEqual(await browser.evaluate(`({early:window.initWasEarly,dark:matchMedia('(prefers-color-scheme: dark)').matches,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,width:innerWidth,height:innerHeight,dialog:confirm('synthetic configuration audit')})`), { early: true, dark: true, reduced: true, width: 700, height: 500, dialog: false });
      assert.equal(await browser.evaluate(`fetch('/configuration-api').then(response=>response.text())`), 'attempt-route');
      assert.deepEqual(await browser.evaluate('({beforeInit:window.tokenBeforeInit,current:localStorage.getItem("audit-token")})'), { beforeInit: expectedToken, current: 'init-rewrite' });
    });
    await verify('captured-A', 'initial');
    await phase('restart', () => engine.session!.restart!(context())); await verify('init-rewrite', 'after restart');
    await phase('reset', () => engine.session!.reset!(context())); await verify(null, 'after reset');
    await phase('restore state', () => engine.state!.restore(saved, context())); await verify('captured-A', 'after restore');
    await phase('settle callbacks', () => engine.settleAttempt!({ signal: new AbortController().signal, timeoutMs: 10_000 }));
  });
});

test('completed dialog callbacks cannot start fresh nested fixture mutations in the same attempt', { timeout: 180_000 }, async () => {
  await withEngine(async (engine, browser) => {
    await engine.session!.open!(`${origin}/storage`, context());
    await browser.evaluate('(() => { window.retiredCallbackMutations=0; return true; })()');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let late: Promise<unknown> | undefined;
    let calls = 0;
    await browser.onDialog(async (dialog) => {
      calls++;
      // This continuation is deliberately detached from the completed handler.
      // It retains the callback scope but attempts to acquire a fresh operation.
      late = gate.then(() => browser.evaluate('++window.retiredCallbackMutations'))
        .then((result) => ({ unexpectedMutation: result }), (error: unknown) => error);
      await dialog.dismiss();
    });
    assert.equal(await browser.evaluate("confirm('callback retirement audit')"), false);
    await engine.settleAttempt!({ signal: new AbortController().signal, timeoutMs: 10_000 });
    assert.equal(calls, 1);
    assert.ok(late, 'The real dialog must invoke the registered handler');
    release();
    const result = await late;
    assert.ok(result instanceof Error && 'code' in result && result.code === 'INVALID_STATE', 'A retired callback must be refused before dispatch, even without a restart');
    assert.ok('retryable' in result && result.retryable === false);
    assert.equal(await browser.evaluate('window.retiredCallbackMutations'), 0, 'Retired work must not mutate or poison the still-current browser');
  });
});

test('simultaneous workers isolate storage, cookies and route callbacks on the same app origin', { timeout: 180_000 }, async () => {
  let arrived = 0;
  let release = (): void => {};
  const ready = new Promise<void>((resolve) => { release = resolve; });
  await Promise.all(['worker-a', 'worker-b'].map((identity) => withEngine(async (engine, browser) => {
    await engine.session!.open!(`${origin}/storage`, context());
    await browser.evaluate((value: string) => { localStorage.setItem('worker', value); document.cookie = `worker=${value};path=/`; return true; }, identity);
    await browser.route('**/worker-api', (route) => route.fulfill({ body: identity }));
    if (++arrived === 2) release();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([ready, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The other worker did not initialize')), 30_000); })]); }
    finally { clearTimeout(timer); }
    assert.deepEqual(await browser.evaluate(`({worker:localStorage.getItem('worker'),cookie:document.cookie})`), { worker: identity, cookie: `worker=${identity}` });
    assert.equal(await browser.evaluate(`fetch('/worker-api').then(response=>response.text())`), identity);
  })));
});

/** Decodes RGB/RGBA 8-bit screenshot pixels with no third-party test dependency. */
function pngPixel(bytes: Uint8Array, x: number, y: number): number[] {
  const buffer = Buffer.from(bytes); const width = buffer.readUInt32BE(16); const height = buffer.readUInt32BE(20);
  assert.equal(buffer[24], 8); assert.equal(buffer[28], 0, 'Interlaced PNG is not expected');
  const channels = buffer[25] === 6 ? 4 : buffer[25] === 2 ? 3 : 0; assert.ok(channels);
  assert.ok(x >= 0 && y >= 0 && x < width && y < height);
  const parts: Buffer[] = [];
  for (let offset = 8; offset + 12 <= buffer.length;) { const size = buffer.readUInt32BE(offset); if (buffer.toString('ascii', offset + 4, offset + 8) === 'IDAT') parts.push(buffer.subarray(offset + 8, offset + 8 + size)); offset += size + 12; }
  const raw = inflateSync(Buffer.concat(parts)); const stride = width * channels;
  let previous = Buffer.alloc(stride);
  for (let row = 0; row <= y; row++) {
    const filter = raw[row * (stride + 1)]!; const decoded = Buffer.from(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
    for (let column = 0; column < stride; column++) {
      const left: number = column >= channels ? decoded[column - channels]! : 0; const up: number = previous[column]!; const upperLeft: number = column >= channels ? previous[column - channels]! : 0;
      const prediction = left + up - upperLeft; const a = Math.abs(prediction - left); const b = Math.abs(prediction - up); const c = Math.abs(prediction - upperLeft);
      const delta: number = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? (a <= b && a <= c ? left : b <= c ? up : upperLeft) : NaN;
      assert.ok(Number.isFinite(delta)); decoded[column] = (decoded[column]! + delta) & 255;
    }
    previous = decoded;
  }
  return [...previous.subarray(x * channels, x * channels + 3)];
}

test('secure observation omits password values and pixels mask main, open-shadow and child-frame fields', { timeout: 240_000 }, async () => {
  await withEngine(async (engine, browser, artifactsDir) => {
    await assert.doesNotReject(engine.session!.open!(`${origin}/masks`, context()), 'Initial secure-fixture navigation must complete before pixel capture');
    const observation = await engine.observe!(context(), { pixels: true });
    assert.ok(!JSON.stringify(observation.root).includes(secret), 'No secure field value can enter the semantic tree');
    for (const node of walk(observation.root)) if (node.states?.secure) { assert.equal(node.value, undefined); assert.equal(node.selection, undefined); }
    assert.ok(observation.pixels, 'Supported same-origin/open-shadow surface must return masked pixels');
    assert.equal(observation.pixels.width, 640); assert.equal(observation.pixels.height, 480); assert.equal(observation.pixels.scale, 1);
    assert.ok((observation.maskedRegionCount ?? 0) >= 3);
    for (const [x, y] of [[40, 40], [40, 120], [40, 200]]) assert.deepEqual(pngPixel(observation.pixels.data, x!, y!), [0, 0, 0]);
    assert.deepEqual(pngPixel(observation.pixels.data, 400, 40), [255, 255, 255], 'Masking must retain non-sensitive pixels');
    assert.equal(await browser.evaluate('document.querySelectorAll("[popover]").length'), 0, 'Mask overlays must be removed after capture');
    const existingArtifacts = await readdir(artifactsDir);
    await assert.doesNotReject(engine.session!.open!(`${origin}/closed-mask`, context()), 'Navigation after source-masked capture must remain usable before closed-shadow capture');
    try {
      const artifact = await engine.artifacts!.screenshot('closed-shadow-fail-closed', context());
      assert.deepEqual(pngPixel(await readFile(path.join(artifactsDir, artifact)), 10, 10), [0, 0, 0], 'A supported closed shadow screenshot must mask its password field');
    } catch (error) {
      assert.ok(error instanceof Error && 'code' in error && (error.code === 'UNSUPPORTED_CAPABILITY' || error.code === 'POLICY_DENIED'));
      assert.deepEqual(await readdir(artifactsDir), existingArtifacts, 'A refused mask must never leave an unmasked image artifact');
    }
  });
});

test('short-lived state and masking probes never stall the next public native observation or navigation', { timeout: 180_000 }, async () => {
  await withEngine(async (engine, browser) => {
    await engine.session!.open!(`${origin}/masks`, context());
    await browser.evaluate('(() => { localStorage.setItem("probe-lifetime-token","retained"); return true; })()');
    const phase = async <T>(iteration: number, label: string, work: () => Promise<T>): Promise<T> => {
      try { return await work(); }
      catch (cause) { throw new Error(`Probe lifetime acceptance round ${iteration}: ${label}`, { cause }); }
    };
    // Every round is required. These are separate successful operations, never retries
    // after an ambiguous action or a refused screenshot. Use native observe/open here:
    // browser.url/evaluate use the CDP companion and cannot detect a blocked CLI daemon.
    for (let iteration = 0; iteration < 12; iteration++) {
      await phase(iteration, 'state capture', () => engine.state!.capture(context()));
      const observed = await phase(iteration, 'native observation after state capture', () => engine.observe!(context()));
      assert.ok([...walk(observed.root)].some(node => node.selector === '#password' && node.states?.secure), 'The original live page must remain the native observation target');
      assert.ok(!JSON.stringify(observed.root).includes(secret));
      const masked = await phase(iteration, 'masked observation', () => engine.observe!(context(), { pixels: true }));
      assert.ok(masked.pixels); assert.ok((masked.maskedRegionCount ?? 0) >= 3);
      for (const [x, y] of [[40, 40], [40, 120], [40, 200]]) assert.deepEqual(pngPixel(masked.pixels.data, x!, y!), [0, 0, 0]);
      assert.deepEqual(pngPixel(masked.pixels.data, 400, 40), [255, 255, 255]);
      const next = `${origin}/masks?probe-round=${iteration}`;
      await phase(iteration, 'native navigation after masked capture', () => engine.session!.open!(next, context()));
      assert.deepEqual(await browser.evaluate('({url:location.href,token:localStorage.getItem("probe-lifetime-token"),overlays:document.querySelectorAll("[popover]").length})'), { url: next, token: 'retained', overlays: 0 });
    }
  });
});
