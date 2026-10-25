// Narrow extraction of the original matrix identity/download functions: one focused producer, two runtimes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { pins, requirePins, sourceCheck, browserPin } from '../runtime-probe/runtime.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const sha256 = file => digest(readFileSync(file));
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const load = file => JSON.parse(readFileSync(file));
export function verifyProvenance(value, binaryBytes, focusedBytes, expected = pins) {
  const p=expected.production;
  assert.equal(value.NATIVE_SHA, expected.nativeSha); assert.equal(value.NATIVE_TREE, expected.nativeTree);
  assert.equal(value.E2E_SHA, expected.e2eSha); assert.equal(value.E2E_TREE, expected.e2eTree);
  assert.equal(value.NATIVE_LOCK_SHA256, expected.nativeLockSha256); assert.equal(value.E2E_LOCK_SHA256, expected.e2eLockSha256);
  assert.equal(String(value.GITHUB_RUN_ID), String(p.runId)); assert.equal(String(value.GITHUB_RUN_ATTEMPT), String(p.runAttempt));
  assert.equal(value.GITHUB_WORKFLOW_SHA, p.recipeSha); assert.equal(value.RUSTUP_TOOLCHAIN, expected.rustToolchain);
  assert.equal(value.helper_sha256,p.producerHelperSha256);
  assert.equal(value.profile, 'ci'); assert.deepEqual(value.features, []); assert.equal(value.artifact_label, 'production');
  assert.equal(value.binary_sha256, p.binarySha256); assert.equal(digest(binaryBytes),p.binarySha256);
  assert.equal(value.binary_bytes,binaryBytes.length); assert.equal(binaryBytes.length,p.binaryBytes);
  assert.equal(binaryBytes.subarray(0,6).toString('hex'),'7f454c460201'); assert.equal(binaryBytes.readUInt16LE(18),62);
  const cargo=value.cargo_artifact;
  assert.equal(cargo.target.name,'agent-browser'); assert.deepEqual(cargo.target.kind,['bin']); assert.deepEqual(cargo.features,[]);
  assert.equal(cargo.profile.test,false); assert.equal(cargo.profile.opt_level,'3'); assert.equal(cargo.profile.debug_assertions,false);
  assert.equal(cargo.target.src_path,'/home/runner/work/e2e/e2e/source/cli/src/main.rs');
  assert.equal(cargo.manifest_path,'/home/runner/work/e2e/e2e/source/cli/Cargo.toml');
  assert.equal(cargo.executable,'/home/runner/work/_temp/focused-production-target/ci/agent-browser');
  for(const key of ['distribution_eligible','full_native_suite_passed','optimized_native_tests_executed','installed_distribution_verified']) assert.equal(value[key],false);
  assert.deepEqual(value.focused_runtime_cases,['LAUNCHER_READY','HTTP_POSITIVE','HTTP500']);
  assert.equal(value.requires_removal,true);assert.equal(value.release_eligible,false);
  assert.deepEqual(value.native_validation,{mode:'same-run-temporary-network-probe-dev-exact',run_id:expected.nativeFocused.runId,current_native_execution:true,receipt_file:'native-focused-verified.json',receipt_sha256:expected.nativeFocused.receiptSha256});
  assert.equal(digest(focusedBytes),expected.nativeFocused.receiptSha256);
  const focused=JSON.parse(focusedBytes);
  assert.equal(focused.verifiedSuccess,true); assert.equal(focused.nativeSha,expected.nativeSha); assert.equal(focused.nativeTree,expected.nativeTree);
  assert.equal(focused.runId,expected.nativeFocused.runId);assert.equal(focused.runId,p.runId);assert.equal(focused.runAttempt,p.runAttempt);assert.equal(focused.selectedCaseCount,6); assert.equal(focused.passedTestCount,expected.nativeFocused.expectedCaseCount);
  assert.equal(focused.fullNativeSuitePassed,false); assert.equal(focused.optimizedNativeTestsExecuted,false);
}
export function verifyProducerMetadata(run,jobs,metadata,commit,expected=pins) {
  const p=expected.production;
  assert.equal(commit.sha,p.recipeSha); assert.equal(commit.tree.sha,p.recipeTree);
  assert.equal(run.id,p.runId); assert.equal(run.status,'completed'); assert.equal(run.conclusion,'success');
  assert.equal(run.head_sha,p.recipeSha); assert.equal(run.run_attempt,p.runAttempt); assert.equal(run.head_commit.tree_id,p.recipeTree);
  assert.equal(run.repository.full_name,'levicode/e2e'); assert.equal(run.repository.private,false); assert.equal(run.repository.id,1425853610);
  assert.equal(run.head_branch,'diagnostic/http500-network-probe-producer-20261025'); assert.equal(run.event,'push'); assert.equal(run.path,'.github/workflows/network-probe-production.yml');
  assert.equal(jobs.total_count,1); assert.equal(jobs.jobs.length,1); const job=jobs.jobs[0];
  assert.equal(job.id,p.jobId); assert.equal(job.name,'temporary-network-probe-production'); assert.equal(job.run_id,p.runId); assert.equal(job.run_attempt,p.runAttempt); assert.equal(job.head_sha,p.recipeSha);
  assert.equal(job.status,'completed'); assert.equal(job.conclusion,'success'); assert.deepEqual(job.labels,['ubuntu-24.04']);
  assert.deepEqual(job.steps.map(s=>s.name),p.expectedJobStepNames); assert.equal(new Set(p.expectedJobStepNames).size,p.expectedJobStepNames.length);
  const benignPostSkip=new Set(['Post Cache registry bytes only, never target executables']);
  assert.ok(job.steps.every(s=>s.status==='completed'&&(s.conclusion==='success'||s.conclusion==='skipped'&&benignPostSkip.has(s.name))));
  assert.equal(metadata.id,p.artifactId); assert.equal(metadata.expired,false); assert.equal(metadata.digest,'sha256:'+p.archiveSha256); assert.equal(metadata.size_in_bytes,p.archiveBytes);
  assert.equal(metadata.workflow_run.id,p.runId); assert.equal(metadata.workflow_run.head_sha,p.recipeSha); assert.equal(metadata.workflow_run.head_branch,run.head_branch);
  assert.equal(metadata.workflow_run.repository_id,run.repository.id); assert.equal(metadata.workflow_run.head_repository_id,run.repository.id);
  assert.equal(metadata.name,`temporary-network-probe-native-linux-x64-${expected.nativeSha}-${p.runId}-${p.runAttempt}`);
}
async function downloadArtifact(workspace,evidence) {
  requirePins(); const p=pins.production;
  const headers={Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  assert.ok(process.env.GH_TOKEN,'Actions read token required'); const api='https://api.github.com/repos/levicode/e2e';
  const get=async endpoint=>{const r=await fetch(api+endpoint,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);return r.json();};
  const commit=await get(`/git/commits/${p.recipeSha}`),run=await get(`/actions/runs/${p.runId}`),jobs=await get(`/actions/runs/${p.runId}/attempts/${p.runAttempt}/jobs?per_page=100`),metadata=await get(`/actions/artifacts/${p.artifactId}`);
  verifyProducerMetadata(run,jobs,metadata,commit);
  for(const [name,value] of Object.entries({commit,run,jobs,metadata}))json(path.join(evidence,`producer-${name}.json`),value);
  const redirect=await fetch(api+`/actions/artifacts/${p.artifactId}/zip`,{headers,redirect:'manual',signal:AbortSignal.timeout(30000)});assert.equal(redirect.status,302);
  const location=new URL(redirect.headers.get('location'));assert.equal(location.protocol,'https:');assert.equal(location.username+location.password,'');
  // Never forward the GitHub token to artifact storage or write the signed URL into evidence.
  const archive=await fetch(location,{redirect:'error',signal:AbortSignal.timeout(120000)});assert.equal(archive.status,200);
  const chunks=[];let size=0;for await(const chunk of archive.body){size+=chunk.length;assert.ok(size<=64*1024*1024);chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);assert.equal(bytes.length,p.archiveBytes);assert.equal(digest(bytes),p.archiveSha256);
  const zip=path.join(workspace,'production-artifact.zip');writeFileSync(zip,bytes,{flag:'wx',mode:0o600});
  const names=execFileSync('unzip',['-Z1',zip],{encoding:'utf8',maxBuffer:4096}).trim().split('\n');
  assert.deepEqual(names.toSorted(),['agent-browser','native-focused-verified.json','provenance.json']);
  const extract=member=>execFileSync('unzip',['-p',zip,member],{maxBuffer:64*1024*1024});
  const binary=extract('agent-browser'),provenanceBytes=extract('provenance.json'),focused=extract('native-focused-verified.json');
  assert.equal(digest(provenanceBytes),p.provenanceSha256);const provenance=JSON.parse(provenanceBytes);verifyProvenance(provenance,binary,focused);
  writeFileSync(path.join(workspace,'agent-browser'),binary,{flag:'wx',mode:0o700});
  writeFileSync(path.join(evidence,'production-provenance.json'),provenanceBytes);writeFileSync(path.join(evidence,'native-focused-verified.json'),focused);
  json(path.join(evidence,'production-identity.json'),{nativeSha:pins.nativeSha,nativeTree:pins.nativeTree,e2eSha:pins.e2eSha,e2eTree:pins.e2eTree,profile:'ci',features:[],binarySha256:digest(binary),binaryBytes:binary.length,runId:p.runId,runAttempt:p.runAttempt,recipeSha:p.recipeSha,recipeTree:p.recipeTree,artifactId:p.artifactId,archiveSha256:p.archiveSha256,nativeFocusedReceiptSha256:pins.nativeFocused.receiptSha256,exactProducerArtifactVerified:true,sameRunArtifactVerified:false});
}
function image(file) {
  const executable=realpathSync(file),info=statSync(executable);
  return {executable,sha256:sha256(executable),dev:info.dev,ino:info.ino,size:info.size};
}
async function images(workspace,evidence,final=false) {
  const chrome=await browserPin(workspace,evidence);
  const result={full:{...image(chrome.executable),version:chrome.version},production:image(path.join(workspace,'agent-browser')),playwrightVersion:pins.playwrightVersion,chromiumRevision:pins.chromiumRevision};
  assert.equal(result.full.sha256,pins.chromeSha256);assert.equal(result.production.sha256,pins.production.binarySha256);
  if(final)assert.deepEqual(result,load(path.join(evidence,'images-before.json')));
  json(path.join(evidence,final?'images-after.json':'images-before.json'),result);
}
async function distCheck(workspace,evidence,final=false) {
  const repo=path.join(workspace,'e2e-source');
  const {candidateDistInventory}=await import(pathToFileURL(path.join(repo,'scripts/acceptance/candidate-web.ts')).href);
  const result=candidateDistInventory(repo);
  if(final)assert.deepEqual(result,load(path.join(evidence,'dist-before.json')));
  json(path.join(evidence,final?'dist-after.json':'dist-before.json'),result);
}
async function main() {
  const [command]=process.argv.slice(2),workspace=process.env.GITHUB_WORKSPACE,evidence=process.env.EVIDENCE_DIR;assert.ok(workspace&&evidence);requirePins();
  if(command==='download')return downloadArtifact(workspace,evidence);
  if(command==='sources'){sourceCheck(workspace,evidence);json(path.join(evidence,'source-before.json'),load(path.join(evidence,'source-identity.json')));return;}
  if(command==='images')return images(workspace,evidence);
  if(command==='dist')return distCheck(workspace,evidence);
  if(command==='final'){sourceCheck(workspace,evidence);assert.deepEqual(load(path.join(evidence,'source-identity.json')),load(path.join(evidence,'source-before.json')));await distCheck(workspace,evidence,true);await images(workspace,evidence,true);return;}
  if(command==='gate'){
    const phases=process.env.PHASES.split(' ');const results=Object.fromEntries(phases.map(p=>[p,readFileSync(path.join(evidence,p+'.exit'),'utf8').trim()]));
    const accepted=Object.values(results).every(s=>s==='0');json(path.join(evidence,'focused-result.json'),{caseId:process.env.CASE_ID,accepted,phases:results,fullNativeSuitePassed:false,full333Complete:false,releaseEligible:false});assert.equal(accepted,true);return;
  }
  throw Error('Unknown closed focused identity command');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error);process.exitCode=1;});
