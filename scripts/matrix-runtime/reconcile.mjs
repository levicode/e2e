#!/usr/bin/env node
// Diagnostic evidence reconciliation only. This never starts tests or grants release acceptance.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PARTITIONS = Object.freeze({
  'original-noncli-304': 304,
  'new-4': 4,
  'callbacks-14': 14,
  'cli-installed-1': 1,
  'cli-cancel-P14-1': 1,
});
const INVENTORIES = { 'original-306': 306, 'new-4': 4, 'callbacks-14': 14 };
const CLI_FILE = 'packages/web/tests/integration/cli.test.ts';
const INSTALLED_NAME = 'e2e-web exits 0 when the browser is already installed';
const P14 = 'cli-cancel-P14-1';
const NON_EXECUTED = new Set(['skipped', 'pending', 'todo', 'disabled']);
const identity = (file, fullName) => JSON.stringify([file, fullName]);
const countBy = (rows, key) => rows.reduce((counts, row) => {
  const value = String(row[key]);
  counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}, {});
const fail = message => { throw new Error(`Invalid inventory: ${message}`); };
const validFile = file => typeof file === 'string' && file.startsWith('packages/') &&
  !file.includes('\\') && path.posix.normalize(file) === file && !file.endsWith('/');
const nonblank = value => typeof value === 'string' && value.trim().length > 0;

export function validateInventories(inventories) {
  const seen = new Set();
  const cases = [];
  for (const [source, count] of Object.entries(INVENTORIES)) {
    const document = inventories[source];
    if (!document || document.count !== count || !Array.isArray(document.cases) ||
        document.cases.length !== count) fail(`${source} must declare and contain ${count} cases`);
    for (const item of document.cases) {
      if (!validFile(item.file) || !nonblank(item.fullName)) fail(`${source} has an invalid identity`);
      const key = identity(item.file, item.fullName);
      if (seen.has(key)) fail(`duplicate identity ${key}`);
      seen.add(key);
      let partition = source === 'original-306' ? 'original-noncli-304' : source;
      if (source === 'original-306' && item.file === CLI_FILE) {
        if (item.caseId === 'P14') partition = P14;
        else if (item.fullName === INSTALLED_NAME) partition = 'cli-installed-1';
        else fail(`unrecognized original CLI identity ${key}`);
      }
      cases.push({ file: item.file, fullName: item.fullName, caseId: item.caseId ?? null, source, partition });
    }
  }
  if (cases.length !== 324 || seen.size !== 324) fail('expected 324 distinct identities');
  for (const [partition, count] of Object.entries(PARTITIONS)) {
    if (cases.filter(item => item.partition === partition).length !== count) fail(`${partition} must contain ${count} cases`);
  }
  if (cases.filter(item => item.caseId === 'P14').length !== 1) fail('P14 must occur exactly once');
  return cases;
}

function parseArtifact(value, label, errors) {
  if (value === undefined || value === null) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object');
    return parsed;
  } catch (error) {
    errors.push({ code: 'invalid-json', artifact: label, message: error.message });
    return null;
  }
}

function relativeSuiteFile(name, root) {
  // No basename/suffix matching, title reconstruction, realpath guesses, or case folding.
  if (typeof name !== 'string' || !path.isAbsolute(name) || path.normalize(name) !== name) return null;
  const relative = path.relative(root, name).split(path.sep).join('/');
  return validFile(relative) && !relative.startsWith('../') ? relative : null;
}

// Pure: callers supply raw JSON text or objects. Undefined means an absent artifact.
export function reconcile({ inventories, reports = {}, states = {}, repoRoot }) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) throw new Error('repoRoot must be absolute');
  const root = path.resolve(repoRoot);
  const expected = validateInventories(inventories);
  const known = new Map(expected.map(item => [identity(item.file, item.fullName), item]));
  const observations = new Map(expected.map(item => [identity(item.file, item.fullName), []]));
  const groups = [];

  for (const [partition, expectedCount] of Object.entries(PARTITIONS)) {
    const errors = [];
    const statePresent = states[partition] !== undefined && states[partition] !== null;
    const reportPresent = reports[partition] !== undefined && reports[partition] !== null;
    const rawState = parseArtifact(states[partition], `${partition}.state.json`, errors);
    const stateValid = rawState && ['not-run', 'running', 'finished'].includes(rawState.status);
    if (!statePresent) errors.push({ code: 'missing-state' });
    else if (!stateValid) errors.push({ code: 'invalid-state' });
    if (rawState?.exitCode !== undefined && !Number.isInteger(rawState.exitCode)) errors.push({ code: 'invalid-exit-code' });
    const state = stateValid ? rawState : { status: 'not-run', reason: 'Missing or invalid state evidence' };
    if (partition === P14 && state.status !== 'not-run') errors.push({ code: 'p14-must-remain-not-run' });
    const effectiveState = partition === P14 ? 'not-run' : state.status;
    if (effectiveState === 'not-run' && reportPresent) errors.push({ code: 'report-for-not-run-partition' });
    if (state.status === 'finished' && !reportPresent) errors.push({ code: 'missing-report' });
    const report = parseArtifact(reports[partition], `${partition}.vitest.json`, errors);
    const group = {
      partition, expectedCount, state: effectiveState, rawState,
      reason: partition === P14 ? 'No cancellation feature artifact; P14 is explicitly not run.' : state.reason ?? null,
      exitCode: rawState?.exitCode ?? null,
      processFailed: Number.isInteger(rawState?.exitCode) && rawState.exitCode !== 0,
      reportPresent, reportSuccess: report?.success ?? null, reportFailed: report?.success === false,
      errors, assertions: [], expectedFilteredSkips: [], unexpectedExecutedCases: [],
      unexpectedNonExecutedCases: [], invalidAssertions: [], duplicateIdentities: [],
    };
    groups.push(group);
    if (!report) continue;
    if (!Array.isArray(report.testResults)) { errors.push({ code: 'invalid-test-results' }); continue; }
    for (const [suiteIndex, suite] of report.testResults.entries()) {
      if (!suite || !Array.isArray(suite.assertionResults)) {
        errors.push({ code: 'invalid-suite', suiteIndex });
        continue;
      }
      const file = relativeSuiteFile(suite.name, root);
      for (const [assertionIndex, assertion] of suite.assertionResults.entries()) {
        const fullName = assertion?.fullName;
        const rawStatus = assertion?.status ?? null;
        const observation = {
          partition, suiteIndex, assertionIndex, suiteName: suite.name ?? null,
          file, fullName: fullName ?? null, rawStatus,
          failureMessages: assertion?.failureMessages ?? [],
          duration: assertion?.duration ?? null,
        };
        group.assertions.push(observation);
        const validIdentity = file !== null && nonblank(fullName);
        const item = validIdentity ? known.get(identity(file, fullName)) : undefined;
        const isNonExecuted = NON_EXECUTED.has(rawStatus);
        if (!validIdentity || !nonblank(rawStatus)) {
          group.invalidAssertions.push({ ...observation, reason: !file ? 'invalid-or-alien-suite-path' : !nonblank(fullName) ? 'blank-or-invalid-fullName' : 'invalid-status' });
        }
        if (item) observations.get(identity(file, fullName)).push(observation);
        if (item?.partition === partition) continue;
        if (item && isNonExecuted) group.expectedFilteredSkips.push(observation);
        else if (isNonExecuted) group.unexpectedNonExecutedCases.push(observation);
        else group.unexpectedExecutedCases.push(observation);
      }
    }
    const byIdentity = new Map();
    for (const observation of group.assertions) {
      if (observation.file === null || !nonblank(observation.fullName)) continue;
      const key = identity(observation.file, observation.fullName);
      if (!byIdentity.has(key)) byIdentity.set(key, []);
      byIdentity.get(key).push(observation);
    }
    group.duplicateIdentities = [...byIdentity.values()].filter(rows => rows.length > 1)
      .map(rows => ({ file: rows[0].file, fullName: rows[0].fullName, occurrences: rows }));
  }

  const byPartition = new Map(groups.map(group => [group.partition, group]));
  const cases = expected.map(item => {
    const group = byPartition.get(item.partition);
    const all = observations.get(identity(item.file, item.fullName));
    const selected = all.filter(row => row.partition === item.partition);
    const coverage = all.filter(row => row.partition === item.partition || !NON_EXECUTED.has(row.rawStatus));
    const duplicate = coverage.length > 1;
    let status = group.state === 'not-run' ? 'not-run' : selected.length === 0 ? 'missing' :
      duplicate ? 'duplicate' : nonblank(selected[0].rawStatus) ? selected[0].rawStatus : 'invalid-status';
    return { ...item, status, missing: selected.length === 0, duplicate,
      selectedObservationCount: selected.length, observations: all,
      rawStatuses: selected.map(row => row.rawStatus),
      verifiedPass: status === 'passed' && group.state === 'finished' && group.exitCode === 0 &&
        group.reportSuccess === true && group.errors.length === 0 && group.invalidAssertions.length === 0 &&
        group.unexpectedExecutedCases.length === 0 && group.duplicateIdentities.length === 0,
    };
  });
  const duplicateIdentities = cases.filter(item => item.duplicate).map(item => ({
    file: item.file, fullName: item.fullName,
    occurrences: item.observations.filter(row => row.partition === item.partition || !NON_EXECUTED.has(row.rawStatus)),
  }));
  for (const group of groups) {
    const rows = cases.filter(item => item.partition === group.partition);
    group.statusCounts = countBy(rows, 'status');
    group.rawStatusCounts = countBy(group.assertions, 'rawStatus');
    group.missingIdentities = rows.filter(item => item.missing).map(({ file, fullName }) => ({ file, fullName }));
  }
  const runnable323Passed = cases.filter(item => item.partition !== P14).every(item => item.verifiedPass) &&
    groups.every(group => group.errors.length === 0 && group.invalidAssertions.length === 0 &&
      group.duplicateIdentities.length === 0 && group.unexpectedExecutedCases.length === 0 &&
      !group.processFailed && !group.reportFailed);
  const flags = { diagnosticOnly: true, releaseEligible: false, fullAcceptance: false, all324Passed: false };
  return {
    ledger: { schemaVersion: 1, ...flags, repoRoot: root, expectedCount: 324, cases },
    summary: {
      schemaVersion: 1, ...flags, complete: false, runnableExpectedCount: 323, runnable323Passed,
      expectedCount: 324, statusCounts: countBy(cases, 'status'),
      verifiedPassCount: cases.filter(item => item.verifiedPass).length,
      missingCount: cases.filter(item => item.missing).length, duplicateIdentities,
      unexpectedExecutedCount: groups.reduce((sum, group) => sum + group.unexpectedExecutedCases.length, 0),
      expectedFilteredSkipCount: groups.reduce((sum, group) => sum + group.expectedFilteredSkips.length, 0),
      partitions: groups,
      acceptanceBlockers: ['P14 is explicitly not run; no cancellation feature artifact.', 'This reconciler produces diagnostic evidence only, not release acceptance.'],
    },
  };
}

function main() {
  const [inventoryDir, outputDir, repoRoot, ...extra] = process.argv.slice(2);
  if (!inventoryDir || !outputDir || !repoRoot || extra.length) {
    throw new Error('Usage: node reconcile.mjs INVENTORY_DIR OUTPUT_DIR REPO_ROOT');
  }
  const inventories = Object.fromEntries(Object.keys(INVENTORIES).map(name =>
    [name, JSON.parse(fs.readFileSync(path.join(inventoryDir, `${name}.json`), 'utf8'))]));
  const readOptional = filename => {
    try { return fs.readFileSync(path.join(outputDir, filename), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  };
  const reports = Object.fromEntries(Object.keys(PARTITIONS).map(name => [name, readOptional(`${name}.vitest.json`)]));
  const states = Object.fromEntries(Object.keys(PARTITIONS).map(name => [name, readOptional(`${name}.state.json`)]));
  const { ledger, summary } = reconcile({ inventories, reports, states, repoRoot: path.resolve(repoRoot) });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'case-ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ ...Object.fromEntries(['diagnosticOnly', 'releaseEligible', 'fullAcceptance', 'all324Passed', 'complete', 'runnable323Passed', 'expectedCount', 'statusCounts'].map(key => [key, summary[key]])), outputDir }));
  // Exit 0 verifies only the runnable 323 diagnostic cases. P14 and acceptance remain incomplete.
  process.exitCode = summary.runnable323Passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
