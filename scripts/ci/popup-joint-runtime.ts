/** Dedicated, same-source verified fault runtime diagnostic; never normal spec's production selection. */
import assert from 'node:assert/strict';
import { spawnSync, execFileSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, constants, accessSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installedChromium } from '../acceptance/installed-chromium.ts';
import { verifyFixtureRuntimeArtifacts } from './spec-fixture-runtime.ts';
import { expectation } from './native-runtime.ts';
import { POPUP_JOINT_CASE_ENTRY } from './popup-joint-case.ts';
import { verifyCandidateRuntime } from '../acceptance/candidate-web.ts';
import { REQUIRED_CAPABILITIES } from '../../packages/web/src/native/capabilities.ts';
import { SEMANTIC_FAULT_CAPABILITY } from '../../packages/web/tests/helpers/semantic-fault-runtime.ts';

const hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
export function cleanJointEnvironment(input:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(input).filter(([key])=>!key.startsWith('E2E_')&&!key.startsWith('AGENT_BROWSER_')&&!/^(?:PLAYWRIGHT_|npm_config_playwright_|npm_package_config_playwright_)/i.test(key)&&!key.startsWith('PYTHON')&&!/proxy|token|secret|password|credential|api.?key/i.test(key)&&!['NODE_OPTIONS','NATIVE_PROCESS_MODULE','PYTHONPATH','PYTHONHOME','LD_PRELOAD','DYLD_INSERT_LIBRARIES'].includes(key)));
}
export function socketBudget(env:NodeJS.ProcessEnv):number {
  assert.ok(env['HOME']);const base=env['XDG_RUNTIME_DIR']?path.join(env['XDG_RUNTIME_DIR'],'agent-browser'):path.join(env['HOME'],'.agent-browser');
  const bytes=Buffer.byteLength(path.join(base,'e2e-00000000-0000-0000-0000-000000000000.sock'));assert.ok(bytes<=103,'Default native socket path budget');return bytes;
}
export function owned(file:string,directory=false):string {
  assert.ok(path.isAbsolute(file));assert.equal(realpathSync(file),file);const st=lstatSync(file);assert.equal(st.uid,process.getuid?.());assert.equal(st.mode&0o022,0);assert.ok(directory?st.isDirectory():st.isFile());assert.ok(!st.isSymbolicLink());if(!directory)assert.equal(st.nlink,1);return file;
}
export async function installedChromiumPath(input:NodeJS.ProcessEnv, discover:typeof installedChromium=installedChromium):Promise<string> {
  const env=cleanJointEnvironment(input);assert.ok(env['HOME'],'Owned installer HOME required');
  const home=owned(env['HOME'],true);const cache=owned(path.join(home,'.agent-browser/browsers'),true);
  const found=await discover(cache);const chrome=owned(found.executablePath);
  const relative=path.relative(cache,chrome);assert.ok(relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative),'Installed Chromium escapes native cache');
  accessSync(chrome,constants.X_OK);assert.equal(hash(chrome),found.sha256,'Installed Chromium hash changed');return chrome;
}
export function installVerifiedProduction(verify:()=>{binary:string}, source:string, root:string, input:NodeJS.ProcessEnv, run:(command:string,args:string[],options:SpawnSyncOptionsWithStringEncoding)=>SpawnSyncReturns<string>=spawnSync):void {
  const {binary}=verify(); // A mismatched producer/role/source must fail before executing the installer.
  const env={...cleanJointEnvironment(input),E2E_AGENT_BROWSER_EXECUTABLE:binary,E2E_TELEMETRY_DISABLED:'1'};
  const p=run(process.execPath,['packages/web/dist/bin.js','install','chromium','--with-deps'],{cwd:source,env,encoding:'utf8',timeout:600000,maxBuffer:8*1024*1024});
  writeFileSync(path.join(root,'install.stdout'),p.stdout??'',{flag:'wx',mode:0o600});
  writeFileSync(path.join(root,'install.stderr'),p.stderr??'',{flag:'wx',mode:0o600});
  writeFileSync(path.join(root,'evidence/install.json'),JSON.stringify({kind:'public-chromium-install',acceptanceEvidence:false,productionBinarySHA256:hash(binary),exit:p.status,signal:p.signal,error:p.error?'spawn-or-timeout':null,stdoutSHA256:hash(path.join(root,'install.stdout')),stderrSHA256:hash(path.join(root,'install.stderr'))},null,2)+'\n',{flag:'wx',mode:0o600});
  assert.equal(p.status,0,'Verified production public Chromium install failed');assert.equal(p.signal,null);assert.equal(p.error,undefined);
}
async function main(args:string[]):Promise<void> {
  assert.equal(args.length,7);const [prod,prodSHA,prodAttempt,fault,faultSHA,faultAttempt,output]=args as [string,string,string,string,string,string,string];
  const root=owned(output,true);owned(path.join(root,'evidence'),true);
  const source=process.cwd();assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),'','Dirty diagnostic source');const binding=JSON.parse(readFileSync('scripts/ci/popup-joint-binding.json','utf8'));
  assert.ok(binding.native,'Unbound published native');
  const production={directory:realpathSync(prod),manifestSha256:prodSHA,expected:expectation(source,prodAttempt)};
  const fixture={directory:realpathSync(fault),manifestSha256:faultSHA,expected:expectation(source,faultAttempt)};
  const pair=verifyFixtureRuntimeArtifacts(production,fixture);chmodSync(pair.binary,0o755);chmodSync(pair.faultBinary,0o755);
  const manifest=JSON.parse(readFileSync(path.join(production.directory,'manifest.json'),'utf8'));
  assert.deepEqual(manifest.nativeSource,binding.native);
  for(const [file,digest] of Object.entries(binding.sourceHashes))assert.equal(hash(file),digest,'Changed diagnostic source');
  const script=owned(realpathSync('scripts/ci/popup-passive-joint-relay.py'));
  assert.equal(hash(script),'e928c2161272a1f89f4c11ee4b0d70e3a2a0eb0b70dc1776f59894adbb31c8cd');
  const python=owned(path.join(root,'venv/bin/python3'));accessSync(python,constants.X_OK);assert.ok(python.startsWith(owned(path.join(root,'venv'),true)+path.sep));
  const pythonProof=JSON.parse(readFileSync(path.join(root,'python.json'),'utf8'));
  assert.equal(pythonProof.version,'3.12.9');assert.equal(pythonProof.websockets,'15.0.1');assert.equal(pythonProof.wheelSHA256,binding.wheelSHA256);assert.ok(pythonProof.module.startsWith(path.join(root,'venv')+path.sep));assert.equal(hash(python),pythonProof.pythonSHA256);
  installVerifiedProduction(()=>verifyFixtureRuntimeArtifacts(production,fixture),source,root,process.env);
  const chrome=await installedChromiumPath(process.env);
  const env:NodeJS.ProcessEnv={...cleanJointEnvironment(process.env),E2E_CHROMIUM_EXECUTABLE:chrome,E2E_TELEMETRY_DISABLED:'1'};
  owned(env['XDG_RUNTIME_DIR']||env['HOME']!,true);const socketPathBytes=socketBudget(env);
  const result:{kind:string;acceptanceEvidence:false;status:string;command:unknown;probes:unknown[];postIdentity:boolean;metadata:string}={kind:'managed-popup-joint',acceptanceEvidence:false,status:'incomplete',command:null,probes:[],postIdentity:false,metadata:'incomplete'};
  const plan={...result,socketPathBytes,source:production.expected.source,native:manifest.nativeSource,production:{binarySha256:pair.binarySha256,manifestSha256:prodSHA,compilerSha256:manifest.compilerSha256,features:[]},fault:{binarySha256:pair.faultBinarySha256,manifestSha256:faultSHA,compilerSha256:JSON.parse(readFileSync(path.join(fixture.directory,'manifest.json'),'utf8')).compilerSha256,features:['acceptance-faults']},sourceHashes:binding.sourceHashes,python:{version:pythonProof.version,websockets:pythonProof.websockets,wheelSHA256:binding.wheelSHA256,pythonSHA256:pythonProof.pythonSHA256},chromeSHA256:hash(chrome),selection:'popup first inline sees each init once and reload starts a fresh document',retries:0,workers:1};
  writeFileSync(path.join(root,'evidence/plan.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
  let failed=true;
  try {
    for(const role of ['production','fault'] as const){
      const binary=role==='production'?pair.binary:pair.faultBinary;const caps=path.join(root,role+'-capabilities.json');const proof=path.join(root,'evidence',role+'-probe.json');
      writeFileSync(caps,JSON.stringify([...REQUIRED_CAPABILITIES,...(role==='fault'?[SEMANTIC_FAULT_CAPABILITY]:[])]),{flag:'wx',mode:0o600});
      const p=spawnSync(process.execPath,['scripts/acceptance/probe-native.ts',binary,caps,proof],{env,cwd:source,timeout:120000,encoding:'utf8'});
      result.probes.push({role,exit:p.status,signal:p.signal,error:p.error?'spawn-or-timeout':null});
      assert.equal(p.status,0,role+' pre-relay probe failed');assert.equal(p.signal,null);verifyCandidateRuntime(JSON.parse(readFileSync(proof,'utf8')),hash(binary),role==='fault');
    }
    const hook={AGENT_BROWSER_ACCEPTANCE_POPUP_RELAY_SCRIPT:script,AGENT_BROWSER_ACCEPTANCE_POPUP_RELAY_SCRIPT_SHA256:hash(script),AGENT_BROWSER_ACCEPTANCE_POPUP_RELAY_PYTHON:python,AGENT_BROWSER_ACCEPTANCE_POPUP_RELAY_EVIDENCE:path.join(root,'joint.jsonl')};
    const p=spawnSync(process.execPath,[POPUP_JOINT_CASE_ENTRY,path.join(root,'evidence')],{cwd:source,env:{...env,...hook,E2E_AGENT_BROWSER_EXECUTABLE:pair.faultBinary,E2E_POPUP_DOCUMENT_DIAGNOSTIC:'1'},timeout:180000,encoding:'utf8',maxBuffer:8*1024*1024});
    // Raw process streams remain private; no proxy endpoints, args or environment are archived.
    writeFileSync(path.join(root,'case.stdout'),p.stdout??'',{flag:'wx',mode:0o600});writeFileSync(path.join(root,'case.stderr'),p.stderr??'',{flag:'wx',mode:0o600});
    result.command={exit:p.status,signal:p.signal,error:p.error?'spawn-or-timeout':null,stdoutSHA256:hash(path.join(root,'case.stdout')),stderrSHA256:hash(path.join(root,'case.stderr'))};
    const capture=spawnSync(python,['-I','scripts/ci/popup-joint-evidence.py',root],{cwd:source,env,encoding:'utf8',timeout:10000});result.metadata=capture.status===0?'complete':'incomplete';
    const caseResult=JSON.parse(readFileSync(path.join(root,'evidence/case.json'),'utf8'));
    failed=p.status!==0||p.signal!==null||!!p.error||caseResult.status!=='passed'||caseResult.cleanup!=='complete'||result.metadata!=='complete';
  } catch {failed=true;} finally {
    try {result.postIdentity=JSON.stringify(verifyFixtureRuntimeArtifacts(production,fixture))===JSON.stringify(pair)&&execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()==='';}catch{result.postIdentity=false;}
    failed ||= !result.postIdentity;result.status=failed?'failed':'passed';writeFileSync(path.join(root,'evidence/result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  process.exitCode=failed?1:0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main(process.argv.slice(2));
