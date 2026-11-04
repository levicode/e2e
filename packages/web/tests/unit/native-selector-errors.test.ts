import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { TestError } from 'e2e/engine';
import { resultError, isNativeNotDispatched } from '../../src/native/browser-channel.ts';
import { serverMessage, type NativeResult } from '../../src/native/protocol.ts';
import { serverMessage as legacyServerMessage } from '../fixtures/client-protocol-ci17.ts';

const vectors = JSON.parse(readFileSync(new URL('../fixtures/client-protocol-v1.json', import.meta.url), 'utf8')) as { selectorErrors: Record<string, unknown>[] };
const clean = { type: 'result', id: 'selector', generation: 1, operationSeq: 1, ok: false, error: { code: 'invalid-locator' }, effects: 'not-dispatched', scopeState: 'usable' } as const;

test('the new native selector code is decoded only by the coordinated decoder', () => {
  for (const value of vectors.selectorErrors) {
    expect(serverMessage(value)).toBe(value);
    expect(() => legacyServerMessage(value)).toThrow();
  }
});

test('a clean selector refusal is a typed, nonretryable INVALID_LOCATOR', () => {
  const failure = resultError(serverMessage(clean) as NativeResult);
  expect(failure).toBeInstanceOf(TestError);
  expect(failure).toMatchObject({ code: 'INVALID_LOCATOR', retryable: false });
  expect(isNativeNotDispatched(failure)).toBe(true);
});

test('malformed native requests are still infrastructure errors', () => {
  expect(resultError(serverMessage({ ...clean, error: { code: 'invalid-arguments' } }) as NativeResult)).toMatchObject({ code: 'ENGINE_FAILURE' });
});

test.each(['quarantined', 'closed'] as const)('a %s scope is never disguised as a user selector mistake', scopeState => {
  const failure = resultError(serverMessage({ ...clean, scopeState }) as NativeResult);
  expect(failure).toMatchObject({ code: 'ENGINE_FAILURE' });
  expect(isNativeNotDispatched(failure)).toBe(false);
});

test('unknown effects take precedence over the selector code', () => {
  const failure = resultError(serverMessage({ ...clean, effects: 'unknown', scopeState: 'quarantined' }) as NativeResult);
  expect(failure).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  expect(isNativeNotDispatched(failure)).toBe(false);
});

test('completed effects do not acquire input-validation semantics', () => {
  const failure = resultError(serverMessage({ ...clean, effects: 'completed' }) as NativeResult);
  expect(failure).toMatchObject({ code: 'ENGINE_FAILURE' });
  expect(isNativeNotDispatched(failure)).toBe(false);
});
