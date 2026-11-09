/** Explicit source setup: build current JS and pinned native source; never download an old runtime bundle. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,existsSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join,relative,isAbsolute,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
export const NATIVE=Object.freeze({commit:'1da1180ed38605ab427dc0586f7973232c2aee69',tree:'cedaae2898f85d0b87f4e26e262989081ed3dc12'});
export const LOCK='5aa88b1ba882a33ccbfebe9bac5ef2c3b856130de6b684737c7060a80e4020a0';
const hash=b=>createHash('sha256').update(b).digest('hex');
export function outside(root,p){const r=relative(root,p);return r==='..'||r.startsWith('../')||isAbsolute(r);}
export function checkSource(git,expected){const source={commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}')};assert.match(source.commit,/^[a-f0-9]{40}$/);assert.match(source.tree,/^[a-f0-9]{40}$/);assert.equal(git('status','--porcelain'),'');if(expected)assert.deepEqual(source,expected);return source;}
export function selectProduction(rows,root,target){assert.ok(Array.isArray(rows));const end=rows.filter(x=>x.reason==='build-finished');assert.equal(end.length,1);assert.equal(end[0].success,true);const all=rows.filter(x=>x.reason==='compiler-artifact'&&x.target?.name==='agent-browser'&&x.profile?.test===false);assert.equal(all.length,1);const b=all[0];assert.equal(b.fresh,false);assert.deepEqual(b.features,[]);assert.deepEqual(b.target.kind,['bin']);assert.equal(b.manifest_path,join(root,'cli/Cargo.toml'));assert.equal(b.target.src_path,join(root,'cli/src/main.rs'));assert.equal(b.executable,join(target,'ci/agent-browser'));return b;}
export function verifyBinary(bytes,platform,architecture){
 assert.ok(Buffer.isBuffer(bytes)&&bytes.length>=20);assert.ok(['x64','arm64'].includes(architecture));
 if(platform==='linux'){assert.equal(bytes.subarray(0,4).toString('hex'),'7f454c46');assert.equal(bytes[4],2);assert.equal(bytes[5],1);assert.equal(bytes.readUInt16LE(18),architecture==='x64'?62:183);}
 else {assert.equal(platform,'darwin');assert.equal(bytes.readUInt32LE(0),0xfeedfacf);assert.equal(bytes.readUInt32LE(4),architecture==='x64'?0x01000007:0x0100000c);}
}
export function cleanEnvironment(input){const e={...input};for(const k of Object.keys(e))if(/^(E2E_|AGENT_BROWSER|AI_GATEWAY|OPENAI|ANTHROPIC)/.test(k)||['NATIVE_PROCESS_MODULE','NODE_PATH','NODE_OPTIONS','GH_TOKEN','GITHUB_TOKEN','ACTIONS_RUNTIME_TOKEN','RUSTC_WRAPPER','RUSTC_WORKSPACE_WRAPPER','RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS','CARGO_TARGET_DIR'].includes(k))delete e[k];return {...e,E2E_TELEMETRY_DISABLED:'1',E2E_UPDATE_CHECK_DISABLED:'1'};}
export function prepareDirectories(checkout,work,project){
 assert.ok(outside(checkout,work)&&outside(checkout,project)&&outside(work,project)&&outside(project,work),'Fresh work/project must be separate and outside checkout');
 for(const p of [work,project]){assert.ok(!existsSync(p),'Never overwrite a work directory or project');assert.equal(realpathSync(dirname(p)),dirname(p),'Canonical existing parent required');}
 mkdirSync(work,{mode:0o700});mkdirSync(project,{mode:0o700});
 const identity=p=>{const s=lstatSync(p);assert.ok(s.isDirectory()&&!s.isSymbolicLink());assert.equal(realpathSync(p),p);assert.equal(s.uid,process.getuid());assert.equal(s.mode&0o777,0o700);return {dev:s.dev,ino:s.ino};};
 const before=[identity(work),identity(project)];return ()=>assert.deepEqual([identity(work),identity(project)],before,'Owned output directory replaced');
}
export function executeLogged(work,records,label,cmd,args,cwd,env){const out=join(work,label+'.stdout.log'),err=join(work,label+'.stderr.log'),o=openSync(out,'wx'),e=openSync(err,'wx');let r;try{r=spawnSync(cmd,args,{cwd,env,stdio:['ignore',o,e],shell:false});}finally{closeSync(o);closeSync(e);}const row={label,command:[cmd,...args],exitCode:r.status,signal:r.signal,error:r.error?'spawn-error':null,stdoutSHA256:hash(readFileSync(out)),stderrSHA256:hash(readFileSync(err))};records.push(row);writeFileSync(join(work,'commands.json'),JSON.stringify(records,null,2)+'\n');assert.equal(r.error,undefined,label+' spawn');assert.equal(r.signal,null,label+' signal');assert.equal(r.status,0,label+' failed; inspect '+err);return readFileSync(out,'utf8');}
export async function setup(workArg,projectArg){
 assert.equal(process.version,'v24.22.1');assert.ok(['linux','darwin'].includes(process.platform));assert.ok(['x64','arm64'].includes(process.arch));
 const checkout=realpathSync(resolve(import.meta.dirname,'..')),work=resolve(workArg),project=resolve(projectArg);
 const git=(...a)=>execFileSync('git',a,{cwd:checkout,encoding:'utf8'}).trim();const source=checkSource(git);const checkDirectories=prepareDirectories(checkout,work,project);
 const save=(name,value)=>writeFileSync(join(work,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});save('source.json',{source,native:NATIVE,acceptanceEvidence:false});
 const baseEnv=cleanEnvironment(process.env),records=[];
 function run(label,cmd,args,cwd=checkout,extra={}){checkDirectories();return executeLogged(work,records,label,cmd,args,cwd,{...baseEnv,...extra});}
 try{
  assert.equal(run('pnpm-version','pnpm',['--version']).trim(),'12.3.4');
  run('dependencies','pnpm',['install','--frozen-lockfile']);run('js-build','pnpm',['run','build']);checkSource(git,source);
  const root=join(work,'native-source'),target=join(work,'native-target');mkdirSync(root);run('native-init','git',['init','--quiet'],root);run('native-fetch','git',['fetch','--depth=1','https://github.com/levicode/agent-browser.git',NATIVE.commit],root);run('native-checkout','git',['checkout','--detach','FETCH_HEAD'],root);
  const ng=(...a)=>execFileSync('git',a,{cwd:root,encoding:'utf8'}).trim();assert.deepEqual(checkSource(ng),NATIVE);assert.equal(hash(readFileSync(join(root,'cli/Cargo.lock'))),LOCK);
  const rust=run('rustc','rustc',['-Vv']);const host=rust.match(/^host: (.+)$/m)?.[1];assert.equal(host,({linux:{x64:'x86_64-unknown-linux-gnu',arm64:'aarch64-unknown-linux-gnu'},darwin:{x64:'x86_64-apple-darwin',arm64:'aarch64-apple-darwin'}})[process.platform][process.arch]);
  const compiler=run('production-compiler','cargo',['build','--locked','--profile','ci','--no-default-features','--message-format=json'],join(root,'cli'),{CARGO_TARGET_DIR:target,CARGO_BUILD_JOBS:'1'});
  const selected=selectProduction(compiler.trim().split('\n').map(s=>JSON.parse(s)),root,target),binary=selected.executable;const st=lstatSync(binary);assert.ok(st.isFile()&&!st.isSymbolicLink()&&st.size>0);assert.equal(realpathSync(binary),binary);assert.deepEqual(checkSource(ng),NATIVE);checkSource(git,source);
  verifyBinary(readFileSync(binary),process.platform,process.arch);
  const producer={schemaVersion:1,kind:'source-native-build-provenance',acceptanceEvidence:false,releaseEligible:false,source:NATIVE,binary:{sha256:hash(readFileSync(binary))},producer:{repository:'levicode/e2e',platform:process.platform,architecture:process.arch},currentBuild:{source,compilerSHA256:hash(readFileSync(join(work,'production-compiler.stdout.log'))),cargoLockSHA256:LOCK,rustHost:host,features:[],profile:'ci',fresh:true}};save('producer.json',producer);
  // Explicit source bootstrap uses only the just-compiled executable. Installed consumer below uses descriptor, never this override.
  run('bootstrap-chromium',process.execPath,['packages/web/dist/bin.js','install','chromium',...(process.platform==='linux'?['--with-deps']:[])],checkout,{E2E_AGENT_BROWSER_EXECUTABLE:binary});
  const chrome=run('chromium-identity',process.execPath,['scripts/acceptance/installed-chromium.ts',join(baseEnv.HOME,'.agent-browser/browsers'),join(work,'chromium.json')]).trim();assert.ok(isAbsolute(chrome));
  run('capabilities',process.execPath,['--input-type=module','-e',"import {REQUIRED_CAPABILITIES} from './packages/web/dist/native/capabilities.js'; console.log(JSON.stringify(REQUIRED_CAPABILITIES))"]);
  run('live-probe',process.execPath,['scripts/acceptance/probe-native.ts',binary,join(work,'capabilities.stdout.log'),join(work,'negotiation.json')],checkout,{E2E_CHROMIUM_EXECUTABLE:chrome});
  const bundle=join(work,'bundle');run('fresh-package',process.execPath,['scripts/acceptance/package-bundle.ts',binary,join(work,'producer.json'),join(work,'negotiation.json'),bundle]);
  const manifestBytes=readFileSync(join(bundle,'manifest.json')),digest=hash(manifestBytes),manifest=JSON.parse(manifestBytes);assert.deepEqual(manifest.source,source);assert.deepEqual(manifest.nativeSource,NATIVE);assert.equal(manifest.native.sha256,producer.binary.sha256);save('trusted-manifest.json',{sha256:digest,source,native:NATIVE,origin:'This invocation freshly built JS and native; not a historical artifact'});
  writeFileSync(join(project,'package.json'),JSON.stringify({name:'e2e-source-project',private:true,type:'module',dependencies:{ai:'7.0.153'}})+'\n',{flag:'wx'});
  run('public-install',process.execPath,[join(bundle,'install.mjs'),bundle,digest,project]);run('public-chromium','pnpm',['exec','e2e-web','install','chromium',...(process.platform==='linux'?['--with-deps']:[])],project);
  run('public-cli-help','pnpm',['exec','e2e','--help'],project);
  checkDirectories();checkSource(git,source);save('setup-result.json',{status:'passed',source,native:NATIVE,binarySHA256:producer.binary.sha256,bundle,manifestSHA256:digest,project,acceptanceEvidence:false,fullCandidateAccepted:false});
  console.log('Source setup ready. Project: '+project+'\nRun public CLI from that directory: pnpm exec e2e --help');
 }catch(error){save('setup-failure.json',{status:'failed',source,native:NATIVE,lastStage:records.at(-1)?.label??null,acceptanceEvidence:false});throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){assert.equal(process.argv.length,4,'Usage: node scripts/setup-source-native.mjs NEW_WORK_DIRECTORY NEW_PROJECT_DIRECTORY');await setup(process.argv[2],process.argv[3]);}
