import assert from 'node:assert/strict';
import {readFileSync,readdirSync,lstatSync,chmodSync,appendFileSync,copyFileSync,writeFileSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyArtifact} from '../../scripts/ci/native-runtime.ts';
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
function verifyCompilerPin(dir:string,p:any,m:any,fault:boolean) {
 const c=p.compiler;assert.equal(m.compilerSha256,c.compilerSHA256);assert.equal(m.rustcSha256,c.rustcSHA256);
 assert.equal(readFileSync(join(dir,'rustc.txt'),'utf8').split('\n')[0],c.rustcVersion);
 for(const k of ['manifestPath','sourcePath','executable'])assert.equal(m.compilation[k],c[k]);
 assert.ok(c.manifestPath.endsWith('/cli/Cargo.toml'));assert.equal(c.sourcePath,c.manifestPath.replace(/Cargo\.toml$/,'src/main.rs'));assert.ok(c.executable.endsWith('/ci/agent-browser'));
 assert.deepEqual(c.command,['cargo','build','--locked','--profile','ci','--no-default-features',...(fault?['--features','acceptance-faults']:[]),'--message-format=json']);
}
const pins=JSON.parse(readFileSync('scripts/ci/full-standard-runtime-pins.json','utf8'));
assert.equal(pins.configured,true);const current=JSON.parse(readFileSync('.github/native-candidate.json','utf8'));
assert.deepEqual(pins.ordinary.nativeSource,pins.fault.nativeSource);assert.equal(current.commit,pins.ordinary.nativeSource.commit);
const ordinaryDir=join(process.env.RUNNER_TEMP!,'ci-native-ordinary');const op=pins.ordinary;
assert.equal(op.expected.platform,process.platform);assert.equal(op.expected.architecture,process.arch);
const ordinary=verifyArtifact(ordinaryDir,op.manifestSha256,op.expected);const om=JSON.parse(readFileSync(join(ordinaryDir,'manifest.json'),'utf8'));
verifyCompilerPin(ordinaryDir,op,om,false);assert.deepEqual(om.nativeSource,op.nativeSource);assert.equal(hash(ordinary),op.binarySha256);chmodSync(ordinary,0o755);
appendFileSync(process.env.GITHUB_ENV!,`E2E_AGENT_BROWSER_EXECUTABLE=${ordinary}\n`);
copyFileSync(join(ordinaryDir,'manifest.json'),'evidence/ordinary.manifest.json');
if(process.env['NEED_FAULT']==='1') {
 const p=pins.fault;assert.equal(p.testOnly,true);const dir=join(process.env.RUNNER_TEMP!,'ci-native-fault');
 const files=['agent-browser','compiler.jsonl','manifest.json','rustc.txt'].sort();assert.deepEqual(readdirSync(dir).sort(),files);
 for(const f of files)assert.ok(lstatSync(join(dir,f)).isFile());assert.equal(hash(join(dir,'manifest.json')),p.manifestSha256);
 const m=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));assert.equal(m.schemaVersion,1);assert.equal(m.kind,'source-built-ci-runtime');assert.equal(m.acceptanceEvidence,false);
 for(const [k,v] of Object.entries(p.expected))if(k!=='nativeCommit')assert.deepEqual(m[k],v);
 assert.equal(m.platform,process.platform);assert.equal(m.architecture,process.arch);assert.equal(m.nativeRepository,'levicode/agent-browser');assert.deepEqual(m.nativeSource,p.nativeSource);assert.equal(m.nativeSource.commit,p.expected.nativeCommit);
 verifyCompilerPin(dir,p,m,true);assert.equal(m.compilation.profile,'ci');assert.deepEqual(m.compilation.features,['acceptance-faults']);for(const k of ['manifestPath','sourcePath','executable'])assert.ok(isAbsolute(m.compilation[k]));
 for(const [f,k] of [['agent-browser','binarySha256'],['compiler.jsonl','compilerSha256'],['rustc.txt','rustcSha256']])assert.equal(hash(join(dir,f!)),m[k!]);assert.equal(m.binarySha256,p.binarySha256);assert.notEqual(m.binarySha256,op.binarySha256);
 const rows=readFileSync(join(dir,'compiler.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));const done=rows.filter(x=>x.reason==='build-finished');assert.equal(done.length,1);assert.equal(done[0].success,true);
 const binaries=rows.filter(x=>x.reason==='compiler-artifact'&&x.target?.name==='agent-browser'&&x.profile?.test===false);assert.equal(binaries.length,1);const b=binaries[0];assert.deepEqual(b.features,['acceptance-faults']);assert.deepEqual(b.target.kind,['bin']);assert.equal(b.manifest_path,m.compilation.manifestPath);assert.equal(b.target.src_path,m.compilation.sourcePath);assert.equal(b.executable,m.compilation.executable);
 const fault=resolve(dir,'agent-browser');chmodSync(fault,0o755);appendFileSync(process.env.GITHUB_ENV!,`FULL_NODE_FAULT_EXECUTABLE=${fault}\n`);copyFileSync(join(dir,'manifest.json'),'evidence/fault.manifest.json');
}

