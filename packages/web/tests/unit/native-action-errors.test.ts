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

test('only an exact clean unsupported fill permits the existing keyboard fallback', () => {
  const wire = result('fill-unsupported-target', 'not-dispatched');
  const context = { kind: 'fill', sensitive: false } as const;
  expect(serverMessage({ ...wire })).toEqual(wire);
  const failure = resultError(wire, undefined, undefined, undefined, context);
  expect(failure).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false });
  expect(failure.message).toMatch(/not an? <?(input|textarea)|not editable/i);
  expect(isNativeNotDispatched(failure)).toBe(true);
  for (const code of ['not-actionable', 'policy-denied', 'stale-reference', 'browser-failure']) {
    expect(resultError(result(code, 'not-dispatched'), undefined, undefined, undefined, context).message)
      .not.toMatch(/not an? <?(input|textarea)|not editable/i);
  }
  for (const effects of ['completed', 'unknown'] as const) {
    expect(resultError({ ...wire, effects }, undefined, undefined, undefined, context).message)
      .not.toMatch(/not an? <?(input|textarea)|not editable/i);
  }
  expect(resultError({ ...wire, scopeState: 'quarantined' }, undefined, undefined, undefined, context).message)
    .not.toMatch(/not an? <?(input|textarea)|not editable/i);
});

test('focused typing exposes its static no receiver refusal without renderer text', () => {
  const wire = result('no-editable-focus', 'not-dispatched');
  expect(serverMessage({ ...wire })).toEqual(wire);
  expect(resultError(wire)).toMatchObject({
    code: 'NOT_ACTIONABLE', retryable: false,
    message: 'nothing that takes keystrokes has focus: the typed text would reach no field. Tap the field first, or type into a listed input by id.',
  });
  expect(resultError(result('no-editable-focus', 'unknown'))).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
});


test('retains NOT_ACTIONABLE for clear and non-clean typed refusals without granting fill fallback', () => {
  for (const code of ['fill-unsupported-target', 'no-editable-focus']) {
    for (const effects of ['not-dispatched', 'completed'] as const) {
      for (const scopeState of ['usable', 'quarantined'] as const) {
        const failure = resultError({ ...result(code, effects), scopeState }, undefined, undefined, undefined, { kind: 'clear', sensitive: false });
        expect(failure).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false });
        expect(failure.message).not.toMatch(/not an? <?(input|textarea)|not editable/i);
      }
    }
  }
});

test('only the certified completed plain tap can relocate after hover without replaying a press', () => {
  const wire = result('tap-target-replaced-before-press', 'completed');
  const context = { kind: 'tap', sensitive: false } as const;
  expect(serverMessage({ ...wire })).toEqual(wire);
  const failure = resultError(wire, undefined, undefined, undefined, context);
  expect(failure).toMatchObject({ code: 'NODE_STALE', retryable: true });
  expect(failure.message).toContain('before its button press');
  expect(isNativeNotDispatched(failure)).toBe(false); // the hover did commit
  for (const effects of ['not-dispatched', 'unknown'] as const) {
    const refused = resultError({ ...wire, effects }, undefined, undefined, undefined, context);
    expect(refused.code).not.toBe('NODE_STALE');
    expect(refused.retryable).toBe(false);
  }
  for (const scopeState of ['quarantined', 'closed'] as const) {
    expect(resultError({ ...wire, scopeState }, undefined, undefined, undefined, context)).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false });
  }
  for (const kind of ['fill', 'clear', 'doubleTap', 'secondaryTap', 'hover', 'check', 'dragTo'] as const) {
    expect(resultError(wire, undefined, undefined, undefined, { kind, sensitive: false })).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false });
  }
  expect(resultError(wire)).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false });
});
