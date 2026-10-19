import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { inflateSync } from 'node:zlib';
import { test } from 'node:test';
import { type OperationContext } from 'e2e/engine';
import { CdpConnection } from '../src/cdp.ts';
import { NetworkHub } from '../src/network.ts';
import { launchChromium, type OwnedBrowser } from '../src/launch.ts';
import { captureState, readState, restoreState } from '../src/state.ts';
import { captureMaskedPixels, readPngSize } from '../src/pixels.ts';
const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 30_000, runId: 'test', attemptId: 'test', origin: 'test' });

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function evaluate<T>(cdp: CdpConnection, target: string, expression: string): Promise<T> {
  const session = await cdp.attachTarget(target, operation());
  try {
    const answer = await cdp.send<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, operation(), session);
    assert.equal(answer.exceptionDetails, undefined); return answer.result.value;
  } finally { await cdp.send('Target.detachFromTarget', { sessionId: session }, operation()); }
}
async function navigate(cdp: CdpConnection, target: string, url: string): Promise<void> {
  const session = await cdp.attachTarget(target, operation());
  try { await cdp.send('Page.navigate', { url }, operation(), session); }
  finally { await cdp.send('Target.detachFromTarget', { sessionId: session }, operation()); }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if (await evaluate<boolean>(cdp, target, `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`)) return; } catch { /* document changing */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Navigation did not complete');
}

/** Minimal PNG decoder used to assert actual captured pixel values, not just masking metadata. */
function pixelAt(png: Uint8Array, x: number, y: number): number[] {
  const bytes = Buffer.from(png); const size = readPngSize(bytes); assert.ok(size);
  assert.equal(bytes[24], 8); const channels = bytes[25] === 6 ? 4 : 3;
  assert.ok(bytes[25] === 2 || bytes[25] === 6);
  const parts: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset); const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') parts.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(parts)); const stride = size.width * channels;
  let previous = Buffer.alloc(stride); let row = Buffer.alloc(stride);
  const paeth = (a: number, b: number, c: number): number => { const p = a + b - c; const aa = Math.abs(p - a); const bb = Math.abs(p - b); const cc = Math.abs(p - c); return aa <= bb && aa <= cc ? a : bb <= cc ? b : c; };
  for (let yy = 0; yy <= y; yy++) {
    row = Buffer.alloc(stride); const base = yy * (stride + 1); const filter = raw[base];
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels]! : 0; const up = previous[i]!; const upperLeft = i >= channels ? previous[i - channels]! : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      row[i] = (raw[base + 1 + i]! + predictor) & 255;
    }
    previous = row;
  }
  return [...row.subarray(x * channels, x * channels + 3)];
}

test('real Chromium masks all frames and shadows and restores complete structured storage', { timeout: 120_000 }, async () => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url === '/frame' ? '<input id="nested" type="password" value="nested-secret" style="width:180px;height:40px">'
      : '<!doctype html><input id="secret" type="password" value="top-secret" style="width:180px;height:40px"><iframe src="/frame" style="display:block"></iframe><div id="host"></div>');
  });
  const otherServer = createServer((_req, res) => res.end('<!doctype html><input type="password" value="cross-secret" style="width:180px;height:40px">'));
  const origin = await listen(server); const other = await listen(otherServer);
  let browser: OwnedBrowser | undefined; let cdp: CdpConnection | undefined;
  const start = async (): Promise<CdpConnection> => {
    browser = await launchChromium({ executable: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', args: ['--site-per-process', ...(process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])], env: process.env }, operation());
    cdp = await CdpConnection.connect(browser.endpoint, operation()); return cdp;
  };
  try {
    let connection = await start(); let target = (await connection.listTargets(operation())).find(t => t.type === 'page')!.targetId;
    await navigate(connection, target, `${origin}/`);
    await evaluate(connection, target, `document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<input type="password" value="shadow-secret">'; true`);
    await evaluate(connection, target, `(() => {const style=document.createElement('style');style.textContent='@keyframes motion{to{transform:translateX(20px)}}#secret{animation:motion .2s infinite alternate}';document.head.append(style);return true})()`);
    const visibility = await evaluate(connection, target, 'document.visibilityState');
    const capture = await captureMaskedPixels(connection, target, operation());
    assert.equal(await evaluate(connection, target, 'document.visibilityState'), visibility);
    assert.equal(await evaluate(connection, target, 'new Promise(resolve => setTimeout(() => resolve(true), 0))'), true, 'Main-frame ordinary tasks must resume after capture');
    assert.equal(await evaluate(connection, target, 'new Promise(resolve => document.querySelector("iframe").contentWindow.setTimeout(() => resolve(true), 0))'), true, 'Same-origin child tasks must resume after capture');
    assert.equal(await evaluate(connection, target, `document.querySelector('#secret').getAnimations()[0].playState`), 'running');
    assert.ok(capture.maskedRegionCount >= 3); assert.equal(capture.maskingProven, true);
    const center = await evaluate<number[]>(connection, target, `(() => {const r=document.querySelector('#secret').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
    assert.deepEqual(pixelAt(capture.pixels.data, Math.floor(center[0]! * capture.pixels.scale), Math.floor(center[1]! * capture.pixels.scale)), [0, 0, 0]);
    assert.equal(await evaluate(connection, target, `document.querySelectorAll('[popover]').length`), 0);
    const crossOrigin = other.replace('127.0.0.1', 'localhost');
    await evaluate(connection, target, `new Promise(resolve=>{const frame=document.createElement('iframe');frame.id='cross';frame.style.cssText='display:block;width:220px;height:80px';frame.onload=()=>resolve(true);frame.src=${JSON.stringify(crossOrigin + '/')};document.body.append(frame)})`);
    const crossCapture = await captureMaskedPixels(connection, target, operation());
    assert.ok(crossCapture.maskedRegionCount >= 4);
    const remote = (await connection.listTargets(operation())).find(item => item.type === 'iframe' && item.url === `${crossOrigin}/`);
    assert.ok(remote, 'The fixture must exercise a real out-of-process child frame');
    assert.equal(await evaluate(connection, remote.targetId, 'new Promise(resolve => setTimeout(() => resolve(true), 0))'), true, 'Out-of-process child tasks must resume after capture');
    const crossCenter = await evaluate<number[]>(connection, target, `(()=>{const r=document.querySelector('#cross').getBoundingClientRect();return [r.x+100,r.y+30]})()`);
    assert.deepEqual(pixelAt(crossCapture.pixels.data, Math.floor(crossCenter[0]! * crossCapture.pixels.scale), Math.floor(crossCenter[1]! * crossCapture.pixels.scale)), [0,0,0]);
    await evaluate(connection, target, `(() => {const nodes=[document.querySelector('#host').shadowRoot.querySelector('input'),document.querySelector('iframe:not(#cross)').contentDocument.querySelector('input')];window.additionalMaskAnimations=nodes.map(node=>node.animate([{transform:'translateX(0px)'},{transform:'translateX(10px)'}],{duration:200,iterations:Infinity,direction:'alternate'}));return true})()`);
    await evaluate(connection, remote.targetId, `(()=>{window.remoteMaskAnimation=document.querySelector('input').animate([{transform:'translateX(0px)'},{transform:'translateX(10px)'}],{duration:200,iterations:Infinity,direction:'alternate'});return true})()`);
    // Independent required captures, not retries: every image must pass real pixel checks.
    for (let iteration = 0; iteration < 12; iteration++) {
      const repeated = await captureMaskedPixels(connection, target, operation());
      assert.ok(repeated.maskedRegionCount >= 4); assert.equal(repeated.maskingProven, true);
      const centers = await evaluate<number[][]>(connection, target, `(() => {const center=node=>{const r=node.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]};const frame=document.querySelector('iframe:not(#cross)');const box=frame.getBoundingClientRect();const local=center(frame.contentDocument.querySelector('input'));const cross=document.querySelector('#cross').getBoundingClientRect();return [center(document.querySelector('#secret')),center(document.querySelector('#host').shadowRoot.querySelector('input')),[box.x+frame.clientLeft+local[0],box.y+frame.clientTop+local[1]],[cross.x+100,cross.y+30]]})()`);
      for (const [x, y] of centers) assert.deepEqual(pixelAt(repeated.pixels.data, Math.floor(x! * repeated.pixels.scale), Math.floor(y! * repeated.pixels.scale)), [0, 0, 0], `Every secure region must be black in independent capture ${iteration}`);
      assert.deepEqual(pixelAt(repeated.pixels.data, repeated.pixels.width - 10, 10), [255, 255, 255], 'Unrelated source pixels must remain useful');
      assert.equal(await evaluate(connection, target, `document.visibilityState===${JSON.stringify(visibility)}&&document.querySelector('#secret').getAnimations()[0].playState==='running'&&additionalMaskAnimations.every(animation=>animation.playState==='running')&&document.querySelectorAll('[popover]').length===0`), true);
      assert.equal(await evaluate(connection, remote.targetId, `remoteMaskAnimation.playState==='running'&&document.querySelectorAll('[popover]').length===0`), true);
      assert.equal(await evaluate(connection, target, 'new Promise(resolve => setTimeout(() => document.querySelector("iframe:not(#cross)").contentWindow.setTimeout(() => resolve(true), 0), 0))'), true);
      assert.equal(await evaluate(connection, remote.targetId, 'new Promise(resolve => setTimeout(() => resolve(true), 0))'), true);
    }
    await evaluate(connection, target, `document.querySelector('#cross').remove();true`);
    await evaluate(connection, target, `document.cookie='auth=credential; Path=/';localStorage.setItem('token','local-value');sessionStorage.setItem('token','tab-value');new Promise((resolve,reject)=>{const r=indexedDB.open('credentials',2);r.onupgradeneeded=()=>{const s=r.result.createObjectStore('items',{keyPath:'id',autoIncrement:true});s.createIndex('byName','name',{unique:true})};r.onsuccess=()=>{const db=r.result;const tx=db.transaction('items','readwrite');const s=tx.objectStore('items');const buffer=new Uint8Array([1,2,3,4]).buffer;const graph={date:new Date('2026-01-02'),buffer,view:new Uint8Array(buffer,1,2),map:new Map(),set:new Set(),big:99n,nan:NaN,minusZero:-0,absent:undefined,blob:new Blob(['blob-bytes'],{type:'text/plain'}),file:new File(['file-bytes'],'saved.txt',{lastModified:123})};graph.self=graph;graph.map.set(graph,graph.view);graph.set.add(graph);s.put({id:7,name:'alice',nested:{roles:['admin']},graph});s.put({id:20,name:'deleted'});s.delete(20);tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=reject};r.onerror=reject})`);
    const second = (await connection.send<{targetId:string}>('Target.createTarget', {url:'about:blank'}, operation())).targetId;
    await navigate(connection, second, `${other}/`);
    await evaluate(connection, second, `localStorage.setItem('old-origin','retained'); true`);
    await connection.send('Target.closeTarget', {targetId:second}, operation());
    const snapshot = await captureState(connection, operation(), new Set([origin, other]));
    const saved = readState(snapshot); assert.equal(saved.origins.length, 2);
    assert.equal(saved.origins.find(o=>o.origin===origin)!.indexedDB.find(db=>db.name==='credentials')!.stores.find(store=>store.name==='items')!.nextKey, 21);
    // New state after capture must not survive a replacement, even on an origin absent from the snapshot.
    await evaluate(connection, target, `document.cookie='rogue=remove-me; Path=/';localStorage.setItem('rogue','remove-me');sessionStorage.setItem('rogue','remove-me');true`);
    const abandoned = (await connection.send<{targetId:string}>('Target.createTarget', {url:'about:blank'}, operation())).targetId;
    await navigate(connection, abandoned, `${crossOrigin}/`);
    await evaluate(connection, abandoned, `localStorage.setItem('not-in-snapshot','remove-me');true`);
    await connection.send('Target.closeTarget', {targetId:abandoned}, operation());
    connection = await restoreState(snapshot, operation(), async () => { cdp?.close(); await browser?.close(); return start(); });
    target = (await connection.listTargets(operation())).find(t => t.type === 'page')!.targetId;
    await navigate(connection, target, `${origin}/`);
    assert.equal(await evaluate(connection, target, `localStorage.getItem('token')`), 'local-value');
    assert.equal(await evaluate(connection, target, `sessionStorage.getItem('token')`), 'tab-value');
    assert.match(await evaluate<string>(connection, target, `document.cookie`), /auth=credential/);
    assert.equal(await evaluate(connection, target, `localStorage.getItem('rogue')`), null);
    assert.equal(await evaluate(connection, target, `sessionStorage.getItem('rogue')`), null);
    assert.doesNotMatch(await evaluate<string>(connection, target, `document.cookie`), /rogue=/);
    const graph = await evaluate(connection, target, `new Promise((resolve,reject)=>{const r=indexedDB.open('credentials');r.onsuccess=()=>{const db=r.result;const get=db.transaction('items').objectStore('items').get(7);get.onsuccess=async()=>{const g=get.result.graph;db.close();resolve({date:g.date.toISOString(),binary:Array.from(new Uint8Array(g.buffer)),view:Array.from(g.view),shared:g.view.buffer===g.buffer,cycle:g.self===g,map:g.map.get(g)===g.view,set:g.set.has(g),big:String(g.big),nan:Number.isNaN(g.nan),minusZero:Object.is(g.minusZero,-0),absent:Object.hasOwn(g,'absent')&&g.absent===undefined,blob:await g.blob.text(),file:await g.file.text(),filename:g.file.name})};get.onerror=reject};r.onerror=reject})`);
    assert.deepEqual(graph, {date:'2026-01-02T00:00:00.000Z',binary:[1,2,3,4],view:[2,3],shared:true,cycle:true,map:true,set:true,big:'99',nan:true,minusZero:true,absent:true,blob:'blob-bytes',file:'file-bytes',filename:'saved.txt'});
    assert.equal(await evaluate(connection, target, `new Promise((resolve,reject)=>{const r=indexedDB.open('credentials');r.onsuccess=()=>{const db=r.result;const tx=db.transaction('items','readwrite');const a=tx.objectStore('items').add({name:'bob'});a.onsuccess=()=>resolve(a.result);a.onerror=reject;tx.oncomplete=()=>db.close()};r.onerror=reject})`), 21);
    await evaluate(connection, target, `sessionStorage.setItem('token','updated');true`);
    await navigate(connection, target, `${origin}/frame`);
    assert.equal(await evaluate(connection, target, `sessionStorage.getItem('token')`), 'updated');
    await navigate(connection, target, `${other}/`);
    assert.equal(await evaluate(connection, target, `localStorage.getItem('old-origin')`), 'retained');
    const cleared = (await connection.send<{targetId:string}>('Target.createTarget', {url:'about:blank'}, operation())).targetId;
    await navigate(connection, cleared, `${crossOrigin}/`);
    assert.equal(await evaluate(connection, cleared, `localStorage.getItem('not-in-snapshot')`), null);
    await connection.send('Target.closeTarget', {targetId:cleared}, operation());
    await evaluate(connection, target, `(()=>{const root=document.body.attachShadow({mode:'closed'});root.innerHTML='<input type="password" value="hidden-secret" style="width:180px;height:40px">';window.closedAnimation=root.querySelector('input').animate([{transform:'translateX(0px)'},{transform:'translateX(10px)'}],{duration:200,iterations:Infinity,direction:'alternate'});return true})()`);
    const closedCapture = await captureMaskedPixels(connection, target, operation());
    assert.ok(closedCapture.maskedRegionCount >= 1);
    assert.deepEqual(pixelAt(closedCapture.pixels.data, 50, 20), [0, 0, 0]);
    assert.equal(await evaluate(connection, target, 'closedAnimation.playState'), 'running');
    await navigate(connection, target, `${origin}/`);
    await evaluate(connection, target, `new Promise((resolve,reject)=>{const r=indexedDB.open('bad');r.onupgradeneeded=()=>r.result.createObjectStore('s');r.onsuccess=()=>{const db=r.result;const tx=db.transaction('s','readwrite');tx.objectStore('s').put(new Date(),'date');tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=reject};r.onerror=reject})`);
    const structured = await captureState(connection, operation(), new Set([origin]));
    assert.equal(readState(structured).origins.find(o=>o.origin===origin)!.indexedDB.some(db=>db.name==='bad'), true);
  } finally {
    cdp?.close(); await browser?.close(); await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),new Promise<void>(resolve=>otherServer.close(()=>resolve()))]);
  }
});


test('storage probes never run user init scripts or routes, while a concurrent popup still receives both', { timeout: 90_000 }, async () => {
  const server = createServer((_request, response) => { response.setHeader('content-type','text/html'); response.end('<!doctype html><script>localStorage.setItem("application-script","ran")</script>'); });
  const origin = await listen(server);
  let browser: OwnedBrowser | undefined; let cdp: CdpConnection | undefined; let hub: NetworkHub | undefined;
  try {
    browser = await launchChromium({ executable: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', args: process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [], env: process.env }, operation());
    const connection = await CdpConnection.connect(browser.endpoint, operation()); cdp = connection;
    const network = new NetworkHub(connection, { operation, resolveUrl: (url)=>new URL(url,origin).href, resolvePath: value=>value }); hub = network;
    await network.start(operation());
    const initialized = new Set<string>(); let routed = 0;
    await network.registerSessionInitializer(async (session, target, context) => {
      initialized.add(target);
      await connection.send('Page.addScriptToEvaluateOnNewDocument', { source: `globalThis.fixtureHook=true;if(location.protocol==='http:')localStorage.setItem('token','changed-by-user-hook');` }, context, session);
    }, operation());
    await network.route('**/', async route=>{routed++;await route.fallback();}, operation());
    const target = (await connection.listTargets(operation())).find(item=>item.type==='page')!.targetId;
    await network.useTarget(target, operation());
    await navigate(connection,target,`${origin}/`);
    await evaluate(connection,target, `localStorage.setItem('token','saved-value');localStorage.removeItem('application-script');true`);
    const initializedBefore = initialized.size; const routedBefore = routed;
    const state = await captureState(connection,operation(),new Set([origin]),{
      create: context=>network.createProbeTarget(context), release:(id,context)=>network.releaseProbeTarget(id,context),
    });
    assert.equal(readState(state).origins[0]!.localStorage.find(([key])=>key==='token')?.[1],'saved-value');
    assert.equal(await evaluate(connection,target,`localStorage.getItem('token')`),'saved-value');
    assert.equal(await evaluate(connection,target,`localStorage.getItem('application-script')`),null);
    assert.equal(initialized.size,initializedBefore); assert.equal(routed,routedBefore);
    const [probe, popup] = await Promise.all([
      network.createProbeTarget(operation()),
      connection.send<{targetId:string}>('Target.createTarget',{url:'about:blank',background:true},operation()),
    ]);
    await network.sessionForTarget(popup.targetId,operation());
    await navigate(connection,popup.targetId,`${origin}/`);
    assert.equal(await evaluate(connection,popup.targetId,`globalThis.fixtureHook`),true);
    assert.equal(initialized.has(probe),false); assert.equal(initialized.has(popup.targetId),true);
    assert.equal(routed,routedBefore+1);
    await connection.send('Target.closeTarget',{targetId:popup.targetId},operation());
    await network.releaseProbeTarget(probe,operation());
    await network.settle(operation());
  } finally {
    hub?.close(); cdp?.close(); await browser?.close();
    await new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});
  }
});
