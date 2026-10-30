/** The browser matcher over the real runner-owned, in-memory attribute seam. */
import { describe, expect, it, vi } from 'vitest';
import { EngineError, type EngineFixtureContext } from 'e2e/engine';
import { expect as expectFixture } from '../../../e2e/src/expect/index.ts';
import { sleep } from '../../../e2e/src/internal/time.ts';
import { useFakeTime } from '../../../e2e/tests/helpers/fake-time.ts';
import { fields, samplingFixture } from '../../../e2e/tests/helpers/fixture-attribute-sampling.ts';
import { createBrowserFixture } from '../../src/browser.ts';
import type { NativeWebSurface } from '../../src/native/browser-contract.ts';
import { ErrorLatch } from '../../src/runtime-support.ts';

useFakeTime();
function browser(context: EngineFixtureContext) {
  const command = vi.fn(async () => { throw new Error('no browser protocol command is permitted in this pure control'); });
  const surface = { routeRegistryVersion: () => 0, subscribe: () => () => {}, latch: new ErrorLatch(), command } as unknown as NativeWebSurface;
  return { browser: createBrowserFixture(surface, context), command };
}

describe('deadline-owned class samples', () => {
  it('keeps the original 300ms mismatch and observed raw-class diagnostic with no count/getter work', async () => {
    const f = samplingFixture(() => [fields()]); const b = browser(f.context); const start = Date.now();
    await expect(expectFixture(b.browser).toHaveClass(f.target, 'card inactive', { timeout: 300 })).rejects.toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('class "card active"') });
    expect(Date.now() - start).toBe(300);
    expect(f.readFields.mock.calls.map(call => call[2].timeoutMs)).toEqual([300, 200, 100]);
    expect(f.locate).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(b.command).not.toHaveBeenCalled();
  });
  it('preserves class-list whitespace normalization, exact and regex predicates', async () => {
    const f = samplingFixture(() => [fields({ class: ' card   active\n ' })]); const b = browser(f.context);
    await expectFixture(b.browser).toHaveClass(f.target, 'card active', { timeout: 300 });
    await expectFixture(b.browser).toHaveClass(f.target, /^card active$/, { timeout: 300 });
    expect(f.readFields).toHaveBeenCalledTimes(2); expect(f.locate).not.toHaveBeenCalled();
  });
  it('keeps an empty class distinct from a missing class attribute', async () => {
    const empty = samplingFixture(() => [fields({ class: '' })]);
    await expectFixture(browser(empty.context).browser).toHaveClass(empty.target, '', { timeout: 300 });
    const absent = samplingFixture(() => [fields({})]);
    await expect(expectFixture(browser(absent.context).browser).toHaveClass(absent.target, '', { timeout: 300 })).rejects.toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('observed: no class attribute') });
  });
  it.each([false, true])('keeps absence unevaluable for either sign (negated=%s)', async negated => {
    const f = samplingFixture(() => []); const b = browser(f.context); const start = Date.now();
    const assertion = negated ? expectFixture(b.browser).not : expectFixture(b.browser);
    await expect(assertion.toHaveClass(f.target, 'card', { timeout: 300 })).rejects.toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('observed: no node') });
    expect(Date.now() - start).toBe(300);
  });
  it.each([false, true])('keeps missing frames unevaluable (negated=%s)', async negated => {
    const f = samplingFixture(() => { throw new EngineError('FRAME_NOT_FOUND', 'absent', { retryable: true }); }); const b = browser(f.context);
    const assertion = negated ? expectFixture(b.browser).not : expectFixture(b.browser);
    await expect(assertion.toHaveClass(f.target, 'card', { timeout: 300 })).rejects.toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('observed: no node') });
    expect(f.locate).not.toHaveBeenCalled();
  });
  it('polls absence to arrival within the same original budget', async () => {
    let count = 0; const f = samplingFixture(() => ++count < 3 ? [] : [fields()]);
    await expectFixture(browser(f.context).browser).toHaveClass(f.target, 'card active', { timeout: 300 });
    expect(f.readFields.mock.calls.map(call => call[2].timeoutMs)).toEqual([300, 200, 100]);
  });
  it('does not suppress strict ambiguity', async () => {
    const f = samplingFixture(() => [fields(), fields()]);
    await expect(expectFixture(browser(f.context).browser).toHaveClass(f.target, 'card active', { timeout: 300 })).rejects.toMatchObject({ code: 'LOCATOR_AMBIGUOUS' });
    expect(f.readFields).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('denies secure attribute reads before judging either sign (negated=%s)', async negated => {
    const f = samplingFixture(() => [{ attributes: { class: 'synthetic' }, states: { secure: true } }]); const b = browser(f.context);
    const assertion = negated ? expectFixture(b.browser).not : expectFixture(b.browser);
    await expect(assertion.toHaveClass(f.target, 'card', { timeout: 300 })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(f.readFields).toHaveBeenCalledTimes(1);
  });
  it('uses the existing final 60ms ordinary-timeout cutoff and preserves the last observed class', async () => {
    let count = 0; const f = samplingFixture(async operation => {
      if (++count === 1) await sleep(40);
      if (count < 3) return [fields()];
      await sleep(operation.timeoutMs); throw new EngineError('OPERATION_TIMEOUT', 'settled deadline', { retryable: false });
    });
    await expect(expectFixture(browser(f.context).browser).toHaveClass(f.target, 'card inactive', { timeout: 300 })).rejects.toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('class "card active"') });
    expect(f.readFields.mock.calls.map(call => call[2].timeoutMs)).toEqual([300, 160, 60]);
  });
  it('keeps Unknown at the same final cutoff as failure, never a diagnostic rewrite or retry', async () => {
    const failure = new EngineError('ACTION_MAY_HAVE_COMMITTED', 'unknown', { retryable: false });
    let count = 0; const f = samplingFixture(async operation => {
      if (++count === 1) await sleep(40);
      if (count < 3) return [fields()];
      await sleep(operation.timeoutMs); throw failure;
    });
    await expect(expectFixture(browser(f.context).browser).toHaveClass(f.target, 'card inactive', { timeout: 300 })).rejects.toMatchObject({ code: 'ACTION_FAILED', cause: failure });
    expect(f.readFields.mock.calls.map(call => call[2].timeoutMs)).toEqual([300, 160, 60]); expect(f.locate).not.toHaveBeenCalled();
  });
  it('does not invent a last observation if the first sample times out and leaves no outstanding read', async () => {
    let pending = 0;
    const f = samplingFixture(async operation => { pending++; try { await sleep(operation.timeoutMs); throw new EngineError('OPERATION_TIMEOUT', 'settled deadline', { retryable: false }); } finally { pending--; } });
    const start = Date.now();
    await expect(expectFixture(browser(f.context).browser).toHaveClass(f.target, 'card active', { timeout: 300 })).rejects.toMatchObject({ code: 'ACTION_FAILED', cause: expect.objectContaining({ code: 'OPERATION_TIMEOUT' }) });
    expect(Date.now() - start).toBe(300); expect(pending).toBe(0);
    expect(f.readFields.mock.calls.map(call => call[2].timeoutMs)).toEqual([300]); expect(f.locate).not.toHaveBeenCalled();
  });
  it('cannot pass on a successful value returned after the issuing deadline', async () => {
    const f = samplingFixture(async () => { await sleep(301); return [fields()]; });
    await expect(expectFixture(browser(f.context).browser).toHaveClass(f.target, 'card active', { timeout: 300 })).rejects.toMatchObject({ code: 'ACTION_FAILED', cause: expect.objectContaining({ code: 'OPERATION_TIMEOUT' }) });
    expect(f.readFields).toHaveBeenCalledTimes(1);
  });
  it('propagates public cancellation to the owned read without dispatching a later getter', async () => {
    let settled!: () => void; const settlement = new Promise<void>(resolve => { settled = resolve; });
    let joined = false; const f = samplingFixture(operation => new Promise((_resolve, reject) => {
      operation.signal.addEventListener('abort', () => { void sleep(10).then(() => { joined = true; reject(new EngineError('CANCELLED', 'settled', { retryable: false })); settled(); }); }, { once: true });
    }));
    setTimeout(() => f.controller.abort(), 40);
    await expect(expectFixture(browser(f.context).browser).toHaveClass(f.target, 'card active', { timeout: 300 })).rejects.toMatchObject({ code: 'CANCELLED' });
    // FixtureRecorder still races phase abort for the public step. The core
    // sampler owns this one cancelled read until its adapter settles it.
    await settlement;
    expect(joined).toBe(true); expect(f.readFields).toHaveBeenCalledTimes(1); expect(f.locate).not.toHaveBeenCalled();
  });
  it('uses the legacy path only for an older context that lacks the optional capability', async () => {
    const f = samplingFixture(() => [fields()]); const { sampleAttribute: _omitted, ...legacy } = f.context;
    await expectFixture(browser(legacy).browser).toHaveClass(f.target, 'card active', { timeout: 300 });
    expect(f.locate).toHaveBeenCalledTimes(1); expect(f.readFields).toHaveBeenCalledTimes(1);
    expect(f.readFields.mock.calls[0]![2].timeoutMs).toBe(5000);
  });
  it.each(['ACTION_MAY_HAVE_COMMITTED', 'CANCELLED'] as const)('never falls back from a declared sampler refusal: %s', async code => {
    const failure = new EngineError(code, 'refused', { retryable: false }); const f = samplingFixture(() => [fields()]);
    const context = { ...f.context, sampleAttribute: async () => { throw failure; } };
    await expect(expectFixture(browser(context).browser).toHaveClass(f.target, 'card active', { timeout: 300 })).rejects.toMatchObject({ code: code === 'CANCELLED' ? 'CANCELLED' : 'ACTION_FAILED', cause: failure });
    expect(f.locate).not.toHaveBeenCalled(); expect(f.readFields).not.toHaveBeenCalled();
  });
  it('never retries a foreign locator through the legacy path', async () => {
    const f = samplingFixture(() => [fields()]); const foreign = samplingFixture(() => [fields()]);
    await expect(expectFixture(browser(f.context).browser).toHaveClass(foreign.target, 'card active', { timeout: 300 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(f.locate).not.toHaveBeenCalled(); expect(foreign.locate).not.toHaveBeenCalled(); expect(foreign.readFields).not.toHaveBeenCalled();
  });
});


describe('closed class sample diagnostics', () => {
  it.each([false, true])('records prior completed sample without changing the thrown timeout (prior=%s)', async prior => {
    const previous = process.env['E2E_CLASS_SAMPLE_DIAGNOSTIC'];
    process.env['E2E_CLASS_SAMPLE_DIAGNOSTIC'] = 'web-platform-class300';
    const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      let calls = 0;
      const f = samplingFixture(async operation => {
        if (prior && ++calls === 1) return [fields()];
        await sleep(operation.timeoutMs);
        throw new EngineError('OPERATION_TIMEOUT', 'settled deadline', { retryable: false });
      });
      // Diagnostic must preserve current behavior; this is not an assertion fix.
      await expect(expectFixture(browser(f.context).browser).toHaveClass(f.target, 'card inactive', { timeout: 300 }))
        .rejects.toMatchObject({ code: 'ACTION_FAILED', cause: expect.objectContaining({ code: 'OPERATION_TIMEOUT' }) });
      const rows = output.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('CLASS_SAMPLE_DIAGNOSTIC '));
      expect(rows).toHaveLength(1);
      const row = JSON.parse(rows[0]!.slice('CLASS_SAMPLE_DIAGNOSTIC '.length));
      expect(row).toMatchObject({ schemaVersion: 1, fixture: 'web-platform-class300', api: 'toHaveClass', outcome: 'threw', overflow: false, sampleCount: prior ? 2 : 1 });
      expect(row.samples.at(-1)).toMatchObject({ priorSample: prior, priorMismatch: prior, startRemainingMs: prior ? 200 : 300, endRemainingMs: 0, outcome: 'threw' });
      expect(rows[0]).not.toContain('card');
      expect(f.readFields).toHaveBeenCalledTimes(prior ? 2 : 1);
      expect(f.locate).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
      if (previous === undefined) delete process.env['E2E_CLASS_SAMPLE_DIAGNOSTIC'];
      else process.env['E2E_CLASS_SAMPLE_DIAGNOSTIC'] = previous;
    }
  });
});
