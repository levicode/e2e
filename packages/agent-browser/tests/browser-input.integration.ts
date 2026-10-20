/** Real browser semantics, intentionally run only by the external CI integration gate. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { EngineFixtureContext, EngineHandle, OperationContext } from 'e2e/engine';
import { agentBrowser, type Browser } from '../dist/index.js';

let server: Server;
let origin: string;
let crossOrigin: string;
const downloaded = 'real browser download body\n';
const html = (body: string) => `<!doctype html><meta charset="utf-8"><style>body{margin:0}</style>${body}`;

before(async () => {
  assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'A built exact-ref binary is required; real integration tests must not silently skip');
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
    if (url.pathname === '/download') {
      response.setHeader('content-type', 'application/octet-stream');
      response.setHeader('content-disposition', 'attachment; filename="../../private.txt"');
      response.end(downloaded); return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/frame') {
      const tag = url.searchParams.get('tag') === 'cross' ? 'cross' : 'same';
      response.end(html(`<div id="host"></div><script>
        const tag=${JSON.stringify(tag)};
        const root=tag==='cross'?document.getElementById('host').attachShadow({mode:'closed'}):document.getElementById('host');
        root.innerHTML='<input id="field">';const field=root.querySelector('input');
        field.addEventListener('input',()=>parent.postMessage({tag,value:field.value},'*'));
        addEventListener('message',event=>{if(event.data==='focus'){field.focus();parent.postMessage({tag,ready:true},'*')}});
      </script>`)); return;
    }
    response.end(html(`
      <input id="field" style="position:absolute;left:10px;top:10px;width:280px;height:30px">
      <div id="drag" style="position:absolute;left:20px;top:80px;width:400px;height:100px;background:#ddd">Drag surface</div>
      <div id="closed" style="position:absolute;left:20px;top:200px"></div>
      <iframe id="same" src="/frame?tag=same" style="position:absolute;left:20px;top:260px;width:250px;height:70px"></iframe>
      <iframe id="cross" src="${crossOrigin}/frame?tag=cross" style="position:absolute;left:300px;top:260px;width:250px;height:70px"></iframe>
      <a id="download" href="/download">Download</a>
      <script>
        window.keyEvents=[];window.physicalKeyEvents=[];window.pointerEvents=[];window.mouseEvents=[];window.messages={};
        document.addEventListener('keydown',e=>window.keyEvents.push({key:e.key,code:e.code,shift:e.shiftKey,control:e.ctrlKey,repeat:e.repeat,trusted:e.isTrusted}));
        for(const type of ['keydown','keyup'])document.addEventListener(type,e=>window.physicalKeyEvents.push({type,key:e.key,code:e.code,trusted:e.isTrusted}));
        for(const type of ['pointerdown','pointermove','pointerup'])document.addEventListener(type,e=>window.pointerEvents.push({type,x:e.clientX,y:e.clientY,buttons:e.buttons,control:e.ctrlKey,trusted:e.isTrusted}));
        document.getElementById('drag').addEventListener('pointerdown',e=>e.target.setPointerCapture(e.pointerId));
        for(const type of ['mousedown','mouseup','click','dblclick','contextmenu'])document.addEventListener(type,e=>{window.mouseEvents.push({type,button:e.button,detail:e.detail,time:performance.now(),trusted:e.isTrusted});if(type==='contextmenu')e.preventDefault()});
        const closed=document.getElementById('closed').attachShadow({mode:'closed'});closed.innerHTML='<input id="inside">';
        window.focusClosed=()=>closed.querySelector('input').focus();window.closedValue=()=>closed.querySelector('input').value;
        addEventListener('message',event=>{if(event.source===document.getElementById('same').contentWindow||event.source===document.getElementById('cross').contentWindow)window.messages[event.data.tag]={...window.messages[event.data.tag],...event.data}});
      </script>`));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  crossOrigin = `http://127.0.0.2:${port}`;
});
after(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

function operation(timeoutMs = 30_000): OperationContext {
  return { signal: new AbortController().signal, timeoutMs, runId: 'browser-input', attemptId: 'fixture', origin: 'test' };
}

function fixture(engine: EngineHandle, attached: string[]): Browser {
  return engine.fixtures!.browser!({
    targetName: 'browser-input', app: { site: '127.0.0.1', resolveUrl: (url: string) => new URL(url, origin).href },
    timeouts: { test: 120_000, action: 30_000, assertion: 30_000 }, signal: new AbortController().signal,
    operation, fixture: (_name: string, value: object) => value, expectable: (value: object) => value,
    attachArtifact: (_kind: string, name: string) => attached.push(name), attachViewport: () => undefined,
    locator: () => { throw new Error('This fixture integration uses public browser input directly'); },
    screen: () => { throw new Error('This fixture integration uses public browser input directly'); },
  } as unknown as EngineFixtureContext) as Browser;
}

async function withBrowser(run: (browser: Browser, attached: string[], artifacts: string, engine: EngineHandle) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-browser-input-'));
  const engine = agentBrowser({ executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE!, executablePath: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium',
    args: process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [], viewport: { width: 640, height: 480 } });
  const signal = new AbortController().signal;
  const errors: unknown[] = [];
  try {
    await engine.init!({ runId: 'browser-input', targetName: 'browser-input', projectRoot: directory, app: { site: '127.0.0.1' }, env: process.env, headed: false, workerSlot: 0, signal, log: () => undefined });
    await engine.startAttempt!({ attemptId: 'fixture', artifactsDir: directory, signal, resolveSecret: async () => { throw new Error('No secrets configured'); }, appLog: () => undefined, navigation: () => undefined, environment: () => undefined });
    const attached: string[] = [];
    await run(fixture(engine, attached), attached, directory, engine);
  } catch (error) { errors.push(error); }
  try { await engine.endAttempt!({ signal: new AbortController().signal, timeoutMs: 15_000 }); }
  catch (error) { errors.push(error); }
  try { await engine.dispose!({ signal: new AbortController().signal, timeoutMs: 15_000 }); }
  catch (error) { errors.push(error); }
  try { await rm(directory, { recursive: true, force: true }); }
  catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Browser input body and cleanup failed');
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 10_000;
  while (!await check()) {
    assert.ok(Date.now() < end, 'Expected browser state did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('public browser keyboard emits held modifiers and repeat, and native type preserves Unicode', { timeout: 120_000 }, async () => {
  await withBrowser(async (browser) => {
    await browser.goto('/');
    await browser.evaluate(() => { (document.getElementById('field') as HTMLInputElement).focus(); return null; });
    await browser.keyboard.down('Shift');
    await browser.keyboard.down('a'); await browser.keyboard.down('a');
    await browser.keyboard.up('a'); await browser.keyboard.up('Shift');
    assert.equal(await browser.evaluate(() => (document.getElementById('field') as HTMLInputElement).value), 'AA');
    const events = await browser.evaluate('window.keyEvents') as Array<{ key: string; code: string; shift: boolean; repeat: boolean; trusted: boolean }>;
    assert.deepEqual(events.filter((event) => event.code === 'KeyA').map((event) => ({ key: event.key, shift: event.shift, repeat: event.repeat, trusted: event.trusted })), [
      { key: 'A', shift: true, repeat: false, trusted: true }, { key: 'A', shift: true, repeat: true, trusted: true },
    ]);
    await browser.evaluate(() => { (document.getElementById('field') as HTMLInputElement).value = ''; return null; });
    await browser.keyboard.type('汉字🙂é');
    assert.equal(await browser.evaluate(() => (document.getElementById('field') as HTMLInputElement).value), '汉字🙂é');
    await browser.evaluate(() => { (document.getElementById('field') as HTMLInputElement).value = ''; (window as unknown as { physicalKeyEvents: unknown[] }).physicalKeyEvents = []; return null; });
    await browser.keyboard.type('Az');
    assert.equal(await browser.evaluate(() => (document.getElementById('field') as HTMLInputElement).value), 'Az');
    const typed = await browser.evaluate('window.physicalKeyEvents') as Array<{ type: string; key: string; code: string; trusted: boolean }>;
    for (const key of ['A', 'z']) {
      assert.equal(typed.filter(event => event.type === 'keydown' && event.key === key && event.trusted).length, 1);
      assert.equal(typed.filter(event => event.type === 'keyup' && event.key === key && event.trusted).length, 1);
    }
  });
});

test('public mouse preserves held drag buttons and keyboard modifiers through decimal movement', { timeout: 120_000 }, async () => {
  await withBrowser(async (browser) => {
    await browser.goto('/');
    await browser.keyboard.down('Control');
    await browser.mouse.move(40.25, 100.75); await browser.mouse.down();
    await browser.mouse.move(180.5, 130.25); await browser.mouse.up();
    await browser.keyboard.up('Control');
    const events = await browser.evaluate('window.pointerEvents') as Array<{ type: string; x: number; y: number; buttons: number; control: boolean; trusted: boolean }>;
    const down = events.find((event) => event.type === 'pointerdown');
    const drag = events.find((event) => event.type === 'pointermove' && event.buttons === 1);
    const up = events.find((event) => event.type === 'pointerup');
    assert.ok(down && drag && up);
    assert.ok(down.control && drag.control && up.control && down.trusted && drag.trusted && up.trusted);
    assert.equal(up.buttons, 0);
    assert.ok(Math.abs(drag.x - 180.5) < 0.51 && Math.abs(drag.y - 130.25) < 0.51);
  });
});

test('native typing accepts exact closed-root and same/cross-origin frame focus, never background-frame focus', { timeout: 120_000 }, async () => {
  await withBrowser(async (browser) => {
    await browser.goto('/');
    await browser.evaluate('window.focusClosed()'); await browser.keyboard.type('closed🙂');
    assert.equal(await browser.evaluate('window.closedValue()'), 'closed🙂');
    for (const tag of ['same', 'cross']) {
      await browser.evaluate((id) => { (document.getElementById(id) as HTMLIFrameElement).contentWindow!.postMessage('focus', '*'); return null; }, tag);
      await eventually(async () => await browser.evaluate((id) => Boolean((window as unknown as { messages: Record<string, { ready?: boolean }> }).messages[id]?.ready), tag));
      await assert.doesNotReject(browser.keyboard.type(`${tag}字`), `${tag}-origin frame focus must accept native typing`);
      await eventually(async () => await browser.evaluate((id) => (window as unknown as { messages: Record<string, { value?: string }> }).messages[id]?.value === `${id}字`, tag));
    }
    await browser.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); return null; });
    await assert.rejects(browser.keyboard.type('must-not-be-typed'), { code: 'NOT_ACTIONABLE' });
    assert.equal(await browser.evaluate('window.messages.cross.value'), 'cross字');
  });
});

test('download fixture waits for actual completion and saves only a generated artifact path', { timeout: 120_000 }, async () => {
  await withBrowser(async (browser, attached, directory) => {
    await browser.goto('/');
    const download = await browser.waitForDownload(async () => { await browser.evaluate(() => { document.getElementById('download')!.click(); return null; }); }, { timeout: 10_000 });
    assert.equal(await readFile(download.absolutePath, 'utf8'), downloaded);
    assert.ok(download.absolutePath.startsWith(`${directory}${path.sep}`));
    assert.match(path.basename(download.absolutePath), /^download-[\da-f-]+\.bin$/);
    assert.ok(!download.path.includes('..'));
    assert.ok(attached.includes(download.path));
  });
});

test('browser evaluation rejects non-JSON values before Chromium serialization discards their identity', { timeout: 120_000 }, async () => {
  await withBrowser(async (browser) => {
    await browser.goto('/');
    for (const source of [
      'new Date()', 'new Map([["key","value"]])', 'document.body', '(() => () => 1)',
      '(() => { const value = {}; value.self = value; return value; })', '({ nested: undefined })',
    ]) await assert.rejects(browser.evaluate(source), { code: 'INVALID_ARGUMENT' });
    assert.equal(await browser.evaluate('undefined'), undefined);
    assert.deepEqual(await browser.evaluate('({ array: [1, true, null], nested: { text: "safe" } })'), { array: [1, true, null], nested: { text: 'safe' } });
  });
});


test('public pointer actions produce right-click, double-click and a sustained long press', { timeout: 120_000 }, async () => {
  await withBrowser(async (browser, _attached, _directory, engine) => {
    await browser.goto('/');
    const point = { x: 200.25, y: 110.5 };
    await engine.performAt!(point, { kind: 'secondaryTap' }, operation());
    let events = await browser.evaluate('window.mouseEvents') as Array<{ type: string; button: number; detail: number; time: number; trusted: boolean }>;
    assert.ok(events.some((event) => event.type === 'contextmenu' && event.button === 2 && event.trusted));
    await browser.evaluate('window.mouseEvents=[]');
    await engine.performAt!(point, { kind: 'doubleTap' }, operation());
    events = await browser.evaluate('window.mouseEvents') as typeof events;
    assert.ok(events.some((event) => event.type === 'dblclick' && event.detail === 2 && event.trusted));
    await browser.evaluate('window.mouseEvents=[]');
    await engine.performAt!(point, { kind: 'longPress', durationMs: 120 }, operation());
    events = await browser.evaluate('window.mouseEvents') as typeof events;
    const down = events.find((event) => event.type === 'mousedown');
    const up = events.find((event) => event.type === 'mouseup');
    assert.ok(down && up); assert.ok(up.time - down.time >= 100);
  });
});
