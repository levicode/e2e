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

test('HTML OBJECT screenshots prove nested content-box geometry, real OOPIF pixels and cleanup at both DPRs', { timeout: 120_000 }, async () => {
  let origin = '';
  const leaf = '<!doctype html><style>html,body{margin:0;background:white}input{position:absolute;left:20px;top:20px;width:100px;height:30px;box-sizing:border-box;border:0;padding:0;background:red}</style><input id="secret" type="password" value="generic-fixture-secret">';
  const owner = (tag: string, id: string, url: string, style: string): string => `<${tag} id="${id}" ${tag === 'object' ? `type="text/html" data="${url}"` : `src="${url}"`} style="${style}"></${tag}>`;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    const url = new URL(request.url!, origin || 'http://127.0.0.1');
    if (url.pathname === '/leaf') { response.end(leaf); return; }
    const remote = origin.replace('127.0.0.1', 'localhost');
    if (url.pathname === '/middle') {
      response.end(`<!doctype html><style>body{margin:0}</style>${owner(url.searchParams.get('tag') ?? 'iframe', 'inner', `${url.searchParams.has('cross') ? remote : origin}/leaf`, 'position:absolute;left:10px;top:10px;width:180px;height:100px;border:3px solid blue;padding:4px')}`); return;
    }
    const nested = url.searchParams.get('nested');
    const childUrl = nested ? `${origin}/middle?tag=${nested}${url.searchParams.has('cross') ? '&cross=1' : ''}` : `${url.searchParams.has('cross') ? remote : origin}/leaf`;
    response.end(`<!doctype html><style>html,body{margin:0;background:white}</style>${owner(url.searchParams.get('tag') ?? 'object', 'outer', childUrl, `position:absolute;left:${url.searchParams.has('scroll') ? -15 : 40}px;top:${url.searchParams.has('scroll') ? 700 : 60}px;width:240px;height:160px;border:5px solid blue;padding:7px`)}<div style="height:2000px"></div>`);
  });
  origin = await listen(server);
  let browser: OwnedBrowser | undefined; let connection: CdpConnection | undefined;
  try {
    browser = await launchChromium({ executable: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', args: ['--site-per-process', ...(process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])], env: process.env }, operation());
    const cdp = await CdpConnection.connect(browser.endpoint, operation()); connection = cdp;
    const target = (await cdp.listTargets(operation())).find(item => item.type === 'page')!.targetId;
    const metricsSession = await cdp.attachTarget(target, operation());
    try {
      for (const deviceScaleFactor of [1, 2]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor, mobile: false }, operation(), metricsSession);
        for (const query of ['', '?nested=iframe', '?tag=iframe&nested=object', '?cross=1', '?nested=object&cross=1', '?scroll=1']) {
          await navigate(cdp, target, `${origin}/${query}`);
          if (query.includes('scroll')) await evaluate(cdp, target, 'scrollTo(0,650); true');
          if (query.includes('cross')) {
            const remote = (await cdp.listTargets(operation())).find(item => item.type === 'iframe' && item.url === `${origin.replace('127.0.0.1', 'localhost')}/leaf`);
            assert.ok(remote, 'Cross-origin OBJECT fixture must be a real out-of-process child');
          }
          // The fixture oracle reads DOM geometry independently from captureMaskedPixels.
          // It does not access the final child's document, so cross-origin children are included.
          const center = await evaluate<number[]>(cdp, target, `(() => {let x=70,y=35;let doc=document;for(const id of ${JSON.stringify(query.includes('nested') ? ['outer', 'inner'] : ['outer'])}){const node=doc.getElementById(id);const r=node.getBoundingClientRect(),s=getComputedStyle(node);x+=r.left+parseFloat(s.borderLeftWidth)+parseFloat(s.paddingLeft);y+=r.top+parseFloat(s.borderTopWidth)+parseFloat(s.paddingTop);doc=node.contentDocument}return [x,y]})()`);
          for (let iteration = 0; iteration < 2; iteration++) {
            const captured = await captureMaskedPixels(cdp, target, operation());
            assert.equal(captured.maskedRegionCount, 1, `${query}: the nested sensitive control is inspected exactly once`);
            assert.equal(captured.maskingProven, true);
            assert.deepEqual(pixelAt(captured.pixels.data, Math.floor(center[0]! * captured.pixels.scale), Math.floor(center[1]! * captured.pixels.scale)), [0, 0, 0], `${query}: actual child password pixels are black at DPR ${deviceScaleFactor}`);
            assert.deepEqual(pixelAt(captured.pixels.data, captured.pixels.width - 10, 10), [255, 255, 255], 'The image still contains useful unmasked source pixels');
            assert.equal(await evaluate(cdp, target, 'document.querySelectorAll("[popover]").length'), 0);
            assert.equal(await evaluate(cdp, target, 'new Promise(resolve => setTimeout(() => resolve(true), 0))'), true);
          }
        }
      }
    } finally { await cdp.send('Emulation.clearDeviceMetricsOverride', {}, operation(), metricsSession); await cdp.send('Target.detachFromTarget', { sessionId: metricsSession }, operation()); }
  } finally { connection?.close(); await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('HTML OBJECT screenshot proof rejects transforms and mutations without returning bytes', { timeout: 90_000 }, async () => {
  const server = createServer((request, response) => {
    if (request.url === '/vector') { response.setHeader('Content-Type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" fill="red"/></svg>'); return; }
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/embed') { response.end('<!doctype html><embed type="text/html" src="/leaf">'); return; }
    if (request.url === '/svg-object') { response.end('<!doctype html><object type="image/svg+xml" data="/vector"></object>'); return; }
    response.end(request.url === '/leaf' ? '<!doctype html><input type="password" value="generic-fixture-secret">' : '<!doctype html><object id="outer" type="text/html" data="/leaf" style="width:240px;height:160px"></object>');
  });
  const origin = await listen(server); let browser: OwnedBrowser | undefined; let connection: CdpConnection | undefined;
  try {
    browser = await launchChromium({ executable: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', args: process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [], env: process.env }, operation());
    const cdp = await CdpConnection.connect(browser.endpoint, operation()); connection = cdp;
    const target = (await cdp.listTargets(operation())).find(item => item.type === 'page')!.targetId;
    const send = cdp.send.bind(cdp); let captures = 0; let mutateAfterCapture: string | undefined;
    cdp.send = async <T>(method: string, params: Record<string, unknown>, context: OperationContext, session?: string): Promise<T> => {
      const answer = await send<T>(method, params, context, session);
      if (method === 'Page.captureScreenshot') { captures++; if (mutateAfterCapture) await evaluate(cdp, target, mutateAfterCapture); }
      return answer;
    };
    for (const path of ['/embed', '/svg-object']) {
      await navigate(cdp, target, `${origin}${path}`);
      await assert.rejects(captureMaskedPixels(cdp, target, operation()), /unsupported-owner-(type|document)/);
      assert.equal(captures, 0, 'Unsupported rendering contexts never request screenshot bytes');
    }
    for (const declaration of ['transform:translateX(1px)', 'zoom:1.1', 'rotate:1deg']) {
      await navigate(cdp, target, `${origin}/`);
      await evaluate(cdp, target, `document.querySelector('#outer').style.cssText+=';${declaration}';true`);
      const previous = captures;
      // macOS may reject transformed masks before reaching the owner geometry proof.
      await assert.rejects(captureMaskedPixels(cdp, target, operation()), /(?:transformed-owner|verify-before-masks)/);
      assert.equal(captures, previous, 'Unproven geometry must fail before capture');
      assert.equal(await evaluate(cdp, target, `document.querySelector('#outer').contentDocument.querySelectorAll('[popover]').length`), 0);
    }
    for (const mutation of [
      `document.querySelector('#outer').style.width='250px';true`,
      `document.querySelector('#outer').style.left='20px';document.querySelector('#outer').style.position='relative';true`,
      `document.querySelector('#outer').replaceWith(document.querySelector('#outer').cloneNode());true`,
      `document.querySelector('#outer').remove();true`,
      `(()=>{const doc=document.querySelector('#outer').contentDocument;doc.open();doc.write('<!doctype html><input type=password value=replacement>');doc.close();return true})()`,
    ]) {
      await navigate(cdp, target, `${origin}/`); mutateAfterCapture = mutation;
      const previous = captures;
      await assert.rejects(captureMaskedPixels(cdp, target, operation()), /masking could not be proven/);
      assert.equal(captures, previous + 1, 'Post-capture failure discards the single captured image, without retries');
      mutateAfterCapture = undefined;
      assert.equal(await evaluate(cdp, target, 'document.querySelectorAll("[popover]").length'), 0);
    }
    await navigate(cdp, target, `${origin}/`);
    assert.equal((await captureMaskedPixels(cdp, target, operation())).maskingProven, true, 'A failed proof must leave the owned renderer usable');
  } finally { connection?.close(); await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('HTML OBJECT without a browsing context is safe only under a proven display:none subtree', { timeout: 120_000 }, async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/child') { response.end('<!doctype html><style>html,body{margin:0}input{position:absolute;left:20px;top:20px;width:100px;height:30px}</style><input type="password" value="generic-child-secret">'); return; }
    response.end('<!doctype html><style>html,body{margin:0;background:white}#hidden{display:none}object{display:block;opacity:0;pointer-events:none;width:200px;height:80px}input{position:absolute;left:20px;top:20px;width:100px;height:30px}</style><input type="password" value="generic-fixture-secret"><section id="hidden"><object id="dormant" type="text/html" data="about:blank"><input value="fallback-secret"></object></section><object id="live" type="text/html" data="/child" style="position:absolute;left:300px;top:20px;width:240px;height:160px;opacity:1;border:0;padding:0"></object><object id="fractional" type="text/html" data="about:blank" style="position:absolute;left:600px;top:20px;width:120px;height:76.625px;border:0;padding:0"></object>');
  });
  const origin = await listen(server); let browser: OwnedBrowser | undefined; let connection: CdpConnection | undefined;
  try {
    browser = await launchChromium({ executable: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', args: process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [], env: process.env }, operation());
    const cdp = await CdpConnection.connect(browser.endpoint, operation()); connection = cdp;
    const target = (await cdp.listTargets(operation())).find(item => item.type === 'page')!.targetId;
    await navigate(cdp, target, origin);
    assert.equal(await evaluate(cdp, target, 'document.querySelector("#dormant").contentDocument === null'), true, 'The fixture must exercise an uninstantiated object');
    assert.deepEqual(await evaluate(cdp, target, '(()=>{const o=document.querySelector("#fractional");return [o.getBoundingClientRect().height,o.contentDocument.defaultView.innerHeight]})()'), [76.625, 77]);
    const captured = await captureMaskedPixels(cdp, target, operation());
    assert.equal(captured.maskingProven, true);
    assert.deepEqual(pixelAt(captured.pixels.data, Math.floor(50 * captured.pixels.scale), Math.floor(30 * captured.pixels.scale)), [0, 0, 0]);
    assert.deepEqual(pixelAt(captured.pixels.data, Math.floor(350 * captured.pixels.scale), Math.floor(50 * captured.pixels.scale)), [0, 0, 0], 'A live HTML child remains inspected beside a dormant owner');
    assert.deepEqual(pixelAt(captured.pixels.data, captured.pixels.width - 10, 10), [255, 255, 255]);
    assert.equal(await evaluate(cdp, target, 'document.querySelectorAll("[popover]").length'), 0);
    const send = cdp.send.bind(cdp);
    for (const transition of ['reveal', 'replace', 'remove', 'resize'] as const) {
      await navigate(cdp, target, origin + '/' + transition);
      let changed = false;
      cdp.send = async <T>(method: string, params: Record<string, unknown>, context: OperationContext, session?: string): Promise<T> => {
        const result = await send<T>(method, params, context, session);
        if (method === 'Page.captureScreenshot' && !changed) {
          changed = true;
          await send('Runtime.evaluate', { expression: transition === 'resize' ? 'document.querySelector("#fractional").style.height="76.75px"' : transition === 'reveal' ? 'document.querySelector("#hidden").style.display="block"' : transition === 'remove' ? 'document.querySelector("#dormant").remove()' : 'document.querySelector("#dormant").replaceWith(document.querySelector("#dormant").cloneNode(true))' }, operation(), session);
        }
        return result;
      };
      await assert.rejects(captureMaskedPixels(cdp, target, operation()), /masking could not be proven/, transition);
      assert.equal(changed, true);
      assert.equal(await evaluate(cdp, target, 'document.querySelectorAll("[popover]").length'), 0);
      cdp.send = send;
    }
  } finally { connection?.close(); await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
