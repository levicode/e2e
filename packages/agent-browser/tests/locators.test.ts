import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import type { LocatorExpression, OperationContext } from 'e2e/engine';
import { LocatorCompanion } from '../src/locators.ts';
import { SnapshotAdapter } from '../src/observation.ts';
import type { RawNodeData } from '../src/read-node.ts';

const context = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 20_000, runId: 'locators', attemptId: 'one', origin: 'test' });
const selector = (value: string): LocatorExpression => ({ kind: 'selector', selector: value });
const text = (value: string) => ({ kind: 'string' as const, value, exact: true });
const raw = (extra: Partial<RawNodeData> = {}): RawNodeData => ({
  role: 'button', name: 'Save', labels: null, text: 'Save', value: null, selection: null, inputPurpose: 'none',
  states: { checked: null, disabled: false, selected: null, expanded: null, pressed: null, focused: false, hidden: false, secure: false },
  level: null, attributes: {}, testId: null, rect: { x: 7, y: 9, width: 40, height: 20 }, ...extra,
});
type Data = RawNodeData & { selector?: string; baseURI?: string; frameGeometry?: { x: number; y: number; scaleX: number; scaleY: number }; frameSelector?: string };
type Match = { backend: number; data: Data; frameId?: string };

type TestFrameTree = { frame: { id: string; parentId?: string; url?: string; loaderId?: string }; childFrames?: TestFrameTree[] };
type TestDocument = { backendNodeId: number; nodeName?: string; frameId?: string; children?: TestDocument[]; contentDocument?: TestDocument };

/** Protocol double asserts identity/realm boundaries, independent of page selector semantics. */
class Protocol {
  readonly calls: { method: string; params: Record<string, unknown>; budget: number; session?: string }[] = [];
  readonly queries: string[] = [];
  readonly data = new Map<number, Data>();
  readonly queue: Match[][] = [];
  readonly arrays = new Map<string, Match[]>();
  tree: TestFrameTree = { frame: { id: 'root' } };
  readonly trees = new Map<string, TestFrameTree>();
  readonly documents = new Map<string, TestDocument>();
  failChildInRoot = false;
  delay = 0;
  async send<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, operation: OperationContext, session?: string): Promise<T> {
    this.calls.push({ method, params, budget: operation.timeoutMs, ...(session ? { session } : {}) });
    if (this.delay) { const delay = this.delay; this.delay = 0; await new Promise((resolve) => setTimeout(resolve, delay)); }
    let result: unknown;
    if (method === 'Page.getFrameTree') result = { frameTree: this.trees.get(session ?? '') ?? this.tree };
    else if (method === 'Page.createIsolatedWorld') {
      if (this.failChildInRoot && params.frameId !== 'root' && session === 'main') throw new Error('Frame belongs to another target');
      result = { executionContextId: params.frameId === 'root' ? 1 : params.frameId === 'child' ? 2 : 3 };
    } else if (method === 'DOM.getDocument') result = { root: this.documents.get(session ?? '') ?? { backendNodeId: 1 } };
    else if (method === 'DOM.getFrameOwner') result = { backendNodeId: params.frameId === 'child' ? 50 : 51 };
    else if (method === 'DOM.resolveNode') result = { object: { objectId: `backend:${String(params.backendNodeId)}` } };
    else if (method === 'Runtime.evaluate') {
      this.queries.push(String(params.expression));
      void new Script(String(params.expression));
      const id = `array:${this.arrays.size}`; this.arrays.set(id, this.queue.shift() ?? []); result = { result: { objectId: id } };
    } else if (method === 'Runtime.getProperties') {
      result = { result: this.arrays.get(String(params.objectId))!.map((_, i) => ({ name: String(i), value: { objectId: `${String(params.objectId)}:item:${i}` } })) };
    } else if (method === 'DOM.describeNode') {
      const [array, index] = String(params.objectId).split(':element:');
      const item = this.arrays.get(array!)![Number(index)]!;
      result = { node: { backendNodeId: item.backend, ...(item.frameId ? { frameId: item.frameId } : {}) } };
    } else if (method === 'Runtime.callFunctionOn') {
      const id = String(params.objectId);
      if (String(params.functionDeclaration).includes('this.map')) result = { result: { value: this.arrays.get(id)!.map((entry) => entry.data) } };
      else if (String(params.functionDeclaration).includes('return this.element')) result = { result: { objectId: id.replace(':item:', ':element:') } };
      else result = { result: { value: this.data.get(Number(id.slice(8))) } };
    } else if (method.startsWith('Runtime.release')) result = {};
    else throw new Error(`Unexpected protocol method ${method}`);
    return result as T;
  }
}

/** The only CLI mutations here register verified backend IDs in the exact-ref namespace. */
function fixture(protocol = new Protocol()) {
  const calls: string[][] = [];
  const recorded = calls;
  const transport = { async run<T>(args: readonly string[]): Promise<T> { recorded.push([...args]); return { ref: `e${recorded.length}` } as T; } };
  const companion = new LocatorCompanion({ cdp: () => protocol, session: () => 'main', transport: () => transport, frameSession: async (id) => `session:${id}` });
  return { protocol, calls, companion, adapter: new SnapshotAdapter(transport) };
}

test('AX-only default refs survive enrichment without fabricated backend identities', async () => {
  const { companion, protocol } = fixture();
  const metadata = await companion.readMetadata({ e1: { role: 'generic', name: '', backendNodeId: null }, e2: { role: 'text', name: 'status' } }, context());
  assert.deepEqual(metadata, { e1: { role: 'generic', name: '' }, e2: { role: 'text', name: 'status' } });
  assert.equal(protocol.calls.some((call) => call.method === 'DOM.resolveNode'), false);
});

test('observations omit secure values, arbitrary attrs and URL tokens; deterministic reads retain class', async () => {
  const { companion, protocol, adapter } = fixture();
  const secure = raw(); secure.states.secure = true;
  protocol.data.set(3, { ...secure, value: 'SECRET', selection: 'SECRET', text: 'SECRET', attributes: { value: 'SECRET', 'aria-valuetext': 'SECRET', 'data-token': 'SECRET', class: 'field', type: 'password' } });
  protocol.data.set(4, { ...raw(), baseURI: 'https://app.test/', attributes: { href: '/next?token=SECRET#SECRET', 'data-token': 'SECRET' } });
  const observed = await companion.readMetadata({ e3: { role: 'textbox', name: 'Password', backendNodeId: 3 }, e4: { role: 'link', name: 'Next', backendNodeId: 4 } }, context());
  assert.equal(JSON.stringify(observed).includes('SECRET'), false);
  assert.deepEqual(observed.e4?.attributes, { href: 'https://app.test/next' });
  protocol.queue.push([{ backend: 7, data: { ...raw(), attributes: { class: 'enabled control' } } }]);
  const [located] = await companion.locate(selector('#save'), context(), adapter);
  assert.equal(located?.attributes?.class, 'enabled control');
});

test('nested frame rectangles compose content origins and scale, and snapshot replay keeps framePath', async () => {
  const { companion, protocol } = fixture();
  protocol.tree = { frame: { id: 'root' }, childFrames: [{ frame: { id: 'child' }, childFrames: [{ frame: { id: 'grand' } }] }] };
  protocol.failChildInRoot = true;
  protocol.data.set(50, { ...raw(), frameSelector: '#outer', frameGeometry: { x: 100, y: 200, scaleX: 2, scaleY: 2 } });
  protocol.data.set(51, { ...raw(), frameSelector: '#inner', frameGeometry: { x: 20, y: 30, scaleX: 1, scaleY: 1 } });
  protocol.data.set(7, { ...raw(), selector: '#save' });
  const metadata = await companion.readMetadata({ e7: { role: 'button', name: 'Save', backendNodeId: 7, frameId: 'grand' } }, context());
  assert.deepEqual(metadata.e7?.framePath, ['#outer', '#inner']);
  assert.deepEqual(metadata.e7?.rect, { x: 154, y: 278, width: 80, height: 40 });
  assert.equal(protocol.calls.find(call => call.method === 'Page.createIsolatedWorld' && call.params.frameId === 'grand')?.session, 'session:child');
});

test('frame geometry includes border and padding before applying CSS scale', async () => {
  const { companion, protocol } = fixture();
  protocol.tree = { frame: { id: 'root' }, childFrames: [{ frame: { id: 'child' } }] };
  protocol.data.set(50, { ...raw(), frameSelector: '#frame', frameGeometry: { x: 0, y: 0, scaleX: 1, scaleY: 1 } });
  protocol.data.set(7, raw());
  await companion.readMetadata({ e7: { role: 'button', name: 'Save', backendNodeId: 7, frameId: 'child' } }, context());
  const call = protocol.calls.find(entry => entry.method === 'Runtime.callFunctionOn' && entry.params.objectId === 'backend:50');
  const source = /data\.frameGeometry=\(([\s\S]*?)\)\(this\);/.exec(String(call?.params.functionDeclaration))?.[1];
  assert.ok(source, 'Exercise the geometry reader actually sent to the parent-frame CDP realm');
  const script = new Script(`(${source})(frame)`);
  for (const example of [
    { width: 350, height: 230, paddingLeft: '5px', paddingTop: '5px', expected: { x: 85, y: 255, scaleX: 1, scaleY: 1 } },
    { width: 700, height: 345, paddingLeft: '5.5px', paddingTop: '7.25px', expected: { x: 101, y: 265.875, scaleX: 2, scaleY: 1.5 } },
    { width: 350, height: 230, paddingLeft: '0px', paddingTop: '0px', expected: { x: 80, y: 250, scaleX: 1, scaleY: 1 } },
  ]) {
    const frame = { parentElement: null, offsetWidth: 350, offsetHeight: 230, clientLeft: 10, clientTop: 10,
      getBoundingClientRect: () => ({ x: 70, y: 240, width: example.width, height: example.height }) };
    const result = script.runInNewContext({ frame, getComputedStyle: () => ({ transform: 'none', paddingLeft: example.paddingLeft, paddingTop: example.paddingTop }) }) as { x: number; y: number; scaleX: number; scaleY: number };
    assert.deepEqual({ ...result }, example.expected);
  }
});

test('frame scopes nested beneath index, filter and query are evaluated in the child realm', async () => {
  const { companion, protocol, calls, adapter } = fixture();
  protocol.tree = { frame: { id: 'root' }, childFrames: [{ frame: { id: 'child' } }] };
  protocol.failChildInRoot = true;
  protocol.data.set(50, { ...raw(), frameSelector: '#frame', frameGeometry: { x: 10, y: 20, scaleX: 1, scaleY: 1 } });
  protocol.queue.push([{ backend: 50, frameId: 'child', data: raw() }], [{ backend: 7, data: raw() }]);
  const expression: LocatorExpression = { kind: 'index', index: 'last', source: { kind: 'filter', hasText: text('Save'), source: {
    kind: 'query', query: { kind: 'role', value: text('button') }, scope: { kind: 'frame', selector: '#frame', source: selector('.panel') },
  } } };
  const [result] = await companion.locate(expression, context(), adapter);
  assert.deepEqual(result?.framePath, ['#frame']);
  assert.deepEqual(calls, [['ref', '7', '--frame', 'child']]);
  assert.ok(protocol.queries[1]?.includes('"kind":"index","index":"last"'));
  assert.ok(!protocol.queries[1]?.includes('"kind":"frame"'));
  assert.equal(protocol.calls.findLast((call) => call.method === 'Runtime.evaluate')?.session, 'session:child');
  assert.ok(protocol.calls.some((call) => call.method === 'Runtime.releaseObjectGroup'));
});

test('frame cardinality errors never select a convenient match or register a ref', async () => {
  for (const count of [0, 2]) {
    const { companion, protocol, calls, adapter } = fixture();
    protocol.queue.push(Array.from({ length: count }, () => ({ backend: 50, frameId: 'child', data: raw() })));
    await assert.rejects(companion.locate({ kind: 'frame', selector: 'iframe', source: selector('button') }, context(), adapter), { code: count ? 'FRAME_AMBIGUOUS' : 'FRAME_NOT_FOUND' });
    assert.equal(calls.length, 0);
  }
});

test('cross-frame has composition fails explicitly before any protocol command', async () => {
  const { companion, protocol, adapter } = fixture();
  await assert.rejects(companion.locate({ kind: 'filter', source: selector('div'), has: { kind: 'frame', selector: 'iframe', source: selector('button') } }, context(), adapter), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.equal(protocol.calls.length, 0);
});

test('the whole read shares one shrinking operation budget and keeps all matches', async () => {
  const { companion, protocol, adapter, calls } = fixture();
  protocol.delay = 20;
  protocol.queue.push([{ backend: 2, data: raw() }, { backend: 3, data: raw() }]);
  const result = await companion.locate(selector('button'), context(), adapter);
  assert.equal(result.length, 2); assert.equal(calls.length, 2);
  assert.ok(protocol.calls[1]!.budget < protocol.calls[0]!.budget - 10);
});

test('observation frame policy approves exact loaders and inherits blank/srcdoc origin', async () => {
  const sent: string[] = [];
  const cdp = { async send<T>(method: string): Promise<T> { if (method === 'DOM.getDocument') return { root: { backendNodeId: 1 } } as T; return { frameTree: { frame: { id: 'root', url: 'https://app.test/', loaderId: 'root-loader' }, childFrames: [
    { frame: { id: 'same', url: 'https://app.test/child', loaderId: 'same-loader' } },
    { frame: { id: 'blank', url: 'about:srcdoc', loaderId: 'blank-loader' } },
    { frame: { id: 'ad', url: 'https://ads.test/', loaderId: 'ad-loader' }, childFrames: [{ frame: { id: 'ad-blank', url: 'about:blank', loaderId: 'ad-blank-loader' } }] },
  ] } } as T; } };
  const companion = new LocatorCompanion({ cdp: () => cdp, session: () => 'main', transport: () => ({ async run<T>(): Promise<T> { throw new Error('No CLI command expected'); } }), frameSession: async id => id, allowFrameUrl: url => { sent.push(url); return url.startsWith('https://app.test/'); } });
  assert.deepEqual(await companion.snapshotArgs(context()), ['--allowed-frame-documents', '{"root":"root-loader","same":"same-loader","blank":"blank-loader"}']);
  assert.deepEqual(sent, ['https://app.test/', 'https://app.test/child', 'https://ads.test/']);
});


test('renderer-local frame trees merge only OOPIFs proven by DOM owners', async () => {
  const { companion, protocol } = fixture();
  protocol.tree = { frame: { id: 'root' } };
  protocol.documents.set('main', { backendNodeId: 1, children: [{ backendNodeId: 50, nodeName: 'IFRAME', frameId: 'child' }] });
  protocol.trees.set('session:child', { frame: { id: 'child', parentId: 'root' }, childFrames: [{ frame: { id: 'grand', parentId: 'child' } }] });
  protocol.documents.set('session:child', { backendNodeId: 2, children: [{ backendNodeId: 51, nodeName: 'IFRAME', frameId: 'grand', contentDocument: { backendNodeId: 3 } }] });
  protocol.data.set(50, { ...raw(), frameSelector: '#cross', frameGeometry: { x: 100, y: 200, scaleX: 1, scaleY: 1 } });
  protocol.data.set(51, { ...raw(), frameSelector: '#inner', frameGeometry: { x: 20, y: 30, scaleX: 1, scaleY: 1 } });
  protocol.data.set(7, { ...raw(), selector: '#deep' });
  const metadata = await companion.readMetadata({ e7: { role: 'button', name: 'Save', backendNodeId: 7, frameId: 'grand' } }, context());
  assert.deepEqual(metadata.e7?.framePath, ['#cross', '#inner']);
  assert.deepEqual(metadata.e7?.rect, { x: 127, y: 239, width: 40, height: 20 });
  assert.equal(protocol.calls.find(call => call.method === 'Page.createIsolatedWorld' && call.params.frameId === 'grand')?.session, 'session:child');
  protocol.trees.set('session:child', { frame: { id: 'unrelated', parentId: 'another-page' } });
  await assert.rejects(companion.readMetadata({ e7: { role: 'button', name: 'Save', backendNodeId: 7, frameId: 'grand' } }, context()), { code: 'FRAME_NOT_FOUND' });
});
