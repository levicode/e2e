/** One original managed reload case. Diagnostic only; no production acceptance. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createProject, runExisting } from '../../packages/e2e/tests/helpers/run-project.ts';
import { popupDocumentDiagnosticFixture, popupDocumentDiagnosticHtml, validPopupDocumentEvidence } from '../../packages/e2e/tests/helpers/popup-document-evidence.ts';

import { fileURLToPath, pathToFileURL } from 'node:url';

export const POPUP_JOINT_CASE_ENTRY = fileURLToPath(import.meta.url);
async function main(output:string):Promise<void> {
const title = 'popup first inline sees each init once and reload starts a fresh document';
const root = output; assert.ok(root);
const html = '<!doctype html><script>globalThis.firstInline = [...(globalThis.initOrder ?? [])];</script><script>addEventListener("DOMContentLoaded", () => { if (opener) opener.postMessage({kind: "init-document", snapshot: {first: globalThis.firstInline, final: globalThis.initOrder}}, location.origin); }, {once: true});</script><title>Synthetic init order</title><body>fixture</body>';
const testSource = readFileSync('packages/e2e/tests/integration/web-popup-init-order.test.ts','utf8');
assert.ok(testSource.includes(html), 'Original HTML changed');
const cases = readFileSync('packages/e2e/tests/fixtures/popup-init-order/cases.txt','utf8');
assert.ok(cases.includes("{ timeout: 12_000 }"));
const server = createServer((request,response) => {
  if(request.method!=='GET'||!['/main','/next','/popup'].includes(request.url??'')){response.writeHead(404).end();return;}
  response.writeHead(200,{'content-type':'text/html'});response.end(popupDocumentDiagnosticHtml(html));
});
const state: {kind:string; acceptanceEvidence:false; status:string; exitCode:number|null; selected:number|null; attempts:number|null; errorCode:string|null; cleanup:string; fixtureDisposal:string; shape:string} = {kind:'managed-popup-joint-diagnostic',acceptanceEvidence:false,status:'incomplete',exitCode:null,selected:null,attempts:null,errorCode:null,cleanup:'unknown',fixtureDisposal:'incomplete',shape:'missing'};
let project: ReturnType<typeof createProject>|undefined;
let failed = false;
try {
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  project=createProject({'tests/popup-init-order.e2e.ts':popupDocumentDiagnosticFixture(cases)});
  const outcome=await runExisting(project,{appUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,config:{workers:1},runOptions:{grep:[/^popup first inline sees each init once and reload starts a fresh document$/],retries:0}});
  state.exitCode=outcome.exitCode;
  const selected=outcome.results.filter(result=>result.selected);state.selected=selected.length;
  assert.equal(selected.length,1);const result=selected[0]!;
  assert.equal(result.test.title,title);assert.equal(result.repeat,0);state.attempts=result.attempts.length;assert.equal(result.attempts.length,1);
  assert.equal(outcome.results.length,3);assert.equal(outcome.results.filter(unselected=>!unselected.selected&&unselected.attempts.length===0).length,2);
  state.cleanup=result.attempts[0]!.cleanup;
  const code=result.attempts[0]!.error?.code;state.errorCode=code===undefined?null:['INVALID_ARGUMENT','ENGINE_FAILURE','ACTION_FAILED','ACTION_MAY_HAVE_COMMITTED','APP_NOT_OPEN','INVALID_STATE','TIMEOUT','CANCELLED'].includes(code)?code:'other';
  state.status=result.status==='passed'&&outcome.exitCode===0?'passed':'failed';failed=state.status!=='passed'||state.cleanup!=='complete';
} catch {failed=true;} finally {
  if(project){
    try {const evidence:unknown=JSON.parse(readFileSync(path.join(project.dir,'.e2e/popup-document-evidence.json'),'utf8'));assert.ok(validPopupDocumentEvidence(evidence));const bytes=JSON.stringify(evidence)+'\n';assert.ok(Buffer.byteLength(bytes)<=4096);writeFileSync(path.join(root,'shape.json'),bytes,{flag:'wx',mode:0o600});state.shape='retained';} catch { /* No shape on success or unrelated error; never infer ACK. */ }
    try {project.cleanup();} catch {failed=true;}
  }
  try {if(server.listening){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}state.fixtureDisposal='completed';}catch{failed=true;}
  writeFileSync(path.join(root,'case.json'),JSON.stringify(state,null,2)+'\n',{flag:'wx',mode:0o600});
}
process.exitCode=failed?1:0;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) await main(process.argv[2]!);
