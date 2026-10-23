/** Node-only checks of static evidence domains. No browser, native process, or fixture action. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { conformanceCoordinateKey, conformanceSourceDomain, loadConformanceTables } from '../../packages/web/tests/helpers/conformance-evidence.ts';

const root = resolve(import.meta.dirname, '../..');
const tables = loadConformanceTables(root);
const expected = readFileSync(resolve(root, 'packages/web/tests/conformance/expected.txt'), 'utf8');

test('the exact synthetic corpus supplies a unique legal field for every target', () => {
  const domain = conformanceSourceDomain(tables, expected);
  assert.equal(domain.tables.length, 2);
  assert.equal(domain.tables[0]!.expectedCases, 88);
  assert.equal(domain.tables[1]!.expectedCases, 144);
  assert.equal(domain.coordinates.size, domain.tables.reduce((count, table) => count + table.expectedComparisons, 0));
  assert.equal(domain.coordinates.size, domain.tables.reduce((count, table) => count + table.expectedTargets, 0));
  for (const [key, coordinate] of domain.coordinates) assert.equal(key, conformanceCoordinateKey(coordinate));
});

test('expected disagreements map uniquely to their physical source lines and original coordinates', () => {
  const domain = conformanceSourceDomain(tables, expected);
  const lines = expected.split('\n');
  assert.equal(domain.expectations.size, 16);
  const coordinates = new Set<string>();
  for (const [key, row] of domain.expectations) {
    assert.equal(lines[row.expectedLineOrdinal - 1], `${key} | ${row.reason}`);
    const coordinateKey = conformanceCoordinateKey(row.coordinate);
    assert.ok(domain.coordinates.has(coordinateKey));
    assert.ok(!coordinates.has(coordinateKey)); coordinates.add(coordinateKey);
  }
});

test('ambiguous fields, table order, expectation keys and physical-line ownership fail closed', () => {
  assert.throws(() => conformanceSourceDomain({ 'accessible-text': tables['accessible-text']!, 'implicit-role': tables['implicit-role']! }, expected));
  assert.throws(() => conformanceSourceDomain({ ...tables, 'implicit-role': [{ html: '', target: 'x', role: 'button', accessibleText: '' }] }, ''));
  const first = expected.split('\n').find(line => line.startsWith('axe:'))!;
  assert.throws(() => conformanceSourceDomain(tables, `${expected}\n${first}\n`));
  assert.throws(() => conformanceSourceDomain(tables, `${expected}\n${first.replace('ours  |', 'ours changed |')}\n`));
  assert.throws(() => conformanceSourceDomain(tables, `${expected}\naxe: missing | axe name | #0 x | ours a | theirs b | reason\n`));
});
