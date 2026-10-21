import { describe, expect, it, vi } from 'vitest';
import { defineEngine, type EngineSnapshot, type NodeRef, type OperationContext } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { ReferenceEvidence } from '../../src/engine/reference-evidence.ts';
const operation: OperationContext = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' };
function fixture(optIn = true) {
  let scope = 'scope-a'; let revision = '41';
  const snapshot = (): EngineSnapshot => ({ identityScope: scope, viewport: { width: 800, height: 600 }, viewportRef: { id: '@e9', revision }, root: {
    ref: { id: '@e1', revision }, role: 'document', children: [
      { ref: { id: '@e2', revision }, role: 'button', name: 'Source' },
      { ref: { id: '@e3', revision }, role: 'button', name: 'Target' },
    ],
  } });
  const observe = vi.fn(async () => snapshot()); const perform = vi.fn(async (_ref: NodeRef) => {});
  const locate = vi.fn(async () => snapshot().root.children!);
  const engine = defineEngine({ name: 'evidence', version: '1', spiVersion: 1,
    ...(optIn ? { referenceRevisions: 'engine' as const } : {}), observe, locate, perform, actions: ['tap', 'dragTo', 'swipe'],
    session: { restart: async () => { scope = 'scope-b'; revision = '42'; }, reset: async () => { scope = 'scope-b'; revision = '42'; } },
  });
  const session = createEngineSession({ engine, targetName: 'evidence', traced: true });
  return { session, observe, perform, locate, snapshot, change: (nextScope: string, nextRevision: string) => { scope = nextScope; revision = nextRevision; } };
}
const query = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } } as const;
describe('exact engine revision provenance', () => {
  it('restores source and drag-target native revisions without changing model-visible revisions', async () => {
    const f = fixture(); const observed = await f.session.observe(operation);
    expect(observed.root.revision).toBe('b1');
    await f.session.perform({ id: '@e2', revision: observed.revision }, { kind: 'dragTo', target: { id: '@e3', revision: observed.revision } }, operation);
    expect(f.perform).toHaveBeenCalledWith({ id: '@e2', revision: '41' }, { kind: 'dragTo', target: { id: '@e3', revision: '41' } }, operation);
  });
  it('preserves legacy engine inputs when the opt-in is omitted', async () => {
    const f = fixture(false); const observation = await f.session.observe(operation);
    await f.session.perform(observation.root, { kind: 'tap' }, operation);
    expect(f.perform).toHaveBeenCalledWith(observation.root, { kind: 'tap' }, operation);
  });
  it('preserves locate evidence and rejects a superseded locate instead of newest-by-id rebinding', async () => {
    const f = fixture(); const [old] = await f.session.locate(query, operation);
    await f.session.perform(old!, { kind: 'tap' }, operation);
    expect(f.perform.mock.calls[0]![0]).toEqual({ id: '@e2', revision: '41' });
    f.change('scope-a', '42'); await f.session.locate(query, operation);
    await expect(f.session.perform(old!, { kind: 'tap' }, operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
    expect(f.perform).toHaveBeenCalledTimes(1);
  });
  it('never replaces an older observed native revision with the newest same-id evidence', async () => {
    const f = fixture(); const old = await f.session.observe(operation);
    f.change('scope-a', '42'); await f.session.observe(operation);
    await f.session.perform(old.root, { kind: 'tap' }, operation);
    expect(f.perform.mock.calls[0]![0].revision).toBe('41'); // Native decides whether this exact revision is still valid.
  });
  it('rejects cross-scope evidence and historical scope reappearance', async () => {
    const f = fixture(); const old = await f.session.observe(operation);
    f.change('scope-b', '42'); await f.session.observe(operation);
    await expect(f.session.perform(old.root, { kind: 'tap' }, operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
    f.change('scope-a', '41'); await expect(f.session.observe(operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
    expect(f.perform).not.toHaveBeenCalled();
  });
  it.each(['reset', 'restart'] as const)('retires mappings before %s and obtains fresh viewport evidence', async method => {
    const f = fixture(); const old = await f.session.observe(operation);
    await f.session.app[method](operation);
    await expect(f.session.perform(old.root, { kind: 'tap' }, operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
    await f.session.swipe('down', undefined, operation);
    expect(f.perform.mock.calls[0]![0]).toEqual({ id: '@e9', revision: '42' });
  });
  it('retires prior references even when restart preserves identityScope', async () => {
    const f = fixture(); const old = await f.session.observe(operation);
    await f.session.app.restart(operation); f.change('scope-a', '42');
    await f.session.observe(operation);
    await expect(f.session.perform(old.root, { kind: 'tap' }, operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
  });
  it('keeps model evidence valid across pixels-only trace publication', async () => {
    const f = fixture(); const old = await f.session.observe(operation); const traces: string[] = [];
    f.session.screens.route(observation => traces.push(observation.kind));
    f.session.screens.push({ ...f.snapshot(), root: { ref: f.snapshot().root.ref }, treeUnavailable: true,
      pixels: { data: new Uint8Array([1]), mediaType: 'image/png', width: 800, height: 600, scale: 1 }, maskedRegionCount: 0 });
    expect(traces).toEqual(['pixels']);
    await f.session.perform(old.root, { kind: 'tap' }, operation);
    expect(f.perform.mock.calls[0]![0].revision).toBe('41');
  });
  it('rejects an observation that returns after reset retired its admission', async () => {
    const f = fixture(); let release!: (value: EngineSnapshot) => void;
    f.observe.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.session.observe(operation); const old = f.snapshot();
    await f.session.app.reset(operation); release(old);
    await expect(pending).rejects.toMatchObject({ code: 'NODE_STALE' });
  });
  it('rejects a locate result that returns after reset retired its admission', async () => {
    const f = fixture(); let release!: (value: ReturnType<typeof f.snapshot>['root']['children']) => void;
    f.locate.mockImplementationOnce(() => new Promise(resolve => { release = value => resolve(value!); }));
    const pending = f.session.locate(query, operation); const old = f.snapshot();
    await f.session.app.reset(operation); release(old.root.children);
    await expect(pending).rejects.toMatchObject({ code: 'NODE_STALE' });
  });
  it('keeps traced screen references non-actionable', async () => {
    const f = fixture(); let ref: NodeRef | undefined;
    f.session.screens.route(observation => { ref = observation.root; });
    f.session.screens.push(f.snapshot());
    expect(ref?.revision).toBe('s1');
    await expect(f.session.perform(ref!, { kind: 'tap' }, operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
    expect(f.perform).not.toHaveBeenCalled();
  });
  it('rejects cached locate reads after an observed identity scope transition', async () => {
    const f = fixture(); await f.session.observe(operation);
    const [ref] = await f.session.locate(query, operation);
    f.change('scope-b', '42'); await f.session.observe(operation);
    await expect(f.session.read(ref!, operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
  });
  it('atomically admits whole batches and rejects oversized trees before publishing evidence', () => {
    const evidence = new ReferenceEvidence(true); evidence.scopeOf('scope-a');
    evidence.capture([{ ref: { id: 'previous', revision: 'native' } }], 'b1');
    const large = Array.from({ length: 16_385 }, (_, i) => ({ ref: { id: `id-${i}`, revision: 'native' } }));
    expect(() => evidence.capture(large, 'b2')).toThrow(/capacity exceeded/);
    expect(evidence.resolve({ id: 'previous', revision: 'b1' }).revision).toBe('native');
    expect(() => evidence.resolve({ id: 'id-0', revision: 'b2' })).toThrow();
    const complete = large.slice(0, 16_383);
    evidence.capture(complete, 'b3', { id: 'viewport', revision: 'native' });
    expect(evidence.resolve({ id: 'id-0', revision: 'b3' }).revision).toBe('native');
    expect(evidence.resolve({ id: 'viewport', revision: 'b3' }).revision).toBe('native');
    expect(() => evidence.resolve({ id: 'previous', revision: 'b1' })).toThrow();
  });
  it('fails stale for evicted or forged presentation refs while leaving undecorated native refs unchanged', () => {
    const evidence = new ReferenceEvidence(true); evidence.scopeOf('scope-a');
    for (let i = 0; i <= 16_384; i++) evidence.capture([{ ref: { id: `id-${i}`, revision: 'native' } }], 'b1');
    expect(() => evidence.resolve({ id: 'id-0', revision: 'b1' })).toThrow();
    expect(() => evidence.resolve({ id: 'missing', revision: 'b2' })).toThrow();
    expect(evidence.resolve({ id: '@e2', revision: '41' })).toEqual({ id: '@e2', revision: '41' });
  });
});
