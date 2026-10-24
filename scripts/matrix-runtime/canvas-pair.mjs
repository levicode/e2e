// Pair-only bridge to existing candidate receipt/capture helpers. Never full synthetic acceptance.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pins, requirePins } from './identity.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const hash=file=>digest(readFileSync(file));
const read=file=>JSON.parse(readFileSync(file));
const write=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
export function validatePairRecords({artifact,binding,sourceDigests,validateRecord}) {
  assert.equal(artifact.schemaVersion,1); assert.equal(artifact.status,'unknown','Unselected suite cases must remain unknown');
  assert.deepEqual(artifact.binding,binding);
  const selected=['P42','P42O'].map(id=>{
    const matches=artifact.cases.filter(row=>row.caseId===id); assert.equal(matches.length,1);
    const row=matches[0]; assert.equal(row.sourceSha256,sourceDigests[id]);
    assert.equal(row.status,'complete'); assert.deepEqual(row.reasons,[]);
    assert.equal(row.recordsSha256,digest(JSON.stringify(row.records)));
    assert.ok(row.records.length>=2&&row.records.length<=64);
    assert.ok(row.records.every(record=>validateRecord(record,id)));
    const [header,...tail]=row.records, footer=tail.at(-1), facts=tail.slice(0,-1);
    assert.equal(header.kind,'header'); assert.equal(header.caseId,id); assert.deepEqual(header.binding,binding); assert.equal(header.sourceSha256,sourceDigests[id]);
    assert.equal(footer.kind,'footer'); assert.equal(footer.sequence,facts.length);
    assert.equal(footer.dropped,0); assert.equal(footer.truncated,false); assert.equal(footer.incomplete,false);
    assert.equal(footer.outcome.setup,'passed'); assert.equal(footer.outcome.body,'passed');
    assert.equal(footer.outcome.cleanup,id==='P42'?'not-started':'passed');
    facts.forEach((record,index)=>{assert.equal(record.kind,'record');assert.equal(record.sequence,index);});
    return facts.map(record=>record.fact);
  });
  const oracle=selected[1].filter(fact=>fact.kind==='canvas-oracle');
  assert.deepEqual(oracle.map(fact=>fact.targetOrdinal).sort(),[0,1,2,3]);
  for(const fact of oracle){
    for(const name of ['nativeIncluded','baselineIncluded','roleMatchesExpected','nativeRoleEqualsBaseline']) assert.equal(fact[name],true,name);
    assert.equal(fact.truncated,false);assert.equal(fact.unavailable,false);
  }
}
export function validatePairCoverage(value,expected) {
  assert.equal(value.schemaVersion,1);assert.equal(value.scope,'original-P42-P42O-only');assert.equal(value.status,'passed');
  for(const key of ['sourceRevision','binarySha256','testSourceDigest']) { assert.match(expected[key],key==='sourceRevision'?/^[a-f0-9]{40}$/:/^[a-f0-9]{64}$/);assert.equal(value[key],expected[key],key); }
  for(const key of ['webUnitReceiptSha256','syntheticArtifactSha256']) assert.match(value[key],/^[a-f0-9]{64}$/);
  assert.deepEqual(value.caseIds,['P42','P42O']);assert.deepEqual(value.targetOrdinals,[0,1,2,3]);
  assert.equal(value.nativePairPresent,true);assert.equal(value.oracleExecuted,true);assert.equal(value.postRunIdentityVerified,true);
  assert.equal(value.childExit,0);assert.equal(value.childSignal,null);
  assert.equal(value.allSuiteSyntheticStatus,'unknown');assert.equal(value.fullSyntheticAcceptance,false);
}
async function main() {
  const [mode,repo,production,fault,productionProof,faultProof,out,...command]=process.argv.slice(2);
  assert.ok(['run','verify'].includes(mode)&&repo&&production&&fault&&productionProof&&faultProof&&out);
  requirePins();
  const candidate=await import(pathToFileURL(path.join(repo,'scripts/acceptance/candidate-web.ts')));
  const synthetic=await import(pathToFileURL(path.join(repo,'scripts/acceptance/candidate-synthetic-evidence.ts')));
  const schema=await import(pathToFileURL(path.join(repo,'packages/web/tests/helpers/synthetic-evidence.ts')));
  const canvas=await import(pathToFileURL(path.join(repo,'packages/web/tests/helpers/canvas-oracle-provenance.ts')));
  const manifest=read(path.join(here,'runtime-manifest.json'));
  const selected=manifest.cases.filter(row=>['P42','P42O'].includes(row.caseId));
  assert.equal(selected.length,2);assert.equal(new Set(selected.map(row=>row.file)).size,1);
  assert.ok(selected.every(row=>row.phase==='paired-canvas-2'));
  const testFile=path.join(repo,selected[0].file), testSourceDigest=hash(testFile);
  assert.equal(testSourceDigest,manifest.testSourceSha256[selected[0].file]);
  const expected={sourceRevision:pins.e2eSha,binarySha256:pins.production.binarySha256,testSourceDigest};
  assert.equal(hash(production),expected.binarySha256);assert.equal(hash(fault),pins.fault.binarySha256);
  candidate.verifyCandidateRuntime(read(productionProof),expected.binarySha256);
  const installer=candidate.verifyInstallerFixtureRuntime('web-browser',fault,faultProof,production,expected.binarySha256);
  const unitFile=path.join(repo,'.artifacts/native-candidate/web-unit.result.json');
  const unitBefore=hash(unitFile), inventory=canvas.canvasCoreInventory(repo);
  assert.equal(canvas.canvasReceiptMatches(read(unitFile),expected,inventory),true,'Missing genuine same-source/binary/current-core web-unit receipt');
  assert.equal(readFileSync(path.join(out,'canvas-web-unit.exit'),'utf8').trim(),'0');
  const sourceDigests=Object.fromEntries(['P42','P42O'].map(id=>[id,synthetic.syntheticCaseSourceDigest(repo,id)]));
  const receiptFile=path.join(out,'canvas-pair-coverage.json');
  if(mode==='verify') {
    const coverage=read(receiptFile);validatePairCoverage(coverage,expected);
    assert.equal(coverage.webUnitReceiptSha256,unitBefore);
    const artifactFile=path.join(out,'web-browser.synthetic-evidence.json');assert.equal(hash(artifactFile),coverage.syntheticArtifactSha256);
    const artifact=read(artifactFile);assert.equal(canvas.canvasOracleAvailable({E2E_SYNTHETIC_EVIDENCE_BATCH:'1',E2E_SYNTHETIC_EVIDENCE_BINDING:JSON.stringify(artifact.binding)}),true);assert.equal(artifact.binding.sourceRevision,expected.sourceRevision);assert.equal(artifact.binding.binarySha256,expected.binarySha256);assert.equal(artifact.binding.testSourceDigest,testSourceDigest);
    validatePairRecords({artifact,binding:artifact.binding,sourceDigests,validateRecord:schema.validSyntheticSavedRecord});return;
  }
  assert.ok(command.length>0);
  // Do not shrink the source-owned configuration or bypass its genuine P14 secondary binding.
  const capture=synthetic.prepareSyntheticCapture(repo,'web-browser',expected,process.env,installer.binding);
  assert.equal(canvas.canvasOracleAvailable(capture.env),true,'Oracle source/build/receipt provenance unavailable');
  const before=candidate.candidateDistInventory(repo);
  let result,primaryError,postRun;
  try { result=spawnSync(command[0],command.slice(1),{env:capture.env,stdio:'inherit'});primaryError=result.error?.message; }
  catch(error){primaryError=String(error);}
  finally {
    postRun=candidate.verifyInstallerFixturePostRun(installer);
    const collected=synthetic.collectSyntheticEvidence(out,capture);
    write(path.join(out,'canvas-pair-capture.json'),{collection:collected,binding:capture.configuration.binding,primaryError:primaryError??null,childExit:result?.status??null,childSignal:result?.signal??null,installer:postRun,fullSyntheticAcceptance:false});
    copyFileSync(unitFile,path.join(out,'canvas-web-unit.result.json'));
  }
  // Keep original child failure as the process result; diagnostics cannot turn it green.
  if(primaryError||result?.status!==0||result?.signal){process.exitCode=typeof result?.status==='number'&&result.status!==0?result.status:1;return;}
  assert.equal(postRun.postRunIdentityVerified,true);
  assert.deepEqual(candidate.candidateDistInventory(repo),before);assert.equal(hash(unitFile),unitBefore);assert.equal(hash(testFile),testSourceDigest);
  assert.equal(hash(production),expected.binarySha256);assert.equal(hash(fault),pins.fault.binarySha256);
  assert.equal(canvas.canvasOracleAvailable(capture.env),true);
  const artifactFile=path.join(out,'web-browser.synthetic-evidence.json'),artifact=read(artifactFile);
  validatePairRecords({artifact,binding:capture.configuration.binding,sourceDigests,validateRecord:schema.validSyntheticSavedRecord});
  const coverage={schemaVersion:1,scope:'original-P42-P42O-only',status:'passed',...expected,webUnitReceiptSha256:unitBefore,syntheticArtifactSha256:hash(artifactFile),caseIds:['P42','P42O'],targetOrdinals:[0,1,2,3],nativePairPresent:true,oracleExecuted:true,postRunIdentityVerified:true,childExit:result.status,childSignal:result.signal,allSuiteSyntheticStatus:artifact.status,fullSyntheticAcceptance:false};
  validatePairCoverage(coverage,expected);write(receiptFile,coverage);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error);process.exitCode=1;});
