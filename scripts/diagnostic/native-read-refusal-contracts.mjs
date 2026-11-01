/** Native unit-contract diagnostics only. No production binary, browser, JS build or N30. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {sha,readOwned,directoryFence,resolveNativeControlNames,selectControlHarness,collectNativeControlOutcomes,REQUIRED_NATIVE_CONTROLS} from './core-counterexample.mjs';
import {LOCK,cleanEnvironment,executeLogged} from '../setup-source-native.mjs';
export const PARENT='f58c23cacd5a9fd0c3eece9c2ea00106b26ead73';
export const BRANCH='ci/read-refusal-contracts-20261101';
export const NATIVE={commit:'a76e142b01870cb28f58be07aaf5b6c74ea4e132',tree:'5b02a8243f49c2e7ed66b140a073fdefed877fac'}; // actual immutable native publication, not a preview commit
export const NEW_CONTROLS=["observe_receipt_continuous_read_race_keeps_clean_owned_scope", "observe_receipt_held_release_is_not_a_settled_prefix", "observe_receipt_late_release_ack_cannot_restart_failed_read", "observe_receipt_usable_broker_does_not_restore_replaced_attachment", "observe_receipt_sealed_owner_stays_terminal", "observe_receipt_failed_release_preserves_terminal_cleanup", "observe_receipt_other_attach_each_sample_has_exact_initial_delta_one", "observe_receipt_other_attach_with_held_release_has_exact_prefix_refusal", "owned_inventory_diagnostic_opt_in_is_local_and_records_actual_registration"]; // exact frozen native v2 source names, actual Rust execution still pending
export function requiredControls(additional=NEW_CONTROLS){assert.ok(Array.isArray(additional)&&additional.length>0,'Unbound required controls');const names=[...REQUIRED_NATIVE_CONTROLS,...additional];assert.equal(new Set(names).size,names.length);for(const n of names)assert.match(n,/^[A-Za-z_][A-Za-z0-9_]*$/);return names;}
export function boundNative(value=NATIVE){assert.ok(value,'Unbound native identity');assert.deepEqual(Object.keys(value).sort(),['commit','tree']);for(const v of Object.values(value))assert.match(v,/^[a-f0-9]{40}$/);return value;}
export function toolingBinding(actual,parents,shaValue,ref){assert.match(actual.commit,/^[a-f0-9]{40}$/);assert.match(actual.tree,/^[a-f0-9]{40}$/);assert.equal(actual.commit,shaValue);assert.equal(ref,'refs/heads/'+BRANCH);assert.deepEqual(parents,[PARENT]);}
export function identity(root){const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();assert.equal(git('status','--porcelain'),'');return {commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}')};}
export function freshWork(root,native,tooling){assert.ok(path.isAbsolute(root));assert.ok(!fs.existsSync(root),'Work must be new');assert.equal(fs.realpathSync(path.dirname(root)),path.dirname(root));for(const source of [native,tooling])assert.ok(root!==source&&!root.startsWith(source+path.sep)&&!source.startsWith(root+path.sep));fs.mkdirSync(root,{mode:0o700});const st=fs.lstatSync(root);assert.equal(st.uid,process.getuid());assert.equal(st.mode&0o777,0o700);const fence=directoryFence(root);fs.mkdirSync(path.join(root,'target'),{mode:0o700});fs.mkdirSync(path.join(root,'evidence'),{mode:0o700});return fence;}
export function initialResult(names,native){return {schemaVersion:1,purpose:'native-test-only-read-refusal-contracts',publicCLI:false,acceptanceEvidence:false,rootCauseFixed:false,status:'incomplete',native,tooling:null,harnessHash:null,compilerSHA256:null,lockSHA256:null,stage:'source-identity',tests:names.map((leaf,index)=>({leaf,name:null,commandLabel:'control-'+String(index+1).padStart(2,'0'),status:'not-run',reason:'not-run-before-validation'})),commands:[],phases:[]};}
export async function run(argv){
 assert.equal(argv.length,2);const nativeIdentity=boundNative(),required=requiredControls();
 const native=fs.realpathSync(argv[0]),work=path.resolve(argv[1]),tooling=fs.realpathSync(path.resolve(import.meta.dirname,'../..'));
 const workFence=freshWork(work,native,tooling),target=path.join(work,'target'),evidence=path.join(work,'evidence'),evidenceFence=directoryFence(evidence),targetFence=directoryFence(target);
 const result=initialResult(required,nativeIdentity);let serial=0,primary;
 const save=()=>{workFence();evidenceFence();const file=path.join(evidence,'result-'+String(++serial)+'.tmp');fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});evidenceFence();fs.renameSync(file,path.join(evidence,'result.json'));evidenceFence();};save();
 try{
  assert.deepEqual(identity(native),nativeIdentity);result.tooling=identity(tooling);toolingBinding(result.tooling,execFileSync('git',['show','-s','--format=%P','HEAD'],{cwd:tooling,encoding:'utf8'}).trim().split(' '),process.env.GITHUB_SHA,process.env.GITHUB_REF);
  result.lockSHA256=sha(readOwned(path.join(native,'cli/Cargo.lock'),1024*1024));assert.equal(result.lockSHA256,LOCK);
  const env={...cleanEnvironment(process.env),CARGO_TARGET_DIR:target,CARGO_BUILD_JOBS:'1'};let phaseEvidenceFailed=false;
  const command=(label,exe,args)=>{phaseEvidenceFailed=false;workFence();targetFence();result.stage=label;const phase={label,startedAt:new Date().toISOString(),durationMs:null,exitCode:null,status:'incomplete'};result.phases.push(phase);save();const start=Date.now();let output,error;try{output=executeLogged(evidence,result.commands,label,exe,args,path.join(native,'cli'),env);}catch(cause){error=cause;}phase.durationMs=Date.now()-start;const row=result.commands.at(-1);if(row?.label===label){phase.exitCode=row.exitCode;phase.status=row.exitCode===0&&row.signal===null&&row.error===null?'command-completed':'failed';}try{save();console.log(JSON.stringify(phase));}catch(cause){phaseEvidenceFailed=true;error??=cause;}if(error)throw error;return output;};
  command('rustc','rustc',['-Vv']);command('cargo','cargo',['--version']);
  const compiler=command('test-compiler','cargo',['test','--locked','--profile','ci','--no-default-features','--no-run','--message-format=json']);result.compilerSHA256=sha(Buffer.from(compiler));
  const selected=selectControlHarness(compiler.trim().split('\n').map(line=>JSON.parse(line)),native,target);assert.equal(selected.fresh,false);const harness=selected.executable;assert.equal(fs.realpathSync(harness),harness);result.harnessHash=sha(readOwned(harness,512*1024*1024));
  const list=command('test-list',harness,['--list','--format','terse']);const qualified=resolveNativeControlNames(list,required);
  const outcome=collectNativeControlOutcomes(required,qualified,(name,label)=>{let stdout;try{stdout=command(label,harness,[name,'--exact','--test-threads=1','--nocapture']);}catch(cause){const row=result.commands.at(-1);if(phaseEvidenceFailed||row?.label!==label||row.exitCode===0&&row.signal===null&&row.error===null)throw cause;stdout=readOwned(path.join(evidence,label+'.stdout.log'),16*1024*1024).toString('utf8');}return {...result.commands.at(-1),stdout};},tests=>{result.tests=tests;save();});
  result.tests=outcome.tests;result.status=outcome.status;primary??=outcome.interruptionError;result.stage='post-control-identity';save();
  assert.equal(sha(readOwned(harness,512*1024*1024)),result.harnessHash);assert.equal(sha(readOwned(path.join(native,'cli/Cargo.lock'),1024*1024)),LOCK);assert.deepEqual(identity(native),nativeIdentity);assert.deepEqual(identity(tooling),result.tooling);workFence();targetFence();evidenceFence();result.stage='complete';save();if(primary)throw primary;assert.equal(result.status,'passed','Required contract tests failed or incomplete');
 }catch(cause){primary??=cause;if(result.stage!=='complete')result.status='incomplete';}
 try{save();}catch(cause){primary??=cause;}if(primary)throw primary;return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await run(process.argv.slice(2));
