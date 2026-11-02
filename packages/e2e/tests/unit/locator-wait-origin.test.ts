import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocatorExpression, NodeRef, TargetSession } from '../../src/engine/surface.ts';
import { EngineError } from '../../src/engine/contract.ts';
import { LocatorEngine } from '../../src/locator/engine.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';

const expression: LocatorExpression = { kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'missing', exact: true } } };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(1_000); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function missingAt(end: number, phase: Deadline = new Deadline(10_000)) {
  const locate = vi.fn(async (): Promise<readonly NodeRef[]> => { vi.setSystemTime(end); return []; });
  const perform = vi.fn();
  const session = { actions: new Set(['tap']), locate, perform } as unknown as TargetSession;
  const engine = new LocatorEngine({ session, budget: new AttemptBudget(new AbortController().signal, phase), runId: 'run', attemptId: 'attempt', actionTimeout: 300, assertionTimeout: 300 });
  return { engine, locate, perform };
}
function crossClockTickAfterDeadline(engine: LocatorEngine) {
  const original = engine.deadline.bind(engine);
  return vi.spyOn(engine, 'deadline').mockImplementation(timeout => {
    const deadline = original(timeout);
    vi.setSystemTime(Date.now() + 1);
    return deadline;
  });
}

describe('locator action wait-report origin', () => {
  it('reports the same admission interval that issued its deadline, even across a clock tick', async () => {
    const { engine, locate, perform } = missingAt(1_300);
    const deadline = crossClockTickAfterDeadline(engine);
    await expect(engine.perform(expression, { kind: 'tap' })).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND', details: { waitedMs: 300 } });
    expect(deadline).toHaveBeenCalledTimes(1);
    expect(locate).toHaveBeenCalledTimes(1);
    expect(locate.mock.calls[0]).toEqual([expression, expect.objectContaining({ timeoutMs: 299 }), { purpose: 'protected' }]);
    expect(perform).not.toHaveBeenCalled();
    expect(Date.now()).toBe(1_300);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports only the shorter phase budget, not a fabricated full action timeout', async () => {
    const { engine, locate } = missingAt(1_120, new Deadline(120));
    crossClockTickAfterDeadline(engine);
    await expect(engine.perform(expression, { kind: 'tap' })).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND', details: { waitedMs: 120 } });
    expect(locate.mock.calls[0]).toEqual([expression, expect.objectContaining({ timeoutMs: 119 }), { purpose: 'protected' }]);
    expect(Date.now()).toBe(1_120);
  });

  it('does not count an earlier stale action in a later lookup wait', async () => {
    const { engine, locate, perform } = missingAt(1_300);
    locate.mockImplementationOnce(async () => [{ id: 'first', revision: 'one' }]);
    perform.mockImplementationOnce(() => {
      vi.setSystemTime(1_100);
      throw new EngineError('NODE_STALE', 'stale', { retryable: true });
    });
    crossClockTickAfterDeadline(engine);
    await expect(engine.perform(expression, { kind: 'tap' })).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND', details: { waitedMs: 200 } });
    expect(locate).toHaveBeenCalledTimes(2);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(locate.mock.calls[1]).toEqual([expression, expect.objectContaining({ timeoutMs: 200 }), { purpose: 'protected' }]);
  });

  it('does not count prior unrelated work when given a shared older deadline', async () => {
    const shared = new Deadline(300);
    vi.setSystemTime(1_200);
    const { engine, locate } = missingAt(1_300);
    await expect(engine.performUntil(expression, { kind: 'tap' }, shared)).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND', details: { waitedMs: 100 } });
    expect(locate.mock.calls[0]).toEqual([expression, expect.objectContaining({ timeoutMs: 100 }), { purpose: 'protected' }]);
  });
});
