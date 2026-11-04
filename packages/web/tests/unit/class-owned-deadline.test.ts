/** Browser class ownership uses the real runner context and existing core proof. */
import { describe, expect, it, vi } from 'vitest';
import { EngineError, TestError, type EngineFixtureContext } from 'e2e/engine';
import { expect as expectFixture } from 'e2e';
import { sleep } from '../../../e2e/dist/internal/time.js';
import { useFakeTime } from '../helpers/class-sampling.ts';
import { fields, samplingFixture } from '../helpers/class-sampling.ts';
import { createBrowserFixture } from '../../src/browser.ts';
import type { NativeWebSurface } from '../../src/native/browser-contract.ts';
import { ErrorLatch } from '../../src/runtime-support.ts';

useFakeTime();
function browser(context: EngineFixtureContext) {
  const command = vi.fn(async () => { throw new Error('no browser protocol command is permitted in this pure control'); });
  const surface = { routeRegistryVersion: () => 0, subscribe: () => () => {}, latch: new ErrorLatch(), command } as unknown as NativeWebSurface;
  return createBrowserFixture(surface, context);
}
function fixture(options: { firstMs?: number; noSample?: boolean; parentMs?: number; extraMs?: number; earlyMs?: number; failure?: Error; onFinal?: () => void } = {}) {
  let count = 0;
  const failure = options.failure ?? new EngineError('OPERATION_TIMEOUT', 'settled deadline', { retryable: false });
  const f = samplingFixture(async operation => {
    if (++count === 1 && !options.noSample) { await sleep(options.firstMs ?? 100); return [fields()]; }
    options.onFinal?.();
    await sleep(options.earlyMs ?? operation.timeoutMs + (options.extraMs ?? 0));
    throw failure;
  }, { budgetMs: options.parentMs ?? 10_000 });
  return { ...f, failure };
}
const assertion = (f: ReturnType<typeof fixture>, context = f.context) => expectFixture(browser(context)).toHaveClass(f.target, 'card inactive', { timeout: 300 });

describe('browser class assertion-owned deadline', () => {
  it.each([99, 100, 135, 200])('retains an actual mismatch when the final read starts with %i ms', async remaining => {
    const f = fixture({ firstMs: 200 - remaining, extraMs: 3 }); const start = Date.now();
    await expect(assertion(f)).rejects.toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('class "card active"') });
    expect(Date.now() - start).toBe(303);
    expect(f.readFields.mock.calls.map(call => call[2].timeoutMs)).toEqual([300, remaining]);
    expect(f.readFields.mock.calls.every(call => call[2].signal === f.controller.signal)).toBe(true);
    expect(f.locate).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it('does not invent a prior mismatch when the first read times out', async () => {
    const f = fixture({ noSample: true });
    await expect(assertion(f)).rejects.toMatchObject({ code: 'ACTION_FAILED', cause: f.failure });
    expect(f.readFields).toHaveBeenCalledTimes(1);
  });
  it('does not rewrite an early read timeout before its own deadline', async () => {
    const f = fixture({ earlyMs: 5 });
    await expect(assertion(f)).rejects.toMatchObject({ code: 'ACTION_FAILED', cause: f.failure });
    expect(f.readFields.mock.calls.map(call => call[2].timeoutMs)).toEqual([300, 100]);
  });
  it.each([250, 300])('preserves an earlier or equal parent deadline of %i ms', async parentMs => {
    const f = fixture({ parentMs });
    await expect(assertion(f)).rejects.toMatchObject({ code: 'ACTION_FAILED', cause: f.failure });
    expect(f.readFields.mock.calls.map(call => call[2].timeoutMs)).toEqual([parentMs, parentMs - 200]);
  });
  it('preserves failure once the original parent also expired during settlement', async () => {
    const f = fixture({ parentMs: 350, extraMs: 60 });
    await expect(assertion(f)).rejects.toMatchObject({ code: 'ACTION_FAILED', cause: f.failure });
    expect(f.readFields).toHaveBeenCalledTimes(2);
  });
  it('does not borrow a replacement phase for a pending old-phase timeout', async () => {
    const f = fixture({ onFinal: () => { f.budget.enter(new AbortController().signal, 10_000); } });
    await expect(assertion(f)).rejects.toMatchObject({ code: 'ACTION_FAILED', cause: f.failure });
    expect(f.readFields).toHaveBeenCalledTimes(2);
    expect(f.readFields.mock.calls[1]![2].signal).toBe(f.controller.signal);
  });
  it('keeps parent cancellation selected after a prior mismatch', async () => {
    const f = fixture({ onFinal: () => { f.controller.abort(); } });
    await expect(assertion(f)).rejects.toMatchObject({ code: 'CANCELLED' });
    await sleep(100); // Join the already-issued in-memory read; do not issue another.
    expect(f.readFields).toHaveBeenCalledTimes(2);
  });
  it.each(['ACTION_MAY_HAVE_COMMITTED', 'CANCELLED', 'ENGINE_FAILURE'] as const)('preserves %s rather than converting it to a mismatch', async code => {
    const failure = new EngineError(code, 'closed refusal', { retryable: false });
    const f = fixture({ failure });
    await expect(assertion(f)).rejects.toMatchObject({ code: code === 'ACTION_MAY_HAVE_COMMITTED' ? 'ACTION_FAILED' : code, cause: failure });
    expect(f.readFields).toHaveBeenCalledTimes(2);
  });
  it('preserves an outer policy refusal with a nested timeout', async () => {
    const failure = new TestError('POLICY_DENIED', 'outer refusal', { cause: new EngineError('OPERATION_TIMEOUT', 'nested', { retryable: false }) });
    const f = fixture({ failure });
    await expect(assertion(f)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
  it('does not turn an unseen 100ms negation tail into a pass', async () => {
    const f = fixture();
    await expect(expectFixture(browser(f.context)).not.toHaveClass(f.target, 'card inactive', { timeout: 300 })).rejects.toMatchObject({ code: 'ASSERTION_FAILED' });
    expect(f.readFields).toHaveBeenCalledTimes(2);
  });
  it('retains the existing short-tail negation grace without another read', async () => {
    const f = fixture({ firstMs: 150 });
    await expectFixture(browser(f.context)).not.toHaveClass(f.target, 'card inactive', { timeout: 300 });
    expect(f.readFields.mock.calls.map(call => call[2].timeoutMs)).toEqual([300, 50]);
  });
  it('retains the older context fallback without claiming ownership', async () => {
    const f = fixture(); const { assertionBudget: _omitted, ...legacy } = f.context;
    await expect(assertion(f, legacy)).rejects.toMatchObject({ code: 'ACTION_FAILED', cause: f.failure });
    expect(f.readFields).toHaveBeenCalledTimes(2);
  });
  it('does not consult the new proof for a legacy getter without the sampler', async () => {
    const f = fixture(); const { sampleAttribute: _omitted, ...legacy } = f.context;
    const budget = vi.fn(() => { throw new Error('must not claim a legacy getter'); });
    await expectFixture(browser({ ...legacy, assertionBudget: budget })).toHaveClass(f.target, 'card active', { timeout: 300 });
    expect(budget).not.toHaveBeenCalled(); expect(f.locate).toHaveBeenCalledTimes(1);
  });
});
