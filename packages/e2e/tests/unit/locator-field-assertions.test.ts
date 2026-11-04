import { describe, expect, it } from 'vitest';
import { EngineError } from '../../src/engine/contract.ts';
import type { EngineReadField, LocatorExpression, OperationContext, SemanticNode, TargetSession } from '../../src/engine/surface.ts';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { Deadline } from '../../src/internal/time.ts';
import { LocatorEngine } from '../../src/locator/engine.ts';
import { createScreen } from '../../src/locator/screen.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { useFakeTime } from '../helpers/fake-time.ts';

useFakeTime();
const expression: LocatorExpression = { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'nickname', exact: true } } };
type Fields = Pick<SemanticNode, EngineReadField>;
function fixture(values: () => readonly Fields[], options: { capability?: boolean; protected?: boolean } = {}) {
  const calls: { fields: readonly EngineReadField[]; timeoutMs: number }[] = [];
  let located = 0;
  let read = 0;
  const ref = { id: 'stable', revision: '1' };
  const session = {
    targetName: 'fixture',
    locate: async () => { located++; return values().map(() => ref); },
    read: async () => { read++; return { ref, states: { hidden: false } }; },
    ...(options.capability === false ? {} : { readFields: async (_: LocatorExpression, fields: readonly EngineReadField[], operation: OperationContext) => {
      calls.push({ fields, timeoutMs: operation.timeoutMs });
      return values();
    } }),
  } as unknown as TargetSession;
  const engine = new LocatorEngine({ session, readPurpose: options.protected ? 'protected' : 'fixture',
    budget: new AttemptBudget(new AbortController().signal, new Deadline(10_000)),
    runId: 'run', attemptId: 'attempt', actionTimeout: 5_000, assertionTimeout: 1_000 });
  const screen = createScreen({ engine, steps: new StepRecorder('attempt'), secrets: { resolve: async () => '' }, renderTree: () => '' });
  return { engine, screen, calls, refCalls: () => ({ located, read }) };
}

describe('reference-free fixture assertion samples', () => {
  it('uses field samples for visibility and count under the assertion deadline, not action timeout', async () => {
    const f = fixture(() => [{ states: { hidden: false, secure: false } }]);
    await expectFixture(f.screen.getByTestId('nickname')).toBeVisible({ timeout: 120 });
    await expectFixture(f.screen.getByTestId('nickname')).toHaveCount(1, { timeout: 80 });
    expect(f.calls).toEqual([{ fields: ['states'], timeoutMs: 120 }, { fields: ['testId'], timeoutMs: 80 }]);
    expect(f.refCalls()).toEqual({ located: 0, read: 0 });
  });

  it('never changes a stale sample into hidden or absent', async () => {
    let rounds = 0;
    const f = fixture(() => {
      if (++rounds === 1) throw new EngineError('NODE_STALE', 'retired native root', { retryable: true });
      return [{ states: { hidden: false, secure: false } }];
    });
    await expect(expectFixture(f.screen.getByTestId('nickname')).toBeHidden({ timeout: 150 })).rejects.toMatchObject({ code: 'ASSERTION_FAILED' });
    expect(rounds).toBeGreaterThan(1);
    expect(f.refCalls()).toEqual({ located: 0, read: 0 });
  });

  it('keeps ambiguity, genuine zero matches and secure visibility', async () => {
    const multiple = fixture(() => [{ states: {} }, { states: {} }]);
    await expect(multiple.engine.tryReadFields(expression, ['states'], new Deadline(100), 'empty')).rejects.toMatchObject({ code: 'LOCATOR_AMBIGUOUS' });
    await expectFixture(multiple.screen.getByTestId('nickname')).toHaveCount(2);
    const empty = fixture(() => []);
    await expectFixture(empty.screen.getByTestId('nickname')).toBeHidden();
    await expectFixture(empty.screen.getByTestId('nickname')).toHaveCount(0);
    const secure = fixture(() => [{ states: { hidden: false, secure: true } }]);
    await expectFixture(secure.screen.getByTestId('nickname')).toBeVisible();
    await expectFixture(secure.screen.getByTestId('nickname')).toHaveCount(1);
    expect(secure.calls.at(-1)?.fields).toEqual(['testId']);
    expect(secure.refCalls()).toEqual({ located: 0, read: 0 });
  });

  it('keeps missing-frame-as-empty only for the caller that permits it', async () => {
    const f = fixture(() => { throw new EngineError('FRAME_NOT_FOUND', 'missing frame', { retryable: true }); });
    expect(await f.engine.tryReadFields(expression, ['states'], new Deadline(100), 'empty')).toEqual({ node: null, count: 0 });
    await expectFixture(f.screen.getByTestId('nickname')).toHaveCount(0, { timeout: 100 });
  });

  it.each([{ capability: false }, { protected: true }])('preserves the existing engine path without fixture field authority: %j', async options => {
    const f = fixture(() => [{ states: { hidden: false } }], options);
    await expectFixture(f.screen.getByTestId('nickname')).toBeVisible();
    await expectFixture(f.screen.getByTestId('nickname')).toHaveCount(1);
    expect(f.calls).toEqual([]);
    expect(f.refCalls()).toEqual({ located: 2, read: 1 });
  });
});
