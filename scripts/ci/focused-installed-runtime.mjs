/** Diagnostic reuse of one actual focused build, never native acceptance. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyFocusedArtifact} from '../acceptance/candidate-focused-artifact.ts';
import {collectSdkObservation} from './baseline-installed-runtime.mjs';
const H=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
export function deriveFocusedProducer(c,m,proof){
 assert.equal(c.purpose,'focused-installed-diagnostic');assert.equal(c.acceptanceEvidence,false);
 assert.deepEqual(m,c.focusedManifest);assert.equal(m.kind,'focused-native-runtime');assert.equal(m.diagnosticOnly,true);assert.equal(m.releaseEligible,false);
 assert.equal(m.build.diagnosticOnly,true);assert.equal(m.build.releaseEligible,false);
 assert.deepEqual(proof,{purpose:c.purpose,acceptanceEvidence:false,recompiled:false,originalRun:c.original.run,nativeSource:m.build.source.native,originalRuntimeSource:m.build.source.e2e,focusedManifestSHA256:c.focusedManifestSHA256,compilerDigests:m.build.compiler});
 return {schemaVersion:1,kind:'diagnostic-focused-native-provenance',purpose:c.purpose,acceptanceEvidence:false,releaseEligible:false,source:{commit:m.build.source.native.commit,tree:m.build.source.native.tree},binary:{sha256:m.build.files.production.sha256},producer:{...m.build.producer,repository:'levicode/e2e'},originalRuntime:{source:m.build.source.e2e,nativeSource:m.build.source.native,manifestSHA256:c.focusedManifestSHA256,artifacts:c.original.artifacts.map(a=>({id:a.id,digest:a.digest})),compiler:m.build.compiler,toolchain:m.build.toolchain,recipe:m.build.recipe},notClaimed:['current-run compilation','full native gate acceptance','hosted contract pass','encoder gate pass','full candidate acceptance']};
}
export function verifyCurrentSource(c,git,bytes,env){
 assert.equal(c.purpose,'focused-installed-diagnostic');assert.equal(c.acceptanceEvidence,false);
 assert.equal(env.GITHUB_REF,c.exactRef);assert.equal(env.GITHUB_RUN_ATTEMPT,'1');assert.equal(env.GITHUB_REPOSITORY,'levicode/e2e');
 const source={commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}')};
 assert.match(source.commit,/^[a-f0-9]{40}$/);assert.match(source.tree,/^[a-f0-9]{40}$/);assert.equal(source.commit,env.GITHUB_SHA);assert.notEqual(source.commit,c.baseCommit,'New consumer must not impersonate historical build');assert.equal(git('rev-parse','HEAD^'),c.baseCommit);assert.equal(git('status','--porcelain'),'');
 assert.deepEqual(git('diff-tree','--no-commit-id','--name-only','-r',c.baseCommit,'HEAD').split('\n').filter(Boolean).sort(),[...c.allowedDelta].sort());
 const excluded=new Set(c.sourceSealExclusions);const seal=git('ls-tree','-r','HEAD').split('\n').filter(Boolean).filter(s=>!excluded.has(s.split('\t')[1])).join('\n')+'\n';assert.equal(H(seal),c.sourceSealSHA256,'Full source seal');
 for(const [p,h]of Object.entries(c.producer209)){assert.equal(H(bytes(p)),h,'producer209 bytes');assert.equal(H(Buffer.from(git('show',`HEAD:${p}`),'binary')),h,'producer209 committed bytes');}
 for(const [p,h]of Object.entries(c.fixedInputs))assert.equal(H(bytes(p)),h,'Fixed lock/native input');
 return source;
}
function main(mode){
 const c=read('scripts/ci/focused-installed-binding.json');const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
 // Byte verification uses git-show buffers, not text normalization.
 const source=verifyCurrentSource(c,(...args)=>args[0]==='show'?execFileSync('git',args).toString('binary'):git(...args),p=>readFileSync(p),process.env);
 assert.equal(process.version,'v24.22.1');
 if(mode==='source'){
  const out='.artifacts/focused-installed-diagnostic',ls=execFileSync('git',['ls-tree','-r','HEAD']),names=ls.toString().trimEnd().split('\n').map(x=>x.split('\t')[1]);
  writeFileSync(join(out,'source.commit'),source.commit+'\n',{flag:'wx'});writeFileSync(join(out,'source.tree'),source.tree+'\n',{flag:'wx'});writeFileSync(join(out,'full-tree.txt'),ls,{flag:'wx'});
  writeFileSync(join(out,'sealed-source.txt'),ls.toString().split('\n').filter(Boolean).filter(x=>!c.sourceSealExclusions.includes(x.split('\t')[1])).join('\n')+'\n',{flag:'wx'});
  writeFileSync(join(out,'source-pins.sha256'),JSON.stringify(c.fixedInputs)+'\n',{flag:'wx'});
  const acceptance=names.filter(p=>/^scripts\/acceptance\/[^/]+[.]test[.]ts$/.test(p)),scripts=names.filter(p=>p.startsWith('scripts/')&&p.endsWith('.test.ts'));
  assert.equal(acceptance.length,32);assert.equal(scripts.length,45);
  for(const [n,v]of [['acceptance-files.txt',acceptance],['whole-scripts-files.txt',scripts]])writeFileSync(join(out,n),v.sort().join('\n')+'\n',{flag:'wx'});
  return;
 }
 const dir=resolve(process.env.RUNNER_TEMP,'focused-installed-runtime');verifyFocusedArtifact(dir,c.focusedManifest,c.focusedManifestSHA256);
 const m=read(join(dir,'manifest.json')),e='.artifacts/focused-installed-diagnostic';
 const producer=deriveFocusedProducer(c,m,read(join(e,'restored-focused-proof.json')));
 for(const [kind,n]of [['production','production-compiler.jsonl'],['default','compiler.jsonl']]){const b=readFileSync(join(e,n));assert.deepEqual({sha256:H(b),bytes:b.length},m.build.compiler[kind]);}
 if(mode==='bind'){
  writeFileSync(join(e,'diagnostic-producer.json'),JSON.stringify(producer,null,2)+'\n',{flag:'wx'});
  writeFileSync(join(e,'current-js-source.json'),JSON.stringify({source,originalRuntimeSource:m.build.source.e2e,nativeSource:producer.source,purpose:c.purpose,acceptanceEvidence:false},null,2)+'\n',{flag:'wx'});
 }else if(mode==='collect'){
  assert.deepEqual(read(join(e,'current-js-source.json')).source,source);const installed=read(join(e,'installed.result.json'));const peer=join(e,'installed-sdk-prerequisite.json'),log=join(e,'installed-consumer.log');
  const observation=collectSdkObservation(installed,existsSync(peer)?read(peer):undefined,existsSync(log)?readFileSync(log,'utf8'):undefined);const code=Number(readFileSync(join(e,'installed-command.exit'),'utf8').trim());assert.ok(Number.isInteger(code)&&code>=0&&code<=255);assert.equal(code===0,installed.status==='passed');
  writeFileSync(join(e,'focused-installed-diagnostic.json'),JSON.stringify({purpose:c.purpose,acceptanceEvidence:false,source,nativeSource:producer.source,originalRuntime:producer.originalRuntime,binarySHA256:producer.binary.sha256,originalInstalledExit:code,installedStatus:installed.status,...observation,fullNativeAccepted:false,fullCandidateAccepted:false,releaseEligible:false},null,2)+'\n',{flag:'wx'});
 }else assert.fail('source, bind or collect only');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){assert.equal(process.argv.length,3);main(process.argv[2]);}
