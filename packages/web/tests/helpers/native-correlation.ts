/** Fixture identity joins preserve all semantic data from the protected observation. */
import type { NodeRef, OperationContext, SemanticNode } from 'e2e/engine';
import type { NativeWebSurface } from '../../src/native/browser-contract.ts';

export type CorrelateObserved = (located: readonly NodeRef[], observed: readonly SemanticNode[], operation?: OperationContext) => Promise<(SemanticNode | null)[]>;

/** Flatten only snapshot.root (native tree.roots), never the separate viewport reference. */
export function observedNodes(root: SemanticNode): SemanticNode[] {
  return [root, ...(root.children ?? []).flatMap(observedNodes)];
}

/** Compare immutable acquisition bindings, not the target of a later live action. */
export function correlateObserved(surface: NativeWebSurface, operation: () => OperationContext): CorrelateObserved {
  return async (located, observed, current = operation()) => {
    const candidates = new Map(observed.map(node => [node.ref.id, node]));
    const result = await surface.command('fixture.correlate', {
      located: located.map(ref => ({ id: ref.id, revision: ref.revision })),
      observed: observed.map(node => ({ id: node.ref.id, revision: node.ref.revision })),
    }, current);
    return result.matches.map(ref => {
      if (ref === null) return null;
      const node = candidates.get(ref.id);
      if (node === undefined || node.ref.revision !== ref.revision) throw new Error('Correlated reference is absent from the protected observation');
      return node;
    });
  };
}
