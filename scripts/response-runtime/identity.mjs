// Same-run local feature-free product binding. Never a terminal external producer receipt.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {pins,requirePins,sourceCheck,browserPin} from './runtime.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
const sha256=file=>digest(readFileSync(file));
const json=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const load=file=>JSON.parse(readFileSync(file));
export function verifyLocalProduct(value,binary,focusedBytes,producer,context){
  assert.equal(value.NATIVE_SHA,producer.nativeSha);assert.equal(value.NATIVE_TREE,producer.nativeTree);
  assert.equal(value.NATIVE_LOCK_SHA256,producer.nativeLockSha256);assert.equal(value.E2E_LOCK_SHA256,producer.e2eLockSha256);
  assert.equal(value.E2E_SHA,producer.e2eSha);assert.equal(value.E2E_TREE,producer.e2eTree);
  assert.equal(String(value.GITHUB_RUN_ID),String(context.runId));assert.equal(String(value.GITHUB_RUN_ATTEMPT),String(context.runAttempt));
  assert.equal(value.GITHUB_WORKFLOW_SHA,context.recipeSha);assert.equal(value.RUSTUP_TOOLCHAIN,'1.99.1');
  assert.equal(value.helper_sha256,context.helperSha256);assert.equal(value.profile,'ci');assert.deepEqual(value.features,[]);assert.equal(value.artifact_label,'production');
  assert.equal(value.binary_sha256,digest(binary));assert.equal(value.binary_bytes,binary.length);
  assert.equal(binary.subarray(0,6).toString('hex'),'7f454c460201');assert.equal(binary.readUInt16LE(18),62);
  const cargo=value.cargo_artifact;
  assert.equal(cargo.target.name,'agent-browser');assert.deepEqual(cargo.target.kind,['bin']);assert.deepEqual(cargo.features,[]);
  assert.equal(cargo.profile.test,false);assert.equal(cargo.profile.opt_level,'3');assert.equal(cargo.profile.debug_assertions,false);
  assert.equal(cargo.target.src_path,path.join(context.workspace,'source/cli/src/main.rs'));
  assert.equal(cargo.manifest_path,path.join(context.workspace,'source/cli/Cargo.toml'));
  assert.equal(cargo.executable,path.join(context.target,'ci/agent-browser'));
  for(const k of ['distribution_eligible','full_native_suite_passed','optimized_native_tests_executed','installed_distribution_verified'])assert.equal(value[k],false);
  assert.deepEqual(value.focused_runtime_cases,['RESPONSE']);
  assert.deepEqual(value.native_validation,{mode:'focused-native-prior-dev-fixtures',run_id:producer.nativeFocused.runId,current_native_execution:false,receipt_file:'native-focused-verified.json',receipt_sha256:digest(focusedBytes)});
  const focused=JSON.parse(focusedBytes);
  assert.equal(focused.verifiedSuccess,true);assert.equal(focused.nativeSha,producer.nativeSha);assert.equal(focused.nativeTree,producer.nativeTree);
  assert.equal(focused.runId,producer.nativeFocused.runId);assert.equal(focused.runAttempt,producer.nativeFocused.runAttempt);assert.equal(focused.recipeSha,producer.nativeFocused.recipeSha);assert.notEqual(String(focused.runId),String(context.runId));
  assert.equal(focused.selectedCaseCount,9);assert.equal(focused.passedTestCount,9);assert.equal(focused.failedTestCount,0);assert.equal(focused.unknownTestCount,0);assert.equal(focused.artifactId,producer.nativeFocused.artifactId);assert.equal(focused.archiveSha256,producer.nativeFocused.archiveSha256);assert.equal(focused.reusedRawLedgerParserSha256,producer.nativeFocused.helperSha256);assert.equal(focused.fullNativeSuitePassed,false);assert.equal(focused.optimizedNativeTestsExecuted,false);
}
async function admit(workspace,evidence){
  requirePins(pins,false);const here=path.dirname(fileURLToPath(import.meta.url)),helper=path.join(here,'producer.py');
  const producer=load(path.join(here,'pins.json'));
  for(const [left,right] of [['nativeSha','nativeSha'],['nativeTree','nativeTree'],['nativeLockSha256','nativeLockSha256'],['e2eSha','e2eSha'],['e2eTree','e2eTree'],['e2eLockSha256','e2eLockSha256']])assert.equal(pins[left],producer[right]);
  // Existing parser re-reads every raw case, command, harness binding and compile exit.
  execFileSync('python3',['-B',path.join(here,'admit-native-focused.py'),path.join(workspace,'proof-recipe')],{stdio:'inherit'});
  execFileSync('python3',['-B',helper,'integrity',process.env.PRODUCT_DIR],{stdio:'inherit'});
  const product=process.env.PRODUCT_DIR,binary=readFileSync(path.join(product,'agent-browser')),provenanceBytes=readFileSync(path.join(product,'provenance.json')),focused=readFileSync(path.join(product,'native-focused-verified.json'));
  assert.equal(digest(focused),sha256(path.join(evidence,'native-focused-verified.json')));
  for(const phase of ['production-build','production-capture','source-after','product-integrity'])assert.equal(readFileSync(path.join(evidence,phase+'.exit'),'utf8').trim(),'0');
  const context={workspace,target:process.env.CARGO_TARGET_DIR,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,recipeSha:process.env.RECIPE_SHA,helperSha256:sha256(helper)};
  verifyLocalProduct(JSON.parse(provenanceBytes),binary,focused,producer,context);
  const output=path.join(workspace,'agent-browser');writeFileSync(output,binary,{flag:'wx',mode:0o700});assert.equal(sha256(output),digest(binary));
  json(path.join(evidence,'production-identity.json'),{nativeSha:pins.nativeSha,nativeTree:pins.nativeTree,e2eSha:pins.e2eSha,e2eTree:pins.e2eTree,profile:'ci',features:[],binarySha256:digest(binary),binaryBytes:binary.length,runId:Number(context.runId),runAttempt:Number(context.runAttempt),recipeSha:context.recipeSha,provenanceSha256:digest(provenanceBytes),nativeFocusedReceiptSha256:digest(focused),sameRunProductVerified:true,externalProducerTerminalClaim:false,releaseEligible:false});
}
function image(file){const executable=realpathSync(file),info=statSync(executable);return{executable,sha256:sha256(executable),dev:info.dev,ino:info.ino,size:info.size};}
async function images(workspace,evidence,final=false){
  const chrome=await browserPin(workspace,evidence);
  const result={full:{...image(chrome.executable),version:chrome.version},production:image(path.join(workspace,'agent-browser')),playwrightVersion:pins.playwrightVersion,chromiumRevision:pins.chromiumRevision};
  assert.equal(result.full.sha256,pins.chromeSha256);assert.equal(result.production.sha256,pins.production.binarySha256);
  if(final)assert.deepEqual(result,load(path.join(evidence,'images-before.json')));
  json(path.join(evidence,final?'images-after.json':'images-before.json'),result);
}
async function distCheck(workspace,evidence,final=false){
  const repo=path.join(workspace,'e2e-source');const{candidateDistInventory}=await import(pathToFileURL(path.join(repo,'scripts/acceptance/candidate-web.ts')).href);
  const result=candidateDistInventory(repo);if(final)assert.deepEqual(result,load(path.join(evidence,'dist-before.json')));
  json(path.join(evidence,final?'dist-after.json':'dist-before.json'),result);
}
async function main(){
  const[command]=process.argv.slice(2),workspace=process.env.GITHUB_WORKSPACE,evidence=process.env.EVIDENCE_DIR;assert.ok(workspace&&evidence);
  if(command==='admit')return admit(workspace,evidence);requirePins();
  if(command==='sources'){sourceCheck(workspace,evidence);json(path.join(evidence,'source-before.json'),load(path.join(evidence,'source-identity.json')));return;}
  if(command==='images')return images(workspace,evidence);if(command==='dist')return distCheck(workspace,evidence);
  if(command==='final'){sourceCheck(workspace,evidence);assert.deepEqual(load(path.join(evidence,'source-identity.json')),load(path.join(evidence,'source-before.json')));await distCheck(workspace,evidence,true);await images(workspace,evidence,true);return;}
  if(command==='gate'){
    const phases=process.env.RUNTIME_PHASES.split(' '),results=Object.fromEntries(phases.map(p=>[p,readFileSync(path.join(evidence,p+'.exit'),'utf8').trim()]));
    const accepted=Object.values(results).every(s=>s==='0');json(path.join(evidence,'focused-result.json'),{caseId:'RESPONSE',accepted,phases:results,focusedOnly:true,fullNativeSuitePassed:false,full333Complete:false,releaseEligible:false});assert.equal(accepted,true);return;
  }throw Error('Unknown closed RESPONSE command');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error);process.exitCode=1;});
