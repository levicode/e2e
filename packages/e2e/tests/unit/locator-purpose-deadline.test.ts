import { describe, expect, it } from 'vitest';
import type { EngineLocateOptions, LocatorExpression, OperationContext, TargetSession } from '../../src/engine/surface.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { EngineError } from '../../src/engine/contract.ts';
import { Deadline } from '../../src/internal/time.ts';
import { LocatorEngine } from '../../src/locator/engine.ts';
import { useFakeTime } from '../helpers/fake-time.ts';

useFakeTime();

const expression: LocatorExpression = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } };

function fixture(missingFrame: boolean) {
  const calls: { timeoutMs: number; purpose: EngineLocateOptions['purpose'] | undefined }[] = [];
  const session = {
    locate(_expression: LocatorExpression, operation: OperationContext, options?: EngineLocateOptions) {
      calls.push({ timeoutMs: operation.timeoutMs, purpose: options?.purpose });
      if (missingFrame) throw new EngineError('FRAME_NOT_FOUND', 'missing fixture frame', { retryable: true });
      return Promise.resolve([]);
    },
  } as unknown as TargetSession;
  const engine = new LocatorEngine({
    session,
    budget: new AttemptBudget(new AbortController().signal, new Deadline(30_000)),
    runId: 'run',
    attemptId: 'attempt',
    actionTimeout: 1_000,
    assertionTimeout: 1_000,
    readPurpose: 'fixture',
  });
  return { engine, calls };
}

describe('upstream whole-set deadlines with native purpose separation', () => {
  it('keeps the caller deadline without changing the fixture purpose', async () => {
    const { engine, calls } = fixture(true);
    expect(await engine.resolveNow(expression, new Deadline(120))).toEqual([]);
    expect(calls).toEqual([{ timeoutMs: 120, purpose: 'fixture' }]);
  });

  it('keeps the protected MCP override while using the default action deadline', async () => {
    const { engine, calls } = fixture(false);
    expect(await engine.resolveNow(expression, undefined, { purpose: 'protected' })).toEqual([]);
    expect(calls).toEqual([{ timeoutMs: 1_000, purpose: 'protected' }]);
  });

  it('combines an explicit deadline and protected purpose without widening either', async () => {
    const { engine, calls } = fixture(true);
    expect(await engine.resolveNow(expression, new Deadline(80), { purpose: 'protected' })).toEqual([]);
    expect(calls).toEqual([{ timeoutMs: 80, purpose: 'protected' }]);
  });
});

