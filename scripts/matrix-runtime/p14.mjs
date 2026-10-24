// Thin adapter around the candidate's existing installer proof/binding functions.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [repo, production, fault, proof, receipt, ...command] = process.argv.slice(2);
assert.ok(repo && production && fault && proof && receipt && command.length);
const {verifyInstallerFixtureRuntime,candidateInstallerEnvironment,verifyInstallerFixturePostRun}=await import(pathToFileURL(repo+'/scripts/acceptance/candidate-web.ts'));
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const runtime=verifyInstallerFixtureRuntime('web-browser',fault,proof,production,hash(production));
let result, primaryError;
try { result=spawnSync(command[0],command.slice(1),{env:candidateInstallerEnvironment(process.env,runtime),stdio:'inherit'}); primaryError=result.error?.message; }
catch(error){ primaryError=String(error); }
finally {
  const binding=verifyInstallerFixturePostRun(runtime);
  writeFileSync(receipt,JSON.stringify({...binding,processExit:result?.status??null,signal:result?.signal??null,primaryError:primaryError??null},null,2)+'\n',{flag:'wx'});
  process.exitCode=typeof result?.status==='number'&&result.status!==0?result.status:primaryError||!binding.postRunIdentityVerified||result?.status!==0?1:0;
}
