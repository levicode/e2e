import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import type { OperationContext } from 'e2e/engine';
import type { CdpConnection } from '../src/cdp.ts';
import { assertTextFocus } from '../src/input-focus.ts';

type Node = { id: number; tag?: string; frame?: string; shadow?: number; active?: number; root?: number; disabled?: boolean; readOnly?: boolean; editable?: boolean; inert?: boolean; connected?: boolean };
type Frame = { id: string; active: number; session: string; parent?: string; owner?: number };
const context = (): OperationContext => ({ runId: 'run', attemptId: 'attempt', origin: 'test', timeoutMs: 500, signal: new AbortController().signal });

function setup(nodes: Node[], frames: Frame[] = [{ id: 'main', active: 1, session: 'main-session' }]) {
  const calls: Array<{ method: string; params: Record<string, unknown>; session?: string; timeoutMs: number }> = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const realms = new Map<number, Frame>();
  let realmId = 0;
  let interceptor: ((method: string, params: Record<string, unknown>) => void) | undefined;
  const tree = (frame: Frame): unknown => ({ frame: { id: frame.id }, childFrames: frames.filter((child) => child.parent === frame.id).map(tree) });
  const object = (id: number): Record<string, unknown> => {
    const node = byId.get(id)!;
    return {
      remoteId: id, isConnected: node.connected !== false, nodeType: node.tag ? 1 : 11, tagName: node.tag, type: 'text',
      readOnly: node.readOnly === true, isContentEditable: node.editable === true, inert: node.inert === true,
      matches: () => node.disabled === true,
      get activeElement() { return node.active === undefined ? null : object(node.active); },
      getRootNode() {
        const active = node.root === undefined ? frames.find((frame) => frame.active === node.id)?.active : byId.get(node.root)?.active;
        return { activeElement: active === node.id ? this : null };
      },
    };
  };
  const cdp = { async send(method: string, params: Record<string, unknown>, operation: OperationContext, session?: string) {
    calls.push({ method, params, timeoutMs: operation.timeoutMs, ...(session ? { session } : {}) });
    interceptor?.(method, params);
    if (method === 'Page.getFrameTree') return { frameTree: tree(frames.find((frame) => frame.session === session)!) };
    if (method === 'Page.createIsolatedWorld') {
      const frame = frames.find((entry) => entry.id === params.frameId)!;
      if (frame.session !== session) throw new Error('Frame belongs to another session');
      realms.set(++realmId, frame); return { executionContextId: realmId };
    }
    if (method === 'Runtime.evaluate') return { result: { objectId: String(realms.get(params.contextId as number)!.active) } };
    if (method === 'DOM.describeNode') {
      const node = byId.get(Number(params.objectId))!;
      return { node: {
        backendNodeId: node.id, nodeName: node.tag,
        ...(node.frame ? { frameId: node.frame } : {}),
        ...(node.shadow ? { shadowRoots: [{ backendNodeId: node.shadow, shadowRootType: 'closed' }] } : {}),
      } };
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: String(params.backendNodeId) } };
    if (method === 'DOM.getFrameOwner') return { backendNodeId: frames.find((frame) => frame.id === params.frameId)!.owner };
    if (method === 'Runtime.callFunctionOn') {
      const result: unknown = vm.runInNewContext(`(${String(params.functionDeclaration)})`).call(object(Number(params.objectId)));
      return { result: typeof result === 'object' && result !== null && 'remoteId' in result ? { objectId: String(result.remoteId) } : { value: result } };
    }
    if (method === 'Runtime.releaseObjectGroup') return {};
    throw new Error('Unexpected method');
  } };
  const options = {
    cdp: () => cdp as unknown as Pick<CdpConnection, 'send'>, session: () => 'main-session',
    frameSession: async (frameId: string) => frames.find((frame) => frame.id === frameId)!.session,
  };
  return { options, calls, intercept(callback: typeof interceptor) { interceptor = callback; } };
}

test('focus preflight accepts exact editable focus and rejects body, disabled, readonly, and inert controls', async () => {
  for (const node of [
    { id: 1, tag: 'INPUT' }, { id: 1, tag: 'TEXTAREA' }, { id: 1, tag: 'DIV', editable: true },
  ]) await assertTextFocus(setup([node]).options, context());
  for (const node of [
    { id: 1, tag: 'BODY' }, { id: 1, tag: 'INPUT', disabled: true }, { id: 1, tag: 'INPUT', readOnly: true },
    { id: 1, tag: 'INPUT', inert: true }, { id: 1, tag: 'INPUT', connected: false },
  ]) await assert.rejects(assertTextFocus(setup([node]).options, context()), { code: 'NOT_ACTIONABLE' });
});

test('closed shadow focus follows each active root and releases only generated object groups', async () => {
  const fixture = setup([
    { id: 1, tag: 'X-OUTER', shadow: 2 }, { id: 2, active: 3 },
    { id: 3, tag: 'X-INNER', root: 2, shadow: 4 }, { id: 4, active: 5 },
    { id: 5, tag: 'INPUT', root: 4 },
  ]);
  await assertTextFocus(fixture.options, context());
  assert.deepEqual(fixture.calls.filter((call) => call.method === 'DOM.resolveNode').map((call) => call.params.backendNodeId), [2, 4]);
  assert.equal(fixture.calls.at(-1)?.method, 'Runtime.releaseObjectGroup');
  assert.ok(fixture.calls.every((call) => !call.method.startsWith('Input.')));
});

test('same-origin iframe focus descends only through its exact focused owner', async () => {
  const fixture = setup([{ id: 1, tag: 'IFRAME', frame: 'child' }, { id: 2, tag: 'TEXTAREA' }], [
    { id: 'main', active: 1, session: 'main-session' },
    { id: 'child', active: 2, session: 'main-session', parent: 'main', owner: 1 },
  ]);
  await assertTextFocus(fixture.options, context());
  assert.deepEqual(fixture.calls.filter((call) => call.method === 'DOM.getFrameOwner').map((call) => call.params.frameId), ['child']);
  assert.ok(fixture.calls.every((call) => call.session === 'main-session'));
});

test('cross-origin focus uses its owned session and checks remote root identity', async () => {
  const fixture = setup([{ id: 1, tag: 'IFRAME', frame: 'child' }, { id: 2, tag: 'INPUT' }], [
    { id: 'main', active: 1, session: 'main-session' },
    { id: 'child', active: 2, session: 'child-session', parent: 'main', owner: 1 },
  ]);
  await assertTextFocus(fixture.options, context());
  assert.ok(fixture.calls.some((call) => call.method === 'Page.getFrameTree' && call.session === 'child-session'));
  assert.equal(fixture.calls.filter((call) => call.method === 'Runtime.releaseObjectGroup').length, 2);
});

test('a focused body never selects an editable field from another frame', async () => {
  const fixture = setup([{ id: 1, tag: 'BODY' }, { id: 2, tag: 'INPUT' }], [
    { id: 'main', active: 1, session: 'main-session' },
    { id: 'child', active: 2, session: 'child-session', parent: 'main', owner: 5 },
  ]);
  await assert.rejects(assertTextFocus(fixture.options, context()), { code: 'NOT_ACTIONABLE' });
  assert.ok(fixture.calls.every((call) => call.session === 'main-session'));
});

test('replacement frame owners and ancestry mismatches fail closed', async () => {
  for (const child of [
    { id: 'child', active: 2, session: 'child-session', parent: 'main', owner: 99 },
    { id: 'child', active: 2, session: 'child-session', parent: 'different', owner: 1 },
  ]) {
    const fixture = setup([{ id: 1, tag: 'IFRAME', frame: 'child' }, { id: 2, tag: 'INPUT' }], [{ id: 'main', active: 1, session: 'main-session' }, child]);
    await assert.rejects(assertTextFocus(fixture.options, context()), { code: 'NOT_ACTIONABLE' });
    assert.ok(fixture.calls.every((call) => call.session === 'main-session'));
  }
});

test('a removed focus ancestor during the multi-command read is rechecked before accepting input', async () => {
  const host: Node = { id: 1, tag: 'X-HOST', shadow: 2 };
  const fixture = setup([host, { id: 2, active: 3 }, { id: 3, tag: 'INPUT', root: 2 }]);
  fixture.intercept((method, params) => {
    if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('matches')) host.connected = false;
  });
  await assert.rejects(assertTextFocus(fixture.options, context()), { code: 'NOT_ACTIONABLE' });
});

test('cancelled focus preflight never makes protocol calls', async () => {
  const fixture = setup([{ id: 1, tag: 'INPUT' }]);
  await assert.rejects(assertTextFocus(fixture.options, { ...context(), signal: AbortSignal.abort('secret') }), { code: 'CANCELLED' });
  assert.equal(fixture.calls.length, 0);
});
