/** Pure, bounded proof checks. No SDK, browser, native process, or network imports. */
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { FORMS } from './fixtures/preview-core.mjs';
export function shaSafeIdentity(manifest) {
 for (const key of ['source', 'nativeSource']) for (const field of ['commit', 'tree']) assert.match(manifest[key]?.[field] ?? '', /^[a-f0-9]{40}$/);
 assert.match(manifest.native?.sha256 ?? '', /^[a-f0-9]{64}$/);
 assert.ok(['linux', 'darwin'].includes(manifest.platform)); assert.ok(['x64', 'arm64'].includes(manifest.architecture));
}
export function noSecrets(value) {
 const text = Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : JSON.stringify(value);
 assert.ok(!FORMS.some(form => text.includes(form)), 'Synthetic secret form found in protected output');
}
export function verifyReport(report, stage) {
 noSecrets(report);
 assert.equal(report.schemaVersion, 'report-1');
 const run = report.run; assert.ok(run && Array.isArray(run.results));
 const stack=[report]; let visited=0; while(stack.length){const value=stack.pop();assert.ok(++visited<100000);if(value && typeof value==='object')for(const [key,item] of Object.entries(value)){if(/truncated$/i.test(key))assert.ok(item===false||item===0||item===undefined,'Truncated report evidence');if(item && typeof item==='object')stack.push(item);}}
 assert.deepEqual(run.errors, []); assert.equal(run.environment?.runtime, 'node v24.22.1');
 const expected = stage === 'secret' ? new Map([
  ['fails on the plain echo', 'failed'], ['fails on the upper echo', 'failed'], ['fails on the lower echo', 'failed'], ['fails on the note-echo echo', 'failed'],
  ['observes the echoes', 'passed'], ['matches the transformed text', 'passed'],
 ]) : new Map([['preview core public flow', 'passed']]);
 const allTitles=['preview core public flow','fails on the plain echo','fails on the upper echo','fails on the lower echo','fails on the note-echo echo','observes the echoes','matches the transformed text'];
 const remaining=new Set(allTitles);const selectedCount=expected.size;assert.equal(run.results.length,allTitles.length);
 assert.equal(run.summary.discovered,7);assert.equal(run.summary.selected,selectedCount);
 for (const result of run.results) {
  assert.equal(result.titlePath.length,1);const title=result.titlePath[0];assert.ok(remaining.delete(title),'Unknown or duplicate discovered result');
  assert.equal(result.kind,'test');assert.equal(result.targetId,'preview');assert.equal(result.repeat,0);
  assert.equal(result.file,title==='preview core public flow'?'tests/core.e2e.ts':'tests/secret.e2e.ts');
  if(!expected.has(title)) {
   assert.equal(result.selected,false);assert.equal(result.status,'skipped');assert.deepEqual(result.attempts,[]);
   assert.deepEqual(result.skip,{cause:'filtered',reason:'file not selected by a positional argument'});assert.equal(result.error,undefined);if(result.secondaryErrors!==undefined)assert.deepEqual(result.secondaryErrors,[]);
   continue;
  }
  assert.equal(result.skip,undefined);
  const status = expected.get(title); expected.delete(title);
  for(const row of [result,...result.attempts]) {if(row.secondaryErrors!==undefined)assert.deepEqual(row.secondaryErrors,[]);}
  if(result.error!==undefined){assert.equal(status,'failed');for(const key of ['code','category','phase','message'])assert.equal(result.error[key],result.attempts[0].error?.[key]);}
  assert.equal(result.selected, true); assert.equal(result.status, status);
  assert.equal(result.attempts.length, 1); assert.equal(result.attempts[0].status, status);
  if (status === 'failed') {
   const attempt=result.attempts[0];assert.equal(attempt.error?.code,'ASSERTION_FAILED');assert.equal(attempt.error.category,'test');assert.equal(attempt.error.phase,'body');
   const message = attempt.error?.message; assert.equal(typeof message, 'string');assert.ok(message.includes('expect.toHaveText'));assert.ok(message.includes('something else'));
   assert.ok(Array.isArray(attempt.steps));const failedSteps=attempt.steps.filter(step=>step.status!=='passed');assert.equal(failedSteps.length,1);
   const failed=failedSteps[0];assert.equal(failed.kind,'assertion');assert.equal(failed.api,'expect.toHaveText');assert.equal(failed.status,'failed');assert.equal(failed.error?.code,'ASSERTION_FAILED');assert.equal(failed.error.category,'test');assert.equal(failed.error.phase,undefined);assert.equal(failed.phase,undefined);
   assert.equal(attempt.steps.at(-1),failed);assert.ok(failed.source?.file.endsWith('secret.e2e.ts'));
   const before=attempt.steps.slice(0,-1);assert.ok(before.some(step=>step.api==='app.open'&&step.status==='passed'));assert.equal(before.filter(step=>step.api==='locator.fill'&&step.status==='passed').length,2);
   assert.ok(message.includes(title.includes('note-echo') ? '<secret:note>' : '<secret:token>'), 'Expected redacted assertion failure absent');
  } else {
   assert.equal(result.error,undefined);assert.equal(result.attempts[0].error,undefined);
   const steps=result.attempts[0].steps;assert.ok(Array.isArray(steps)&&steps.length>0);assert.ok(steps.every(step=>step.status==='passed'));
   if(stage!=='secret')for(const api of ['app.open','locator.fill','agent.act','expect.toHaveScreenshot','app.screenshot'])assert.ok(steps.some(step=>step.api===api),'Core public API step missing');
  }
 }
 assert.equal(remaining.size,0);assert.equal(expected.size, 0); assert.equal(run.status, stage === 'secret' ? 'failed' : 'passed'); assert.equal(run.exitCode,stage==='secret'?1:0);
 assert.equal(run.summary.executed, stage === 'secret' ? 6 : 1);
 assert.equal(run.summary.passed, stage === 'secret' ? 2 : 1);
 assert.equal(run.summary.failed, stage === 'secret' ? 4 : 0);
 for (const key of ['skipped','interrupted','flaky']) assert.equal(run.summary[key], 0);
 return { executed: run.summary.executed, passed: run.summary.passed, failed: run.summary.failed };
}
export function verifyWitness(core, screen, secret) {
 noSecrets(core); noSecrets(screen); noSecrets(secret);
 assert.equal(core.schemaVersion, 1); assert.match(core.nativeReference, /^\S+$/); assert.equal(core.displayReference, '#' + core.nativeReference); assert.equal(core.observedTreeId,core.nativeReference); assert.equal(core.dispatchId,core.displayReference); assert.equal(core.secondDispatchId,core.secondObservedTreeId); assert.match(core.secondObservedTreeId,/^\S+$/);
 assert.equal(core.refAction, true); assert.ok(core.compactText.split('\n').some(line => line.trim().startsWith(core.displayReference + ' ') && line.includes('"Apply preview"')));
 assert.ok(core.middleText.includes('preview-filled-731:1')); assert.ok(core.afterText.includes('preview-filled-731:2'));
 for (const key of ['fillPassed','refEffectPassed','objectMatcherPassed']) assert.equal(screen[key], true);
 assert.ok(screen.compact.includes('Apply preview'));
 assert.equal(secret.schemaVersion, 1); assert.equal(secret.allSixFormsAbsent, true);
 assert.ok(secret.observation.includes('<secret:token>')); assert.ok(secret.observation.includes('<secret:note>'));
}
function crc32(bytes) { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); } return (crc^-1)>>>0; }
/** Independently decode only 8-bit non-interlaced RGB/RGBA PNG; reject all unsupported formats. */
export function decodePng(bytes) {
 assert.ok(bytes.length <= 16*1024*1024); assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 let offset=8, width, height, channels, ended=false; const blocks=[];
 while(offset<bytes.length) {
  assert.ok(offset+12<=bytes.length); const size=bytes.readUInt32BE(offset); const end=offset+12+size; assert.ok(end<=bytes.length);
  const type=bytes.toString('ascii',offset+4,offset+8); const data=bytes.subarray(offset+8,offset+8+size);
  assert.equal(crc32(bytes.subarray(offset+4,offset+8+size)),bytes.readUInt32BE(offset+8+size),'PNG CRC mismatch');
  if(type==='IHDR') { assert.equal(offset,8); assert.equal(size,13); width=data.readUInt32BE(0); height=data.readUInt32BE(4); assert.ok(width>0&&height>0&&width<=4096&&height<=4096); assert.equal(data[8],8); assert.ok([2,6].includes(data[9])); channels=data[9]===2?3:4; assert.equal(data[10],0);assert.equal(data[11],0);assert.equal(data[12],0); }
  else if(type==='IDAT') blocks.push(data);
  else if(type==='IEND') {assert.equal(size,0);assert.equal(end,bytes.length);ended=true;}
  offset=end;
 }
 assert.ok(ended&&width&&channels&&blocks.length); const stride=width*channels;
 const raw=inflateSync(Buffer.concat(blocks),{maxOutputLength:(stride+1)*height}); assert.equal(raw.length,(stride+1)*height);
 const pixels=Buffer.alloc(stride*height);
 function paeth(a,b,c) {const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;}
 for(let y=0;y<height;y++) { const filter=raw[y*(stride+1)];assert.ok(filter<=4);for(let x=0;x<stride;x++){const a=x>=channels?pixels[y*stride+x-channels]:0,b=y?pixels[(y-1)*stride+x]:0,c=y&&x>=channels?pixels[(y-1)*stride+x-channels]:0;pixels[y*stride+x]=(raw[y*(stride+1)+1+x]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter])&255;} }
 if(channels===4)for(let i=3;i<pixels.length;i+=4)assert.equal(pixels[i],255,'Transparent capture forbidden for this opaque fixture');
 return {width,height,pixel(x,y){const i=(y*width+x)*channels;return [...pixels.subarray(i,i+3)];}};
}
export function verifyObjectPng(bytes) {
 const image=decodePng(bytes);assert.equal(image.width,160);assert.equal(image.height,80);
 // Every pixel, not a hand-picked point: red left half, blue right half; green surrounding viewport must never be included.
 for(let y=0;y<80;y++)for(let x=0;x<160;x++)assert.deepEqual(image.pixel(x,y),x<80?[255,0,0]:[0,0,255],'Object crop pixels differ from independent synthetic oracle');
 return {width:160,height:80,redPixels:6400,bluePixels:6400,greenSurroundingPixels:0};
}
export function verifyViewportPng(bytes) {
 const image=decodePng(bytes);assert.equal(image.width,640);assert.equal(image.height,480);
 assert.deepEqual(image.pixel(600,400),[0,255,0]);assert.deepEqual(image.pixel(32,32),[255,0,0]);assert.deepEqual(image.pixel(160,32),[0,0,255]);
 return {width:640,height:480,syntheticRegionsVerified:true};
}
export function verifyExit(result, expectedSuccess) {
 assert.equal(result.signal,null); assert.equal(result.error,null); assert.equal(result.timedOut,false); assert.equal(result.overflow,false);
 assert.ok(Number.isInteger(result.code)); if(expectedSuccess) assert.equal(result.code,0); else assert.equal(result.code,1);
}

/** Bounded no-follow retention of a fixed owned output directory; never follows report-supplied paths. */
export async function retainEvidenceDirectory(source,destination,allowedParent) {
 const fs=await import('node:fs'),path=await import('node:path');const parent=fs.realpathSync(allowedParent),root=path.resolve(source),target=path.resolve(destination);
 const directoryFact=file=>{const stat=fs.lstatSync(file,{bigint:true});assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());assert.equal(fs.realpathSync(file),file);return{file,dev:stat.dev,ino:stat.ino};};
 const fence=facts=>{for(const old of facts){const current=directoryFact(old.file);assert.equal(current.dev,old.dev);assert.equal(current.ino,old.ino);}};
 assert.ok(root.startsWith(parent+path.sep));const rootFacts=[directoryFact(parent)];let at=parent;for(const segment of path.relative(parent,root).split(path.sep)){at=path.join(at,segment);rootFacts.push(directoryFact(at));}
 const destinationParent=directoryFact(path.dirname(target));assert.ok(!fs.existsSync(target));fs.mkdirSync(target);const targetFacts=[destinationParent,directoryFact(target)];
 let total=0,count=0;const maxFile=32*1024*1024,maxTotal=64*1024*1024;
 const sameFile=(a,b)=>{assert.ok(b.isFile());for(const key of ['dev','ino','size','mtimeNs','ctimeNs'])assert.equal(b[key],a[key],'Evidence identity or content metadata changed');};
 function visit(directory,relative='',depth=0,parents=rootFacts,destinations=targetFacts){assert.ok(depth<=24);fence(parents);fence(destinations);for(const name of fs.readdirSync(directory)){fence(parents);const file=path.join(directory,name),rel=path.join(relative,name),to=path.join(target,rel);const stat=fs.lstatSync(file,{bigint:true});assert.ok(!stat.isSymbolicLink(),'Evidence symlink rejected');assert.equal(fs.realpathSync(file),file);assert.ok(++count<=2048);
  if(stat.isDirectory()){fence(destinations);fs.mkdirSync(to);visit(file,rel,depth+1,[...parents,directoryFact(file)],[...destinations,directoryFact(to)]);continue;}
  assert.ok(stat.isFile()&&stat.size<=BigInt(maxFile));total+=Number(stat.size);assert.ok(total<=maxTotal);fence(parents);
  // NONBLOCK prevents a regular-file-to-FIFO race from hanging before fstat can reject it.
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {fence(parents);sameFile(stat,fs.fstatSync(fd,{bigint:true}));
   const bytes=Buffer.alloc(Number(stat.size)+1);let length=0;while(length<bytes.length){const n=fs.readSync(fd,bytes,length,bytes.length-length,null);if(n===0)break;length+=n;}assert.equal(length,Number(stat.size),'Evidence changed during read');
   sameFile(stat,fs.fstatSync(fd,{bigint:true}));fence(parents);fence(destinations);fs.writeFileSync(to,bytes.subarray(0,length),{flag:'wx'});fence(destinations);
  }finally{fs.closeSync(fd);}
 }fence(parents);}visit(root);fence(rootFacts);return{files:count,bytes:total};
}

/** Artifact-only replay: hash inventory first, then original report/pixel/witness checks. */
export async function verifyEvidence(directory, expectedManifestHash) {
 const fs=await import('node:fs'); const path=await import('node:path'); const {createHash}=await import('node:crypto');
 const root=fs.realpathSync(directory),read=name=>fs.readFileSync(path.join(root,name)),json=name=>JSON.parse(read(name));
 const receipt=json('preview-core-result.json');
 assert.match(expectedManifestHash??'',/^[a-f0-9]{64}$/);assert.equal(receipt.manifestSha256,expectedManifestHash);
 assert.equal(receipt.schemaVersion,1);assert.equal(receipt.status,'passed');assert.equal(receipt.previewCorePassed,true);
 for(const key of ['acceptanceEvidence','fullCandidateAccepted','releaseEligible'])assert.equal(receipt[key],false);
 assert.equal(receipt.node,'v24.22.1');assert.equal(receipt.ai,'7.0.153');assert.match(receipt.manifestSha256,/^[a-f0-9]{64}$/);assert.match(receipt.nativeSha256,/^[a-f0-9]{64}$/);
 const seen=new Set();assert.ok(Array.isArray(receipt.inventory)&&receipt.inventory.length>0);
 for(const member of receipt.inventory){assert.equal(typeof member.path,'string');assert.ok(member.path&&!path.isAbsolute(member.path)&&!member.path.includes('\\')&&!member.path.split('/').some(p=>p==='..'||p==='.'));assert.ok(!seen.has(member.path));seen.add(member.path);const file=path.join(root,member.path);assert.ok(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink());const real=fs.realpathSync(file);assert.ok(real.startsWith(root+path.sep));const bytes=read(member.path);assert.equal(bytes.length,member.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),member.sha256);noSecrets(bytes);}
 const list=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{const file=path.join(dir,entry.name);assert.ok(!entry.isSymbolicLink());return entry.isDirectory()?list(file):[path.relative(root,file).split(path.sep).join('/')];});
 assert.deepEqual(list(root).filter(name=>name!=='preview-core-result.json').toSorted(),[...seen].toSorted());
 const manifestBytes=read('bundle-manifest.json');assert.equal(createHash('sha256').update(manifestBytes).digest('hex'),expectedManifestHash);const manifest=JSON.parse(manifestBytes);shaSafeIdentity(manifest);
 for(const key of ['source','nativeSource','platform','architecture'])assert.deepEqual(manifest[key],receipt[key]);assert.equal(manifest.native.sha256,receipt.nativeSha256);
 assert.equal(createHash('sha256').update(read('bundle-producer.json')).digest('hex'),manifest.producer.sha256);const producer=json('bundle-producer.json');assert.deepEqual(producer.source,manifest.nativeSource);assert.equal(producer.binary.sha256,manifest.native.sha256);assert.equal(producer.producer.platform,manifest.platform);assert.equal(producer.producer.architecture,manifest.architecture);
 const commands=json('commands.json'), identity=json('identity-before.json');
 const labels=['pnpm-version','install-bundle','install-chromium','baseline','repeat','secret'];assert.deepEqual(Object.keys(commands).toSorted(),labels.toSorted());
 for(const key of ['manifestSha256','nativeSha256','source','nativeSource','platform','architecture','node','ai'])assert.deepEqual(identity[key],receipt[key]);
 assert.deepEqual(json('identity-after.json'),identity);assert.equal(identity.nativeOverrideAbsent,true);assert.equal(identity.chromiumOverrideAbsent,true);
 for(const key of ['bundleRoot','projectRoot','nodeExecutable'])assert.ok(path.isAbsolute(identity[key]));
 assert.match(identity.orchestrator.commit,/^[a-f0-9]{40}$/);assert.equal(identity.orchestrator.repository,'levicode/e2e');for(const key of ['run','attempt'])assert.match(identity.orchestrator[key],/^[0-9]+$/);
 for(const label of labels){verifyExit(commands[label],label!=='secret');for(const stream of ['stdout','stderr']){const name=label+'.'+stream+'.log';assert.ok(seen.has(name),'Required command stream absent');const bytes=read(name);assert.equal(commands[label][stream+'Bytes'],bytes.length);assert.equal(commands[label][stream+'Sha256'],createHash('sha256').update(bytes).digest('hex'));}}
 assert.deepEqual(commands['pnpm-version'].command,['pnpm','--version']);assert.equal(read('pnpm-version.stdout.log').toString().trim(),'12.3.4');
 assert.deepEqual(commands['install-bundle'].command,[identity.nodeExecutable,path.join(identity.bundleRoot,'install.mjs'),identity.bundleRoot,expectedManifestHash,identity.projectRoot]);
 assert.deepEqual(commands['install-chromium'].command,['pnpm','exec','e2e-web','install','chromium',...(receipt.platform==='linux'?['--with-deps']:[])]);
 for(const [label,test] of [['baseline','tests/core.e2e.ts'],['repeat','tests/core.e2e.ts'],['secret','tests/secret.e2e.ts']]){
  const expected=['pnpm','exec','e2e','run',test,'--output',path.join(identity.projectRoot,'.e2e','preview-'+label),'--reporter','json,markdown,junit','--video','off','--trace','off',...(label==='baseline'?['--update-snapshots']:[])];
  assert.deepEqual(commands[label].command,expected);verifyReport(json(label+'-output/report.json'),label);
 }
 assert.ok(read('object-baseline.png').equals(read('object-repeat.png')));verifyObjectPng(read('object-baseline.png'));verifyViewportPng(read('viewport.png'));
 verifyWitness(json('repeat-core-witness.json'),json('repeat-screen-witness.json'),json('secret-observation.json'));
 assert.equal(receipt.core.identityUnchanged,true);assert.equal(receipt.core.secretForms,6);
 assert.equal(json('object-oracle.json').sha256,createHash('sha256').update(read('object-baseline.png')).digest('hex'));
 return {status:'PASS_LIMITED_PREVIEW_CORE_ARTIFACT_REPLAY',platform:receipt.platform,architecture:receipt.architecture,manifestSha256:receipt.manifestSha256,fullCandidateAccepted:false,releaseEligible:false};
}
// This optional entrypoint reads artifacts only, never imports/runs the product.
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
 try {assert.equal(process.argv.length,4);console.log(JSON.stringify(await verifyEvidence(process.argv[2],process.argv[3])));}
 catch {console.error('PREVIEW_CORE_ARTIFACT_REPLAY_FAILED');process.exitCode=1;}
}
