import { describe, expect, it } from 'vitest';
import { IsolatedScopeCreation } from '../helpers/isolated-scope-creation.ts';

type Call = { name: string; args: Record<string, unknown>; result: unknown };
function startup(): Call[] {
  return [
    { name: 'scope.interop.prepare', args: { context: 'isolated', preparationId: 'reservation', viewport: null }, result: { preparationId: 'reservation', endpoint: 'not-recorded' } },
    { name: 'scope.interop.adopt', args: { preparationId: 'reservation', contextId: 'context', targetId: 'page' }, result: { identityScope: 'owned-scope' } },
    { name: 'scope.configure', args: { identityScope: 'owned-scope' }, result: null },
  ];
}
async function observe(calls: Call[], observer = new IsolatedScopeCreation()) {
  for (const call of calls) {
    const raw = Promise.resolve(call.result);
    expect(observer.observe(call.name, call.args, raw)).toBe(raw);
    await raw;
  }
  return observer;
}

describe('isolated startup receipt oracle', () => {
  it('accepts exactly one completed prepare/adopt/configure chain and the public owner', async () => {
    const observer = await observe(startup());
    observer.assertOne({ viewport: null, identityScope: 'owned-scope' });
    expect(() => observer.assertScope('another-scope')).toThrow();
  });

  it.each(['prepare', 'adopt', 'configure'] as const)('does not treat a sent but pending %s as a successful startup', async stage => {
    const calls = startup(); const observer = new IsolatedScopeCreation();
    let complete!: (value: unknown) => void;
    for (const call of calls) {
      if (call.name.endsWith(stage)) {
        const pending = new Promise(resolve => { complete = resolve; });
        expect(observer.observe(call.name, call.args, pending)).toBe(pending);
        expect(() => observer.assertOne()).toThrow(); complete(call.result); await pending;
      } else await observe([call], observer);
    }
    observer.assertOne();
  });

  it.each(['prepare', 'adopt', 'configure'] as const)('preserves a rejected %s receipt and never counts it as successful', async stage => {
    const calls = startup(); const observer = new IsolatedScopeCreation(); const failure = new Error('original native refusal');
    for (const call of calls) {
      if (call.name.endsWith(stage)) {
        const rejected = Promise.reject(failure);
        expect(observer.observe(call.name, call.args, rejected)).toBe(rejected);
        await expect(rejected).rejects.toBe(failure); break;
      }
      await observe([call], observer);
    }
    expect(() => observer.assertOne()).toThrow();
  });

  it.each([
    ['old scope.open', (calls: Call[]) => { calls.splice(0, 2, { name: 'scope.open', args: { viewport: null }, result: { identityScope: 'owned-scope' } }); }],
    ['missing prepare', (calls: Call[]) => { calls.splice(0, 1); }],
    ['missing adopt', (calls: Call[]) => { calls.splice(1, 1); }],
    ['missing configure', (calls: Call[]) => { calls.splice(2, 1); }],
    ['duplicate prepare', (calls: Call[]) => { calls.splice(1, 0, calls[0]!); }],
    ['duplicate adopt', (calls: Call[]) => { calls.splice(2, 0, calls[1]!); }],
    ['duplicate configure', (calls: Call[]) => { calls.push(calls[2]!); }],
    ['empty reservation', (calls: Call[]) => { calls[0]!.args['preparationId'] = ''; }],
    ['wrong prepare receipt', (calls: Call[]) => { calls[0]!.result = { preparationId: 'another' }; }],
    ['wrong adopted reservation', (calls: Call[]) => { calls[1]!.args['preparationId'] = 'another'; }],
    ['no real context', (calls: Call[]) => { calls[1]!.args['contextId'] = ''; }],
    ['no real page', (calls: Call[]) => { calls[1]!.args['targetId'] = ''; }],
    ['no adopted scope', (calls: Call[]) => { calls[1]!.result = { identityScope: '' }; }],
    ['configure another scope', (calls: Call[]) => { calls[2]!.args['identityScope'] = 'another'; }],
    ['persistent context', (calls: Call[]) => { calls[0]!.args['context'] = 'persistent'; }],
    ['viewport null replaced', (calls: Call[]) => { calls[0]!.args['viewport'] = { width: 1280, height: 720 }; }],
  ] as const)('rejects %s instead of weakening the original obligation', async (_name, mutate) => {
    const calls = startup(); mutate(calls); const observer = await observe(calls);
    expect(() => observer.assertOne({ viewport: null })).toThrow();
  });

  it('requires the preceding receipt before dispatching the next stage', async () => {
    const observer = new IsolatedScopeCreation();
    await Promise.all(startup().map(call => observer.observe(call.name, call.args, Promise.resolve(call.result))));
    expect(() => observer.assertOne()).toThrow();
  });

  it('snapshots only owned scalar arguments and does not count unrelated page commands', async () => {
    const observer = new IsolatedScopeCreation(); const calls = startup();
    for (const call of calls) {
      const pending = observer.observe(call.name, call.args, Promise.resolve(call.result));
      call.args['preparationId'] = 'caller mutation'; await pending;
    }
    const raw = Promise.resolve({ title: 'not-recorded' });
    expect(observer.observe('page.title', {}, raw)).toBe(raw); await raw;
    observer.assertOne({ viewport: null });
  });
});
