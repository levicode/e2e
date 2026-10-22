/** Concentrated-batch only: private raw capture, closed artifact, independent evidence status. */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, opendirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from './bundle.ts';
import { hashFile } from './candidate-native.ts';
import { conformanceCoordinateKey, conformanceSourceDomain, loadConformanceTables } from '../../packages/web/tests/helpers/conformance-evidence.ts';
import {
  SYNTHETIC_BATCH_ENV, SYNTHETIC_BINDING_ENV, SYNTHETIC_BINDING_FILE, SYNTHETIC_CASE_MANIFEST,
  SYNTHETIC_DIRECTORY_ENV, SYNTHETIC_MANIFEST_BYTES, SYNTHETIC_RECORD_BYTES, SYNTHETIC_TOTAL_BYTES,
  readSyntheticFile, requireSyntheticDirectory, syntheticCase, syntheticCount, syntheticDigest,
  syntheticKeys, syntheticObject, validSyntheticBinding, validSyntheticConfiguration, validSyntheticSavedRecord,
  type SyntheticBinding, type SyntheticCaseId, type SyntheticConfiguration, type SyntheticFact, type SyntheticSavedRecord, type SyntheticSuite,
} from '../../packages/web/tests/helpers/synthetic-evidence.ts';

export interface SyntheticCapture { sourceRoot: string; directory: string; configuration: SyntheticConfiguration; env: NodeJS.ProcessEnv }
const REASONS = ['unavailable-file', 'invalid-record', 'partial-record', 'wrong-binding', 'sequence', 'missing-header', 'missing-footer', 'dropped', 'incomplete', 'unexpected-entry'] as const;
type Reason = typeof REASONS[number];
interface CaseEvidence {
  caseId: SyntheticCaseId; sourceSha256: string; status: 'complete' | 'unknown'; reasons: Reason[];
  records: SyntheticSavedRecord[]; recordsSha256: string;
}
interface Manifest { schemaVersion: 1; binding: SyntheticBinding; status: 'complete' | 'unknown'; cases: CaseEvidence[] }
export interface SyntheticEvidenceReceipt {
  schemaVersion: 1; status: 'complete' | 'unknown'; file: string | null; sha256: string | null; bytes: number;
  reason: 'collected' | 'setup-failed' | 'collection-failed';
}
export const syntheticArtifactFile = (suite: SyntheticSuite): string => `${suite}.synthetic-evidence.json`;
/** Inherited sink paths are never authority; only the exact fresh runner configuration is propagated. */
export function cleanSyntheticEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const name of [SYNTHETIC_BATCH_ENV, SYNTHETIC_DIRECTORY_ENV, SYNTHETIC_BINDING_ENV]) delete env[name];
  return env;
}
/** Hash every static source dependency, not merely the test entry or an external claimed digest. */
export function syntheticCaseSourceDigest(root: string, caseId: SyntheticCaseId): string {
  return sha256(Buffer.from(JSON.stringify(SYNTHETIC_CASE_MANIFEST[caseId].sources.map(path => ({ source: path, sha256: hashFile(join(root, path)) })))));
}
const validatorRoot = join(import.meta.dirname, '../..');
const requireConformanceSource = createRequire(import.meta.url);
const conformanceLoadedPaths = [SYNTHETIC_CASE_MANIFEST.P16.sources[1], SYNTHETIC_CASE_MANIFEST.P16.sources[2], SYNTHETIC_CASE_MANIFEST.P16.sources[4], SYNTHETIC_CASE_MANIFEST.P16.sources[5]];
// Snapshot the validator's own fixed sources, not arbitrary producer-supplied modules. Failure is diagnostic-only.
const conformanceLoadedHashes = (() => { try { return conformanceLoadedPaths.map(path => hashFile(join(validatorRoot, path))); } catch { return undefined; } })();
/**
 * Check source-domain membership and the correspondence of saved rows, not renderer truth.
 * Matching aggregate coverage is a producer declaration; unrecorded successful comparisons cannot be replayed.
 */
function completeConformanceEvidence(records: readonly SyntheticSavedRecord[], root: string, sourceSha256: string): boolean {
  try {
    if (!conformanceLoadedHashes || syntheticCaseSourceDigest(root, 'P16') !== sourceSha256
      || conformanceLoadedPaths.some((path, index) => hashFile(join(root, path)) !== conformanceLoadedHashes[index] || hashFile(join(validatorRoot, path)) !== conformanceLoadedHashes[index])) return false;
    // This source has only erased type dependencies on browser fixtures. Load the fixed, hash-checked module
    // without expanding scripts' TypeScript graph to those unrelated DOM-only fixture definitions.
    const { TODO_REASON: todoReason } = requireConformanceSource(join(validatorRoot, SYNTHETIC_CASE_MANIFEST.P16.sources[5])) as { TODO_REASON: unknown };
    if (typeof todoReason !== 'string' || todoReason.length > 256) return false;
    const domain = conformanceSourceDomain(loadConformanceTables(validatorRoot), readFileSync(join(root, SYNTHETIC_CASE_MANIFEST.P16.sources[3]), 'utf8'));
    const facts = records.flatMap(record => record.kind === 'record' ? [record.fact] : []);
    const coverage = facts.filter(fact => fact.kind === 'conformance-coverage');
    const counts = facts.filter(fact => fact.kind === 'conformance-counts');
    const mismatches = facts.filter(fact => fact.kind === 'conformance');
    const summaries = facts.filter(fact => fact.kind === 'conformance-summary');
    if (coverage.length !== 2 || new Set(coverage.map(fact => fact.tableOrdinal)).size !== 2 || counts.length !== 1) return false;
    // These counters exclude both coverage rows, counts itself, phases, header and footer.
    if (counts[0]!.omitted !== 0 || counts[0]!.truncated || counts[0]!.emitted !== mismatches.length + summaries.length || counts[0]!.total !== counts[0]!.emitted) return false;
    for (const table of domain.tables) {
      const observed = coverage.find(fact => fact.tableOrdinal === table.tableOrdinal);
      if (!observed?.complete || observed.expectedCases !== table.expectedCases || observed.expectedTargets !== table.expectedTargets || observed.expectedComparisons !== table.expectedComparisons
        || observed.completedCases !== table.expectedCases || observed.completedTargets !== table.expectedTargets || observed.checkedComparisons !== table.expectedComparisons
        || observed.uniqueComparisons !== table.expectedComparisons || observed.mismatchComparisons !== mismatches.filter(fact => fact.tableOrdinal === table.tableOrdinal).length) return false;
    }
    const expectedByCoordinate = new Map([...domain.expectations.values()].map(entry => [conformanceCoordinateKey(entry.coordinate), entry]));
    if (expectedByCoordinate.size !== domain.expectations.size) return false;
    const mismatchByCoordinate = new Map<string, Extract<SyntheticFact, { kind: 'conformance' }>>();
    for (const mismatch of mismatches) {
      const key = conformanceCoordinateKey(mismatch);
      if (!domain.coordinates.has(key) || mismatchByCoordinate.has(key) || mismatch.matchesAxe || mismatch.listed === mismatch.observedMissing
        || (mismatch.matchesExistingException && !expectedByCoordinate.has(key))) return false;
      mismatchByCoordinate.set(key, mismatch);
    }
    const summaryKey = (row: Extract<SyntheticFact, { kind: 'conformance-summary' }>) => `${row.category}:${row.tableOrdinal}:${row.caseOrdinal}:${row.targetOrdinal}:${row.expectedLineOrdinal}`;
    const requiredSummaries = new Set<string>();
    for (const mismatch of mismatches) if (!mismatch.matchesExistingException) requiredSummaries.add(summaryKey({ ...mismatch, kind: 'conformance-summary', category: 'unexpected', expectedLineOrdinal: 0 }));
    for (const entry of domain.expectations.values()) {
      if (!mismatchByCoordinate.get(conformanceCoordinateKey(entry.coordinate))?.matchesExistingException) requiredSummaries.add(summaryKey({ ...entry.coordinate, kind: 'conformance-summary', category: 'stale', expectedLineOrdinal: entry.expectedLineOrdinal }));
      if (entry.reason === todoReason) requiredSummaries.add(summaryKey({ ...entry.coordinate, kind: 'conformance-summary', category: 'todo', expectedLineOrdinal: entry.expectedLineOrdinal }));
    }
    const actualSummaries = new Set(summaries.map(summaryKey));
    return actualSummaries.size === summaries.length && actualSummaries.size === requiredSummaries.size
      && [...actualSummaries].every(key => requiredSummaries.has(key)) && syntheticCaseSourceDigest(root, 'P16') === sourceSha256;
  } catch { return false; }
}
/** All four fixed comparison targets must be represented exactly once; phase/footer alone is not evidence. */
function completeCanvasEvidence(records: readonly SyntheticSavedRecord[]): boolean {
  const targets = records.flatMap(record => record.kind === 'record' && record.fact.kind === 'canvas-oracle' ? [record.fact.targetOrdinal] : []);
  return targets.length === 4 && new Set(targets).size === 4 && [0, 1, 2, 3].every(target => targets.includes(target as 0 | 1 | 2 | 3));
}
/** Explicit suite ownership fixes the maximum aggregate budget before any fixture can write. */
export function prepareSyntheticCapture(root: string, suite: SyntheticSuite, identity: Omit<SyntheticBinding, 'runId' | 'suite'>, inherited: NodeJS.ProcessEnv): SyntheticCapture {
  if (SYNTHETIC_TOTAL_BYTES > SYNTHETIC_MANIFEST_BYTES) throw new Error('Synthetic evidence exceeds aggregate budget');
  const binding: SyntheticBinding = { runId: randomBytes(16).toString('hex'), suite, ...identity };
  if (!validSyntheticBinding(binding)) throw new Error('Invalid synthetic binding');
  const cases = (Object.keys(SYNTHETIC_CASE_MANIFEST) as SyntheticCaseId[]).filter(caseId => SYNTHETIC_CASE_MANIFEST[caseId].suite === suite)
    .map(caseId => ({ caseId, sourceSha256: syntheticCaseSourceDigest(root, caseId) }));
  const configuration: SyntheticConfiguration = { schemaVersion: 1, binding, cases };
  if (!validSyntheticConfiguration(configuration)) throw new Error('Invalid synthetic configuration');
  const directory = mkdtempSync(join(tmpdir(), 'e2e-synthetic-evidence-'));
  requireSyntheticDirectory(directory);
  writeFileSync(join(directory, SYNTHETIC_BINDING_FILE), JSON.stringify(configuration), { flag: 'wx', mode: 0o600 });
  const env = { ...cleanSyntheticEnvironment(inherited), [SYNTHETIC_BATCH_ENV]: '1', [SYNTHETIC_DIRECTORY_ENV]: directory, [SYNTHETIC_BINDING_ENV]: JSON.stringify(binding) };
  return { sourceRoot: root, directory, configuration, env };
}
function inspectCase(directory: string, entry: SyntheticConfiguration['cases'][number], binding: SyntheticBinding, unexpected: boolean, sourceRoot: string): CaseEvidence {
  const reasons: Reason[] = unexpected ? ['unexpected-entry'] : []; const records: SyntheticSavedRecord[] = [];
  const budget = SYNTHETIC_CASE_MANIFEST[entry.caseId]; let bytes: Buffer | undefined;
  try { bytes = readSyntheticFile(join(directory, `${entry.caseId}.jsonl`), budget.maxBytes); }
  catch { reasons.push('unavailable-file'); }
  if (bytes !== undefined) {
    if (bytes.at(-1) !== 10) reasons.push('partial-record');
    const lines = bytes.toString('utf8').split('\n'); if (lines.at(-1) === '') lines.pop();
    if (lines.length > budget.maxRecords) reasons.push('invalid-record');
    for (const line of lines.slice(0, budget.maxRecords)) {
      try {
        const item: unknown = JSON.parse(line);
        if (Buffer.byteLength(line) + 1 > SYNTHETIC_RECORD_BYTES || !validSyntheticSavedRecord(item, entry.caseId) || JSON.stringify(item) !== line) { reasons.push('invalid-record'); continue; }
        if (item.kind === 'header' && (JSON.stringify(item.binding) !== JSON.stringify(binding) || item.sourceSha256 !== entry.sourceSha256)) { reasons.push('wrong-binding'); continue; }
        records.push(item);
      } catch { reasons.push('invalid-record'); }
    }
  }
  // A record without its exact source/run header has no established provenance, even when its scalar schema is safe.
  if (records[0]?.kind !== 'header' || reasons.includes('wrong-binding')) records.length = 0;
  const first = records[0]; const last = records.at(-1);
  if (first?.kind !== 'header' || records.filter(record => record.kind === 'header').length !== 1) reasons.push('missing-header');
  if (last?.kind !== 'footer' || records.filter(record => record.kind === 'footer').length !== 1) reasons.push('missing-footer');
  const facts = records.filter(record => record.kind === 'record');
  if (facts.some((record, index) => record.sequence !== index) || (last?.kind === 'footer' && last.sequence !== facts.length)
    || records.slice(1, -1).some(record => record.kind !== 'record')) reasons.push('sequence');
  if (last?.kind === 'footer') {
    if (last.dropped || last.truncated) reasons.push('dropped');
    if (last.incomplete || Object.values(last.outcome).includes('incomplete') || (entry.caseId === 'nested-setup' ? last.outcome.setup : last.outcome.body) === 'not-started') reasons.push('incomplete');
  }
  if (facts.some(({ fact }) => ('truncated' in fact && fact.truncated) || ('unavailable' in fact && fact.unavailable))) reasons.push('incomplete');
  const slots = facts.flatMap(({ fact }) => fact.kind === 'native-result' ? [fact.slot] : fact.kind === 'request-rejected-without-result' ? [fact.kind] : []);
  if (new Set(slots).size !== slots.length) reasons.push('invalid-record');
  if (entry.caseId === 'P16' && !completeConformanceEvidence(records, sourceRoot, entry.sourceSha256)) reasons.push('incomplete');
  if (entry.caseId === 'P42O' && !completeCanvasEvidence(records)) reasons.push('incomplete');
  return { caseId: entry.caseId, sourceSha256: entry.sourceSha256, status: reasons.length ? 'unknown' : 'complete', reasons: [...new Set(reasons)], records, recordsSha256: sha256(Buffer.from(JSON.stringify(records))) };
}
/** Only fully schema-validated records are saved. Rejected raw bytes are neither uploaded nor hashed as recoverable evidence. */
export function collectSyntheticEvidence(output: string, capture: SyntheticCapture | undefined): SyntheticEvidenceReceipt {
  const unavailable = (reason: 'setup-failed' | 'collection-failed'): SyntheticEvidenceReceipt => ({ schemaVersion: 1, status: 'unknown', file: null, sha256: null, bytes: 0, reason });
  if (!capture) return unavailable('setup-failed');
  try {
    requireSyntheticDirectory(capture.directory);
    const current: unknown = JSON.parse(readSyntheticFile(join(capture.directory, SYNTHETIC_BINDING_FILE), 16 * 1024).toString('utf8'));
    if (!validSyntheticConfiguration(current) || JSON.stringify(current) !== JSON.stringify(capture.configuration)) return unavailable('collection-failed');
    const allowed = new Set([SYNTHETIC_BINDING_FILE, ...current.cases.map(item => `${item.caseId}.jsonl`)]);
    const directory = opendirSync(capture.directory); let unexpected = false; let count = 0;
    try {
      for (;;) {
        const entry = directory.readSync(); if (!entry) break;
        if (++count > allowed.size || !allowed.has(entry.name)) { unexpected = true; break; }
      }
    } finally { directory.closeSync(); }
    const cases = current.cases.map(entry => inspectCase(capture.directory, entry, current.binding, unexpected, capture.sourceRoot));
    const manifest: Manifest = { schemaVersion: 1, binding: current.binding, status: cases.every(item => item.status === 'complete') ? 'complete' : 'unknown', cases };
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > SYNTHETIC_MANIFEST_BYTES) return unavailable('collection-failed');
    const file = syntheticArtifactFile(current.binding.suite);
    writeFileSync(join(output, file), bytes, { flag: 'wx', mode: 0o600 });
    return { schemaVersion: 1, status: manifest.status, file, sha256: sha256(bytes), bytes: bytes.length, reason: 'collected' };
  } catch { return unavailable('collection-failed'); }
}
/** Final acceptance requires complete diagnostics only when this one batch was explicitly requested. */
export function verifySyntheticEvidence(output: string, value: unknown, expected: SyntheticBinding, root: string): void {
  const fail = (): never => { throw new Error('Synthetic evidence is missing, invalid or incomplete'); };
  if (!validSyntheticBinding(expected) || !syntheticObject(value) || !syntheticKeys(value, ['schemaVersion', 'status', 'file', 'sha256', 'bytes', 'reason'])
    || value['schemaVersion'] !== 1 || value['status'] !== 'complete' || value['reason'] !== 'collected'
    || value['file'] !== syntheticArtifactFile(expected.suite) || !syntheticDigest(value['sha256']) || !syntheticCount(value['bytes'], SYNTHETIC_MANIFEST_BYTES)) fail();
  const receipt = value as SyntheticEvidenceReceipt;
  const bytes = readSyntheticFile(join(output, receipt.file!), SYNTHETIC_MANIFEST_BYTES);
  if (bytes.length !== receipt.bytes || sha256(bytes) !== receipt.sha256) fail();
  let manifest: unknown; try { manifest = JSON.parse(bytes.toString('utf8')); } catch { fail(); }
  if (JSON.stringify(manifest) !== bytes.toString('utf8')) fail();
  if (!syntheticObject(manifest) || !syntheticKeys(manifest, ['schemaVersion', 'binding', 'status', 'cases']) || manifest['schemaVersion'] !== 1
    || manifest['status'] !== 'complete' || !validSyntheticBinding(manifest['binding']) || JSON.stringify(manifest['binding']) !== JSON.stringify(expected) || !Array.isArray(manifest['cases'])) fail();
  const caseIds = (Object.keys(SYNTHETIC_CASE_MANIFEST) as SyntheticCaseId[]).filter(id => SYNTHETIC_CASE_MANIFEST[id].suite === expected.suite);
  const caseEvidence = (manifest as unknown as Manifest).cases;
  if (caseEvidence.length !== caseIds.length) fail();
  for (const [index, item] of caseEvidence.entries()) {
    if (!syntheticObject(item) || !syntheticKeys(item, ['caseId', 'sourceSha256', 'status', 'reasons', 'records', 'recordsSha256'])
      || !syntheticCase(item['caseId']) || item['caseId'] !== caseIds[index] || item['status'] !== 'complete' || !Array.isArray(item['reasons']) || item['reasons'].length
      || item['sourceSha256'] !== syntheticCaseSourceDigest(root, item['caseId']) || !Array.isArray(item['records']) || !syntheticDigest(item['recordsSha256'])) fail();
    const recordItems = item.records; const budget = SYNTHETIC_CASE_MANIFEST[item.caseId];
    if (recordItems.length < 2 || recordItems.length > budget.maxRecords || Buffer.byteLength(recordItems.map(record => `${JSON.stringify(record)}\n`).join('')) > budget.maxBytes
      || recordItems.some(record => !validSyntheticSavedRecord(record, item.caseId) || Buffer.byteLength(JSON.stringify(record)) + 1 > SYNTHETIC_RECORD_BYTES)
      || sha256(Buffer.from(JSON.stringify(recordItems))) !== item.recordsSha256) fail();
    const slots = recordItems.flatMap(record => record.kind === 'record' && record.fact.kind === 'native-result' ? [record.fact.slot] : record.kind === 'record' && record.fact.kind === 'request-rejected-without-result' ? [record.fact.kind] : []);
    if (new Set(slots).size !== slots.length) fail();
    if (item.caseId === 'P16' && !completeConformanceEvidence(recordItems, root, item.sourceSha256)) fail();
    if (item.caseId === 'P42O' && !completeCanvasEvidence(recordItems)) fail();
    const first = recordItems[0]; const last = recordItems.at(-1);
    if (first?.kind !== 'header' || JSON.stringify(first.binding) !== JSON.stringify(expected) || first.sourceSha256 !== item.sourceSha256 || last?.kind !== 'footer'
      || last.sequence !== recordItems.length - 2 || last.dropped !== 0 || last.truncated || last.incomplete || Object.values(last.outcome).includes('incomplete')
      || (item.caseId === 'nested-setup' ? last.outcome.setup : last.outcome.body) === 'not-started'
      || recordItems.slice(1, -1).some((record, ordinal) => record.kind !== 'record' || record.sequence !== ordinal
        || ('truncated' in record.fact && record.fact.truncated) || ('unavailable' in record.fact && record.fact.unavailable))) fail();
  }
}
