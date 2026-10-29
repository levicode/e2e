/** Pure inventory/parser controls; does not execute a native test or browser. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CANDIDATE_NATIVE_CONTRACTS, CANDIDATE_NATIVE_DIAGNOSTICS } from './candidate-manifest.ts';
import { REQUIRED_NATIVE_FEATURE_TESTS } from './candidate-native-matrix-manifest.ts';
import { REQUIRED_ENCODER_CONTRACTS } from './candidate-video-manifest.ts';
import { verifyNativeInventory } from './candidate-native.ts';
import { verifyFeatureDelta } from './candidate-native-matrix.ts';
const listing = (names: readonly string[]) => names.map(name => `${name}: test`).join('\n');

// Independent fixed seals of the reviewed exact-name sets (61/46/21), not
// counts derived from the implementation. Renames or same-size substitutions fail.
test('reviewed Linux inventory identities remain exact, not merely equal-sized', () => {
  assert.equal(CANDIDATE_NATIVE_CONTRACTS.length, 46);
  assert.equal(createHash('sha256').update(JSON.stringify(CANDIDATE_NATIVE_CONTRACTS.toSorted())).digest('hex'), 'b066d0b5cd870febe05a5c942dc68bd2727f3f6bef4f9afbe09a0f15c17732b8');
  assert.equal(REQUIRED_NATIVE_FEATURE_TESTS.length, 61);
  assert.equal(createHash('sha256').update(JSON.stringify(REQUIRED_NATIVE_FEATURE_TESTS.toSorted())).digest('hex'), '90f97b3e1a84b58fdf11f0d18b3a7b082a0387763b833168b58a7af4effe178c');
  assert.equal(REQUIRED_ENCODER_CONTRACTS.length, 21);
  assert.equal(createHash('sha256').update(JSON.stringify(REQUIRED_ENCODER_CONTRACTS.toSorted())).digest('hex'), '8bc5077e24e4b6874949a8bc1e18820c6ff9987759275c7860f1aeea39c00930');
});
test('every browser and encoder contract remains mandatory including reviewed additions', () => {
  const required = [...CANDIDATE_NATIVE_CONTRACTS, ...REQUIRED_ENCODER_CONTRACTS];
  const all = [...required, ...CANDIDATE_NATIVE_DIAGNOSTICS];
  assert.deepEqual(verifyNativeInventory(listing(all)), all);
  for (const name of required) {
    assert.throws(() => verifyNativeInventory(listing(all.filter(item => item !== name))), /Missing required/, name);
    assert.throws(() => verifyNativeInventory(listing([...all, name])), /Duplicate/, name);
    assert.throws(() => verifyNativeInventory(listing([...all, `native::client_unreviewed::${name}`])), /Unclassified/, name);
  }
});
test('every feature name is required, unique, nonignored, and no unreviewed feature is exempt', () => {
  const defaults = ['historical_normal']; const features = [...defaults, ...REQUIRED_NATIVE_FEATURE_TESTS];
  assert.deepEqual(verifyFeatureDelta(defaults, features, []), { added: REQUIRED_NATIVE_FEATURE_TESTS.toSorted(), removed: [] });
  for (const name of REQUIRED_NATIVE_FEATURE_TESTS) {
    assert.throws(() => verifyFeatureDelta(defaults, features.filter(item => item !== name), []), /Unexplained/, name);
    assert.throws(() => verifyFeatureDelta(defaults, [...features, name], []), /Duplicate/, name);
    assert.throws(() => verifyFeatureDelta(defaults, features, [name]), /mandatory feature test is ignored/, name);
    assert.throws(() => verifyFeatureDelta(defaults, [...features, `${name}_unreviewed`], []), /Unexplained/, name);
  }
});
