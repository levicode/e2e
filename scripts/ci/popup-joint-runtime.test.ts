import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, chmodSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installedChromiumPath, installVerifiedProduction, cleanJointEnvironment, owned, socketBudget } from './popup-joint-runtime.ts';
test('dedicated child removes inherited hook, credential and native/browser overrides',()=>{
 const env=cleanJointEnvironment({PATH:'/usr/bin',GITHUB_SHA:'a'.repeat(40),GITHUB_TOKEN:'secret',HTTPS_PROXY:'bad',E2E_AGENT_BROWSER_EXECUTABLE:'old',AGENT_BROWSER_ACCEPTANCE_POPUP_RELAY_SCRIPT:'bad',NATIVE_PROCESS_MODULE:'bad',PLAYWRIGHT_BROWSERS_PATH:'bad',NODE_OPTIONS:'bad',PYTHONOPTIMIZE:'2',PYTHONPATH:'untrusted'});
 assert.deepEqual(env,{PATH:'/usr/bin',GITHUB_SHA:'a'.repeat(40)});
});
test('owned regular paths reject relative, symlink and writable source',()=>{
 const root=mkdtempSync(path.join(realpathSync(os.tmpdir()),'joint-pure-'));
 try {mkdirSync(path.join(root,'dir'),{mode:0o700});const file=path.join(root,'file');writeFileSync(file,'x',{mode:0o600});assert.equal(owned(file),file);assert.equal(owned(path.join(root,'dir'),true),path.join(root,'dir'));symlinkSync(file,path.join(root,'link'));assert.throws(()=>owned(path.join(root,'link')));assert.throws(()=>owned('relative'));const bad=path.join(root,'writable');writeFileSync(bad,'x',{mode:0o666}); chmodSync(bad,0o666);assert.throws(()=>owned(bad));
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('native default HOME and XDG socket paths enforce real103byte budget without override',()=>{assert.ok(socketBudget({HOME:'/tmp/pj-abc/home'})<=103);assert.ok(socketBudget({HOME:'/tmp/pj-abc/home',XDG_RUNTIME_DIR:'/tmp/xdg'})<=103);assert.throws(()=>socketBudget({HOME:'/tmp/'+ 'x'.repeat(100)}));assert.throws(()=>socketBudget({HOME:'/tmp/h',XDG_RUNTIME_DIR:'/tmp/'+ 'x'.repeat(100)}));});

test('verified production install is ordered before probes and never inherits relay or fault selection',()=>{
 const root=mkdtempSync(path.join(realpathSync(os.tmpdir()),'install-pure-'));
 try {
  mkdirSync(path.join(root,'evidence'));const binary=path.join(root,'production');writeFileSync(binary,'synthetic-not-executed');let verified=false;let calls=0;
  const run=((command:string,args:string[],options:{env:NodeJS.ProcessEnv})=>{assert.ok(verified);calls++;assert.equal(command,process.execPath);assert.deepEqual(args,['packages/web/dist/bin.js','install','chromium','--with-deps']);assert.equal(options.env['E2E_AGENT_BROWSER_EXECUTABLE'],binary);assert.ok(!Object.keys(options.env).some(k=>k.startsWith('AGENT_BROWSER_')));assert.equal(options.env['PLAYWRIGHT_BROWSERS_PATH'],undefined);return {status:0,signal:null,stdout:'fixture install only',stderr:'',pid:1,output:[]};}) as NonNullable<Parameters<typeof installVerifiedProduction>[4]>;
  installVerifiedProduction(()=>{verified=true;return {binary};},root,root,{E2E_AGENT_BROWSER_EXECUTABLE:'/unverified-fault',AGENT_BROWSER_ACCEPTANCE_POPUP_RELAY_SCRIPT:'secret',PLAYWRIGHT_BROWSERS_PATH:'old'},run);assert.equal(calls,1);
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('identity failure never installs; failed installation retains exit and cannot reach subsequent probe/case',()=>{
 let installs=0;let probes=0;
 assert.throws(()=>{installVerifiedProduction(()=>{throw Error('native/source identity mismatch');},'/unused','/unused',{},(()=>{installs++;throw Error('must not execute');}) as NonNullable<Parameters<typeof installVerifiedProduction>[4]>);probes++;},/identity mismatch/);assert.equal(installs,0);assert.equal(probes,0);
 const root=mkdtempSync(path.join(realpathSync(os.tmpdir()),'install-fail-pure-'));
 try {mkdirSync(path.join(root,'evidence'));const binary=path.join(root,'production');writeFileSync(binary,'synthetic-not-executed');
  assert.throws(()=>{installVerifiedProduction(()=>({binary}),root,root,{},(()=>({status:17,signal:null,stdout:'fixed failure',stderr:'fixed stderr',pid:1,output:[]})) as NonNullable<Parameters<typeof installVerifiedProduction>[4]>);probes++;},/install failed/);
  assert.equal(probes,0);assert.equal(JSON.parse(readFileSync(path.join(root,'evidence/install.json'),'utf8')).exit,17);
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('workflow downloads both artifacts before the verified runtime and has no premature public installer',()=>{
 const spec=readFileSync(new URL('../../.github/workflows/spec.yml',import.meta.url),'utf8');const body=spec.split('  popup-joint:\n')[1]!.split('  native-targeted:\n')[0]!;
 assert.equal((body.match(/uses: actions\/download-artifact@/g)??[]).length,2);assert.ok(body.lastIndexOf('uses: actions/download-artifact@')<body.indexOf('node scripts/ci/popup-joint-runtime.ts'));assert.ok(!body.includes('node packages/web/dist/bin.js install'));
 const source=readFileSync(new URL('./popup-joint-runtime.ts',import.meta.url),'utf8');assert.ok(source.indexOf('installVerifiedProduction(()=>verifyFixtureRuntimeArtifacts')<source.indexOf("for(const role of ['production','fault']"));
});

test('Chrome resolver uses the same clean cache environment as install, including npm fallback names',()=>{
 const input={HOME:'/owned/home',PLAYWRIGHT_BROWSERS_PATH:'/wrong',npm_config_playwright_browsers_path:'/wrong2',npm_package_config_playwright_browsers_path:'/wrong3',AGENT_BROWSER_ACCEPTANCE_POPUP_RELAY_SCRIPT:'forbidden'};
 assert.equal(installedChromiumPath('/source',input,(_command,_args,options)=>{assert.deepEqual(options.env,{HOME:'/owned/home'});assert.equal(options.cwd,'/source');return '/owned/home/chrome';}),'/owned/home/chrome');
 for(const value of ['relative','/chrome\nforged'])assert.throws(()=>installedChromiumPath('/source',input,()=>value));
 assert.deepEqual(cleanJointEnvironment(input),{HOME:'/owned/home'});
});
