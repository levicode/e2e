/**
 * The one JSON-safety walker. Anything crossing a boundary that demands plain
 * JSON — fixture evaluation arguments and results, `agent.act` params — validates
 * here, so cycle detection, plain-prototype checks, and secret rejection
 * cannot drift between call sites.
 */

import { isSecret } from '../secrets.ts';
import { ConfigurationError, TestError } from './errors.ts';

export interface JsonValueRules {
  /** Raised on a Secret value; the default denies with POLICY_DENIED. */
  readonly onSecret?: (label: string) => never;
  /** Maximum object/array nesting depth; unlimited when omitted. */
  readonly maxDepth?: number;
}

/** Validates that a value is JSON-safe, throwing a labeled TestError otherwise. */
export function validateJsonValue(value: unknown, label: string, rules: JsonValueRules = {}): void {
  if (value === undefined) return;
  const onSecret =
    rules.onSecret ??
    ((at: string): never => {
      throw new ConfigurationError('POLICY_DENIED', `${at} must not contain a Secret`);
    });
  const problem = jsonValueProblem(value, rules.maxDepth, item => {
    if (isSecret(item)) onSecret(label);
  });
  if (problem === undefined) return;
  const detail = problem === 'depth' ? `exceeds ${rules.maxDepth} levels of nesting`
    : problem === 'non-finite' ? 'contains a non-finite number'
    : problem === 'cycle' ? 'contains a cycle'
    : problem === 'prototype' ? 'must be JSON-safe'
    : `must be JSON-safe, found ${problem}`;
  throw new TestError('INVALID_ARGUMENT', `${label} ${detail}`);
}

/**
 * Portable traversal shared with page-side result validation. When requested,
 * snapshot receives only values inspected in this walk, never live accessors.
 */
export function jsonValueProblem(
  value: unknown,
  maxDepth?: number,
  onObject?: (item: object) => void,
  snapshot?: { value: unknown },
): 'depth' | 'non-finite' | 'cycle' | 'prototype' | 'undefined' | 'function' | 'symbol' | 'bigint' | undefined {
  if (value === undefined) {
    if (snapshot !== undefined) snapshot.value = undefined;
    return;
  }
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number, write?: (value: unknown) => void): ReturnType<typeof jsonValueProblem> => {
    if (maxDepth !== undefined && depth > maxDepth) return 'depth';
    if (item === null) { write?.(null); return; }
    switch (typeof item) {
      case 'string':
      case 'boolean': write?.(item); return;
      case 'number':
        if (!Number.isFinite(item)) return 'non-finite';
        write?.(item); return;
      case 'object': {
        onObject?.(item);
        if (ancestors.has(item)) return 'cycle';
        if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return 'prototype';
        ancestors.add(item);
        const copy = write === undefined ? undefined : Array.isArray(item) ? [] : Object.create(null) as object;
        const indexed = function* (items: unknown[]): Generator<readonly [string, unknown]> {
          let index = 0;
          for (const entry of items) yield [String(index++), entry];
        };
        const entries = Array.isArray(item) ? indexed(item) : Object.entries(item);
        for (const [key, entry] of entries) {
          const problem = visit(entry, depth + 1, copy === undefined ? undefined : copied => {
            Object.defineProperty(copy, key, { value: copied, enumerable: true, configurable: true, writable: true });
          });
          if (problem !== undefined) return problem;
        }
        ancestors.delete(item);
        write?.(copy);
        return;
      }
      default: return typeof item as 'undefined' | 'function' | 'symbol' | 'bigint';
    }
  };
  return visit(value, 0, snapshot === undefined ? undefined : copied => { snapshot.value = copied; });
}
