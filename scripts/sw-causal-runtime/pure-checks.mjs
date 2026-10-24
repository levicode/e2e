import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DIAGNOSTIC_CASE_IDS, requireDiagnosticSelection, mayContinueFocusedCase, selectedReport, CASES, restoreOriginalFixture, pins} from './runtime.mjs';
import {createHash} from 'node:crypto';
assert.deepEqual(requireDiagnosticSelection(['FIRST_EVENTS','HTTP500']),DIAGNOSTIC_CASE_IDS);
for(const ids of [[],['HTTP500'],['HTTP500','FIRST_EVENTS'],['FIRST_EVENTS','HTTP500','HTTP500'],['P41','HTTP500']]) assert.throws(()=>requireDiagnosticSelection(ids));
const good={id:'FIRST_EVENTS',status:'focused-test-passed',selectedEvidencePresent:true,testPassed:true,report:{selectionExact:true,status:'passed'},causal:{positiveControlVisible:true},knownCleanupConfirmed:true,runtimeImagesUnchanged:true,actualBrowserImageConfirmed:true};
assert.equal(mayContinueFocusedCase(good),true);
for(const key of ['selectedEvidencePresent','testPassed','knownCleanupConfirmed','runtimeImagesUnchanged','actualBrowserImageConfirmed'])assert.equal(mayContinueFocusedCase({...good,[key]:false}),false);
for(const status of ['failed','unknown','skipped',undefined])assert.equal(mayContinueFocusedCase({...good,report:{selectionExact:true,status}}),false);
assert.equal(mayContinueFocusedCase({...good,causal:{positiveControlVisible:false}}),false);
assert.equal(mayContinueFocusedCase({...good,firstRunnerError:'missing-raw'}),false);
assert.equal(mayContinueFocusedCase({...good,observerFirstError:'identity-unknown'}),false);
assert.equal(mayContinueFocusedCase({...good,cleanup:{status:'unknown'}}),true); // Not formal cleanup acceptance.
for(const id of DIAGNOSTIC_CASE_IDS)assert.equal(CASES[id].outerMaxMs,45000);
for(const [name,expected] of [['sw-startup-events.test.ts',pins.http500OriginalSha256],['negotiation.setup.ts',pins.negotiationOriginalSha256]])assert.equal(createHash('sha256').update(restoreOriginalFixture(readFileSync(new URL(name,import.meta.url),'utf8'))).digest('hex'),expected);
const src=readFileSync(new URL('runtime.mjs',import.meta.url),'utf8');assert.ok(src.includes("flag:'wx'"));assert.ok(src.includes("['FIRST_EVENTS','HTTP500']"));assert.ok(!src.includes('collector.collectCleanupCapture'));
console.log('closed selector, original fixture/budget, safe positive continuation and no-repeat pure checks passed');

assert.equal(mayContinueFocusedCase({...good,status:'failed-or-incomplete'}),false);
