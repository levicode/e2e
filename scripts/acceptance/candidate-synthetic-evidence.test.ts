import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { type InstallerRuntimeBinding } from '../../packages/web/tests/helpers/installer-fixture.ts';
import { sha256 } from './bundle.ts';
import {
  beginSyntheticCase, callbackFailureFact, validSyntheticFact, SYNTHETIC_BATCH_ENV, SYNTHETIC_BINDING_ENV, SYNTHETIC_CASE_MANIFEST,
  SYNTHETIC_DIRECTORY_ENV, SYNTHETIC_TOTAL_BYTES, type SyntheticCaseId, type SyntheticFact,
  type SyntheticOutcome, type SyntheticSavedRecord,
} from '../../packages/web/tests/helpers/synthetic-evidence.ts';
import { cleanSyntheticEnvironment, collectSyntheticEvidence, prepareSyntheticCapture, syntheticCaseSourceDigest, verifySyntheticEvidence } from './candidate-synthetic-evidence.ts';
import { conformanceSourceDomain, loadConformanceTables } from '../../packages/web/tests/helpers/conformance-evidence.ts';
const installerRuntime: InstallerRuntimeBinding = { caseId: 'P14', purpose: 'installer-cancellation-loopback', binarySha256: 'd'.repeat(64), negotiationProofSha256: 'e'.repeat(64) };
const outcome: SyntheticOutcome = { setup: 'passed', body: 'passed', cleanup: 'passed' };
const phaseFact: SyntheticFact = { kind: 'phase', section: 'body', phase: 'open', state: 'passed' };
const sourceRoot = join(import.meta.dirname, '../..');
const { TODO_REASON } = createRequire(import.meta.url)(join(sourceRoot, SYNTHETIC_CASE_MANIFEST.P16.sources[5])) as { TODO_REASON: string };
function fixture(t: TestContext, suite: 'web-browser' | 'public-callbacks' = 'web-browser', expectedSource?: string) {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-evidence-unit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const spec of Object.values(SYNTHETIC_CASE_MANIFEST)) for (const path of spec.sources) {
    const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'fixed synthetic source');
  }
  for (const path of SYNTHETIC_CASE_MANIFEST.P16.sources.slice(1)) copyFileSync(join(sourceRoot, path), join(root, path));
  if (expectedSource !== undefined) writeFileSync(join(root, SYNTHETIC_CASE_MANIFEST.P16.sources[3]), expectedSource);
  const output = join(root, 'output'); mkdirSync(output);
  const capture = prepareSyntheticCapture(root, suite, { sourceRevision: 'a'.repeat(40), testSourceDigest: 'b'.repeat(64), binarySha256: 'c'.repeat(64) }, {}, suite === 'web-browser' ? installerRuntime : undefined);
  t.after(() => rmSync(capture.directory, { recursive: true, force: true }));
  const saved = (id: SyntheticCaseId): SyntheticSavedRecord[] => readFileSync(join(capture.directory, `${id}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line) as SyntheticSavedRecord);
  const manifest = () => {
    const receipt = collectSyntheticEvidence(output, capture);
    assert.ok(receipt.file);
    return { receipt, value: JSON.parse(readFileSync(join(output, receipt.file), 'utf8')) as { status: string; cases: { caseId: SyntheticCaseId; status: string; records: SyntheticSavedRecord[]; reasons: string[] }[] } };
  };
  return { root, output, capture, saved, manifest };
}
/** Invented unit-test observations, not a claim that the browser produced these facts. */
function conformanceFacts(root: string): SyntheticFact[] {
  const domain = conformanceSourceDomain(loadConformanceTables(sourceRoot), readFileSync(join(root, SYNTHETIC_CASE_MANIFEST.P16.sources[3]), 'utf8'));
  const facts: SyntheticFact[] = [...domain.expectations.values()].map(({ coordinate }) => ({ kind: 'conformance', ...coordinate, listed: true, matchesAxe: false, observedMissing: false, valueMissing: true, valueEmpty: false, matchesExistingException: true }));
  for (const entry of domain.expectations.values()) if (entry.reason === TODO_REASON) {
    const { field: _field, ...coordinate } = entry.coordinate;
    facts.push({ kind: 'conformance-summary', ...coordinate, category: 'todo', expectedLineOrdinal: entry.expectedLineOrdinal });
  }
  const emitted = facts.length;
  for (const table of domain.tables) facts.push({ kind: 'conformance-coverage', ...table, completedCases: table.expectedCases, completedTargets: table.expectedTargets, checkedComparisons: table.expectedComparisons, uniqueComparisons: table.expectedComparisons, mismatchComparisons: facts.filter(fact => fact.kind === 'conformance' && fact.tableOrdinal === table.tableOrdinal).length, complete: true });
  facts.push({ kind: 'conformance-counts', total: emitted, emitted, omitted: 0, truncated: false });
  return facts;
}
function canvasFacts(): SyntheticFact[] {
  return ([0, 1, 2, 3] as const).map(targetOrdinal => ({ kind: 'canvas-oracle', targetOrdinal, nativeIncluded: true, baselineIncluded: true, roleMatchesExpected: true, nativeRoleEqualsBaseline: true, namePresence: false, valuePresence: false, truncated: false, unavailable: false }));
}
function completeAll(capture: ReturnType<typeof prepareSyntheticCapture>, p16 = conformanceFacts(capture.sourceRoot), canvas = canvasFacts()): void {
  for (const entry of capture.configuration.cases) {
    const evidence = beginSyntheticCase(entry.caseId, capture.env); assert.equal(evidence.available, true);
    evidence.record(phaseFact);
    if (entry.caseId === 'P14') evidence.record({ kind: 'installer-runtime', ...installerRuntime });
    if (entry.caseId === 'P16') for (const row of p16) evidence.record(row);
    if (entry.caseId === 'P42O') for (const row of canvas) evidence.record(row);
    evidence.finish(outcome);
  }
}
test('static case groups have exact source dependencies and a 1624 KiB total hard cap', () => {
  const entries = Object.entries(SYNTHETIC_CASE_MANIFEST);
  assert.equal(entries.filter(([, item]) => item.group === 'public').length, 43);
  assert.equal(entries.filter(([, item]) => item.group === 'callback').length, 3);
  assert.equal(entries.filter(([, item]) => item.group === 'setup').length, 1);
  assert.equal(entries.filter(([, item]) => item.group === 'oracle').length, 4);
  assert.equal(SYNTHETIC_TOTAL_BYTES, 1624 * 1024);
  assert.deepEqual(SYNTHETIC_CASE_MANIFEST['nested-setup'].covers, ['P36', 'P37', 'P38', 'P39', 'P40']);
  assert.equal(SYNTHETIC_CASE_MANIFEST.P16.maxRecords, 256);
  assert.equal(SYNTHETIC_CASE_MANIFEST.P16.sources.length, 6);
  assert.equal(SYNTHETIC_CASE_MANIFEST.P42.sources.length, 2);
  assert.equal(SYNTHETIC_CASE_MANIFEST.P42O.sources.length, 30);
  assert.equal(SYNTHETIC_CASE_MANIFEST.P42O.maxRecords, 32);
  assert.equal(SYNTHETIC_CASE_MANIFEST.P42O.maxBytes, 16 * 1024);
  assert.equal(entries.some(([id]) => id.startsWith('N')), false);
});
test('integrated repository prepares both suites and all 51 source-bound IDs without missing sources', t => {
  const ids: string[] = [];
  for (const suite of ['web-browser', 'public-callbacks'] as const) {
    // Availability check only: these placeholders do not assert an executed candidate or native binary.
    const capture = prepareSyntheticCapture(sourceRoot, suite, { sourceRevision: 'a'.repeat(40), testSourceDigest: 'b'.repeat(64), binarySha256: 'c'.repeat(64) }, {}, suite === 'web-browser' ? installerRuntime : undefined);
    t.after(() => rmSync(capture.directory, { recursive: true, force: true }));
    ids.push(...capture.configuration.cases.map(entry => entry.caseId));
    assert.ok(capture.configuration.cases.every(entry => /^[a-f0-9]{64}$/.test(entry.sourceSha256)));
  }
  assert.equal(ids.length, 51);
  assert.deepEqual(new Set(ids), new Set(Object.keys(SYNTHETIC_CASE_MANIFEST)));
});
test('P42O hard-coded sources exactly bind its reviewed 26-file oracle closure without importing page code', () => {
  const declared = SYNTHETIC_CASE_MANIFEST.P42O.sources;
  const manifest = JSON.parse(readFileSync(join(sourceRoot, 'packages/web/tests/helpers/canvas-oracle-manifest.json'), 'utf8')) as { schemaVersion: number; sources: { path: string }[] };
  assert.equal(manifest.schemaVersion, 1);
  const closure = manifest.sources.map(source => source.path);
  assert.equal(closure.length, 26); assert.equal(new Set(closure).size, 26);
  assert.deepEqual(declared, [
    'packages/web/tests/integration/read-node-roles.test.ts',
    'packages/web/tests/helpers/canvas-oracle.ts',
    'packages/web/tests/helpers/canvas-oracle-provenance.ts',
    'packages/web/tests/helpers/canvas-oracle-manifest.json',
    ...closure,
  ]);
  assert.equal(new Set(declared).size, 30);
  assert.deepEqual(SYNTHETIC_CASE_MANIFEST.P42.sources, ['packages/web/tests/integration/read-node-roles.test.ts', 'packages/web/tests/helpers/canvas-oracle-provenance.ts']);
});
test('fresh private capture retains passing and failing body/cleanup independently', t => {
  const { capture, saved } = fixture(t);
  const evidence = beginSyntheticCase('P04', capture.env);
  assert.equal(evidence.available, true); evidence.record(phaseFact);
  evidence.finish({ setup: 'passed', body: 'failed', cleanup: 'failed' });
  assert.deepEqual(saved('P04').at(-1), { kind: 'footer', sequence: 1, dropped: 0, truncated: false, incomplete: false, outcome: { setup: 'passed', body: 'failed', cleanup: 'failed' } });
});
test('retained UNKNOWN usable survives the private writer and independent collector unchanged', t => {
  const { capture, saved, manifest } = fixture(t);
  const evidence = beginSyntheticCase('P17', capture.env);
  const retention = { version: 1, retiredOperationSeq: 7, producerState: 'retiring', inputDebt: 1, objectDebt: 32 } as const;
  const result = { operationSeq: 7, ok: false, code: 'browser-failure', effects: 'unknown', scopeState: 'usable', retention } as const;
  for (const slot of ['first-refusal', 'first-terminal'] as const) assert.equal(evidence.tryRecord({ kind: 'native-result', slot, phase: 'evaluate', command: 'fixture.evaluate', result }), true);
  evidence.finish({ ...outcome, body: 'failed' });
  const records = saved('P17');
  assert.deepEqual(records.slice(1, -1), ['first-refusal', 'first-terminal'].map((slot, sequence) => ({ kind: 'record', sequence, fact: { kind: 'native-result', slot, phase: 'evaluate', command: 'fixture.evaluate', result } })));
  assert.deepEqual(records.at(-1), { kind: 'footer', sequence: 2, dropped: 0, truncated: false, incomplete: false, outcome: { ...outcome, body: 'failed' } });
  assert.equal(evidence.tryRecord(phaseFact), false, 'a closed writer cannot claim it saved a later record');
  const collected = manifest().value.cases.find(item => item.caseId === 'P17');
  assert.equal(collected?.status, 'complete');
  assert.deepEqual(collected?.records, records);
});
test('invalid nested retention never executes getters, consumes a slot or increments saved sequence', t => {
  const { capture, saved } = fixture(t); const evidence = beginSyntheticCase('P17', capture.env);
  const retention = { version: 1, retiredOperationSeq: 1, producerState: 'retired', inputDebt: 0, objectDebt: 0 } as const;
  const result = { operationSeq: 1, ok: false, code: 'cancelled', effects: 'unknown', scopeState: 'usable', retention } as const;
  const fact = { kind: 'native-result', slot: 'first-refusal', phase: 'evaluate', command: 'fixture.evaluate', result } as const;
  let getters = 0;
  const getter = () => { getters++; throw new Error('PRIVATE'); };
  const invalid: unknown[] = [
    { ...result, retention: undefined }, { ...result, retention: { ...retention, retiredOperationSeq: 2 } },
    { ...result, retention: { ...retention, extra: 'PRIVATE' } },
    { ...result, retention: { ...retention, objectDebt: { nested: 'PRIVATE' } } },
    { ...result, retention: Object.defineProperty({ ...retention }, 'inputDebt', { get: getter, enumerable: true }) },
    Object.defineProperty({ ...result }, 'retention', { get: getter, enumerable: true }),
  ];
  for (const invalidResult of invalid) assert.equal(evidence.tryRecord({ ...fact, result: invalidResult } as SyntheticFact), false);
  assert.equal(getters, 0);
  assert.equal(evidence.tryRecord(fact), true);
  evidence.finish({ ...outcome, body: 'failed' });
  const records = saved('P17');
  assert.deepEqual(records[1], { kind: 'record', sequence: 0, fact });
  assert.deepEqual(records.at(-1), { kind: 'footer', sequence: 1, dropped: invalid.length, truncated: false, incomplete: true, outcome: { ...outcome, body: 'failed' } });
  assert.equal(JSON.stringify(records).includes('PRIVATE'), false);
});
test('the artifact validates complete suite identity and saved-record digests', t => {
  const { root, output, capture } = fixture(t);
  completeAll(capture); const receipt = collectSyntheticEvidence(output, capture);
  assert.equal(receipt.status, 'complete'); assert.ok(receipt.file);
  assert.equal(receipt.sha256, sha256(readFileSync(join(output, receipt.file))));
  verifySyntheticEvidence(output, receipt, capture.configuration.binding, root, capture.configuration.installerRuntime);
  assert.throws(() => verifySyntheticEvidence(output, { ...receipt, bytes: receipt.bytes + 1 }, capture.configuration.binding, root, capture.configuration.installerRuntime));
  assert.throws(() => verifySyntheticEvidence(output, receipt, { ...capture.configuration.binding, runId: 'd'.repeat(32) }, root, capture.configuration.installerRuntime));
});
test('observer throws and invalidation never alter the original thrown value', t => {
  const { capture, saved } = fixture(t); const evidence = beginSyntheticCase('P04', capture.env);
  const original = new Error('original business failure'); let caught: unknown;
  try { throw original; } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- The independent synthetic observer failure must not replace the original caught value.
    evidence.observe(() => { throw new Error('private diagnostic error'); }); evidence.invalidate(); caught = error;
  } finally { evidence.finish({ ...outcome, body: 'failed' }); }
  assert.equal(caught, original);
  assert.equal(JSON.stringify(saved('P04')).includes('private'), false);
  assert.deepEqual(saved('P04').at(-1), { kind: 'footer', sequence: 0, dropped: 1, truncated: false, incomplete: true, outcome: { ...outcome, body: 'failed' } });
});
test('malformed, extra fields, arbitrary text and hostile getters are rejected without serialization', t => {
  const { capture, saved } = fixture(t); const evidence = beginSyntheticCase('P04', capture.env);
  const malformed = [null, { ...phaseFact, message: 'private payload' }, { ...phaseFact, phase: 'arbitrary-url' }, { ...phaseFact, state: 1 }, { ...phaseFact, toJSON: () => 'private' }, Object.defineProperty({}, 'kind', { get() { throw new Error('getter'); }, enumerable: true })];
  for (const item of malformed) assert.doesNotThrow(() => evidence.record(item as SyntheticFact));
  evidence.finish(outcome); const records = saved('P04');
  assert.equal(records.length, 2); assert.equal(JSON.stringify(records).includes('private'), false);
  assert.equal((records.at(-1) as { dropped: number }).dropped, malformed.length);
});
test('unknown case, wrong suite, wrong run and inherited sink variables cannot grant writes', t => {
  const { capture } = fixture(t);
  assert.equal(beginSyntheticCase('P99' as SyntheticCaseId, capture.env).available, false);
  assert.equal(beginSyntheticCase('C01', capture.env).available, false);
  assert.equal(beginSyntheticCase('P04', { ...capture.env, [SYNTHETIC_BINDING_ENV]: JSON.stringify({ ...capture.configuration.binding, runId: 'd'.repeat(32) }) }).available, false);
  assert.equal(beginSyntheticCase('P04', { ...capture.env, [SYNTHETIC_BATCH_ENV]: undefined }).available, false);
  assert.deepEqual(cleanSyntheticEnvironment({ ...capture.env, KEEP: 'yes' }), { KEEP: 'yes' });
});
test('different cases own independent files under concurrent scheduling', async t => {
  const { capture, saved } = fixture(t);
  await Promise.all((['P04', 'P05', 'P06'] as const).map(async id => {
    const evidence = beginSyntheticCase(id, capture.env); assert.equal(evidence.available, true);
    await Promise.resolve(); evidence.record(phaseFact); evidence.finish(outcome);
  }));
  for (const id of ['P04', 'P05', 'P06'] as const) {
    assert.equal((saved(id)[0] as { caseId: string }).caseId, id);
    assert.equal(saved(id).length, 3);
  }
});
test('existing file and duplicate owner are refused without overwrite', t => {
  const { capture } = fixture(t); const path = join(capture.directory, 'P04.jsonl');
  writeFileSync(path, 'original', { mode: 0o600 });
  assert.equal(beginSyntheticCase('P04', capture.env).available, false); assert.equal(readFileSync(path, 'utf8'), 'original');
  const owner = beginSyntheticCase('P05', capture.env); assert.equal(owner.available, true);
  assert.equal(beginSyntheticCase('P05', capture.env).available, false); owner.finish(outcome);
});
test('symlink sink and symlink directory are refused', t => {
  const { root, capture } = fixture(t); const target = join(root, 'target'); writeFileSync(target, 'untouched', { mode: 0o600 });
  symlinkSync(target, join(capture.directory, 'P04.jsonl'));
  assert.equal(beginSyntheticCase('P04', capture.env).available, false); assert.equal(readFileSync(target, 'utf8'), 'untouched');
  const alias = join(root, 'alias'); symlinkSync(capture.directory, alias);
  assert.equal(beginSyntheticCase('P05', { ...capture.env, [SYNTHETIC_DIRECTORY_ENV]: alias }).available, false);
});
test('record caps reserve a terminal summary and report exact bounded drops', t => {
  const { capture, saved, manifest } = fixture(t); const evidence = beginSyntheticCase('P04', capture.env);
  for (let index = 0; index < 100; index++) evidence.record(phaseFact);
  evidence.finish(outcome); const records = saved('P04');
  assert.equal(records.length, 64); assert.deepEqual(records.at(-1), { kind: 'footer', sequence: 62, dropped: 38, truncated: true, incomplete: true, outcome });
  assert.ok(readFileSync(join(capture.directory, 'P04.jsonl')).length <= 32 * 1024);
  assert.equal(manifest().value.cases.find(item => item.caseId === 'P04')?.status, 'unknown');
});
test('P16 has an explicit larger cap rather than silently losing nine mismatch identities', t => {
  const { capture, saved } = fixture(t); const evidence = beginSyntheticCase('P16', capture.env);
  for (let index = 0; index < 100; index++) evidence.record(phaseFact);
  evidence.finish(outcome); assert.equal(saved('P16').length, 102); assert.equal((saved('P16').at(-1) as { dropped: number }).dropped, 0);
});
test('a missing footer, a skipped body and shared setup never fabricate completed cases', t => {
  const { capture, manifest } = fixture(t);
  const interrupted = beginSyntheticCase('P36', capture.env); interrupted.record(phaseFact); interrupted.finish(outcome);
  const interruptedFile = join(capture.directory, 'P36.jsonl');
  writeFileSync(interruptedFile, readFileSync(interruptedFile, 'utf8').split('\n').slice(0, -2).join('\n') + '\n');
  beginSyntheticCase('P37', capture.env).finish({ setup: 'failed', body: 'not-started', cleanup: 'passed' });
  beginSyntheticCase('nested-setup', capture.env).finish({ setup: 'failed', body: 'not-started', cleanup: 'passed' });
  const result = manifest().value;
  assert.equal(result.cases.find(item => item.caseId === 'P36')?.status, 'unknown');
  assert.equal(result.cases.find(item => item.caseId === 'P37')?.status, 'unknown');
  assert.equal(result.cases.find(item => item.caseId === 'P38')?.status, 'unknown');
  assert.equal(result.cases.find(item => item.caseId === 'nested-setup')?.status, 'complete');
});
for (const mutation of ['oversize', 'symlink', 'hardlink', 'not-private', 'malformed', 'extra-field', 'wrong-run', 'sequence', 'partial'] as const) {
  test(`collector refuses ${mutation} raw evidence without publishing rejected content`, t => {
    const { root, capture, manifest } = fixture(t); const evidence = beginSyntheticCase('P04', capture.env); evidence.record(phaseFact); evidence.finish(outcome);
    const path = join(capture.directory, 'P04.jsonl'); const contents = readFileSync(path, 'utf8');
    if (mutation === 'oversize') writeFileSync(path, 'PRIVATE'.repeat(10_000));
    if (mutation === 'symlink') { rmSync(path); const target = join(root, 'target'); writeFileSync(target, contents, { mode: 0o600 }); symlinkSync(target, path); }
    if (mutation === 'hardlink') linkSync(path, join(root, 'alias'));
    if (mutation === 'not-private') chmodSync(path, 0o644);
    if (mutation === 'malformed') writeFileSync(path, contents + 'PRIVATE invalid json\n');
    if (mutation === 'extra-field') { const rows = contents.trim().split('\n').map(line => JSON.parse(line)); rows[1].PRIVATE = 'discarded'; writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); }
    if (mutation === 'wrong-run') writeFileSync(path, contents.replace(capture.configuration.binding.runId, 'd'.repeat(32)));
    if (mutation === 'sequence') writeFileSync(path, contents.replace('"sequence":0', '"sequence":2'));
    if (mutation === 'partial') writeFileSync(path, contents.trimEnd());
    const { receipt, value } = manifest(); assert.equal(receipt.status, 'unknown');
    assert.equal(value.cases.find(item => item.caseId === 'P04')?.status, 'unknown');
    assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
  });
}
test('unexpected directory entries invalidate rather than become artifact filenames', t => {
  const { capture, manifest } = fixture(t); completeAll(capture);
  writeFileSync(join(capture.directory, 'private-extra-file'), 'PRIVATE');
  const { receipt, value } = manifest(); assert.equal(receipt.status, 'unknown'); assert.equal(JSON.stringify(value).includes('private-extra-file'), false);
});
test('collector setup/output errors are closed UNKNOWN with no thrown diagnostic error', t => {
  const { output, capture } = fixture(t);
  assert.equal(collectSyntheticEvidence(output, undefined).reason, 'setup-failed');
  writeFileSync(join(output, 'web-browser.synthetic-evidence.json'), 'preexisting');
  assert.equal(collectSyntheticEvidence(output, capture).reason, 'collection-failed');
  assert.equal(readFileSync(join(output, 'web-browser.synthetic-evidence.json'), 'utf8'), 'preexisting');
});
test('full verifier detects source-dependency mutation after capture', t => {
  const { root, output, capture } = fixture(t); completeAll(capture); const receipt = collectSyntheticEvidence(output, capture);
  writeFileSync(join(root, SYNTHETIC_CASE_MANIFEST.P16.sources[1]), 'changed corpus');
  assert.throws(() => verifySyntheticEvidence(output, receipt, capture.configuration.binding, root, capture.configuration.installerRuntime));
});
test('callback manifest cannot contain public cases', t => {
  const { root, output, capture } = fixture(t, 'public-callbacks'); completeAll(capture);
  assert.deepEqual(capture.configuration.cases.map(item => item.caseId), ['C01', 'C02', 'C03']);
  verifySyntheticEvidence(output, collectSyntheticEvidence(output, capture), capture.configuration.binding, root, capture.configuration.installerRuntime);
});
test('P16 byte cap is independent of record cap and preserves truncation evidence', t => {
  const { capture, saved } = fixture(t); const evidence = beginSyntheticCase('P16', capture.env);
  const mismatch: SyntheticFact = { kind: 'conformance', tableOrdinal: 1, caseOrdinal: 65535, targetOrdinal: 255, field: 'name', listed: false, matchesAxe: false, observedMissing: false, valueMissing: false, valueEmpty: false, matchesExistingException: false };
  for (let index = 0; index < 1000; index++) evidence.record(mismatch);
  evidence.finish(outcome); const last = saved('P16').at(-1);
  assert.ok(last?.kind === 'footer'); assert.ok(last.sequence < 254); assert.equal(last.truncated, true);
  assert.equal(last.dropped, 1000 - last.sequence); assert.ok(readFileSync(join(capture.directory, 'P16.jsonl')).length <= 64 * 1024);
});
test('duplicate first-result slots cannot claim complete evidence', t => {
  const { capture, saved } = fixture(t); const evidence = beginSyntheticCase('P04', capture.env);
  const missing: SyntheticFact = { kind: 'native-result', slot: 'first-refusal', phase: 'open', command: 'scope.open', result: null };
  evidence.record(missing); evidence.record(missing); evidence.finish(outcome);
  const last = saved('P04').at(-1); assert.ok(last?.kind === 'footer'); assert.equal(last.dropped, 1); assert.equal(last.incomplete, true);
});
test('descriptor snapshot never reads a dynamic property getter through a Proxy', t => {
  const { capture, saved } = fixture(t); const evidence = beginSyntheticCase('P04', capture.env);
  const proxy = new Proxy(phaseFact, { get(target, key, receiver) { if (key === 'phase') return 'PRIVATE'; return Reflect.get(target, key, receiver); } });
  evidence.record(proxy); evidence.finish(outcome);
  assert.equal(JSON.stringify(saved('P04')).includes('PRIVATE'), false);
  assert.deepEqual(saved('P04')[1], { kind: 'record', sequence: 0, fact: phaseFact });
});
test('duplicate ownership cannot leave an apparently complete first writer', t => {
  const { capture, manifest } = fixture(t); completeAll(capture);
  assert.equal(beginSyntheticCase('P04', capture.env).available, false);
  const result = manifest(); assert.equal(result.receipt.status, 'unknown');
  assert.ok(result.value.cases.find(item => item.caseId === 'P04')?.reasons.includes('unexpected-entry'));
});
test('wrong-run records have no retained provenance and duplicate JSON keys are rejected', t => {
  const { capture, manifest } = fixture(t);
  for (const id of ['P04', 'P05'] as const) { const evidence = beginSyntheticCase(id, capture.env); evidence.record(phaseFact); evidence.finish(outcome); }
  const wrong = join(capture.directory, 'P04.jsonl'); writeFileSync(wrong, readFileSync(wrong, 'utf8').replace(capture.configuration.binding.runId, 'd'.repeat(32)));
  const duplicate = join(capture.directory, 'P05.jsonl'); writeFileSync(duplicate, readFileSync(duplicate, 'utf8').replace('"phase":"open"', '"phase":"PRIVATE","phase":"open"'));
  const result = manifest().value;
  assert.deepEqual(result.cases.find(item => item.caseId === 'P04')?.records, []);
  assert.equal(result.cases.find(item => item.caseId === 'P05')?.status, 'unknown'); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

for (const mutation of ['missing-coverage', 'duplicate-coverage', 'missing-counts', 'duplicate-counts', 'forged-domain', 'incomplete-coverage', 'skipped-case', 'skipped-target', 'skipped-comparison', 'duplicate-comparison', 'missing-mismatch', 'duplicate-mismatch', 'case-outside-domain', 'target-outside-domain', 'field-outside-domain', 'not-a-mismatch', 'contradictory-inclusion', 'forged-emitted-count', 'forged-mismatch-count', 'missing-summaries', 'extra-summary', 'omitted'] as const) {
  test(`P16 collector and verifier reject ${mutation} despite valid scalar records and digests`, t => {
    const { root, output, capture, manifest } = fixture(t);
    let facts = conformanceFacts(root);
    const coverage = facts.find(fact => fact.kind === 'conformance-coverage')! as Extract<SyntheticFact, { kind: 'conformance-coverage' }>;
    const mismatch = facts.find(fact => fact.kind === 'conformance')! as Extract<SyntheticFact, { kind: 'conformance' }>;
    const counts = facts.find(fact => fact.kind === 'conformance-counts')! as Extract<SyntheticFact, { kind: 'conformance-counts' }>;
    if (mutation === 'missing-coverage') facts = facts.filter(fact => fact !== coverage);
    if (mutation === 'duplicate-coverage') facts.push({ ...coverage });
    if (mutation === 'missing-counts') facts = facts.filter(fact => fact !== counts);
    if (mutation === 'duplicate-counts') facts.push({ ...counts });
    if (mutation === 'forged-domain') { coverage.expectedCases++; coverage.completedCases++; coverage.expectedTargets++; coverage.completedTargets++; coverage.expectedComparisons++; coverage.checkedComparisons++; coverage.uniqueComparisons++; }
    if (mutation === 'incomplete-coverage') coverage.complete = false;
    if (mutation === 'skipped-case') coverage.completedCases--;
    if (mutation === 'skipped-target') coverage.completedTargets--;
    if (mutation === 'skipped-comparison') coverage.checkedComparisons--;
    if (mutation === 'duplicate-comparison') coverage.uniqueComparisons--;
    if (mutation === 'missing-mismatch') { facts = facts.filter(fact => fact !== mismatch); counts.total--; counts.emitted--; }
    if (mutation === 'duplicate-mismatch') { facts.push({ ...mismatch }); counts.total++; counts.emitted++; facts.filter(fact => fact.kind === 'conformance-coverage' && fact.tableOrdinal === mismatch.tableOrdinal).forEach(fact => { if (fact.kind === 'conformance-coverage') fact.mismatchComparisons++; }); }
    if (mutation === 'case-outside-domain') mismatch.caseOrdinal = 65535;
    if (mutation === 'target-outside-domain') mismatch.targetOrdinal = 255;
    if (mutation === 'field-outside-domain') mismatch.field = mismatch.field === 'role' ? 'name' : 'role';
    if (mutation === 'not-a-mismatch') mismatch.matchesAxe = true;
    if (mutation === 'contradictory-inclusion') mismatch.observedMissing = mismatch.listed;
    if (mutation === 'forged-emitted-count') { counts.total += 2; counts.emitted += 2; }
    if (mutation === 'forged-mismatch-count') coverage.mismatchComparisons++;
    if (mutation === 'missing-summaries') mismatch.matchesExistingException = false;
    if (mutation === 'extra-summary') { facts.push({ kind: 'conformance-summary', category: 'unexpected', tableOrdinal: mismatch.tableOrdinal, caseOrdinal: mismatch.caseOrdinal, targetOrdinal: mismatch.targetOrdinal, expectedLineOrdinal: 0 }); counts.total++; counts.emitted++; }
    if (mutation === 'omitted') { counts.total++; counts.omitted++; counts.truncated = true; }
    completeAll(capture, facts);
    const result = manifest(); const item = result.value.cases.find(entry => entry.caseId === 'P16')!;
    assert.equal(item.status, 'unknown'); assert.ok(item.reasons.includes('incomplete'));
    // Forge every public status and re-hash all saved artifact bytes: semantic checks must still reject.
    item.status = 'complete'; item.reasons = []; result.value.status = 'complete';
    const bytes = Buffer.from(JSON.stringify(result.value)); writeFileSync(join(output, result.receipt.file!), bytes);
    assert.throws(() => verifySyntheticEvidence(output, { ...result.receipt, status: 'complete', sha256: sha256(bytes), bytes: bytes.length }, capture.configuration.binding, root, capture.configuration.installerRuntime));
  });
}

test('P16 summary categories and physical expected lines are derived independently from stored mismatches', t => {
  const { root, output, capture } = fixture(t);
  const facts = conformanceFacts(root);
  const mismatch = facts.find(fact => fact.kind === 'conformance')! as Extract<SyntheticFact, { kind: 'conformance' }>;
  const domain = conformanceSourceDomain(loadConformanceTables(sourceRoot), readFileSync(join(root, SYNTHETIC_CASE_MANIFEST.P16.sources[3]), 'utf8'));
  const expected = [...domain.expectations.values()].find(entry => entry.coordinate.tableOrdinal === mismatch.tableOrdinal && entry.coordinate.caseOrdinal === mismatch.caseOrdinal && entry.coordinate.targetOrdinal === mismatch.targetOrdinal)!;
  mismatch.matchesExistingException = false;
  const { tableOrdinal, caseOrdinal, targetOrdinal } = mismatch;
  facts.push({ kind: 'conformance-summary', category: 'unexpected', tableOrdinal, caseOrdinal, targetOrdinal, expectedLineOrdinal: 0 });
  facts.push({ kind: 'conformance-summary', category: 'stale', tableOrdinal, caseOrdinal, targetOrdinal, expectedLineOrdinal: expected.expectedLineOrdinal });
  const counts = facts.find(fact => fact.kind === 'conformance-counts')! as Extract<SyntheticFact, { kind: 'conformance-counts' }>;
  counts.total += 2; counts.emitted += 2;
  completeAll(capture, facts);
  const receipt = collectSyntheticEvidence(output, capture); assert.equal(receipt.status, 'complete');
  verifySyntheticEvidence(output, receipt, capture.configuration.binding, root, capture.configuration.installerRuntime);
});

for (const mutation of ['wrong-line', 'comment-line', 'wrong-coordinate', 'wrong-category', 'duplicate-summary', 'missing-todo', 'unexpected-nonzero-line'] as const) {
  test(`P16 rejects ${mutation} in source-bound expectation summaries`, t => {
    const source = readFileSync(join(sourceRoot, SYNTHETIC_CASE_MANIFEST.P16.sources[3]), 'utf8');
    const lines = source.split('\n'); const index = lines.findIndex(line => line !== '' && !line.startsWith('#'));
    lines[index] = lines[index]!.slice(0, lines[index]!.lastIndexOf(' | ') + 3) + TODO_REASON;
    const { root, capture, manifest } = fixture(t, 'web-browser', lines.join('\n'));
    let facts = conformanceFacts(root);
    const summary = facts.find(fact => fact.kind === 'conformance-summary')! as Extract<SyntheticFact, { kind: 'conformance-summary' }>;
    const counts = facts.find(fact => fact.kind === 'conformance-counts')! as Extract<SyntheticFact, { kind: 'conformance-counts' }>;
    if (mutation === 'wrong-line') summary.expectedLineOrdinal++;
    if (mutation === 'comment-line') summary.expectedLineOrdinal = 1;
    if (mutation === 'wrong-coordinate') summary.caseOrdinal = 65535;
    if (mutation === 'wrong-category') summary.category = 'stale';
    if (mutation === 'duplicate-summary') { facts.push({ ...summary }); counts.total++; counts.emitted++; }
    if (mutation === 'missing-todo') { facts = facts.filter(fact => fact !== summary); counts.total--; counts.emitted--; }
    if (mutation === 'unexpected-nonzero-line') summary.category = 'unexpected';
    completeAll(capture, facts);
    assert.equal(manifest().value.cases.find(item => item.caseId === 'P16')?.status, 'unknown');
  });
}

test('P16 source mismatch is UNKNOWN before collection, not merely rejected by final verification', t => {
  const { root, capture, manifest } = fixture(t); completeAll(capture);
  writeFileSync(join(root, SYNTHETIC_CASE_MANIFEST.P16.sources[1]), 'module.exports = [];');
  assert.equal(manifest().value.cases.find(item => item.caseId === 'P16')?.status, 'unknown');
});

test('P16 can retain complete zero-mismatch coverage with all stale and TODO rows, without a green functional outcome', t => {
  const source = readFileSync(join(sourceRoot, SYNTHETIC_CASE_MANIFEST.P16.sources[3]), 'utf8');
  const lines = source.split('\n'); const index = lines.findIndex(line => line !== '' && !line.startsWith('#'));
  lines[index] = lines[index]!.slice(0, lines[index]!.lastIndexOf(' | ') + 3) + TODO_REASON;
  const { root, output, capture } = fixture(t, 'web-browser', lines.join('\n'));
  const domain = conformanceSourceDomain(loadConformanceTables(sourceRoot), lines.join('\n'));
  const facts: SyntheticFact[] = [];
  for (const entry of domain.expectations.values()) {
    const { field: _field, ...coordinate } = entry.coordinate;
    facts.push({ kind: 'conformance-summary', ...coordinate, category: 'stale', expectedLineOrdinal: entry.expectedLineOrdinal });
    if (entry.reason === TODO_REASON) facts.push({ kind: 'conformance-summary', ...coordinate, category: 'todo', expectedLineOrdinal: entry.expectedLineOrdinal });
  }
  const emitted = facts.length;
  for (const table of domain.tables) facts.push({ kind: 'conformance-coverage', ...table, completedCases: table.expectedCases, completedTargets: table.expectedTargets, checkedComparisons: table.expectedComparisons, uniqueComparisons: table.expectedComparisons, mismatchComparisons: 0, complete: true });
  facts.push({ kind: 'conformance-counts', total: emitted, emitted, omitted: 0, truncated: false });
  completeAll(capture, facts);
  const path = join(capture.directory, 'P16.jsonl');
  const records = readFileSync(path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as SyntheticSavedRecord);
  const footer = records.at(-1)!; assert.equal(footer.kind, 'footer');
  if (footer.kind === 'footer') footer.outcome.body = 'failed';
  writeFileSync(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const receipt = collectSyntheticEvidence(output, capture); assert.equal(receipt.status, 'complete');
  verifySyntheticEvidence(output, receipt, capture.configuration.binding, root, capture.configuration.installerRuntime);
});

test('P16 refuses a correctly re-bound but different corpus instead of using another root\'s cached table', t => {
  const { root, capture } = fixture(t); completeAll(capture);
  const path = join(root, SYNTHETIC_CASE_MANIFEST.P16.sources[1]);
  writeFileSync(path, readFileSync(path, 'utf8') + '\n// Different source, same coordinates.\n');
  // A fresh configuration binds the altered corpus, but the loaded validator's fixed source gate still closes.
  const { sourceRevision, testSourceDigest, binarySha256 } = capture.configuration.binding;
  const next = prepareSyntheticCapture(root, 'web-browser', { sourceRevision, testSourceDigest, binarySha256 }, {}, installerRuntime);
  t.after(() => rmSync(next.directory, { recursive: true, force: true }));
  completeAll(next);
  const receipt = collectSyntheticEvidence(join(root, 'output'), next);
  assert.equal(receipt.status, 'unknown');
  assert.ok(receipt.file);
  const saved = JSON.parse(readFileSync(join(root, 'output', receipt.file), 'utf8')) as { cases: { caseId: string; status: string }[] };
  assert.equal(saved.cases.find(item => item.caseId === 'P16')?.status, 'unknown');
});

for (const mutation of ['missing-all', 'missing-one', 'duplicate-target', 'extra-target', 'unavailable', 'truncated'] as const) {
  test(`P42O collector and verifier refuse ${mutation} without changing original P42 evidence`, t => {
    const { root, output, capture, manifest } = fixture(t);
    let rows = canvasFacts();
    if (mutation === 'missing-all') rows = [];
    if (mutation === 'missing-one') rows.pop();
    if (mutation === 'duplicate-target') rows[3] = { ...rows[0]! };
    if (mutation === 'extra-target') rows.push({ ...rows[0]! });
    if (mutation === 'unavailable' || mutation === 'truncated') rows[0] = { ...rows[0]!, [mutation]: true } as SyntheticFact;
    completeAll(capture, undefined, rows);
    const result = manifest(); const original = result.value.cases.find(item => item.caseId === 'P42')!;
    const oracle = result.value.cases.find(item => item.caseId === 'P42O')!;
    assert.equal(original.status, 'complete'); assert.equal(oracle.status, 'unknown');
    assert.ok(oracle.reasons.includes('incomplete'));
    // A forged green status and recomputed artifact hash cannot bypass the target set requirement.
    oracle.status = 'complete'; oracle.reasons = []; result.value.status = 'complete';
    const bytes = Buffer.from(JSON.stringify(result.value)); writeFileSync(join(output, result.receipt.file!), bytes);
    assert.throws(() => verifySyntheticEvidence(output, { ...result.receipt, status: 'complete', sha256: sha256(bytes), bytes: bytes.length }, capture.configuration.binding, root, capture.configuration.installerRuntime));
  });
}

test('P42O has its own exclusive file and 32-row/16-KiB budget', t => {
  const { capture, saved } = fixture(t);
  const original = beginSyntheticCase('P42', capture.env); original.record(phaseFact); original.finish(outcome);
  const oracle = beginSyntheticCase('P42O', capture.env);
  for (let index = 0; index < 40; index++) oracle.record(phaseFact);
  oracle.finish(outcome);
  assert.equal(saved('P42').length, 3);
  assert.equal(saved('P42O').length, 32);
  const last = saved('P42O').at(-1); assert.ok(last?.kind === 'footer');
  assert.equal(last.dropped, 10); assert.equal(last.truncated, true);
  assert.ok(readFileSync(join(capture.directory, 'P42O.jsonl')).length <= 16 * 1024);
});

for (const source of ['packages/web/tests/helpers/canvas-oracle.ts', 'packages/web/tests/helpers/canvas-oracle-provenance.ts', 'packages/web/tests/helpers/canvas-oracle-manifest.json', 'packages/web/src/runtime-support.ts']) {
  test(`P42O source binding fails closed when ${source} is missing`, t => {
    const { root } = fixture(t); rmSync(join(root, source));
    assert.throws(() => prepareSyntheticCapture(root, 'web-browser', { sourceRevision: 'a'.repeat(40), testSourceDigest: 'b'.repeat(64), binarySha256: 'c'.repeat(64) }, {}));
    assert.equal(collectSyntheticEvidence(join(root, 'output'), undefined).reason, 'setup-failed');
  });
}

test('P14 closure includes the fixture and complete capture requires one exact independently expected secondary identity', t => {
  assert.deepEqual(SYNTHETIC_CASE_MANIFEST.P14.sources, ['packages/web/tests/integration/cli.test.ts', 'packages/web/tests/helpers/installer-fixture.ts', 'packages/web/tests/helpers/synthetic-native-outcomes.ts', 'packages/web/tests/helpers/synthetic-evidence.ts']);
  const { root, output, capture } = fixture(t); completeAll(capture);
  const receipt = collectSyntheticEvidence(output, capture);
  assert.equal(receipt.status, 'complete');
  assert.throws(() => verifySyntheticEvidence(output, receipt, capture.configuration.binding, root));
  assert.throws(() => verifySyntheticEvidence(output, receipt, capture.configuration.binding, root, { ...installerRuntime, binarySha256: 'f'.repeat(64) }));
  assert.throws(() => verifySyntheticEvidence(output, receipt, capture.configuration.binding, root, { ...installerRuntime, negotiationProofSha256: 'f'.repeat(64) }));
});

test('P14 missing duplicate foreign-proof and foreign-runtime facts cannot be collected as complete', t => {
  for (const facts of [[], [installerRuntime, installerRuntime], [{ ...installerRuntime, binarySha256: 'c'.repeat(64) }], [{ ...installerRuntime, negotiationProofSha256: 'f'.repeat(64) }]]) {
    const { capture, manifest } = fixture(t);
    for (const entry of capture.configuration.cases) {
      const evidence = beginSyntheticCase(entry.caseId, capture.env); evidence.record(phaseFact);
      if (entry.caseId === 'P14') for (const fact of facts) evidence.record({ kind: 'installer-runtime', ...fact });
      if (entry.caseId === 'P16') for (const fact of conformanceFacts(capture.sourceRoot)) evidence.record(fact);
      if (entry.caseId === 'P42O') for (const fact of canvasFacts()) evidence.record(fact);
      evidence.finish(outcome);
    }
    const result = manifest(); assert.equal(result.receipt.status, 'unknown');
    assert.equal(result.value.cases.find(item => item.caseId === 'P14')!.status, 'unknown');
  }
});

test('P14 runtime fact rejects wrong case and arbitrary metadata, including in a forged finalized sidecar', t => {
  const { root, output, capture } = fixture(t); completeAll(capture); const result = collectSyntheticEvidence(output, capture);
  assert.ok(result.file); const file = join(output, result.file); const original = readFileSync(file);
  for (const mutate of [
    (fact: Record<string, unknown>) => { fact['caseId'] = 'P13'; },
    (fact: Record<string, unknown>) => { fact['binarySha256'] = 'c'.repeat(64); },
    (fact: Record<string, unknown>) => { fact['negotiationProofSha256'] = 'f'.repeat(64); },
    (fact: Record<string, unknown>) => { fact['path'] = '/not-allowed'; },
  ]) {
    const value = JSON.parse(original.toString()) as { cases: { caseId: string; records: SyntheticSavedRecord[]; recordsSha256: string }[] };
    const item = value.cases.find(entry => entry.caseId === 'P14')!;
    const record = item.records.find(entry => entry.kind === 'record' && entry.fact.kind === 'installer-runtime')!;
    if (record.kind !== 'record') throw new Error('Expected installer fact'); mutate(record.fact as unknown as Record<string, unknown>);
    item.recordsSha256 = sha256(Buffer.from(JSON.stringify(item.records)));
    const bytes = Buffer.from(JSON.stringify(value)); writeFileSync(file, bytes);
    assert.throws(() => verifySyntheticEvidence(output, { ...result, sha256: sha256(bytes), bytes: bytes.length }, capture.configuration.binding, root, installerRuntime));
  }
  const rejected = fixture(t); const wrong = beginSyntheticCase('P13', rejected.capture.env); wrong.record({ kind: 'installer-runtime', ...installerRuntime }); wrong.finish(outcome);
  const footer = rejected.saved('P13').at(-1)!; assert.equal(footer.kind, 'footer');
  if (footer.kind === 'footer') { assert.equal(footer.dropped, 1); assert.equal(footer.incomplete, true); }
});


test('callback failure sidecar is case-owned, bounded and cannot read or save error payloads', () => {
  const cause = { code: 'NODE_STALE', message: 'not retained' };
  const error = { code: 'ACTION_FAILED', cause, stack: 'not retained' };
  assert.deepEqual(callbackFailureFact(3, error), { kind: 'callback-failure', stageOrdinal: 3, code: 'ACTION_FAILED', causeCode: 'NODE_STALE' });
  const fact = callbackFailureFact(3, error);
  assert.equal(validSyntheticFact(fact, 'C03'), true);
  assert.equal(validSyntheticFact(fact, 'C02'), false);
  assert.equal(validSyntheticFact({ ...fact, message: 'not retained' }, 'C03'), false);
  assert.equal(validSyntheticFact({ ...fact, code: 'arbitrary text' }, 'C03'), false);
  assert.equal(validSyntheticFact({ ...fact, stageOrdinal: 6 }, 'C03'), false);
  const getter = Object.defineProperty({}, 'code', { get() { throw new Error('must not invoke getter'); } });
  assert.deepEqual(callbackFailureFact(0, getter), { kind: 'callback-failure', stageOrdinal: 0, code: 'other', causeCode: null });
});

test('P01 observes optional trace failures with closed command names and a bound observer source', () => {
  assert.deepEqual(SYNTHETIC_CASE_MANIFEST.P01.sources, [
    'packages/web/tests/integration/app-log.test.ts',
    'packages/web/tests/helpers/synthetic-native-outcomes.ts',
    'packages/web/tests/helpers/synthetic-evidence.ts',
  ]);
  const source = readFileSync(join(sourceRoot, SYNTHETIC_CASE_MANIFEST.P01.sources[0]), 'utf8');
  assert.match(source, /return await evidence\.observer\.run\(async \(\) =>/);
  assert.match(source, /observeSyntheticConnection\(connect\(\.\.\.args\)\)/);
  for (const command of ['capture.screenshot', 'blob.read', 'blob.release'] as const) {
    const fact = { kind: 'request-rejected-without-result', phase: 'capture', command } as const;
    assert.equal(validSyntheticFact(fact, 'P01'), true);
    assert.equal(validSyntheticFact({ ...fact, payload: 'not permitted' }, 'P01'), false);
  }
  assert.equal(validSyntheticFact({ kind: 'request-rejected-without-result', phase: 'capture', command: 'arbitrary-private-command' }, 'P01'), false);
});

test('P27 source closure binds the real native fixture graph and its captured correlation helpers', () => {
  assert.deepEqual(SYNTHETIC_CASE_MANIFEST.P27.sources, [
    'packages/web/tests/integration/lifecycle.test.ts',
    'packages/web/tests/helpers/native-browser.ts',
    'packages/web/tests/helpers/capture-fixture-surface.ts',
    'packages/web/tests/helpers/native-correlation.ts',
  ]);
});

for (const source of [
  'packages/web/tests/helpers/native-browser.ts',
  'packages/web/tests/helpers/capture-fixture-surface.ts',
  'packages/web/tests/helpers/native-correlation.ts',
]) {
  test(`P27 verifier invalidates captured evidence after helper mutation: ${source}`, t => {
    const { root, output, capture } = fixture(t);
    completeAll(capture);
    const receipt = collectSyntheticEvidence(output, capture);
    assert.equal(receipt.status, 'complete');
    verifySyntheticEvidence(output, receipt, capture.configuration.binding, root, capture.configuration.installerRuntime);
    const file = join(root, source);
    const original = readFileSync(file);
    writeFileSync(file, 'changed P27 fixture helper');
    assert.throws(() => verifySyntheticEvidence(output, receipt, capture.configuration.binding, root, capture.configuration.installerRuntime));
    writeFileSync(file, original);
    verifySyntheticEvidence(output, receipt, capture.configuration.binding, root, capture.configuration.installerRuntime);
  });
}

const nativeObserverCases: readonly SyntheticCaseId[] = [
  'P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12', 'P13', 'P14', 'P15',
  'P17', 'P18', 'P19', 'P20', 'P21', 'P23', 'P36', 'P37', 'P38', 'P39', 'P40', 'P43', 'nested-setup',
];
for (const helper of ['packages/web/tests/helpers/synthetic-native-outcomes.ts', 'packages/web/tests/helpers/synthetic-evidence.ts']) {
  test(`only actual native observer cases bind the evidence helper: ${helper}`, t => {
    const bound = (Object.entries(SYNTHETIC_CASE_MANIFEST) as [SyntheticCaseId, { sources: readonly string[] }][])
      .filter(([, spec]) => spec.sources.includes(helper)).map(([caseId]) => caseId);
    assert.deepEqual(bound, nativeObserverCases);
    for (const caseId of nativeObserverCases) {
      const spec = SYNTHETIC_CASE_MANIFEST[caseId];
      assert.equal(new Set(spec.sources).size, spec.sources.length);
      assert.match(readFileSync(join(sourceRoot, spec.sources[0]), 'utf8'), /synthetic-native-outcomes\.ts/);
    }
    const { root, output, capture } = fixture(t);
    completeAll(capture);
    const receipt = collectSyntheticEvidence(output, capture);
    assert.equal(receipt.status, 'complete');
    verifySyntheticEvidence(output, receipt, capture.configuration.binding, root, capture.configuration.installerRuntime);
    const file = join(root, helper); const original = readFileSync(file);
    writeFileSync(file, 'changed evidence helper');
    for (const entry of capture.configuration.cases) {
      assert.equal(syntheticCaseSourceDigest(root, entry.caseId) !== entry.sourceSha256, nativeObserverCases.includes(entry.caseId), entry.caseId);
    }
    assert.throws(() => verifySyntheticEvidence(output, receipt, capture.configuration.binding, root, capture.configuration.installerRuntime));
    writeFileSync(file, original);
    verifySyntheticEvidence(output, receipt, capture.configuration.binding, root, capture.configuration.installerRuntime);
  });
}

test('a failed append reports false and cannot manufacture a saved sequence or complete footer', t => {
  const { capture, saved, manifest } = fixture(t);
  const evidence = beginSyntheticCase('P17', capture.env);
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const failedWrite = t.mock.method(fs, 'writeSync', () => 0);
  syncBuiltinESMExports();
  try {
    assert.equal(evidence.tryRecord(phaseFact), false);
    assert.equal(failedWrite.mock.callCount(), 1);
  } finally {
    failedWrite.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(evidence.tryRecord(phaseFact), false, 'a failed writer cannot later claim success');
  evidence.finish({ ...outcome, body: 'failed' });
  assert.deepEqual(saved('P17').map(row => row.kind), ['header']);
  const collected = manifest().value.cases.find(item => item.caseId === 'P17');
  assert.equal(collected?.status, 'unknown');
  assert.ok(collected?.reasons.includes('missing-footer'));
});
