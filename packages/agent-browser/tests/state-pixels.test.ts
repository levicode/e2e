import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { EngineError, type EngineState, type OperationContext } from 'e2e/engine';
import { CdpConnection } from '../src/cdp.ts';
import { captureState, decodeStateValue, encodeStateValue, readState, releaseStateProbeTarget, restoreState } from '../src/state.ts';
import { captureMaskedPixels, readPngSize, verifyMaskableDom } from '../src/pixels.ts';

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 30_000, runId: 'test', attemptId: 'test', origin: 'test' });
const empty = (): EngineState => ({ format: 'agent-browser-state', version: 1, data: { cookies: [], origins: [], tabs: [] } });

test('state validation rejects bad formats and non-JSON payloads without reflecting secrets', () => {
  assert.deepEqual(readState(empty()), empty().data);
  for (const value of [undefined, new Date(), new Uint8Array([1]), NaN, Infinity, -0, 1n]) {
    const state: EngineState = { ...empty(), data: { cookies: [], origins: [], tabs: [], secret: value } };
    assert.throws(() => readState(state), (error: unknown) => error instanceof EngineError && error.code === 'INVALID_STATE' && !error.message.includes('secret'));
  }
  assert.throws(() => readState({ ...empty(), format: 'secret-value' }), /Unsupported or malformed/);
});

test('state validation rejects opaque origins and unsupported IndexedDB keys', async () => {
  const state = (key: unknown): EngineState => ({ ...empty(), data: { cookies: [], tabs: [], origins: [{ origin: 'https://example.test', localStorage: [], indexedDB: [{ name: 'db', version: 1, stores: [{ name: 'store', keyPath: null, autoIncrement: false, indexes: [], records: [{ key, value: { root: ['string', 'okay'], nodes: [] } }] }] }] }] } });
  const validKey = await encodeStateValue(['id', 7, new Date('2026-01-01')]);
  assert.doesNotThrow(() => readState(state(validKey)));
  assert.throws(() => readState(state({ nested: 'unsupported' })), /Unsupported or malformed/);
  assert.throws(() => readState({ ...empty(), data: { cookies: [], tabs: [], origins: [{ origin: 'null', localStorage: [], indexedDB: [] }] } }));
});

test('invalid state is refused before replacing the browser', async () => {
  let replaced = false;
  await assert.rejects(restoreState({ ...empty(), version: 2 }, operation(), async () => { replaced = true; throw new Error('must not run'); }));
  assert.equal(replaced, false);
});

test('mask proof requires closed-root resolution and rejects inaccessible frames independently of semantic nodes', () => {
  verifyMaskableDom({ nodeType: 9, children: [{ nodeType: 1, frameId: 'frame', contentDocument: { nodeType: 9 } }] }, ['top', 'frame']);
  assert.throws(() => verifyMaskableDom({ nodeType: 9, children: [{ frameId: 'oopif' }] }, ['top', 'oopif']), /masking could not be proven/);
  assert.throws(() => verifyMaskableDom({ nodeType: 9, shadowRoots: [{ shadowRootType: 'closed' }] }, ['top']), /masking could not be proven/);
  assert.deepEqual(verifyMaskableDom({ nodeType: 9, shadowRoots: [{ shadowRootType: 'closed', backendNodeId: 42 }] }, ['top'], true), [{ frameId: 'top', backendNodeId: 42 }]);
});

test('PNG dimensions come from a valid IHDR rather than guessed viewport dimensions', () => {
  assert.equal(readPngSize(new Uint8Array(24)), null);
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4); png.writeUInt32BE(13, 8); png.write('IHDR', 12);
  png.writeUInt32BE(1234, 16); png.writeUInt32BE(567, 20);
  assert.deepEqual(readPngSize(png), { width: 1234, height: 567 });
  png.writeUInt32BE(0, 20); assert.equal(readPngSize(png), null);
});


test('structured-clone graph roundtrips Dates, binary views, maps, sets, cycles and non-JSON scalars', async () => {
  const buffer = new Uint8Array([10, 20, 30, 40]).buffer;
  const sparse: unknown[] = []; sparse.length = 3; sparse[0] = 1; sparse[2] = 3;
  const original: Record<string, unknown> = {
    date: new Date('2026-10-19T00:00:00.000Z'), buffer, view: new Uint8Array(buffer, 1, 2),
    dataView: new DataView(buffer, 1, 2), map: new Map(), set: new Set(), nan: NaN,
    infinite: Infinity, negative: -0, big: 99999999999999999999999999n, absent: undefined,
    sparse, regex: /a+b/gi, error: new TypeError('sample'),
  };
  original.self = original;
  (original.map as Map<unknown, unknown>).set(original, original.view);
  (original.set as Set<unknown>).add(original);
  const decoded = decodeStateValue(JSON.parse(JSON.stringify(await encodeStateValue(original)))) as typeof original;
  assert.equal(decoded.self, decoded);
  assert.deepEqual(decoded.date, original.date);
  assert.deepEqual(decoded.buffer, buffer);
  assert.equal((decoded.view as Uint8Array).buffer, decoded.buffer);
  assert.deepEqual([...decoded.view as Uint8Array], [20, 30]);
  assert.equal((decoded.dataView as DataView).getUint8(0), 20);
  assert.equal((decoded.map as Map<unknown, unknown>).get(decoded), decoded.view);
  assert.equal((decoded.set as Set<unknown>).has(decoded), true);
  assert.equal(Number.isNaN(decoded.nan), true);
  assert.equal(decoded.infinite, Infinity); assert.equal(Object.is(decoded.negative, -0), true);
  assert.equal(decoded.big, original.big); assert.equal(Object.hasOwn(decoded, 'absent'), true);
  assert.equal(1 in (decoded.sparse as number[]), false);
  assert.equal(String(decoded.regex), '/a+b/gi');
  assert.equal((decoded.error as Error).name, 'TypeError'); assert.ok(decoded.error instanceof TypeError);
});

test('structured-clone graph preserves Blob/File bytes and prototype-sensitive property names', async () => {
  const object = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
  const value = { blob: new Blob(['secret bytes'], { type: 'text/plain' }), file: new File(['payload'], 'name.txt', { type: 'text/plain', lastModified: 123 }), object };
  const decoded = decodeStateValue(await encodeStateValue(value)) as typeof value;
  assert.equal(await decoded.blob.text(), 'secret bytes'); assert.equal(decoded.blob.type, 'text/plain');
  assert.equal(await decoded.file.text(), 'payload'); assert.equal(decoded.file.name, 'name.txt'); assert.equal(decoded.file.lastModified, 123);
  assert.equal(Object.hasOwn(decoded.object, '__proto__'), true); assert.equal(Object.getPrototypeOf(decoded.object), Object.prototype);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('structured-clone graph rejects forged references and unrecognized constructors', async () => {
  assert.throws(() => decodeStateValue({ root: ['ref', 99], nodes: [] }));
  assert.throws(() => decodeStateValue({ root: ['ref', 0], nodes: [{ kind: 'view', name: 'Function', buffer: ['ref', 0], offset: 0, length: 0 }] }));
  await assert.rejects(encodeStateValue(() => 'never serializable'));
});

function pixelFixture(white?: { x: number; y: number }, size = { width: 100, height: 80 }): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const encoded = Buffer.alloc(data.length + 12); encoded.writeUInt32BE(data.length); encoded.write(type, 4); data.copy(encoded, 8);
    encoded.writeUInt32BE(crc32(encoded.subarray(4, -4)), encoded.length - 4); return encoded;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(size.width); header.writeUInt32BE(size.height, 4); header[8] = 8; header[9] = 2;
  const stride = size.width * 3 + 1; const rows = Buffer.alloc(size.height * stride); if (white) rows.fill(255, white.y * stride + 1 + white.x * 3, white.y * stride + 1 + white.x * 3 + 3);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function mockPixels(options: { dormant?: 'self' | 'ancestor' | 'shadow' | 'slot' | 'opacity' | 'visible'; revealAt?: 'before' | 'after'; ownerTag?: string; childContentType?: string; ownerStyle?: Record<string, string>; ownerDisconnected?: boolean; inaccessibleFrame?: boolean; oopif?: boolean; nestedOopif?: boolean; unavailableOopif?: boolean; mismatchedOopif?: boolean; ownerInClosedShadow?: boolean; missingOwnerIdentity?: boolean; ownerChangesAt?: 'before' | 'after'; ownerChangeKind?: 'replace' | 'add' | 'remove'; verificationFails?: boolean; cleanupFails?: boolean; cancelCapture?: AbortController; hidesOnFreeze?: boolean; visibilityFails?: boolean; browserContextId?: string; explicitContexts?: string[] } = {}): { cdp: CdpConnection; calls: { method: string; params: Record<string, unknown>; context: OperationContext; session?: string }[] } {
  const calls: { method: string; params: Record<string, unknown>; context: OperationContext; session?: string }[] = [];
  const cdp = Object.create(CdpConnection.prototype) as CdpConnection;
  let visible = true; let switchedAway = false;
  let masksInstalled = false; let screenshotRequested = false;
  cdp.attachTarget = async () => 'top-session';
  cdp.listTargets = async () => [
    { targetId: 'top', type: 'page', url: 'https://top.test', ...(options.browserContextId ? { browserContextId: options.browserContextId } : {}) },
    { targetId: 'foreign-frame', type: 'iframe', url: 'https://foreign.test' },
    ...(options.oopif && !options.unavailableOopif ? [{ targetId: 'child', type: 'iframe', url: 'https://child.test' }] : []),
    ...(options.nestedOopif ? [{ targetId: 'grandchild', type: 'iframe', url: 'https://grandchild.test' }] : []),
  ];
  cdp.send = async <T>(method: string, params: Record<string, unknown>, context: OperationContext, session?: string): Promise<T> => {
    calls.push({ method, params, context, ...(session === undefined ? {} : { session }) });
    let value: unknown = {};
    if (method === 'Page.setWebLifecycleState' && params.state === 'frozen' && options.hidesOnFreeze) visible = false;
    if (method === 'Target.getBrowserContexts') value = { browserContextIds: options.explicitContexts ?? [] };
    if (method === 'Target.createTarget') value = { targetId: 'recovery' };
    if (method === 'Target.closeTarget') value = { success: true };
    if (method === 'Target.activateTarget') {
      if (params.targetId !== 'top') switchedAway = true;
      else if (switchedAway && !options.visibilityFails) visible = true;
      else if (options.visibilityFails) throw new Error('Visibility recovery unavailable');
    }
    if (method === 'Page.getFrameTree') value = { frameTree: { frame: { id: session === 'grandchild-session' ? 'grandchild' : session === 'child-session' ? options.mismatchedOopif ? 'foreign-frame' : 'child' : 'top' }, ...(options.inaccessibleFrame && session === 'top-session' ? { childFrames: [{ frame: { id: 'child' } }] } : {}) } };
    if (method === 'DOM.getDocument') {
      const changed = options.ownerChangesAt === 'before' ? masksInstalled : options.ownerChangesAt === 'after' && screenshotRequested;
      const owner = { nodeType: 1, nodeName: options.ownerTag ?? 'IFRAME', ...(options.missingOwnerIdentity ? {} : { frameId: session === 'child-session' ? 'grandchild' : 'child' }), backendNodeId: changed && (options.ownerChangeKind ?? 'replace') === 'replace' ? 23 : 22 };
      const hasOwner = (options.oopif && session === 'top-session') || (options.nestedOopif && session === 'child-session');
      const owners = changed && options.ownerChangeKind === 'remove' ? [] : changed && options.ownerChangeKind === 'add' ? [owner, { nodeType: 1, nodeName: 'IFRAME', frameId: 'new-child', backendNodeId: 24 }] : [owner];
      const frameId = session === 'grandchild-session' ? 'grandchild' : session === 'child-session' ? 'child' : 'top';
      value = { root: { nodeType: 9, children: [{ nodeType: 1, nodeName: 'HTML', frameId, backendNodeId: 10, ...(options.dormant ? { children: [{ nodeType: 1, nodeName: 'OBJECT', backendNodeId: 99 }] } : hasOwner ? { children: options.ownerInClosedShadow ? [{ nodeType: 1, nodeName: 'DIV', shadowRoots: [{ nodeType: 11, shadowRootType: 'closed', backendNodeId: 77, children: owners }] }] : owners } : {}) }] } };
    }
    if (method === 'Target.attachToTarget') value = { sessionId: `${String(params.targetId)}-session` };
    if (method === 'Page.createIsolatedWorld') value = { executionContextId: session === 'grandchild-session' ? 3 : session === 'child-session' ? 2 : 1 };
    if (method === 'DOM.resolveNode') value = { object: { objectId: 'closed-root' } };
    if (method === 'Runtime.callFunctionOn') {
      // Execute the production owner function. Returning a canned rectangle hid the OBJECT rejection.
      if (String(params.functionDeclaration).includes('this.getClientRects().length')) {
        const revealed = options.revealAt === 'before' ? masksInstalled : options.revealAt === 'after' && screenshotRequested;
        const ancestor = { parentElement: null, getRootNode: () => ({}) };
        const owner = { isConnected: true, tagName: 'OBJECT', parentElement: options.dormant === 'ancestor' ? ancestor : null,
          assignedSlot: options.dormant === 'slot' ? ancestor : undefined,
          getRootNode: () => options.dormant === 'shadow' ? { host: ancestor } : {}, getClientRects: () => [] };
        const getComputedStyle = (node: unknown) => ({ display: !revealed && ((node === owner && options.dormant === 'self') || (node === ancestor && ['ancestor', 'shadow', 'slot'].includes(options.dormant ?? ''))) ? 'none' : 'block', opacity: '0', visibility: 'hidden' });
        return { result: { value: runInNewContext(`(${String(params.functionDeclaration)}).call(owner)`, { owner, getComputedStyle }) } } as T;
      }
      const rectangle = session === 'child-session' ? { left: 5, top: 5, width: 20, height: 10 } : { left: 20, top: 30, width: 60, height: 40 };
      const owner = { isConnected: !options.ownerDisconnected, tagName: options.ownerTag ?? 'IFRAME', parentElement: null, getRootNode: () => ({}), getBoundingClientRect: () => rectangle };
      const style = { transform: 'none', perspective: 'none', rotate: 'none', scale: 'none', translate: 'none', zoom: '1', borderLeftWidth: '0', borderTopWidth: '0', borderRightWidth: '0', borderBottomWidth: '0', paddingLeft: '0', paddingTop: '0', paddingRight: '0', paddingBottom: '0', ...options.ownerStyle };
      value = { result: { value: String(params.functionDeclaration).includes('this.isConnected') ? runInNewContext(`(${String(params.functionDeclaration)}).call(owner)`, { owner, getComputedStyle: () => style }) : true } };
    }
    if (method === 'Runtime.evaluate') {
      const expression = String(params.expression);
      if (expression === `document.contentType === 'text/html'`) value = { result: { value: (options.childContentType ?? 'text/html') === 'text/html' } };
      else if (expression === 'document.visibilityState === "visible"') value = { result: { value: visible } };
      else if (expression.includes('requestAnimationFrame')) value = { result: { value: true } };
      else if (expression.includes('rectangles: state.masks.map')) value = { result: { value: { contentType: options.childContentType ?? 'text/html', width: session === 'grandchild-session' ? 20 : session === 'child-session' ? 60 : 100, height: session === 'grandchild-session' ? 10 : session === 'child-session' ? 40 : 80, rectangles: [{ x: 5, y: 5, width: 10, height: 5 }] } } };
      else if (expression.includes('mask state already exists')) { masksInstalled = true; value = { result: { value: 1 } }; }
      else if (expression.includes("delete globalThis[key + '_closed']")) {
        if (options.cleanupFails) throw new Error('cleanup failure');
        value = { result: { value: true } };
      } else value = { result: { value: !options.verificationFails } };
    }
    if (method === 'Page.getLayoutMetrics') value = { cssVisualViewport: { clientWidth: 100, clientHeight: 80, pageX: 0, pageY: 0, scale: 1 } };
    if (method === 'Page.captureScreenshot') {
      screenshotRequested = true;
      if (options.cancelCapture) { options.cancelCapture.abort(); throw new EngineError('CANCELLED', 'cancelled', { retryable: false }); }
      const png = pixelFixture();
      value = { data: png.toString('base64') };
    }
    return value as T;
  };
  return { cdp, calls };
}

test('pixel capture refuses an inaccessible child before requesting screenshot bytes', async () => {
  const { cdp, calls } = mockPixels({ inaccessibleFrame: true });
  await assert.rejects(captureMaskedPixels(cdp, 'top', operation()), /masking could not be proven/);
  assert.equal(calls.some(call=>call.method==='Page.captureScreenshot'), false);
  assert.equal(calls.some(call=>call.method==='Target.detachFromTarget' && call.params.sessionId==='top-session'), true);
});

test('pixel capture independently masks the verified OOPIF renderer and releases both owned sessions', async () => {
  const { cdp, calls } = mockPixels({ oopif: true });
  const result = await captureMaskedPixels(cdp, 'top', operation());
  assert.equal(result.maskedRegionCount, 2); assert.equal(result.pixels.width, 100); assert.equal(result.pixels.height, 80); assert.equal(result.pixels.scale, 1);
  assert.equal(calls.filter(call=>call.method==='Page.createIsolatedWorld').length, 2);
  assert.deepEqual(calls.filter(call=>call.method==='Target.detachFromTarget').map(call=>call.params.sessionId).toSorted(), ['child-session','top-session']);
  assert.deepEqual(calls.filter(call=>call.method==='Target.attachToTarget').map(call=>call.params.targetId), ['child'], 'Unrelated iframe targets must never be inspected');
});

test('HTML OBJECT owners use the executed content-box projection and exact child viewport', async () => {
  const { cdp, calls } = mockPixels({ oopif: true, ownerTag: 'OBJECT' });
  assert.equal((await captureMaskedPixels(cdp, 'top', operation())).maskedRegionCount, 2);
  assert.equal(calls.filter(call => call.method === 'Page.captureScreenshot').length, 1);
  assert.equal(calls.filter(call => call.method === 'Runtime.callFunctionOn').length, 2, 'Execute the owner function before and after capture');
});

test('unsupported owner types, non-HTML OBJECT documents and transformed owners fail closed with fixed reasons', async () => {
  const cases = [
    ...['EMBED', 'FENCEDFRAME', 'PORTAL', 'DIV'].map(ownerTag => ({ options: { ownerTag }, reason: 'unsupported-owner-type' })),
    ...['application/pdf', 'image/svg+xml', 'image/png', 'application/xhtml+xml'].map(childContentType => ({ options: { ownerTag: 'OBJECT', childContentType }, reason: 'unsupported-owner-document' })),
    ...['transform', 'perspective', 'rotate', 'scale', 'translate', 'zoom'].map(property => ({ options: { ownerTag: 'OBJECT', ownerStyle: { [property]: property === 'zoom' ? '2' : 'invalid-transform' } }, reason: 'transformed-owner' })),
    { options: { ownerTag: 'OBJECT', ownerStyle: { paddingLeft: '1' } }, reason: 'owner-viewport-mismatch' },
  ];
  for (const { options, reason } of cases) {
    const { cdp, calls } = mockPixels({ oopif: true, ...options });
    await assert.rejects(captureMaskedPixels(cdp, 'top', operation()), new RegExp(reason));
    assert.equal(calls.some(call => call.method === 'Page.captureScreenshot'), false);
    assert.equal(calls.some(call => call.method === 'Target.detachFromTarget'), true);
  }
});

test('HTML OBJECT rejection never depends on whether sensitive controls were found', async () => {
  const { cdp, calls } = mockPixels({ oopif: true, ownerTag: 'OBJECT', ownerDisconnected: true });
  const send = cdp.send.bind(cdp);
  cdp.send = async <T>(method: string, params: Record<string, unknown>, context: OperationContext, session?: string): Promise<T> => {
    const result = await send<T>(method, params, context, session);
    if (method === 'Runtime.evaluate' && String(params.expression).includes('mask state already exists')) return { result: { value: 0 } } as T;
    if (method === 'Runtime.evaluate' && String(params.expression).includes('rectangles: state.masks.map')) {
      const geometry = result as { result: { value: { rectangles: unknown[] } } }; geometry.result.value.rectangles = [];
    }
    return result;
  };
  await assert.rejects(captureMaskedPixels(cdp, 'top', operation()), /geometry-before/);
  assert.equal(calls.some(call => call.method === 'Page.captureScreenshot'), false);
});

test('Chromium document-element frame markers are not mistaken for child frame owners', async () => {
  const { cdp, calls } = mockPixels();
  const result = await captureMaskedPixels(cdp, 'top', operation());
  assert.equal(result.maskingProven, true);
  assert.equal(result.maskedRegionCount, 1);
  assert.equal(calls.filter(call => call.method === 'DOM.getDocument').length, 4);
  assert.equal(calls.some(call => call.method === 'Target.attachToTarget'), false);
  assert.equal(calls.some(call => call.method === 'Page.captureScreenshot'), true);
});

test('document marker exception never accepts mismatched, nested or frame-owning markers', async () => {
  const element = { nodeType: 1, nodeName: 'HTML', frameId: 'top', backendNodeId: 10 };
  const candidates = [
    { ...element, frameId: 'foreign' },
    { ...element, children: [{ ...element, nodeName: 'DIV', backendNodeId: 11 }] },
    { ...element, contentDocument: { nodeType: 9 } },
    ...['IFRAME', 'FRAME', 'FENCEDFRAME', 'OBJECT', 'EMBED', 'PORTAL'].map(nodeName => ({ ...element, nodeName })),
  ];
  for (const candidate of candidates) {
    const { cdp, calls } = mockPixels(); const send = cdp.send.bind(cdp);
    cdp.send = async <T>(method: string, params: Record<string, unknown>, context: OperationContext, session?: string): Promise<T> => {
      if (method === 'DOM.getDocument') return { root: { nodeType: 9, children: [candidate] } } as T;
      return send<T>(method, params, context, session);
    };
    await assert.rejects(captureMaskedPixels(cdp, 'top', operation()), /masking could not be proven/);
    assert.equal(calls.some(call => call.method === 'Page.captureScreenshot'), false);
  }
});

test('pixel capture discovers nested remote owners in closed roots even when every Page frame tree omits them', async () => {
  const { cdp, calls } = mockPixels({ oopif: true, nestedOopif: true, ownerInClosedShadow: true });
  const result = await captureMaskedPixels(cdp, 'top', operation());
  assert.equal(result.maskedRegionCount, 3);
  assert.deepEqual(calls.filter(call => call.method === 'Target.attachToTarget').map(call => call.params.targetId), ['child', 'grandchild']);
  assert.equal(calls.filter(call => call.method === 'DOM.resolveNode' && call.params.backendNodeId === 77).length, 2);
});

test('missing or mismatched remote target or owner identity prevents screenshot capture', async () => {
  for (const options of [{ unavailableOopif: true }, { mismatchedOopif: true }, { missingOwnerIdentity: true }]) {
    const { cdp, calls } = mockPixels({ oopif: true, ...options });
    await assert.rejects(captureMaskedPixels(cdp, 'top', { ...operation(), timeoutMs: 50 }), /masking could not be proven/);
    assert.equal(calls.some(call => call.method === 'Page.captureScreenshot'), false);
    assert.equal(calls.some(call => call.method === 'Target.attachToTarget' && call.params.targetId === 'foreign-frame'), false);
  }
});

test('new, disappearing or replaced frame owners invalidate both pre-capture and post-capture proof', async () => {
  for (const ownerTag of ['IFRAME', 'OBJECT']) for (const ownerChangesAt of ['before', 'after'] as const) for (const ownerChangeKind of ['replace', 'add', 'remove'] as const) {
    const { cdp, calls } = mockPixels({ oopif: true, ownerTag, ownerChangesAt, ownerChangeKind });
    await assert.rejects(captureMaskedPixels(cdp, 'top', operation()), /masking could not be proven/);
    assert.equal(calls.some(call => call.method === 'Page.captureScreenshot'), ownerChangesAt === 'after');
    assert.deepEqual(calls.filter(call => call.method === 'Target.detachFromTarget').map(call => call.params.sessionId).toSorted(), ['child-session', 'top-session']);
  }
});

test('pre-mask inventory waits for its exact remote target without capturing or freezing partial coverage', async () => {
  const { cdp, calls } = mockPixels({ oopif: true }); const list = cdp.listTargets.bind(cdp); let reads = 0;
  cdp.listTargets = async context => {
    const targets = await list(context);
    if (++reads === 1) {
      assert.equal(calls.some(call => call.method === 'Page.setWebLifecycleState' || call.method === 'Page.captureScreenshot'), false);
      assert.equal(calls.some(call => String(call.params.expression).includes('mask state already exists')), false);
      return targets.filter(target => target.targetId !== 'child');
    }
    return targets;
  };
  const result = await captureMaskedPixels(cdp, 'top', operation());
  assert.equal(result.maskedRegionCount, 2); assert.equal(reads, 2);
  assert.equal(calls.filter(call => call.method === 'Target.attachToTarget').length, 1);
  assert.equal(calls.filter(call => call.method === 'Page.captureScreenshot').length, 1);
});

test('pre-mask inventory can settle but never retries a changed owner once masks are installed', async () => {
  const { cdp, calls } = mockPixels({ oopif: true }); const send = cdp.send.bind(cdp); let reads = 0;
  cdp.send = async <T>(method: string, params: Record<string, unknown>, context: OperationContext, session?: string): Promise<T> => {
    const value = await send<T>(method, params, context, session);
    if (method === 'DOM.getDocument' && session === 'top-session' && ++reads >= 2) {
      assert.ok(typeof value === 'object' && value !== null && 'root' in value);
      const root = value.root as { children: { children: { backendNodeId: number }[] }[] };
      root.children[0]!.children[0]!.backendNodeId = 33;
    }
    return value;
  };
  assert.equal((await captureMaskedPixels(cdp, 'top', operation())).maskedRegionCount, 2);
  assert.equal(reads, 6, 'One initial changed inventory requires a new complete two-pass inventory before masked proof');
  assert.equal(calls.filter(call => call.method === 'Page.captureScreenshot').length, 1);
  assert.equal(calls.filter(call => call.method === 'Page.setWebLifecycleState' && call.params.state === 'frozen').length, 1);
});

test('an inventory that never settles is refused without any source mutation or capture', async () => {
  const { cdp, calls } = mockPixels({ oopif: true }); const send = cdp.send.bind(cdp); let reads = 0;
  cdp.send = async <T>(method: string, params: Record<string, unknown>, context: OperationContext, session?: string): Promise<T> => {
    const value = await send<T>(method, params, context, session);
    if (method === 'DOM.getDocument' && session === 'top-session') {
      assert.ok(typeof value === 'object' && value !== null && 'root' in value);
      const root = value.root as { children: { children: { backendNodeId: number }[] }[] };
      root.children[0]!.children[0]!.backendNodeId = ++reads;
    }
    return value;
  };
  await assert.rejects(captureMaskedPixels(cdp, 'top', { ...operation(), timeoutMs: 50 }), /\(inventory-stability\)/);
  assert.ok(reads >= 4);
  assert.equal(calls.some(call => call.method === 'Page.setWebLifecycleState' || call.method === 'Page.captureScreenshot'), false);
  assert.equal(calls.some(call => String(call.params.expression).includes('mask state already exists')), false);
});

test('pixels wait for each frame task queue to resume and are withheld when that acknowledgement fails', async () => {
  for (const fail of [false, true]) {
    const { cdp, calls } = mockPixels({ oopif: true }); const send = cdp.send.bind(cdp); const resumed: string[] = [];
    cdp.send = async <T>(method: string, params: Record<string, unknown>, context: OperationContext, session?: string): Promise<T> => {
      if (method === 'Runtime.evaluate' && String(params.expression).startsWith('new Promise(resolve => setTimeout')) {
        assert.ok(calls.some(call => call.method === 'Page.setWebLifecycleState' && call.params.state === 'active'));
        assert.equal(calls.some(call => call.method === 'Target.detachFromTarget'), false);
        await new Promise(resolve => setTimeout(resolve, 5)); resumed.push(session!);
        if (fail && session === 'child-session') throw new Error('private-task-error');
      }
      return send<T>(method, params, context, session);
    };
    if (fail) await assert.rejects(captureMaskedPixels(cdp, 'top', operation()), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /\(cleanup-tasks\)/); assert.doesNotMatch(error.message, /private-/); return true;
    });
    else assert.equal((await captureMaskedPixels(cdp, 'top', operation())).maskingProven, true);
    assert.deepEqual(resumed.toSorted(), ['child-session', 'top-session']);
    assert.equal(calls.filter(call => call.method === 'Target.detachFromTarget').length, 2);
  }
});

test('pixel failure phases contain no browser text and retain exact post-mask proof stage', async () => {
  const { cdp } = mockPixels({ oopif: true, ownerChangesAt: 'after' });
  await assert.rejects(captureMaskedPixels(cdp, 'top', operation()), /\(verify-after-owners\)/);
  const broken = mockPixels(); const send = broken.cdp.send.bind(broken.cdp);
  broken.cdp.send = async <T>(method: string, params: Record<string, unknown>, context: OperationContext, session?: string): Promise<T> => {
    if (method === 'Page.captureScreenshot') throw new Error('private-browser-error');
    return send<T>(method, params, context, session);
  };
  await assert.rejects(captureMaskedPixels(broken.cdp, 'top', operation()), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /\(capture\)/); assert.doesNotMatch(error.message, /private-/); return true;
  });
});

test('actual nonblack pixels in any main, remote or nested remote mask suppress the entire screenshot', async () => {
  for (const white of [{ x: 5, y: 5 }, { x: 25, y: 35 }, { x: 30, y: 40 }]) {
    const { cdp, calls } = mockPixels({ oopif: true, nestedOopif: true }); const send = cdp.send.bind(cdp);
    cdp.send = async <T>(method: string, params: Record<string, unknown>, context: OperationContext, session?: string): Promise<T> => {
      const result = await send<T>(method, params, context, session);
      if (method === 'Page.captureScreenshot') return { data: pixelFixture(white).toString('base64') } as T;
      return result;
    };
    await assert.rejects(captureMaskedPixels(cdp, 'top', operation()), /\(pixel-proof/);
    assert.equal(calls.filter(call => call.method === 'Page.captureScreenshot').length, 1, 'A rejected image is never retried');
    assert.equal(calls.filter(call => call.method === 'Target.detachFromTarget').length, 3);
    assert.ok(calls.some(call => call.method === 'Page.setWebLifecycleState' && call.params.state === 'active'));
  }
});

test('same-process child rectangles receive the same root-space byte proof as remote children', async () => {
  const { cdp, calls } = mockPixels(); const send = cdp.send.bind(cdp);
  cdp.send = async <T>(method: string, params: Record<string, unknown>, context: OperationContext, session?: string): Promise<T> => {
    const result = await send<T>(method, params, context, session);
    if (method === 'DOM.getDocument') return { root: { nodeType: 9, children: [{ nodeType: 1, nodeName: 'HTML', frameId: 'top', backendNodeId: 10, children: [{ nodeType: 1, nodeName: 'IFRAME', frameId: 'child', backendNodeId: 22, contentDocument: { nodeType: 9, children: [{ nodeType: 1, nodeName: 'HTML', frameId: 'child', backendNodeId: 12 }] } }] }] } } as T;
    if (method === 'Page.createIsolatedWorld') return { executionContextId: params.frameId === 'child' ? 2 : 1 } as T;
    if (method === 'Runtime.evaluate' && params.contextId === 2 && String(params.expression).includes('rectangles: state.masks.map')) return { result: { value: { contentType: 'text/html', width: 60, height: 40, rectangles: [{ x: 5, y: 5, width: 10, height: 5 }] } } } as T;
    if (method === 'Page.captureScreenshot') return { data: pixelFixture({ x: 25, y: 35 }).toString('base64') } as T;
    return result;
  };
  await assert.rejects(captureMaskedPixels(cdp, 'top', operation()), /\(pixel-proof-nonblack-mask\)/);
  assert.equal(calls.filter(call => call.method === 'Page.createIsolatedWorld').length, 2);
  assert.equal(calls.some(call => call.method === 'Target.attachToTarget'), false);
  assert.equal(calls.filter(call => call.method === 'Page.captureScreenshot').length, 1);
});

test('a small screenshot aspect mismatch cannot shift the byte-proof rectangle onto different pixels', async () => {
  const { cdp, calls } = mockPixels(); const send = cdp.send.bind(cdp);
  cdp.send = async <T>(method: string, params: Record<string, unknown>, context: OperationContext, session?: string): Promise<T> => {
    const result = await send<T>(method, params, context, session);
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1000, clientHeight: 1000, pageX: 0, pageY: 0, scale: 1 } } as T;
    if (method === 'Page.captureScreenshot') return { data: pixelFixture(undefined, { width: 1000, height: 1009 }).toString('base64') } as T;
    return result;
  };
  await assert.rejects(captureMaskedPixels(cdp, 'top', operation()), /\(png\)/);
  assert.equal(calls.filter(call => call.method === 'Page.captureScreenshot').length, 1);
});

test('paint acknowledgement precedes freeze and a rejected paint cannot request screenshot bytes', async () => {
  for (const rejected of [false, true]) {
    const { cdp, calls } = mockPixels({ oopif: true }); const send = cdp.send.bind(cdp); let painted = 0;
    cdp.send = async <T>(method: string, params: Record<string, unknown>, context: OperationContext, session?: string): Promise<T> => {
      if (method === 'Runtime.evaluate' && String(params.expression).includes('requestAnimationFrame')) {
        assert.equal(calls.some(call => call.method === 'Page.setWebLifecycleState'), false);
        if (rejected) throw new Error('private-renderer-error');
        painted++;
      }
      if (method === 'Page.setWebLifecycleState' && params.state === 'frozen') assert.equal(painted, 2);
      return send<T>(method, params, context, session);
    };
    if (rejected) await assert.rejects(captureMaskedPixels(cdp, 'top', operation()), /\(paint\)/);
    else assert.equal((await captureMaskedPixels(cdp, 'top', operation())).maskingProven, true);
    assert.equal(calls.some(call => call.method === 'Page.captureScreenshot'), !rejected);
  }
});

test('unproven or changed owner geometry is refused without accepting captured bytes', async () => {
  for (const changedAfter of [false, true]) {
    const { cdp, calls } = mockPixels({ oopif: true }); const send = cdp.send.bind(cdp);
    cdp.send = async <T>(method: string, params: Record<string, unknown>, context: OperationContext, session?: string): Promise<T> => {
      const result = await send<T>(method, params, context, session);
      if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('this.isConnected')) {
        if (!changedAfter) return { result: { value: null } } as T;
        if (calls.some(call => call.method === 'Page.captureScreenshot')) return { result: { value: { x: 21, y: 30, width: 60, height: 40 } } } as T;
      }
      return result;
    };
    await assert.rejects(captureMaskedPixels(cdp, 'top', operation()), changedAfter ? /\(geometry-after\)/ : /\(geometry-before\)/);
    assert.equal(calls.some(call => call.method === 'Page.captureScreenshot'), changedAfter);
  }
});

test('unproven mask verification never produces pixels and always resumes the page', async () => {
  const { cdp, calls } = mockPixels({ verificationFails: true });
  await assert.rejects(captureMaskedPixels(cdp, 'top', operation()), /masking could not be proven/);
  assert.equal(calls.some(call=>call.method==='Page.captureScreenshot'), false);
  assert.equal(calls.some(call=>call.method==='Page.setWebLifecycleState' && call.params.state==='active'), true);
  assert.equal(calls.some(call=>call.method==='Page.bringToFront'), true);
  assert.equal(calls.some(call=>call.method==='Runtime.evaluate' && String(call.params.expression).includes("delete globalThis[key + '_closed']")), true);
});

test('cleanup uses a fresh budget after cancellation and withheld pixels stay withheld', async () => {
  const controller = new AbortController(); const { cdp, calls } = mockPixels({ cancelCapture: controller });
  await assert.rejects(captureMaskedPixels(cdp, 'top', { ...operation(), signal: controller.signal }), (error: unknown)=>error instanceof EngineError && error.code==='CANCELLED');
  const resumed = calls.find(call=>call.method==='Page.setWebLifecycleState' && call.params.state==='active');
  assert.ok(resumed); assert.equal(resumed.context.signal.aborted, false); assert.ok(resumed.context.timeoutMs > 0);
});

test('failed mask cleanup discards even successfully captured screenshot bytes', async () => {
  const { cdp, calls } = mockPixels({ cleanupFails: true });
  await assert.rejects(captureMaskedPixels(cdp, 'top', operation()), /masking could not be proven/);
  assert.equal(calls.some(call=>call.method==='Page.captureScreenshot'), true);
  assert.equal(calls.some(call=>call.method==='Page.setWebLifecycleState' && call.params.state==='active'), true);
  assert.equal(calls.some(call=>call.method==='Page.bringToFront'), true);
});


test('storage capture and replacement are scoped to the active browser context', async () => {
  let contextId = 'before';
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const cdp = Object.create(CdpConnection.prototype) as CdpConnection;
  cdp.listTargets = async () => [{ targetId: 'foreign', type: 'page', url: 'https://foreign.test', browserContextId: 'foreign' }];
  cdp.attachTarget = async () => { throw new Error('Foreign context was accessed'); };
  cdp.send = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    calls.push({ method, params }); return { cookies: [] } as T;
  };
  const probes = { browserContextId: () => contextId, create: async () => { throw new Error('Unexpected probe'); }, release: async () => {} };
  const captured = await captureState(cdp, operation(), new Set(), probes);
  assert.deepEqual(readState(captured).tabs, []);
  await restoreState(captured, operation(), async () => { contextId = 'after'; return cdp; }, probes);
  assert.deepEqual(calls, [
    { method: 'Storage.getCookies', params: { browserContextId: 'before' } },
    { method: 'Storage.setCookies', params: { cookies: [], browserContextId: 'after' } },
  ]);
});

test('storage failure diagnostics identify only fixed phases and never browser errors or state contents', async () => {
  for (const phase of ['tab-frames', 'cookies', 'snapshot-validation'] as const) {
    const cdp = Object.create(CdpConnection.prototype) as CdpConnection;
    cdp.listTargets = async () => [{ targetId: 'owned', type: 'page', url: 'about:blank' }];
    cdp.attachTarget = async () => 'session';
    cdp.send = async <T>(method: string): Promise<T> => {
      if ((phase === 'tab-frames' && method === 'Page.getFrameTree') || (phase === 'cookies' && method === 'Storage.getCookies')) throw new Error('private-browser-payload');
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top', url: 'about:blank' } } } as T;
      if (method === 'Storage.getCookies') return { cookies: [{ malformed: 'private-state-value' }] } as T;
      return {} as T;
    };
    await assert.rejects(captureState(cdp, operation(), new Set(), { targetBrowserContextId: () => undefined, create: async () => 'probe', release: async () => {} }), (error: unknown) => {
      assert.ok(error instanceof EngineError); assert.equal(error.code, 'ENGINE_FAILURE');
      assert.equal(error.message, `Storage state could not be captured or restored safely (${phase})`);
      assert.doesNotMatch(JSON.stringify(error), /private-/); return true;
    });
  }
});

test('origin probe phase survives cleanup without exposing its browser error', async () => {
  const cdp = Object.create(CdpConnection.prototype) as CdpConnection; const released: string[] = [];
  cdp.listTargets = async () => []; cdp.attachTarget = async () => 'probe-session'; cdp.on = () => () => {};
  cdp.send = async <T>(): Promise<T> => { throw new Error('private-origin-error'); };
  await assert.rejects(captureState(cdp, operation(), new Set(['https://private-origin.test']), {
    targetBrowserContextId: () => undefined, create: async () => 'probe', release: async id => { released.push(id); },
  }), (error: unknown) => {
    assert.ok(error instanceof EngineError); assert.equal(error.code, 'ENGINE_FAILURE');
    assert.equal(error.message, 'Storage state could not be captured or restored safely (origin-enable)');
    assert.doesNotMatch(JSON.stringify(error), /private-/); return true;
  });
  assert.deepEqual(released, ['probe']);
});

test('storage phase diagnostics preserve cancellation and timeout taxonomy', async () => {
  for (const code of ['CANCELLED', 'OPERATION_TIMEOUT'] as const) {
    const expected = new EngineError(code, 'Operation interrupted', { retryable: false });
    const cdp = Object.create(CdpConnection.prototype) as CdpConnection;
    cdp.listTargets = async () => { throw expected; };
    await assert.rejects(captureState(cdp, operation(), new Set(), { targetBrowserContextId: () => undefined, create: async () => 'probe', release: async () => {} }), error => error === expected);
  }
});

test('default storage scope captures concrete-identity tabs and reuses the replacement tab without scoping cookies', async () => {
  for (const suppliedIdentity of [false, true]) {
    let identity = 'default-before';
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const attached: string[] = [];
    const cdp = Object.create(CdpConnection.prototype) as CdpConnection;
    cdp.listTargets = async () => [
      { targetId: 'foreign', type: 'page', url: 'https://foreign.test', browserContextId: 'foreign' },
      { targetId: 'owned', type: 'page', url: 'about:blank', browserContextId: identity },
    ];
    cdp.attachTarget = async targetId => { attached.push(targetId); assert.equal(targetId, 'owned'); return 'owned-session'; };
    cdp.send = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
      let value: unknown = {};
      if (method === 'Target.createTarget') value = { targetId: 'identity-probe' };
      if (method === 'Target.getTargetInfo') value = { targetInfo: { targetId: params.targetId, type: 'page', browserContextId: identity } };
      if (method === 'Target.closeTarget') value = { success: true };
      if (method === 'Page.getFrameTree') value = { frameTree: { frame: { id: 'owned-frame', url: 'about:blank' } } };
      if (method === 'Storage.getCookies') value = { cookies: [] };
      return value as T;
    };
    const probes = suppliedIdentity ? {
      browserContextId: () => undefined,
      targetBrowserContextId: () => identity,
      create: async () => { throw new Error('Unexpected probe'); },
      release: async () => {},
    } : undefined;
    const captured = await captureState(cdp, operation(), new Set(), probes);
    assert.deepEqual(readState(captured).tabs, [{ url: 'about:blank', sessionStorage: [] }]);
    await restoreState(captured, operation(), async () => { identity = 'default-after'; return cdp; }, probes);
    assert.deepEqual(attached, ['owned']);
    assert.deepEqual(calls.filter(call => call.method.startsWith('Storage.')), [
      { method: 'Storage.getCookies', params: {} },
      { method: 'Storage.setCookies', params: { cookies: [] } },
    ]);
    const created = calls.filter(call => call.method === 'Target.createTarget');
    assert.equal(created.length, suppliedIdentity ? 0 : 2, 'Only standalone ownership probes may be created; restore must reuse its existing blank tab');
    assert.ok(created.every(call => !Object.hasOwn(call.params, 'browserContextId')));
    assert.equal(calls.filter(call => call.method === 'Target.closeTarget').length, created.length);
  }
});

test('default ownership probing uses excluded target callbacks and cleans up before capture', async () => {
  const events: string[] = [];
  const cdp = Object.create(CdpConnection.prototype) as CdpConnection;
  cdp.listTargets = async () => { events.push('list'); return []; };
  cdp.send = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    assert.notEqual(method, 'Target.createTarget');
    if (method === 'Target.getTargetInfo') { events.push('identity'); return { targetInfo: { targetId: params.targetId, type: 'page', browserContextId: 'default' } } as T; }
    return { cookies: [] } as T;
  };
  await captureState(cdp, operation(), new Set(), {
    create: async () => { events.push('create'); return 'excluded-probe'; },
    release: async targetId => { assert.equal(targetId, 'excluded-probe'); events.push('release'); },
  });
  assert.deepEqual(events, ['create', 'identity', 'release', 'list', 'list']);
});

test('state capture waits for its closing identity probe to disappear instead of attaching a stale page', async () => {
  const cdp = Object.create(CdpConnection.prototype) as CdpConnection;
  const attached: string[] = []; let closeCalls = 0; let listings = 0;
  const owned = { targetId: 'owned', type: 'page', url: 'about:blank', browserContextId: 'default' };
  const closing = { targetId: 'probe', type: 'page', url: 'about:blank', browserContextId: 'default' };
  cdp.listTargets = async () => ++listings <= 2 ? [owned, closing] : [owned];
  cdp.attachTarget = async id => { attached.push(id); if (id === 'probe') throw new Error('Closing target is unavailable'); return 'owned-session'; };
  cdp.send = async <T>(method: string): Promise<T> => {
    if (method === 'Target.createTarget') return { targetId: 'probe' } as T;
    if (method === 'Target.getTargetInfo') return { targetInfo: { ...closing } } as T;
    if (method === 'Target.closeTarget') { closeCalls++; return { success: true } as T; }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top', url: 'about:blank' } } } as T;
    if (method === 'Storage.getCookies') return { cookies: [] } as T;
    return {} as T;
  };
  const state = await captureState(cdp, operation());
  assert.deepEqual(readState(state).tabs, [{ url: 'about:blank', sessionStorage: [] }]);
  assert.deepEqual(attached, ['owned']); assert.equal(closeCalls, 1); assert.ok(listings >= 4);
});

test('owned probe disposal waits read-only for destruction and never closes unrelated live pages', async () => {
  for (const callbacks of [false, true]) {
    const cdp = Object.create(CdpConnection.prototype) as CdpConnection; let listings = 0; const closed: string[] = [];
    cdp.listTargets = async () => [{ targetId: 'unrelated', type: 'page', url: 'about:blank' }, ...(++listings < 3 ? [{ targetId: 'probe', type: 'page', url: 'about:blank' }] : [])];
    cdp.send = async <T>(method: string, params: Record<string, unknown>): Promise<T> => { assert.equal(method, 'Target.closeTarget'); closed.push(String(params.targetId)); return { success: true } as T; };
    await releaseStateProbeTarget(cdp, 'probe', operation(), callbacks ? { create: async () => 'probe', release: async id => { closed.push(id); } } : undefined);
    assert.deepEqual(closed, ['probe']); assert.equal(listings, 3);
  }
});

test('unconfirmed owned-probe destruction times out without retrying the close mutation', async () => {
  const cdp = Object.create(CdpConnection.prototype) as CdpConnection; let closed = 0;
  cdp.listTargets = async () => [{ targetId: 'probe', type: 'page', url: 'about:blank' }];
  cdp.send = async <T>(): Promise<T> => { closed++; return { success: true } as T; };
  await assert.rejects(releaseStateProbeTarget(cdp, 'probe', { ...operation(), timeoutMs: 20 }), (error: unknown) => error instanceof EngineError && error.code === 'OPERATION_TIMEOUT');
  assert.equal(closed, 1);
});

test('capture still refuses unknown application-tab attachment failures rather than skipping them', async () => {
  const cdp = Object.create(CdpConnection.prototype) as CdpConnection; let attaches = 0;
  cdp.listTargets = async () => [{ targetId: 'application', type: 'page', url: 'about:blank' }];
  cdp.attachTarget = async () => { attaches++; throw new Error('Application tab closed during capture'); };
  await assert.rejects(captureState(cdp, operation(), new Set(), { targetBrowserContextId: () => undefined, create: async () => 'probe', release: async () => {} }), /\(tab-attach\)/);
  assert.equal(attaches, 1);
});


test('pixel cleanup restores a frozen selected tab through an excluded owned probe', async () => {
  const { cdp, calls } = mockPixels({ hidesOnFreeze: true });
  const released: string[] = [];
  const result = await captureMaskedPixels(cdp, 'top', operation(), { create: async () => 'excluded-probe', release: async id => { released.push(id); } });
  assert.equal(result.maskingProven, true);
  assert.deepEqual(calls.filter(call => call.method === 'Target.activateTarget').map(call => call.params.targetId), ['excluded-probe', 'top']);
  assert.deepEqual(released, ['excluded-probe']);
  assert.equal(calls.some(call => call.method === 'Target.createTarget'), false, 'Live hubs must reserve the temporary target before user hooks can run');
});

test('standalone visibility recovery preserves explicit scope and omits opaque default-context ids', async () => {
  for (const explicit of [false, true]) {
    const { cdp, calls } = mockPixels({ hidesOnFreeze: true, browserContextId: 'scope', explicitContexts: explicit ? ['scope'] : [] });
    await captureMaskedPixels(cdp, 'top', operation());
    assert.deepEqual(calls.find(call => call.method === 'Target.createTarget')?.params, { url: 'about:blank', background: true, ...(explicit ? { browserContextId: 'scope' } : {}) });
    assert.deepEqual(calls.filter(call => call.method === 'Target.closeTarget').map(call => call.params.targetId), ['recovery']);
  }
});

test('failed visibility recovery discards pixels and still closes the owned recovery probe', async () => {
  const { cdp, calls } = mockPixels({ hidesOnFreeze: true, visibilityFails: true });
  const released: string[] = [];
  await assert.rejects(captureMaskedPixels(cdp, 'top', operation(), { create: async () => 'excluded-probe', release: async id => { released.push(id); } }), /masking could not be proven/);
  assert.equal(calls.some(call => call.method === 'Page.captureScreenshot'), true);
  assert.deepEqual(released, ['excluded-probe']);
});

test('pixel observation publishes only after cleanup and unchanged attempt identity', async () => {
  const { AgentBrowserSurface } = await import('../src/surface.ts');
  for (const change of ['none', 'connection', 'target', 'adapter', 'taint', 'snapshot-taint', 'snapshot-failure'] as const) {
    const { cdp, calls } = mockPixels();
    let observations = 0;
    const surface = new AgentBrowserSurface({});
    const snapshot = { root: { ref: { id: 'root' }, role: 'document' }, viewport: { width: 100, height: 80 } };
    const adapter = { observe: async () => {
      observations++;
      assert.ok(calls.some(call => call.method === 'Target.detachFromTarget'), 'pixel cleanup precedes native snapshot');
      if (change === 'snapshot-taint') Object.assign(surface, { tainted: true });
      if (change === 'snapshot-failure') throw new EngineError('NODE_STALE', 'Snapshot failed', { retryable: true });
      return snapshot;
    } };
    Object.assign(surface, { info: { runId: 'test' }, attempt: { attemptId: 'test' }, transport: { poisoned: false }, snapshots: adapter, connection: cdp, targetId: 'top', network: {} });
    const send = cdp.send.bind(cdp);
    cdp.send = async <T>(method: string, params: Record<string, unknown>, context: OperationContext, session?: string): Promise<T> => {
      const result = await send<T>(method, params, context, session);
      if (method === 'Target.detachFromTarget') {
        if (change === 'connection') Object.assign(surface, { connection: {} });
        if (change === 'target') Object.assign(surface, { targetId: 'other' });
        if (change === 'adapter') Object.assign(surface, { snapshots: {} });
        if (change === 'taint') Object.assign(surface, { tainted: true });
      }
      return result;
    };
    if (change === 'none') {
      const result = await surface.observe(operation(), { pixels: true });
      assert.equal(result.root, snapshot.root);
      assert.equal(result.pixels?.mediaType, 'image/png');
      assert.equal(observations, 1);
    } else {
      await assert.rejects(surface.observe(operation(), { pixels: true }), { code: change.includes('taint') ? 'POLICY_DENIED' : change === 'snapshot-failure' ? 'NODE_STALE' : 'INVALID_STATE' });
      assert.equal(observations, change.startsWith('snapshot-') ? 1 : 0);
    }
  }
});


test('uninstantiated OBJECT requires repeated display:none subtree proof, not opacity or empty bounds', async () => {
  for (const dormant of ['self', 'ancestor', 'shadow'] as const) {
    const { cdp, calls } = mockPixels({ dormant });
    assert.equal((await captureMaskedPixels(cdp, 'top', operation())).maskingProven, true);
    assert.equal(calls.filter(call => call.method === 'Runtime.callFunctionOn' && String(call.params.functionDeclaration).includes('this.getClientRects().length')).length, 4);
  }
  for (const dormant of ['opacity', 'visible', 'slot'] as const) {
    const { cdp, calls } = mockPixels({ dormant });
    await assert.rejects(captureMaskedPixels(cdp, 'top', operation()), /unsupported-owner-document/);
    assert.equal(calls.some(call => call.method === 'Page.captureScreenshot'), false);
  }
  for (const revealAt of ['before', 'after'] as const) {
    const { cdp, calls } = mockPixels({ dormant: 'ancestor', revealAt });
    await assert.rejects(captureMaskedPixels(cdp, 'top', operation()), /unsupported-owner-document/);
    assert.equal(calls.some(call => call.method === 'Page.captureScreenshot'), revealAt === 'after');
    assert.ok(calls.some(call => call.method === 'Target.detachFromTarget'));
  }
});
