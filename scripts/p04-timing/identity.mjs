// Existing source/dist/image checks; producer bytes belong to the explicitly pinned prior run.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync,statSync,writeFileSync,copyFileSync,constants} from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {pins,requirePins,sourceCheck,browserPin} from './runtime.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
const sha256=file=>digest(readFileSync(file));
const json=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const load=file=>JSON.parse(readFileSync(file));
function image(file){const executable=realpathSync(file),info=statSync(executable);return{executable,sha256:sha256(executable),dev:info.dev,ino:info.ino,size:info.size};}
async function images(workspace,evidence,final=false){
  const chrome=await browserPin(workspace,evidence);
  const result={full:{...image(chrome.executable),version:chrome.version},production:image(path.join(workspace,'agent-browser')),playwrightVersion:pins.playwrightVersion,chromiumRevision:pins.chromiumRevision};
  assert.equal(result.full.sha256,pins.chromeSha256);assert.equal(result.production.sha256,pins.production.binarySha256);
  if(final)assert.deepEqual(result,load(path.join(evidence,'images-before.json')));
  json(path.join(evidence,final?'images-after.json':'images-before.json'),result);
}
async function distCheck(workspace,evidence,final=false){
  const repo=path.join(workspace,'e2e-source');const{candidateDistInventory}=await import(pathToFileURL(path.join(repo,'scripts/acceptance/candidate-web.ts')).href);
  const result=candidateDistInventory(repo);if(final)assert.deepEqual(result,load(path.join(evidence,'dist-before.json')));
  json(path.join(evidence,final?'dist-after.json':'dist-before.json'),result);
}
async function main(){
  const[command]=process.argv.slice(2),workspace=process.env.GITHUB_WORKSPACE,evidence=process.env.EVIDENCE_DIR;assert.ok(workspace&&evidence);
  if(command==='admit')return (await import('./prior-product.mjs')).admit(workspace,evidence);
  requirePins();
  if(command==='overlay') {
    assert.ok(['N','D'].includes(process.env.COMPARISON_CELL));
    const root=path.join(workspace,'e2e-source');
    assert.equal(execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=all'],{encoding:'utf8'}).trim(),'');
    assert.equal(sha256(path.join(root,'packages/web/tests/integration/cdp-recovery.test.ts')),pins.p04SourceSha256);
    if(process.env.COMPARISON_CELL==='D') for(const [target,source]of [
      ['packages/web/tests/integration/cdp-recovery-direct.test.ts','cdp-recovery-direct.test.ts'],
      ['packages/web/tests/helpers/p04-direct-capture.mjs','direct-capture.mjs']]) {
      const file=new URL(source,import.meta.url);assert.equal(sha256(file),pins.comparison.overlay[target]);
      copyFileSync(file,path.join(root,target),constants.COPYFILE_EXCL);
    }
    return;
  }
  if(command==='sources'){sourceCheck(workspace,evidence);json(path.join(evidence,'source-before.json'),load(path.join(evidence,'source-identity.json')));return;}
  if(command==='images')return images(workspace,evidence);if(command==='dist')return distCheck(workspace,evidence);
  if(command==='final'){sourceCheck(workspace,evidence);assert.deepEqual(load(path.join(evidence,'source-identity.json')),load(path.join(evidence,'source-before.json')));await distCheck(workspace,evidence,true);await images(workspace,evidence,true);return;}
  if(command==='gate'){
    const phases=process.env.RUNTIME_PHASES.split(' '),results=Object.fromEntries(phases.map(p=>[p,readFileSync(path.join(evidence,p+'.exit'),'utf8').trim()]));
    let originalCase={status:'unknown',exit:null};try {const result=load(path.join(evidence,'P04.focused-result.json'));originalCase={status:result.selected.status,exit:result.exit};}catch {}
    const accepted=Object.values(results).every(s=>s==='0');json(path.join(evidence,'focused-result.json'),{caseId:'P04',cell:process.env.COMPARISON_CELL,originalCaseAcceptance:process.env.COMPARISON_CELL==='N'?originalCase:'not-applicable-diagnostic-replacement',accepted,phases:results,diagnosticOnly:true,fullNativeSuitePassed:false,full333Complete:false,releaseEligible:false});assert.equal(accepted,true);return;
  }throw Error('Unknown closed P04 command');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error);process.exitCode=1;});
