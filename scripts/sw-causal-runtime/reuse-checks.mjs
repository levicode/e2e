import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { requireReuseSelection, requireHistoricalPositive, reusePins, CASES } from './runtime.mjs';
assert.deepEqual(requireReuseSelection(['HTTP500']), ['HTTP500']);
for (const ids of [[], ['FIRST_EVENTS'], ['FIRST_EVENTS','HTTP500'], ['HTTP500','HTTP500'], ['P41']]) assert.throws(() => requireReuseSelection(ids));
const good = {
  id: 'FIRST_EVENTS', status: 'historical-positive-control-verified', executedThisRun: false,
  sourceRunId: reusePins.runId, sourceRunAttempt: reusePins.runAttempt, sourceRecipeSha: reusePins.recipeSha,
  sourceArtifactId: reusePins.priorEvidenceArtifactId, sourceArtifactSha256: reusePins.priorEvidenceArtifactSha256,
  rawSha256: reusePins.priorRawSha256, testPassed: true, knownCleanupConfirmed: true, positiveControlVisible: true,
  globalLosslessCapture: false, formalCleanupPass: false, formalAcceptance: false, nativeCompilationExecutedThisRun: false,
  scopeDecoderVersion: 'sw-causal-scope-closure-v1', closedSuccessfulTraceCount: 1,
  decoderSha256: createHash('sha256').update(readFileSync(new URL('evidence.py', import.meta.url))).digest('hex'),
};
assert.deepEqual(requireHistoricalPositive(good), good);
assert.throws(() => requireHistoricalPositive({}));
for (const key of Object.keys(good)) assert.throws(() => requireHistoricalPositive({ ...good, [key]: typeof good[key] === 'boolean' ? !good[key] : 'wrong' }), key);
assert.equal(CASES.HTTP500.outerMaxMs, 45000);
const runtime = readFileSync(new URL('runtime.mjs', import.meta.url), 'utf8');
const reuseBlock = runtime.slice(runtime.indexOf("if (command === 'cases-reuse')"), runtime.indexOf("if (command === 'cases')"));
assert.ok(reuseBlock.indexOf('requireHistoricalPositive(') < reuseBlock.indexOf('await browserPin('));
assert.ok(reuseBlock.indexOf("flag: 'wx'") < reuseBlock.indexOf('await browserPin('));
assert.ok(!reuseBlock.includes("runCase('FIRST_EVENTS'"));
console.log('Historical/new execution separation, HTTP500 once-only selection and missing/unsafe positive refusal passed');

// Fixed four-cell experiment: synthetic bytes only, never a browser/native process.
const { comparisonCell, verifyComparisonIdentity, verifyFormalEnvelope, formalCausalAssessment } = await import('./runtime.mjs');
const ids = ['formal-1', 'formal-2', 'diag-1', 'diag-2'];
assert.deepEqual(reusePins.comparison.cells.map(item => item.id), ids);
for (const id of ['formal-0', 'formal-3', 'diag-3', 'HTTP500', '', undefined]) assert.throws(() => comparisonCell(id));
for (const key of ['maxAttemptsPerCell', 'conditionalRetries', 'additionalCasesAllowed', 'failFast', 'outerMaxMs', 'caseIds', 'cells']) {
  const plan = structuredClone(reusePins.comparison); plan[key] = key === 'cells' ? plan.cells.slice(1) : key === 'caseIds' ? ['FIRST_EVENTS', 'HTTP500'] : 2;
  assert.throws(() => comparisonCell('formal-1', plan), key);
}
for (const id of ids) {
  const cell = comparisonCell(id), product = cell.product;
  const identity = { comparisonCell: id, comparisonArm: cell.arm, replicate: cell.replicate, ...Object.fromEntries(['nativeSha', 'nativeTree', 'artifactId', 'binarySha256', 'binaryBytes', 'recipeSha'].map(key => [key, product[key]])),
    runId: String(product.runId), runAttempt: String(product.runAttempt), artifactDigest: 'sha256:' + product.artifactSha256,
    artifactClass: cell.arm === 'formal' ? 'formal-production' : 'temporary-diagnostic', causalHooksExpected: product.causalHooksExpected,
    sameRunArtifactVerified: false, exactPriorArtifactVerified: true, profile: 'ci', features: [], nativeCompilationExecutedThisRun: false,
    nativeTestsExecutedThisRun: false, experimentOnly: true, formalCandidateRuntimePass: false, releaseEligible: false };
  assert.equal(verifyComparisonIdentity(identity, cell), identity);
  for (const key of Object.keys(identity)) assert.throws(() => verifyComparisonIdentity({ ...identity, [key]: 'wrong' }, cell), key);
  assert.throws(() => verifyComparisonIdentity(identity, comparisonCell(cell.arm === 'formal' ? 'diag-1' : 'formal-1')));
}
const formalProduct = structuredClone(comparisonCell('formal-1').product);
const bytes = Buffer.alloc(20); Buffer.from('7f454c460201', 'hex').copy(bytes); bytes.writeUInt16LE(62, 18);
formalProduct.binarySha256 = createHash('sha256').update(bytes).digest('hex'); formalProduct.binaryBytes = bytes.length;
const { pins } = await import('./runtime.mjs');
const provenance = {
  NATIVE_SHA: formalProduct.nativeSha, NATIVE_TREE: formalProduct.nativeTree, E2E_SHA: pins.e2eSha, E2E_TREE: pins.e2eTree,
  NATIVE_LOCK_SHA256: pins.nativeLockSha256, E2E_LOCK_SHA256: pins.e2eLockSha256, GITHUB_RUN_ID: String(formalProduct.runId),
  GITHUB_RUN_ATTEMPT: String(formalProduct.runAttempt), GITHUB_WORKFLOW_SHA: formalProduct.recipeSha, RUSTUP_TOOLCHAIN: '1.99.1',
  profile: 'ci', features: [], artifact_label: 'production', binary_sha256: formalProduct.binarySha256, binary_bytes: bytes.length,
  cargo_artifact: { target: { name: 'agent-browser', kind: ['bin'], src_path: '/synthetic/source/cli/src/main.rs' }, features: [],
    profile: { test: false, opt_level: '3', debug_assertions: false }, manifest_path: '/synthetic/source/cli/Cargo.toml', executable: '/synthetic/ci/agent-browser' },
  distribution_eligible: false, dashboard_frontend_built: false, helper_sha256: formalProduct.helperSha256, native_validation: structuredClone(formalProduct.nativeValidation),
};
assert.equal(verifyFormalEnvelope(provenance, bytes, formalProduct).verified, true);
for (const key of ['NATIVE_SHA','NATIVE_TREE','E2E_SHA','E2E_TREE','NATIVE_LOCK_SHA256','E2E_LOCK_SHA256','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_WORKFLOW_SHA','RUSTUP_TOOLCHAIN','profile','artifact_label','binary_sha256','binary_bytes','helper_sha256','distribution_eligible','dashboard_frontend_built']) {
  assert.throws(() => verifyFormalEnvelope({ ...provenance, [key]: 'wrong' }, bytes, formalProduct), key);
}
for (const key of ['diagnostic_only', 'formal_candidate', 'validation_receipts']) assert.throws(() => verifyFormalEnvelope({ ...provenance, [key]: true }, bytes, formalProduct));
assert.throws(() => verifyFormalEnvelope({ ...provenance, features: ['acceptance-faults'] }, bytes, formalProduct));
assert.throws(() => verifyFormalEnvelope({ ...provenance, native_validation: comparisonCell('diag-1').product.nativeValidation }, bytes, formalProduct));
assert.throws(() => verifyFormalEnvelope(provenance, bytes, comparisonCell('diag-1').product));
const badBytes = Buffer.from(bytes); badBytes[6] = 1; assert.throws(() => verifyFormalEnvelope(provenance, badBytes, formalProduct));
const absentHooks = formalCausalAssessment();
assert.equal(absentHooks.status, 'unknown'); assert.equal(absentHooks.causalHooksExpected, false);
assert.equal(absentHooks.positiveControlVisible, false); assert.equal(absentHooks.formalCleanupPass, false); assert.equal(absentHooks.formalAcceptance, false);
const compareBlock = runtime.slice(runtime.indexOf("if (command === 'cases-compare')"), runtime.indexOf("if (command === 'cases-reuse')"));
assert.ok(compareBlock.includes("if (cell.arm === 'diag')"));
assert.ok(compareBlock.indexOf('verifyComparisonIdentity(') < compareBlock.indexOf('await browserPin('));
assert.ok(compareBlock.indexOf("flag: 'wx'") < compareBlock.indexOf('await browserPin('));
assert.ok(compareBlock.includes('conditionalRetries: false'));
assert.ok(!compareBlock.includes("runCase('FIRST_EVENTS'"));
console.log('Fixed four-cell selection, exact-arm image binding, original formal envelope and no-hooks unknown checks passed');
