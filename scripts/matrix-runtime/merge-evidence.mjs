#!/usr/bin/env node
// Read-only, two-batch diagnostic binding. Never starts tests, repairs reports, or grants acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARTITIONS, reconcile, validateInventories } from './reconcile.mjs';

const P14 = 'cli-cancel-P14-1';
const NON_EXECUTED = new Set(['skipped', 'pending', 'todo', 'disabled']);
const EXECUTED = new Set(['passed', 'failed']);
const key = item => JSON.stringify([item.file, item.fullName]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const countBy = (rows, field) => rows.reduce((out, row) => ({ ...out, [row[field]]: (out[row[field]] ?? 0) + 1 }), {});
const requireValue = (condition, message) => assert.ok(condition, `Evidence binding rejected: ${message}`);
const equal = (actual, expected, message) => assert.deepEqual(actual, expected, `Evidence binding rejected: ${message}`);
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const CAPS = ['operation.continue-exact-owner/1', 'terminal.close/1', 'browser.scope/1', 'browser.lifecycle/1',
  'browser.evaluate/1', 'browser.page/1', 'browser.observe/1', 'browser.query/1', 'browser.actions/1',
  'browser.network/1', 'browser.fixture-read-fields/1', 'browser.dialog/1', 'browser.download/1',
  'browser.capture/1', 'browser.state/1', 'browser.recording/1', 'browser.blobs/1'];
export const IDENTITY_FILES = ['source-before.json', 'source-after.json', 'images-before.json', 'images-after.json',
  'dist-before.json', 'dist-after.json', 'postrun-identities.json', 'artifact-identity.json', 'production-negotiation.json'];
export const RAW_FILES = [...IDENTITY_FILES, ...Object.keys(PARTITIONS).flatMap(partition =>
  [`${partition}.state.json`, ...(partition === P14 ? [] : [`${partition}.vitest.json`])])];
const OPTIONAL_FILES = [`${P14}.vitest.json`, 'case-ledger.json', 'summary.json', 'required-capabilities.json'];
const parse = (files, name) => {
  requireValue(typeof files[name] === 'string', `missing raw file ${name}`);
  try { return JSON.parse(files[name]); } catch { throw new Error(`Evidence binding rejected: invalid JSON in ${name}`); }
};

export function readBatch(directory, repoRoot, provenance) {
  const files = {};
  for (const name of [...RAW_FILES, ...OPTIONAL_FILES]) {
    try { files[name] = fs.readFileSync(path.join(directory, name), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT' || RAW_FILES.includes(name)) throw error; }
  }
  return { files, repoRoot, provenance };
}

function verifyIdentity(batch, pins, label) {
  const get = name => parse(batch.files, name);
  const source = get('source-before.json');
  equal(get('source-after.json'), source, `${label} source changed during execution`);
  equal(source.e2e, { commit: pins.sourceSha, tree: pins.sourceTree, status: '' }, `${label} e2e source identity`);
  equal(source.native, { commit: pins.nativeSha, tree: pins.nativeTree, status: '' }, `${label} native source identity`);
  requireValue(SHA.test(source.recipe?.commit) && SHA.test(source.recipe?.tree) && source.recipe.status === '', `${label} recipe identity`);
  equal(source.recipe.commit, batch.provenance.recipeSha, `${label} recipe provenance`);
  requireValue(HASH.test(source.pnpmLockSha256), `${label} lock digest`);
  const images = get('images-before.json');
  equal(get('images-after.json'), images, `${label} runtime images changed during execution`);
  for (const kind of ['full', 'shell', 'production']) requireValue(HASH.test(images[kind]?.sha256), `${label} ${kind} image digest`);
  equal(images.production.sha256, pins.binarySha256, `${label} production binary identity`);
  const artifact = get('artifact-identity.json');
  equal(artifact.binarySha256, pins.binarySha256, `${label} artifact binary identity`);
  requireValue(HASH.test(artifact.zipSha256) && artifact.rustBuild === false, `${label} native artifact provenance`);
  equal(get('dist-after.json'), get('dist-before.json'), `${label} dist changed during execution`);
  const checks = get('postrun-identities.json');
  for (const name of ['source', 'images', 'dist']) equal(checks[name]?.status, 'passed', `${label} ${name} final check`);
  const proof = get('production-negotiation.json');
  requireValue(proof?.status === 'passed' && proof.binarySha256 === pins.binarySha256 &&
    proof.scopeExercisePassed === true && proof.cleanupConfirmed === true &&
    proof.negotiation?.protocol === 'agent-browser-session/1' && Array.isArray(proof.negotiation.capabilities) &&
    CAPS.every(cap => proof.negotiation.capabilities.includes(cap)) &&
    !proof.negotiation.capabilities.some(cap => cap.startsWith('acceptance.')),
  `${label} invalid production runtime proof`);
  equal(proof.chromium?.sha256, images.full.sha256, `${label} proof Chromium identity`);
  return { source, images, artifact };
}

function reconcileBatch(inventories, batch, label) {
  requireValue(path.isAbsolute(batch.repoRoot ?? ''), `${label} repoRoot must be explicit and absolute`);
  const reports = {}, states = {};
  for (const partition of Object.keys(PARTITIONS)) {
    reports[partition] = batch.files[`${partition}.vitest.json`];
    states[partition] = batch.files[`${partition}.state.json`];
  }
  const result = reconcile({ inventories, reports, states, repoRoot: batch.repoRoot });
  for (const group of result.summary.partitions) {
    requireValue(group.errors.length === 0 && group.invalidAssertions.length === 0 && group.duplicateIdentities.length === 0 &&
      group.unexpectedExecutedCases.length === 0 && group.unexpectedNonExecutedCases.length === 0,
    `${label} ${group.partition} invalid, alien, or duplicate raw evidence`);
    if (group.partition === P14) equal(group.state, 'not-run', `${label} P14 must remain not-run`);
    else requireValue(group.state === 'finished' && Number.isInteger(group.exitCode) && typeof group.reportSuccess === 'boolean',
      `${label} ${group.partition} unfinished or incomplete report/process evidence`);
    for (const row of group.assertions) requireValue(EXECUTED.has(row.rawStatus) || NON_EXECUTED.has(row.rawStatus), `${label} unsupported raw status`);
  }
  equal(result.summary.duplicateIdentities, [], `${label} duplicate execution identities`);
  return result;
}

function batchProvenance(batch, label) {
  const p = batch.provenance;
  requireValue(p && /^\d+$/.test(String(p.runId)) && SHA.test(p.recipeSha) && ((typeof p.artifactName === 'string' && p.artifactName.length > 0) || (label === 'prior' && /^https:\/\/github\.com\//.test(p.artifactUrl ?? '') && p.artifactId != null)),
    `${label} missing run/recipe/artifact provenance`);
  if (p.artifactId != null) requireValue(/^\d+$/.test(String(p.artifactId)), `${label} invalid artifact ID`);
  return { ...p, artifactName: p.artifactName ?? null, artifactId: p.artifactId ?? null, artifactZipSha256: p.artifactZipSha256 ?? null,
    repoRoot: batch.repoRoot, sourceIdentity: parse(batch.files, 'source-before.json'),
    nativeArtifactIdentity: parse(batch.files, 'artifact-identity.json'), files: Object.fromEntries(Object.entries(batch.files).map(([name, bytes]) => [name, sha256(bytes)])) };
}

export function mergeEvidence({ inventories, prior, next, manifest }) {
  const expected = validateInventories(inventories);
  requireValue(manifest?.schemaVersion === 1 && manifest.prior && Array.isArray(manifest.retained) && Array.isArray(manifest.selected), 'invalid manifest');
  const pins = manifest.prior;
  for (const field of ['sourceSha', 'sourceTree', 'nativeSha', 'nativeTree', 'recipeSha']) requireValue(SHA.test(pins[field]), `invalid manifest ${field}`);
  for (const field of ['binarySha256', 'artifactZipSha256']) requireValue(HASH.test(pins[field]), `invalid manifest ${field}`);
  equal(prior.provenance.runId, pins.runId, 'prior run provenance');
  equal(prior.provenance.artifactId, pins.artifactId, 'prior artifact provenance');
  equal(prior.provenance.artifactZipSha256, pins.artifactZipSha256, 'prior archive provenance');
  equal(prior.provenance.recipeSha, pins.recipeSha, 'prior recipe provenance');
  equal(prior.repoRoot, pins.repoRoot, 'prior repoRoot provenance');
  requireValue(String(next.provenance.runId) !== String(pins.runId), 'next run must be distinct from prior run');
  for (const name of RAW_FILES) {
    requireValue(HASH.test(pins.artifacts?.[name] ?? ''), `missing frozen prior digest ${name}`);
    equal(sha256(prior.files[name] ?? ''), pins.artifacts[name], `prior raw file digest ${name}`);
  }
  for (const name of OPTIONAL_FILES) if (pins.artifacts?.[name]) equal(sha256(prior.files[name] ?? ''), pins.artifacts[name], `prior optional raw file digest ${name}`);
  for (const name of Object.keys(pins.artifacts ?? {})) {
    requireValue([...RAW_FILES, ...OPTIONAL_FILES].includes(name), `unsupported frozen artifact ${name}`);
    equal(sha256(prior.files[name] ?? ''), pins.artifacts[name], `frozen artifact digest ${name}`);
  }
  const oldIdentity = verifyIdentity(prior, pins, 'prior');
  if (pins.recipeTree) equal(oldIdentity.source.recipe.tree, pins.recipeTree, 'prior recipe tree');
  const newIdentity = verifyIdentity(next, pins, 'next');
  equal(newIdentity.source.pnpmLockSha256, oldIdentity.source.pnpmLockSha256, 'lock changed between batches');
  for (const kind of ['full', 'shell', 'production']) equal(newIdentity.images[kind].sha256, oldIdentity.images[kind].sha256, `${kind} changed between batches`);
  for (const field of ['playwrightVersion', 'chromiumRevision']) equal(newIdentity.images[field], oldIdentity.images[field], `${field} changed between batches`);
  equal(newIdentity.artifact, oldIdentity.artifact, 'native artifact changed between batches');
  equal(parse(next.files, 'dist-before.json'), parse(prior.files, 'dist-before.json'), 'dist changed between batches');
  const previous = reconcileBatch(inventories, prior, 'prior');
  const current = reconcileBatch(inventories, next, 'next');
  equal(previous.summary.statusCounts, { skipped: 302, 'not-run': 1, passed: 20, failed: 1 }, 'prior exact 20 passed, 1 failed, 302 skipped, P14 not-run baseline');
  const notRun = expected.filter(item => item.partition === P14);
  equal(manifest.notRun?.map(({ file, fullName, partition, caseId }) => ({ file, fullName, partition, caseId })),
    notRun.map(({ file, fullName, partition, caseId }) => ({ file, fullName, partition, caseId })), 'frozen P14 identity');
  const known = new Map(expected.map(item => [key(item), item]));
  function selection(rows, label, count) {
    requireValue(rows.length === count, `${label} must contain exactly ${count} identities`);
    const map = new Map();
    for (const row of rows) {
      const id = key(row), original = known.get(id);
      requireValue(original && original.partition === row.partition && row.partition !== P14, `${label} alien or changed identity`);
      requireValue(!map.has(id), `${label} duplicate identity`); map.set(id, row);
    }
    return map;
  }
  const retained = selection(manifest.retained, 'retained', 21);
  const selected = selection(manifest.selected, 'selected', 302);
  for (const row of manifest.selected) {
    requireValue(!retained.has(key(row)), 'selected overlaps retained');
    requireValue(Array.isArray(row.ancestorTitles) && row.ancestorTitles.every(title => typeof title === 'string') && typeof row.title === 'string' &&
      [...row.ancestorTitles, row.title].join(' ') === row.fullName, 'selected reporter identity does not match ancestorTitles/title');
  }
  for (const row of previous.ledger.cases) {
    if (EXECUTED.has(row.status)) {
      const frozen = retained.get(key(row));
      requireValue(frozen && frozen.status === row.status, 'retained status/identity changed from raw prior report');
      equal(frozen.reportSha256, pins.artifacts[`${row.partition}.vitest.json`], 'retained raw report provenance');
      const observation = row.observations.find(item => item.partition === row.partition);
      equal(frozen.suiteIndex, observation.suiteIndex, 'retained suite index');
      equal(frozen.assertionIndex, observation.assertionIndex, 'retained assertion index');
    } else if (row.partition !== P14) requireValue(row.status === 'skipped' && selected.has(key(row)), 'selected differs from 302 previously unexecuted cases');
  }
  const old = new Map(previous.ledger.cases.map(row => [key(row), row]));
  const fresh = new Map(current.ledger.cases.map(row => [key(row), row]));
  for (const group of current.summary.partitions) for (const observation of group.assertions) {
    if (!NON_EXECUTED.has(observation.rawStatus)) requireValue(selected.has(key(observation)), 'executed replay or execution outside selected 302');
  }
  for (const row of manifest.selected) {
    const result = fresh.get(key(row));
    requireValue((EXECUTED.has(result.status) || NON_EXECUTED.has(result.status) || result.status === 'missing') &&
      result.selectedObservationCount <= 1 && !result.duplicate, `selected case has invalid outcome evidence: ${key(row)}`);
  }
  const priorProvenance = batchProvenance(prior, 'prior'), nextProvenance = batchProvenance(next, 'next');
  const batches = { prior: priorProvenance, next: nextProvenance };
  const cases = expected.map(item => {
    const id = key(item), fromPrior = retained.has(id), p14 = item.partition === P14;
    const result = p14 || fromPrior ? old.get(id) : fresh.get(id);
    const batchId = p14 || fromPrior ? 'prior' : 'next';
    const batch = batches[batchId];
    const selectedObservations = result.observations.filter(observation => observation.partition === item.partition);
    return { ...result, executed: EXECUTED.has(result.status), verifiedPass: fromPrior || p14 ? false : result.verifiedPass,
      outcomeBatch: p14 ? null : batchId,
      outcomeProvenance: p14 ? null : { batch: batchId, runId: batch.runId, artifactId: batch.artifactId, artifactName: batch.artifactName,
        recipeSha: batch.recipeSha, reportFile: `${item.partition}.vitest.json`, reportSha256: batch.files[`${item.partition}.vitest.json`],
        observations: selectedObservations.map(({ suiteIndex, assertionIndex, rawStatus }) => ({ suiteIndex, assertionIndex, rawStatus })) },
      observations: [...old.get(id).observations.map(row => ({ ...row, batch: 'prior', role: fromPrior && EXECUTED.has(row.rawStatus) ? 'retained-outcome' : 'filtered-skip' })),
        ...fresh.get(id).observations.map(row => ({ ...row, batch: 'next', role: selected.has(id) && row.partition === item.partition
          ? EXECUTED.has(row.rawStatus) ? 'selected-outcome' : 'selected-unexecuted' : 'filtered-skip' }))] };
  });
  const flags = { diagnosticOnly: true, releaseEligible: false, fullAcceptance: false, all324Passed: false };
  const reportGroups = [previous, current].flatMap((result, index) => result.summary.partitions.map(group => ({
    batch: index === 0 ? 'prior' : 'next', partition: group.partition, state: group.state, exitCode: group.exitCode,
    reportSuccess: group.reportSuccess, reportFailed: group.reportFailed, processFailed: group.processFailed,
    rawStatusCounts: group.rawStatusCounts, reportSha256: batches[index === 0 ? 'prior' : 'next'].files[`${group.partition}.vitest.json`] ?? null })));
  const selectedCases = cases.filter(row => selected.has(key(row)));
  const newlyExecutedCount = selectedCases.filter(row => row.executed).length;
  const summary = { schemaVersion: 1, ...flags, complete: false, evidenceBindingComplete: true,
    coverageComplete: newlyExecutedCount === 302, coverageScope: 'runnable-323-only; P14 excluded', expectedCount: 324,
    runnableExpectedCount: 323, runnable323Passed: false, statusCounts: countBy(cases, 'status'),
    retainedExecutedCount: 21, newlyExecutedCount, selectedUnexecutedCount: 302 - newlyExecutedCount,
    selectedMissingCount: selectedCases.filter(row => row.missing).length, verifiedPassCount: cases.filter(row => row.verifiedPass).length,
    duplicateIdentities: [], unexpectedExecutedCount: 0, priorReportFailureRetained: previous.summary.partitions.some(group => group.reportFailed),
    priorProcessFailureRetained: previous.summary.partitions.some(group => group.processFailed), reportGroups,
    acceptanceBlockers: ['The original failed case and report/process failures are retained, not rerun or repaired.',
      ...(newlyExecutedCount < 302 ? ['Some selected cases remain unexecuted or missing; their raw diagnostic outcomes are preserved.'] : []),
      'P14 is explicitly not run; no cancellation feature artifact.', 'This is diagnostic evidence binding only, not release acceptance.'] };
  return { ledger: { schemaVersion: 1, ...flags, expectedCount: 324, manifestSha256: sha256(JSON.stringify(manifest)), batches, cases }, summary };
}

function main() {
  const [inventoryDir, priorDir, nextDir, manifestFile, outputDir, ...extra] = process.argv.slice(2);
  if (!outputDir || extra.length) throw new Error('Usage: node merge-evidence.mjs INVENTORY_DIR PRIOR_DIR NEXT_DIR MANIFEST_JSON OUTPUT_DIR');
  const manifestText = fs.readFileSync(manifestFile, 'utf8'), manifest = JSON.parse(manifestText);
  const inventories = Object.fromEntries(['original-306', 'new-4', 'callbacks-14'].map(name =>
    [name, JSON.parse(fs.readFileSync(path.join(inventoryDir, `${name}.json`), 'utf8'))]));
  const prior = readBatch(priorDir, manifest.prior.repoRoot, manifest.prior);
  requireValue(process.env.GITHUB_WORKSPACE && process.env.GITHUB_RUN_ID && process.env.RECIPE_SHA && process.env.NEXT_ARTIFACT_NAME,
    'GITHUB_WORKSPACE, GITHUB_RUN_ID, RECIPE_SHA, NEXT_ARTIFACT_NAME are required for next provenance');
  const next = readBatch(nextDir, path.join(process.env.GITHUB_WORKSPACE, 'e2e-source'), {
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    recipeSha: process.env.RECIPE_SHA, artifactName: process.env.NEXT_ARTIFACT_NAME });
  const result = mergeEvidence({ inventories, prior, next, manifest });
  result.ledger.manifestSha256 = sha256(manifestText);
  fs.mkdirSync(outputDir, { recursive: true });
  for (const name of ['combined-case-ledger.json', 'combined-summary.json'])
    requireValue(!fs.existsSync(path.join(outputDir, name)), `EEXIST: refusing to overwrite ${name}`);
  for (const [name, document] of [['combined-case-ledger.json', result.ledger], ['combined-summary.json', result.summary]])
    fs.writeFileSync(path.join(outputDir, name), `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ ...result.summary, reportGroups: undefined, outputDir }));
  // Binding succeeds independently of test success. Retained real failure keeps this gate red.
  process.exitCode = result.summary.runnable323Passed ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error.message); process.exitCode = 1;
    const outputDir = process.argv[6];
    if (outputDir) {
      try {
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, 'combined-binding-error.json'), JSON.stringify({
          schemaVersion: 1, diagnosticOnly: true, releaseEligible: false, fullAcceptance: false, all324Passed: false,
          evidenceBindingComplete: false, error: error.message, note: 'No combined outcome ledger was accepted; inspect unchanged raw batch evidence.'
        }, null, 2) + '\n', { flag: 'wx' });
      } catch (writeError) { console.error(`Could not create non-overwriting binding error receipt: ${writeError.message}`); }
    }
  }
}
