import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentBrowserSurface } from '../src/surface.ts';
import type { LocatorAction, OperationContext } from 'e2e/engine';

for (const failClose of [false, true]) {
  test(`surface disconnects scoped CLI sessions before disposing browser ownership (close failure: ${failClose})`, async () => {
    const surface = new AgentBrowserSurface({});
    const events: string[] = [];
    const original = new Error('Synthetic close failure');
    Object.assign(surface, {
      contextId: 'owned-context',
      network: { close() { events.push('network.close'); } },
      traceTransport: { async close() { events.push('trace.close'); if (failClose) throw original; } },
      transport: { async close() { events.push('primary.close'); } },
      owned: { async close() { events.push('browser.close'); } },
      connection: {
        async send(method: string, params: unknown) {
          assert.equal(method, 'Target.disposeBrowserContext');
          assert.deepEqual(params, { browserContextId: 'owned-context' });
          events.push('context.dispose');
        },
        close() { events.push('connection.close'); },
      },
    });
    const cleanup = surface.endAttempt({ signal: new AbortController().signal, timeoutMs: 1_000 });
    if (failClose) await assert.rejects(cleanup, error => error === original);
    else await cleanup;
    assert.deepEqual(events, ['network.close', 'trace.close', 'primary.close', 'context.dispose', 'browser.close', 'connection.close']);
    await surface.endAttempt({ signal: new AbortController().signal, timeoutMs: 1_000 });
    assert.equal(events.length, 6, 'Repeated teardown cannot repeat a browser or context mutation');
  });
}

for (const action of [{ kind: 'tap' }, { kind: 'hover' }, { kind: 'check' }, { kind: 'uncheck' }, { kind: 'dragTo', target: { id: 'destination', revision: 'one' } }] satisfies LocatorAction[]) {
  test(`surface ${action.kind} accepts acknowledged native pointer state with lifecycle metadata`, async () => {
    const surface = new AgentBrowserSurface({});
    const commands: string[][] = [];
    Object.assign(surface, {
      info: { runId: 'run' }, attempt: { attemptId: 'attempt' },
      snapshots: { isRoot: () => false, verify: async () => undefined, resolve: (ref: { id: string }) => `@${ref.id}` },
      transport: { async run(args: string[]) { commands.push(args); return args[0] === 'mouse'
        ? { x: 12.5, y: 40.25, buttons: 0, lifecycle: { reused: true } } : {}; } },
    });
    const context: OperationContext = { runId: 'run', attemptId: 'attempt', origin: 'test', timeoutMs: 1_000, signal: new AbortController().signal };
    await surface.perform({ id: 'source', revision: 'one' }, action, context);
    assert.deepEqual(commands.at(-1), ['mouse', 'state']);
    assert.equal(commands.length, 2, 'A successful pointer action must not be repeated during state synchronization');
    assert.deepEqual(surface.input.position, { x: 12.5, y: 40.25 });
    assert.doesNotThrow(() => surface.guardOperation(context));
  });
}

test('malformed post-action pointer state still poisons the attempt without repeating input', async () => {
  const surface = new AgentBrowserSurface({});
  let mutations = 0;
  Object.assign(surface, {
    info: { runId: 'run' }, attempt: { attemptId: 'attempt' },
    snapshots: { isRoot: () => false, verify: async () => undefined, resolve: () => '@source' },
    transport: { async run(args: string[]) { if (args[0] === 'click') { mutations++; return {}; } return { x: 0, y: 0, buttons: 3, lifecycle: { reused: true } }; } },
  });
  const context: OperationContext = { runId: 'run', attemptId: 'attempt', origin: 'test', timeoutMs: 1_000, signal: new AbortController().signal };
  await assert.rejects(surface.perform({ id: 'source', revision: 'one' }, { kind: 'tap' }, context), { code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
  assert.equal(mutations, 1);
  assert.throws(() => surface.guardOperation(context), { code: 'INVALID_STATE' });
});
