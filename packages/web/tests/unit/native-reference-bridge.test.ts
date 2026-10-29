import { describe, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { NativeReferenceBridge, type ReferenceOwner } from '../../src/native/reference-bridge.ts';
const owner = (): ReferenceOwner => ({ attempt: {}, client: {}, scope: 'scope', epoch: 0, publication: 0, owns: () => true });
const node = (id = '@e77', revision = 'nr1:5:scope:1:7'): SemanticNode => ({ ref: { id, revision }, role: 'button', name: 'Save' });
const viewport = { id: '@e500', revision: 'nr1:5:scope:1:2' };
const stale = { code: 'NODE_STALE' };

describe('Web native reference bridge', () => {
  it.each(['observe', 'locate', 'pixels'] as const)('preserves all native IDs and opaque revisions for %s', purpose => {
    const bridge = new NativeReferenceBridge();
    const source = { ...node('@e1'), children: [node('@e18446744073709551615')] };
    const result = bridge.capture(owner(), [source], viewport, purpose);
    expect(result).toEqual({ nodes: [source], viewport });
    expect(result.nodes[0]).not.toBe(source);
    expect(result.nodes[0]!.ref).not.toBe(source.ref);
    expect(result.nodes[0]!.children![0]!.ref).not.toBe(source.children[0]!.ref);
    expect(result.viewport).not.toBe(viewport);
  });
  it('keeps observed and located identities identical instead of minting new aliases', () => {
    const bridge = new NativeReferenceBridge(); const current = owner();
    const observed = bridge.capture(current, [node()]).nodes[0]!.ref;
    expect(bridge.capture(current, [node()], undefined, 'locate').nodes[0]!.ref).toEqual(observed);
    expect(bridge.capture(current, [node()]).nodes[0]!.ref).toEqual(observed);
  });
  it('does not maintain a second observation membership or locator eviction registry', () => {
    const bridge = new NativeReferenceBridge(); const current = owner(); const issued = node().ref;
    bridge.capture(current, [node()]);
    bridge.capture(current, []);
    bridge.capture(current, Array.from({ length: 2049 }, (_, i) => node(`@e${i + 1000}`)), undefined, 'locate');
    // Forwarding is not acceptance: native checks current issuance and capability.
    expect(bridge.action(current, issued, { kind: 'tap' })).toEqual({ ref: issued, action: { kind: 'tap' } });
  });
  it('routes only the exact current root swipe to its native viewport', () => {
    const bridge = new NativeReferenceBridge(); const current = owner(); const root = node('@e1').ref;
    bridge.capture(current, [node('@e1')], viewport);
    const swipe = { kind: 'swipe' as const, direction: 'down' as const };
    expect(bridge.action(current, root, swipe)).toEqual({ ref: viewport, action: swipe });
    expect(bridge.action(current, root, { kind: 'tap' })).toEqual({ ref: root, action: { kind: 'tap' } });
    const changed = { ...root, revision: `${root.revision}:forged` };
    expect(bridge.action(current, changed, swipe).ref).toEqual(changed);
    expect(bridge.action(current, viewport, swipe).ref).toEqual(viewport);
  });
  it('does not erase the root viewport pair during locator queries', () => {
    const bridge = new NativeReferenceBridge(); const current = owner();
    bridge.capture(current, [node('@e1')], viewport);
    bridge.capture(current, [node('@e20')], undefined, 'locate');
    expect(bridge.action(current, node('@e1').ref, { kind: 'swipe', direction: 'down' }).ref).toEqual(viewport);
  });
  it('retires root routing without revoking native viewport lifetime across navigation', () => {
    const bridge = new NativeReferenceBridge(); const current = owner(); const root = node('@e1').ref;
    bridge.capture(current, [node('@e1')], viewport); bridge.retire();
    const swipe = { kind: 'swipe' as const, direction: 'down' as const };
    expect(bridge.action(current, root, swipe).ref).toEqual(root);
    expect(bridge.action(current, viewport, swipe).ref).toEqual(viewport);
  });
  it.each(['attempt', 'client', 'scope', 'epoch', 'publication'] as const)('never carries root routing into a changed %s', field => {
    const bridge = new NativeReferenceBridge(); const current = owner(); const root = node('@e1').ref;
    bridge.capture(current, [node('@e1')], viewport);
    const replacement = { ...current, [field]: field === 'attempt' || field === 'client' ? {} : field === 'scope' ? 'new' : 1 };
    expect(bridge.action(replacement, root, { kind: 'swipe', direction: 'down' }).ref).toEqual(root);
  });
  it('preserves both drag endpoints for atomic native validation without granting kind authority', () => {
    const bridge = new NativeReferenceBridge(); const source = node().ref; const target = node('@e9').ref;
    const result = bridge.action(owner(), source, { kind: 'dragTo', target });
    expect(result).toEqual({ ref: source, action: { kind: 'dragTo', target } });
    expect(result.ref).not.toBe(source);
    if (result.action.kind !== 'dragTo') throw new Error('Expected drag');
    expect(result.action.target).not.toBe(target);
  });
  it('keeps trace IDs intact without updating live root routing or issuing authority', () => {
    const bridge = new NativeReferenceBridge(); const current = owner();
    bridge.capture(current, [node('@e1')], viewport);
    const trace = bridge.trace([node('@e900')], { ...viewport, id: '@e901' });
    expect(trace.nodes[0]!.ref).toEqual(node('@e900').ref);
    expect(trace.viewport!.id).toBe('@e901');
    expect(bridge.action(current, node('@e1').ref, { kind: 'swipe', direction: 'down' }).ref).toEqual(viewport);
  });
  it('rejects a retired publication owner before forwarding or capture', () => {
    const bridge = new NativeReferenceBridge(); let live = true;
    const current = { ...owner(), owns: () => live };
    bridge.capture(current, [node()]); live = false;
    expect(() => bridge.action(current, node().ref, { kind: 'tap' })).toThrow(expect.objectContaining(stale));
    expect(() => bridge.capture(current, [node()])).toThrow(expect.objectContaining(stale));
    expect(() => bridge.correlation(current, { located: [], observed: [] })).toThrow(expect.objectContaining(stale));
  });
  it('snapshots exact native correlation candidates and refuses a different returned reference', () => {
    const bridge = new NativeReferenceBridge(); const current = owner();
    const located = node('@e20').ref; const observed = node('@e90').ref;
    const input = { located: [located], observed: [observed] };
    const correlation = bridge.correlation(current, input);
    expect(correlation.args).toEqual(input);
    input.observed.length = 0;
    expect(correlation.project([observed, null])).toEqual([observed, null]);
    expect(() => correlation.project([{ ...observed, revision: 'forged' }])).toThrow();
    expect(() => correlation.project([located])).toThrow();
    bridge.retire(); expect(() => correlation.project([observed])).toThrow(expect.objectContaining(stale));
  });
  it('checks the captured correlation publication owner after dispatch', () => {
    const bridge = new NativeReferenceBridge(); let live = true;
    const current = { ...owner(), owns: () => live };
    const correlation = bridge.correlation(current, { located: [], observed: [node().ref] });
    live = false;
    expect(() => correlation.project([node().ref])).toThrow(expect.objectContaining(stale));
  });
  it.each([
    { located: [], observed: [], extra: true },
    { located: [{ id: 'n1', revision: 'nr1:5:scope:1:7' }], observed: [] },
    { located: [], observed: [{ id: '@e1', revision: '' }] },
    { located: [], observed: [{ id: '@e1', revision: 1 }] },
    { located: [], observed: [node().ref, node().ref] },
  ])('rejects malformed correlation shape before transport %#', value => {
    expect(() => new NativeReferenceBridge().correlation(owner(), value)).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
  });
});
