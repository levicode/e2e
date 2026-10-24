#!/usr/bin/env node
// Diagnostic evidence reconciliation only. This never starts tests or grants release acceptance.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePairCoverage } from './canvas-pair.mjs';
import { pins } from './identity.mjs';

const NON_EXECUTED = new Set(['skipped', 'pending', 'todo', 'disabled']);
const identity = (file, fullName) => JSON.stringify([file, fullName]);
const countBy = (rows, key) => rows.reduce((counts, row) => { const value = String(row[key]); counts[value] = (counts[value] ?? 0) + 1; return counts; }, {});
const validFile = file => typeof file === 'string' && file.startsWith('packages/') && !file.includes('\\') && path.posix.normalize(file) === file && !file.endsWith('/');
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
export function validateManifest(manifest) {
  if(manifest.kind!=='remaining-only-21-runtime-recipe'||manifest.expectedOriginalCount!==329||manifest.additionalRequiredAssertionCount!==4||manifest.cases.length!==329||manifest.additionalRequiredCases.length!==4||manifest.carryoverAllowed!==false) throw Error('Expected original333 universe without imported outcomes');
  const universe=[...manifest.cases,...manifest.additionalRequiredCases];
  if(new Set(universe.map(row=>identity(row.file,row.fullName))).size!==333)throw Error('Duplicate original identity');
  const cases=manifest.selectedCases.map(row=>({...row,partition:row.phase}));
  if(manifest.expectedSelectedCount!==21||manifest.expectedSelectedOriginalCount!==17||cases.length!==21||new Set(cases.map(row=>identity(row.file,row.fullName))).size!==21)throw Error('Expected exact21');
  // Compare sorted UTF-8 JSON using one canonical lexical ordering, not locale-sensitive titles.
  const canonical=createHash('sha256').update(JSON.stringify(cases.map(row=>[row.file,row.fullName,row.phase]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:a[2]<b[2]?-1:a[2]>b[2]?1:0))).digest('hex');
  if(canonical!=='cac87a0956b6bff4d36aa00b5413333023973ff3b895a97c216f781817364f0a'||manifest.selectedIdentitySha256!==canonical)throw Error('Remaining selection changed');
  if(cases.some(row=>!validFile(row.file)||!nonblank(row.fullName)||[...row.ancestorTitles,row.title].join(' ')!==row.fullName||!universe.some(item=>identity(item.file,item.fullName)===identity(row.file,row.fullName))))throw Error('Invalid exact identity');
  const counts={'display-value-1':1,'callbacks-14':14,'cli-installed-1':1,'cli-cancel-P14-1':1,'decision-cli-4':4};
  if(manifest.phases.length!==5||new Set(manifest.phases.map(p=>p.id)).size!==5)throw Error('Unexpected phase');
  for(const p of manifest.phases)if(counts[p.id]!==p.expectedCount||cases.filter(row=>row.partition===p.id).length!==p.expectedCount)throw Error('Wrong phase count');
  if(cases.filter(row=>row.priorStatus==='not-run').length!==20||cases.filter(row=>row.priorStatus==='failed').length!==1||cases.filter(row=>row.caseId==='P14').length!==1)throw Error('Wrong remaining-only obligation');
  if(manifest.remainingSelection.importedHistoricalOutcomes!==0||manifest.full333Complete!==false||manifest.fullRuntimeComplete!==false)throw Error('Historical/full-run promotion forbidden');
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
export function reconcile({ manifest, reports = {}, states = {}, repoRoot, pairCoverage, pairExpected }) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) throw new Error('repoRoot must be absolute');
  const root = path.resolve(repoRoot);
  const expected = validateManifest(manifest);
  const PARTITIONS=Object.fromEntries(manifest.phases.map(p=>[p.id,p.expectedCount]));
  let pairCoverageValid=false;
  try { validatePairCoverage(pairCoverage,pairExpected);pairCoverageValid=true; } catch { /* Raw P42O pass is not proof its optional body ran. */ }
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
    const effectiveState = state.status;
    if (effectiveState === 'not-run' && reportPresent) errors.push({ code: 'report-for-not-run-partition' });
    if (state.status === 'finished' && !reportPresent) errors.push({ code: 'missing-report' });
    const report = parseArtifact(reports[partition], `${partition}.vitest.json`, errors);
    const group = {
      partition, expectedCount, state: effectiveState, rawState,
      reason: state.reason ?? null,
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
    const requiresPairCoverage=['P42','P42O'].includes(item.caseId);
    return { ...item, status, pairCoverageRequired:requiresPairCoverage, pairCoverageVerified:requiresPairCoverage?pairCoverageValid:null, missing: selected.length === 0, duplicate,
      selectedObservationCount: selected.length, observations: all,
      rawStatuses: selected.map(row => row.rawStatus),
      verifiedPass: (!requiresPairCoverage||pairCoverageValid) && status === 'passed' && group.state === 'finished' && group.exitCode === 0 &&
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
  const allSelectedAssertionsPassed = cases.every(item => item.verifiedPass) &&
    groups.every(group => group.errors.length === 0 && group.invalidAssertions.length === 0 &&
      group.duplicateIdentities.length === 0 && group.unexpectedExecutedCases.length === 0 &&
      !group.processFailed && !group.reportFailed);
  const flags={diagnosticOnly:true,scope:'remaining-only21',releaseEligible:false,fullAcceptance:false,full333Complete:false,fullRuntimeComplete:false,importedHistoricalOutcomes:0};
  return {ledger:{schemaVersion:1,...flags,repoRoot:root,expectedCount:21,originalExpectedCount:17,additionalExpectedCount:4,universeExpectedCount:333,cases},
    summary:{schemaVersion:1,...flags,expectedCount:21,allSelectedAssertionsPassed,all333AssertionsPassed:false,statusCounts:countBy(cases,'status'),verifiedPassCount:cases.filter(c=>c.verifiedPass).length,
      missingCount:cases.filter(c=>c.missing).length,duplicateIdentities,partitions:groups,
      acceptanceBlockers:['Assertion reconciliation alone cannot establish runtime proof, sentinels, dependencies, image/cache integrity, cleanup or release acceptance.']}};
}

export function phaseSelectionExact(group,selected) {
  return group.state==='finished'&&Number.isInteger(group.exitCode)&&group.reportPresent&&group.errors.length===0&&group.invalidAssertions.length===0&&group.unexpectedExecutedCases.length===0&&group.duplicateIdentities.length===0&&selected.every(c=>c.selectedObservationCount===1&&!c.duplicate&&['passed','failed'].includes(c.status));
}

function main() {
  const [manifestFile, outputDir, repoRoot, phase] = process.argv.slice(2);
  if (!manifestFile || !outputDir || !repoRoot) throw Error('Usage: reconcile.mjs MANIFEST OUTPUT SOURCE [PHASE]');
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  const readOptional=filename=>{try{return fs.readFileSync(path.join(outputDir,filename),'utf8')}catch(e){if(e.code==='ENOENT')return undefined;throw e}};
  const reports=Object.fromEntries(manifest.phases.map(p=>[p.id,readOptional(`${p.id}.vitest.json`)]));
  const states=Object.fromEntries(manifest.phases.map(p=>[p.id,readOptional(`${p.id}.state.json`)]));
  const pairCoverage=parseArtifact(readOptional('canvas-pair-coverage.json'),'canvas-pair-coverage.json',[]);
  const pairFile=manifest.cases.find(row=>row.caseId==='P42O').file;
  const pairExpected={sourceRevision:manifest.sources.e2e.commit,binarySha256:pins.production.binarySha256,testSourceDigest:manifest.testSourceSha256[pairFile]};
  const {ledger,summary}=reconcile({manifest,reports,states,repoRoot:path.resolve(repoRoot),pairCoverage,pairExpected});
  if(phase){
    const group=summary.partitions.find(p=>p.partition===phase); if(!group)throw Error('Unknown phase');
    const selected=ledger.cases.filter(c=>c.partition===phase);
    // Failed assertions remain failed and may be reported alongside later phases.
    // Missing, skipped, zero-match, duplicates and alien execution are integrity failures.
    const exact=phaseSelectionExact(group,selected);
    fs.writeFileSync(path.join(outputDir,phase+'.selection.json'),JSON.stringify({phase,expected:group.expectedCount,exact,counts:group.statusCounts},null,2)+'\n');
    process.exitCode=exact?0:2;return;
  }
  fs.writeFileSync(path.join(outputDir,'case-ledger.json'),JSON.stringify(ledger,null,2)+'\n');
  fs.writeFileSync(path.join(outputDir,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify({expectedCount:21,statusCounts:summary.statusCounts,allSelectedAssertionsPassed:summary.allSelectedAssertionsPassed,all333AssertionsPassed:false,releaseEligible:false}));
  process.exitCode=summary.allSelectedAssertionsPassed?0:1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{main()}catch(error){console.error(error);process.exitCode=1}
}
