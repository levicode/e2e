import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireVerified } from './readiness.ts';
const expected = { manifestHash: 'a'.repeat(64), coreEntry: 'file:///core/runner.js', webEntry: 'file:///web/index.js', nativeSha256: 'b'.repeat(64) };
for (const value of [false, undefined, null, {}, { status: 'blocked' }, { status: 'verified', capabilities: ['browser.scope/1', 'browser.evaluate/1'] }]) test(`readiness rejects ${JSON.stringify(value)}`, () => {
  assert.throws(() => requireVerified(value, expected));
});
test('complete fixture proof is accepted only for the bound package entries and binary', () => {
  const proof = { status: 'verified', manifestHash: expected.manifestHash, nativeSha256: expected.nativeSha256, source: { commit: 'c'.repeat(40), tree: 'd'.repeat(40) }, protocol: 'fixture-only', capabilities: ['scope', 'lifecycle', 'evaluate', 'page', 'observe', 'query', 'actions', 'network', 'dialog', 'download', 'capture', 'state', 'recording', 'blobs'].map(name => `browser.${name}/1`), installed: { core: { entry: expected.coreEntry, inventorySha256: 'e'.repeat(64) }, web: { entry: expected.webEntry, inventorySha256: 'f'.repeat(64) } } };
  assert.equal(requireVerified(proof, expected), proof);
  assert.throws(() => requireVerified(proof, { ...expected, nativeSha256: '0'.repeat(64) }));
  assert.throws(() => requireVerified(proof, { ...expected, webEntry: 'file:///other/index.js' }));
});
