import test from 'node:test';
import assert from 'node:assert/strict';
import type { OperationContext } from 'e2e/engine';
import { AgentBrowserSurface } from '../src/surface.ts';

const context = (): OperationContext => ({ runId: 'run', attemptId: 'attempt', origin: 'test', signal: new AbortController().signal, timeoutMs: 1000 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  let commands = 0;
  const surface = new AgentBrowserSurface({});
  Object.assign(surface, { info: { runId: 'run' }, attempt: { attemptId: 'attempt' }, transport: { poisoned: false, run: async () => { commands++; return {}; } } });
  const owner = surface as unknown as { withUi<T>(operation: OperationContext, work: () => Promise<T>): Promise<T> };
  return { surface, owner, commands: () => commands };
}

test('a retained operation from another attempt cannot dispatch a command', async () => {
  const item = fixture();
  await assert.rejects(item.surface.command(['press', 'Enter'], { ...context(), attemptId: 'retired' }, true), { code: 'INVALID_STATE' });
  assert.equal(item.commands(), 0);
});

test('deferred work cannot inherit a retired UI owner and enter a later input sequence', async () => {
  const item = fixture();
  const later = deferred<void>();
  const holding = deferred<void>();
  let inherited!: Promise<void>;
  await item.owner.withUi(context(), async () => {
    inherited = later.promise.then(() => item.surface.pressKey('Enter', context()));
  });
  const current = item.owner.withUi(context(), () => holding.promise);
  const refusal = assert.rejects(inherited, { code: 'UNSUPPORTED_CAPABILITY' });
  later.resolve();
  await refusal;
  assert.equal(item.commands(), 0);
  holding.resolve();
  await current;
});

test('reset cannot replace the browser during an in-flight UI sequence', async () => {
  const item = fixture();
  const holding = deferred<void>();
  const current = item.owner.withUi(context(), () => holding.promise);
  await assert.rejects(item.surface.reset(context()), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.equal(item.commands(), 0);
  holding.resolve();
  await current;
});

// A denied screenshot must not replace refs that were never published to the
// caller. Use the real snapshot adapter and pixel inventory, not a mocked
// capture function, so the ordering regression remains observable.
test('a refused pixel observation does not replace the last published exact refs', async () => {
  const { SnapshotAdapter } = await import('../src/observation.ts');
  const { EngineError } = await import('e2e/engine');
  let snapshots = 0;
  let connected = true;
  const transport = {
    poisoned: false,
    async run<T>(args: readonly string[]): Promise<T> {
      if (args[0] === 'snapshot') {
        snapshots++;
        return { exactRefs: true, complete: true, snapshot: '- button "Save" [ref=e1]', refs: { e1: { role: 'button', name: 'Save', backendNodeId: 1 } } } as T;
      }
      if (args[0] === 'eval') return { result: { width: 800, height: 600, frames: false, location: 'https://fixture.test/' } } as T;
      if (args[0] === 'get') {
        if (!connected) throw new EngineError('NODE_STALE', 'Detached exact node', { retryable: true });
        assert.equal(args[2], '@e1');
        return { value: null } as T;
      }
      throw new Error(`Unexpected command: ${args[0]}`);
    },
  };
  const adapter = new SnapshotAdapter(transport, { readMetadata: async () => ({ e1: { rect: { x: 0, y: 0, width: 40, height: 20 } } }) });
  const connection = {
    attachTarget: async () => 'capture',
    async send(method: string) {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'owner' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: false } };
      if (method === 'DOM.getDocument') return { root: { nodeType: 9, children: [{ nodeType: 1, nodeName: 'OBJECT', backendNodeId: 9 }] } };
      if (['DOM.enable', 'Runtime.releaseObjectGroup', 'Target.detachFromTarget'].includes(method)) return {};
      throw new Error(`Unexpected CDP method: ${method}`);
    },
  };
  const surface = new AgentBrowserSurface({});
  Object.assign(surface, { info: { runId: 'run' }, attempt: { attemptId: 'attempt' }, transport, snapshots: adapter, connection, targetId: 'page', network: {} });
  const before = await surface.observe(context());
  const ref = before.root.children![0]!.ref;
  await assert.rejects(surface.observe(context(), { pixels: true }), /unsupported-owner-document/);
  assert.equal(snapshots, 1, 'a rejected screenshot must not invoke native snapshot');
  assert.equal(adapter.resolve(ref), '@e1');
  await adapter.verify(ref, context());
  connected = false;
  await assert.rejects(adapter.verify(ref, context()), { code: 'NODE_STALE' });
  connected = true;
  const refreshed = await surface.observe(context());
  assert.notEqual(refreshed.root.children![0]!.ref.id, ref.id);
  assert.throws(() => adapter.resolve(ref), { code: 'NODE_STALE' });
  assert.equal(adapter.resolve(refreshed.root.children![0]!.ref), '@e1');
});
