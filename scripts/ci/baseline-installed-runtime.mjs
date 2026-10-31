/** Historical runtime + current JS diagnostic binding, never a fabricated native gate. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,realpathSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyArtifact} from './native-runtime.ts';
import {validateInstalledSdkPrerequisite} from '../acceptance/installed-public-proof.ts';
const H=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
export function closedRecords(text){
 const rows=text.split('\n').filter(x=>x.startsWith('INSTALLED_RUN_CLOSED ')).map(x=>{assert.ok(x.length<=32768);return JSON.parse(x.slice(21));});
 assert.ok(rows.length<=2);const seen=new Set();
 const codes=['other','INVALID_CONFIG','CONFIG_NOT_FOUND','CONFIG_AMBIGUOUS','CONFIG_LOAD_FAILED','INVALID_GLOB','NO_TESTS','NO_TESTS_FOUND','COLLECTION_FAILED','MODEL_UNAVAILABLE','RUNNER_BUSY','UNSUPPORTED_CAPABILITY','TEST_SETUP_FAILED','POLICY_DENIED','REPLAY_STALE','REPORT_WRITE_FAILED'];
 const phases=['other','config','collection','filter','launch','beforeAll','beforeEach','body','afterEach','afterAll','cleanup','report'];
 for(const [index,x] of rows.entries()){
  assert.deepEqual(Object.keys(x).sort(),['schemaVersion','evidence','stage','exitCode','status','resultCount','truncated','errors'].sort());assert.equal(x.schemaVersion,1);assert.equal(x.evidence,'partial-diagnostic-not-acceptance');assert.equal(x.stage,index===0?'record':'replay');assert.ok(!seen.has(x.stage));seen.add(x.stage);assert.ok([0,1,2,3,4,130,null].includes(x.exitCode));assert.ok(['passed','failed','blocked','interrupted','other'].includes(x.status));assert.ok(Number.isInteger(x.resultCount)&&x.resultCount>=0&&x.resultCount<=16);assert.equal(typeof x.truncated,'boolean');assert.ok(Array.isArray(x.errors)&&x.errors.length<=32);
  for(const e of x.errors){assert.deepEqual(Object.keys(e).sort(),['scope','resultIndex','attemptIndex','stepIndex','code','category','phase'].sort());assert.ok(['run','attempt','secondary','step'].includes(e.scope));for(const [key,max]of [['resultIndex',15],['attemptIndex',3],['stepIndex',63]])assert.ok(Number.isInteger(e[key])&&e[key]>=-1&&e[key]<=max);assert.ok(codes.includes(e.code));assert.ok(['other','test','configuration','infrastructure','internal','interrupted'].includes(e.category));assert.ok(phases.includes(e.phase));if(e.scope==='run')assert.ok(e.resultIndex===-1&&e.attemptIndex===-1&&e.stepIndex===-1);else {assert.ok(e.resultIndex>=0&&e.resultIndex<x.resultCount&&e.attemptIndex>=0);assert.ok(e.scope==='step'?e.stepIndex>=0:e.stepIndex===-1);}}
 }
 if(rows.length===2)assert.ok(rows[0].exitCode===0&&rows[0].status==='passed');return rows;
}
export function deriveProducer(c,m){
 assert.equal(c.purpose,'baseline-installed-diagnostic');assert.equal(c.acceptanceEvidence,false);const p=c.ordinary;
 assert.deepEqual(m.source,p.expected.source);assert.deepEqual(m.nativeSource,p.nativeSource);assert.equal(m.binarySha256,p.binarySha256);assert.equal(m.runId,p.expected.runId);assert.equal(m.runAttempt,p.expected.runAttempt);assert.equal(m.acceptanceEvidence,false);assert.equal(m.kind,'source-built-ci-runtime');assert.deepEqual(m.compilation.features,[]);assert.equal(m.platform,p.expected.platform);assert.equal(m.architecture,p.expected.architecture);
 return {schemaVersion:1,kind:'diagnostic-historical-native-provenance',purpose:c.purpose,acceptanceEvidence:false,releaseEligible:false,source:m.nativeSource,binary:{sha256:m.binarySha256},producer:{platform:m.platform,architecture:m.architecture,repository:m.repository,runId:m.runId,runAttempt:m.runAttempt,workflowSha:m.source.commit},originalRuntime:{manifestSHA256:p.manifestSha256,artifactId:p.artifactId,artifactDigest:p.artifactDigest,source:m.source,compilerSHA256:m.compilerSha256,rustcSHA256:m.rustcSha256},historicalPairSealSHA256:c.historicalPairSealSHA256,notClaimed:['current-run compilation','hosted contract pass','encoder gate pass','full candidate acceptance'],originalFormalBinarySHA256:c.originalFormalBinarySHA256};
}
/** The peer receipt is a pre-fixture snapshot, never final installed acceptance. */
export function collectSdkObservation(installed,peerValue,log){
 assert.ok(installed && ['passed','failed'].includes(installed.status));
 const peer=peerValue===undefined?null:validateInstalledSdkPrerequisite(peerValue);
 const hasLog=typeof log==='string';assert.ok(log===undefined||hasLog);
 if(hasLog)assert.ok(Buffer.byteLength(log)<=16*1024*1024);
 if(peer?.status==='failed'){assert.equal(installed.status,'failed');assert.equal(hasLog,false,'SDK prerequisite failure must stop before consumer fixture');}
 const rows=hasLog?closedRecords(log):[];
 if(installed.status==='passed'){assert.equal(peer?.status,'verified');assert.equal(hasLog,true);assert.equal(rows.length,2,'Successful installed fixture must retain both original closed records');assert.ok(rows.every(x=>x.exitCode===0&&x.status==='passed'));}
 return {sdkPrerequisite:peer??{status:'incomplete',reason:'missing-receipt'},sdkPrerequisiteVerified:peer?.status==='verified',consumerExecution:hasLog?'consumer-log-retained':peer?.status==='failed'?'unrun-sdk-prerequisite-failed':'incomplete-no-consumer-log',closedRecords:rows};
}
function main(mode){
 const c=read('scripts/ci/baseline-installed-binding.json');const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();
 assert.equal(process.env.GITHUB_REF,c.exactRef);assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');assert.equal(process.env.GITHUB_REPOSITORY,'levicode/e2e');assert.equal(process.version,'v24.22.1');assert.equal(git('status','--porcelain'),'');assert.equal(git('rev-parse','HEAD'),process.env.GITHUB_SHA);
 const source={commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}')};const paths=git('diff-tree','--no-commit-id','--name-only','-r',c.baseCommit,'HEAD').split('\n').filter(Boolean).sort();assert.deepEqual(paths,[...c.allowedDelta].sort());
 for(const [p,h]of Object.entries(c.producer209)){assert.equal(H(readFileSync(p)),h);assert.equal(H(execFileSync('git',['show',`HEAD:${p}`])),h);}
 assert.equal(H(readFileSync('scripts/ci/full-standard-runtime-pins.json')),c.originalPinsSHA256);assert.equal(read('.github/native-candidate.json').commit,c.ordinary.nativeSource.commit);
 const dir=join(process.env.RUNNER_TEMP,'baseline-installed-runtime');const pin=c.ordinary;const executable=verifyArtifact(dir,pin.manifestSha256,pin.expected);const m=read(join(dir,'manifest.json'));assert.deepEqual(m.nativeSource,pin.nativeSource);assert.equal(H(readFileSync(executable)),pin.binarySha256);assert.equal(m.compilerSha256,pin.compiler.compilerSHA256);assert.equal(m.rustcSha256,pin.compiler.rustcSHA256);
 if(mode==='bind'){
  writeFileSync('.artifacts/baseline-installed-diagnostic/diagnostic-producer.json',JSON.stringify(deriveProducer(c,m),null,2)+'\n',{flag:'wx'});writeFileSync('.artifacts/baseline-installed-diagnostic/current-js-source.json',JSON.stringify({source,purpose:c.purpose,acceptanceEvidence:false,originalRuntimeSource:m.source},null,2)+'\n',{flag:'wx'});
 }else if(mode==='collect'){
  const installed=read('.artifacts/baseline-installed-diagnostic/installed.result.json');const peerPath='.artifacts/baseline-installed-diagnostic/installed-sdk-prerequisite.json';const logPath='.artifacts/baseline-installed-diagnostic/installed-consumer.log';const observation=collectSdkObservation(installed,existsSync(peerPath)?read(peerPath):undefined,existsSync(logPath)?readFileSync(logPath,'utf8'):undefined);const rows=observation.closedRecords;const code=Number(readFileSync('.artifacts/baseline-installed-diagnostic/installed-command.exit','utf8').trim());assert.ok(Number.isInteger(code)&&code>=0&&code<=255);assert.deepEqual(read('.artifacts/baseline-installed-diagnostic/current-js-source.json').source,source);
  writeFileSync('.artifacts/baseline-installed-diagnostic/baseline-installed-diagnostic.json',JSON.stringify({purpose:c.purpose,acceptanceEvidence:false,source,nativeSource:m.nativeSource,binarySHA256:m.binarySha256,originalRuntimeSource:m.source,originalInstalledExit:code,installedStatus:installed.status,...observation,observation:rows.length?'bounded-facts-observed':'incomplete-before-first-record',replayObserved:rows.length===2,fullCandidateAccepted:false,releaseEligible:false},null,2)+'\n',{flag:'wx'});
 }else assert.fail('bind or collect only');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){assert.equal(process.argv.length,3);main(process.argv[2]);}
