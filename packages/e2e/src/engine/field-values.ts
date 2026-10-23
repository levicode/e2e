/** The closed, reference-free fixture value boundary shared by engine adapters. */
import { EngineError, type EngineFieldValues, type EngineReadField } from './contract.ts';

const FIELDS = ['role', 'name', 'text', 'value', 'selection', 'testId', 'inputPurpose', 'states', 'level', 'attributes', 'selector', 'framePath'] as const;
const STATES = new Set(['checked', 'disabled', 'selected', 'expanded', 'pressed', 'focused', 'hidden', 'secure']);
const invalid = (): never => { throw new EngineError('INVALID_STATE', 'Invalid fixture field projection', { retryable: false }); };
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  return value as Record<string, unknown>;
};

/** Reject unknown/duplicate fields, rather than silently widening a projection. */
export function validateEngineReadFields(fields: readonly EngineReadField[]): void {
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > FIELDS.length || new Set(fields).size !== fields.length || fields.some(field => !FIELDS.includes(field))) invalid();
}

/** No refs, geometry, children, unrequested fields, or unmarked secure values. */
export function decodeEngineFieldValues(value: unknown, fields: readonly EngineReadField[]): readonly EngineFieldValues[] {
  validateEngineReadFields(fields);
  if (!Array.isArray(value) || value.length > 100_000) return invalid();
  return value.map(entry => {
    const item = record(entry);
    const states = record(item['states']);
    if (typeof states['secure'] !== 'boolean' || Object.entries(states).some(([key, field]) => !STATES.has(key) || typeof field !== 'boolean' || (!fields.includes('states') && key !== 'secure'))) invalid();
    const secure = states['secure'];
    if (typeof secure !== 'boolean') return invalid();
    const result: Record<string, unknown> & { states: { secure: boolean } } = { states: { ...states, secure } };
    for (const [key, field] of Object.entries(item)) {
      if (key === 'states') continue;
      if (!fields.includes(key as EngineReadField)) invalid();
      if (key === 'attributes') {
        const attributes = record(field);
        if (Object.values(attributes).some(attribute => typeof attribute !== 'string') || (states['secure'] && Object.hasOwn(attributes, 'value'))) invalid();
        result[key] = { ...attributes };
      } else if (key === 'framePath') {
        if (!Array.isArray(field) || field.length > 256 || field.some(part => typeof part !== 'string')) invalid();
        result[key] = [...field as string[]];
      } else if (key === 'level') {
        if (!Number.isSafeInteger(field) || (field as number) < 0) invalid();
        result[key] = field;
      } else {
        if (typeof field !== 'string' || (states['secure'] && ['value', 'text', 'selection'].includes(key))) invalid();
        if (key === 'inputPurpose' && !['username', 'password', 'one-time-code', 'generic-secret', 'none'].includes(field as string)) invalid();
        result[key] = field;
      }
    }
    return result as EngineFieldValues;
  });
}
