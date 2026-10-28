import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAX } from './ax-duplicate-summary.mjs';
const row = { nodeId: 'synthetic-secret-id', frameId: 'synthetic-secret-frame', backendDOMNodeId: 7, ignored: false, role: { type: 'role', value: 'synthetic-secret-role' }, name: { value: 'synthetic-secret-text' } };
test('identical rows preserve counts without any data values', () => {
  const result = summarizeAX({ nodes: [row, structuredClone(row), structuredClone(row)] });
  assert.equal(result.rowCount, 3); assert.equal(result.uniqueKeys, 1);
  assert.equal(result.duplicateKeys, 1); assert.equal(result.parsedIdenticalRows, 2);
  assert.equal(result.conflictingRows, 0);
  assert(!JSON.stringify(result).includes('synthetic-secret'));
});
test('every identity/graph/unknown field difference is conflicting, never exported', () => {
  for (const [field, value] of Object.entries({ frameId: 'other-secret', parentId: 'other-secret', childIds: ['other-secret'], ignored: true, role: null, unknownField: { secret: 'other-secret' }, backendDOMNodeId: 8 })) {
    const result = summarizeAX({ nodes: [row, { ...row, [field]: value }] });
    assert.equal(result.conflictingRows, 1); assert.equal(result.parsedIdenticalRows, 0);
    assert.equal(result.differingFields[field === 'unknownField' ? 'other' : field], 1);
    assert(!JSON.stringify(result).includes('other-secret'));
  }
});
test('numeric/string key collision and sentinel categories are closed', () => {
  for (const [key, category] of [['0', 'zero'], ['-1', 'negative'], ['', 'empty'], ['42', 'other']]) {
    const result = summarizeAX({ nodes: [{ nodeId: key }, { nodeId: key }] });
    assert.equal(result.idCategory[category], 1);
  }
  const result = summarizeAX({ nodes: [{ nodeId: '3' }, { nodeId: 3 }] });
  assert.equal(result.keyWireTypeCollisionRows, 1); assert.equal(result.conflictingRows, 1);
});
test('invalid or oversized replies fail closed', () => {
  for (const reply of [null, {}, { nodes: [null] }, { nodes: [{ nodeId: {} }] }, { nodes: [{ nodeId: Number.MAX_SAFE_INTEGER + 1 }] }, { nodes: Array(100_001).fill(row) }]) assert.throws(() => summarizeAX(reply));
});
