/** Pure controls for attribute projection through the real session decoder. */
import { describe, expect, it, vi } from 'vitest';
import { defineEngine, EngineError, type EngineFieldValues, type EngineReadField, type OperationContext } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { Deadline, sleep } from '../../src/internal/time.ts';
import { LocatorEngine } from '../../src/locator/engine.ts';
import { createLocator } from '../../src/locator/screen.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { useFakeTime } from '../helpers/fake-time.ts';

useFakeTime();
const expression = { kind: 'selector', selector: '#field' } as const;
const plain = (attributes: Record<string, string> = {}): EngineFieldValues => ({ attributes, states: { secure: false } });
type Read = (operation: OperationContext) => readonly EngineFieldValues[] | Promise<readonly EngineFieldValues[]>;
function fixture(values: Read, options: { capability?: boolean; protected?: boolean; attemptTimeout?: number } = {}) {
  const calls: { fields: readonly EngineReadField[]; timeoutMs: number }[] = [];
  const locate = vi.fn(async () => [{ ref: { id: 'field', revision: '1' }, attributes: { value: 'legacy' }, states: { secure: false } }]);
  const observe = vi.fn(async () => ({ identityScope: 'scope', root: { ref: { id: 'root', revision: '1' } }, viewport: { width: 10, height: 10 } }));
  const perform = vi.fn(async () => {});
  const readFields = vi.fn(async (_expression: typeof expression, fields: readonly EngineReadField[], operation: OperationContext) => {
    calls.push({ fields: [...fields], timeoutMs: operation.timeoutMs });
    return values(operation);
  });
  const engine = defineEngine({ name: 'attributes', version: '1', spiVersion: 1, referenceRevisions: 'engine', locate, observe, perform, actions: ['tap'],
    ...(options.capability === false ? {} : { readFields }) });
  const session = createEngineSession({ engine, targetName: 'attributes' });
  const read = vi.spyOn(session, 'read');
  const locator = new LocatorEngine({ session, readPurpose: options.protected ? 'protected' : 'fixture',
    budget: new AttemptBudget(new AbortController().signal, new Deadline(options.attemptTimeout ?? 10_000)),
    runId: 'run', attemptId: 'attempt', actionTimeout: 5_000, assertionTimeout: 1_000 });
  const field = createLocator({ engine: locator, steps: new StepRecorder('attempt'), secrets: { resolve: async () => '' }, renderTree: () => '' }, expression);
  return { field, calls, locate, read, readFields, observe, perform };
}
function projected(f: ReturnType<typeof fixture>) {
  expect(f.calls.length).toBeGreaterThan(0);
  expect(f.calls.every(call => JSON.stringify(call.fields) === '["attributes"]')).toBe(true);
  expect(f.readFields).toHaveBeenCalledWith(expression, ['attributes'], expect.objectContaining({ runId: 'run', attemptId: 'attempt', origin: 'test' }), { purpose: 'fixture' });
  expect(f.locate).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.observe).not.toHaveBeenCalled();
  expect(f.perform).not.toHaveBeenCalled();
}

describe('attribute-only assertion samples', () => {
  it('keeps presence, exact, regex, empty, own prototype keys and ignoreCase matching', async () => {
    const f = fixture(() => [plain({ value: '  Marker\n  5e0c ', empty: '', constructor: 'own', toString: '', ['__proto__']: 'proto' })]);
    await expectFixture(f.field).toHaveAttribute('value');
    await expectFixture(f.field).toHaveAttribute('value', 'Marker 5e0c');
    await expectFixture(f.field).toHaveAttribute('value', /Marker\s+5e0c/);
    await expectFixture(f.field).toHaveAttribute('value', 'marker 5e0c', { ignoreCase: true });
    await expectFixture(f.field).toHaveAttribute('value', /marker\s+5e0c/, { ignoreCase: true });
    await expectFixture(f.field).toHaveAttribute('empty', '');
    await expectFixture(f.field).toHaveAttribute('constructor', 'own');
    await expectFixture(f.field).toHaveAttribute('toString', '');
    await expectFixture(f.field).toHaveAttribute('__proto__', 'proto');
    projected(f);
  });

  it('keeps the entire 200ms grace for Blank rather than passing on its first absence sample', async () => {
    const f = fixture(() => [plain()]); const start = Date.now();
    await expectFixture(f.field).not.toHaveAttribute('value', { timeout: 200 });
    expect(Date.now() - start).toBe(200);
    expect(f.calls.map(call => call.timeoutMs)).toEqual([200, 100]);
    projected(f);
  });

  it('does not mistake inherited names for attributes and keeps positive/negative failure diagnostics', async () => {
    const absent = fixture(() => [plain()]);
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      await expectFixture(absent.field).not.toHaveAttribute(name, { timeout: 200 });
    }
    await expect(expectFixture(absent.field).toHaveAttribute('value', { timeout: 200 })).rejects.toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('observed: attribute "value" absent') });
    const present = fixture(() => [plain({ value: 'marker' })]);
    await expect(expectFixture(present.field).not.toHaveAttribute('value', { timeout: 200 })).rejects.toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('observed: attribute "value" "marker"') });
    projected(absent); projected(present);
  });

  it.each([
    { negated: false, value: false, name: 'value' },
    { negated: true, value: false, name: 'value' },
    { negated: false, value: true, name: 'value' },
    { negated: true, value: true, name: 'value' },
    { negated: false, value: true, name: 'type' },
  ])('denies secure reads before the predicate: %j', async ({ negated, value, name }) => {
    const f = fixture(() => [{ attributes: { type: 'password' }, states: { secure: true } }]);
    const assertion = negated ? expectFixture(f.field).not : expectFixture(f.field);
    await expect(value ? assertion.toHaveAttribute(name, 'synthetic', { timeout: 200 }) : assertion.toHaveAttribute(name, { timeout: 200 })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(f.calls).toHaveLength(1); projected(f);
  });

  it.each([
    { attributes: {} },
    { attributes: {}, states: {} },
    { attributes: { value: 'synthetic' }, states: { secure: true } },
    { attributes: {}, states: { secure: false }, ref: { id: 'forged', revision: '1' } },
  ])('fails closed on malformed or widened field projection %#', async projection => {
    const f = fixture(() => [projection as EngineFieldValues]);
    await expect(expectFixture(f.field).not.toHaveAttribute('value', { timeout: 200 })).rejects.toMatchObject({ code: 'APP_NOT_OPEN', cause: expect.objectContaining({ code: 'INVALID_STATE' }) });
    expect(f.calls).toHaveLength(1); projected(f);
  });

  it.each([false, true])('waits for a real match even when negated=%s', async negated => {
    const f = fixture(() => []); const start = Date.now();
    const assertion = negated ? expectFixture(f.field).not : expectFixture(f.field);
    await expect(assertion.toHaveAttribute('value', { timeout: 200 })).rejects.toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('observed: no node') });
    expect(Date.now() - start).toBe(200); projected(f);
  });

  it.each([false, true])('does not turn a missing frame into absence when negated=%s', async negated => {
    const failure = new EngineError('FRAME_NOT_FOUND', 'missing frame', { retryable: true });
    const f = fixture(() => { throw failure; }); const start = Date.now();
    const assertion = negated ? expectFixture(f.field).not : expectFixture(f.field);
    await expect(assertion.toHaveAttribute('value', { timeout: 200 })).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND', cause: failure });
    expect(Date.now() - start).toBe(200); projected(f);
  });

  it('refuses ambiguous current matches immediately', async () => {
    const f = fixture(() => [plain(), plain()]); const start = Date.now();
    await expect(expectFixture(f.field).not.toHaveAttribute('value', { timeout: 200 })).rejects.toMatchObject({ code: 'LOCATOR_AMBIGUOUS' });
    expect(Date.now() - start).toBe(0); expect(f.calls).toHaveLength(1); projected(f);
  });

  it('retries a missing frame, then absence, then arrival under one original deadline', async () => {
    let round = 0;
    const f = fixture(() => {
      if (++round === 1) throw new EngineError('FRAME_NOT_FOUND', 'missing frame', { retryable: true });
      return round === 2 ? [] : [plain({ value: 'arrived' })];
    });
    await expectFixture(f.field).toHaveAttribute('value', 'arrived', { timeout: 300 });
    expect(f.calls.map(call => call.timeoutMs)).toEqual([300, 200, 100]); projected(f);
  });

  it('caps the requested 200ms assertion by the 120ms attempt budget', async () => {
    const f = fixture(() => [plain()], { attemptTimeout: 120 }); const start = Date.now();
    await expectFixture(f.field).not.toHaveAttribute('value', { timeout: 200 });
    expect(Date.now() - start).toBe(120);
    expect(f.calls.map(call => call.timeoutMs)).toEqual([120, 20]); projected(f);
  });

  it('preserves the existing final 60ms ordinary-timeout cutoff after a completed negative sample', async () => {
    let round = 0;
    const f = fixture(async operation => {
      if (++round === 1) { await sleep(40); return [plain()]; }
      await sleep(operation.timeoutMs);
      throw new EngineError('OPERATION_TIMEOUT', 'final read cutoff', { retryable: false });
    }); const start = Date.now();
    await expectFixture(f.field).not.toHaveAttribute('value', { timeout: 200 });
    expect(Date.now() - start).toBe(200);
    expect(f.calls.map(call => call.timeoutMs)).toEqual([200, 60]); projected(f);
  });

  it('never treats Unknown as that cutoff, retries it, or falls back to references', async () => {
    const failure = new EngineError('ACTION_MAY_HAVE_COMMITTED', 'action-outcome-unknown', { retryable: false });
    // Refusal before the deadline must not be retried either; an exhausted
    // final sample alone would not distinguish that from budget exhaustion.
    const immediate = fixture(() => { throw failure; }); const issued = Date.now();
    await expect(expectFixture(immediate.field).not.toHaveAttribute('value', { timeout: 200 })).rejects.toMatchObject({ code: 'ACTION_FAILED', cause: failure });
    expect(Date.now() - issued).toBe(0); expect(immediate.calls).toHaveLength(1); projected(immediate);
    let round = 0;
    const f = fixture(async operation => {
      if (++round === 1) { await sleep(40); return [plain()]; }
      await sleep(operation.timeoutMs); throw failure;
    }); const start = Date.now();
    await expect(expectFixture(f.field).not.toHaveAttribute('value', { timeout: 200 })).rejects.toMatchObject({ code: 'ACTION_FAILED', cause: failure });
    expect(Date.now() - start).toBe(200);
    expect(f.calls.map(call => call.timeoutMs)).toEqual([200, 60]); projected(f);
  });

  it.each([{ capability: false }, { protected: true }])('retains the legacy path without fixture field authority: %j', async options => {
    const f = fixture(() => { throw new Error('field hook must not be called'); }, options);
    await expectFixture(f.field).toHaveAttribute('value', 'legacy', { timeout: 200 });
    expect(f.calls).toEqual([]); expect(f.readFields).not.toHaveBeenCalled();
    expect(f.locate).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.observe).not.toHaveBeenCalled(); expect(f.perform).not.toHaveBeenCalled();
  });
});
