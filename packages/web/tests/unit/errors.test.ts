/** Closed native failures preserve public retry/classification semantics without parsing backend text. */
import { describe, expect, it } from 'vitest';
import { ConfigurationError, EngineError, TestError } from 'e2e/engine';
import { isTestErrorCode } from '../../src/runtime-support.ts';
import { resultError } from '../../src/native/browser-channel.ts';
import type { Effects } from '../../src/native/protocol.ts';
import { dialogPeer, nativeDialog } from '../helpers/dialog-peer.ts';

function foreignTestError(code: string): Error {
  const error = new Error(code); error.name = 'TestError';
  Object.assign(error, { category: 'test', code, retryable: false }); return error;
}
function failure(code: string, effects: Effects = 'not-dispatched'): EngineError {
  return resultError({ type: 'result', id: 'failure', generation: 1, operationSeq: 1, ok: false, error: { code }, effects, scopeState: effects === 'unknown' ? 'quarantined' : 'usable' });
}
async function fromCallback(error: Error): Promise<Error | undefined> {
  const peer = await dialogPeer();
  try {
    await peer.add(() => { throw error; }); await peer.dispatch(nativeDialog().dialog);
    try { peer.throwPending(); } catch (cause) { if (cause instanceof Error) return cause; throw cause; }
    return undefined;
  } finally { await peer.close(); }
}

describe('native error boundary', () => {
  it('passes engine errors through untouched', async () => {
    const original = new EngineError('NODE_STALE', 'gone', { retryable: true });
    expect(await fromCallback(original)).toBe(original);
  });
  it('passes runner errors through untouched: policy never becomes infrastructure', async () => {
    const denied = new TestError('POLICY_DENIED', 'blocked');
    const invalid = new TestError('INVALID_STATE', 'bad state');
    expect(await fromCallback(denied)).toBe(denied); expect(await fromCallback(invalid)).toBe(invalid);
  });
  it('recognizes an EngineError from another module copy structurally', async () => {
    const foreign = new Error('stale'); foreign.name = 'EngineError';
    Object.assign(foreign, { code: 'NODE_STALE', retryable: true });
    expect(await fromCallback(foreign)).toBe(foreign);
  });
  it('passes a runner error from another module copy through untouched', async () => {
    const foreign = foreignTestError('LOCATOR_AMBIGUOUS'); expect(await fromCallback(foreign)).toBe(foreign);
  });
  it('maps a timeout to a non-retryable OPERATION_TIMEOUT', () => {
    expect(failure('deadline-exceeded')).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
  });
});

describe('isTestErrorCode', () => {
  it('matches the code on a TestError from this module copy', () => {
    expect(isTestErrorCode(new TestError('LOCATOR_NOT_FOUND', 'gone'), 'LOCATOR_NOT_FOUND')).toBe(true);
    expect(isTestErrorCode(new TestError('LOCATOR_AMBIGUOUS', 'two'), 'LOCATOR_NOT_FOUND')).toBe(false);
  });

  it('matches the code on a TestError from another module copy, where instanceof says no', () => {
    const foreign = foreignTestError('LOCATOR_NOT_FOUND');
    expect(foreign instanceof TestError).toBe(false);
    expect(isTestErrorCode(foreign, 'LOCATOR_NOT_FOUND')).toBe(true);
    expect(isTestErrorCode(foreign, 'LOCATOR_AMBIGUOUS')).toBe(false);
  });

  it('never matches another class carrying the same code', () => {
    const engine = new EngineError('NODE_STALE', 'engine says', { retryable: true });
    expect(isTestErrorCode(engine, 'NODE_STALE')).toBe(false);
    expect(isTestErrorCode(new ConfigurationError('LOCATOR_NOT_FOUND', 'config says'), 'LOCATOR_NOT_FOUND')).toBe(false);
    expect(isTestErrorCode('LOCATOR_NOT_FOUND', 'LOCATOR_NOT_FOUND')).toBe(false);
  });
});

// Navigation replacement and detached-node detection now belong to native code.
// These assertions cover the public projection of its closed stale-reference evidence;
// native browser races remain separate required acceptance gates, not string matching here.
describe('native read/capture error projection', () => {
  it('reports a capture that lost its document as retryable only before dispatch', () => {
    expect(failure('stale-reference')).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(failure('stale-reference', 'completed')).toMatchObject({ code: 'NODE_STALE', retryable: false });
  });
  it('keeps a timeout a timeout: a capture that ran out of budget is not a race', () => {
    expect(failure('deadline-exceeded')).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
  });
  it('leaves every other failure a non-retryable ENGINE_FAILURE', () => {
    expect(failure('browser-failure')).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
  });
  it('never reclassifies an engine error the callback already classified', async () => {
    const original = new EngineError('ENGINE_FAILURE', 'Execution context was destroyed', { retryable: false });
    expect(await fromCallback(original)).toBe(original);
  });
  it('treats exact native navigation-race evidence as stale, not arbitrary error text', async () => {
    expect(failure('stale-reference')).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(await fromCallback(new Error('Execution context was destroyed'))).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
  });
  it('still reports exact native detachment and misses as stale', () => {
    expect(failure('stale-reference')).toMatchObject({ code: 'NODE_STALE', retryable: true });
  });
  it('keeps a timeout a timeout: locate resolves once and never waits', () => {
    expect(failure('deadline-exceeded')).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
  });
  it('never retries a stale-looking error with an unknown action outcome', () => {
    expect(failure('stale-reference', 'unknown')).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
  });
});
