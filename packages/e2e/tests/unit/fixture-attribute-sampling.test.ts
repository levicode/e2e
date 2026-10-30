import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { EngineError, type EngineFieldValues } from '../../src/engine/index.ts';
import { Deadline, sleep } from '../../src/internal/time.ts';
import { LocatorEngine } from '../../src/locator/engine.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { useFakeTime } from '../helpers/fake-time.ts';
import { expression, fields, samplingFixture } from '../helpers/fixture-attribute-sampling.ts';

useFakeTime();
describe('owner-bound attribute samples', () => {
  it('uses exactly one decoded attributes projection, not a count followed by a getter', async () => {
    const f = samplingFixture(() => [fields()]);
    await expect(f.context.sampleAttribute!(f.target, 'class', new Deadline(300))).resolves.toBe('card active');
    expect(f.readFields).toHaveBeenCalledExactlyOnceWith(expression, ['attributes'], expect.objectContaining({ signal: f.controller.signal, timeoutMs: 300 }), { purpose: 'fixture' });
    expect(f.locate).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled();
  });
  it('distinguishes no node, missing attribute, empty string and own prototype keys', async () => {
    for (const [values, name, wanted] of [
      [[], 'class', undefined], [[fields({})], 'class', null], [[fields({ class: '' })], 'class', ''],
      [[fields({})], 'constructor', null], [[fields({ ['__proto__']: 'own' })], '__proto__', 'own'],
    ] as const) {
      const f = samplingFixture(() => values);
      await expect(f.context.sampleAttribute!(f.target, name, new Deadline(300))).resolves.toBe(wanted);
    }
  });
  it('treats a retryable missing frame as an unevaluable sample, not a missing attribute', async () => {
    const f = samplingFixture(() => { throw new EngineError('FRAME_NOT_FOUND', 'frame absent', { retryable: true }); });
    await expect(f.context.sampleAttribute!(f.target, 'class', new Deadline(300))).resolves.toBeUndefined();
    expect(f.readFields).toHaveBeenCalledTimes(1);
  });
  it('preserves strict cardinality before reading an attribute', async () => {
    const f = samplingFixture(() => [fields(), fields()]);
    await expect(f.context.sampleAttribute!(f.target, 'class', new Deadline(300))).rejects.toMatchObject({ code: 'LOCATOR_AMBIGUOUS' });
    expect(f.readFields).toHaveBeenCalledTimes(1);
  });
  it('rejects every secure attribute before exposing a value', async () => {
    const f = samplingFixture(() => [{ attributes: { class: 'synthetic' }, states: { secure: true } }]);
    await expect(f.context.sampleAttribute!(f.target, 'class', new Deadline(300))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
  it.each([
    { attributes: { class: 'unmarked' } },
    { attributes: { value: 'synthetic' }, states: { secure: true } },
    { attributes: {}, states: { secure: false }, ref: { id: 'forged', revision: '1' } },
  ])('does not bypass field projection validation %#', async value => {
    const f = samplingFixture(() => [value as EngineFieldValues]);
    await expect(f.context.sampleAttribute!(f.target, 'class', new Deadline(300))).rejects.toMatchObject({ code: 'APP_NOT_OPEN', cause: expect.objectContaining({ code: 'INVALID_STATE' }) });
    expect(f.locate).not.toHaveBeenCalled();
  });
  it('rejects a foreign locator despite identical target, run and attempt names', () => {
    const one = samplingFixture(() => [fields()]); const two = samplingFixture(() => [fields()]);
    expect(() => one.context.sampleAttribute!(two.target, 'class', new Deadline(300))).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(one.readFields).not.toHaveBeenCalled(); expect(two.readFields).not.toHaveBeenCalled();
  });
  it('rejects a fake locator without falling back to its methods', () => {
    const f = samplingFixture(() => [fields()]);
    expect(() => f.context.sampleAttribute!({ count: () => { throw new Error('must not call'); } } as never, 'class', new Deadline(300))).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(f.readFields).not.toHaveBeenCalled();
  });
  it('accepts the existing cross-realm symbol contract without instanceof or locator methods', async () => {
    const f = samplingFixture(() => [fields()]);
    const otherRealm = runInNewContext('Object.create(null, Object.getOwnPropertyDescriptors(target))', { target: f.target });
    expect(Object.getPrototypeOf(otherRealm)).toBeNull();
    await expect(f.context.sampleAttribute!(otherRealm, 'class', new Deadline(300))).resolves.toBe('card active');
  });
  it('caps by the phase deadline and never starts after the assertion deadline', async () => {
    const f = samplingFixture(() => [fields()], { budgetMs: 120 });
    await f.context.sampleAttribute!(f.target, 'class', new Deadline(300));
    expect(f.readFields.mock.calls[0]![2].timeoutMs).toBe(120);
    await expect(f.context.sampleAttribute!(f.target, 'class', new Deadline(0))).rejects.toMatchObject({ code: 'ACTION_FAILED', cause: expect.objectContaining({ code: 'OPERATION_TIMEOUT' }) });
    expect(f.readFields).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch from an already cancelled phase', async () => {
    const f = samplingFixture(() => [fields()]); f.controller.abort();
    await expect(f.context.sampleAttribute!(f.target, 'class', new Deadline(300))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.readFields).not.toHaveBeenCalled();
  });
  it('passes cancellation to the read and waits for its settlement rather than abandoning it', async () => {
    let joined = false;
    const f = samplingFixture(operation => new Promise((_resolve, reject) => {
      operation.signal.addEventListener('abort', () => { void sleep(10).then(() => { joined = true; reject(new EngineError('CANCELLED', 'settled cancellation', { retryable: false })); }); }, { once: true });
    }));
    setTimeout(() => f.controller.abort(), 40); const start = Date.now();
    await expect(f.context.sampleAttribute!(f.target, 'class', new Deadline(300))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(joined).toBe(true); expect(Date.now() - start).toBe(50); expect(f.readFields).toHaveBeenCalledTimes(1);
  });
  it('cannot publish success from an adapter that ignored phase cancellation', async () => {
    const f = samplingFixture(() => { f.controller.abort(); return [fields()]; });
    await expect(f.context.sampleAttribute!(f.target, 'class', new Deadline(300))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.readFields).toHaveBeenCalledTimes(1);
  });
  it('cannot publish old-phase success through a fresh teardown phase', async () => {
    let finish!: (value: readonly EngineFieldValues[]) => void;
    const f = samplingFixture(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.context.sampleAttribute!(f.target, 'class', new Deadline(300));
    const next = f.budget.enter(new AbortController().signal, 1000); finish([fields()]);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    f.readFields.mockResolvedValue([fields({ class: 'fresh' })]);
    await expect(f.context.sampleAttribute!(f.target, 'class', new Deadline(200))).resolves.toBe('fresh');
    expect(f.readFields.mock.calls[1]![2].signal).not.toBe(f.controller.signal);
    expect(f.readFields.mock.calls[1]![2].signal.aborted).toBe(false); next.abort();
  });
  it('cannot retry an old-phase read using the next phase signal or budget', async () => {
    const f = samplingFixture(() => { f.budget.enter(new AbortController().signal, 1000); throw new EngineError('NODE_STALE', 'retired', { retryable: true }); });
    await expect(f.context.sampleAttribute!(f.target, 'class', new Deadline(300))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.readFields).toHaveBeenCalledTimes(1);
  });
  it('preserves an Unknown result even if cancellation or phase replacement also occurred', async () => {
    const failure = new EngineError('ACTION_MAY_HAVE_COMMITTED', 'unknown', { retryable: false });
    const f = samplingFixture(() => { f.controller.abort(); f.budget.enter(new AbortController().signal, 1000); throw failure; });
    await expect(f.context.sampleAttribute!(f.target, 'class', new Deadline(300))).rejects.toMatchObject({ code: 'ACTION_FAILED', cause: failure });
    expect(f.readFields).toHaveBeenCalledTimes(1); expect(f.locate).not.toHaveBeenCalled();
  });
  it.each(['missing capability', 'protected purpose'] as const)('retains a bounded legacy read for %s', async kind => {
    const f = samplingFixture(() => [fields()], { capability: kind !== 'missing capability' });
    const engine = new LocatorEngine({ session: f.session, readPurpose: kind === 'protected purpose' ? 'protected' : 'fixture', budget: new AttemptBudget(f.controller.signal, new Deadline(1000)), runId: 'run', attemptId: 'attempt', actionTimeout: 5000, assertionTimeout: 1000 });
    await expect(engine.sampleAttribute(expression, 'class', new Deadline(300))).resolves.toBe('legacy');
    expect(f.locate).toHaveBeenCalledExactlyOnceWith(expression, expect.objectContaining({ timeoutMs: 300 }), { purpose: kind === 'protected purpose' ? 'protected' : 'fixture' });
    expect(f.readFields).not.toHaveBeenCalled();
  });
});
