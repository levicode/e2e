// Pure filesystem/data controls only; never imports runner, engine or browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { registerShortReadFixture, retainShortReadReport, hasSyntheticSecret } from '../helpers/short-read-report-custody.ts';

it('retains only the two exact synthetic fixture reports without changing outcomes (17 controls)', () => {
const source=fileURLToPath(new URL('../', import.meta.url));
const text=fs.readFileSync(source+'integration/transformed-secrets.test.ts','utf8');
const context=vm.createContext({});
vm.runInContext(text.slice(text.indexOf('const TOKEN'),text.indexOf("describe('secrets"))+`;globalThis.files={'tests/echo.e2e.ts':SUITE};globalThis.forms=FORMS;`,context);
const files=context.files;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'short-read-custody-controls-'));
const old={dir:process.env.E2E_SHORT_READ_CUSTODY_DIR,suite:process.env.E2E_SHORT_READ_SUITE};
const report={run:{status:'failed'},results:[{code:'UNKNOWN',cleanup:'failed'}]};
const original=JSON.stringify(report);
const entries=()=>fs.readdirSync(root).filter(x=>x.startsWith('fixture-'));
let checks=0;
function control(fn){fn();checks++;}
try {
  delete process.env.E2E_SHORT_READ_CUSTODY_DIR;
  control(()=>{registerShortReadFixture('/optout',files);retainShortReadReport('/optout',report);assert.equal(entries().length,0);});
  process.env.E2E_SHORT_READ_CUSTODY_DIR=root;process.env.E2E_SHORT_READ_SUITE='transformed-secrets';
  control(()=>{registerShortReadFixture('/correct',files);retainShortReadReport('/correct',report);assert.equal(entries().length,1);const dir=path.join(root,entries()[0]);const bytes=fs.readFileSync(path.join(dir,'reports/report.json'));const receipt=JSON.parse(fs.readFileSync(path.join(dir,'custody.json')));assert.equal(bytes.toString(),original);assert.equal(receipt.status,'captured');assert.equal(receipt.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(receipt.bytes,bytes.length);assert.equal(JSON.stringify(report),original);});
  control(()=>{registerShortReadFixture('/wrong',{'tests/echo.e2e.ts':'not the fixture'});retainShortReadReport('/wrong',report);assert.equal(entries().length,1);});
  control(()=>{process.env.E2E_SHORT_READ_SUITE='web-platform';registerShortReadFixture('/scope',files);retainShortReadReport('/scope',report);assert.equal(entries().length,1);process.env.E2E_SHORT_READ_SUITE='transformed-secrets';});
  for(const form of context.forms) control(()=>{assert.ok(hasSyntheticSecret(form));const before=new Set(entries());registerShortReadFixture('/private',files);retainShortReadReport('/private',{synthetic:form});const name=entries().find(x=>!before.has(x));const dir=path.join(root,name);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'custody.json'))).status,'redaction-refused');assert.equal(fs.existsSync(path.join(dir,'reports/report.json')),false);});
  control(()=>{const before=entries().length;const link=path.join(root,'linked');fs.symlinkSync(root,link);process.env.E2E_SHORT_READ_CUSTODY_DIR=link;registerShortReadFixture('/link',files);retainShortReadReport('/link',report);assert.equal(entries().length,before);process.env.E2E_SHORT_READ_CUSTODY_DIR=root;});
  control(()=>{const before=new Set(entries());registerShortReadFixture('/large',files);retainShortReadReport('/large',{data:'x'.repeat(16*1024*1024)});const dir=path.join(root,entries().find(x=>!before.has(x)));assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'custody.json'))).status,'oversize');assert.equal(fs.existsSync(path.join(dir,'reports/report.json')),false);});
  control(()=>{const before=entries().length;for(let i=0;i<2;i++){registerShortReadFixture('/repeat',files);retainShortReadReport('/repeat',report);}assert.equal(entries().length,before+2);});
  control(()=>{const before=entries().length;retainShortReadReport('/unregistered',report);assert.equal(entries().length,before);});
  control(()=>{const before=entries().length;process.env.E2E_SHORT_READ_CUSTODY_DIR='relative';registerShortReadFixture('/relative',files);retainShortReadReport('/relative',report);assert.equal(entries().length,before);process.env.E2E_SHORT_READ_CUSTODY_DIR=root;});
  control(()=>{const before=entries().length;const bad={};bad.self=bad;registerShortReadFixture('/cyclic',files);assert.doesNotThrow(()=>retainShortReadReport('/cyclic',bad));assert.equal(entries().length,before+1);});
  control(()=>{
    const platform=fs.readFileSync(source+'integration/web-platform.test.ts','utf8');
    const helper=fs.readFileSync(source+'helpers/run-project.ts','utf8');
    const ctx=vm.createContext({workers:1,extra:"\n  cache: 'off',\n  actionTimeout: 5_000,\n  assertionTimeout: 4_000,\n  timeout: 30_000,"});
    vm.runInContext(platform.slice(platform.indexOf('const KITCHEN_SINK'),platform.indexOf("describe('web platform"))+`;globalThis.files={'tests/kitchen.e2e.ts':KITCHEN_SINK,'tests/late-handler.e2e.ts':LATE_HANDLER_THEN_TEARDOWN,'tests/schemes.e2e.ts':WRAPPED_SCHEMES,'tests/classes.e2e.ts':CLASSES,'tests/url-patterns.e2e.ts':URL_PATTERNS,'marker.txt':'marker-local-file\\n'};`,ctx);
    const start=helper.indexOf('  return `',helper.indexOf('export function workerConfigSource'));const end=helper.indexOf('\n`;',start)+3;
    vm.runInContext('globalThis.config='+helper.slice(start,end).trim().replace(/^return /,''),ctx);ctx.files['e2e.config.ts']=ctx.config;
    process.env.E2E_SHORT_READ_SUITE='web-platform';const before=new Set(entries());registerShortReadFixture('/platform',ctx.files);retainShortReadReport('/platform',report);
    const dir=path.join(root,entries().find(x=>!before.has(x)));assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'custody.json'))).status,'captured');assert.equal(fs.readFileSync(path.join(dir,'reports/report.json'),'utf8'),original);
  });
  process.stdout.write(JSON.stringify({status:'passed',controls:checks,nativeBrowserSocket:false})+'\n');
} finally {
  if(old.dir===undefined)delete process.env.E2E_SHORT_READ_CUSTODY_DIR;else process.env.E2E_SHORT_READ_CUSTODY_DIR=old.dir;
  if(old.suite===undefined)delete process.env.E2E_SHORT_READ_SUITE;else process.env.E2E_SHORT_READ_SUITE=old.suite;
  fs.rmSync(root,{recursive:true,force:true});
}

});
