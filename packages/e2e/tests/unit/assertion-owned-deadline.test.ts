import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineError, type EngineErrorCode } from '../../src/engine/contract.ts';
import type { LocatorExpression, OperationContext, TargetSession } from '../../src/engine/surface.ts';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { E2EError, TestError } from '../../src/internal/errors.ts';
import { Deadline, sleep } from '../../src/internal/time.ts';
import { LocatorEngine } from '../../src/locator/engine.ts';
import { createScreen } from '../../src/locator/screen.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { StepRecorder } from '../../src/run/steps.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

function fixture(options: {
  firstMs?: number;
  noSample?: boolean;
  parentMs?: number;
  errorAfterMs?: number;
  code?: EngineErrorCode;
  failure?: Error;
} = {}) {
  const secret = 'unit-only-observed-value';
  const redact = (text: string): string => text.replaceAll(secret, '<secret:note>');
  const controller = new AbortController();
  const parent = new Deadline(options.parentMs ?? 10_000);
  const budget = new AttemptBudget(controller.signal, parent);
  const failure = options.failure ?? new EngineError(options.code ?? 'OPERATION_TIMEOUT', 'closed sample failure', { retryable: false });
  const locates: { atMs: number; timeoutMs: number }[] = [];
  const reads: number[] = [];
  const ref = { id: 'sample', revision: '1' };
  const session = {
    targetName: 'fixture',
    locate: async (_expression: LocatorExpression, operation: OperationContext) => {
      locates.push({ atMs: Date.now(), timeoutMs: operation.timeoutMs });
      if (locates.length === 1 && options.noSample !== true) {
        await sleep(options.firstMs ?? 265);
        return [ref];
      }
      await sleep(options.errorAfterMs ?? operation.timeoutMs);
      throw failure;
    },
    read: async (_ref: typeof ref, operation: OperationContext) => {
      reads.push(operation.timeoutMs);
      return { ref, text: secret, states: { secure: false } };
    },
  } as unknown as TargetSession;
  const steps = new StepRecorder('attempt', { redact });
  const engine = new LocatorEngine({
    session, budget, runId: 'run', attemptId: 'attempt',
    // An assertion owns its budget; the action default must not become its cap.
    actionTimeout: 1, assertionTimeout: 500, redact,
    recordEvent: (event) => steps.recordEvent(event),
  });
  const screen = createScreen({ engine, steps, secrets: { resolve: async () => '' }, renderTree: () => '' });
  return { engine, screen, steps, failure, locates, reads, budget, controller, parent, secret };
}

async function settle(promise: Promise<void>, advanceMs = 1_100): Promise<unknown> {
  const outcome = promise.then(() => undefined, (cause: unknown) => cause);
  await vi.advanceTimersByTimeAsync(advanceMs);
  return outcome;
}

describe('assertion-owned deadline failures', () => {
  it.each([99, 100, 135, 399])('formats the real prior sample when a final %i ms read reaches the owned deadline', async (remaining) => {
    const f = fixture({ firstMs: 400 - remaining });
    const error = await settle(expectFixture(f.screen.getByTestId('echo')).toHaveText('different'));
    expect(error).toMatchObject({ code: 'ASSERTION_FAILED', details: { observed: `text "${f.secret}"`, matches: 1 } });
    expect(f.locates).toEqual([{ atMs: 0, timeoutMs: 500 }, { atMs: 500 - remaining, timeoutMs: remaining }]);
    expect(f.reads).toHaveLength(1);
    const [step] = f.steps.all();
    expect(step?.durationMs).toBe(500);
    expect(step?.error).toMatchObject({ code: 'ASSERTION_FAILED', details: { observed: 'text "<secret:note>"', matches: 1 } });
    expect(step?.events).toEqual([expect.objectContaining({ kind: 'poll', count: 1, status: 'failed', detail: 'text "<secret:note>" (1 match)' })]);
    expect(JSON.stringify(f.steps.all())).not.toContain(f.secret);
  });

  it('does not format an early timeout before the assertion deadline', async () => {
    const f = fixture({ errorAfterMs: 5 });
    const error = await settle(expectFixture(f.screen.getByTestId('echo')).toHaveText('different'));
    expect(error).toMatchObject({ code: 'ACTION_FAILED', cause: f.failure });
    expect(f.steps.all()[0]?.durationMs).toBe(370);
    expect(f.steps.all()[0]?.error?.details).toBeUndefined();
  });

  it('does not invent an observed value when no sample completed', async () => {
    const f = fixture({ noSample: true });
    const error = await settle(expectFixture(f.screen.getByTestId('echo')).toHaveText('different'));
    expect(error).toMatchObject({ code: 'ACTION_FAILED', cause: f.failure });
    expect(f.reads).toEqual([]);
    expect(f.steps.all()[0]?.events).toEqual([expect.objectContaining({ kind: 'poll', count: 0 })]);
    expect(JSON.stringify(f.steps.all())).not.toContain('<secret:note>');
  });

  it.each(['ENGINE_FAILURE', 'CANCELLED', 'ACTION_MAY_HAVE_COMMITTED'] as const)('preserves %s at the owned deadline', async (code) => {
    const f = fixture({ code });
    const error = await settle(expectFixture(f.screen.getByTestId('echo')).toHaveText('different'));
    expect(error).toMatchObject({ cause: f.failure });
    expect(error).not.toMatchObject({ code: 'ASSERTION_FAILED' });
    expect(f.steps.all()[0]?.error?.details).toBeUndefined();
  });

  it.each([450, 500])('preserves a parent deadline of %i ms, including an equal boundary', async (parentMs) => {
    const f = fixture({ parentMs });
    const error = await settle(expectFixture(f.screen.getByTestId('echo')).toHaveText('different'));
    expect(error).toMatchObject({ code: 'ACTION_FAILED', cause: f.failure });
    expect(f.steps.all()[0]?.durationMs).toBe(parentMs);
  });

  it.each(['ENGINE_FAILURE', 'CANCELLED', 'POLICY_DENIED', 'infrastructure ACTION_FAILED'])('does not replace outer %s with its nested timeout cause', async (code) => {
    const nested = new EngineError('OPERATION_TIMEOUT', 'nested read deadline', { retryable: false });
    const failure = code === 'POLICY_DENIED'
      ? new TestError(code, 'outer refusal', { cause: nested })
      : new E2EError('infrastructure', code === 'infrastructure ACTION_FAILED' ? 'ACTION_FAILED' : code, 'outer failure', { cause: nested });
    const f = fixture({ failure });
    const error = await settle(expectFixture(f.screen.getByTestId('echo')).toHaveText('different'));
    expect(error).toBe(failure);
    expect(f.steps.all()[0]?.error?.details).toBeUndefined();
  });

  it('does not treat a retryable wrapper as the non-retryable timeout translation', async () => {
    const nested = new EngineError('OPERATION_TIMEOUT', 'nested read deadline', { retryable: false });
    const failure = new E2EError('test', 'ACTION_FAILED', 'different failure contract', { retryable: true, cause: nested });
    const f = fixture({ failure });
    const error = await settle(expectFixture(f.screen.getByTestId('echo')).toHaveText('different'));
    expect(error).toBe(failure);
  });

  it('does not borrow a later phase budget after a sample was issued', async () => {
    const f = fixture();
    const pending = expectFixture(f.screen.getByTestId('echo')).toHaveText('different');
    const outcome = pending.then(() => undefined, (cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(400);
    f.budget.enter(new AbortController().signal, 10_000);
    await vi.advanceTimersByTimeAsync(200);
    expect(await outcome).toMatchObject({ code: 'ACTION_FAILED', cause: f.failure });
    expect(f.locates).toHaveLength(2);
    expect(f.reads).toHaveLength(1);
  });

  it('keeps a parent abort selected while the final read is in flight', async () => {
    const f = fixture();
    const pending = expectFixture(f.screen.getByTestId('echo')).toHaveText('different');
    const outcome = pending.then(() => undefined, (cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(400);
    f.controller.abort();
    await vi.advanceTimersByTimeAsync(200);
    expect(await outcome).toMatchObject({ code: 'ACTION_FAILED', cause: f.failure });
    expect(f.steps.all()[0]?.events[0]?.status).toBe('cancelled');
  });

  it('preserves timeout delivery after the original parent deadline has also expired', async () => {
    const f = fixture({ parentMs: 600, errorAfterMs: 300 });
    const error = await settle(expectFixture(f.screen.getByTestId('echo')).toHaveText('different'));
    expect(error).toMatchObject({ code: 'ACTION_FAILED', cause: f.failure });
    expect(f.steps.all()[0]?.durationMs).toBe(665);
  });

  it('never turns a long unseen negation tail into a pass', async () => {
    const f = fixture();
    const error = await settle(expectFixture(f.screen.getByTestId('echo')).not.toHaveText('different'));
    expect(error).toMatchObject({ code: 'ASSERTION_FAILED' });
    expect(f.steps.all()[0]?.status).toBe('failed');
    expect(f.reads).toHaveLength(1);
  });

  it('preserves the existing short unseen negation tail without expanding it', async () => {
    const f = fixture({ firstMs: 350 });
    const error = await settle(expectFixture(f.screen.getByTestId('echo')).not.toHaveText('different'));
    expect(error).toBeUndefined();
    expect(f.steps.all()[0]?.status).toBe('passed');
    expect(f.locates.at(-1)?.timeoutMs).toBe(50);
    expect(f.reads).toHaveLength(1);
  });

  it('binds the original phase objects rather than merely equal deadline values', async () => {
    const f = fixture();
    const captured = f.engine.assertionBudget(500);
    f.budget.enter(f.controller.signal, 10_000);
    expect(f.budget.deadline.endsAt).toBe(f.parent.endsAt);
    expect(f.budget.deadline).not.toBe(f.parent);
    await vi.advanceTimersByTimeAsync(500);
    expect(captured.ownsExpiredDeadline()).toBe(false);
  });
});
