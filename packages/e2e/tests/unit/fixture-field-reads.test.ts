/** Value-only fixture reads use the real session/locator seam, never fake refs. */
import { describe, expect, it, vi } from 'vitest';
import { defineEngine, EngineError, type Engine, type EngineFieldValues, type EngineReadField, type OperationContext } from '../../src/engine/index.ts';
import { decodeEngineFieldValues } from '../../src/engine/field-values.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { LocatorEngine } from '../../src/locator/engine.ts';
import { createLocator } from '../../src/locator/screen.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { Deadline } from '../../src/internal/time.ts';
import { useFakeTime } from '../helpers/fake-time.ts';
useFakeTime();
const expression = { kind: 'selector', selector: '#field' } as const;
const operation: OperationContext = { signal: new AbortController().signal, timeoutMs: 300, runId: 'run', attemptId: 'attempt', origin: 'test' };
function fixture(readFields?: Engine['readFields'], purpose: 'fixture' | 'protected' = 'fixture') {
  const locate = vi.fn(async () => [{ ref: { id: 'field', revision: '1' }, text: 'legacy', states: { secure: false }, rect: { x: 1, y: 2, width: 3, height: 4 } }]);
  const observe = vi.fn(async () => ({ identityScope: 'scope', root: { ref: { id: 'root', revision: '1' } }, viewport: { width: 10, height: 10 } }));
  const perform = vi.fn(async () => {});
  const engine = defineEngine({ name: 'fields', version: '1', spiVersion: 1, referenceRevisions: 'engine', observe, locate, perform, actions: ['tap'],
    session: { restart: async () => {} }, ...(readFields === undefined ? {} : { readFields }) });
  const session = createEngineSession({ engine, targetName: 'fields' });
  const locator = new LocatorEngine({ session, readPurpose: purpose, budget: new AttemptBudget(operation.signal, new Deadline(5000)), runId: 'run', attemptId: 'attempt', actionTimeout: 300, assertionTimeout: 300 });
  const field = createLocator({ engine: locator, steps: new StepRecorder('attempt'), secrets: { resolve: async () => '' }, renderTree: () => '' }, expression);
  return { session, locator, field, locate, observe, perform };
}
const value = (text = '  current \n value '): EngineFieldValues => ({ text, states: { secure: false } });

describe('pure fixture field seam', () => {
  it('reads current values while the old reference path still refuses retained input debt', async () => {
    const blocked = new EngineError('INVALID_STATE', 'reference acquisition has retained input debt', { retryable: false });
    const f = fixture(async () => [value('callback value')]);
    f.locate.mockRejectedValue(blocked);
    await expect(f.session.locate(expression, operation, { purpose: 'fixture' })).rejects.toBe(blocked);
    expect(await f.field.textContent()).toBe('callback value');
    await expect(f.session.locate(expression, operation, { purpose: 'fixture' })).rejects.toBe(blocked);
    expect(f.locate).toHaveBeenCalledTimes(2); expect(f.perform).not.toHaveBeenCalled();
  });
  it('reads selected current values without locate, observe, ref publication or revision replacement', async () => {
    const read = vi.fn(async () => [value()]); const f = fixture(read);
    const [before] = await f.session.locate(expression, operation);
    expect(await f.field.textContent()).toBe('current value');
    expect(read).toHaveBeenCalledWith(expression, ['text'], expect.objectContaining({ attemptId: 'attempt' }), { purpose: 'fixture' });
    expect(await f.session.read(before!, operation)).toMatchObject({ ref: before, text: 'legacy' });
    expect(f.locate).toHaveBeenCalledTimes(1); expect(f.observe).not.toHaveBeenCalled(); expect(f.perform).not.toHaveBeenCalled();
  });
  it('does not route protected reads, geometry, counts, or actions through the seam', async () => {
    const read = vi.fn(async () => [value()]); const f = fixture(read);
    expect(await f.field.boundingBox()).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(await f.field.count()).toBe(1); await f.field.tap();
    expect(await fixture(read, 'protected').field.textContent()).toBe('legacy');
    expect(read).not.toHaveBeenCalled();
  });
  it('retains old engine behavior only when the optional hook is absent', async () => {
    const f = fixture(); expect(f.session.readFields).toBeUndefined(); expect(await f.field.textContent()).toBe('legacy');
  });
  it('never falls back after a hook refusal and preserves its original cause', async () => {
    const failure = new EngineError('ENGINE_FAILURE', 'native callback revoked', { retryable: false });
    const f = fixture(async () => { throw failure; });
    const thrown = await f.field.textContent().catch(cause => cause);
    expect(thrown.cause).toBe(failure); expect(f.locate).not.toHaveBeenCalled();
  });
  it('preserves strict cardinality, waiting for absence, and current-list order', async () => {
    const f = fixture(async () => [value('one'), value('two')]);
    await expect(f.field.textContent()).rejects.toMatchObject({ code: 'LOCATOR_AMBIGUOUS' });
    expect(await f.field.allTextContents()).toEqual(['one', 'two']);
    const empty = fixture(async () => []); expect(await empty.field.isVisible()).toBe(false);
    expect(await empty.field.isHidden()).toBe(true); expect(await empty.field.allTextContents()).toEqual([]);
    await expect(empty.field.textContent()).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
    const appears = vi.fn(async () => [value('appeared')]).mockResolvedValueOnce([]);
    expect(await fixture(appears).field.textContent()).toBe('appeared');
    expect(appears).toHaveBeenCalledTimes(2);
  });
  it('preserves missing-value, own-attribute, state, and secure-read contracts', async () => {
    const requested: readonly EngineReadField[][] = [];
    const f = fixture(async (_expression, fields) => { (requested as EngineReadField[][]).push([...fields]); return [{ states: { secure: false } }]; });
    expect(await f.field.textContent()).toBeNull(); expect(await f.field.inputValue()).toBe('');
    expect(await f.field.getAttribute('constructor')).toBeNull(); expect(await f.field.isEnabled()).toBe(true);
    expect(await f.field.isChecked()).toBe(false);
    expect(requested).toEqual([['text'], ['value'], ['attributes'], ['states'], ['states']]);
    const secure = fixture(async () => [{ states: { secure: true } }]);
    await expect(secure.field.textContent()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(secure.field.inputValue()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(secure.field.getAttribute('name')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(secure.field.allTextContents()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await secure.field.isEnabled()).toBe(true);
  });
  it('uses the existing missing-frame contract without a fallback query', async () => {
    const f = fixture(async () => { throw new EngineError('FRAME_NOT_FOUND', 'no frame', { retryable: true }); });
    expect(await f.field.isVisible()).toBe(false); expect(await f.field.allTextContents()).toEqual([]);
    await expect(f.field.textContent()).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND', cause: expect.objectContaining({ code: 'FRAME_NOT_FOUND' }) });
    expect(f.locate).not.toHaveBeenCalled();
  });
  it('rejects a result arriving after the session owner retired', async () => {
    let resolve!: (values: readonly EngineFieldValues[]) => void;
    const f = fixture(() => new Promise(done => { resolve = done; }));
    const work = f.session.readFields!(expression, ['text'], operation);
    await f.session.app.restart(operation); resolve([value()]);
    await expect(work).rejects.toMatchObject({ code: 'NODE_STALE' });
  });
});

it.each([
  { ref: { id: 'forged', revision: '1' }, states: { secure: false } },
  { rect: { x: 1, y: 2, width: 3, height: 4 }, states: { secure: false } },
  { children: [], states: { secure: false } }, { selector: '#unrequested', states: { secure: false } },
  { text: 'unmarked' }, { text: 'secret', states: { secure: true } },
  { text: 'value', states: { secure: false, hidden: true } },
])('rejects widened or unmarked field values %#', projection => {
  expect(() => decodeEngineFieldValues([projection], ['text'])).toThrow();
});
it.each([[], ['text', 'text'], ['rect'], ['unknown']].map(fields => ({ fields })))('rejects an invalid closed field selection %j', ({ fields }) => {
  expect(() => decodeEngineFieldValues([], fields as EngineReadField[])).toThrow();
});
