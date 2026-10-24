// Source/artifact verification reuses the reviewed focused-runtime recipe primitives.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mayContinueFocusedCase } from '../runtime-probe/runtime.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
export const pins = JSON.parse(readFileSync(path.join(here, 'pins.json'), 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const sha256 = file => digest(readFileSync(file));
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
export function requirePins(value = pins) {
  assert.equal(value.enabled, true, 'Draft disabled: integrator must freeze genuine artifact identities first');
  for (const key of ['e2eSha','e2eTree','nativeSha','nativeTree','compileRecipeSha','compileRecipeTree']) assert.match(value[key], /^[a-f0-9]{40}$/);
  assert.ok(Number.isSafeInteger(value.compileRunId) && value.compileRunId > 0);
  assert.ok(Number.isSafeInteger(value.compileRunAttempt) && value.compileRunAttempt > 0);
  for (const label of ['production','fault']) {
    assert.ok(Number.isSafeInteger(value[label].artifactId) && value[label].artifactId > 0);
    for (const key of ['archiveSha256','binarySha256']) assert.match(value[label][key], /^[a-f0-9]{64}$/);
  }
  assert.equal(value.nativeValidation.mode,'historical-native-proof-reuse');assert.equal(value.nativeValidation.current_native_execution,false);
  assert.equal(value.nativeValidation.receipt_file,'native-reuse.json');assert.match(value.nativeValidation.receipt_sha256,/^[a-f0-9]{64}$/);
  assert.notEqual(value.production.artifactId, value.fault.artifactId);
  assert.notEqual(value.production.binarySha256, value.fault.binarySha256);
}
export function verifyProvenance(value, label, binaryBytes, expected = pins) {
  const features = label === 'production' ? [] : ['acceptance-faults'];
  assert.equal(value.NATIVE_SHA, expected.nativeSha); assert.equal(value.NATIVE_TREE, expected.nativeTree);
  assert.equal(value.E2E_SHA, expected.e2eSha); assert.equal(value.E2E_TREE, expected.e2eTree);
  assert.equal(value.NATIVE_LOCK_SHA256, expected.nativeLockSha256); assert.equal(value.E2E_LOCK_SHA256, expected.e2eLockSha256);
  assert.equal(String(value.GITHUB_RUN_ID), String(expected.compileRunId));
  assert.equal(String(value.GITHUB_RUN_ATTEMPT), String(expected.compileRunAttempt));
  assert.equal(value.GITHUB_WORKFLOW_SHA, expected.compileRecipeSha); assert.equal(value.RUSTUP_TOOLCHAIN, expected.rustToolchain);
  assert.equal(value.profile, 'ci'); assert.deepEqual(value.features, features);
  assert.equal(value.artifact_label, label === 'production' ? 'production' : 'acceptance-faults');
  assert.equal(value.binary_sha256, expected[label].binarySha256); assert.equal(digest(binaryBytes), expected[label].binarySha256);
  assert.equal(value.binary_bytes, binaryBytes.length);
  assert.equal(binaryBytes.subarray(0, 6).toString('hex'), '7f454c460201'); assert.equal(binaryBytes.readUInt16LE(18), 62);
  const cargo = value.cargo_artifact;
  assert.equal(cargo.target.name, 'agent-browser'); assert.deepEqual(cargo.target.kind, ['bin']);
  assert.deepEqual(cargo.features, features); assert.equal(cargo.profile.test, false);
  assert.equal(cargo.profile.opt_level, '3'); assert.equal(cargo.profile.debug_assertions, false);
  assert.ok(cargo.target.src_path.endsWith('/source/cli/src/main.rs'));
  assert.ok(cargo.manifest_path.endsWith('/source/cli/Cargo.toml'));
  assert.ok(cargo.executable.endsWith('/ci/agent-browser'));
  assert.equal(value.distribution_eligible, false);
  assert.deepEqual(value.native_validation,expected.nativeValidation,'Fresh artifact must bind the exact reviewed historical-only native receipt');
}
function sourceIdentity(root, sha, tree) {
  const result = { commit: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}'), status: git(root, 'status', '--porcelain', '--untracked-files=all') };
  assert.equal(result.commit, sha); assert.equal(result.tree, tree); assert.equal(result.status, ''); return result;
}
async function downloadArtifact(workspace, evidence) {
  requirePins();
  const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  assert.ok(process.env.GH_TOKEN, 'Actions read token required');
  const api = 'https://api.github.com/repos/levicode/e2e';
  const get = async endpoint => { const response = await fetch(api + endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) }); assert.equal(response.status, 200); return response.json(); };
  const recipeCommit = await get(`/git/commits/${pins.compileRecipeSha}`); assert.equal(recipeCommit.tree.sha, pins.compileRecipeTree);
  const run = await get(`/actions/runs/${pins.compileRunId}`);
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  assert.equal(run.head_sha, pins.compileRecipeSha); assert.equal(run.run_attempt, pins.compileRunAttempt);
  const jobs = await get(`/actions/runs/${pins.compileRunId}/attempts/${pins.compileRunAttempt}/jobs?per_page=100`);
  assert.equal(jobs.total_count, 3); assert.equal(jobs.jobs.length, 3);
  for (const name of ['native-validation-reused-proof','e2e-validation','native-production-artifact']) {
    const matches = jobs.jobs.filter(job => job.name === name);
    assert.equal(matches.length, 1); assert.equal(matches[0].status, 'completed'); assert.equal(matches[0].conclusion, 'success');
  }
  json(path.join(evidence, 'compile-gates.json'), { runId: run.id, attempt: run.run_attempt, headSha: run.head_sha, conclusion: run.conclusion, nativeValidation:pins.nativeValidation, jobs: jobs.jobs.map(job => ({name: job.name, conclusion: job.conclusion})) });
  for (const label of ['production','fault']) {
    const pin = pins[label], endpoint = `/actions/artifacts/${pin.artifactId}`;
    const metadata = await get(endpoint);
    assert.equal(metadata.id, pin.artifactId); assert.equal(metadata.expired, false);
    assert.equal(metadata.workflow_run.id, pins.compileRunId); assert.equal(metadata.workflow_run.head_sha, pins.compileRecipeSha);
    const prefix = label === 'production' ? 'unpromoted-native-linux-x64' : 'test-only-acceptance-faults-linux-x64';
    assert.equal(metadata.name, `${prefix}-${pins.nativeSha}-${pins.compileRunId}-${pins.compileRunAttempt}`);
    const redirect = await fetch(api + endpoint + '/zip', { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    assert.equal(redirect.status, 302);
    const location = new URL(redirect.headers.get('location')); assert.equal(location.protocol, 'https:'); assert.equal(location.username + location.password, '');
    // Never forward the GitHub Authorization header to artifact storage.
    const archive = await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(120000) }); assert.equal(archive.status, 200);
    const chunks = []; let size = 0;
    for await (const chunk of archive.body) { size += chunk.length; assert.ok(size <= 64 * 1024 * 1024); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks); assert.equal(bytes.length, metadata.size_in_bytes); assert.equal(digest(bytes), pin.archiveSha256);
    const zip = path.join(workspace, `${label}-artifact.zip`); writeFileSync(zip, bytes, { flag: 'wx', mode: 0o600 });
    const extract = member => execFileSync('unzip', ['-p', zip, member], { maxBuffer: 64 * 1024 * 1024 });
    const binaryBytes = extract('agent-browser'), provenance = JSON.parse(extract('provenance.json'));
    verifyProvenance(provenance, label, binaryBytes);
    const binary = path.join(workspace, label === 'production' ? 'agent-browser' : 'agent-browser-acceptance-faults');
    writeFileSync(binary, binaryBytes, { flag: 'wx', mode: 0o700 });
    json(path.join(evidence, `${label}-provenance.json`), provenance);
    json(path.join(evidence, `${label}-artifact-identity.json`), { artifactId: metadata.id, archiveSha256: digest(bytes), binarySha256: digest(binaryBytes), binaryBytes: binaryBytes.length, runId: run.id, recipeSha: run.head_sha });
    // Existing focused runner consumes this genuine producer identity; not negotiation proof.
    if (label === 'production') json(path.join(evidence, 'production-identity.json'), { nativeSha: pins.nativeSha, nativeTree: pins.nativeTree, profile: 'ci', features: [], binarySha256: digest(binaryBytes) });
  }
}
export function sourceCheck(workspace, evidence, final = false) {
  requirePins();
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(process.version, pins.nodeVersion);
  assert.match(readFileSync('/etc/os-release', 'utf8'), /^VERSION_ID="24\.04"$/m);
  const e2e = path.join(workspace, 'e2e-source'), native = path.join(workspace, 'native-source');
  const result = { e2e: sourceIdentity(e2e,pins.e2eSha,pins.e2eTree), native: sourceIdentity(native,pins.nativeSha,pins.nativeTree),
    recipe: sourceIdentity(path.join(workspace,'recipe'),process.env.RECIPE_SHA,git(path.join(workspace,'recipe'),'rev-parse','HEAD^{tree}')),
    pnpmLockSha256: sha256(path.join(e2e,'pnpm-lock.yaml')) };
  assert.equal(sha256(path.join(native,'cli/Cargo.lock')), pins.nativeLockSha256);
  assert.equal(sha256(path.join(e2e,'pnpm-lock.yaml')), pins.e2eLockSha256);
  assert.equal(JSON.parse(readFileSync(path.join(e2e,'.github/native-candidate.json'))).commit, pins.nativeSha);
  assert.equal(sha256(path.join(native,'cli/src/native/cdp/chrome.rs')),pins.nativeChromeSourceSha256);
  assert.equal(sha256(path.join(native,'cli/src/install.rs')),pins.nativeInstallSourceSha256);
  assert.equal(JSON.parse(readFileSync(path.join(e2e,'package.json'))).packageManager,`pnpm@${pins.pnpmVersion}`);
  assert.equal(JSON.parse(readFileSync(path.join(e2e,'packages/web/package.json'))).devDependencies['playwright-core'],pins.playwrightVersion);
  if (final) assert.deepEqual(result,JSON.parse(readFileSync(path.join(evidence,'source-before.json'))));
  json(path.join(evidence,final?'source-after.json':'source-before.json'),result);
}
function image(file) {
  const executable=realpathSync(file), info=statSync(executable);
  return { executable, sha256:sha256(executable), dev:info.dev,ino:info.ino,size:info.size };
}
export function validateCatalog(catalog) {
  for (const name of ['chromium','chromium-headless-shell']) {
    const entry=catalog.browsers.find(entry=>entry.name===name);
    assert.equal(entry?.revision,pins.chromiumRevision,name); assert.equal(entry?.browserVersion,pins.chromeVersion,name);
  }
}
export function browserCheck(workspace,evidence,final=false) {
  const require=createRequire(path.join(workspace,'e2e-source/packages/web/package.json'));
  const packageFile=require.resolve('playwright-core/package.json');
  assert.equal(JSON.parse(readFileSync(packageFile)).version,pins.playwrightVersion);
  validateCatalog(JSON.parse(readFileSync(path.join(path.dirname(packageFile),'browsers.json'))));
  const root=realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH);
  const full=image(require('playwright-core').chromium.executablePath());
  const shell=image(path.join(root,'chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell'));
  for (const value of [full,shell]) {
    assert.ok(value.executable.startsWith(root+path.sep));
    assert.ok(statSync(value.executable).mode & 0o111);
    value.version=execFileSync(value.executable,['--version'],{encoding:'utf8',timeout:10000}).trim();
    assert.match(value.version,/\b156\.0\.8078\.4\b/);
  }
  assert.equal(full.executable,path.join(root,'chromium-1248/chrome-linux64/chrome'));
  assert.equal(full.sha256,pins.chromeSha256);
  const result={full,shell,production:image(path.join(workspace,'agent-browser')),fault:image(path.join(workspace,'agent-browser-acceptance-faults')),playwrightVersion:pins.playwrightVersion,chromiumRevision:pins.chromiumRevision};
  assert.equal(result.production.sha256,pins.production.binarySha256); assert.equal(result.fault.sha256,pins.fault.binarySha256);
  if(final) assert.deepEqual(result,JSON.parse(readFileSync(path.join(evidence,'images-before.json'))));
  json(path.join(evidence,final?'images-after.json':'images-before.json'),result);
  return result;
}
export async function distCheck(workspace,evidence,final=false) {
  const repo=path.join(workspace,'e2e-source');
  const {candidateDistInventory}=await import(pathToFileURL(path.join(repo,'scripts/acceptance/candidate-web.ts')).href);
  const result=candidateDistInventory(repo);
  const directory=path.join(repo,'packages/decision/dist');
  result.decision=readdirSync(directory,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>({path:path.relative(directory,path.join(e.parentPath,e.name)),sha256:sha256(path.join(e.parentPath,e.name))})).sort((a,b)=>a.path.localeCompare(b.path));
  assert.ok(result.decision.some(file=>file.path==='index.js'),'Missing actual decision build');
  if(final) assert.deepEqual(result,JSON.parse(readFileSync(path.join(evidence,'dist-before.json'))));
  json(path.join(evidence,final?'dist-after.json':'dist-before.json'),result);
}
export function validateFocusedP41({report,plan,processResult,expected,sourceRoot,sourceSha256,expectedE2eSha,expectedNativeSha,productionSha256}) {
  const target=path.join(sourceRoot,expected.file);
  assert.equal(plan.id,'P41'); assert.equal(plan.binding.sourceRevision,expectedE2eSha);
  assert.equal(plan.binding.nativeSourceRevision,expectedNativeSha); assert.equal(plan.binding.binarySha256,productionSha256);
  assert.equal(plan.binding.testSourceDigest,sourceSha256);
  assert.equal(plan.outerMaxMs,150000);
  assert.equal(plan.syntheticBatch,false);
  assert.match(plan.paths.runtimeRoot,/^\/tmp\/er-[A-Za-z0-9]+$/);
  const expectedArgv=[process.execPath,path.join(sourceRoot,'packages/web/node_modules/vitest/vitest.mjs'),'run','--project=integration','--maxWorkers=1','--reporter=verbose','--reporter=json','--outputFile.json='+path.join(plan.paths.runtimeRoot,'vitest.json'),target,'-t',expected.title];
  assert.deepEqual(plan.argv,expectedArgv,'Original P41 argv/config/budgets must match exactly');
  assert.deepEqual(processResult.launcher?.argv,expectedArgv,'Actual observed launcher argv must agree');
  assert.equal(processResult.launcher?.spawnedByThisRunner,true);
  const all=report.testResults.flatMap(suite=>suite.assertionResults.map(test=>({...test,file:suite.name})));
  const selected=all.filter(test=>test.file===target&&test.fullName===expected.fullName);
  const executed=all.filter(test=>!['skipped','pending','todo','disabled'].includes(test.status));
  assert.equal(selected.length,1); assert.equal(executed.length,1); assert.equal(selected[0],executed[0]);
  assert.ok(['passed','failed'].includes(selected[0].status));
  assert.equal([...selected[0].ancestorTitles,selected[0].title].join(' '),expected.fullName);
  assert.ok(Number.isInteger(processResult.launcherExit?.code));
  assert.equal(processResult.launcherExit?.signal,null);
  return processResult.launcherExit.code;
}
function importFocusedP41(workspace,evidence) {
  const manifest=JSON.parse(readFileSync(path.join(here,'runtime-manifest.json')));
  const expected=manifest.cases.find(row=>row.caseId==='P41');
  assert.ok(expected&&expected.phase==='priority-p41-1');
  const sourceRoot=path.join(workspace,'e2e-source'), root=path.join(evidence,'focused/P41');
  const load=name=>JSON.parse(readFileSync(path.join(root,name)));
  const sourceSha256=sha256(path.join(sourceRoot,expected.file));
  assert.equal(sourceSha256,manifest.testSourceSha256[expected.file]);
  const exitCode=validateFocusedP41({report:load('vitest.json'),plan:load('plan.json'),processResult:load('result.json'),expected,sourceRoot,sourceSha256,expectedE2eSha:pins.e2eSha,expectedNativeSha:pins.nativeSha,productionSha256:pins.production.binarySha256});
  copyFileSync(path.join(root,'vitest.json'),path.join(evidence,'priority-p41-1.vitest.json'));
  json(path.join(evidence,'priority-p41-1.state.json'),{status:'finished',exitCode,source:'same-run focused original P41; unmodified raw reporter'});
  writeFileSync(path.join(evidence,'priority-p41-1.exit'),exitCode+'\n');
}
// A functional assertion failure is not an ownership failure. Unknown collector/identity is.
export function mayContinueFocusedBatch(summary) {
  const cases=summary?.focusedCases;
  return summary?.scope==='matrix-only'&&JSON.stringify(summary.excludedCaseIds)===JSON.stringify(['HTTP500'])&&Array.isArray(cases)&&cases.length===2&&['P41','FIRST_EVENTS'].every(id=>{
    const matches=cases.filter(row=>row.id===id);
    return matches.length===1&&matches[0].report?.selectionExact===true&&['passed','failed'].includes(matches[0].report.status)&&mayContinueFocusedCase(matches[0]);
  });
}
export function observedCleanupConfirmed(value,observerExit) {
  return observerExit===0&&Array.isArray(value?.errors)&&value.errors.length===0
    &&Array.isArray(value?.remainingObservedAtStop)&&value.remainingObservedAtStop.length===0;
}
async function focusedContinuation(workspace,evidence) {
  const receipt={schemaVersion:1,safeToContinue:false,reason:null,e2eSha:pins.e2eSha,nativeSha:pins.nativeSha,productionSha256:pins.production.binarySha256,faultSha256:pins.fault.binarySha256,functionalFailureRemainsFailure:true,releaseEligible:false};
  try {
    const summary=JSON.parse(readFileSync(path.join(evidence,'focused/summary.json')));
    assert.equal(mayContinueFocusedBatch(summary),true,'Focused selection, identity or owned cleanup incomplete; no continuation');
    // Reuse original complete before/after checks, not a narrower substitute.
    sourceCheck(workspace,evidence,true);browserCheck(workspace,evidence,true);await distCheck(workspace,evidence,true);
    receipt.safeToContinue=true;
  } catch(error) {receipt.reason=String(error);}
  json(path.join(evidence,'focused-continuation.json'),receipt);
  if(!receipt.safeToContinue) process.exitCode=1;
}
export function sentinelLedger(focused) {
  const ledger={schemaVersion:1,scope:'matrix-only job; full runtime sentinel coverage incomplete',fullRuntimeComplete:false,releaseEligible:false,cases:[
    {id:'HTTP500',requiredForFullRuntime:true,status:'not-run',passed:false,reason:'Excluded from this isolated matrix job; do not repeat the prior failed/cleanup-unknown sentinel',historicalOnly:{runId:40129728970,status:'failed-or-incomplete',cleanup:'unknown',reasons:['worker-admission-incomplete','no-cleanup-attempt'],importedAsCurrentEvidence:false}},
    {id:'FIRST_EVENTS',requiredForFullRuntime:true,status:'not-run',passed:false,reason:'Excluded from the Vitest-only333 job; reserved for a separate runner',currentRun:true}
  ]};
  return ledger;
}
function writeSentinelLedger(evidence) {
  const ledger=sentinelLedger();json(path.join(evidence,'sentinel-ledger.json'),ledger);return ledger;
}
function verifyRuntimeResults(evidence) {
  const manifest=JSON.parse(readFileSync(path.join(here,'runtime-manifest.json')));
  const summary=JSON.parse(readFileSync(path.join(evidence,'summary.json')));
  assert.equal(summary.expectedCount,333); assert.equal(summary.all333AssertionsPassed,true);
  for(const name of ['sources','artifact','dependencies','browser-install','codec-install','browser-codecs','runtime-probes','runtime-matrix','final-identities']) assert.equal(readFileSync(path.join(evidence,name+'.exit'),'utf8').trim(),'0',name);
  assert.equal(readFileSync(path.join(evidence,'cli-cache-unchanged.exit'),'utf8').trim(),'0');
  assert.deepEqual(JSON.parse(readFileSync(path.join(evidence,'cli-cache-before.json'))),JSON.parse(readFileSync(path.join(evidence,'cli-cache-after.json'))));
  const binding=JSON.parse(readFileSync(path.join(evidence,'P14-installer-binding.json')));
  assert.equal(binding.caseId,'P14');assert.equal(binding.purpose,'installer-cancellation-loopback');
  assert.equal(binding.binarySha256,pins.fault.binarySha256);assert.equal(binding.negotiationProofSha256,sha256(path.join(evidence,'fault-negotiation.json')));
  assert.equal(binding.postRunIdentityVerified,true);assert.equal(binding.processExit,0);assert.equal(binding.signal,null);assert.equal(binding.primaryError,null);
  for(const name of ['production-probe','fault-probe','canvas-web-unit','official-install',...manifest.phases.map(p=>p.id)]) {
    assert.equal(readFileSync(path.join(evidence,name+'.observer.exit'),'utf8').trim(),'0');
    const sampled=JSON.parse(readFileSync(path.join(evidence,name+'.processes.jsonl.summary.json')));
    assert.equal(sampled.errors.length,0);assert.equal(sampled.remainingObservedAtStop.length,0);
  }
  const images=JSON.parse(readFileSync(path.join(evidence,'images-before.json')));
  const observations=readdirSync(evidence).filter(name=>name.endsWith('.processes.jsonl')).flatMap(name=>readFileSync(path.join(evidence,name),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
  const observed=Object.fromEntries(['full','shell','production','fault'].map(name=>[name,observations.some(row=>row.executable===images[name].executable&&row.sha256===images[name].sha256&&row.expectedHashMatches===true)]));
  json(path.join(evidence,'actual-image-observation.json'),{observed,coverage:'sampled only; not exhaustive descendant cleanup proof',releaseEligible:false});
  assert.ok(Object.values(observed).every(Boolean));
  const sentinels=writeSentinelLedger(evidence);assert.equal(sentinels.cases[0].status,'not-run');assert.equal(sentinels.cases[0].passed,false);assert.equal(sentinels.cases[1].status,'not-run');assert.equal(sentinels.cases[1].passed,false);
  const matrix={status:'passed',scope:'original same-source333 through ordinary Vitest only',originalAssertions:329,decisionAssertions:4,externalSentinelsExecuted:0,http500Status:'not-run',firstEventsStatus:'not-run',fullRuntimeComplete:false,e2e:pins.e2eSha,native:pins.nativeSha,productionSha256:pins.production.binarySha256,faultSha256:pins.fault.binarySha256,releaseEligible:false,fullAcceptance:false,sourceRetirement:false,realModelAcceptance:false};
  json(path.join(evidence,'matrix-runtime-results.json'),matrix);
  json(path.join(evidence,'runtime-results.json'),{...matrix,status:'incomplete',matrixStatus:'passed',reason:'HTTP500 and FIRST_EVENTS are not run in this Vitest-only333 job; separate diagnostics do not grant full runtime acceptance'});
}
async function main() {
  const [command]=process.argv.slice(2), workspace=process.env.GITHUB_WORKSPACE,evidence=process.env.EVIDENCE_DIR;
  requirePins(); assert.ok(workspace&&evidence,'Explicit workflow workspace and evidence required');
  if(command==='sources') return sourceCheck(workspace,evidence);
  if(command==='focused-continuation') return focusedContinuation(workspace,evidence);
  if(command==='import-p41') return importFocusedP41(workspace,evidence);
  if(command==='sentinel-ledger') return writeSentinelLedger(evidence);
  if(command==='runtime-results') return verifyRuntimeResults(evidence);
  if(command==='download') return downloadArtifact(workspace,evidence);
  if(command==='browsers') return browserCheck(workspace,evidence);
  if(command==='dist') return distCheck(workspace,evidence);
  if(command==='final') {
    const checks={};
    for(const [name,run] of [['source',()=>sourceCheck(workspace,evidence,true)],['images',()=>browserCheck(workspace,evidence,true)],['dist',()=>distCheck(workspace,evidence,true)]]) {
      try { await run(); checks[name]={status:'passed'}; }
      catch(error) { checks[name]={status:'failed',problem:String(error)}; }
    }
    json(path.join(evidence,'postrun-identities.json'),checks);
    assert.ok(Object.values(checks).every(item=>item.status==='passed'),'Post-run identity checks failed or unavailable');return;
  }
  if(command==='verify-proof'||command==='verify-fault-proof') {
    const repo=path.join(workspace,'e2e-source');
    const {verifyCandidateRuntime}=await import(pathToFileURL(path.join(repo,'scripts/acceptance/candidate-web.ts')).href);
    const fault=command==='verify-fault-proof', label=fault?'fault':'production';
    assert.equal(sha256(path.join(workspace,fault?'agent-browser-acceptance-faults':'agent-browser')),pins[label].binarySha256);
    verifyCandidateRuntime(JSON.parse(readFileSync(path.join(evidence,`${label}-negotiation.json`))),pins[label].binarySha256,fault);return;
  }
  throw Error('Unknown explicit command');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error);process.exitCode=1;});
