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
