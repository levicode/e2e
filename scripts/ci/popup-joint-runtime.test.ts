import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cleanJointEnvironment, owned, socketBudget } from './popup-joint-runtime.ts';
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
