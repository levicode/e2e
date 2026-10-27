/** Parser/inventory tests only. These synthetic strings are not native runtime evidence. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { verifyNativeInventory, verifyVideoInventory } from './candidate-native.ts';
import { CANDIDATE_NATIVE_CONTRACTS, CANDIDATE_NATIVE_DIAGNOSTICS } from './candidate-manifest.ts';
import { PREPARATION_SETTLEMENT_TESTS, REQUIRED_NATIVE_FEATURE_TESTS } from './candidate-native-matrix-manifest.ts';
import { MANAGED_ENCODER_CONTRACTS, LEGACY_COMPONENT_ENCODER_CONTRACTS, REQUIRED_ENCODER_CONTRACTS, REQUIRED_VIDEO_NORMAL_TESTS } from './candidate-video-manifest.ts';
import { verifyEncoderProducerGate } from './candidate-producer.ts';
import { CANDIDATE_GATES } from './candidate-receipt.ts';
import { nativeTestEvidence } from './native-evidence.ts';
const listing = (names: readonly string[]) => names.map(name => `${name}: test`).join('\n');
const ignored = [...CANDIDATE_NATIVE_CONTRACTS, ...REQUIRED_ENCODER_CONTRACTS, ...CANDIDATE_NATIVE_DIAGNOSTICS];
const defaults = [...ignored, ...REQUIRED_VIDEO_NORMAL_TESTS];
test('video23 preserves 44 browser/encoder, 45 feature and 8 preparation inventories', () => {
  assert.equal(CANDIDATE_NATIVE_CONTRACTS.length, 44);
  assert.equal(REQUIRED_NATIVE_FEATURE_TESTS.length, 45);
  assert.equal(PREPARATION_SETTLEMENT_TESTS.length, 8);
  assert.equal(MANAGED_ENCODER_CONTRACTS.length, 10);
  assert.equal(LEGACY_COMPONENT_ENCODER_CONTRACTS.length, 3);
  assert.equal(REQUIRED_VIDEO_NORMAL_TESTS.length, 10);
  assert.equal(new Set([...REQUIRED_ENCODER_CONTRACTS, ...REQUIRED_VIDEO_NORMAL_TESTS]).size, 23);
  for (const name of REQUIRED_ENCODER_CONTRACTS) assert.ok(!CANDIDATE_NATIVE_CONTRACTS.includes(name as never));
});
test('all 13 encoder contracts are required separately, never diagnostic exemptions', () => {
  assert.deepEqual(verifyNativeInventory(listing(ignored)), ignored);
  for (const name of REQUIRED_ENCODER_CONTRACTS) {
    assert.throws(() => verifyNativeInventory(listing(ignored.filter(item => item !== name))), /Missing required/);
    assert.ok(!CANDIDATE_NATIVE_DIAGNOSTICS.includes(name as never));
  }
  assert.throws(() => verifyNativeInventory(listing([...ignored, 'native::client_unknown::test'])), /Unclassified/);
  assert.throws(() => verifyNativeInventory(listing([...ignored, REQUIRED_ENCODER_CONTRACTS[0]])), /Duplicate/);
});
test('each of ten normal tests must be discovered and nonignored', () => {
  verifyVideoInventory(listing(defaults), listing(ignored));
  for (const name of REQUIRED_VIDEO_NORMAL_TESTS) {
    assert.throws(() => verifyVideoInventory(listing(defaults.filter(item => item !== name)), listing(ignored)), /Missing or ignored/);
    assert.throws(() => verifyVideoInventory(listing(defaults), listing([...ignored, name])), /Missing or ignored/);
  }
});
test('each encoder must be in both default discovery and exact ignored partition', () => {
  for (const name of REQUIRED_ENCODER_CONTRACTS) {
    assert.throws(() => verifyVideoInventory(listing(defaults.filter(item => item !== name)), listing(ignored)), /Missing or nonignored/);
    assert.throws(() => verifyVideoInventory(listing(defaults), listing(ignored.filter(item => item !== name))), /Missing or nonignored/);
  }
  assert.throws(() => verifyVideoInventory(listing([...defaults, defaults[0]!]), listing(ignored)), /Duplicate/);
  assert.throws(() => verifyVideoInventory(listing(defaults), listing([...ignored, ignored[0]!])), /Duplicate/);
});
test('existing exact success parser cannot promote failed or zero-execution summaries', () => {
  const log = (status: string, passed: number, failed: number, skipped: number) => `test result: ${status}. ${passed} passed; ${failed} failed; ${skipped} ignored;`;
  assert.deepEqual(nativeTestEvidence(log('ok', 1, 0, 0)), { passed: 1, ignored: 0 });
  for (const raw of ['', log('ok', 0, 0, 1), log('FAILED', 0, 1, 0), log('ok', 1, 1, 0)]) assert.throws(() => nativeTestEvidence(raw));
  assert.equal(nativeTestEvidence(log('ok', 2, 0, 0)).passed, 2); // Runner's existing !== 1 rejects it.
  assert.equal(nativeTestEvidence(log('ok', 1, 0, 1)).ignored, 1); // Runner's existing !== 0 rejects it.
});
test('separate encoder step and receipt are mandatory, retaining exact180s and discovery30s', () => {
  const runner = readFileSync(new URL('./candidate-native.ts', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../../.github/workflows/native-candidate.yml', import.meta.url), 'utf8');
  const receipt = readFileSync(new URL('./candidate-receipt.ts', import.meta.url), 'utf8');
  assert.match(workflow, /id: native-encoder/);
  assert.match(workflow, /candidate-native.ts encoder/);
  assert.match(receipt, /'native-encoder'/);
  assert.match(receipt, /'encoder.result.json'/);
  assert.match(runner, /\[name, '--exact', '--ignored', '--list'\], 30_000/);
  assert.match(runner, /\[name, '--exact', '--ignored', '--test-threads=1'\], 180_000/);
  assert.match(runner, /evidence.passed !== 1 \|\| evidence.ignored !== 0/);
  assert.match(runner, /fake-cdp-real-encoder-contract/);
});

test('producer packaging cannot omit or misclassify the separate encoder category', () => {
  assert.equal(CANDIDATE_GATES.length, 32);
  const source = { commit: 'a'.repeat(40) }; const binary = 'b'.repeat(64);
  const proof = { status: 'passed', source, productionBinarySha256: binary, category: 'fake-cdp-real-encoder-contract', browserIdentityRequired: false,
    required: REQUIRED_ENCODER_CONTRACTS, results: REQUIRED_ENCODER_CONTRACTS.map(name => ({ name, passed: 1, ignored: 0 })), failures: [] };
  verifyEncoderProducerGate(proof, source, binary);
  for (const bad of [undefined, {}, { ...proof, status: 'failed' }, { ...proof, source: {} }, { ...proof, productionBinarySha256: 'c'.repeat(64) },
    { ...proof, browserIdentityRequired: true }, { ...proof, category: 'browser' }, { ...proof, failures: ['failed'] }, { ...proof, required: REQUIRED_ENCODER_CONTRACTS.slice(1) },
    { ...proof, results: proof.results.slice(1) }, { ...proof, results: proof.results.map((row, i) => i ? row : { ...row, ignored: 1 }) },
    { ...proof, results: proof.results.map((row, i) => i ? row : { ...row, passed: 0 }) }, { ...proof, results: proof.results.toReversed() }]) {
    assert.throws(() => verifyEncoderProducerGate(bad, source, binary));
  }
  const producer = readFileSync(new URL('./candidate-producer.ts', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../../.github/workflows/native-candidate.yml', import.meta.url), 'utf8');
  assert.match(producer, /encoderReceiptSha256: hashFile/);
  assert.match(producer, /const recipes = \['candidate-video-manifest.ts'/);
  assert.match(workflow, /steps.native-browser.outcome == 'success' && steps.native-encoder.outcome == 'success' && steps.native-proxy/);
});
