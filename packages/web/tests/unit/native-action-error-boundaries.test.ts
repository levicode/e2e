import { describe, expect, it, vi } from 'vitest';
import { EngineError, type LocatorAction, type OperationContext } from 'e2e/engine';
import { isNativeNotDispatched } from '../../src/native/browser-channel.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { serverMessage } from '../../src/native/protocol.ts';
import { NativeProtocolPeer, type PeerOutcome } from '../helpers/native-protocol-peer.ts';

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'action-errors', attemptId: 'action-errors', origin: 'test' });

// These are adapter proofs, not renderer proofs or retirement receipts. The
// original actions:6/8/9/10/11/13/14/15/16 tests remain in normal discovery.
describe('native action error boundaries', () => {
  it.each([
    { kind: 'tap' },
    { kind: 'press', key: 'Enter' },
    { kind: 'fill', value: 'hunter2-plaintext', sensitive: true },
    { kind: 'fill', value: 'gamma', sensitive: false },
  ] as const satisfies readonly LocatorAction[])('preserves the exact %j action on a clean typed refusal without replay', async action => {
    vi.useFakeTimers();
    const context = operation();
    const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action };
    const original = structuredClone(args);
    const peer = new NativeProtocolPeer([], request => {
      if (request.command === 'browser.perform') return { error: 'not-actionable', effects: 'not-dispatched', scopeState: 'usable' };
      if (request.command === 'scope.end') return { data: null };
      throw new Error('Unexpected action-error adapter command');
    });
    const client = await peer.connect(context, () => {});
    try {
      const channel = new EngineChannel(client);
      const failure: unknown = await channel.command('browser.perform', args, { ...context, timeoutMs: 7 }).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(EngineError);
      expect(failure).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false });
      expect(isNativeNotDispatched(failure)).toBe(true);
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.perform', original]]);
      expect(peer.frames.find(frame => frame['type'] === 'request')?.['timeoutMs']).toBe(7);
      if (action.kind === 'fill' && action.sensitive) {
        expect((failure as Error).message).not.toContain(action.value);
        expect((failure as Error).stack).not.toContain(action.value);
        expect((failure as Error).cause).toBeUndefined();
      }
      await expect(channel.command('scope.end', { identityScope: 'scope' }, context)).resolves.toBeNull();
      expect(peer.requests.map(request => request.command)).toEqual(['browser.perform', 'scope.end']);
    } finally {
      try { await client.close(context); } finally { vi.useRealTimers(); }
    }
  });

  it.each(['not-actionable', 'deadline-exceeded'] as const)('never downgrades an unknown tap %s to a clean refusal', async error => {
    const context = operation();
    const action = { kind: 'tap' } as const;
    const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action };
    const peer = new NativeProtocolPeer(['terminal.close/1'], (): PeerOutcome => ({ error, effects: 'unknown', scopeState: 'quarantined' }));
    const client = await peer.connect(context, () => {});
    try {
      const channel = new EngineChannel(client);
      const failure: unknown = await channel.command('browser.perform', args, context).catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
      expect(isNativeNotDispatched(failure)).toBe(false);
      await expect(channel.command('browser.perform', args, context)).rejects.toMatchObject({ code: 'INVALID_STATE', retryable: false });
      await expect(channel.command('scope.end', { identityScope: 'scope' }, context)).rejects.toMatchObject({ code: 'INVALID_STATE', retryable: false });
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.perform', args]]);
    } finally {
      await client.close(context);
      expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    }
  });

  it('keeps the sensitive noneditable producer outcome uncertain without leaking the submitted value', async () => {
    // The matching producer fixture executes PREPARE_FILL on a scripted DIV.
    // Unknown is not a claim that the DOM changed; it prevents a blind retry.
    const context = operation();
    const secret = 'hunter2-plaintext';
    const peer = new NativeProtocolPeer(['terminal.close/1'], () => ({ error: 'not-actionable', effects: 'unknown', scopeState: 'quarantined' }));
    const client = await peer.connect(context, () => {});
    try {
      const action = { kind: 'fill', value: secret, sensitive: true } as const;
      const failure: unknown = await new EngineChannel(client).command('browser.perform', { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action }, context).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(EngineError);
      expect(failure).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
      expect((failure as Error).message).not.toContain(secret);
      expect((failure as Error).stack).not.toContain(secret);
      expect((failure as Error).cause).toBeUndefined();
      expect(isNativeNotDispatched(failure)).toBe(false);
      expect(peer.requests).toHaveLength(1);
      expect(peer.requests[0]?.args['action']).toEqual(action);
    } finally {
      await client.close(context);
      expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    }
  });

  it.each(['message', 'cause', 'stack', 'callLog'])('rejects a raw %s field rather than treating backend text as classification authority', field => {
    const wire = { type: 'result', id: 'action', generation: 1, operationSeq: 1, ok: false, effects: 'not-dispatched', scopeState: 'usable', error: { code: 'not-actionable', [field]: 'hunter2-plaintext: performing click action' } };
    expect(() => serverMessage(wire)).toThrow();
  });
});
