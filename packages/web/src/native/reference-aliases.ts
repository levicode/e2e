/** Web presentation aliases retain exact native authority; they never resolve selectors. */
import { EngineError, type LocatorAction, type NodeRef, type SemanticNode } from 'e2e/engine';
import { snapshotCorrelationArgs } from './browser-decode.ts';
import type { BrowserCommandMap } from './browser-contract.ts';

// Original Web locator references are a FIFO independent of the observed generation.
const MAX_LOCATED_REFS = 2048;
type Kind = 'element' | 'viewport';
export interface ReferenceOwner {
  readonly attempt: object;
  readonly client: object;
  readonly scope: string;
  readonly epoch: number;
  readonly publication: number;
  readonly owns: () => boolean;
}
interface Evidence { readonly ref: NodeRef; readonly kind: Kind }
const key = (ref: NodeRef): string => JSON.stringify([ref.id, ref.revision]);
const stale = (): EngineError => new EngineError('NODE_STALE', 'The web reference has retired; re-resolve or observe the screen again', { retryable: true });

/** Presentation counters survive replacement; names never rebind to unrelated native identities. */
export class NativeReferenceAliases {
  private next = 0;
  // Native observed IDs are durable element identities, not capture ordinals.
  // Even ordinals encode those identities in a non-recycled owner namespace;
  // odd ordinals are fresh locator/viewport/trace aliases. No dormant authority is kept.
  private observedOffset = 0n;
  private observedHighWater = 0n;
  private owner: ReferenceOwner | undefined;
  private observation = new Map<string, Evidence>();
  private viewport: NodeRef | undefined;
  private readonly located = new Map<string, Evidence>();

  /** Clear current authority, not the identity of a still-live native element. */
  retire(): void { this.observation.clear(); this.located.clear(); this.viewport = undefined; }

  private scopeOf(owner: ReferenceOwner): void {
    if (!owner.owns()) throw stale();
    const prior = this.owner;
    const identityChanged = prior !== undefined && (prior.attempt !== owner.attempt || prior.client !== owner.client
      || prior.scope !== owner.scope || prior.epoch !== owner.epoch);
    // A positive native ordinal in the new namespace is above every earlier
    // observed alias. Publication fences revoke authority, not element identity.
    if (identityChanged) this.observedOffset = this.observedHighWater;
    if (prior === undefined || identityChanged || prior.publication !== owner.publication) this.retire();
    this.owner = owner;
  }

  /** Swap one complete observed generation, or append independently bounded locator refs. */
  capture(owner: ReferenceOwner, nodes: readonly SemanticNode[], viewport?: NodeRef, purpose: 'observe' | 'locate' | 'pixels' = 'observe'): { nodes: SemanticNode[]; viewport?: NodeRef } {
    this.scopeOf(owner);
    const aliases = new Map<string, NodeRef>();
    const staged = new Map<string, Evidence>();
    const reference = (ref: NodeRef, kind: Kind, root = false): NodeRef => {
      const source = key(ref);
      let alias = aliases.get(source);
      if (alias === undefined) {
        // The root needs a capture guard even when its native text repeats.
        // Non-root observations retain identity only from the exact native ID;
        // public IDs are never decoded to recover or manufacture authority.
        alias = root ? { id: 'root', revision: `r${this.allocate().slice(1)}` }
          : { id: purpose === 'locate' || kind === 'viewport' ? this.allocate() : this.observedId(ref), revision: ref.revision };
        aliases.set(source, alias); staged.set(key(alias), { ref: { ...ref }, kind });
      } else if (staged.get(key(alias))!.kind !== kind) {
        throw new EngineError('INVALID_STATE', 'A native reference changed capability kind', { retryable: false });
      }
      return { ...alias };
    };
    const project = (node: SemanticNode, root = false): SemanticNode => ({ ...node, ref: reference(node.ref, root && purpose === 'pixels' ? 'viewport' : 'element', root),
      ...(node.children === undefined ? {} : { children: node.children.map(child => project(child)) }) });
    const projected = nodes.map((node, index) => project(node, purpose !== 'locate' && index === 0));
    const projectedViewport = viewport === undefined ? undefined : reference(viewport, 'viewport');
    if (purpose !== 'locate') { this.observation = staged; this.viewport = projectedViewport; }
    else {
      for (const [id, evidence] of staged) this.located.set(id, evidence);
      while (this.located.size > MAX_LOCATED_REFS) this.located.delete(this.located.keys().next().value!);
    }
    return { nodes: projected, ...(projectedViewport === undefined ? {} : { viewport: projectedViewport }) };
  }

  /** Neither arbitrary native IDs nor a different revision can acquire authority. */
  resolve(owner: ReferenceOwner, ref: NodeRef, kind?: Kind): NodeRef {
    this.scopeOf(owner);
    const entry = this.observation.get(key(ref)) ?? this.located.get(key(ref));
    if (entry === undefined) throw stale();
    if (kind !== undefined && entry.kind !== kind) throw new EngineError('INVALID_STATE', 'A viewport reference accepts only viewport swipe operations', { retryable: false });
    return { ...entry.ref };
  }

  /** Both drag endpoints are translated before any native command can dispatch. */
  action(owner: ReferenceOwner, ref: NodeRef, action: LocatorAction): { ref: NodeRef; action: LocatorAction } {
    const native = this.resolve(owner, ref, action.kind === 'swipe' ? undefined : 'element');
    if (ref.id === 'root' && action.kind === 'swipe' && this.viewport !== undefined) return { ref: this.resolve(owner, this.viewport, 'viewport'), action };
    return { ref: native, action: action.kind === 'dragTo' ? { ...action, target: this.resolve(owner, action.target, 'element') } : action };
  }

  /** The private diagnostic join accepts only exact already-issued public candidates. */
  correlation(owner: ReferenceOwner, value: unknown): {
    args: BrowserCommandMap['fixture.correlate']['args'];
    project: (matches: (NodeRef | null)[]) => (NodeRef | null)[];
  } {
    const invalid = (): never => { throw new EngineError('INVALID_STATE', 'The native fixture correlation request does not match its contract', { retryable: false }); };
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).toSorted().join(',') !== 'located,observed'
      || !('located' in value) || !('observed' in value) || !Array.isArray(value.located) || !Array.isArray(value.observed)) return invalid();
    if (value.located.length + value.observed.length > 100_000) return invalid();
    const snapshot = (values: unknown[]): NodeRef[] => Array.from(values, ref => {
      if (ref === null || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).toSorted().join(',') !== 'id,revision'
        || !('id' in ref) || !('revision' in ref) || typeof ref.id !== 'string' || typeof ref.revision !== 'string') return invalid();
      return { id: ref.id, revision: ref.revision };
    });
    const located = snapshot(value.located); const observed = snapshot(value.observed);
    const args = snapshotCorrelationArgs({
      located: located.map(ref => this.resolve(owner, ref, 'element')),
      observed: observed.map(ref => this.resolve(owner, ref, 'element')),
    });
    const publicRefs = new Map(args.observed.map((ref, index) => [key(ref), observed[index]!]));
    return { args, project: matches => {
      this.scopeOf(owner);
      return matches.map(ref => {
        if (ref === null) return null;
        const alias = publicRefs.get(key(ref));
        if (alias === undefined) return invalid();
        // A retirement between dispatch and publication cannot renew these candidates.
        this.resolve(owner, alias, 'element');
        return { ...alias };
      });
    } };
  }

  /** Trace IDs have a disjoint display lifetime and are never entered as evidence. */
  trace(nodes: readonly SemanticNode[], viewport?: NodeRef): { nodes: SemanticNode[]; viewport?: NodeRef } {
    const aliases = new Map<string, string>();
    const reference = (ref: NodeRef, root = false): NodeRef => {
      let id = aliases.get(ref.id);
      if (id === undefined) { id = this.allocate(); aliases.set(ref.id, id); }
      return root ? { id: 'root', revision: `t${id.slice(1)}` } : { id, revision: ref.revision };
    };
    const project = (node: SemanticNode, root = false): SemanticNode => ({ ...node, ref: reference(node.ref, root), ...(node.children === undefined ? {} : { children: node.children.map(child => project(child)) }) });
    return { nodes: nodes.map((node, index) => project(node, index === 0)), ...(viewport === undefined ? {} : { viewport: reference(viewport) }) };
  }

  private observedId(ref: NodeRef): string {
    if (!/^@e[1-9][0-9]*$/.test(ref.id)) throw new EngineError('INVALID_STATE', 'An observed native reference has invalid identity', { retryable: false });
    const ordinal = this.observedOffset + BigInt(ref.id.slice(2));
    if (ordinal > this.observedHighWater) this.observedHighWater = ordinal;
    return `n${2n * ordinal}`;
  }

  private allocate(): string {
    if (this.next >= Number.MAX_SAFE_INTEGER) throw new EngineError('INVALID_STATE', 'Web reference identity space exhausted', { retryable: false });
    return `n${2n * BigInt(++this.next) - 1n}`;
  }
}
