// Exact prior diagnostic artifact only; same reviewed fetch/redirect/extract pattern as identity.mjs.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST_SHA256='052086be095f25acef78129548fb1462af4b65ccddaec1b693c50612579ec29e';
const sha=value=>createHash('sha256').update(value).digest('hex');
export function loadManifest(file=path.join(here,'continuation-manifest.json')) {
 const bytes=readFileSync(file);assert.equal(sha(bytes),MANIFEST_SHA256,'Continuation manifest changed');
 const manifest=JSON.parse(bytes);assert.equal(manifest.selected.length,302);assert.equal(manifest.retained.length,21);assert.equal(manifest.notRun.length,1);
 const pins=JSON.parse(readFileSync(path.join(here,'pins.json')));
 for(const [key,pin] of [['sourceSha','e2eSha'],['sourceTree','e2eTree'],['nativeSha','nativeSha'],['nativeTree','nativeTree'],['binarySha256','binarySha256']]) assert.equal(manifest.prior[key],pins[pin]);
 return manifest;
}
export function verifyPrior(out,manifest=loadManifest()) {
 for(const [name,expected] of Object.entries(manifest.prior.artifacts)) assert.equal(sha(readFileSync(path.join(out,name))),expected,`Prior raw evidence changed: ${name}`);
 const binding=JSON.parse(readFileSync(path.join(out,'download-binding.json')));
 assert.equal(binding.runId,manifest.prior.runId);assert.equal(binding.artifactId,manifest.prior.artifactId);assert.equal(binding.artifactZipSha256,manifest.prior.artifactZipSha256);assert.equal(binding.manifestSha256,MANIFEST_SHA256);
}
export function extractPrior(zip,out,manifest=loadManifest()) {
 const bytes=readFileSync(zip);assert.equal(bytes.length,manifest.prior.artifactZipBytes);assert.equal(sha(bytes),manifest.prior.artifactZipSha256);
 mkdirSync(out,{mode:0o700});
 for(const [name,expected] of Object.entries(manifest.prior.artifacts)) {
  assert.match(name,/^[a-zA-Z0-9.-]+\.json$/,'Only fixed manifest JSON members may be extracted');
  const content=execFileSync('unzip',['-p',zip,name],{maxBuffer:4*1024*1024});assert.equal(sha(content),expected,`Prior artifact member changed: ${name}`);
  writeFileSync(path.join(out,name),content,{flag:'wx',mode:0o600});
 }
 writeFileSync(path.join(out,'download-binding.json'),JSON.stringify({runId:manifest.prior.runId,artifactId:manifest.prior.artifactId,artifactZipSha256:sha(bytes),recipeSha:manifest.prior.recipeSha,manifestSha256:MANIFEST_SHA256,readOnly:true},null,2)+'\n',{flag:'wx',mode:0o600});
}
export async function downloadPrior(output,fetcher=fetch) {
 const manifest=loadManifest(),prior=manifest.prior;
 assert.ok(process.env.GH_TOKEN,'Actions read token is required');
 const headers={Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
 const endpoint=`https://api.github.com/repos/levicode/e2e/actions/artifacts/${prior.artifactId}`;
 const metadataResponse=await fetcher(endpoint,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});assert.equal(metadataResponse.status,200);
 const metadata=await metadataResponse.json();assert.equal(metadata.id,prior.artifactId);assert.equal(metadata.expired,false);assert.equal(metadata.workflow_run.id,prior.runId);assert.equal(metadata.workflow_run.head_sha,prior.recipeSha);
 const redirect=await fetcher(endpoint+'/zip',{headers,redirect:'manual',signal:AbortSignal.timeout(30000)});assert.equal(redirect.status,302);
 const location=new URL(redirect.headers.get('location'));assert.equal(location.protocol,'https:');assert.equal(location.username+location.password,'');
 // No Authorization or other caller headers are forwarded to signed storage.
 const response=await fetcher(location,{redirect:'error',signal:AbortSignal.timeout(120000)});assert.equal(response.status,200);
 const chunks=[];let size=0;
 for await(const chunk of response.body) {size+=chunk.length;assert.ok(size<=prior.artifactZipBytes,'Unexpected prior archive size');chunks.push(chunk);}
 const bytes=Buffer.concat(chunks);assert.equal(bytes.length,prior.artifactZipBytes);assert.equal(sha(bytes),prior.artifactZipSha256);
 const zip=path.join(output,'prior-run40116161447.zip');writeFileSync(zip,bytes,{flag:'wx',mode:0o600});
 extractPrior(zip,path.join(output,'prior-run40116161447'),manifest);
 writeFileSync(path.join(output,'prior-download-origin.json'),JSON.stringify({repository:'levicode/e2e',artifactId:metadata.id,name:metadata.name,runId:metadata.workflow_run.id,recipeSha:metadata.workflow_run.head_sha,archiveSha256:sha(bytes)},null,2)+'\n',{flag:'wx',mode:0o600});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) downloadPrior(process.env.EVIDENCE_DIR).catch(error=>{console.error(error);process.exitCode=1;});
