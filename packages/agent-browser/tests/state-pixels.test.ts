import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EngineError, type EngineState, type OperationContext } from 'e2e/engine';
import { CdpConnection } from '../src/cdp.ts';
import { captureState, decodeStateValue, encodeStateValue, readState, restoreState } from '../src/state.ts';
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

function mockPixels(options: { inaccessibleFrame?: boolean; oopif?: boolean; verificationFails?: boolean; cleanupFails?: boolean; cancelCapture?: AbortController } = {}): { cdp: CdpConnection; calls: { method: string; params: Record<string, unknown>; context: OperationContext; session?: string }[] } {
  const calls: { method: string; params: Record<string, unknown>; context: OperationContext; session?: string }[] = [];
  const cdp = Object.create(CdpConnection.prototype) as CdpConnection;
  cdp.attachTarget = async () => 'top-session';
  cdp.listTargets = async () => [{ targetId: 'top', type: 'page', url: 'https://top.test' }, ...(options.oopif ? [{ targetId: 'child', type: 'iframe', url: 'https://child.test' }] : [])];
  cdp.send = async <T>(method: string, params: Record<string, unknown>, context: OperationContext, session?: string): Promise<T> => {
    calls.push({ method, params, context, ...(session === undefined ? {} : { session }) });
    let value: unknown = {};
    if (method === 'Page.getFrameTree') value = { frameTree: { frame: { id: session === 'child-session' ? 'child' : 'top' }, ...((options.inaccessibleFrame || options.oopif) && session !== 'child-session' ? { childFrames: [{ frame: { id: 'child' } }] } : {}) } };
    if (method === 'DOM.getDocument') value = { root: { nodeType: 9 } };
    if (method === 'Target.attachToTarget') value = { sessionId: 'child-session' };
    if (method === 'Page.createIsolatedWorld') value = { executionContextId: session === 'child-session' ? 2 : 1 };
    if (method === 'Runtime.evaluate') {
      const expression = String(params.expression);
      if (expression === 'document.visibilityState === "visible"') value = { result: { value: true } };
      else if (expression.includes('mask state already exists')) value = { result: { value: 1 } };
      else if (expression.includes("delete globalThis[key + '_closed']")) {
        if (options.cleanupFails) throw new Error('cleanup failure');
        value = { result: { value: true } };
      } else value = { result: { value: !options.verificationFails } };
    }
    if (method === 'Page.getLayoutMetrics') value = { cssVisualViewport: { clientWidth: 100, clientHeight: 80, pageX: 0, pageY: 0, scale: 1 } };
    if (method === 'Page.captureScreenshot') {
      if (options.cancelCapture) { options.cancelCapture.abort(); throw new EngineError('CANCELLED', 'cancelled', { retryable: false }); }
      const png = Buffer.alloc(33); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(100, 16); png.writeUInt32BE(80, 20);
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
