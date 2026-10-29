/** Preserve native identities. Native owns issuance, kind checks and retirement. */
import { EngineError, type LocatorAction, type NodeRef, type SemanticNode } from 'e2e/engine';
import { snapshotCorrelationArgs } from './browser-decode.ts';
import type { BrowserCommandMap } from './browser-contract.ts';

export interface ReferenceOwner {
  readonly attempt: object;
  readonly client: object;
  readonly scope: string;
  readonly epoch: number;
  readonly publication: number;
  readonly owns: () => boolean;
}
const key = (ref: NodeRef): string => JSON.stringify([ref.id, ref.revision]);
const stale = (): EngineError => new EngineError('NODE_STALE', 'The web reference publication owner has retired', { retryable: true });

/** No reference registry, selector resolution, ID allocation or native revision rewriting. */
export class NativeReferenceBridge {
  private owner: ReferenceOwner | undefined;
  private retirement: object = {};
  // E2E's root swipe means viewport swipe. This pair is semantic routing only:
  // native must still validate the exact viewport issuance at dispatch.
  private rootViewport: { root: NodeRef; viewport: NodeRef } | undefined;

  retire(): void { this.rootViewport = undefined; this.retirement = {}; }

  private scopeOf(owner: ReferenceOwner): void {
    if (!owner.owns()) throw stale();
    const prior = this.owner;
    if (prior !== undefined && (prior.attempt !== owner.attempt || prior.client !== owner.client
      || prior.scope !== owner.scope || prior.epoch !== owner.epoch || prior.publication !== owner.publication)) this.retire();
    this.owner = owner;
  }

  capture(owner: ReferenceOwner, nodes: readonly SemanticNode[], viewport?: NodeRef, purpose: 'observe' | 'locate' | 'pixels' = 'observe'): { nodes: SemanticNode[]; viewport?: NodeRef } {
    this.scopeOf(owner);
    const result = this.copy(nodes, viewport);
    if (purpose !== 'locate') this.rootViewport = nodes[0] === undefined || viewport === undefined
      ? undefined : { root: { ...nodes[0].ref }, viewport: { ...viewport } };
    return result;
  }

  action(owner: ReferenceOwner, ref: NodeRef, action: LocatorAction): { ref: NodeRef; action: LocatorAction } {
    this.scopeOf(owner);
    const pair = this.rootViewport;
    const target = action.kind === 'swipe' && pair !== undefined && key(ref) === key(pair.root) ? pair.viewport : ref;
    return { ref: { ...target }, action: action.kind === 'dragTo' ? { ...action, target: { ...action.target } } : action };
  }

  correlation(owner: ReferenceOwner, value: unknown): {
    args: BrowserCommandMap['fixture.correlate']['args'];
    project: (matches: (NodeRef | null)[]) => (NodeRef | null)[];
  } {
    this.scopeOf(owner);
    const retirement = this.retirement;
    // Decoder snapshots exact shape and strings. Only native validates issuance.
    const args = snapshotCorrelationArgs(value);
    const observed = new Set(args.observed.map(key));
    return { args, project: matches => {
      this.scopeOf(owner);
      if (this.retirement !== retirement) throw stale();
      return matches.map(ref => {
        if (ref === null) return null;
        if (!observed.has(key(ref))) throw new EngineError('INVALID_STATE', 'The native fixture correlation returned a different reference', { retryable: false });
        return { ...ref };
      });
    } };
  }

  /** Native trace uses a disposable ref map; copying never grants action authority. */
  trace(nodes: readonly SemanticNode[], viewport?: NodeRef): { nodes: SemanticNode[]; viewport?: NodeRef } {
    return this.copy(nodes, viewport);
  }

  private copy(nodes: readonly SemanticNode[], viewport?: NodeRef): { nodes: SemanticNode[]; viewport?: NodeRef } {
    const project = (node: SemanticNode): SemanticNode => ({ ...node, ref: { ...node.ref },
      ...(node.children === undefined ? {} : { children: node.children.map(project) }) });
    return { nodes: nodes.map(project), ...(viewport === undefined ? {} : { viewport: { ...viewport } }) };
  }
}
