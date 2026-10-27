/**
 * The page-side evaluation boundary: the caller's source is inlined into a
 * fresh function, so it must run whatever the loader compiled it to. The tsx
 * loader of e2e before 0.17 emits esbuild `keepNames` output, which
 * references a module-scoped `__name` helper.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileEvaluation, pageFunctionSource } from '../../src/evaluation.ts';

describe('compileEvaluation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs a keepNames-compiled source that references __name', async () => {
    const evaluate = compileEvaluation(
      'input=>{const pick=__name(key=>input[key],"pick");return pick("a")+pick("b")}',
      true,
    );
    await expect(evaluate({ a: 2, b: 40 })).resolves.toEqual({ ok: true, value: 42 });
  });

  it('gives the wrapped binding the name esbuild kept', async () => {
    const evaluate = compileEvaluation('() => __name(() => 1, "pick").name', false);
    await expect(evaluate(undefined)).resolves.toEqual({ ok: true, value: 'pick' });
  });

  it.each([
    ['document.title', 'Cart'],
    ['(() => document.title)()', 'Cart'],
    ['Promise.resolve(document.title)', 'Cart'],
    ['() => document.title', 'Cart'],
  ])('evaluates a string as an expression, calling a function it evaluates to: %s', async (source, value) => {
    vi.stubGlobal('document', { title: 'Cart' });
    await expect(compileEvaluation(source, false)(undefined)).resolves.toEqual({ ok: true, value });
  });

  it('leaves a page global of any name visible to the source', async () => {
    vi.stubGlobal('result', 'page value');
    vi.stubGlobal('value', 'page value');
    await expect(compileEvaluation('[result, value]', false)(undefined)).resolves.toEqual({
      ok: true,
      value: ['page value', 'page value'],
    });
  });

  it('calls a function expression with the argument', async () => {
    await expect(compileEvaluation('(n) => n + 1', true)(41)).resolves.toEqual({ ok: true, value: 42 });
  });

  it.each([
    'Infinity', 'NaN', '({ nested: [Infinity] })', '({ nested: undefined })',
    '({ nested: () => 1 })', '1n', 'Symbol("value")', 'new Date(0)',
    '(() => { const value = {}; value.self = value; return value; })()',
  ])('rejects invalid results before JSON transport can erase them: %s', async source => {
    const envelope = await compileEvaluation(source, false)(undefined);
    expect(JSON.parse(JSON.stringify(envelope))).toEqual({ ok: false, invalidResult: true });
  });

  it.each([
    ['undefined', undefined],
    ['Object.assign(Object.create(null), { value: 1 })', { value: 1 }],
    ['(() => { const shared = { value: 1 }; return [shared, shared]; })()', [{ value: 1 }, { value: 1 }]],
  ])('preserves valid top-level undefined, null prototypes and DAG values: %s', async (source, value) => {
    await expect(compileEvaluation(source as string, false)(undefined)).resolves.toEqual({ ok: true, value });
  });

  it('emits the validated snapshot without reading stateful getters again', async () => {
    const envelope = await compileEvaluation(`() => {
      let reads = 0;
      return { get value() { return ++reads === 1 ? 42 : Infinity; }, get count() { return reads; } };
    }`, false)(undefined);
    expect(JSON.parse(JSON.stringify(envelope))).toEqual({ ok: true, value: { value: 42, count: 1 } });
  });

  it('copies __proto__ as an ordinary data property without invoking toJSON', async () => {
    const envelope = await compileEvaluation(`JSON.parse('{"__proto__":{"value":42}}')`, false)(undefined);
    expect(JSON.parse(JSON.stringify(envelope))).toEqual({ ok: true, value: JSON.parse('{"__proto__":{"value":42}}') });
  });

  it('reports an exception from the evaluated code by message', async () => {
    const evaluate = compileEvaluation('() => { throw new Error("boom"); }', false);
    await expect(evaluate(undefined)).resolves.toEqual({ ok: false, message: 'boom' });
  });
});

// The same boundary browser.evaluate and init scripts use for serialized functions.
describe('pageFunctionSource', () => {
  it('evaluates an ordinary method with its argument', async () => {
    const functions = { add(value: number) { return value + 1; } };
    await expect(compileEvaluation(pageFunctionSource(functions.add), true)(41))
      .resolves.toEqual({ ok: true, value: 42 });
  });

  it('evaluates an async method with its argument', async () => {
    const functions = { async add(value: number) { return value + 1; } };
    await expect(compileEvaluation(pageFunctionSource(functions.add), true)(41))
      .resolves.toEqual({ ok: true, value: 42 });
  });
});
