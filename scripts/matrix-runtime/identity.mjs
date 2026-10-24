// Source/artifact verification reuses the reviewed focused-runtime recipe primitives.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export const pins = JSON.parse(readFileSync(path.join(here, 'pins.json'), 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const sha256 = file => digest(readFileSync(file));
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
export function requirePins() {
  for (const key of ['e2eSha','e2eTree','nativeSha','nativeTree']) assert.match(pins[key], /^[a-f0-9]{40}$/);
  assert.equal(pins.e2eSha, '0e19094382c3959d3c52c865c1066c3e59b911b7');
  assert.equal(pins.binarySha256, 'fa5fbad01243472bb82db38a3a4790b072fe9e1114e7f0adc6dc2a494b3edd02');
}
function sourceIdentity(root, sha, tree) {
  const result = { commit: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}'), status: git(root, 'status', '--porcelain', '--untracked-files=all') };
  assert.equal(result.commit, sha); assert.equal(result.tree, tree); assert.equal(result.status, ''); return result;
}
async function downloadArtifact(workspace, evidence) {
  requirePins();
  const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  assert.ok(process.env.GH_TOKEN, 'Actions read token is required');
  const endpoint = `https://api.github.com/repos/levicode/e2e/actions/artifacts/${pins.artifactId}`;
  const metadataResponse = await fetch(endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.id, pins.artifactId); assert.equal(metadata.expired, false);
  assert.equal(metadata.workflow_run.id, pins.compileRunId); assert.equal(metadata.workflow_run.head_sha, pins.compileRecipeSha);
  json(path.join(evidence, 'download-origin.json'), { repository: 'levicode/e2e', id: metadata.id, name: metadata.name, runId: metadata.workflow_run.id, headSha: metadata.workflow_run.head_sha });
  // Stop at GitHub's redirect; never forward Authorization to artifact storage.
  const redirect = await fetch(endpoint + '/zip', { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  assert.equal(redirect.status, 302);
  const location = new URL(redirect.headers.get('location')); assert.equal(location.protocol, 'https:'); assert.equal(location.username + location.password, '');
  const archive = await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  assert.equal(archive.status, 200);
  const chunks = []; let size = 0;
  for await (const chunk of archive.body) { size += chunk.length; assert.ok(size <= 64 * 1024 * 1024, 'Unexpected archive size'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks); assert.equal(digest(bytes), pins.artifactZipSha256);
  const zip = path.join(workspace, 'native-artifact.zip'); writeFileSync(zip, bytes, { flag: 'wx', mode: 0o600 });
  const binary = path.join(workspace, 'agent-browser');
  // Extract only fixed named files, never archive-controlled filesystem paths.
  const extract = member => execFileSync('unzip', ['-p', zip, member], { maxBuffer: 64 * 1024 * 1024 });
  const binaryBytes = extract('native-linux-compile-bin/agent-browser'); assert.equal(digest(binaryBytes), pins.binarySha256);
  assert.equal(binaryBytes.subarray(0, 6).toString('hex'), '7f454c460201'); assert.equal(binaryBytes.readUInt16LE(18), 62);
  writeFileSync(binary, binaryBytes, { flag: 'wx', mode: 0o700 });
  for (const [name, sha, tree] of [['recipe', pins.compileRecipeSha, pins.compileRecipeTree], ['native-source', pins.nativeSha, pins.nativeTree], ['e2e-source', pins.compileE2eSha, pins.compileE2eTree]]) {
    const text = extract(`native-linux-compile/${name}.txt`).toString(); assert.equal(text.trim(), `${sha}\n${tree}`); writeFileSync(path.join(evidence, `compile-${name}.txt`), text);
  }
  json(path.join(evidence, 'artifact-identity.json'), { zipSha256: digest(bytes), binarySha256: digest(binaryBytes), binaryBytes: binaryBytes.length, rustBuild: false });
}
export function sourceCheck(workspace, evidence, final = false) {
  requirePins();
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(process.version, pins.nodeVersion);
  assert.match(readFileSync('/etc/os-release', 'utf8'), /^VERSION_ID="24\.04"$/m);
  const e2e = path.join(workspace, 'e2e-source'), native = path.join(workspace, 'native-source');
  const result = { e2e: sourceIdentity(e2e,pins.e2eSha,pins.e2eTree), native: sourceIdentity(native,pins.nativeSha,pins.nativeTree),
    recipe: sourceIdentity(path.join(workspace,'recipe'),process.env.RECIPE_SHA,git(path.join(workspace,'recipe'),'rev-parse','HEAD^{tree}')),
    pnpmLockSha256: sha256(path.join(e2e,'pnpm-lock.yaml')) };
  assert.equal(sha256(path.join(native,'cli/src/native/cdp/chrome.rs')),pins.nativeChromeSourceSha256);
  assert.equal(sha256(path.join(native,'cli/src/install.rs')),pins.nativeInstallSourceSha256);
  assert.equal(JSON.parse(readFileSync(path.join(e2e,'package.json'))).packageManager,`pnpm@${pins.pnpmVersion}`);
  assert.equal(JSON.parse(readFileSync(path.join(e2e,'packages/web/package.json'))).devDependencies['playwright-core'],pins.playwrightVersion);
  if (final) assert.deepEqual(result,JSON.parse(readFileSync(path.join(evidence,'source-before.json'))));
  json(path.join(evidence,final?'source-after.json':'source-before.json'),result);
}
function image(file) {
  const executable=realpathSync(file), info=statSync(executable);
  return { executable, sha256:sha256(executable), dev:info.dev,ino:info.ino,size:info.size };
}
export function validateCatalog(catalog) {
  for (const name of ['chromium','chromium-headless-shell']) {
    const entry=catalog.browsers.find(entry=>entry.name===name);
    assert.equal(entry?.revision,pins.chromiumRevision,name); assert.equal(entry?.browserVersion,pins.chromeVersion,name);
  }
}
export function browserCheck(workspace,evidence,final=false) {
  const require=createRequire(path.join(workspace,'e2e-source/packages/web/package.json'));
  const packageFile=require.resolve('playwright-core/package.json');
  assert.equal(JSON.parse(readFileSync(packageFile)).version,pins.playwrightVersion);
  validateCatalog(JSON.parse(readFileSync(path.join(path.dirname(packageFile),'browsers.json'))));
  const root=realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH);
  const full=image(require('playwright-core').chromium.executablePath());
  const shell=image(path.join(root,'chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell'));
  for (const value of [full,shell]) {
    assert.ok(value.executable.startsWith(root+path.sep));
    assert.ok(statSync(value.executable).mode & 0o111);
    value.version=execFileSync(value.executable,['--version'],{encoding:'utf8',timeout:10000}).trim();
    assert.match(value.version,/\b156\.0\.8078\.4\b/);
  }
  assert.equal(full.executable,path.join(root,'chromium-1248/chrome-linux64/chrome'));
  assert.equal(full.sha256,pins.chromeSha256);
  const result={full,shell,production:image(path.join(workspace,'agent-browser')),playwrightVersion:pins.playwrightVersion,chromiumRevision:pins.chromiumRevision};
  assert.equal(result.production.sha256,pins.binarySha256);
  if(final) assert.deepEqual(result,JSON.parse(readFileSync(path.join(evidence,'images-before.json'))));
  json(path.join(evidence,final?'images-after.json':'images-before.json'),result);
  return result;
}
export async function distCheck(workspace,evidence,final=false) {
  const repo=path.join(workspace,'e2e-source');
  const {candidateDistInventory}=await import(pathToFileURL(path.join(repo,'scripts/acceptance/candidate-web.ts')).href);
  const result=candidateDistInventory(repo);
  if(final) assert.deepEqual(result,JSON.parse(readFileSync(path.join(evidence,'dist-before.json'))));
  json(path.join(evidence,final?'dist-after.json':'dist-before.json'),result);
}
async function main() {
  const [command]=process.argv.slice(2), workspace=process.env.GITHUB_WORKSPACE,evidence=process.env.EVIDENCE_DIR;
  requirePins(); assert.ok(workspace&&evidence,'Explicit workflow workspace and evidence required');
  if(command==='sources') return sourceCheck(workspace,evidence);
  if(command==='download') return downloadArtifact(workspace,evidence);
  if(command==='browsers') return browserCheck(workspace,evidence);
  if(command==='dist') return distCheck(workspace,evidence);
  if(command==='final') {
    const checks={};
    for(const [name,run] of [['source',()=>sourceCheck(workspace,evidence,true)],['images',()=>browserCheck(workspace,evidence,true)],['dist',()=>distCheck(workspace,evidence,true)]]) {
      try { await run(); checks[name]={status:'passed'}; }
      catch(error) { checks[name]={status:'failed',problem:String(error)}; }
    }
    json(path.join(evidence,'postrun-identities.json'),checks);
    assert.ok(Object.values(checks).every(item=>item.status==='passed'),'Post-run identity checks failed or unavailable');return;
  }
  if(command==='verify-proof') {
    const repo=path.join(workspace,'e2e-source');
    const {verifyCandidateRuntime}=await import(pathToFileURL(path.join(repo,'scripts/acceptance/candidate-web.ts')).href);
    assert.equal(sha256(path.join(workspace,'agent-browser')),pins.binarySha256);
    verifyCandidateRuntime(JSON.parse(readFileSync(path.join(evidence,'production-negotiation.json'))),pins.binarySha256,false);return;
  }
  throw Error('Unknown explicit command');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error);process.exitCode=1;});
