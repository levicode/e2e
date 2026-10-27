import { describe, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { NativeReferenceAliases, type ReferenceOwner } from '../../src/native/reference-aliases.ts';
const owner = (): ReferenceOwner => ({ attempt: {}, client: {}, scope: 'scope', epoch: 0, publication: 0, owns: () => true });
const node = (id = '@e77', revision = '7'): SemanticNode => ({ ref: { id, revision }, role: 'button', name: 'Save' });
const stale = { code: 'NODE_STALE' };

describe('Web public reference aliases', () => {
  it('publishes nN IDs without deriving native numbers or changing semantics', () => {
    const aliases = new NativeReferenceAliases(); const current = owner();
    const source = { ...node(), children: [node('@e912')] };
    const [publicNode] = aliases.capture(current, [source]).nodes;
    expect(publicNode).toEqual({ ...source, ref: { id: 'root', revision: 'r1' }, children: [{ ...source.children[0], ref: { id: 'n2', revision: '7' } }] });
    expect(source.ref.id).toBe('@e77');
    expect(aliases.resolve(current, publicNode!.ref)).toEqual(source.ref);
    expect(() => aliases.resolve(current, { id: 'n77', revision: '7' })).toThrow(expect.objectContaining(stale));
    expect(() => aliases.resolve(current, source.ref)).toThrow(expect.objectContaining(stale));
  });
  it('retires the old observation generation instead of upgrading a captured reference', () => {
    const aliases = new NativeReferenceAliases(); const current = owner();
    const first = aliases.capture(current, [node()]).nodes[0]!.ref;
    const second = aliases.capture(current, [node('@e77', '8')]).nodes[0]!.ref;
    expect(second.id).toBe('root'); expect(second.revision).not.toBe(first.revision);
    expect(() => aliases.resolve(current, first)).toThrow(expect.objectContaining(stale));
    expect(aliases.resolve(current, second)).toEqual({ id: '@e77', revision: '8' });
    for (const revision of ['9', 's1', 'b1', 'l1']) expect(() => aliases.resolve(current, { ...first, revision })).toThrow(expect.objectContaining(stale));
  });
  it.each(['attempt', 'client', 'scope', 'epoch', 'publication'] as const)('does not recycle aliases when %s changes', field => {
    const aliases = new NativeReferenceAliases(); const current = owner();
    const old = aliases.capture(current, [node()]).nodes[0]!.ref;
    const replacement = { ...current, [field]: field === 'attempt' || field === 'client' ? {} : field === 'scope' ? 'replacement' : 1 };
    const fresh = aliases.capture(replacement, [node()]).nodes[0]!.ref;
    expect(fresh).not.toEqual(old);
    expect(() => aliases.resolve(replacement, old)).toThrow(expect.objectContaining(stale));
    expect(aliases.resolve(replacement, fresh)).toEqual(node().ref);
  });
  it('does not restore old aliases after navigation or pixel fallback retires same-scope evidence', () => {
    const aliases = new NativeReferenceAliases(); const current = owner();
    const old = aliases.capture(current, [node()]).nodes[0]!.ref;
    aliases.retire();
    const fresh = aliases.capture(current, [node()]).nodes[0]!.ref;
    expect(fresh).not.toEqual(old);
    expect(() => aliases.resolve(current, old)).toThrow(expect.objectContaining(stale));
  });
  it('rejects a captured owner after its lifetime ends', () => {
    const aliases = new NativeReferenceAliases(); let live = true;
    const current = { ...owner(), owns: () => live };
    const ref = aliases.capture(current, [node()]).nodes[0]!.ref; live = false;
    expect(() => aliases.resolve(current, ref)).toThrow(expect.objectContaining(stale));
    expect(() => aliases.capture(current, [node()])).toThrow(expect.objectContaining(stale));
  });
  it('translates both drag endpoints and distinguishes viewport capability', () => {
    const aliases = new NativeReferenceAliases(); const current = owner();
    const batch = aliases.capture(current, [node(), node('@e31', '9')], { id: '@e500', revision: '7' });
    const source = batch.nodes[0]!.ref; const target = batch.nodes[1]!.ref;
    expect(aliases.action(current, source, { kind: 'dragTo', target })).toEqual({ ref: node().ref, action: { kind: 'dragTo', target: { id: '@e31', revision: '9' } } });
    expect(aliases.action(current, batch.viewport!, { kind: 'swipe', direction: 'down' })).toEqual({ ref: { id: '@e500', revision: '7' }, action: { kind: 'swipe', direction: 'down' } });
    expect(() => aliases.action(current, batch.viewport!, { kind: 'tap' })).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
    expect(() => aliases.action(current, source, { kind: 'dragTo', target: batch.viewport! })).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
    expect(() => aliases.action(current, source, { kind: 'dragTo', target: { id: 'n999', revision: '7' } })).toThrow(expect.objectContaining(stale));
  });
  it('keeps trace aliases non-actionable even when temporary native IDs collide', () => {
    const aliases = new NativeReferenceAliases(); const current = owner();
    const live = aliases.capture(current, [node()]).nodes[0]!.ref;
    const trace = aliases.trace([node()]).nodes[0]!.ref;
    expect(trace.id).toBe('root'); expect(trace.revision).not.toBe(live.revision);
    expect(() => aliases.resolve(current, trace)).toThrow(expect.objectContaining(stale));
    expect(aliases.resolve(current, live)).toEqual(node().ref);
  });
  it('maps diagnostic matches back to the exact issued observed candidate', () => {
    const aliases = new NativeReferenceAliases(); const current = owner();
    const located = aliases.capture(current, [node('@e20')], undefined, 'locate').nodes[0]!.ref;
    const observed = aliases.capture(current, [node('@e90')]).nodes[0]!.ref;
    const input = { located: [located], observed: [observed] };
    const correlation = aliases.correlation(current, input);
    expect(correlation.args).toEqual({ located: [{ id: '@e20', revision: '7' }], observed: [{ id: '@e90', revision: '7' }] });
    input.observed.length = 0;
    expect(correlation.project([{ id: '@e90', revision: '7' }])).toEqual([observed]);
    expect(correlation.project([null])).toEqual([null]);
    expect(() => correlation.project([{ id: '@e20', revision: '7' }])).toThrow();
    aliases.retire(); expect(() => correlation.project([{ id: '@e90', revision: '7' }])).toThrow(expect.objectContaining(stale));
  });
  it('refuses native IDs, viewport capabilities and malformed diagnostic inputs', () => {
    const aliases = new NativeReferenceAliases(); const current = owner();
    const batch = aliases.capture(current, [node()], { id: '@e2', revision: '7' });
    expect(() => aliases.correlation(current, { located: [node().ref], observed: [] })).toThrow(expect.objectContaining(stale));
    expect(() => aliases.correlation(current, { located: [batch.viewport], observed: [] })).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
    expect(() => aliases.correlation(current, { located: [batch.nodes[0]!.ref], observed: [], extra: true })).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
  });
  it('bounds only locator evidence while keeping the current observation actionable', () => {
    const aliases = new NativeReferenceAliases(); const current = owner();
    const anchor = aliases.capture(current, [node('@e1')]).nodes[0]!.ref;
    const first = aliases.capture(current, [node('@e2')], undefined, 'locate').nodes[0]!.ref;
    const batch = Array.from({ length: 2048 }, (_, index) => node(`@e${index + 3}`));
    const latest = aliases.capture(current, batch, undefined, 'locate').nodes;
    expect(aliases.resolve(current, latest.at(-1)!.ref)).toEqual(batch.at(-1)!.ref);
    expect(() => aliases.resolve(current, first)).toThrow(expect.objectContaining(stale));
    expect(aliases.resolve(current, anchor)).toEqual({ id: '@e1', revision: '7' });
    const reissued = aliases.capture(current, [node('@e2')], undefined, 'locate').nodes[0]!.ref;
    expect(reissued.id).not.toBe(first.id);
    aliases.capture(current, [node('@e1')]);
    expect(() => aliases.resolve(current, anchor)).toThrow(expect.objectContaining(stale));
    expect(aliases.resolve(current, reissued)).toEqual({ id: '@e2', revision: '7' });
  });
  it('keeps literal root and sends its swipe to viewport, other actions to the document', () => {
    const aliases = new NativeReferenceAliases(); const current = owner();
    const observed = aliases.capture(current, [node('@e40', '6')], { id: '@e90', revision: '8' });
    const root = observed.nodes[0]!.ref;
    expect(root).toEqual({ id: 'root', revision: 'r1' });
    expect(aliases.action(current, root, { kind: 'tap' })).toEqual({ ref: { id: '@e40', revision: '6' }, action: { kind: 'tap' } });
    expect(aliases.action(current, root, { kind: 'swipe', direction: 'down' })).toEqual({ ref: { id: '@e90', revision: '8' }, action: { kind: 'swipe', direction: 'down' } });
    const replacement = aliases.capture(current, [node('@e40', '6')], { id: '@e90', revision: '8' });
    expect(replacement.nodes[0]!.ref.id).toBe('root');
    expect(() => aliases.action(current, root, { kind: 'swipe', direction: 'down' })).toThrow(expect.objectContaining(stale));
  });

  it('does not give a pixel-fallback root document-element authority', () => {
    const aliases = new NativeReferenceAliases(); const current = owner();
    const observed = aliases.capture(current, [{ ref: node().ref }], { id: '@e90', revision: '8' }, 'pixels');
    const root = observed.nodes[0]!.ref;
    expect(() => aliases.action(current, root, { kind: 'tap' })).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
    expect(aliases.action(current, root, { kind: 'swipe', direction: 'down' }).ref).toEqual({ id: '@e90', revision: '8' });
  });

});
