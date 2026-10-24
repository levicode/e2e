// Pure synthetic unit checks only. Never import tests, launch native/browser, install or fetch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { reconcile, validateManifest, phaseSelectionExact } from './reconcile.mjs';
import { pins, requirePins, verifyProvenance, validateFocusedP41, mayContinueFocusedBatch, observedCleanupConfirmed, sentinelLedger } from './identity.mjs';
import { validatePairCoverage, validatePairRecords } from './canvas-pair.mjs';
import { pathToFileURL } from 'node:url';
import { mayContinueFocusedCase, selectRuntimeCases } from '../runtime-probe/runtime.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(readFileSync(path.join(here,'runtime-manifest.json')));
const clone=x=>structuredClone(x), sourceRoot='/synthetic-only/e2e-source';
const cases=validateManifest(manifest), reports={}, states={};
for(const phase of manifest.phases){
  const files=new Map();
  for(const row of cases.filter(row=>row.partition===phase.id)) {
    if(!files.has(row.file)) files.set(row.file,[]);
    files.get(row.file).push({fullName:row.fullName,title:row.title,ancestorTitles:row.ancestorTitles,status:'passed',failureMessages:[]});
  }
  reports[phase.id]={success:true,testResults:[...files].map(([file,assertionResults])=>({name:path.join(sourceRoot,file),assertionResults}))};
  states[phase.id]={status:'finished',exitCode:0};
}
const pairExpected={sourceRevision:manifest.sources.e2e.commit,binarySha256:'c'.repeat(64),testSourceDigest:manifest.testSourceSha256[manifest.cases.find(row=>row.caseId==='P42O').file]};
const pairCoverage={schemaVersion:1,scope:'original-P42-P42O-only',status:'passed',...pairExpected,webUnitReceiptSha256:'a'.repeat(64),syntheticArtifactSha256:'b'.repeat(64),caseIds:['P42','P42O'],targetOrdinals:[0,1,2,3],nativePairPresent:true,oracleExecuted:true,postRunIdentityVerified:true,childExit:0,childSignal:null,allSuiteSyntheticStatus:'unknown',fullSyntheticAcceptance:false};
let checks=0;
const base=()=>({manifest:clone(manifest),reports:clone(reports),states:clone(states),repoRoot:sourceRoot,pairCoverage:clone(pairCoverage),pairExpected:clone(pairExpected)});
const good=reconcile(base());assert.equal(good.summary.all333AssertionsPassed,true);assert.equal(good.ledger.cases.length,333);checks++;
const reject=(label,mutate)=>{const input=base();mutate(input);let failed=false;try{failed=!reconcile(input).summary.all333AssertionsPassed}catch{failed=true}assert.ok(failed,label);checks++};
const first=manifest.phases[0].id;
reject('missing report',x=>delete x.reports[first]);
reject('empty zero-match',x=>x.reports[first].testResults=[]);
reject('skipped selected row',x=>x.reports[first].testResults[0].assertionResults[0].status='skipped');
reject('pending selected row',x=>x.reports[first].testResults[0].assertionResults[0].status='pending');
reject('failed selected row',x=>x.reports[first].testResults[0].assertionResults[0].status='failed');
reject('nonzero process exit',x=>x.states[first].exitCode=1);
reject('missing process exit',x=>delete x.states[first].exitCode);
reject('report success false',x=>x.reports[first].success=false);
reject('not-run even with report',x=>x.states[first].status='not-run');
reject('duplicate row',x=>x.reports[first].testResults[0].assertionResults.push(clone(x.reports[first].testResults[0].assertionResults[0])));
reject('wrong raw fullName separators',x=>x.reports[first].testResults[0].assertionResults[0].fullName='wrong > title');
reject('alien path',x=>x.reports[first].testResults[0].name='/wrong/protected-app.test.ts');
reject('unexpected executed row',x=>x.reports[first].testResults[0].assertionResults.push({fullName:'not in manifest',status:'passed'}));
reject('P14 missing',x=>delete x.reports['cli-cancel-P14-1']);
reject('decision four absent',x=>delete x.reports['decision-cli-4']);
reject('manifest duplicate identity',x=>x.manifest.cases[1]=clone(x.manifest.cases[0]));
reject('carryover flag',x=>x.manifest.carryoverAllowed=true);
reject('wrong phase count',x=>x.manifest.phases[0].expectedCount++);
reject('raw P42O pass without real pair receipt',x=>delete x.pairCoverage);
reject('pair source mismatch',x=>x.pairCoverage.sourceRevision='a'.repeat(40));
reject('pair binary mismatch',x=>x.pairCoverage.binarySha256='a'.repeat(64));
reject('pair test source mismatch',x=>x.pairCoverage.testSourceDigest='a'.repeat(64));
reject('invalid binary expected binding',x=>{x.pairExpected.binarySha256=null;x.pairCoverage.binarySha256=null});
reject('pair split across phases',x=>x.manifest.cases.find(row=>row.caseId==='P42').phase='original-remaining-296');
reject('pair not executed',x=>x.pairCoverage.oracleExecuted=false);
reject('pair absent',x=>x.pairCoverage.nativePairPresent=false);
reject('pair missing target',x=>x.pairCoverage.targetOrdinals.pop());
reject('pair missing original case',x=>x.pairCoverage.caseIds.pop());
reject('partial suite promoted',x=>x.pairCoverage.allSuiteSyntheticStatus='complete');
reject('full synthetic acceptance claimed',x=>x.pairCoverage.fullSyntheticAcceptance=true);
reject('pair original process failure',x=>x.pairCoverage.childExit=1);
reject('pair interrupted process',x=>x.pairCoverage.childSignal='SIGTERM');
reject('pair postrun identity unknown',x=>x.pairCoverage.postRunIdentityVerified=false);
const missing=reconcile({manifest,reports:{},states:{},repoRoot:sourceRoot});assert.equal(missing.summary.all333AssertionsPassed,false);assert.equal(missing.summary.verifiedPassCount,0);checks++;
assert.throws(()=>requirePins({...pins,enabled:false}));checks++;
requirePins();checks++;
const h=x=>createHash('sha256').update(x).digest('hex');
const bytes=Buffer.alloc(32);Buffer.from('7f454c460201','hex').copy(bytes);bytes.writeUInt16LE(62,18);
const accepted={...clone(pins),enabled:true,compileRunId:999999999,compileRecipeSha:'4'.repeat(40),compileRecipeTree:'5'.repeat(40),compileRunAttempt:1,production:{artifactId:101,archiveSha256:'a'.repeat(64),binarySha256:h(bytes)},fault:{artifactId:102,archiveSha256:'b'.repeat(64),binarySha256:'c'.repeat(64)}};
requirePins(accepted);checks++;
for(const mutate of [p=>p.production.artifactId=null,p=>p.fault.binarySha256=p.production.binarySha256,p=>p.fault.artifactId=p.production.artifactId,p=>p.compileRunAttempt=null]) {const x=clone(accepted);mutate(x);assert.throws(()=>requirePins(x));checks++}
const provenance={NATIVE_SHA:pins.nativeSha,NATIVE_TREE:pins.nativeTree,E2E_SHA:pins.e2eSha,E2E_TREE:pins.e2eTree,NATIVE_LOCK_SHA256:pins.nativeLockSha256,E2E_LOCK_SHA256:pins.e2eLockSha256,GITHUB_RUN_ID:String(accepted.compileRunId),GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_SHA:accepted.compileRecipeSha,RUSTUP_TOOLCHAIN:pins.rustToolchain,profile:'ci',features:[],artifact_label:'production',binary_sha256:h(bytes),binary_bytes:bytes.length,distribution_eligible:false,native_validation:clone(pins.nativeValidation),cargo_artifact:{target:{name:'agent-browser',kind:['bin'],src_path:'/synthetic/source/cli/src/main.rs'},features:[],profile:{test:false,opt_level:'3',debug_assertions:false},manifest_path:'/synthetic/source/cli/Cargo.toml',executable:'/synthetic/target/ci/agent-browser'}};
verifyProvenance(provenance,'production',bytes,accepted);checks++;
for(const mutate of [p=>p.E2E_SHA='0'.repeat(40),p=>p.NATIVE_TREE='0'.repeat(40),p=>p.GITHUB_RUN_ID='40123162559',p=>p.GITHUB_WORKFLOW_SHA='0'.repeat(40),p=>p.RUSTUP_TOOLCHAIN='different',p=>p.features=['acceptance-faults'],p=>p.cargo_artifact.profile.test=true,p=>p.cargo_artifact.profile.opt_level='0',p=>p.binary_sha256='0'.repeat(64),p=>p.distribution_eligible=true,p=>delete p.native_validation,p=>p.native_validation.current_native_execution=true,p=>p.native_validation.mode='current-native-run',p=>p.native_validation.receipt_sha256='0'.repeat(64),p=>p.native_validation.proof.run_id=40123162559,p=>p.native_validation.proof.artifact_id=1,p=>p.native_validation.proof.archive_sha256='0'.repeat(64)]) {const x=clone(provenance);mutate(x);assert.throws(()=>verifyProvenance(x,'production',bytes,accepted));checks++}
const invalidBytes=Buffer.from(bytes);invalidBytes[18]=183;assert.throws(()=>verifyProvenance(provenance,'production',invalidBytes,accepted));checks++;
const expected=manifest.cases.find(row=>row.caseId==='P41'), sourceSha256=manifest.testSourceSha256[expected.file];
const focus={report:clone(reports[first]),plan:{id:'P41',binding:{sourceRevision:pins.e2eSha,nativeSourceRevision:pins.nativeSha,binarySha256:accepted.production.binarySha256,testSourceDigest:sourceSha256},outerMaxMs:150000,syntheticBatch:false,paths:{runtimeRoot:'/tmp/er-synthetic'},argv:[process.execPath,path.join(sourceRoot,'packages/web/node_modules/vitest/vitest.mjs'),'run','--project=integration','--maxWorkers=1','--reporter=verbose','--reporter=json','--outputFile.json=/tmp/er-synthetic/vitest.json',path.join(sourceRoot,expected.file),'-t',expected.title]},processResult:{launcherExit:{code:0,signal:null}},expected,sourceRoot,sourceSha256,expectedE2eSha:pins.e2eSha,expectedNativeSha:pins.nativeSha,productionSha256:accepted.production.binarySha256};
focus.processResult.launcher={argv:clone(focus.plan.argv),spawnedByThisRunner:true};
assert.equal(validateFocusedP41(focus),0);checks++;
for(const mutate of [x=>x.report.testResults[0].name='/synthetic/reproduction.test.ts',x=>x.report.testResults[0].assertionResults[0].fullName='custom sentinel P41',x=>x.plan.binding.testSourceDigest='0'.repeat(64),x=>x.plan.argv=x.plan.argv.filter(s=>s!=='--project=integration'),x=>x.processResult.launcherExit.code=null,x=>x.plan.argv.push('--config','foreign.mjs'),x=>x.plan.argv.push('--testTimeout=60000'),x=>x.plan.argv.push('--project=unit'),x=>x.plan.argv.push('--setupFiles=foreign.ts'),x=>x.plan.outerMaxMs=300000,x=>x.processResult.launcher.argv.push('--config=foreign.mjs'),x=>x.processResult.launcher.spawnedByThisRunner=false]){const x=clone(focus);mutate(x);assert.throws(()=>validateFocusedP41(x));checks++}
const focusedSafe={knownCleanupConfirmed:true,cleanup:{status:'complete-observed-snapshots'},runtimeImagesUnchanged:true,actualBrowserImageConfirmed:true,firstRunnerError:null,observerFirstError:null};
assert.equal(mayContinueFocusedCase(focusedSafe),true);checks++;
for(const mutate of [x=>x.knownCleanupConfirmed=false,x=>delete x.knownCleanupConfirmed,x=>x.cleanup.status='unknown',x=>x.runtimeImagesUnchanged=false,x=>x.actualBrowserImageConfirmed=false,x=>x.firstRunnerError='missing reporter',x=>x.observerFirstError='identity mismatch']){const x=clone(focusedSafe);mutate(x);assert.equal(mayContinueFocusedCase(x),false);checks++}
const safeBatch={scope:'matrix-only',excludedCaseIds:['HTTP500'],focusedCases:['P41','FIRST_EVENTS'].map(id=>({...clone(focusedSafe),id,status:'focused-test-passed',report:{selectionExact:true,status:'passed'}}))};
assert.equal(mayContinueFocusedBatch(safeBatch),true);checks++;
const sentinels=sentinelLedger(safeBatch);assert.equal(sentinels.fullRuntimeComplete,false);assert.equal(sentinels.cases[0].status,'not-run');assert.equal(sentinels.cases[0].passed,false);assert.equal(sentinels.cases[1].passed,true);checks++;
assert.equal(sentinelLedger(undefined).cases[0].passed,false);assert.equal(sentinelLedger(undefined).cases[1].passed,false);checks++;
const invented500=clone(safeBatch);invented500.focusedCases.push({...clone(safeBatch.focusedCases[0]),id:'HTTP500'});assert.equal(sentinelLedger(invented500).cases[0].passed,false);assert.equal(sentinelLedger(invented500).cases[0].status,'not-run');checks++;
const failedEvent=clone(safeBatch);failedEvent.focusedCases[1].status='failed-or-incomplete';failedEvent.focusedCases[1].report.status='failed';assert.equal(sentinelLedger(failedEvent).cases[1].passed,false);checks++;
assert.deepEqual(selectRuntimeCases(['matrix']),['P41','FIRST_EVENTS']);checks++;
for(const args of [[],['all'],['HTTP500'],['P41'],['matrix','HTTP500'],['matrix','matrix'],['P41','FIRST_EVENTS']]){assert.throws(()=>selectRuntimeCases(args));checks++;}
for(const mutate of [x=>delete x.scope,x=>x.excludedCaseIds=[],x=>x.focusedCases.push({...clone(x.focusedCases[0]),id:'HTTP500'}),x=>x.focusedCases[1].id='P41']){const x=clone(safeBatch);mutate(x);assert.equal(mayContinueFocusedBatch(x),false);checks++;}
const redSafe=clone(safeBatch);redSafe.focusedCases[0].status='failed-or-incomplete';redSafe.focusedCases[0].report.status='failed';
assert.equal(mayContinueFocusedBatch(redSafe),true,'Ordinary assertion red with complete identity/cleanup permits next group');checks++;
for(const mutate of [x=>x.focusedCases[0].cleanup.status='unknown',x=>x.focusedCases[0].cleanup={status:'unknown',reasons:['worker-admission-incomplete']},x=>x.focusedCases[0].knownCleanupConfirmed=false,x=>x.focusedCases[0].runtimeImagesUnchanged=false,x=>x.focusedCases[0].report.selectionExact=false,x=>delete x.focusedCases[0].report.status,x=>x.focusedCases[0].report.status='unknown',x=>x.focusedCases[0].report.status='skipped',x=>x.focusedCases[0].firstRunnerError='missing report',x=>x.focusedCases.pop()]){const x=clone(redSafe);mutate(x);assert.equal(mayContinueFocusedBatch(x),false);checks++}
const observation={errors:[],remainingObservedAtStop:[]};assert.equal(observedCleanupConfirmed(observation,0),true);checks++;
for(const [value,exit] of [[{errors:['identity mismatch'],remainingObservedAtStop:[]},0],[{errors:[],remainingObservedAtStop:[{pid:1}]},0],[observation,1],[{},0]]){assert.equal(observedCleanupConfirmed(value,exit),false);checks++}
for(const phase of ['priority-p41-1','priority-old-failures-6']){
 const x=base();x.reports[phase].testResults[0].assertionResults[0].status='failed';x.reports[phase].success=false;x.states[phase].exitCode=1;
 const result=reconcile(x),group=result.summary.partitions.find(g=>g.partition===phase),rows=result.ledger.cases.filter(c=>c.partition===phase);
 assert.equal(phaseSelectionExact(group,rows)&&observedCleanupConfirmed(observation,0),true,'Exact functional failure continues only after safe cleanup');
 assert.equal(result.summary.all333AssertionsPassed,false,'Original failure remains red');checks++;
 assert.equal(phaseSelectionExact(group,rows)&&observedCleanupConfirmed({errors:[],remainingObservedAtStop:[{pid:1}]},0),false,'Unknown owned cleanup stops next group');checks++;
}
// Source-owned pure validators only; no test module, unit runner or browser is loaded.
const validationSource=process.argv[2];assert.ok(validationSource,'Explicit candidate source for pure helper imports');
const {validSyntheticSavedRecord}=await import(pathToFileURL(path.join(validationSource,'packages/web/tests/helpers/synthetic-evidence.ts')));
const {canvasReceiptMatches}=await import(pathToFileURL(path.join(validationSource,'packages/web/tests/helpers/canvas-oracle-provenance.ts')));
const inventory=[{path:'dist/index.js',sha256:'d'.repeat(64)}];
const unit={schemaVersion:1,suite:'web-unit',status:'passed',sourceRevision:pairExpected.sourceRevision,binarySha256:pairExpected.binarySha256,runtimeBuild:{core:inventory}};
assert.equal(canvasReceiptMatches(unit,pairExpected,inventory),true);checks++;
for(const mutate of [x=>x.status='failed',x=>delete x.runtimeBuild,x=>x.runtimeBuild.core=[],x=>x.runtimeBuild.core[0].sha256='e'.repeat(64),x=>x.sourceRevision='e'.repeat(40),x=>x.binarySha256='e'.repeat(64),x=>x.suite='web-browser',x=>x.runtimeBuild.core[0].extra=true]){const x=clone(unit);mutate(x);assert.equal(canvasReceiptMatches(x,pairExpected,inventory),false);checks++}
const binding={runId:'f'.repeat(32),suite:'web-browser',...pairExpected};
const sourceDigests={P42:'1'.repeat(64),P42O:'2'.repeat(64)};
const row=(id,facts)=>{const records=[{kind:'header',schemaVersion:1,binding,caseId:id,sourceSha256:sourceDigests[id]},...facts.map((fact,sequence)=>({kind:'record',sequence,fact})),{kind:'footer',sequence:facts.length,dropped:0,truncated:false,incomplete:false,outcome:{setup:'passed',body:'passed',cleanup:id==='P42'?'not-started':'passed'}}];return{caseId:id,sourceSha256:sourceDigests[id],status:'complete',reasons:[],records,recordsSha256:h(JSON.stringify(records))}};
const artifact={schemaVersion:1,binding,status:'unknown',cases:[row('P42',[]),row('P42O',[0,1,2,3].map(targetOrdinal=>({kind:'canvas-oracle',targetOrdinal,nativeIncluded:true,baselineIncluded:true,roleMatchesExpected:true,nativeRoleEqualsBaseline:true,namePresence:false,valuePresence:false,truncated:false,unavailable:false})))]};
const validRecords=x=>validatePairRecords({artifact:x,binding,sourceDigests,validateRecord:validSyntheticSavedRecord});
validRecords(artifact);checks++;
for(const mutate of [x=>x.cases.pop(),x=>x.cases.push(clone(x.cases[0])),x=>x.cases[1].status='unknown',x=>x.binding.sourceRevision='3'.repeat(40),x=>x.cases[1].sourceSha256='3'.repeat(64),x=>x.cases[1].records[1].fact.unavailable=true,x=>x.cases[1].records[1].fact.truncated=true,x=>x.cases[1].records[1].fact.nativeIncluded=false,x=>x.cases[1].records[1].fact.baselineIncluded=false,x=>x.cases[1].records[1].fact.roleMatchesExpected=false,x=>x.cases[1].records[1].fact.nativeRoleEqualsBaseline=false,x=>x.cases[1].records[1].fact.targetOrdinal=1,x=>x.cases[1].records.at(-1).outcome.body='not-started',x=>x.cases[1].records.at(-1).outcome.cleanup='failed',x=>x.cases[1].records.at(-1).incomplete=true,x=>x.cases[1].records.at(-1).dropped=1,x=>x.cases[1].records[1].sequence=9]){const x=clone(artifact);mutate(x);for(const c of x.cases)c.recordsSha256=h(JSON.stringify(c.records));assert.throws(()=>validRecords(x));checks++}
console.log(JSON.stringify({kind:'pure-synthetic-negative-checks-only',checks,allPassed:true,runtimeExecuted:false,nativeExecuted:false,browserExecuted:false,sourceTestsImported:false}));
