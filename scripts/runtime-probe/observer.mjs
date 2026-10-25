import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFileSync,closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,readlinkSync,renameSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {borrowedOwnedSnapshot} from './borrowed-ownership.mjs';

export const nowUs=()=>Number(process.hrtime.bigint()/1000n);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const sha256=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
export const imageIdentity=path=>{const s=statSync(path,{bigint:true});return{dev:BigInt.asUintN(64,s.dev).toString(),ino:BigInt.asUintN(64,s.ino).toString(),bytes:s.size.toString()}};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function atomicJson(path,value){
  const temp=path+'.pending';const fd=openSync(temp,'w',0o600);
  try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd)}finally{closeSync(fd)}
  renameSync(temp,path);
}
export function pathPreflight(root){
  const st=lstatSync(root);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o777)!==0o700)throw Error('unowned-runtime-root');
  const tmp=join(root,'tmp'),ipc=join(root,'s');
  for(const p of [tmp,ipc,join(root,'points')])if(!existsSync(p))mkdirSync(p,{mode:0o700});
  const nativeSocket=join(ipc,'e2e-00000000-0000-0000-0000-000000000000.sock');
  const chromeSocket=join(tmp,'org.chromium.Chromium.XXXXXX','SingletonSocket');
  const result={runtimeRoot:root,dev:st.dev,ino:st.ino,TMPDIR:tmp,TMP:tmp,TEMP:tmp,nativeSocketBytes:Buffer.byteLength(nativeSocket),nativeLimit:103,chromeSocketBytes:Buffer.byteLength(chromeSocket),chromeLimit:107};
  if(result.nativeSocketBytes>79||result.chromeSocketBytes>83)throw Error('socket-path-margin-insufficient');
  return result;
}
function proc(pid){
  try{const p='/proc/'+pid,raw=readFileSync(p+'/stat','utf8'),f=raw.slice(raw.lastIndexOf(')')+2).split(' ');return{status:['Z','X'].includes(f[0])?'terminal':'live',pid,state:f[0],startTicks:f[19],uid:statSync(p).uid,ppid:Number(f[1]),pgrp:Number(f[2])}}
  catch(e){return{status:e.code==='ENOENT'?'absent':'unreadable',pid,errno:e.code??'unknown'}}
}
function socketProfile(root,borrowed=false){
  const found=[];
  for(const name of readdirSync(join(root,'tmp'))){if(!/^agent-browser-chrome-[a-f0-9-]{36}$/.test(name)&&!(borrowed&&/^e2e-cdp-host-[A-Za-z0-9]{6}$/.test(name)))continue;const profile=join(root,'tmp',name),s=lstatSync(profile);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid())continue;
    try{const q=lstatSync(join(profile,'SingletonLock'));if(!q.isSymbolicLink()||q.uid!==process.getuid())continue;const m=readlinkSync(join(profile,'SingletonLock')).match(/-([1-9][0-9]*)$/);if(m)found.push({pid:Number(m[1]),profile,borrowed:name.startsWith('e2e-cdp-host-')})}catch{}
  }return found;
}
export function validateSample(value){
  if(!value||Array.isArray(value)||value.schemaVersion!==1||!['mapped','unknown'].includes(value.status))return false;
  if(value.status==='unknown')return typeof value.reason==='string'&&value.reason.length<100;
  const good=n=>Number.isSafeInteger(n)&&n>=0;
  return value.applicationBytesRead===0&&value.CDPConnectionsOpened===0&&value.identityAndSelectedFdLinksStableBeforeAfter===true&&value.uniqueConnectionPair===true&&good(value.startedMonotonicUs)&&good(value.finishedMonotonicUs)&&value.startedMonotonicUs<=value.finishedMonotonicUs&&['nativeSocket','chromeAcceptedSocket'].every(k=>value[k]?.state===1&&good(value[k].inode)&&value[k].inode>0&&good(value[k].txBytes)&&good(value[k].rxBytes))&&value.listener?.state===10;
}
export function sampleCli(config,pair,fault=null){
  const input={native:pair.native,chrome:pair.chrome,profile:pair.profile,syntheticFixture:config.synthetic===true};
  const args=[config.sampler];if(fault){if(!config.synthetic)throw Error('fault-requires-synthetic-fixture');args.push('--selftest-fault',fault)}
  try{const raw=execFileSync(config.python,args,{input:JSON.stringify(input),encoding:'utf8',timeout:config.samplerTimeoutMs??1200,maxBuffer:128*1024});let value;try{value=JSON.parse(raw)}catch{return{schemaVersion:1,status:'unknown',reason:'invalid-sampler-json'}}
    return validateSample(value)?value:{schemaVersion:1,status:'unknown',reason:'invalid-sampler-schema'};
  }catch(e){return{schemaVersion:1,status:'unknown',reason:e.code==='ETIMEDOUT'?'sampler-timeout':'sampler-process-failed'}}
}

export async function runObserved(config){
  const root=config.root,paths=pathPreflight(root);
  for(const spec of [config.native,config.chrome])if(!same(imageIdentity(spec.executable),spec.fileIdentity)||sha256(spec.executable)!==spec.sha256)throw Error('configured-executable-identity-mismatch');
  const startUs=nowUs();
  const plan=config.queueSampling===false?[]:[2000,10000,20000];const records=new Map(),errors=[],points=[];let firstError=null,anchor=null,child=null,exit=null,closed=false,spawnError=null,sequence=0,stop=false,finallyEntered=false,transientInjected=false;
  let launcherSnapshot=null,lastInventoryKey=null,lastPersistUs=0,pointWriteInjected=false;
  const pointStream=join(root,'socket-queues.jsonl');writeFileSync(pointStream,'',{flag:'wx',mode:0o600});
  const errorStream=join(root,'observer-errors.jsonl');writeFileSync(errorStream,'',{flag:'wx',mode:0o600});
  function issue(stage,code){const item={atUs:nowUs(),stage,code};errors.push(item);firstError??=item;try{appendFileSync(errorStream,JSON.stringify(item)+'\n')}catch{}return item}
  function save(path,value,stage){try{atomicJson(path,value);return true}catch(e){issue(stage,e.code??e.name??'unknown');return false}}
  function inventory(reason,force=false){
    const value={schemaVersion:1,atUs:nowUs(),reason,launcher:launcherSnapshot,processes:[...records.values()]};
    const key=JSON.stringify(value.processes.map(p=>[p.pid,p.startTicks,p.current.status,p.terminalFileOwnerObservation?.fd]));
    if(reason.startsWith('before-point-'))save(join(root,'inventory-'+reason+'.json'),value,'inventory-checkpoint-write');
    if(reason==='immediately-after-spawn')save(join(root,'inventory-spawn.json'),value,'inventory-spawn-write');
    if(force||key!==lastInventoryKey||nowUs()-lastPersistUs>=1000000){const okay=save(join(root,'inventory.json'),value,'inventory-write');if(okay){lastInventoryKey=key;lastPersistUs=nowUs()}}
    return value;
  }
  function borrowedIdentity(base,profile,argv,executable,environment,expectedProfileIdentity){
    try{const s=lstatSync(profile);return borrowedOwnedSnapshot({profile,runtimeTmp:join(root,'tmp'),profileStat:{directory:s.isDirectory(),symlink:s.isSymbolicLink(),uid:s.uid,mode:s.mode&0o777,dev:s.dev,ino:s.ino},process:base,launcher:launcherSnapshot?.initial,argv,executable,expectedExecutable:config.chrome.executable,expectedArgv:config.chrome.argvForProfile?.(profile),environment,ownerEnvironment:config.ownerEnvironment,expectedProfileIdentity})}catch{return null}
  }
  function admit(pid,role,constraint={}){
    const old=[...records.values()].find(p=>p.pid===pid),base=proc(pid);
    if(old&&config.synthetic&&config.testFaults?.transientProcOnce&&points.length>=1&&role==='native'&&!transientInjected){transientInjected=true;old.current={status:'unreadable',errno:'EACCES',atUs:nowUs(),injected:true};old.transientFailureUs=nowUs();issue('proc-read','injected-EACCES');return null}
    if(base.status!=='live'){
      if(old){old.current={...base,atUs:nowUs()};old.absentChecks=base.status==='absent'?(old.absentChecks??0)+1:0}
      return null;
    }
    if(old&&base.startTicks!==old.startTicks){old.current={status:'identity-changed',atUs:nowUs()};return null}
    if(base.uid!==process.getuid())return null;
    try{
      const spec=role==='chrome'?config.chrome:role==='proxy'?config.proxy:config.native,p='/proc/'+pid,executable=readlinkSync(p+'/exe');
      if(executable!==spec.executable||!same(imageIdentity(p+'/exe'),spec.fileIdentity))return null;
      const argv=readFileSync(p+'/cmdline','utf8').split('\0').filter(Boolean);
      const expected=role==='chrome'?spec.argvForProfile?.(constraint.profile):spec.argv;
      if(role==='proxy'&&!expected&&!spec.argvCheck?.(argv))return null;
      if(expected&&!same(argv,expected))return null;
      if(!expected&&role==='chrome'&&!argv.includes('--user-data-dir='+constraint.profile))return null;
      if(constraint.parentPid&&base.ppid!==constraint.parentPid&&!old)return null;
      const env=readFileSync(p+'/environ','utf8').split('\0');
      for(const [key,value] of Object.entries(config.ownerEnvironment))if(!env.includes(key+'='+value))return null;
      if(role==='native'&&!env.includes('AGENT_BROWSER_DAEMON=1'))return null;
      const borrowed=constraint.borrowed===true||old?.borrowed===true;
      const profileIdentity=borrowed?borrowedIdentity(base,constraint.profile,argv,executable,env,old?.profileIdentity):null;
      if(borrowed&&!profileIdentity)return null;
      const item=old??{borrowed,profileIdentity,...base,role,executable,executableSha256:spec.sha256,executableFileIdentity:spec.fileIdentity,argv,profile:constraint.profile??null,firstObservedUs:nowUs(),absentChecks:0};
      item.current={...base,atUs:nowUs()};item.lastObservedUs=nowUs();item.absentChecks=0;
      if(item.transientFailureUs&&!item.recoveredUs)item.recoveredUs=nowUs();
      item.namespace=readlinkSync(p+'/ns/net');
      if(role==='native'&&!item.terminalFileOwnerObservation){
        for(const fd of readdirSync(p+'/fd'))try{const s=statSync(p+'/fd/'+fd),m=readFileSync(p+'/fdinfo/'+fd,'utf8').match(/^flags:\s+([0-7]+)/m);if(s.isFile()&&s.dev===config.terminalIdentity.dev&&s.ino===config.terminalIdentity.ino&&m&&(parseInt(m[1],8)&3)!==0){item.terminalFileOwnerObservation={fd:Number(fd),dev:s.dev,ino:s.ino,observedUs:nowUs(),startTicks:base.startTicks,writable:true};break}}catch{}
      }
      records.set(pid+':'+base.startTicks,item);return item;
    }catch(e){if(old)old.current={status:'unreadable',errno:e.code??'unknown',atUs:nowUs()};return null}
  }
  function discover(){
    const candidates=new Set([...records.values()].filter(p=>p.role==='native').map(p=>p.pid));
    try{for(const name of readdirSync(join(root,'s'))){if(!/^e2e-[a-f0-9-]{36}\.pid$/.test(name))continue;const path=join(root,'s',name),s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||s.nlink!==1||s.size>32||(s.mode&0o022))continue;const value=readFileSync(path,'utf8').trim();if(/^[1-9][0-9]*$/.test(value))candidates.add(Number(value))}}catch(e){issue('private-pid-read',e.code??'unknown')}
    const natives=[];for(const pid of candidates){const item=admit(pid,'native');if(item){natives.push(item);if(config.proxy&&item.ppid>1&&item.ppid!==child?.pid)admit(item.ppid,'proxy')}}
    let profiles=[];try{profiles=socketProfile(root,config.borrowedChrome===true)}catch(e){issue('profile-read',e.code??'unknown')}
    for(const item of records.values())if(item.role==='chrome'&&!profiles.some(p=>p.pid===item.pid))profiles.push({pid:item.pid,profile:item.profile,borrowed:item.borrowed});
    for(const candidate of profiles){const known=[...records.values()].some(p=>p.pid===candidate.pid&&p.role==='chrome');if(!candidate.borrowed&&!config.synthetic&&!known&&natives.length!==1)continue;admit(candidate.pid,'chrome',{profile:candidate.profile,borrowed:candidate.borrowed,parentPid:candidate.borrowed?undefined:config.synthetic?child?.pid:natives.length===1?natives[0].pid:undefined})}
    for(const item of records.values())if(item.role==='proxy')admit(item.pid,'proxy');
    // Failed reads retain last known identity, and successful later reads restore live state.
    inventory('monitor');
  }
  function pair(){const live=[...records.values()].filter(p=>p.current.status==='live'),a=live.filter(p=>p.role==='native'&&p.terminalFileOwnerObservation),b=live.filter(p=>p.role==='chrome');if(a.length!==1||b.length!==1)return null;
    const input=p=>({pid:p.pid,startTicks:p.startTicks,executable:p.executable,argv:p.argv,executableFileIdentity:p.executableFileIdentity});
    return{native:input(a[0]),chrome:input(b[0]),profile:b[0].profile};
  }
  function marker(){
    if(anchor)return;
    try{for(const line of readFileSync(config.markerFile,'utf8').split('\n').filter(Boolean)){let m;try{m=JSON.parse(line)}catch{continue}if(m.kind==='projected-original-marker'&&m.fact?.branch==='plain'&&m.fact?.stage==='register-invoked'&&Number.isSafeInteger(m.observedMonotonicUs)&&m.observedMonotonicUs>=startUs&&m.observedMonotonicUs<=nowUs()){anchor={kind:config.synthetic?'synthetic-register-shaped-marker':'projected-original-register-invoked',atUs:m.observedMonotonicUs,selectedUs:nowUs()};break}}}catch{}
    if(!anchor&&nowUs()-startUs>=5000000)anchor={kind:'runner-start-fallback',atUs:startUs,selectedUs:nowUs(),firstSlotMayBeLate:true};
  }
  function summary(){return{schemaVersion:1,anchor,planMs:plan,points,firstError,errors,launcherExit:exit,spawnError}}
  function recordPoint(point){
    // Durable inventory and a receipt precede the fallible append path.
    inventory('before-point-'+point.point,true);
    point.receiptSaved=save(join(root,'points',String(point.point).padStart(2,'0')+'.json'),point,'point-receipt-before');
    try{if(config.synthetic&&config.testFaults?.firstPointWrite&&point.point===1&&!pointWriteInjected){pointWriteInjected=true;const e=Error('injected first point append failure');e.code='EIO';throw e}
      appendFileSync(pointStream,JSON.stringify({anchor,...point})+'\n');point.jsonlSaved=true;
    }catch(e){point.jsonlSaved=false;point.writeError=issue('point-jsonl-write',e.code??e.name??'unknown')}
    point.finalReceiptSaved=save(join(root,'points',String(point.point).padStart(2,'0')+'.json'),point,'point-receipt-after');
    points.push(point);
    save(join(root,'state.json'),summary(),'state-write');
  }
  function tick(){
    discover();marker();if(!anchor||points.length===plan.length)return;
    const index=points.length,due=anchor.atUs+plan[index]*1000;if(nowUs()<due)return;
    const entered=nowUs(),owned=pair();
    const fault=config.synthetic?config.testFaults?.sampler?.[index+1]:null;
    const observation=owned?sampleCli(config,owned,fault):{schemaVersion:1,status:'unknown',reason:'no-unique-owned-process-pair'};
    if(observation.status==='unknown')issue('sampler-observation',observation.reason);
    recordPoint({point:index+1,scheduledOffsetMs:plan[index],scheduledUs:due,enteredUs:entered,finishedUs:nowUs(),actualSinceAnchorMs:(entered-anchor.atUs)/1000,observation,acquired:observation.status==='mapped',jsonlSaved:false});
  }
  const output=openSync(join(root,'program.stdout'),'wx',0o600),stderr=openSync(join(root,'program.stderr'),'wx',0o600);
  const signals=[];let extraResult=null;
  try{
    child=spawn(config.program.argv[0],config.program.argv.slice(1),{cwd:config.program.cwd,env:config.program.env,detached:true,stdio:['ignore',output,stderr]});
    // Register every event before the first /proc access. No interval callback can escape.
    child.once('error',e=>{spawnError={code:e.code??'unknown',atUs:nowUs()};issue('program-spawn',spawnError.code)});
    child.once('exit',(code,signal)=>{exit={code,signal,atUs:nowUs()}});
    child.once('close',(code,signal)=>{closed=true;if(!exit&&!spawnError)exit={code,signal,atUs:nowUs(),fromClose:true}});
    const initial=child.pid?proc(child.pid):{status:'not-started'};
    launcherSnapshot={pid:child.pid??null,spawnedByThisRunner:true,initial,argv:config.program.argv,spawnedUs:nowUs()};
    inventory('immediately-after-spawn',true);save(join(root,'state.json'),summary(),'initial-state-write');
    while(!exit&&!spawnError&&nowUs()-startUs<(config.outerMaxMs??45000)*1000){
      try{tick()}catch(e){issue('monitor-tick',e.code??e.name??'unknown');inventory('after-monitor-error',true)}
      if(config.synthetic&&config.afterThreePoints&&points.length===3&&!extraResult){try{extraResult=await config.afterThreePoints({pair,cli:(p,f)=>sampleCli(config,p,f),inventory:()=>inventory('extra-cli-check',true)});if(!extraResult)extraResult={completed:true}}catch(e){issue('synthetic-extra-check',e.code??e.name??'unknown');extraResult={failed:true,message:String(e.message)}}}
      await delay(50);
    }
    if(!exit&&!spawnError)issue('program-wait','outer-watchdog-expired');
  }catch(e){issue('runner-body',e.code??e.name??'unknown')}
  finally{
    finallyEntered=true;stop=true;
    // Observer failure never abandons an already launched program.
    const waitUntil=startUs+(config.outerMaxMs??45000)*1000;
    while(child&&!exit&&!spawnError&&nowUs()<waitUntil){try{discover()}catch{}await delay(50)}
    try{discover()}catch(e){issue('finally-discovery',e.code??'unknown')}
    for(const signal of ['SIGTERM','SIGKILL']){
      const targets=[];
      for(const record of records.values()){const current=proc(record.pid);if(current.status==='live'&&current.startTicks===record.startTicks&&current.uid===process.getuid())targets.push(record)}
      if(child?.pid&&!exit&&!spawnError&&launcherSnapshot.initial.status==='live')targets.push({pid:child.pid,startTicks:launcherSnapshot.initial.startTicks,role:'launcher'});
      if(!targets.length)break;
      for(const record of targets){const current=proc(record.pid);if(current.status!=='live'||current.startTicks!==record.startTicks)continue;
        try{if(record.role!=='launcher'){const p='/proc/'+record.pid;if(readlinkSync(p+'/exe')!==record.executable||!same(imageIdentity(p+'/exe'),record.executableFileIdentity)||!same(readFileSync(p+'/cmdline','utf8').split('\0').filter(Boolean),record.argv))continue;const env=readFileSync(p+'/environ','utf8').split('\0');if(!Object.entries(config.ownerEnvironment).every(([k,v])=>env.includes(k+'='+v)))continue;if(record.borrowed&&!borrowedIdentity(current,record.profile,record.argv,record.executable,env,record.profileIdentity))continue}
          process.kill(record.pid,signal);signals.push({pid:record.pid,startTicks:record.startTicks,signal,atUs:nowUs()});
        }catch(e){issue('owned-cleanup-signal',e.code??'unknown')}
      }
      await delay(signal==='SIGTERM'?400:200);try{discover()}catch{}
    }
    const closeLimit=nowUs()+1000000;while(child&&!closed&&nowUs()<closeLimit)await delay(10);
    // A temporary read failure is never a successful cleanup observation.
    for(let i=0;i<2;i++){try{discover()}catch{}if(i===0)await delay(50)}
    inventory('finally-complete',true);
    for(const fd of [output,stderr])try{closeSync(fd)}catch(e){issue('stdio-close',e.code??'unknown')}
  }
  const pending=plan.slice(points.length).map((ms,i)=>({point:points.length+i+1,scheduledOffsetMs:ms,status:'not-run',reason:'program-ended-before-scheduled-observation'}));
  const current=[...records.values()].map(p=>({pid:p.pid,startTicks:p.startTicks,status:p.current.status,absentChecks:p.absentChecks??0,transientFailureUs:p.transientFailureUs??null,recoveredUs:p.recoveredUs??null}));
  const cleanupKnown=current.every(p=>p.status==='terminal'||p.status==='absent'&&p.absentChecks>=2);
  const result={schemaVersion:1,queueSamplingEnabled:config.queueSampling!==false,synthetic:config.synthetic===true,startUs,endUs:nowUs(),finallyEntered,observationStopped:stop,launcher:launcherSnapshot,launcherExit:exit,spawnError,stdioClosed:closed,anchor,planMs:plan,points,notRun:pending,acquiredCount:points.filter(p=>p.acquired).length,jsonlSavedCount:points.filter(p=>p.jsonlSaved).length,receiptSavedCount:points.filter(p=>p.finalReceiptSaved).length,firstError,errors,extraResult,signals,currentKnownProcesses:current,knownCleanupConfirmed:cleanupKnown&&closed,allDescendantsCoverage:config.synthetic?'checked against fixture manifest by selftest':'unproven',protocolCleanup:'not established by process exit',applicationPayloadReadByObserver:0,CDPConnectionsOpened:0,ptrace:false};
  save(join(root,'result.json'),result,'final-result-write');
  return result;
}
