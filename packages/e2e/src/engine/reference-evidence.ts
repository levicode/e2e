/** Private bridge between presentation revisions and exact engine-owned reference evidence. */
import { EngineError } from './contract.ts';
import type { NodeRef, SemanticNode } from './index.ts';
const LIMIT = 16_384;
const key = (ref: NodeRef) => JSON.stringify([ref.revision, ref.id]);
export class ReferenceEvidence {
  // Query churn must not evict references from the current observed screen.
  private readonly observed = new Map<string, { ref: NodeRef; scope: string | undefined }>();
  private readonly located = new Map<string, { ref: NodeRef; scope: string | undefined }>();
  private scope: string | undefined;
  private readonly retiredScopes = new Set<string | undefined>();
  private initialized = false;
  private epoch = 0;
  constructor(private readonly enabled: boolean) {}
  checkpoint(): number { return this.epoch; }
  assert(epoch: number): void { if (this.enabled && epoch !== this.epoch) throw this.stale(); }
  retire(): void { if (this.enabled) { this.observed.clear(); this.located.clear(); this.epoch += 1; } }
  scopeOf(scope: string | undefined, epoch = this.epoch): void {
    if (!this.enabled) return;
    this.assert(epoch);
    if (this.retiredScopes.has(scope)) throw this.stale();
    if (this.initialized && this.scope !== scope) {
      if (this.retiredScopes.size >= 4096) throw new EngineError('INVALID_STATE', 'Engine reference scope history capacity exceeded', { retryable: false });
      this.retiredScopes.add(this.scope); this.retire();
    }
    this.scope = scope; this.initialized = true;
  }
  capture(nodes: readonly SemanticNode[], revision: string, viewport?: NodeRef, purpose: 'observe' | 'locate' = 'observe'): void {
    if (!this.enabled) return;
    const refs = purpose === 'observe' ? this.observed : this.located;
    if (nodes.length > LIMIT) throw new EngineError('INVALID_STATE', 'Engine reference tree capacity exceeded', { retryable: false });
    const staged = new Map<string, NodeRef>();
    const stack = nodes.map(node => ({ node, depth: 0 }));
    let visits = 0;
    const add = (ref: NodeRef) => {
      const id = key({ id: ref.id, revision });
      const existing = staged.get(id) ?? refs.get(id)?.ref;
      if (existing && existing.revision !== ref.revision) throw new EngineError('INVALID_STATE', 'Conflicting engine reference evidence', { retryable: false });
      staged.set(id, { ...ref });
      if (staged.size > LIMIT) throw new EngineError('INVALID_STATE', 'Engine reference batch capacity exceeded', { retryable: false });
    };
    while (stack.length) {
      const { node, depth } = stack.pop()!;
      if (++visits > LIMIT || depth > 256) throw new EngineError('INVALID_STATE', 'Engine reference tree capacity exceeded', { retryable: false });
      add(node.ref);
      for (const child of node.children ?? []) {
        if (stack.length >= LIMIT) throw new EngineError('INVALID_STATE', 'Engine reference tree capacity exceeded', { retryable: false });
        stack.push({ node: child, depth: depth + 1 });
      }
    }
    if (viewport) add(viewport);
    // Atomically admit a complete current batch, pruning only older evidence.
    for (const id of staged.keys()) refs.delete(id);
    while (refs.size + staged.size > LIMIT) refs.delete(refs.keys().next().value!);
    for (const [id, ref] of staged) refs.set(id, { ref, scope: this.scope });
  }
  resolve(ref: NodeRef): NodeRef {
    if (!this.enabled) return ref;
    const evidence = this.observed.get(key(ref)) ?? this.located.get(key(ref));
    if (evidence && evidence.scope === this.scope) return { ...evidence.ref };
    // Undecorated engine refs remain engine-validated. Never reinterpret a missing
    // core presentation ref as current engine authority or reconstruct it by id.
    if (/^[bls]\d+$/.test(ref.revision)) throw this.stale();
    return ref;
  }
  private stale(): EngineError { return new EngineError('NODE_STALE', 'Engine reference evidence has retired; re-resolve', { retryable: true }); }
}
