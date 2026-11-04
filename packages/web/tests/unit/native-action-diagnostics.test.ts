import { describe, expect, it, vi } from 'vitest';
import { EngineError, type OperationContext } from 'e2e/engine';
import { isNativeNotDispatched } from '../../src/native/browser-channel.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import type { EngineCommandMap } from '../../src/native/engine-contract.ts';
type NativeLocatorAction = EngineCommandMap['browser.perform']['args']['action'];
import { NativeProtocolPeer, type PeerOutcome } from '../helpers/native-protocol-peer.ts';

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'action-diagnostics', attemptId: 'action-diagnostics', origin: 'test' });

async function refused(action: NativeLocatorAction, outcome: PeerOutcome): Promise<Error> {
  const context = operation();
  const peer = new NativeProtocolPeer(['terminal.close/1'], () => outcome);
  const client = await peer.connect(context, () => {});
  try {
    const failure: unknown = await new EngineChannel(client).command('browser.perform', { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action }, context).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(peer.requests).toHaveLength(1);
    expect(peer.requests[0]?.args['action']).toEqual(action);
    return failure as Error;
  } finally { await client.close(context); }
}

const clean = { error: 'not-actionable', effects: 'not-dispatched', scopeState: 'usable' } as const;

describe('native request-local action diagnostics', () => {
  it.each([{ kind: 'tap' }, { kind: 'press', key: 'Enter' }] as const)('names the original %j action without inventing a timeout or blocker', async action => {
    const failure = await refused(action, clean);
    expect(failure).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false, message: `${action.kind} did not become actionable` });
    expect(isNativeNotDispatched(failure)).toBe(true);
    expect(failure.message).not.toContain('Timeout');
    expect(failure.cause).toBeUndefined();
  });

  it('keeps the real pointer-interception category but no renderer selector', async () => {
    expect(await refused({ kind: 'tap' }, { ...clean, error: 'intercepted-pointer' })).toMatchObject({
      code: 'NOT_ACTIONABLE', retryable: false,
      message: 'tap did not become actionable: another element intercepts pointer events',
    });
  });

  it.each(['check', 'uncheck'] as const)('retains the established %s postcondition message', async kind => {
    expect(await refused({ kind }, { error: 'checked-state-unchanged', effects: 'completed', scopeState: 'usable' })).toMatchObject({
      code: 'NOT_ACTIONABLE', retryable: false,
      message: `${kind} clicked the control but its checked state did not change`,
    });
  });

  it.each(['not-actionable', 'invalid-arguments', 'unsupported-capability'] as const)('redacts a sensitive fill without dropping its %s diagnostic category', async error => {
    const secret = 'hunter2-plaintext';
    const failure = await refused({ kind: 'fill', value: secret, sensitive: true }, { ...clean, error });
    const expectedCode = error === 'not-actionable' ? 'NOT_ACTIONABLE' : error === 'unsupported-capability' ? 'UNSUPPORTED_CAPABILITY' : 'ENGINE_FAILURE';
    expect(failure).toMatchObject({ code: expectedCode, retryable: false });
    expect(failure.message).toContain('[redacted]');
    if (error !== 'not-actionable') expect(failure.message).toContain(error);
    expect(failure.message).not.toContain(secret);
    expect(failure.stack).not.toContain(secret);
    expect(failure.cause).toBeUndefined();
  });

  it('does not label an ordinary fill value as redacted or invent an underlying error', async () => {
    const failure = await refused({ kind: 'fill', value: 'gamma', sensitive: false }, clean);
    expect(failure.message).toBe('fill did not become actionable');
    expect(failure.message).not.toContain('gamma');
    expect(failure.cause).toBeUndefined();
  });

  it('preserves unknown effects, refuses replay and never claims Input dispatch from a preparation failure', async () => {
    const context = operation();
    const peer = new NativeProtocolPeer(['terminal.close/1'], () => ({ error: 'not-actionable', effects: 'unknown', scopeState: 'quarantined' }));
    const client = await peer.connect(context, () => {});
    try {
      const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind: 'fill', value: 'hunter2-plaintext', sensitive: true } as const };
      const channel = new EngineChannel(client);
      const failure: unknown = await channel.command('browser.perform', args, context).catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false, message: 'fill outcome is unknown; the action may have committed (fill value [redacted])' });
      expect(isNativeNotDispatched(failure)).toBe(false);
      expect((failure as Error).message).not.toContain('input was dispatched');
      expect((failure as Error).message).not.toContain(args.action.value);
      expect((failure as Error).stack).not.toContain(args.action.value);
      expect((failure as Error).cause).toBeUndefined();
      await expect(channel.command('browser.perform', args, context)).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(peer.requests).toHaveLength(1);
    } finally {
      await client.close(context);
      expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    }
  });

  it('captures verb and sensitivity before a pending caller mutates its action object', async () => {
    let received!: () => void;
    const arrived = new Promise<void>(resolve => { received = resolve; });
    let settle!: (result: PeerOutcome) => void;
    const pending = new Promise<PeerOutcome>(resolve => { settle = resolve; });
    const peer = new NativeProtocolPeer([], () => { received(); return pending; });
    const context = operation();
    const client = await peer.connect(context, () => {});
    const action = { kind: 'fill', value: 'hunter2-plaintext', sensitive: true };
    try {
      const result = new EngineChannel(client).command('browser.perform', { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: action as NativeLocatorAction }, context);
      await arrived;
      action.kind = 'tap'; action.value = 'changed'; action.sensitive = false;
      settle(clean);
      await expect(result).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: 'fill did not become actionable (fill value [redacted])' });
      expect(peer.requests[0]?.args['action']).toEqual({ kind: 'fill', value: 'hunter2-plaintext', sensitive: true });
    } finally { await client.close(context); }
  });

  it('does not echo an unrecognized action verb supplied outside the typed boundary', async () => {
    const hostile = { kind: 'hunter2-plaintext <div id="private">' } as unknown as NativeLocatorAction;
    const failure = await refused(hostile, clean);
    expect(failure.message).toBe('The native browser operation failed (not-actionable)');
    expect(failure.message).not.toContain('hunter2-plaintext');
  });

  it('preserves the identity of a real local NativeClient error instead of synthesizing a cause', async () => {
    const peer = new NativeProtocolPeer([], () => { throw new Error('An expired request must never reach the peer'); });
    const context = operation();
    const client = await peer.connect(context, () => {});
    const request = client.request.bind(client);
    let original: unknown;
    const spy = vi.spyOn(client, 'request').mockImplementation(async (...args) => {
      try { return await request(...args); } catch (cause) { original = cause; throw cause; }
    });
    try {
      const failure: unknown = await new EngineChannel(client).command('browser.perform', { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind: 'fill', value: 'gamma', sensitive: false } }, { ...context, timeoutMs: 0 }).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(EngineError);
      expect(failure).toBe(original);
      expect(failure).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
      expect((failure as Error).cause).toBeUndefined();
      expect(peer.requests).toHaveLength(0);
    } finally { spy.mockRestore(); await client.close(context); }
  });
});
