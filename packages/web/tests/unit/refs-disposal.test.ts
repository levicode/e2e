import { describe, expect, it } from 'vitest';

// Producer authority is tested separately in native a878a1d, CI39646980813:
// chromium_located_reference_retirement_across_owned_attempts (real browser),
// chromium_query_churn_bounds_durable_metadata_without_evicting_authority (real browser),
// query_group_cleanup_failure_preserves_primary_and_never_publishes (TCP failure injection).
// The peer below proves only the production adapter's exact forwarding/error boundary.
// Accepted policy change: bounded100000 native metadata entries with atomic refusal, rather
// than old2048 retained Playwright handles with incremental eviction. A proves bounded
// admission/no alias; B/C separately prove lifecycle and transient cleanup, not quota alone.
import { PassThrough, Writable } from 'node:stream';
import type { OperationContext } from 'e2e/engine';
import { NativeClient } from '../../src/native/client.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';

async function referenceBoundary() {
  const output = new PassThrough();
  const requests: Record<string, unknown>[] = [];
  const input = new Writable({ write(chunk: Buffer, _encoding, callback) { requests.push(JSON.parse(chunk.toString()) as Record<string, unknown>); callback(); } });
  const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'references', attemptId: 'attempt', origin: 'test' });
  const send = (message: unknown) => output.write(JSON.stringify(message) + '\n');
  const connecting = NativeClient.connect({ readable: output, writable: input, dispose: () => { input.destroy(); output.destroy(); } }, [], operation(), () => {});
  send({ type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1', sessionId: 'reference-peer', generation: 1, capabilities: [], limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
  const client = await connecting;
  const reply = (data: unknown, error?: string) => {
    const request = requests.at(-1)!;
    send({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: error === undefined, ...(error === undefined ? { data } : { error: { code: error } }), effects: 'not-dispatched', scopeState: 'usable' });
  };
  const close = async () => { const closing = client.close(operation()); send({ type: 'closed', id: requests.at(-1)!['id'], generation: 1, scopeState: 'closed' }); await closing; };
  return { channel: new EngineChannel(client), requests, operation, reply, close };
}
const referenceQuery = { identityScope: 'first', testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]', expression: { kind: 'selector', selector: '#current' } } as const;

describe('located reference production transport boundary', () => {
  it('preserves native query identity and propagates stale identity without rebinding or retry', async () => {
    const f = await referenceBoundary();
    try {
      const queried = f.channel.command('fixture.query', referenceQuery, f.operation());
      f.reply({ identityScope: 'first', revision: '7', nodes: [{ ref: { id: '@e41', revision: '7' }, role: 'button' }] });
      const reference = (await queried).nodes[0]!.ref;
      expect(reference).toEqual({ id: '@e41', revision: '7' });
      const ending = f.channel.command('scope.end', { identityScope: 'first' }, f.operation()); f.reply(null); await ending;
      const action = f.channel.command('browser.perform', { identityScope: 'replacement', ref: reference, action: { kind: 'tap' } }, f.operation());
      f.reply(undefined, 'stale-reference');
      await expect(action).rejects.toMatchObject({ code: 'NODE_STALE' });
      expect(f.requests.at(-1)!['args']).toEqual({ identityScope: 'replacement', ref: { id: '@e41', revision: '7' }, action: { kind: 'tap' } });
      expect(f.requests.map(request => request['command']).filter(Boolean)).toEqual(['fixture.query', 'scope.end', 'browser.perform']);
    } finally { await f.close(); }
  });

  it('rejects native query quota failure without publishing nodes or refreshing existing exact refs', async () => {
    const f = await referenceBoundary();
    try {
      const queried = f.channel.command('fixture.query', referenceQuery, f.operation());
      f.reply({ identityScope: 'first', revision: '7', nodes: [{ ref: { id: '@e41', revision: '7' } }] });
      const reference = (await queried).nodes[0]!.ref;
      const overflow = f.channel.command('fixture.query', referenceQuery, f.operation()); f.reply(undefined, 'capacity-exceeded');
      await expect(overflow).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: 'The native browser operation failed (capacity-exceeded)' });
      const action = f.channel.command('browser.perform', { identityScope: 'first', ref: reference, action: { kind: 'tap' } }, f.operation()); f.reply(null); await action;
      expect(f.requests.at(-1)!['args']).toEqual({ identityScope: 'first', ref: { id: '@e41', revision: '7' }, action: { kind: 'tap' } });
      expect(f.requests.map(request => request['command']).filter(Boolean)).toEqual(['fixture.query', 'fixture.query', 'browser.perform']);
    } finally { await f.close(); }
  });
});
