import { expect, test } from 'vitest';
import { resultError, isNativeNotDispatched } from '../../src/native/browser-channel.ts';
import { serverMessage, type NativeResult } from '../../src/native/protocol.ts';
const result = (code: string, effects: NativeResult['effects'] = 'completed'): NativeResult => ({ type: 'result', id: 'action', generation: 1, operationSeq: 1, ok: false, error: { code }, effects, scopeState: effects === 'unknown' ? 'quarantined' : 'usable' });
test.each(['check', 'uncheck'] as const)('preserves %s postcondition failures from closed native reasons', verb => {
  for (const [code, suffix] of [['checked-state-unchanged', ''], ['checked-control-replaced', ' before the control was replaced']]) {
    const wire = result(code!); expect(serverMessage({ ...wire })).toEqual(wire);
    const failure = resultError(wire, verb);
    expect(failure).toMatchObject({ code: 'NOT_ACTIONABLE', message: `${verb} clicked the control but its checked state did not change${suffix}`, retryable: false });
    expect(isNativeNotDispatched(failure)).toBe(false);
  }
});
test('preserves pointer interception without exposing backend labels', () => {
  const wire = result('intercepted-pointer', 'not-dispatched'); expect(serverMessage({ ...wire })).toEqual(wire);
  expect(resultError(wire)).toMatchObject({ code: 'NOT_ACTIONABLE', message: 'Another element intercepts pointer events', retryable: false });
});
test.each(['checked-state-unchanged', 'checked-control-replaced', 'intercepted-pointer'])('never downgrades an unknown %s outcome', code => {
  expect(resultError(result(code, 'unknown'), 'check')).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
});

test('engine command mapping takes check/uncheck wording from the original typed action', async () => {
  const { NativeProtocolPeer } = await import('../helpers/native-protocol-peer.ts');
  const { EngineChannel } = await import('../../src/native/engine-channel.ts');
  const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'synthetic', attemptId: 'synthetic', origin: 'test' as const };
  const peer = new NativeProtocolPeer([], () => ({ error: 'checked-state-unchanged', effects: 'completed' }));
  const client = await peer.connect(operation, () => {}); const channel = new EngineChannel(client);
  try {
    for (const kind of ['check', 'uncheck'] as const) {
      await expect(channel.command('browser.perform', { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind } }, operation)).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: `${kind} clicked the control but its checked state did not change`, retryable: false });
    }
    expect(peer.requests.map(request => request.command)).toEqual(['browser.perform', 'browser.perform']);
  } finally { await client.close(operation); }
});


test('marks only the exact clean native timeout and never downgrades uncertain input', () => {
  const wire = result('deadline-exceeded', 'not-dispatched');
  expect(serverMessage({ ...wire })).toEqual(wire);
  const failure = resultError(wire);
  expect(failure).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
  expect(isNativeNotDispatched(failure)).toBe(true);
  expect(isNativeNotDispatched(Object.assign(new Error(failure.message), failure))).toBe(false);
  expect(isNativeNotDispatched(Object.assign(Object.create(Object.getPrototypeOf(failure)), failure))).toBe(false);
  expect(isNativeNotDispatched({ code: 'OPERATION_TIMEOUT', retryable: false })).toBe(false);
  for (const scopeState of ['usable', 'quarantined'] as const) {
    const uncertain = resultError({ ...wire, effects: 'unknown', scopeState });
    expect(uncertain).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(isNativeNotDispatched(uncertain)).toBe(false);
  }
  expect(isNativeNotDispatched(resultError({ ...wire, effects: 'completed' }))).toBe(false);
  expect(isNativeNotDispatched(resultError({ ...wire, scopeState: 'quarantined' }))).toBe(false);
});
