import type { LocatorExpression } from 'e2e/engine';

export type QueryDiagnostic = 'display-value-composition';
interface Composition { readonly displayValue: boolean; readonly unsupported: boolean }

/** Diagnostic evidence only. Native validation still decides whether a query can run. */
export function queryDiagnostic(root: LocatorExpression): QueryDiagnostic | undefined {
  let remaining = 4096;
  const inspect = (expression: LocatorExpression, depth: number): Composition | undefined => {
    if (--remaining < 0 || depth > 64 || expression === null || typeof expression !== 'object') return undefined;
    switch (expression.kind) {
      case 'query': {
        const query = expression.query;
        if (query === null || typeof query !== 'object' || !['role', 'label', 'placeholder', 'text', 'displayValue', 'testId'].includes(query.kind)) return undefined;
        const scope = expression.scope === undefined ? { displayValue: false, unsupported: false } : inspect(expression.scope, depth + 1);
        if (scope === undefined) return undefined;
        // A child query has its own kind. A display-value scope is the refusal,
        // not provenance carried through an otherwise ordinary child query.
        return { displayValue: query.kind === 'displayValue', unsupported: scope.unsupported || scope.displayValue };
      }
      case 'filter': {
        const source = inspect(expression.source, depth + 1);
        const has = expression.has === undefined ? { displayValue: false, unsupported: false } : inspect(expression.has, depth + 1);
        if (source === undefined || has === undefined) return undefined;
        return { displayValue: source.displayValue, unsupported: source.unsupported || has.unsupported || has.displayValue };
      }
      case 'index':
      case 'frame': return inspect(expression.source, depth + 1);
      case 'selector': return { displayValue: false, unsupported: false };
      default: return undefined;
    }
  };
  return inspect(root, 0)?.unsupported === true ? 'display-value-composition' : undefined;
}
