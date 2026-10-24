// Synthetic-only checks. No test modules, browser/native, install, network or process observation.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {reconcile,validateManifest,phaseSelectionExact} from './reconcile.mjs';
import {pins,requirePins,verifyProvenance,validateTestOnlyDelta,observedCleanupConfirmed,sentinelLedger,requireSelectedRuntimeImages} from './identity.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),manifest=JSON.parse(readFileSync(path.join(here,'runtime-manifest.json')));
const clone=x=>structuredClone(x),h=x=>createHash('sha256').update(x).digest('hex'),sourceRoot='/synthetic-only/e2e-source';
const cases=validateManifest(manifest),reports={},states={};let checks=0;
for(const phase of manifest.phases){
  const files=new Map();
  for(const row of cases.filter(row=>row.partition===phase.id)){
    if(!files.has(row.file))files.set(row.file,[]);
    files.get(row.file).push({fullName:row.fullName,title:row.title,ancestorTitles:row.ancestorTitles,status:'passed',failureMessages:[]});
  }
  reports[phase.id]={success:true,testResults:[...files].map(([file,assertionResults])=>({name:path.join(sourceRoot,file),assertionResults}))};
  states[phase.id]={status:'finished',exitCode:0};
}
const base=()=>({manifest:clone(manifest),reports:clone(reports),states:clone(states),repoRoot:sourceRoot});
const good=reconcile(base());
assert.equal(good.summary.allSelectedAssertionsPassed,true);assert.equal(good.summary.verifiedPassCount,21);assert.equal(good.ledger.cases.length,21);checks++;
for(const value of [good.summary,good.ledger]){assert.equal(value.full333Complete,false);assert.equal(value.fullRuntimeComplete,false);assert.equal(value.importedHistoricalOutcomes,0);assert.equal(value.releaseEligible,false);checks++;}
assert.equal(good.summary.all333AssertionsPassed,false);checks++;
const reject=(label,mutate)=>{const x=base();mutate(x);let failed=false;try{failed=!reconcile(x).summary.allSelectedAssertionsPassed}catch{failed=true}assert.ok(failed,label);checks++;};
const first=manifest.phases[0].id;
for(const [label,mutate] of [
 ['missing report',x=>delete x.reports[first]],['zero match',x=>x.reports[first].testResults=[]],
 ['skipped',x=>x.reports[first].testResults[0].assertionResults[0].status='skipped'],
 ['pending',x=>x.reports[first].testResults[0].assertionResults[0].status='pending'],
 ['failed',x=>x.reports[first].testResults[0].assertionResults[0].status='failed'],
 ['unknown',x=>x.reports[first].testResults[0].assertionResults[0].status='unknown'],
 ['process failed',x=>x.states[first].exitCode=1],['exit missing',x=>delete x.states[first].exitCode],
 ['report failed',x=>x.reports[first].success=false],['report unproven',x=>delete x.reports[first].success],
 ['not-run with report',x=>x.states[first].status='not-run'],
 ['duplicate',x=>x.reports[first].testResults[0].assertionResults.push(clone(x.reports[first].testResults[0].assertionResults[0]))],
 ['wrong raw title',x=>x.reports[first].testResults[0].assertionResults[0].fullName='wrong > separators'],
 ['alien path',x=>x.reports[first].testResults[0].name='/wrong/test.ts'],
 ['unexpected execution',x=>x.reports[first].testResults[0].assertionResults.push({fullName:'not selected',status:'passed'})],
 ['P14 absent',x=>delete x.reports['cli-cancel-P14-1']],['decision absent',x=>delete x.reports['decision-cli-4']],
 ['duplicate universe',x=>x.manifest.cases[1]=clone(x.manifest.cases[0])],
 ['duplicate selected',x=>x.manifest.selectedCases[1]=clone(x.manifest.selectedCases[0])],
 ['prior pass substituted',x=>x.manifest.selectedCases[0]=clone(x.manifest.cases.find(row=>!cases.some(c=>c.fullName===row.fullName)))],
 ['carryover',x=>x.manifest.carryoverAllowed=true],['phase count',x=>x.manifest.phases[0].expectedCount++],
 ['wrong phase',x=>x.manifest.selectedCases[0].phase='original-remaining-296'],
 ['wrong prior status',x=>x.manifest.selectedCases[0].priorStatus='passed'],
 ['missing P14 identity',x=>delete x.manifest.selectedCases.find(r=>r.caseId==='P14').caseId],
 ['historical imported',x=>x.manifest.remainingSelection.importedHistoricalOutcomes=306],
 ['333 promoted',x=>x.manifest.full333Complete=true],['runtime promoted',x=>x.manifest.fullRuntimeComplete=true],
])reject(label,mutate);
const absent=reconcile({manifest,reports:{},states:{},repoRoot:sourceRoot});assert.equal(absent.summary.verifiedPassCount,0);assert.equal(absent.summary.statusCounts['not-run'],21);checks++;
const observation={errors:[],remainingObservedAtStop:[],cleanupStatus:'unknown'};
assert.equal(observedCleanupConfirmed(observation,0),true);assert.equal(observation.cleanupStatus,'unknown');checks++;
for(const [value,exit] of [[{errors:['image mismatch'],remainingObservedAtStop:[]},0],[{errors:[],remainingObservedAtStop:[{pid:1}]},0],[observation,1],[{},0],[{errors:[],remainingObservedAtStop:[{status:'unknown'}]},0]]){assert.equal(observedCleanupConfirmed(value,exit),false);checks++;}
for(const phase of manifest.phases.map(p=>p.id)){
  const x=base();x.reports[phase].testResults[0].assertionResults[0].status='failed';x.reports[phase].success=false;x.states[phase].exitCode=1;
  const r=reconcile(x),group=r.summary.partitions.find(g=>g.partition===phase),rows=r.ledger.cases.filter(c=>c.partition===phase);
  assert.equal(phaseSelectionExact(group,rows)&&observedCleanupConfirmed(observation,0),true);assert.equal(r.summary.allSelectedAssertionsPassed,false);checks++;
  assert.equal(phaseSelectionExact(group,rows)&&observedCleanupConfirmed({errors:[],remainingObservedAtStop:[{pid:1}]},0),false);checks++;
  x.reports[phase].testResults[0].assertionResults[0].status='skipped';const s=reconcile(x);assert.equal(phaseSelectionExact(s.summary.partitions.find(g=>g.partition===phase),s.ledger.cases.filter(c=>c.partition===phase)),false);checks++;
}
requirePins();checks++;
for(const mutate of [x=>x.enabled=false,x=>x.production.artifactId=null,x=>x.fault.artifactId=x.production.artifactId,x=>x.fault.binarySha256=x.production.binarySha256,x=>x.compileRunAttempt=null,x=>x.e2eSha=x.artifactE2eSha,x=>x.testOnlyChange.file='packages/web/src/index.ts',x=>x.testOnlyChange.diffSha256=null]){const x=clone(pins);mutate(x);assert.throws(()=>requirePins(x));checks++;}
const bytes=Buffer.alloc(32);Buffer.from('7f454c460201','hex').copy(bytes);bytes.writeUInt16LE(62,18);
const accepted={...clone(pins),production:{...pins.production,binarySha256:h(bytes)}};
const provenance={NATIVE_SHA:pins.nativeSha,NATIVE_TREE:pins.nativeTree,E2E_SHA:pins.artifactE2eSha,E2E_TREE:pins.artifactE2eTree,NATIVE_LOCK_SHA256:pins.nativeLockSha256,E2E_LOCK_SHA256:pins.e2eLockSha256,GITHUB_RUN_ID:String(pins.compileRunId),GITHUB_RUN_ATTEMPT:String(pins.compileRunAttempt),GITHUB_WORKFLOW_SHA:pins.compileRecipeSha,RUSTUP_TOOLCHAIN:pins.rustToolchain,profile:'ci',features:[],artifact_label:'production',binary_sha256:h(bytes),binary_bytes:bytes.length,distribution_eligible:false,native_validation:clone(pins.nativeValidation),cargo_artifact:{target:{name:'agent-browser',kind:['bin'],src_path:'/synthetic/source/cli/src/main.rs'},features:[],profile:{test:false,opt_level:'3',debug_assertions:false},manifest_path:'/synthetic/source/cli/Cargo.toml',executable:'/synthetic/target/ci/agent-browser'}};
verifyProvenance(provenance,'production',bytes,accepted);checks++;
for(const mutate of [x=>x.E2E_SHA=pins.e2eSha,x=>x.E2E_TREE=pins.e2eTree,x=>x.NATIVE_SHA='0'.repeat(40),x=>x.NATIVE_TREE='0'.repeat(40),x=>x.E2E_LOCK_SHA256='0'.repeat(64),x=>x.NATIVE_LOCK_SHA256='0'.repeat(64),x=>x.GITHUB_RUN_ID='40123162559',x=>x.GITHUB_RUN_ATTEMPT='2',x=>x.GITHUB_WORKFLOW_SHA='0'.repeat(40),x=>x.RUSTUP_TOOLCHAIN='different',x=>x.features=['acceptance-faults'],x=>x.cargo_artifact.profile.test=true,x=>x.cargo_artifact.profile.opt_level='0',x=>x.binary_sha256='0'.repeat(64),x=>x.distribution_eligible=true,x=>delete x.native_validation,x=>x.native_validation.current_native_execution=true,x=>x.native_validation.receipt_sha256='0'.repeat(64),x=>x.native_validation.proof.run_id=1,x=>x.native_validation.proof.archive_sha256='0'.repeat(64)]){const x=clone(provenance);mutate(x);assert.throws(()=>verifyProvenance(x,'production',bytes,accepted));checks++;}
const invalidBytes=Buffer.from(bytes);invalidBytes[18]=183;assert.throws(()=>verifyProvenance(provenance,'production',invalidBytes,accepted));checks++;
const delta={parentSha:pins.artifactE2eSha,parentTree:pins.artifactE2eTree,changedFiles:[pins.testOnlyChange.file],diffSha256:pins.testOnlyChange.diffSha256,beforeSha256:pins.testOnlyChange.beforeSha256,afterSha256:pins.testOnlyChange.afterSha256};
validateTestOnlyDelta(delta);checks++;
for(const mutate of [x=>x.parentSha=pins.e2eSha,x=>x.parentTree=pins.e2eTree,x=>x.changedFiles=[],x=>x.changedFiles.push('packages/web/src/index.ts'),x=>x.diffSha256='0'.repeat(64),x=>x.beforeSha256='0'.repeat(64),x=>x.afterSha256='0'.repeat(64)]){const x=clone(delta);mutate(x);assert.throws(()=>validateTestOnlyDelta(x));checks++;}
const images={full:true,production:true,fault:true,shell:false};requireSelectedRuntimeImages(images);checks++;
for(const name of ['full','production','fault']){const x={...images,[name]:false};assert.throws(()=>requireSelectedRuntimeImages(x));checks++;}
const sentinels=sentinelLedger();assert.equal(sentinels.fullRuntimeComplete,false);assert.ok(sentinels.cases.every(r=>r.status==='not-run'&&r.passed===false));checks++;
const workflow=readFileSync(path.join(here,'../../.github/workflows/native-linux-remaining-matrix.yml'),'utf8');
const runner=readFileSync(path.join(here,'run.sh'),'utf8');
assert.equal(workflow.includes('runtime-probe/runtime.mjs cases'),false);assert.equal(workflow.includes('steps.focused'),false);assert.equal(workflow.includes('canvas-pair.mjs verify'),false);checks++;
assert.equal(runner.includes('run_batch priority-'),false);assert.equal(runner.includes('run_batch canvas-pair'),false);assert.equal(runner.includes('canvas-pair.mjs unit'),false);checks++;
assert.ok(runner.includes('for group in display-value-1 callbacks-14'));assert.ok(runner.includes('run_batch cli-installed-1 web'));assert.ok(runner.includes('run_batch cli-cancel-P14-1 web'));assert.ok(runner.includes('run_batch decision-cli-4 decision'));checks++;
assert.ok(runner.includes('display-value-1|callbacks-14) cap=1800'));assert.ok(runner.includes('decision-cli-4) cap=600'));assert.ok(runner.includes('cli-installed-1|cli-cancel-P14-1) cap=180'));assert.ok(runner.includes('kill-after=5s 1800 "$PRODUCTION" install'));checks++;
assert.equal(pins.chromeVersion,'156.0.8078.4');assert.equal(pins.cliChromeVersion,'156.0.8078.47');assert.ok(runner.includes('156\\.0\\.8078\\.47'));checks++;
assert.ok(workflow.includes('fetch-depth: 2'));assert.ok(workflow.includes('timeout-minutes: 110'));assert.ok(workflow.includes('timeout-minutes: 190'));checks++;
console.log(JSON.stringify({kind:'remaining21-pure-negative-checks-only',checks,allPassed:true,runtimeExecuted:false,nativeExecuted:false,browserExecuted:false,sourceTestsImported:false,full333Complete:false}));
