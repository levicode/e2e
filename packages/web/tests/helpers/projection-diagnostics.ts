/** Failure messages for synthetic fixtures only. No page-derived string is an output field. */
import { createHash } from 'node:crypto';

const GROUPS = ['hrefs', 'headers', 'inline-svg', 'vocabulary', 'editing-hosts', 'embedded-surfaces', 'editor-before', 'editor-after', 'announcer-empty', 'announcer-populated', 'select-visibility'] as const;
type Group = typeof GROUPS[number];
const BOOLEAN_FIELDS = ['missing', 'roleMatches', 'nameMatches', 'valueMatches', 'hrefMatches', 'nameMissing', 'valueMissing', 'hrefMissing'] as const;
const COUNT_FIELDS = ['presentCount', 'nameLength', 'valueLength', 'hrefLength'] as const;
type Fact = { readonly ordinal: number } & Partial<Record<typeof BOOLEAN_FIELDS[number], boolean>> & Partial<Record<typeof COUNT_FIELDS[number], number>>;
interface Counts { readonly observedCount: number; readonly expectedCount?: number }
export const PROJECTION_MAX_RECORDS = 32;
export const PROJECTION_MAX_BYTES = 4096;

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Bind fixture ordinals to the exact calling test source, not a drifting list or a
 * page-provided ID. Callers read their own source once and supply only facts from
 * values their assertions already acquired. This pure formatter never logs,
 * observes a browser, changes assertions, or serializes arbitrary input fields.
 */
export function projectionDiagnostics(testSource: string): (group: Group, counts: Counts, facts: readonly Fact[]) => string {
  const sourceSha256 = createHash('sha256').update(testSource).digest('hex');
  return (group, counts, facts) => {
    const validGroup = GROUPS.includes(group);
    const records: Fact[] = [];
    const encode = () => JSON.stringify({
      schema: 'synthetic-projection-v1', sourceSha256, group: validGroup ? group : 'invalid',
      observedCount: count(counts.observedCount), expectedCount: count(counts.expectedCount),
      records, omittedRecords: facts.length - records.length, truncated: records.length < facts.length,
    });
    if (!validGroup) return encode();
    for (let index = 0; index < Math.min(facts.length, PROJECTION_MAX_RECORDS); index++) {
      const fact = facts[index]!;
      const ordinal = count(fact.ordinal);
      if (ordinal === null) continue;
      // Rebuild from the closed schema. Never spread input, stringify it, or copy toJSON.
      const record: { ordinal: number } & Partial<Record<typeof BOOLEAN_FIELDS[number], boolean>> & Partial<Record<typeof COUNT_FIELDS[number], number>> = { ordinal };
      for (const field of BOOLEAN_FIELDS) {
        const value = fact[field];
        if (typeof value === 'boolean') record[field] = value;
      }
      for (const field of COUNT_FIELDS) {
        const value = count(fact[field]);
        if (value !== null) record[field] = value;
      }
      records.push(record);
      if (Buffer.byteLength(encode(), 'utf8') > PROJECTION_MAX_BYTES) {
        records.pop();
        break;
      }
    }
    return encode();
  };
}
