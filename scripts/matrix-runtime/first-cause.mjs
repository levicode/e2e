// Two original cases only. Existing source-owned carriers; no new native code or acceptance gate.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync,existsSync,lstatSync,realpathSync,openSync,closeSync,fstatSync,readSync,constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {pins,requirePins} from './identity.mjs';
import {reconcile,phaseSelectionExact} from './reconcile.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export const IDS=Object.freeze(['P01','P04']);
export const phaseFor=id=>{assert.ok(IDS.includes(id),'Only original P01/P04');return 'first-cause-'+id;};
const read=file=>JSON.parse(readFileSync(file));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const hash=file=>digest(readFileSync(file));
const write=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const baseManifest=()=>read(path.join(here,'runtime-manifest.json'));
export function firstCauseManifest(original) {
  const manifest=structuredClone(original), selected=manifest.cases.filter(row=>IDS.includes(row.caseId));
  assert.deepEqual(selected.map(row=>row.caseId).sort(),[...IDS]);
  assert.ok(selected.every(row=>row.phase==='priority-old-failures-6'));
  for(const row of selected)row.phase=phaseFor(row.caseId);
  const old=manifest.phases.find(p=>p.id==='priority-old-failures-6');assert.equal(old.expectedCount,6);old.expectedCount=4;
  manifest.phases.push(...IDS.map(id=>({id:phaseFor(id),package:'web',expectedCount:1})));return manifest;
}
export function selectedResult(manifest,reports,selectedStates,repoRoot) {
  const states=Object.fromEntries(manifest.phases.map(p=>[p.id,{status:'not-run',reason:'Not selected in two-case screenshot capture'}]));
  for(const id of IDS)states[phaseFor(id)]=selectedStates[phaseFor(id)]??{status:'not-run',reason:'Original case was not run'};
  const result=reconcile({manifest,reports,states,repoRoot});
  const selected=result.ledger.cases.filter(row=>IDS.map(phaseFor).includes(row.partition));
  return {...result,selected,exact:IDS.every(id=>phaseSelectionExact(result.summary.partitions.find(row=>row.partition===phaseFor(id)),selected.filter(row=>row.partition===phaseFor(id))))};
}
// Source helper owns creation; these checks prove what was handed to the child, not daemon admission.
export function verifyPrecreatedSink(capture) {
  assert.ok(path.isAbsolute(capture.file));assert.equal(realpathSync(capture.directory),capture.directory);
  assert.equal(path.dirname(capture.file),capture.directory);assert.equal(capture.env.AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE,capture.file);
  const directory=lstatSync(capture.directory),stat=lstatSync(capture.file);
  assert.ok(directory.isDirectory()&&!directory.isSymbolicLink());assert.equal(directory.mode&0o777,0o700);
  assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.mode&0o777,0o600);assert.equal(stat.nlink,1);
  assert.equal(stat.uid,process.getuid());assert.equal(directory.uid,process.getuid());
  assert.equal(stat.dev,capture.device);assert.equal(stat.ino,capture.inode);assert.equal(stat.size,0);
  // Same read+append flags as the existing daemon sink; no bytes are written here.
  const fd=openSync(capture.file,constants.O_RDWR|constants.O_APPEND|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {const opened=fstatSync(fd);assert.equal(opened.dev,stat.dev);assert.equal(opened.ino,stat.ino);}finally{closeSync(fd);}
  return {file:capture.file,directory:capture.directory,device:stat.dev,inode:stat.ino,uid:stat.uid,mode:'0600',directoryMode:'0700',precreatedEmpty:true};
}
export function collectNativeRaw(capture,out,collector,identityUnchanged) {
  if(!capture)return {status:'unknown',reasons:['capture-unavailable'],diagnosticOnly:true};
  let fd;
  try {
    const named=lstatSync(capture.file);assert.ok(named.isFile()&&!named.isSymbolicLink());
    fd=openSync(capture.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=fstatSync(fd);assert.ok(stat.isFile());assert.equal(stat.dev,capture.device);assert.equal(stat.ino,capture.inode);assert.equal(stat.nlink,1);
    assert.equal(stat.uid,process.getuid());assert.equal(stat.mode&0o777,0o600);
    const buffer=Buffer.alloc(collector.CLEANUP_BYTES+1),length=readSync(fd,buffer,0,buffer.length,0),bytes=buffer.subarray(0,length),after=fstatSync(fd);
    // Preserve available original bytes before interpretation, including malformed or partial records.
    const rawFile='native.jsonl';writeFileSync(path.join(out,rawFile),bytes,{flag:'wx',mode:0o600});
    const inspected=collector.inspectCleanupBytes(bytes),reasons=[...inspected.reasons];
    if(length!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)reasons.push('changing-or-truncated-raw');
    if(!identityUnchanged)reasons.push('source-runtime-unverified');
    return {status:reasons.length?'unknown':inspected.status,reasons,rawFile,rawSha256:digest(bytes),bytes:length,sourceBytes:stat.size,
      device:stat.dev,inode:stat.ino,binding:capture.binding,diagnosticOnly:true,processCoverage:'unproven',releaseEligible:false};
  }catch{return {status:'unknown',reasons:['raw-collection-unavailable'],diagnosticOnly:true};}
  finally{if(fd!==undefined)try{closeSync(fd);}catch{/* Diagnostic close errors cannot replace the child outcome. */}}
}
// An outer signal can kill the wrapper before finally. Reconciliation only reads
// its prior owned-file manifest; it never recreates a sink, retries a writer or waits.
export function recoverNativeRaw(id,out,collector) {
  if(existsSync(path.join(out,'native.jsonl')))return {status:'unknown',reasons:['raw-already-preserved-no-overwrite'],diagnosticOnly:true};
  try {
    const capture=read(path.join(out,'native-sink-precreation.json'));
    assert.equal(capture.caseId,id);phaseFor(id);assert.equal(capture.precreatedEmpty,true);
    assert.ok(path.isAbsolute(capture.file));assert.equal(path.basename(capture.file),'native.jsonl');
    assert.equal(path.dirname(capture.file),capture.directory);assert.equal(realpathSync(capture.directory),capture.directory);
    const directory=lstatSync(capture.directory);assert.ok(directory.isDirectory()&&!directory.isSymbolicLink());
    assert.equal(directory.uid,process.getuid());assert.equal(directory.mode&0o777,0o700);
    assert.equal(capture.uid,process.getuid());assert.equal(capture.mode,'0600');assert.equal(capture.directoryMode,'0700');
    assert.equal(capture.binding.sourceRevision,pins.e2eSha);assert.equal(capture.binding.nativeSourceRevision,pins.nativeSha);
    assert.equal(capture.binding.binarySha256,pins.production.binarySha256);
    const recovered=collectNativeRaw(capture,out,collector,false);
    const result={...recovered,status:'unknown',reasons:[...recovered.reasons,'wrapper-finally-not-established'],recoveredFromPrecreation:true,writerTermination:'unproven',cleanupAcceptance:'unknown'};
    write(path.join(out,'native-raw-recovery.json'),result);return result;
  }catch{return {status:'unknown',reasons:['owned-precreation-recovery-unavailable'],diagnosticOnly:true};}
}
export function bindNativeScreenshots({records,processes,production,binding,caseId,operationSeqs,diagnosticStatus}) {
  const native=records.filter(row=>row.source==='native'),starts=native.filter(row=>row.phase==='CaptureStarted'&&row.record===0);
  const screenshots=native.filter(row=>row.phase==='ScreenshotFirstFailure');
  return {caseId,binding,diagnosticStatus,processCoverage:'sampled-only',fdCoverage:'not-observed',cleanupAcceptance:'unknown',releaseEligible:false,
    screenshots:screenshots.map(row=>{
      const matches=processes.filter(p=>p.pid===row.pid&&p.executable===production&&p.sha256===binding.binarySha256&&p.expectedHashMatches===true&&typeof p.startTicks==='string'&&/^[1-9][0-9]*$/.test(p.startTicks));
      const lifetimes=[...new Set(matches.map(p=>p.startTicks))];
      const started=starts.filter(start=>start.pid===row.pid).length===1;
      const uniqueOperation=screenshots.filter(other=>other.operationSeq===row.operationSeq).length===1;
      return {record:row,nativePidBinding:started&&lifetimes.length===1?'observed-sampled-production-lifetime':'unknown',
        startTicks:lifetimes.length===1?lifetimes[0]:null,caseOperationBinding:operationSeqs.includes(row.operationSeq)&&uniqueOperation?'observed-case-local-sequence':'unknown'};
    })};
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
async function captureRun(id,repo,production,fault,productionProof,faultProof,out,command) {
  const PHASE=phaseFor(id);requirePins();const manifest=firstCauseManifest(baseManifest()),selected=manifest.cases.filter(row=>row.phase===PHASE);
  const candidate=await import(pathToFileURL(path.join(repo,'scripts/acceptance/candidate-web.ts')));
  const synthetic=await import(pathToFileURL(path.join(repo,'scripts/acceptance/candidate-synthetic-evidence.ts')));
  const collectorFile=path.join(repo,'scripts/acceptance/candidate-cleanup-diagnostics.ts'),collector=await import(pathToFileURL(collectorFile));
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
  assert.deepEqual(command,expectedCommand,'Original exact one-case Vitest argv required; no extra overrides');
  write(path.join(out,'selection.json'),{caseIds:[id],files:selected.map(r=>({file:r.file,fullName:r.fullName,sha256:manifest.testSourceSha256[r.file]})),command,originalCaseBudgetsUnchanged:true,fullAcceptance:false});
  let capture,nativeCapture,nativeSetupError,nativeRaw,setupError,collection,result,primaryError,postRun,identityVerified=false;
  const cleanEnv=collector.cleanCleanupEnvironment(process.env);
  try {
    nativeCapture=collector.prepareCleanupCapture({...binding,nativeSourceRevision:pins.nativeSha,collectorSha256:hash(collectorFile)},cleanEnv);
    const precreated=verifyPrecreatedSink(nativeCapture);
    write(path.join(out,'native-sink-precreation.json'),{caseId:id,binding:nativeCapture.binding,...precreated,daemonOpened:'not-yet-observed'});
  }catch(error){nativeSetupError=String(error);nativeCapture=undefined;}
  try {capture=synthetic.prepareSyntheticCapture(repo,'web-browser',binding,nativeCapture?.env??cleanEnv,installer.binding);}catch(error){setupError=String(error);}
  // A diagnostic setup gap never skips or weakens the original business assertions.
  try {assert.ok(command.length>0);result=spawnSync(command[0],command.slice(1),{env:capture?.env??synthetic.cleanSyntheticEnvironment(nativeCapture?.env??cleanEnv),stdio:'inherit'});primaryError=result.error?.message;}catch(error){primaryError=String(error);}
  finally {
    // Collection is diagnostic only, including original body/cleanup failures.
    try {collection=synthetic.collectSyntheticEvidence(out,capture);}catch {collection={status:'unknown',reason:'collection-failed'};}
    try {postRun=candidate.verifyInstallerFixturePostRun(installer);}catch{postRun={postRunIdentityVerified:false};}
    try {assert.deepEqual(candidate.candidateDistInventory(repo),before);assert.equal(fingerprint(),testSourceDigest);assert.equal(hash(production),pins.production.binarySha256);assert.equal(hash(fault),pins.fault.binarySha256);assert.equal(postRun.postRunIdentityVerified,true);identityVerified=true;}catch{ /* Retain original child outcome; independent identity gate remains red. */ }
    nativeRaw=collectNativeRaw(nativeCapture,out,collector,identityVerified);
    try {write(path.join(out,'capture-receipt.json'),{scope:'original-P01-P04-only',caseIds:[id],collection,binding:capture?.configuration.binding??null,completeConfigurationCaseIds:capture?.configuration.cases.map(c=>c.caseId)??null,installer:postRun,setupError:setupError??null,primaryError:primaryError??null,childExit:result?.status??null,childSignal:result?.signal??null,postRunIdentityVerified:identityVerified,fullSyntheticAcceptance:false,nativeCleanupCaptureEnabled:!!nativeCapture,nativeSetupError:nativeSetupError??null,nativeRaw,historicalProofs:true});}catch(error){console.error('Capture receipt unavailable; original child outcome retained:',String(error));}
  }
  if(result?.signal){process.kill(process.pid,result.signal);return;}
  process.exitCode=typeof result?.status==='number'?result.status:1;
}
async function reconcileOnly(repo,out) {
  const manifest=firstCauseManifest(baseManifest()),reports={},states={},receipts={},nativeRaws={};
  const collector=await import(pathToFileURL(path.join(repo,'scripts/acceptance/candidate-cleanup-diagnostics.ts')));
  for(const id of IDS){
    const phase=phaseFor(id),dir=path.join(out,phase+'-capture');
    try{reports[phase]=read(path.join(out,phase+'.vitest.json'));states[phase]=read(path.join(out,phase+'.state.json'));}catch{states[phase]={status:'not-run',reason:'Original report or state missing'};}
    const receiptFile=path.join(dir,'capture-receipt.json');try{receipts[id]=existsSync(receiptFile)?read(receiptFile):null;}catch{receipts[id]=null;}
    const recovered=recoverNativeRaw(id,dir,collector);
    nativeRaws[id]=recovered.rawFile?recovered:receipts[id]?.nativeRaw??recovered;
    // Observations are read only after the unchanged observer has stopped.
    try {
      const nativeRaw=nativeRaws[id],bytes=readFileSync(path.join(dir,'native.jsonl'));assert.equal(digest(bytes),nativeRaw.rawSha256);
      const inspected=collector.inspectCleanupBytes(bytes),processes=readFileSync(path.join(out,phase+'.processes.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
      const synthetic=read(path.join(dir,'web-browser.synthetic-evidence.json')),caseRow=synthetic.cases.find(row=>row.caseId===id);
      const operationSeqs=caseRow?.records.filter(row=>row.kind==='record'&&row.fact.kind==='native-result'&&row.fact.command==='capture.screenshot').map(row=>row.fact.result.operationSeq)??[];
      write(path.join(dir,'native-screenshot-binding.json'),bindNativeScreenshots({records:inspected.records,processes,production:path.join(process.env.GITHUB_WORKSPACE,'agent-browser'),binding:nativeRaw.binding,caseId:id,operationSeqs,diagnosticStatus:nativeRaw.status}));
    }catch{try{write(path.join(dir,'native-screenshot-binding.json'),{caseId:id,status:'unknown',reason:'raw-pid-source-join-unavailable',processCoverage:'sampled-only',fdCoverage:'not-observed',cleanupAcceptance:'unknown',releaseEligible:false,screenshots:[]});}catch{/* Missing evidence stays unknown; never a business gate. */}}
  }
  const value=selectedResult(manifest,reports,states,path.resolve(repo));
  write(path.join(out,'first-cause-selected-results.json'),{scope:'original-P01-P04-only',exact:value.exact,cases:value.selected,
    caseEvidence:IDS.map(id=>({caseId:id,childExit:states[phaseFor(id)]?.exitCode??null,collection:receipts[id]?.collection??{status:'unknown'},nativeRaw:nativeRaws[id]??{status:'unknown'},postRunIdentityVerified:receipts[id]?.postRunIdentityVerified??false})),
    fullSuiteStatus:'unknown',fullAcceptance:false,unselectedAssertionsExecuted:value.exact?false:'unknown'});
  assert.equal(value.exact,true,'Missing/skipped/duplicate/alien selection is not two original executions');
  assert.ok(IDS.every(id=>receipts[id]?.postRunIdentityVerified===true),'Source/dist/image identity unavailable or changed');
}
async function main() {
  const [mode,...args]=process.argv.slice(2);
  if(mode==='proofs')return historicalProofs(args[0]);
  if(mode==='run'){const [id,repo,production,fault,productionProof,faultProof,out,...command]=args;return captureRun(id,repo,production,fault,productionProof,faultProof,out,command);}
  if(mode==='reconcile')return reconcileOnly(...args);
  throw Error('Closed first-cause mode required');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error);process.exitCode=1;});
