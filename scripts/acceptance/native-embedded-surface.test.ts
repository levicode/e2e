/** Native P42 regression evidence; the finished legacy comparison is immutable history, never executable oracle code. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { nativeEmbeddedSurfaceFacts, validSyntheticFact } from '../../packages/web/tests/helpers/synthetic-evidence.ts';

const root = join(import.meta.dirname, '../..');
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const source = readFileSync(join(root, 'packages/web/tests/integration/read-node-roles.test.ts'), 'utf8');
const caseStart = source.indexOf("  it('never makes a drawn or embedded surface");
const caseEnd = source.indexOf("  it('drops a name taken", caseStart);
const publicCase = source.slice(caseStart, caseEnd);
const nodes = [{ testId: 'canvas' }, { testId: 'svg', role: 'image' }, { testId: 'frame', role: 'iframe' }, { testId: 'host', role: 'textbox' }];

test('P42 projects all four exact native snapshot targets and retains only closed scalars', () => {
  const observed = nodes.map(node => ({ ...node, name: 'never retain name', value: 'never retain value', ref: 'never retain ref' }));
  const facts = nativeEmbeddedSurfaceFacts(observed);
  assert.deepEqual(facts, [0, 1, 2, 3].map(targetOrdinal => ({ kind: 'native-embedded-surface', targetOrdinal, count: 1, roleMatchesExpected: true })));
  assert.ok(facts.every(fact => validSyntheticFact(fact, 'P42')));
  assert.doesNotMatch(JSON.stringify(facts), /never retain|testId|name|value|ref|canvas|image|iframe|textbox/);
});

test('P42 never treats a missing or duplicated undefined-role canvas as a matching target', () => {
  const absent = nativeEmbeddedSurfaceFacts(nodes.slice(1));
  assert.deepEqual(absent[0], { kind: 'native-embedded-surface', targetOrdinal: 0, count: 0, roleMatchesExpected: false });
  const duplicate = nativeEmbeddedSurfaceFacts([...nodes, { testId: 'canvas' }]);
  assert.deepEqual(duplicate[0], { kind: 'native-embedded-surface', targetOrdinal: 0, count: 2, roleMatchesExpected: false });
  assert.deepEqual(nativeEmbeddedSurfaceFacts([]).map(fact => [fact.count, fact.roleMatchesExpected]), [[0, false], [0, false], [0, false], [0, false]]);
});

test('P42 preserves the historical wrong Canvas and SVG as false comparisons, not other-equals-other', () => {
  const facts = nativeEmbeddedSurfaceFacts([{ testId: 'canvas', role: 'Canvas' }, { testId: 'svg', role: 'graphics-document' }, ...nodes.slice(2)]);
  assert.deepEqual(facts.map(fact => fact.roleMatchesExpected), [false, false, true, true]);
  assert.doesNotMatch(JSON.stringify(facts), /Canvas|graphics-document/);
});

test('P42 retains the exact fixture, strict role assertion and every unrelated native role-test block', () => {
  const fixture = source.match(/const embeddedSurfaceHtml = `([\s\S]*?)`;/)?.[1]; assert.ok(fixture);
  assert.equal(sha256(fixture), '6b37c3e04140e1f7839faae7c22ceb7a1178d97242631289bbe2ab39b1aa823b');
  const assertion = publicCase.match(/expect\(roles,[\s\S]*?\.toStrictEqual\(\{ canvas: undefined, svg: 'image', frame: 'iframe', host: 'textbox' \}\);/)?.[0].replace(/^\s+/gm, '');
  assert.ok(assertion); assert.equal(sha256(assertion), '89f383dde0c278dc4a6077320886dafe43f537fcdbd99445f54299552cc140d4');
  const prefix = source.slice(source.indexOf("describe('role mapping'"), source.lastIndexOf('  //', source.indexOf('  const embeddedSurfaceHtml')));
  assert.equal(sha256(prefix), '5ee295d0290420041b547eff5aba406fbe807825abf9a1feb22a8e0203f54fe6');
  assert.equal(sha256(source.slice(caseEnd)), 'f090bf2c848350086232ef0b7d8c333e300822cecd80d337f876d68147318306');
});

test('P42 facts and the unique-count assertion use the original single snapshot without companion reads', () => {
  assert.equal((publicCase.match(/await capture\(\)/g) ?? []).length, 1);
  assert.match(publicCase, /const facts = nativeEmbeddedSurfaceFacts\(flatten\(tree\)\);\s*for \(const fact of facts\) evidence.record\(fact\);/);
  assert.match(publicCase, /expect\(facts.map\(fact => fact.count\)\).toStrictEqual\(\[1, 1, 1, 1\]\);/);
  assert.doesNotMatch(source, /canvas-oracle|recordCanvasOracle|pairCanvasNative|it\('P42O:/);
});

test('archived P42O raw evidence keeps its original identity and two native mismatches', () => {
  const history = JSON.parse(readFileSync(join(root, 'packages/web/tests/retirement/p42-oracle-history.json'), 'utf8')) as {
    baselineRevision: string;
    case: { status: string; recordsSha256: string; records: { kind: string; binding?: { sourceRevision: string; binarySha256: string }; fact?: { kind: string; targetOrdinal?: number; baselineIncluded?: boolean; nativeRoleEqualsBaseline?: boolean; unavailable?: boolean; truncated?: boolean }; outcome?: unknown }[] };
  };
  assert.equal(history.baselineRevision, 'd7c6b5e5a4c27fac7633e66866fd367b0351ead8');
  assert.equal(history.case.status, 'complete');
  assert.equal(sha256(JSON.stringify(history.case.records)), '9014fb2349f1baa6dc899d6dd506be5c8a1c25cc472799034f44015b9d06b482');
  assert.equal(history.case.recordsSha256, '9014fb2349f1baa6dc899d6dd506be5c8a1c25cc472799034f44015b9d06b482');
  assert.equal(history.case.records[0]?.binding?.sourceRevision, 'a52e2be3c94a32da08ea76aa731017d40f1b1a03');
  assert.equal(history.case.records[0]?.binding?.binarySha256, 'f56cd47feb07433156f7b25963ba0beb66ced001fedf35961353b6ec2fee2957');
  const facts = history.case.records.flatMap(record => record.fact?.kind === 'canvas-oracle' ? [record.fact] : []);
  assert.deepEqual(facts.map(fact => fact.targetOrdinal), [0, 1, 2, 3]);
  assert.ok(facts.every(fact => fact.baselineIncluded && !fact.unavailable && !fact.truncated));
  assert.deepEqual(facts.map(fact => fact.nativeRoleEqualsBaseline), [false, false, true, true]);
  assert.deepEqual(history.case.records.at(-1)?.outcome, { setup: 'passed', body: 'passed', cleanup: 'passed' });
});
