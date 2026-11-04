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

test('native public installer layout wins over XDG and Playwright caches',async()=>{
 const root=mkdtempSync(path.join(realpathSync(os.tmpdir()),'native-chrome-'));
 try {
  const home=path.join(root,'home');const native=path.join(home,'.agent-browser/browsers/chrome-156.0.8078.4/chrome-linux64');mkdirSync(native,{recursive:true,mode:0o700});const executable=path.join(native,'chrome');writeFileSync(executable,'synthetic official-layout file, never executed',{mode:0o700});
  const xdg=path.join(root,'xdg');mkdirSync(xdg,{mode:0o700});const input={HOME:home,XDG_CACHE_HOME:xdg,PLAYWRIGHT_BROWSERS_PATH:'/wrong',npm_config_playwright_browsers_path:'/wrong2',npm_package_config_playwright_browsers_path:'/wrong3'};
  assert.equal(await installedChromiumPath(input),executable);assert.equal(await installedChromiumPath({HOME:home}),executable);
  assert.equal(cleanJointEnvironment(input)['PLAYWRIGHT_BROWSERS_PATH'],undefined);
  const source=readFileSync(new URL('../setup-source-native.mjs',import.meta.url),'utf8');assert.ok(source.includes("join(baseEnv.HOME,'.agent-browser/browsers')"));
  const publicCli=readFileSync(new URL('../../packages/web/src/cli.ts',import.meta.url),'utf8');assert.ok(publicCli.includes('run: runNativeInstall'));
  const publicInstall=readFileSync(new URL('../../packages/web/src/native/install.ts',import.meta.url),'utf8');assert.ok(publicInstall.includes('resolveNativeExecutable(context.env, context.cwd)'));
  const second=path.join(home,'.agent-browser/browsers/chrome-155.0.0.1');mkdirSync(second);writeFileSync(path.join(second,'chrome'),'other',{mode:0o700});await assert.rejects(installedChromiumPath(input),/exactly one/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('native cache discovery fails closed for missing cache, symlink escape and false digest',async()=>{
 const root=mkdtempSync(path.join(realpathSync(os.tmpdir()),'native-chrome-neg-'));
 try {
  const home=path.join(root,'home');mkdirSync(home);await assert.rejects(installedChromiumPath({HOME:home}));await assert.rejects(installedChromiumPath({HOME:'relative'}));
  const cache=path.join(home,'.agent-browser/browsers');const version=path.join(cache,'chrome-156.0.8078.4');mkdirSync(version,{recursive:true});const outside=path.join(root,'external');writeFileSync(outside,'synthetic',{mode:0o700});symlinkSync(outside,path.join(version,'chrome'));await assert.rejects(installedChromiumPath({HOME:home}),/escapes/);
  rmSync(version,{recursive:true});mkdirSync(version);const executable=path.join(version,'chrome');writeFileSync(executable,'synthetic',{mode:0o700});
  await assert.rejects(installedChromiumPath({HOME:home},async()=>({executablePath:outside,sha256:'0'.repeat(64)})),/escapes/);
  await assert.rejects(installedChromiumPath({HOME:home},async()=>({executablePath:executable,sha256:'0'.repeat(64)})),/hash changed/);
  chmodSync(executable,0o600);await assert.rejects(installedChromiumPath({HOME:home}));
  const linkedHome=path.join(root,'linked-home');symlinkSync(home,linkedHome);await assert.rejects(installedChromiumPath({HOME:linkedHome}));
 }finally{rmSync(root,{recursive:true,force:true});}
});
