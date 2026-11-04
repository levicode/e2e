import { afterEach, expect, it, vi } from 'vitest';
import { EngineError } from 'e2e/engine';
import { connectionDeadline, connectionWaitDeparture, isLocalBudgetDeparture, withConnectionBudget } from '../../src/operation-budget.ts';

afterEach(() => vi.useRealTimers());
it('tags only its own deadline error, not same-code errors or copies', () => {
  const owned = connectionDeadline('local deadline');
  expect(isLocalBudgetDeparture(owned)).toBe(true);
  expect(isLocalBudgetDeparture(new EngineError('OPERATION_TIMEOUT', owned.message, { retryable: false }))).toBe(false);
  expect(isLocalBudgetDeparture(new EngineError('CANCELLED', 'native cancelled', { retryable: false }))).toBe(false);
});
it('copies a borrowed abort reason without granting it local-departure identity', () => {
  const foreign = new EngineError('OPERATION_TIMEOUT', 'provider receipt', { retryable: false });
  const signal = AbortSignal.abort(foreign);
  const departure = connectionWaitDeparture(signal, 'caller left');
  expect(departure).not.toBe(foreign); expect(departure.code).toBe(foreign.code);
  expect(isLocalBudgetDeparture(departure)).toBe(true); expect(isLocalBudgetDeparture(foreign)).toBe(false);
});
it('does not tag an actual work rejection or inherited foreign timeout', async () => {
  const foreign = new EngineError('OPERATION_TIMEOUT', 'native result', { retryable: false });
  const direct = await withConnectionBudget({ signal: new AbortController().signal, timeoutMs: 100 }, 'work', async () => { throw foreign; }).catch(error => error);
  expect(direct).toBe(foreign); expect(isLocalBudgetDeparture(direct)).toBe(false);
  const inherited = await withConnectionBudget({ signal: AbortSignal.abort(foreign), timeoutMs: 100 }, 'work', async () => undefined).catch(error => error);
  expect(inherited).toBe(foreign); expect(isLocalBudgetDeparture(inherited)).toBe(false);
});
it('tags a timer-created budget departure and aborts the original signal without new effects', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let inner: AbortSignal | undefined; let calls = 0;
  const caller = withConnectionBudget({ signal: new AbortController().signal, timeoutMs: 10 }, 'work', remaining => {
    calls++; inner = remaining().signal; return new Promise<never>(() => {});
  }).catch(error => error);
  await vi.advanceTimersByTimeAsync(10);
  const failure = await caller;
  expect(failure).toMatchObject({ code: 'OPERATION_TIMEOUT' }); expect(isLocalBudgetDeparture(failure)).toBe(true);
  expect(inner?.aborted).toBe(true); expect(calls).toBe(1);
});
