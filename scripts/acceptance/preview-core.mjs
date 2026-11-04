/** CI ONLY: exact installed public CLI preview gate. Never run in local pure validation. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, realpathSync, existsSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORE_HTML, ECHO_HTML, CONFIG, CORE_TEST, SECRET_TEST } from './fixtures/preview-core.mjs';
import { shaSafeIdentity, noSecrets, verifyReport, verifyWitness, verifyObjectPng, verifyViewportPng, verifyExit, retainEvidenceDirectory } from './preview-core-proof.mjs';
const [bundleArg, digest, projectArg, evidenceArg, ...extra] = process.argv.slice(2);
if (!bundleArg || !projectArg || !evidenceArg || extra.length || !/^[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('usage: preview-core.mjs BUNDLE EXTERNALLY_TRUSTED_MANIFEST_SHA NEW_PROJECT NEW_EVIDENCE');
const bundle=realpathSync(bundleArg), project=path.resolve(projectArg), evidence=path.resolve(evidenceArg);
const checkout=path.resolve(import.meta.dirname,'../..');
function outside(root, child) { const rel=path.relative(root,child);return rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel); }
assert.ok(outside(checkout,project)&&outside(bundle,project),'Consumer must be outside checkout and bundle');
assert.ok(outside(project,evidence)&&outside(bundle,evidence),'Evidence must be separate');
assert.ok(!existsSync(project)&&!existsSync(evidence),'Fresh consumer and evidence required');
mkdirSync(project,{recursive:true});mkdirSync(evidence,{recursive:true});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=file=>JSON.parse(readFileSync(file,'utf8'));
function save(name,value) {writeFileSync(path.join(evidence,name),JSON.stringify(value,null,2)+'\n');}
function files(root) { const found=[];for(const entry of readdirSync(root,{withFileTypes:true})){const file=path.join(root,entry.name);assert.ok(!entry.isSymbolicLink(),'No evidence symlinks');if(entry.isDirectory())found.push(...files(file));else {assert.ok(entry.isFile());found.push(file);}}return found;}
const env={...process.env,HOME:path.join(project,'home'),E2E_TELEMETRY_DISABLED:'1',E2E_UPDATE_CHECK_DISABLED:'1',E2E_CACHE_DIR:'',CI:'true'};
for(const key of Object.keys(env)) if (/^(E2E_AGENT_BROWSER|AGENT_BROWSER)/.test(key)||['NODE_PATH','NODE_OPTIONS','E2E_CHROMIUM_EXECUTABLE'].includes(key)) delete env[key];
mkdirSync(env.HOME);
// A boolean opt-in, never an externally supplied path or native override.
const nativeDiagnostics=process.env.E2E_CORE_NATIVE_DIAGNOSTICS==='1';
function beginNativeDiagnostic(stage) {
 assert.ok(['baseline','repeat','secret'].includes(stage));
 // Raw append custody stays outside every uploaded directory. Only validated
 // bounded bytes are copied into evidence; unknown replacement files stay private.
 assert.equal(realpathSync(project),project);assert.ok(!lstatSync(project).isSymbolicLink());
 const parent=lstatSync(project),destination=lstatSync(evidence);
 const file=path.join(project,stage+'-native-cleanup.jsonl');
 const fd=openSync(file,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
 const owner=fstatSync(fd);assert.ok(owner.isFile());
 return {file,finish(){try {
  const current=lstatSync(file),held=fstatSync(fd);
  assert.ok(current.isFile()&&!current.isSymbolicLink());assert.equal(realpathSync(file),file);
  for(const key of ['dev','ino']){assert.equal(current[key],owner[key]);assert.equal(held[key],owner[key]);}
  assert.ok(held.size<=256*1024,'Native diagnostic exceeded its closed sink bound');
  const bytes=Buffer.alloc(256*1024+1);const size=readSync(fd,bytes,0,bytes.length,0);assert.ok(size<=256*1024);
  const content=bytes.subarray(0,size);noSecrets(content);
  assert.equal(size,held.size);const after=fstatSync(fd);
  for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(after[key],held[key]);
  const leaf=lstatSync(file);for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(leaf[key],held[key]);
  for(const [directory,directoryOwner] of [[project,parent],[evidence,destination]]){const stat=lstatSync(directory);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());for(const key of ['dev','ino'])assert.equal(stat[key],directoryOwner[key]);assert.equal(realpathSync(directory),directory);}
  assert.equal(realpathSync(evidence),evidence);assert.ok(!lstatSync(evidence).isSymbolicLink());
  writeFileSync(path.join(evidence,path.basename(file)),content,{flag:'wx',mode:0o600});
  return {file:path.basename(file),bytes:size,sha256:sha(content),status:size===0?'empty-unknown':'captured',acceptanceEvidence:false};
 } finally {closeSync(fd);}}};
}
let server;
const stages={};
async function command(label, executable, args, timeoutMs=180_000, extraEnv={}) {
 const result=await new Promise(resolve=>{
  let child;let timedOut=false,overflow=false,error=null;let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0);let timer;
  const kill=()=>{try{if(child?.pid)process.kill(-child.pid,'SIGKILL');}catch{try{child?.kill('SIGKILL');}catch{}}};
  try {child=spawn(executable,args,{cwd:project,env:{...env,...extraEnv},shell:false,detached:true,stdio:['ignore','pipe','pipe']});}
  catch {resolve({code:null,signal:null,error:'spawn-error',timedOut:false,overflow:false,stdout,stderr});return;}
  timer=setTimeout(()=>{timedOut=true;kill();},timeoutMs);
  const add=(which,chunk)=>{if(stdout.length+stderr.length+chunk.length>16*1024*1024){overflow=true;kill();return;}if(which==='stdout')stdout=Buffer.concat([stdout,chunk]);else stderr=Buffer.concat([stderr,chunk]);};
  child.stdout.on('data',chunk=>add('stdout',chunk));child.stderr.on('data',chunk=>add('stderr',chunk));
  child.on('error',()=>{error='spawn-error';});
  child.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,error,timedOut,overflow,stdout,stderr});});
 });
 writeFileSync(path.join(evidence,label+'.stdout.log'),result.stdout);writeFileSync(path.join(evidence,label+'.stderr.log'),result.stderr);
 const {stdout,stderr,...receipt}=result;stages[label]={...receipt,command:[executable,...args],stdoutBytes:stdout.length,stderrBytes:stderr.length,stdoutSha256:sha(stdout),stderrSha256:sha(stderr)};save('commands.json',stages);
 noSecrets(stdout);noSecrets(stderr);return {...receipt,stdout,stderr};
}
try {
 assert.equal(process.version,'v24.22.1');assert.match(process.env.GITHUB_SHA??'',/^[a-f0-9]{40}$/);assert.equal(process.env.GITHUB_REPOSITORY,'levicode/e2e');assert.match(process.env.GITHUB_RUN_ID??'',/^[0-9]+$/);assert.match(process.env.GITHUB_RUN_ATTEMPT??'',/^[0-9]+$/);
 const manager=await command('pnpm-version','pnpm',['--version']);verifyExit(manager,true);assert.equal(manager.stdout.toString().trim(),'12.3.4');
 const manifestBytes=readFileSync(path.join(bundle,'manifest.json'));assert.equal(sha(manifestBytes),digest);
 const manifest=JSON.parse(manifestBytes);shaSafeIdentity(manifest);assert.equal(manifest.platform,process.platform);assert.equal(manifest.architecture,process.arch);
 // Verify the public installer bytes before executing that installer, not merely from inside it.
 assert.equal(manifest.installation?.schemaVersion,1);const installerFiles=manifest.installation.installerFiles;assert.ok(Array.isArray(installerFiles));
 for(const required of ['install.mjs','installer/bundle.js','installer/bundle-install.js','installer/installed-runtime.js','installer/package.json'])assert.ok(installerFiles.some(file=>file.path===required));
 const members=[...Object.values(manifest.packages),manifest.native,manifest.producer,manifest.negotiation,...installerFiles];const memberPaths=new Set();
 for(const member of members){assert.equal(typeof member.path,'string');assert.ok(member.path&&!path.isAbsolute(member.path)&&!member.path.includes('\\')&&!member.path.split('/').some(part=>part==='..'||part==='.'));assert.ok(!memberPaths.has(member.path));memberPaths.add(member.path);assert.match(member.sha256,/^[a-f0-9]{64}$/);const file=path.join(bundle,member.path);assert.ok(!lstatSync(file).isSymbolicLink()&&lstatSync(file).isFile());assert.ok(!outside(bundle,realpathSync(file)));assert.equal(sha(readFileSync(file)),member.sha256,'Bundle member changed before public installer execution');}
 const producerBefore=readFileSync(path.join(bundle,manifest.producer.path));writeFileSync(path.join(evidence,'bundle-manifest.json'),manifestBytes);writeFileSync(path.join(evidence,'bundle-producer.json'),producerBefore);
 writeFileSync(path.join(project,'package.json'),JSON.stringify({name:'e2e-preview-core-consumer',private:true,type:'module',dependencies:{ai:'7.0.153'}})+'\n');
 verifyExit(await command('install-bundle',process.execPath,[path.join(bundle,'install.mjs'),bundle,digest,project],300_000),true);
 // Only CI reaches these installed verifier imports; pure tests never import this entrypoint.
 const {installedPackageRoots}=await import(pathToFileURL(path.join(bundle,'installer/installed-runtime.js')).href);
 const {verifyInstalledBundle}=await import(pathToFileURL(path.join(bundle,'installer/bundle.js')).href);
 const roots=await installedPackageRoots(project);for(const root of Object.values(roots))assert.ok(!outside(path.join(project,'node_modules'),root));
 verifyInstalledBundle(bundle,digest,roots);
 const require=createRequire(path.join(roots.core,'package.json'));
 const sdkEntry=realpathSync(require.resolve('ai')); assert.ok(!outside(path.join(project,'node_modules'),sdkEntry));
 let sdk; let sdkDirectory=path.dirname(sdkEntry);
 for(let depth=0;depth<16 && !outside(project,sdkDirectory);depth++,sdkDirectory=path.dirname(sdkDirectory)) { const metadata=path.join(sdkDirectory,'package.json');if(!existsSync(metadata))continue;assert.ok(lstatSync(metadata).isFile()&&!lstatSync(metadata).isSymbolicLink());assert.ok(lstatSync(metadata).size<=65536);const value=json(metadata);if(value.name==='ai'){sdk=value;break;} }
 assert.equal(sdk?.version,'7.0.153');
 const descriptorBefore=readFileSync(path.join(project,'.e2e/native-runtime.json'));
 save('identity-before.json',{manifestSha256:digest,source:manifest.source,nativeSource:manifest.nativeSource,nativeSha256:manifest.native.sha256,platform:process.platform,architecture:process.arch,node:process.version,ai:sdk.version,bundleRoot:bundle,projectRoot:project,nodeExecutable:process.execPath,orchestrator:{commit:process.env.GITHUB_SHA,repository:process.env.GITHUB_REPOSITORY,run:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT},roots,producerSha256:sha(producerBefore),descriptorSha256:sha(descriptorBefore),nativeOverrideAbsent:!('E2E_AGENT_BROWSER_EXECUTABLE' in env),chromiumOverrideAbsent:!('E2E_CHROMIUM_EXECUTABLE' in env),isolatedHome:env.HOME});
 // Public browser installer, not a repo helper or native executable override. Fresh HOME; no Playwright install, no ffmpeg.
 verifyExit(await command('install-chromium','pnpm',['exec','e2e-web','install','chromium',...(process.platform==='linux'?['--with-deps']:[])],600_000),true);
 mkdirSync(path.join(project,'tests'));
 writeFileSync(path.join(project,'e2e.config.ts'),CONFIG);writeFileSync(path.join(project,'tests/core.e2e.ts'),CORE_TEST);writeFileSync(path.join(project,'tests/secret.e2e.ts'),SECRET_TEST);
 server=createServer((request,response)=>{response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(request.url==='/echo'?ECHO_HTML:CORE_HTML);});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 env.PREVIEW_CORE_URL=`http://127.0.0.1:${server.address().port}`;
 const snapshots=path.join(project,'tests/core.e2e.ts-snapshots');
 async function cli(stage, test, update=false) {
  const output=path.join(project,'.e2e','preview-'+stage);const witness=path.join(evidence,stage+'-core-witness.json'),screen=path.join(evidence,stage+'-screen-witness.json'),secret=path.join(evidence,'secret-observation.json');
  const args=['exec','e2e','run',test,'--output',output,'--reporter','json,markdown,junit','--video','off','--trace','off',...(update?['--update-snapshots']:[])];
  const diagnostic=nativeDiagnostics?beginNativeDiagnostic(stage):undefined;
  let result;let diagnosticFailure=false;
  try {result=await command(stage,'pnpm',args,240_000,{PREVIEW_CORE_WITNESS:witness,PREVIEW_SCREENSHOT_WITNESS:screen,PREVIEW_SECRET_WITNESS:secret,...(diagnostic?{AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE:diagnostic.file}:{})});}
  finally {if(diagnostic){try{save(stage+'-native-diagnostic.json',diagnostic.finish());}catch{diagnosticFailure=true;try{save(stage+'-native-diagnostic.json',{status:'invalid-unknown',acceptanceEvidence:false});}catch{/* Never replace the original command failure with diagnostic persistence. */}}}}
  if(existsSync(output))await retainEvidenceDirectory(output,path.join(evidence,stage+'-output'),project);
  if(stage!=='secret'&&existsSync(snapshots))await retainEvidenceDirectory(snapshots,path.join(evidence,stage+'-snapshots'),project);
  verifyExit(result,stage!=='secret');const report=json(path.join(output,'report.json'));const counts=verifyReport(report,stage);
  assert.equal(diagnosticFailure,false,'Native diagnostic ownership or bound validation failed');
  for(const file of files(output)) {assert.ok(lstatSync(file).size<=32*1024*1024);noSecrets(readFileSync(file));}
  assert.ok(files(output).some(file=>file.endsWith('.md')));assert.ok(files(output).some(file=>file.endsWith('.xml')));
  return {output,witness,screen,report,counts};
 }
 const baseline=await cli('baseline','tests/core.e2e.ts',true);
 const snapshotFiles=files(snapshots);assert.equal(snapshotFiles.length,1);assert.ok(snapshotFiles[0].endsWith('.png'));
 const objectBytes=readFileSync(snapshotFiles[0]);writeFileSync(path.join(evidence,'object-baseline.png'),objectBytes);const object=verifyObjectPng(objectBytes);
 const objectHash=sha(objectBytes);
 save('object-oracle.json',{...object,sha256:objectHash,meaning:'Independent fixed geometry/color oracle approved before repeat without update-snapshots'});
 const repeat=await cli('repeat','tests/core.e2e.ts');assert.equal(sha(readFileSync(snapshotFiles[0])),objectHash,'Repeat changed baseline');
 writeFileSync(path.join(evidence,'object-repeat.png'),readFileSync(snapshotFiles[0]));
 const screen=json(repeat.screen);const screenshot=path.resolve(screen.screenshot);
 assert.ok(!outside(repeat.output,realpathSync(screenshot)),'Screenshot outside this run output');
 const viewportBytes=readFileSync(screenshot);writeFileSync(path.join(evidence,'viewport.png'),viewportBytes);assert.ok(repeat.report.run.results[0].attempts[0].artifacts.some(artifact=>artifact.kind==='screenshot'&&artifact.sha256===sha(viewportBytes)),'Viewport bytes absent from CLI report');const viewport=verifyViewportPng(viewportBytes);
 const secret=await cli('secret','tests/secret.e2e.ts');
 verifyWitness(json(repeat.witness),screen,json(path.join(evidence,'secret-observation.json')));
 // Include all reporter/cache/session output under .e2e, not just selected report fields.
 for(const file of files(path.join(project,'.e2e')))noSecrets(readFileSync(file));
 verifyInstalledBundle(bundle,digest,await installedPackageRoots(project));
 assert.equal(sha(readFileSync(path.join(bundle,'manifest.json'))),digest);assert.equal(sha(readFileSync(path.join(bundle,manifest.producer.path))),sha(producerBefore));assert.equal(sha(readFileSync(path.join(project,'.e2e/native-runtime.json'))),sha(descriptorBefore));
 save('identity-after.json',{...json(path.join(evidence,'identity-before.json')),manifestSha256:sha(readFileSync(path.join(bundle,'manifest.json'))),producerSha256:sha(readFileSync(path.join(bundle,manifest.producer.path))),descriptorSha256:sha(readFileSync(path.join(project,'.e2e/native-runtime.json')))});
 const inventory=files(evidence).map(file=>({path:path.relative(evidence,file),bytes:lstatSync(file).size,sha256:sha(readFileSync(file))}));
 save('preview-core-result.json',{schemaVersion:1,status:'passed',previewCorePassed:true,acceptanceEvidence:false,fullCandidateAccepted:false,releaseEligible:false,scope:'Fresh isolated test-only Chromium; installed public CLI; deterministic no-model core smoke, not full acceptance',source:manifest.source,nativeSource:manifest.nativeSource,manifestSha256:digest,nativeSha256:manifest.native.sha256,platform:process.platform,architecture:process.arch,node:process.version,ai:sdk.version,core:{baseline:baseline.counts,repeat:repeat.counts,secretNegativeControls:secret.counts,object,viewport,canonicalNativeRefAction:true,fill:true,secretForms:6,identityUnchanged:true},limits:['No claim of standalone locator.screenshot API; object screenshot is public toHaveScreenshot with independently checked crop','No claim of production credential safety beyond the synthetic transformed-secret boundary','No recovery/restore/popup/full matrix acceptance','Existing installed11 remains separately required for each new platform'],inventory});
 console.log('PREVIEW_CORE_PASS_LIMITED_SCOPE');
} catch {
 save('preview-core-result.json',{schemaVersion:1,status:'failed',previewCorePassed:false,acceptanceEvidence:false,fullCandidateAccepted:false,releaseEligible:false,reason:'Core gate failed; inspect bounded command receipts and synthetic-only outputs',lastStage:Object.keys(stages).at(-1)??'preflight'});
 process.exitCode=1;console.error('PREVIEW_CORE_FAILED');
} finally {
 if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
