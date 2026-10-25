// Synthetic byte/JSON controls only. No downloads, subprocesses, browser or native execution.
import assert from 'node:assert/strict';
import test from 'node:test';
import {pins,digest,verifyProducerMetadata,verifyLocalProduct,verifyPriorProduct,verifyArchive,verifyArchiveMembers,consumerIdentity,downloadArtifact,admit} from './prior-product.mjs';
const copy=value=>structuredClone(value);
const encode=value=>Buffer.from(JSON.stringify(value));
function metadataFixture(){
  const p=pins;
  return {run:{id:p.runId,status:p.status,conclusion:p.conclusion,head_sha:p.recipeSha,run_attempt:p.runAttempt,head_commit:{tree_id:p.recipeTree},repository:{full_name:p.repository,private:false,id:p.repositoryId},head_branch:p.branch,event:p.event,path:p.workflowPath},
    jobs:{total_count:1,jobs:[{id:p.jobId,name:p.jobName,run_id:p.runId,run_attempt:p.runAttempt,head_sha:p.recipeSha,head_branch:p.branch,status:p.status,conclusion:p.conclusion,labels:copy(p.jobLabels),steps:copy(p.jobSteps)}]},
    metadata:{id:p.artifactId,name:p.artifactName,expired:false,digest:'sha256:'+p.archiveSha256,size_in_bytes:p.archiveBytes,workflow_run:{id:p.runId,head_sha:p.recipeSha,head_branch:p.branch,repository_id:p.repositoryId,head_repository_id:p.repositoryId}},commit:{sha:p.recipeSha,tree:{sha:p.recipeTree}}};
}
const checkMetadata=f=>verifyProducerMetadata(f.run,f.jobs,f.metadata,f.commit);
function productFixture(){
  const p=copy(pins),s=p.producer,binary=Buffer.alloc(64);Buffer.from('7f454c460201','hex').copy(binary);binary.writeUInt16LE(62,18);
  const focused={verifiedSuccess:true,nativeSha:s.publishedNativeSha,nativeTree:s.candidateTree,runId:p.runId,runAttempt:p.runAttempt,recipeSha:p.recipeSha,selectedCaseCount:5,passedTestCount:5,
    cases:s.cases.map(c=>({id:c.id,actual:'passed',testPassed:true})),phases:{'synthetic-positive-control':'0'},fullNativeSuitePassed:false,optimizedNativeTestsExecuted:false};
  const focusedBytes=encode(focused);
  const provenance={NATIVE_SHA:s.publishedNativeSha,NATIVE_TREE:s.candidateTree,NATIVE_LOCK_SHA256:s.nativeLockSha256,E2E_SHA:s.e2eSha,E2E_TREE:s.e2eTree,E2E_LOCK_SHA256:s.e2eLockSha256,
    GITHUB_RUN_ID:String(p.runId),GITHUB_RUN_ATTEMPT:String(p.runAttempt),GITHUB_WORKFLOW_SHA:p.recipeSha,RUSTUP_TOOLCHAIN:p.rustToolchain,helper_sha256:p.helperSha256,profile:'ci',features:[],artifact_label:'production',binary_sha256:digest(binary),binary_bytes:binary.length,
    cargo_artifact:{target:{name:'agent-browser',kind:['bin'],src_path:p.workspace+'/source/cli/src/main.rs'},features:[],profile:{test:false,opt_level:'3',debug_assertions:false},manifest_path:p.workspace+'/source/cli/Cargo.toml',executable:p.target+'/ci/agent-browser'},
    distribution_eligible:false,full_native_suite_passed:false,optimized_native_tests_executed:false,installed_distribution_verified:false,release_eligible:false,requires_removal:true,focused_runtime_cases:['P04'],
    native_validation:{mode:'same-run-temporary-p04-timing-dev-exact',run_id:p.runId,current_native_execution:true,receipt_file:'native-focused-verified.json',receipt_sha256:digest(focusedBytes)}};
  const provenanceBytes=encode(provenance);
  Object.assign(p,{binaryBytes:binary.length,binarySha256:digest(binary),provenanceSha256:digest(provenanceBytes),nativeFocusedReceiptSha256:digest(focusedBytes)});
  return {p,binary,focused,focusedBytes,provenance,provenanceBytes};
}
test('immutable exact artifact pins; failed producer remains failed',()=>{
  assert.ok(Object.isFrozen(pins));assert.ok(Object.isFrozen(pins.jobSteps));assert.ok(Object.isFrozen(pins.producer.cases));
  assert.equal(pins.runId,40175557827);assert.equal(pins.artifactId,12592770979);assert.equal(pins.conclusion,'failure');
  assert.equal(admit,downloadArtifact);
  assert.deepEqual(pins.jobSteps.filter(s=>s.conclusion==='failure').map(s=>s.number),[28,31]);
  assert.deepEqual(pins.jobSteps.filter(s=>s.conclusion==='skipped').map(s=>s.number),[64,66]);
  checkMetadata(metadataFixture());
});
for(const [name,mutate] of Object.entries({
  'promoted run':f=>f.run.conclusion='success',
  'nonterminal run':f=>f.run.status='in_progress',
  'wrong run attempt':f=>f.run.run_attempt=2,
  'different recipe tree':f=>f.commit.tree.sha='0'.repeat(40),
  'wrong workflow':f=>f.run.path='.github/workflows/other.yml',
  'wrong repository':f=>f.run.repository.id++,
  'promoted job':f=>f.jobs.jobs[0].conclusion='success',
  'extra job':f=>f.jobs.total_count=2,
  'masked original failure':f=>f.jobs.jobs[0].steps.find(s=>s.number===28).conclusion='success',
  'unexpected producer failure':f=>f.jobs.jobs[0].steps.find(s=>s.number===21).conclusion='failure',
  'missing step':f=>f.jobs.jobs[0].steps.pop(),
  'changed skipped step':f=>f.jobs.jobs[0].steps.find(s=>s.number===64).conclusion='success',
  'different artifact':f=>f.metadata.id++,
  'expired artifact':f=>f.metadata.expired=true,
  'wrong archive digest':f=>f.metadata.digest='sha256:'+'0'.repeat(64),
  'wrong archive size':f=>f.metadata.size_in_bytes++,
  'wrong artifact run':f=>f.metadata.workflow_run.id++,
  'renamed artifact':f=>f.metadata.name+='-other',
}))test('metadata rejects '+name,()=>{const f=metadataFixture();mutate(f);assert.throws(()=>checkMetadata(f));});
test('synthetic product passes only explicit synthetic expected hashes',()=>{
  const f=productFixture();verifyPriorProduct(f.provenanceBytes,f.binary,f.focusedBytes,f.p);
  assert.throws(()=>verifyPriorProduct(f.provenanceBytes,f.binary,f.focusedBytes));
});
for(const [name,mutate] of Object.entries({
  'new-run provenance':f=>f.provenance.GITHUB_RUN_ID=String(pins.runId+1),
  'new-run recipe':f=>f.provenance.GITHUB_WORKFLOW_SHA='1'.repeat(40),
  'wrong helper':f=>f.provenance.helper_sha256='0'.repeat(64),
  'changed source':f=>f.provenance.NATIVE_SHA='0'.repeat(40),
  'extra native feature':f=>f.provenance.features=['acceptance-faults'],
  'nonproduction cargo artifact':f=>f.provenance.cargo_artifact.profile.test=true,
  'wrong cargo path':f=>f.provenance.cargo_artifact.executable='/tmp/agent-browser',
  'release promotion':f=>f.provenance.release_eligible=true,
  'removal exemption':f=>f.provenance.requires_removal=false,
  'rewritten historical native execution':f=>f.provenance.native_validation.current_native_execution=false,
  'different case':f=>f.provenance.focused_runtime_cases=['P06'],
}))test('provenance rejects '+name,()=>{
  const f=productFixture();mutate(f);assert.throws(()=>verifyLocalProduct(f.provenance,f.binary,f.focusedBytes,f.p.producer,f.p));
});
test('receipt rejects missing/failed controls and changed run binding',()=>{
  for(const mutate of [r=>r.cases.pop(),r=>r.cases[0].actual='unknown',r=>r.runId++,r=>r.phases['synthetic-positive-control']='1']){
    const f=productFixture();mutate(f.focused);const bytes=encode(f.focused);f.provenance.native_validation.receipt_sha256=digest(bytes);
    assert.throws(()=>verifyLocalProduct(f.provenance,f.binary,bytes,f.p.producer,f.p));
  }
});
test('outer pins reject changed ELF, provenance, and receipt bytes',()=>{
  const f=productFixture();const badBinary=Buffer.from(f.binary);badBinary[30]^=1;
  assert.throws(()=>verifyPriorProduct(f.provenanceBytes,badBinary,f.focusedBytes,f.p));
  assert.throws(()=>verifyPriorProduct(Buffer.concat([f.provenanceBytes,Buffer.from('\n')]),f.binary,f.focusedBytes,f.p));
  assert.throws(()=>verifyPriorProduct(f.provenanceBytes,f.binary,Buffer.concat([f.focusedBytes,Buffer.from('\n')]),f.p));
});
test('archive exact size and digest remain mandatory',()=>{
  const bytes=Buffer.from('synthetic archive control'),p={archiveBytes:bytes.length,archiveSha256:digest(bytes)};verifyArchive(bytes,p);
  assert.throws(()=>verifyArchive(Buffer.concat([bytes,Buffer.from('x')]),p));assert.throws(()=>verifyArchive(bytes,{...p,archiveSha256:'0'.repeat(64)}));
});
test('archive permits only the three exact unique file members',()=>{
  const names=['provenance.json','agent-browser','native-focused-verified.json'];verifyArchiveMembers(names);
  for(const invalid of [[...names,'extra'],[...names,'agent-browser'],names.slice(1),['../agent-browser',...names.slice(0,2)],names.map(x=>'directory/'+x)])assert.throws(()=>verifyArchiveMembers(invalid));
});
test('consumer identity does not reinterpret historical same-run facts',()=>{
  const consumer={runId:pins.runId+1,runAttempt:1,recipeSha:'2'.repeat(40)},r=consumerIdentity(consumer);
  assert.equal(r.runId,pins.runId);assert.equal(r.producerRunId,pins.runId);assert.equal(r.producerRecipeSha,pins.recipeSha);assert.equal(r.consumerRunId,consumer.runId);assert.equal(r.producerConclusion,'failure');
  assert.equal(r.exactProducerArtifactVerified,true);for(const key of ['sameRunArtifactVerified','sameRunDiagnosticVerified','currentNativeExecution','originalP04Passed','fullNativeSuitePassed','releaseEligible'])assert.equal(r[key],false);
  assert.throws(()=>consumerIdentity({...consumer,runId:pins.runId}));assert.throws(()=>consumerIdentity({...consumer,recipeSha:undefined}));
});
