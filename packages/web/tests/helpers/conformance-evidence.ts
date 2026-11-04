/** Static synthetic corpus coordinates only. Shared by the producer and artifact verifier, never a page reader. */
import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface AxeCase {
  readonly html: string;
  readonly target: string | readonly string[];
  readonly role?: string | null;
  readonly accessibleText?: string | readonly string[];
}
const require = createRequire(import.meta.url);
export type ConformanceTables = Readonly<Record<string, readonly AxeCase[]>>;
/** Call only after the two fixed source files have been bound to the candidate source manifest. */
export function loadConformanceTables(sourceRoot: string): ConformanceTables {
  return {
    'implicit-role': require(join(sourceRoot, 'packages/web/tests/conformance/axe-core/implicit-role.cjs')) as AxeCase[],
    'accessible-text': require(join(sourceRoot, 'packages/web/tests/conformance/axe-core/accessible-text.cjs')) as AxeCase[],
  };
}
export interface ConformanceCoordinate {
  tableOrdinal: 0 | 1;
  caseOrdinal: number;
  targetOrdinal: number;
  field: 'role' | 'name';
}
export const conformanceCoordinateKey = (row: ConformanceCoordinate): string =>
  `${row.tableOrdinal}:${row.caseOrdinal}:${row.targetOrdinal}:${row.field}`;
const conformanceList = <T,>(value: T | readonly T[]): readonly T[] => Array.isArray(value) ? value : [value as T];

/** The source, not producer output, defines the legal domain and expected counts. */
export function conformanceSourceDomain(sourceTables: ConformanceTables, expectedSource: string) {
  if (Object.keys(sourceTables).join(',') !== 'implicit-role,accessible-text') throw new Error('Unexpected synthetic table order');
  const coordinates = new Map<string, ConformanceCoordinate>();
  const prefixes = new Map<string, ConformanceCoordinate>();
  const tables = Object.entries(sourceTables).map(([table, cases], ordinal) => {
    const tableOrdinal = ordinal as 0 | 1;
    let expectedTargets = 0;
    let expectedComparisons = 0;
    for (const [caseOrdinal, entry] of cases.entries()) {
      for (const [targetOrdinal, selector] of conformanceList(entry.target).entries()) {
        expectedTargets++;
        const fields: ('role' | 'name')[] = [];
        if (entry.role !== undefined) fields.push('role');
        if (entry.accessibleText !== undefined) fields.push('name');
        if (fields.length !== 1) throw new Error('Ambiguous synthetic summary field');
        for (const field of fields) {
          const coordinate = { tableOrdinal, caseOrdinal, targetOrdinal, field };
          const key = conformanceCoordinateKey(coordinate);
          const prefix = `axe: ${table} | axe ${field} | #${caseOrdinal} ${selector} | ours `.replaceAll('\n', ' ');
          if (coordinates.has(key) || prefixes.has(prefix)) throw new Error('Ambiguous synthetic conformance coordinate');
          coordinates.set(key, coordinate);
          prefixes.set(prefix, coordinate);
          expectedComparisons++;
        }
      }
    }
    return { tableOrdinal, expectedCases: cases.length, expectedTargets, expectedComparisons };
  });
  const expectations = new Map<string, { coordinate: ConformanceCoordinate; expectedLineOrdinal: number; reason: string }>();
  const expectedCoordinates = new Set<string>();
  for (const [lineIndex, line] of expectedSource.split('\n').entries()) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const cut = line.lastIndexOf(' | ');
    const key = line.slice(0, cut);
    const candidates = [...prefixes].filter(([prefix]) => key.startsWith(prefix));
    if (cut < 0 || candidates.length !== 1 || expectations.has(key)) throw new Error('Unmapped synthetic conformance expectation');
    const coordinateKey = conformanceCoordinateKey(candidates[0]![1]);
    if (expectedCoordinates.has(coordinateKey)) throw new Error('Ambiguous synthetic expected line');
    expectedCoordinates.add(coordinateKey);
    expectations.set(key, { coordinate: candidates[0]![1], expectedLineOrdinal: lineIndex + 1, reason: line.slice(cut + 3) });
  }
  return { coordinates, tables, expectations };
}
