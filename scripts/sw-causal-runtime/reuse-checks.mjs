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
