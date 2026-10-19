import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentBrowserSurface } from '../src/surface.ts';

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
