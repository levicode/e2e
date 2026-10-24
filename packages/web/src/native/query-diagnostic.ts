import type { LocatorExpression, SemanticQuery, TextPattern } from 'e2e/engine';
import { MAX_FRAME_BYTES } from './protocol.ts';

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
      case 'union': {
        const left = inspect(expression.left, depth + 1);
        const right = inspect(expression.right, depth + 1);
        if (left === undefined || right === undefined) return undefined;
        return { displayValue: false, unsupported: left.unsupported || right.unsupported || left.displayValue || right.displayValue };
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

/** Bounded feature detection only; undefined is not evidence that a query has no union. */
export function queryUsesUnion(root: LocatorExpression): boolean | undefined {
  let remaining = 4096;
  const inspect = (value: unknown, depth: number): boolean | undefined => {
    if (--remaining < 0 || depth > 64 || value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const expression = value as Record<string, unknown>;
    const kind = expression['kind'];
    if (kind === 'union') return true;
    if (typeof kind !== 'string' || !['query', 'filter', 'index', 'frame', 'selector'].includes(kind)) return undefined;
    let complete = !['filter', 'index', 'frame'].includes(kind) || expression['source'] !== undefined;
    // Inspect only expression edges, never arbitrary query values or metadata.
    // Even unexpected edges cannot conceal a union from an older runtime.
    for (const key of ['source', 'scope', 'has', 'left', 'right']) {
      if (expression[key] === undefined) continue;
      const union = inspect(expression[key], depth + 1);
      if (union === true) return true;
      if (union === undefined) complete = false;
    }
    return complete ? false : undefined;
  };
  return inspect(root, 0);
}

/** Copied request context only, never a second query or source of native authority. */
export interface FrameQueryDiagnostic { readonly selector: string; readonly index: number; readonly count: number }

/** Match native split_frame_expression's outer-to-inner order through source/scope. */
export function frameQuerySnapshot(root: LocatorExpression): readonly string[] | undefined {
  let remaining = 4096;
  let bytes = 0;
  const shape = (value: object, required: readonly string[], optional: readonly string[] = []): boolean =>
    !Array.isArray(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
  const pattern = (value: TextPattern): boolean => {
    if (value === null || typeof value !== 'object') return false;
    return value.kind === 'string' ? shape(value, ['kind', 'value', 'exact']) && typeof value.value === 'string' && typeof value.exact === 'boolean'
      : value.kind === 'regexp' && shape(value, ['kind', 'source', 'flags']) && typeof value.source === 'string' && typeof value.flags === 'string';
  };
  const query = (value: SemanticQuery): boolean => value !== null && typeof value === 'object'
    && shape(value, ['kind', 'value'], ['name', 'states', 'level', 'visible'])
    && ['role', 'label', 'placeholder', 'text', 'displayValue', 'testId'].includes(value.kind)
    && pattern(value.value) && (value.kind !== 'role' || value.value.kind === 'string')
    && (value.name === undefined || pattern(value.name))
    && (value.level === undefined || Number.isSafeInteger(value.level))
    && (value.visible === undefined || typeof value.visible === 'boolean')
    && (value.states === undefined || (value.states !== null && typeof value.states === 'object'
      && shape(value.states, [], ['checked', 'disabled', 'selected', 'expanded', 'pressed']) && Object.values(value.states).every(state => typeof state === 'boolean')));
  const inspect = (expression: LocatorExpression, depth: number): string[] | undefined => {
    if (--remaining < 0 || depth > 64 || expression === null || typeof expression !== 'object') return undefined;
    switch (expression.kind) {
      case 'frame': {
        if (!shape(expression, ['kind', 'selector', 'source']) || typeof expression.selector !== 'string' || expression.selector.length === 0 || expression.selector.length > MAX_FRAME_BYTES) return undefined;
        bytes += Buffer.byteLength(expression.selector);
        if (bytes > MAX_FRAME_BYTES) return undefined;
        const source = inspect(expression.source, depth + 1);
        return source === undefined || source.length >= 64 ? undefined : [expression.selector, ...source];
      }
      case 'union': {
        if (!shape(expression, ['kind', 'left', 'right'])) return undefined;
        const left = inspect(expression.left, depth + 1);
        const right = inspect(expression.right, depth + 1);
        return left !== undefined && right !== undefined && left.length === right.length && left.every((selector, index) => selector === right[index]) ? left : undefined;
      }
      case 'index':
        if (!shape(expression, ['kind', 'source', 'index']) || !((expression.index === 'first' || expression.index === 'last') || (typeof expression.index === 'number' && Number.isSafeInteger(expression.index) && expression.index >= 0))) return undefined;
        return inspect(expression.source, depth + 1);
      case 'filter': {
        if (!shape(expression, ['kind', 'source'], ['has', 'hasText']) || (expression.hasText !== undefined && !pattern(expression.hasText))) return undefined;
        if (expression.has !== undefined) {
          const has = inspect(expression.has, depth + 1);
          if (has === undefined || has.length !== 0) return undefined;
        }
        return inspect(expression.source, depth + 1);
      }
      case 'query':
        if (!shape(expression, ['kind', 'query'], ['scope']) || !query(expression.query)) return undefined;
        return expression.scope === undefined ? [] : inspect(expression.scope, depth + 1);
      case 'selector':
        return shape(expression, ['kind', 'selector']) && typeof expression.selector === 'string' && expression.selector.length > 0 ? [] : undefined;
      default: return undefined;
    }
  };
  const selectors = inspect(root, 0);
  return selectors === undefined ? undefined : Object.freeze(selectors);
}
