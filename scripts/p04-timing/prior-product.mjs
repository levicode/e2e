// Narrow prior-artifact admission for the fixed P04 N/D comparison. No build or test execution.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,statSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export const pins=freeze(JSON.parse(readFileSync(path.join(here,'producer-artifact-pins.json'))));
export const digest=value=>createHash('sha256').update(value).digest('hex');
const json=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
export function verifyProducerMetadata(run,jobs,metadata,commit,expected=pins){
  const p=expected;
  assert.equal(commit.sha,p.recipeSha);assert.equal(commit.tree.sha,p.recipeTree);
  assert.equal(run.id,p.runId);assert.equal(run.status,p.status);assert.equal(run.conclusion,p.conclusion);
  assert.equal(run.head_sha,p.recipeSha);assert.equal(run.run_attempt,p.runAttempt);assert.equal(run.head_commit.tree_id,p.recipeTree);
  assert.equal(run.repository.full_name,p.repository);assert.equal(run.repository.private,false);assert.equal(run.repository.id,p.repositoryId);
  assert.equal(run.head_branch,p.branch);assert.equal(run.event,p.event);assert.equal(run.path,p.workflowPath);
  assert.equal(jobs.total_count,1);assert.equal(jobs.jobs.length,1);const job=jobs.jobs[0];
  assert.equal(job.id,p.jobId);assert.equal(job.name,p.jobName);assert.equal(job.run_id,p.runId);assert.equal(job.run_attempt,p.runAttempt);assert.equal(job.head_sha,p.recipeSha);
  assert.equal(job.head_branch,p.branch);assert.equal(job.status,p.status);assert.equal(job.conclusion,p.conclusion);assert.deepEqual(job.labels,p.jobLabels);
  assert.deepEqual(job.steps.map(({number,name,status,conclusion})=>({number,name,status,conclusion})),p.jobSteps);
  assert.equal(new Set(p.jobSteps.map(s=>s.name)).size,p.jobSteps.length);
  assert.equal(metadata.id,p.artifactId);assert.equal(metadata.name,p.artifactName);assert.equal(metadata.expired,false);
  assert.equal(metadata.digest,'sha256:'+p.archiveSha256);assert.equal(metadata.size_in_bytes,p.archiveBytes);
  assert.equal(metadata.workflow_run.id,p.runId);assert.equal(metadata.workflow_run.head_sha,p.recipeSha);assert.equal(metadata.workflow_run.head_branch,p.branch);
  assert.equal(metadata.workflow_run.repository_id,p.repositoryId);assert.equal(metadata.workflow_run.head_repository_id,p.repositoryId);
}
// Retains the original P04 verifier's explicit historical context. Its same-run
// fields describe the producer, never the later N/D consumer.
export function verifyLocalProduct(value,binary,focusedBytes,producer,context){
  assert.equal(value.NATIVE_SHA,producer.publishedNativeSha);assert.equal(value.NATIVE_TREE,producer.candidateTree);
  assert.equal(value.NATIVE_LOCK_SHA256,producer.nativeLockSha256);assert.equal(value.E2E_LOCK_SHA256,producer.e2eLockSha256);
  assert.equal(value.E2E_SHA,producer.e2eSha);assert.equal(value.E2E_TREE,producer.e2eTree);
  assert.equal(String(value.GITHUB_RUN_ID),String(context.runId));assert.equal(String(value.GITHUB_RUN_ATTEMPT),String(context.runAttempt));
  assert.equal(value.GITHUB_WORKFLOW_SHA,context.recipeSha);assert.equal(value.RUSTUP_TOOLCHAIN,context.rustToolchain);
  assert.equal(value.helper_sha256,context.helperSha256);assert.equal(value.profile,'ci');assert.deepEqual(value.features,[]);assert.equal(value.artifact_label,'production');
  assert.equal(value.binary_sha256,digest(binary));assert.equal(value.binary_bytes,binary.length);
  assert.equal(binary.subarray(0,6).toString('hex'),'7f454c460201');assert.equal(binary.readUInt16LE(18),62);
  const cargo=value.cargo_artifact;
  assert.equal(cargo.target.name,'agent-browser');assert.deepEqual(cargo.target.kind,['bin']);assert.deepEqual(cargo.features,[]);
  assert.equal(cargo.profile.test,false);assert.equal(cargo.profile.opt_level,'3');assert.equal(cargo.profile.debug_assertions,false);
  assert.equal(cargo.target.src_path,path.join(context.workspace,'source/cli/src/main.rs'));
  assert.equal(cargo.manifest_path,path.join(context.workspace,'source/cli/Cargo.toml'));
  assert.equal(cargo.executable,path.join(context.target,'ci/agent-browser'));
  for(const k of ['distribution_eligible','full_native_suite_passed','optimized_native_tests_executed','installed_distribution_verified','release_eligible'])assert.equal(value[k],false);
  assert.equal(value.requires_removal,true);assert.deepEqual(value.focused_runtime_cases,['P04']);
  assert.deepEqual(value.native_validation,{mode:'same-run-temporary-p04-timing-dev-exact',run_id:Number(context.runId),current_native_execution:true,receipt_file:'native-focused-verified.json',receipt_sha256:digest(focusedBytes)});
  const focused=JSON.parse(focusedBytes);
  assert.equal(focused.verifiedSuccess,true);assert.equal(focused.nativeSha,producer.publishedNativeSha);assert.equal(focused.nativeTree,producer.candidateTree);
  assert.equal(focused.runId,Number(context.runId));assert.equal(focused.runAttempt,Number(context.runAttempt));assert.equal(focused.recipeSha,context.recipeSha);
  assert.equal(focused.selectedCaseCount,producer.cases.length);assert.equal(focused.passedTestCount,producer.cases.length);
  assert.deepEqual(focused.cases.map(c=>c.id),producer.cases.map(c=>c.id));assert.ok(focused.cases.every(c=>c.actual==='passed'&&c.testPassed===true));
  assert.ok(Object.values(focused.phases).every(s=>s==='0'));assert.equal(focused.fullNativeSuitePassed,false);assert.equal(focused.optimizedNativeTestsExecuted,false);
}
export function verifyPriorProduct(provenanceBytes,binary,focusedBytes,expected=pins){
  assert.equal(binary.length,expected.binaryBytes);assert.equal(digest(binary),expected.binarySha256);
  assert.equal(digest(provenanceBytes),expected.provenanceSha256);assert.equal(digest(focusedBytes),expected.nativeFocusedReceiptSha256);
  verifyLocalProduct(JSON.parse(provenanceBytes),binary,focusedBytes,expected.producer,expected);
}
export function verifyArchive(bytes,expected=pins){
  assert.ok(bytes.length<=64*1024*1024);assert.equal(bytes.length,expected.archiveBytes);assert.equal(digest(bytes),expected.archiveSha256);
}
export function verifyArchiveMembers(names){
  assert.deepEqual([...names].sort(),['agent-browser','native-focused-verified.json','provenance.json']);
}
export function consumerIdentity(consumer,expected=pins){
  assert.match(String(consumer.runId),/^[1-9][0-9]*$/);assert.ok(Number.isSafeInteger(Number(consumer.runId)));
  assert.match(String(consumer.runAttempt),/^[1-9][0-9]*$/);assert.ok(Number.isSafeInteger(Number(consumer.runAttempt)));
  assert.match(consumer.recipeSha,/^[a-f0-9]{40}$/);assert.notEqual(String(consumer.runId),String(expected.runId),'Must consume the completed earlier producer, never claim same-run production');
  const p=expected,source=p.producer;
  return {nativeSha:source.publishedNativeSha,nativeTree:source.candidateTree,e2eSha:source.e2eSha,e2eTree:source.e2eTree,profile:'ci',features:[],
    binarySha256:p.binarySha256,binaryBytes:p.binaryBytes,runId:p.runId,runAttempt:p.runAttempt,recipeSha:p.recipeSha,recipeTree:p.recipeTree,
    artifactId:p.artifactId,archiveSha256:p.archiveSha256,provenanceSha256:p.provenanceSha256,nativeFocusedReceiptSha256:p.nativeFocusedReceiptSha256,
    producerRunId:p.runId,producerRunAttempt:p.runAttempt,producerRecipeSha:p.recipeSha,producerRecipeTree:p.recipeTree,
    producerStatus:p.status,producerConclusion:p.conclusion,consumerRunId:Number(consumer.runId),consumerRunAttempt:Number(consumer.runAttempt),consumerRecipeSha:consumer.recipeSha,
    exactProducerArtifactVerified:true,sameRunArtifactVerified:false,sameRunDiagnosticVerified:false,currentNativeExecution:false,
    diagnosticOnly:true,requiresRemoval:true,fullNativeSuitePassed:false,originalP04Passed:false,releaseEligible:false};
}
export async function downloadArtifact(workspace,evidence,consumer={runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,recipeSha:process.env.RECIPE_SHA}){
  const identity=consumerIdentity(consumer);assert.ok(statSync(workspace).isDirectory());assert.ok(statSync(evidence).isDirectory());
  const p=pins;assert.ok(process.env.GH_TOKEN,'Actions read token required');
  const headers={Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  const api=`https://api.github.com/repos/${p.repository}`;
  const get=async endpoint=>{const r=await fetch(api+endpoint,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);return r.json();};
  const commit=await get(`/git/commits/${p.recipeSha}`),run=await get(`/actions/runs/${p.runId}`),jobs=await get(`/actions/runs/${p.runId}/attempts/${p.runAttempt}/jobs?per_page=100`),metadata=await get(`/actions/artifacts/${p.artifactId}`);
  verifyProducerMetadata(run,jobs,metadata,commit);
  for(const [name,value] of Object.entries({commit,run,jobs,metadata}))json(path.join(evidence,`producer-${name}.json`),value);
  const redirect=await fetch(api+`/actions/artifacts/${p.artifactId}/zip`,{headers,redirect:'manual',signal:AbortSignal.timeout(30000)});assert.equal(redirect.status,302);
  const location=new URL(redirect.headers.get('location'));assert.equal(location.protocol,'https:');assert.equal(location.username+location.password,'');
  // Never forward the token to storage; never save or print the signed URL.
  const archive=await fetch(location,{redirect:'error',signal:AbortSignal.timeout(120000)});assert.equal(archive.status,200);
  const chunks=[];let size=0;for await(const chunk of archive.body){size+=chunk.length;assert.ok(size<=64*1024*1024);chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);verifyArchive(bytes);
  const zip=path.join(workspace,'production-artifact.zip');writeFileSync(zip,bytes,{flag:'wx',mode:0o600});
  const names=execFileSync('unzip',['-Z1',zip],{encoding:'utf8',maxBuffer:4096}).trim().split('\n');verifyArchiveMembers(names);
  const extract=member=>execFileSync('unzip',['-p',zip,member],{maxBuffer:64*1024*1024});
  const binary=extract('agent-browser'),provenanceBytes=extract('provenance.json'),focused=extract('native-focused-verified.json');verifyPriorProduct(provenanceBytes,binary,focused);
  writeFileSync(path.join(workspace,'agent-browser'),binary,{flag:'wx',mode:0o700});
  writeFileSync(path.join(evidence,'production-provenance.json'),provenanceBytes,{flag:'wx',mode:0o600});writeFileSync(path.join(evidence,'native-focused-verified.json'),focused,{flag:'wx',mode:0o600});
  json(path.join(evidence,'production-identity.json'),identity);
  return identity;
}
export const admit=downloadArtifact;
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['download'],'Only the fixed prior-artifact download command is supported');
  const workspace=process.env.GITHUB_WORKSPACE,evidence=process.env.EVIDENCE_DIR;assert.ok(workspace&&evidence);
  downloadArtifact(workspace,evidence,{runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,recipeSha:process.env.RECIPE_SHA}).catch(error=>{console.error('Prior artifact admission failed:',error.message);process.exitCode=1;});
}
