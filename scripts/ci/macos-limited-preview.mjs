/** Independent test-only macOS qualification. Never native/full candidate acceptance. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,lstatSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const H=b=>createHash('sha256').update(b).digest('hex');
const PURPOSE='macos-arm64-limited-preview';
export function verifySource(c,git,bytes,env){
 assert.equal(c.purpose,PURPOSE);assert.equal(c.acceptanceEvidence,false);
 assert.equal(env.GITHUB_REPOSITORY,'levicode/e2e');assert.equal(env.GITHUB_REF,'refs/heads/'+c.branch);assert.equal(env.GITHUB_RUN_ATTEMPT,'1');
 const source={commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}')};assert.match(source.commit,/^[a-f0-9]{40}$/);assert.match(source.tree,/^[a-f0-9]{40}$/);assert.equal(source.commit,env.GITHUB_SHA);assert.notEqual(source.commit,c.baseCommit);assert.equal(git('rev-parse','HEAD^'),c.baseCommit);assert.equal(git('status','--porcelain'),'');
 assert.deepEqual(git('diff-tree','--no-commit-id','--name-only','-r',c.baseCommit,'HEAD').split('\n').filter(Boolean).sort(),[...c.allowedDelta].sort());
 const ls=git('ls-tree','-r','HEAD').split('\n').filter(Boolean);assert.equal(H(ls.filter(s=>!c.sourceSealExclusions.includes(s.split('\t')[1])).join('\n')+'\n'),c.sourceSealSHA256);
 for(const [p,h]of Object.entries({...c.producer209,...c.fixedInputs}))assert.equal(H(bytes(p)),h,'fixed source input');
 return source;
}
export function verifyCompiler(c,rows,context){
 assert.equal(c.purpose,PURPOSE);assert.equal(c.acceptanceEvidence,false);assert.deepEqual(context.native,c.native);assert.equal(context.nativeDirty,false);assert.equal(context.cargoLockSHA256,c.nativeCargoLockSHA256);assert.equal(context.platform,'darwin');assert.equal(context.architecture,'arm64');assert.equal(context.rustHost,'aarch64-apple-darwin');assert.equal(context.machoArch,'arm64');
 assert.ok(Array.isArray(rows)&&rows.length>0);const done=rows.filter(r=>r.reason==='build-finished');assert.equal(done.length,1);assert.equal(done[0].success,true);
 const binaries=rows.filter(r=>r.reason==='compiler-artifact'&&r.target?.name==='agent-browser'&&r.profile?.test===false);assert.equal(binaries.length,1);const b=binaries[0];assert.equal(b.fresh,false);assert.deepEqual(b.features,[]);assert.deepEqual(b.target.kind,['bin']);assert.equal(b.manifest_path,join(context.nativeRoot,'cli/Cargo.toml'));assert.equal(b.target.src_path,join(context.nativeRoot,'cli/src/main.rs'));assert.equal(b.executable,join(context.targetDir,'ci/agent-browser'));assert.equal(context.binaryRegular,true);assert.ok(Number.isSafeInteger(context.binaryBytes)&&context.binaryBytes>0);assert.match(context.binarySHA256,/^[a-f0-9]{64}$/);return b;
}
export function deriveProducer(c,context,source,compilerSHA256,env){
 assert.equal(c.acceptanceEvidence,false);assert.deepEqual(context.native,c.native);assert.equal(context.platform,'darwin');assert.equal(context.architecture,'arm64');assert.match(source.commit,/^[a-f0-9]{40}$/);assert.match(source.tree,/^[a-f0-9]{40}$/);assert.equal(source.commit,env.GITHUB_SHA);assert.match(env.GITHUB_RUN_ID,/^[1-9]\d*$/);assert.equal(env.GITHUB_RUN_ATTEMPT,'1');assert.match(compilerSHA256,/^[a-f0-9]{64}$/);assert.match(context.binarySHA256,/^[a-f0-9]{64}$/);
 return {schemaVersion:1,kind:'diagnostic-native-build-provenance',purpose:PURPOSE,acceptanceEvidence:false,releaseEligible:false,source:c.native,binary:{sha256:context.binarySHA256},producer:{repository:'levicode/e2e',platform:'darwin',architecture:'arm64',runId:env.GITHUB_RUN_ID,runAttempt:1},currentBuild:{source,compilerSHA256,cargoLockSHA256:context.cargoLockSHA256,rustHost:context.rustHost,features:[],profile:'ci',fresh:true},priorFullGate:{run:41265232081,armJob:124726559565,status:'failed',acceptanceEvidence:false,unresolved:c.unresolved},notClaimed:['full native baseline acceptance','five failing Rust tests repaired','concurrent/recovery/retired-reference safety','80ms fallback guarantee','release acceptance']};
}
export function qualify(installed,core,digest,source,native){
 assert.match(digest,/^[a-f0-9]{64}$/);assert.equal(installed.status,'passed');assert.equal(installed.manifestSha256,digest);assert.equal(installed.releaseEligible,false);assert.equal(core.status,'passed');assert.equal(core.previewCorePassed,true);for(const k of ['acceptanceEvidence','fullCandidateAccepted','releaseEligible'])assert.equal(core[k],false);assert.equal(core.manifestSha256,digest);assert.deepEqual(core.source,source);assert.deepEqual(core.nativeSource,native);assert.equal(core.platform,'darwin');assert.equal(core.architecture,'arm64');
 return {schemaVersion:1,purpose:PURPOSE,previewQualified:true,acceptanceEvidence:false,fullNativeAccepted:false,fullCandidateAccepted:false,releaseEligible:false,source,nativeSource:native,manifestSha256:digest,limits:['test-only fresh profile; no production credentials','serial core only; no concurrent/recovery/retired refs guarantees','prior full native baseline five failures remain unresolved']};
}
function main(mode){
 const c=JSON.parse(readFileSync('scripts/ci/macos-limited-preview-binding.json','utf8'));const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();const source=verifySource(c,git,p=>readFileSync(p),process.env);assert.equal(process.version,'v24.22.1');assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');const e='.artifacts/macos-limited-preview';const save=(n,v)=>writeFileSync(join(e,n),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
 if(mode==='source'){
  const ls=execFileSync('git',['ls-tree','-r','HEAD']);writeFileSync(join(e,'source.commit'),source.commit+'\n');writeFileSync(join(e,'source.tree'),source.tree+'\n');writeFileSync(join(e,'full-tree.txt'),ls);writeFileSync(join(e,'sealed-source.txt'),ls.toString().split('\n').filter(Boolean).filter(s=>!c.sourceSealExclusions.includes(s.split('\t')[1])).join('\n')+'\n');writeFileSync(join(e,'source-pins.sha256'),JSON.stringify(c.fixedInputs)+'\n');const names=ls.toString().trimEnd().split('\n').map(s=>s.split('\t')[1]);for(const [n,paths,count]of [['acceptance-files.txt',names.filter(p=>/^scripts\/acceptance\/[^/]+[.]test[.]ts$/.test(p)),32],['whole-scripts-files.txt',names.filter(p=>p.startsWith('scripts/')&&p.endsWith('.test.ts')),45]]){assert.equal(paths.length,count);writeFileSync(join(e,n),paths.sort().join('\n')+'\n');}writeFileSync(process.env.GITHUB_OUTPUT,'sha='+c.native.commit+'\n',{flag:'a'});save('source-identity.json',{source,native:c.native,purpose:PURPOSE,acceptanceEvidence:false});return;
 }
 if(mode==='seal'){
  const root=resolve('.artifacts/native-source');const ng=(...a)=>execFileSync('git',['-C',root,...a],{encoding:'utf8'}).trim();const binary=join(process.env.RUNNER_TEMP,'native-candidate-bin/production');const stat=lstatSync(binary);assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.equal(realpathSync(binary),binary);const bytes=readFileSync(binary);const compiler=readFileSync(join(e,'production-compiler.jsonl'));const rows=compiler.toString().trim().split('\n').map(s=>JSON.parse(s));const context={native:{commit:ng('rev-parse','HEAD'),tree:ng('rev-parse','HEAD^{tree}')},nativeDirty:ng('status','--porcelain')!=='',cargoLockSHA256:H(readFileSync(join(root,'cli/Cargo.lock'))),platform:process.platform,architecture:process.arch,rustHost:execFileSync('rustc',['-Vv'],{encoding:'utf8'}).match(/^host: (.+)$/m)?.[1],machoArch:execFileSync('lipo',['-archs',binary],{encoding:'utf8'}).trim(),nativeRoot:root,targetDir:process.env.CARGO_TARGET_DIR,binaryRegular:true,binaryBytes:bytes.length,binarySHA256:H(bytes)};verifyCompiler(c,rows,context);const built=readFileSync(join(context.targetDir,'ci/agent-browser'));assert.equal(H(built),H(bytes));save('fresh-build-identity.json',context);save('producer.json',deriveProducer(c,context,source,H(compiler),process.env));return;
 }
 if(mode==='qualify'){
  const read=n=>JSON.parse(readFileSync(n,'utf8'));const digest=readFileSync(join(e,'trusted-manifest-sha256.txt'),'utf8').trim();const receipt=qualify(read(join(e,'installed.result.json')),read(join(process.env.RUNNER_TEMP,'macos-preview-core-evidence/preview-core-result.json')),digest,source,c.native);save('limited-preview-qualification.json',{...receipt,priorFullGate:{run:41265232081,status:'failed',unresolved:c.unresolved}});return;
 }
 assert.fail('source, seal or qualify only');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv[2]);
