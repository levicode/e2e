/** Actual advertised action contracts against a synthetic Chromium page. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import type { EngineFixtureContext, EngineHandle, NodeRef, OperationContext } from 'e2e/engine';
import { agentBrowser, type Browser } from '../dist/index.js';

let server: Server;
let origin: string;
before(async () => {
  assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'The real patched binary is required');
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><meta charset="utf-8"><style>
      body{margin:0}input,textarea,[contenteditable]{display:block;width:250px;height:24px;margin:4px}
      #source,#destination{position:absolute;top:170px;width:100px;height:60px;background:#ddd}
      #source{left:20px}#destination{left:300px}#scroller{position:absolute;top:250px;left:20px;width:300px;height:150px;overflow:auto;border:0}
      #below{position:absolute;top:2000px;left:20px}#tail{height:2400px}
    </style><input id="text"><textarea id="area"></textarea><div contenteditable id="editable"></div>
    <label><input id="checked" type="checkbox" checked>Checked</label><button id="hover">Hover here</button>
    <div id="source">Source</div><div id="destination">Destination</div><div id="scroller"><div style="height:1800px">Scroll content</div></div>
    <button id="below">Below viewport</button><div id="tail"></div><script>
      window.changed=[];window.checkedClicks=0;window.hovered=false;window.pointerLog=[];window.wheels=[];
      for(const id of ['text','area','editable'])document.getElementById(id).addEventListener('input',event=>window.changed.push({id,type:event.type}));
      document.getElementById('checked').addEventListener('click',()=>window.checkedClicks++);
      document.getElementById('hover').addEventListener('pointerenter',()=>window.hovered=true);
      for(const type of ['pointerdown','pointermove','pointerup'])document.addEventListener(type,event=>window.pointerLog.push({type,x:event.clientX,y:event.clientY,buttons:event.buttons,trusted:event.isTrusted}));
      document.addEventListener('wheel',event=>window.wheels.push({target:event.target.id||event.target.parentElement.id,dy:event.deltaY,trusted:event.isTrusted}),{passive:true});
    </script>`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
function operation(): OperationContext { return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'actions', attemptId: 'actions', origin: 'test' }; }
async function withEngine(run: (engine: EngineHandle, browser: Browser) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-action-contracts-'));
  const engine = agentBrowser({ executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE!, executablePath: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', args: process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [], viewport: { width: 640, height: 480 } });
  const signal = new AbortController().signal;
  const failures: unknown[] = [];
  try {
    await engine.init!({ runId: 'actions', targetName: 'actions', projectRoot: directory, app: { site: '127.0.0.1' }, env: process.env, headed: false, workerSlot: 0, signal, log: () => undefined });
    await engine.startAttempt!({ attemptId: 'actions', artifactsDir: directory, signal, resolveSecret: async () => { throw new Error('No fixture secrets'); }, appLog: () => undefined, navigation: () => undefined, environment: () => undefined });
    const browser = engine.fixtures!.browser!({
      targetName: 'actions', app: { site: '127.0.0.1', resolveUrl: (url: string) => new URL(url, origin).href }, timeouts: { test: 120_000, action: 30_000, assertion: 30_000 }, signal, operation,
      fixture: (_name: string, value: object) => value, expectable: (value: object) => value, attachArtifact: () => undefined, attachViewport: () => undefined,
      locator: () => { throw new Error('These tests use the public SPI'); }, screen: () => { throw new Error('These tests use the public SPI'); },
    } as unknown as EngineFixtureContext) as Browser;
    await browser.goto('/'); await run(engine, browser);
  } catch (error) { failures.push(error); }
  finally {
    try { await engine.endAttempt!({ signal: new AbortController().signal, timeoutMs: 15_000 }); } catch (error) { failures.push(error); }
    try { await engine.dispose!({ signal: new AbortController().signal, timeoutMs: 15_000 }); } catch (error) { failures.push(error); }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Action acceptance failed; original body error precedes cleanup failures');
}
async function ref(engine: EngineHandle, selector: string): Promise<NodeRef> {
  const nodes = await engine.locate!({ kind: 'selector', selector }, operation());
  assert.equal(nodes.length, 1);
  // Core owns revisions and overwrites the engine's suggestion on every read.
  return { ...nodes[0]!.ref, revision: `harness-locate:${selector}` };
}

test('fill, clear, uncheck, hover, focus, press and explicit scroll act through public exact refs', { timeout: 180_000 }, async () => {
  await withEngine(async (engine, browser) => {
    for (const selector of ['#text', '#area', '#editable']) {
      const target = await ref(engine, selector);
      await engine.perform!(target, { kind: 'fill', value: 'literal --session 汉字', sensitive: false }, operation());
      assert.equal(await browser.evaluate(id => { const node = document.querySelector(id)!; return 'value' in node ? String(node.value) : node.textContent; }, selector), 'literal --session 汉字');
      await engine.perform!(target, { kind: 'clear' }, operation());
      assert.equal(await browser.evaluate(id => { const node = document.querySelector(id)!; return 'value' in node ? String(node.value) : node.textContent; }, selector), '');
    }
    assert.equal((await browser.evaluate('window.changed') as unknown[]).length, 6);
    const checkbox = await ref(engine, '#checked');
    await engine.perform!(checkbox, { kind: 'uncheck' }, operation());
    await engine.perform!(checkbox, { kind: 'uncheck' }, operation());
    assert.deepEqual(await browser.evaluate('({checked:document.getElementById("checked").checked,clicks:window.checkedClicks})'), { checked: false, clicks: 1 });
    await engine.perform!(await ref(engine, '#hover'), { kind: 'hover' }, operation());
    assert.equal(await browser.evaluate('window.hovered'), true);
    const text = await ref(engine, '#text');
    await engine.perform!(text, { kind: 'focus' }, operation());
    await engine.perform!(text, { kind: 'press', key: 'a' }, operation());
    assert.equal(await browser.evaluate('document.getElementById("text").value'), 'a');
    await engine.perform!(await ref(engine, '#below'), { kind: 'scrollIntoView' }, operation());
    assert.equal(await browser.evaluate('(()=>{const r=document.getElementById("below").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()'), true);
  });
});

interface PointerEventRecord { type: string; x: number; y: number; buttons: number; trusted: boolean }
function assertDrag(events: PointerEventRecord[], from: { x: number; y: number }, to: { x: number; y: number }): void {
  const down = events.find(event => event.type === 'pointerdown');
  const up = events.findLast(event => event.type === 'pointerup');
  assert.ok(down?.trusted && up?.trusted);
  assert.ok(Math.abs(down.x - from.x) <= 1 && Math.abs(down.y - from.y) <= 1);
  assert.ok(Math.abs(up.x - to.x) <= 1 && Math.abs(up.y - to.y) <= 1);
  assert.equal(up.buttons, 0);
  assert.ok(events.some(event => event.type === 'pointermove' && event.buttons === 1 && event.trusted && event.x > from.x && event.x < to.x));
}

test('two independent locator resolutions remain usable for native dragTo and point swipeTo', { timeout: 180_000 }, async () => {
  await withEngine(async (engine, browser) => {
    const source = await ref(engine, '#source');
    const destination = await ref(engine, '#destination');
    await engine.perform!(source, { kind: 'dragTo', target: destination }, operation());
    assertDrag(await browser.evaluate('window.pointerLog') as unknown as PointerEventRecord[], { x: 70, y: 200 }, { x: 350, y: 200 });
    await browser.evaluate('window.pointerLog=[]');
    await engine.performAt!({ x: 50, y: 190 }, { kind: 'swipeTo', target: { x: 330, y: 210 }, durationMs: 100 }, operation());
    assertDrag(await browser.evaluate('window.pointerLog') as unknown as PointerEventRecord[], { x: 50, y: 190 }, { x: 330, y: 210 });
  });
});

test('node and pointer swipes dispatch trusted wheels with direction and momentum', { timeout: 180_000 }, async () => {
  await withEngine(async (engine, browser) => {
    const scroller = await ref(engine, '#scroller');
    await engine.perform!(scroller, { kind: 'swipe', direction: 'down', momentum: 'slow' }, operation());
    let wheels = await browser.evaluate('window.wheels') as Array<{ target: string; dy: number; trusted: boolean }>;
    assert.deepEqual(wheels.at(-1), { target: 'scroller', dy: 113, trusted: true });
    assert.ok((await browser.evaluate('document.getElementById("scroller").scrollTop') as number) > 0);
    await engine.performAt!({ x: 160, y: 320 }, { kind: 'swipe', direction: 'up', momentum: 'fast' }, operation());
    wheels = await browser.evaluate('window.wheels') as typeof wheels;
    assert.deepEqual(wheels.at(-1), { target: 'scroller', dy: -720, trusted: true });
    assert.equal(await browser.evaluate('document.getElementById("scroller").scrollTop'), 0);
  });
});
