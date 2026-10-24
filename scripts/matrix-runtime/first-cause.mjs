// Three original cases only. Existing source-owned carrier; no full-suite gate or native diagnostics.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {pins,requirePins} from './identity.mjs';
import {reconcile,phaseSelectionExact} from './reconcile.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export const IDS=Object.freeze(['P01','P04','P06']);
const PHASE='first-cause-three';
const read=file=>JSON.parse(readFileSync(file));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const hash=file=>digest(readFileSync(file));
const write=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const baseManifest=()=>read(path.join(here,'runtime-manifest.json'));
export function firstCauseManifest(original) {
  const manifest=structuredClone(original), selected=manifest.cases.filter(row=>IDS.includes(row.caseId));
  assert.deepEqual(selected.map(row=>row.caseId).sort(),[...IDS]);
  assert.ok(selected.every(row=>row.phase==='priority-old-failures-6'));
  for(const row of selected)row.phase=PHASE;
  const old=manifest.phases.find(p=>p.id==='priority-old-failures-6');assert.equal(old.expectedCount,6);old.expectedCount=3;
  manifest.phases.push({id:PHASE,package:'web',expectedCount:3});return manifest;
}
export function selectedResult(manifest,report,state,repoRoot) {
  const states=Object.fromEntries(manifest.phases.map(p=>[p.id,{status:'not-run',reason:'Not selected in three-case capture'}]));states[PHASE]=state;
  const result=reconcile({manifest,reports:{[PHASE]:report},states,repoRoot});
  const selected=result.ledger.cases.filter(row=>row.partition===PHASE),group=result.summary.partitions.find(row=>row.partition===PHASE);
  return {...result,selected,exact:phaseSelectionExact(group,selected)};
}
export const HISTORICAL_PROOFS=Object.freeze({runId:40131455673,attempt:1,recipe:'6084cebb694c144d1a30b04aa65d0893b4bf018a',artifactId:12574879258,zipSha256:'86534d3dc35e0e9850da59c7f4a02daf738fcd889f1455935026c30e8fccac9c',production:'c2075ed347236cab974ff3312d65f6417380836980cae64aa691ee45a75f7154',fault:'54e73db28c7da6440424a5e1e17f5d853148691b86fc11e358181558b3eab33e'});
export function verifyProofMetadata(meta,run) {
  const p=HISTORICAL_PROOFS;assert.equal(meta.id,p.artifactId);assert.equal(meta.expired,false);assert.equal(meta.workflow_run.id,p.runId);assert.equal(meta.workflow_run.head_sha,p.recipe);
  assert.equal(meta.name,`same-source-runtime-${p.runId}-${p.attempt}`);assert.equal(meta.digest,'sha256:'+p.zipSha256);
  assert.equal(run.id,p.runId);assert.equal(run.run_attempt,p.attempt);assert.equal(run.head_sha,p.recipe);assert.equal(run.status,'completed');
  // The old matrix failed. This is only its genuine negotiation proof, never old matrix success.
  assert.equal(run.conclusion,'failure');
}
async function historicalProofs(out) {
  const p=HISTORICAL_PROOFS,headers={Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  assert.ok(process.env.GH_TOKEN);const api='https://api.github.com/repos/levicode/e2e';
  const get=async endpoint=>{const r=await fetch(api+endpoint,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);return r.json();};
  const meta=await get(`/actions/artifacts/${p.artifactId}`),run=await get(`/actions/runs/${p.runId}`);verifyProofMetadata(meta,run);
  const redirect=await fetch(api+`/actions/artifacts/${p.artifactId}/zip`,{headers,redirect:'manual',signal:AbortSignal.timeout(30000)});assert.equal(redirect.status,302);
  const url=new URL(redirect.headers.get('location'));assert.equal(url.protocol,'https:');assert.equal(url.username+url.password,'');
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(120000)});assert.equal(response.status,200);
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;assert.ok(size<=64*1024*1024);chunks.push(chunk);}const bytes=Buffer.concat(chunks);
  assert.equal(bytes.length,meta.size_in_bytes);assert.equal(digest(bytes),p.zipSha256);
  const zip=path.join(process.env.GITHUB_WORKSPACE,'historical-first-cause-proofs.zip');writeFileSync(zip,bytes,{flag:'wx',mode:0o600});
  const names=execFileSync('unzip',['-Z1',zip],{encoding:'utf8',maxBuffer:1024*1024}).split('\n');
  for(const label of ['production','fault']){const name=`${label}-negotiation.json`;assert.equal(names.filter(x=>x===name).length,1);const proof=execFileSync('unzip',['-p',zip,name],{maxBuffer:64*1024});assert.equal(digest(proof),p[label]);writeFileSync(path.join(out,name),proof,{flag:'wx',mode:0o600});}
  write(path.join(out,'historical-proof-origin.json'),{...p,historicalOnly:true,currentRuntimeProbeExecuted:false,oldMatrixPassImported:false,nonceOrFieldsModified:false,metadata:meta});
}
async function captureRun(repo,production,fault,productionProof,faultProof,out,command) {
  requirePins();const manifest=firstCauseManifest(baseManifest()),selected=manifest.cases.filter(row=>row.phase===PHASE);
  const candidate=await import(pathToFileURL(path.join(repo,'scripts/acceptance/candidate-web.ts')));
  const synthetic=await import(pathToFileURL(path.join(repo,'scripts/acceptance/candidate-synthetic-evidence.ts')));
  const {CANDIDATE_WEB_SUITES}=await import(pathToFileURL(path.join(repo,'scripts/acceptance/candidate-manifest.ts')));
  assert.equal(hash(production),pins.production.binarySha256);assert.equal(hash(fault),pins.fault.binarySha256);
  candidate.verifyCandidateRuntime(read(productionProof),pins.production.binarySha256,false);
  const installer=candidate.verifyInstallerFixtureRuntime('web-browser',fault,faultProof,production,pins.production.binarySha256);
  for(const row of selected)assert.equal(hash(path.join(repo,row.file)),manifest.testSourceSha256[row.file]);
  // Exact existing candidate-web fingerprint and COMPLETE source-owned suite configuration.
  const suite=CANDIDATE_WEB_SUITES.find(s=>s.id==='web-browser'),directory=path.join(repo,'packages',suite.package,suite.directory);
  const discovered=readdirSync(directory,{recursive:true,encoding:'utf8'}).filter(n=>n.endsWith('.test.ts')).map(n=>path.join(directory,n)).toSorted();
  const files=candidate.candidateFiles(suite,directory,discovered);
  const fingerprint=()=>digest(Buffer.from(files.map(file=>`${file}\0${hash(file)}`).join('\n')));
  const testSourceDigest=fingerprint(),before=candidate.candidateDistInventory(repo);
  const binding={sourceRevision:pins.e2eSha,testSourceDigest,binarySha256:pins.production.binarySha256};
  const output=path.dirname(out),selectedFiles=[...new Set(selected.map(row=>row.file))].sort().map(file=>file.slice('packages/web/'.length));
  const expectedCommand=[process.execPath,path.join(repo,'packages/web/node_modules/vitest/vitest.mjs'),'run','--project','integration','--maxWorkers=2','--bail=0','--reporter=verbose','--reporter=json',`--outputFile.json=${path.join(output,PHASE+'.vitest.json')}`,'--testNamePattern',readFileSync(path.join(output,PHASE+'.regex.txt'),'utf8').trim(),...selectedFiles];
  assert.deepEqual(command,expectedCommand,'Original exact three-case Vitest argv required; no extra overrides');
  write(path.join(out,'selection.json'),{caseIds:IDS,files:selected.map(r=>({file:r.file,fullName:r.fullName,sha256:manifest.testSourceSha256[r.file]})),command,originalCaseBudgetsUnchanged:true,fullAcceptance:false});
  let capture,setupError,collection,result,primaryError,postRun,identityVerified=false;
  try {capture=synthetic.prepareSyntheticCapture(repo,'web-browser',binding,process.env,installer.binding);}catch(error){setupError=String(error);}
  try {assert.ok(command.length>0);result=spawnSync(command[0],command.slice(1),{env:capture?.env??synthetic.cleanSyntheticEnvironment(process.env),stdio:'inherit'});primaryError=result.error?.message;}catch(error){primaryError=String(error);}
  finally {
    // Collection is diagnostic only, including original body/cleanup failures.
    try {collection=synthetic.collectSyntheticEvidence(out,capture);}catch {collection={status:'unknown',reason:'collection-failed'};}
    postRun=candidate.verifyInstallerFixturePostRun(installer);
    try {assert.deepEqual(candidate.candidateDistInventory(repo),before);assert.equal(fingerprint(),testSourceDigest);assert.equal(hash(production),pins.production.binarySha256);assert.equal(hash(fault),pins.fault.binarySha256);assert.equal(postRun.postRunIdentityVerified,true);identityVerified=true;}catch{ /* Retain original child outcome; independent identity gate remains red. */ }
    try {write(path.join(out,'capture-receipt.json'),{scope:'original-P01-P04-P06-only',caseIds:IDS,collection,binding:capture?.configuration.binding??null,completeConfigurationCaseIds:capture?.configuration.cases.map(c=>c.caseId)??null,installer:postRun,setupError:setupError??null,primaryError:primaryError??null,childExit:result?.status??null,childSignal:result?.signal??null,postRunIdentityVerified:identityVerified,fullSyntheticAcceptance:false,nativeCleanupCaptureEnabled:false,historicalProofs:true});}catch(error){console.error('Capture receipt unavailable; original child outcome retained:',String(error));}
  }
  if(result?.signal){process.kill(process.pid,result.signal);return;}
  process.exitCode=typeof result?.status==='number'?result.status:1;
}
function reconcileOnly(repo,out) {
  const manifest=firstCauseManifest(baseManifest());let report,state;
  try{report=read(path.join(out,PHASE+'.vitest.json'));state=read(path.join(out,PHASE+'.state.json'));}catch{state={status:'not-run',reason:'Original report or state missing'};}
  const value=selectedResult(manifest,report,state,path.resolve(repo));
  const receiptFile=path.join(out,'first-cause-capture/capture-receipt.json');const receipt=existsSync(receiptFile)?read(receiptFile):null;
  write(path.join(out,'first-cause-selected-results.json'),{scope:'original-P01-P04-P06-only',exact:value.exact,cases:value.selected,childExit:state.exitCode??null,collection:receipt?.collection??{status:'unknown'},postRunIdentityVerified:receipt?.postRunIdentityVerified??false,fullSuiteStatus:'unknown',fullAcceptance:false,unselectedAssertionsExecuted:value.exact?false:'unknown'});
  assert.equal(value.exact,true,'Missing/skipped/duplicate/alien selection is not three original executions');
  assert.equal(receipt?.postRunIdentityVerified,true,'Source/dist/image identity unavailable or changed');
}
async function main() {
  const [mode,...args]=process.argv.slice(2);
  if(mode==='proofs')return historicalProofs(args[0]);
  if(mode==='run'){const [repo,production,fault,productionProof,faultProof,out,...command]=args;return captureRun(repo,production,fault,productionProof,faultProof,out,command);}
  if(mode==='reconcile')return reconcileOnly(...args);
  throw Error('Closed first-cause mode required');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error);process.exitCode=1;});
