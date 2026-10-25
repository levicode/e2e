// Temporary D-only comparator. No source masks, native acceptance, payload logging or retry.
export const CAPTURE_PARAMS = Object.freeze({format: 'png', fromSurface: true});
const STATE = `({marker:window.recoveryWitness,input:document.querySelector('input[name=user]')?.value,session:sessionStorage.getItem('attempt'),local:localStorage.getItem('login'),cookie:document.cookie,width:innerWidth,height:innerHeight,visibility:document.visibilityState,focus:document.hasFocus()})`;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function tracked(promise, settled=()=>{}) {
  const item = {state: 'pending', value: undefined};
  item.done = Promise.resolve(promise).then(value => { item.state='fulfilled'; item.value=value; settled('fulfilled'); }, () => { item.state='rejected'; settled('rejected'); });
  return item;
}
async function until(item, deadline, now, timedOut=()=>{}) {
  const expired=()=>{timedOut();return new Error('deadline');};
  const left=deadline-now();
  if (left<=0) throw expired();
  let timer;
  try {
    await Promise.race([item.done, new Promise((_, reject) => { timer=setTimeout(()=>reject(expired()),Math.ceil(left)); })]);
    if(now()>=deadline) throw expired();
    if(item.state!=='fulfilled') throw new Error('request');
    return item.value;
  } finally { clearTimeout(timer); }
}
export function newDirectRecord(rateMode='zero') {
  return {schemaVersion:1,diagnosticOnly:true,originalP04Pass:false,nativeMaskEquivalent:false,
    sessionRoute:'oracle-direct-new-session',rateMode,requestedRate:null,budgetMs:1000,cleanupBudgetMs:3000,calls:0,captureRequests:0,
    targetMatches:false,stateBeforeMatches:false,stateAfterMatches:false,background:false,visibility:'unknown',focus:null,rateBefore:null,
    rateSetAck:false,captureCalledMs:null,captureFulfilledMs:null,captureRejectedMs:null,timeoutObservedMs:null,
    restoreCalledMs:null,restoreAckMs:null,restoreReadbackMs:null,captureStatus:'not-run',captureTerminal:'not-issued',captureElapsedMs:null,bytes:null,
    restoreAck:false,restoreReadback:false,detachAck:false,pendingRequests:null,cleanup:'unknown',invalid:false};
}
// Every started promise remains observed. A timed-out capture can never become a success.
// A rejected CDP promise may be a transport rejection, so it is not browser completion proof.
export async function directCapture(page, expected, record, now=()=>performance.now()) {
  record.calls++;
  if(record.calls!==1) { record.invalid=true; return; }
  const start=now(), deadline=start+1000, requests=[];
  let session, touched=false, capture, before, captureObservationClosed=false, observationClosed=false;
  // Milliseconds since helper entry. Calls mean API invocation, not wire delivery.
  const stamp=()=>{const value=now()-start;if(!Number.isFinite(value)||value<0||value>60_000){record.invalid=true;return null;}return value;};
  const timedOut=()=>{if(record.timeoutObservedMs===null)record.timeoutObservedMs=stamp();};
  const begin = (fn,settled) => { let promise; try { promise=fn(); } catch { promise=Promise.reject(new Error('request')); } const item=tracked(promise,settled); requests.push(item); return item; };
  const send = (method,params,limit=deadline,called=()=>{},settled=()=>{}) => {
    const timeout=limit===deadline?timedOut:()=>{};
    if(now()>=limit){timeout();throw new Error('deadline');}
    return until(begin(()=>{called();return session.send(method,params);},settled),limit,now,timeout);
  };
  try {
    if(!['zero','original'].includes(record.rateMode))throw new Error('rate-mode');
    session=await until(begin(()=>page.context().newCDPSession(page)),deadline,now,timedOut);
    const target=await send('Target.getTargetInfo');
    record.targetMatches=target.targetInfo?.targetId===expected.targetId;
    before=(await send('Runtime.evaluate',{expression:STATE,returnByValue:true})).result?.value;
    record.stateBeforeMatches=!!before && before.marker===expected.marker && before.input==='unsaved' &&
      before.session==='kept' && before.local==='kept' && before.cookie==='session=kept' && before.width===800 && before.height===600;
    record.visibility=['visible','hidden'].includes(before?.visibility)?before.visibility:'unknown';
    record.focus=typeof before?.focus==='boolean'?before.focus:null;
    record.background=record.visibility==='hidden' && record.focus===false;
    // Preserve the page's actual state; the original P04 does not promise background.
    if(!record.targetMatches || !record.stateBeforeMatches || record.visibility==='unknown' || record.focus===null) throw new Error('precondition');
    await send('Animation.enable');
    const {playbackRate}=await send('Animation.getPlaybackRate');
    if(typeof playbackRate!=='number'||!Number.isFinite(playbackRate)) throw new Error('rate');
    record.rateBefore=playbackRate;
    touched=true; // Journal before issue, including an unacknowledged set-rate command.
    record.requestedRate=record.rateMode==='zero'?0:record.rateBefore;
    await send('Animation.setPlaybackRate',{playbackRate:record.requestedRate}); record.rateSetAck=true;
    if(now()>=deadline){timedOut();throw new Error('deadline');}
    record.captureRequests++;
    capture=begin(()=>{record.captureCalledMs=stamp();return session.send('Page.captureScreenshot',CAPTURE_PARAMS);},state=>{
      if(!captureObservationClosed)record[state==='fulfilled'?'captureFulfilledMs':'captureRejectedMs']=stamp();
    });
    const result=await until(capture,deadline,now,timedOut);
    if(typeof result.data!=='string'||result.data.length===0) throw new Error('payload');
    record.captureElapsedMs=now()-start;
    if(record.captureElapsedMs>=1000){timedOut();throw new Error('deadline');}
    record.bytes=Buffer.byteLength(result.data,'base64');
    record.captureStatus=record.bytes>0?'success':'error';
  } catch (cause) {
    record.captureStatus=cause?.message==='deadline'||now()>=deadline?'timeout':'error';
    record.captureElapsedMs=now()-start;
    if(record.captureStatus==='timeout')timedOut();
  } finally {
    const cleanupDeadline=now()+3000;
    if(session) {
      if(touched && record.rateBefore!==null) {
        try {
          await send('Animation.setPlaybackRate',{playbackRate:record.rateBefore},cleanupDeadline-100,
            ()=>{record.restoreCalledMs=stamp();},state=>{if(!observationClosed&&state==='fulfilled')record.restoreAckMs=stamp();});
          record.restoreAck=true;
          record.restoreReadback=(await send('Animation.getPlaybackRate',undefined,cleanupDeadline-100,()=>{},state=>{if(!observationClosed&&state==='fulfilled')record.restoreReadbackMs=stamp();})).playbackRate===record.rateBefore;
        } catch { /* Unknown is preserved; cleanup never extends screenshot success. */ }
      }
      if(capture?.state==='pending') { try { await until(capture,cleanupDeadline-100,now); } catch {} }
      if(before && now()<cleanupDeadline-100) {
        try { record.stateAfterMatches=same(before,(await send('Runtime.evaluate',{expression:STATE,returnByValue:true},cleanupDeadline-100)).result?.value); } catch {}
      }
      // Snapshot capture terminal BEFORE detach; detach rejection is not a Chrome reply.
      record.captureTerminal=capture?.state??'not-issued'; captureObservationClosed=true;
      try { if(now()>=cleanupDeadline) throw new Error('deadline'); await until(begin(()=>session.detach()),cleanupDeadline,now); record.detachAck=true; } catch {}
    }
    record.pendingRequests=requests.filter(item=>item.state==='pending').length;
    record.cleanup=record.restoreAck && record.restoreReadback && record.detachAck &&
      record.captureTerminal==='fulfilled' && record.pendingRequests===0 && record.stateAfterMatches?'confirmed':'unknown';
    observationClosed=true;
  }
}
export function validDirectTiming(r) {
  const fields=['captureCalledMs','captureFulfilledMs','captureRejectedMs','timeoutObservedMs','restoreCalledMs','restoreAckMs','restoreReadbackMs'];
  if(!fields.every(key=>r[key]===null||(typeof r[key]==='number'&&Number.isFinite(r[key])&&r[key]>=0&&r[key]<=60_000)))return false;
  if(r.captureFulfilledMs!==null && r.captureRejectedMs!==null)return false;
  if(r.captureTerminal==='fulfilled'&&r.captureFulfilledMs===null)return false;
  if(r.captureTerminal==='rejected'&&r.captureRejectedMs===null)return false;
  if(['pending','not-issued'].includes(r.captureTerminal)&&(r.captureFulfilledMs!==null||r.captureRejectedMs!==null))return false;
  for(const key of ['captureFulfilledMs','captureRejectedMs'])if(r[key]!==null&&(r.captureCalledMs===null||r[key]<r.captureCalledMs))return false;
  if(r.restoreAckMs!==null&&(r.restoreCalledMs===null||r.restoreAckMs<r.restoreCalledMs))return false;
  if(r.restoreReadbackMs!==null&&(r.restoreAckMs===null||r.restoreReadbackMs<r.restoreAckMs))return false;
  return true; // No assumed relative order between capture reply and restoration.
}
export function validDirectResult(r) {
  const shape=newDirectRecord();
  if(!r || !same(Object.keys(r).sort(),Object.keys(shape).sort())) return false;
  return r.schemaVersion===1 && r.diagnosticOnly===true && r.originalP04Pass===false && r.nativeMaskEquivalent===false &&
    r.sessionRoute===shape.sessionRoute && ['zero','original'].includes(r.rateMode) && r.requestedRate===(r.rateMode==='zero'?0:r.rateBefore) && validDirectTiming(r) && r.budgetMs===1000 && r.cleanupBudgetMs===3000 && r.calls===1 && r.captureRequests===1 &&
    r.targetMatches===true && r.stateBeforeMatches===true && r.stateAfterMatches===true && ['visible','hidden'].includes(r.visibility) && typeof r.focus==='boolean' &&
    r.background===(r.visibility==='hidden' && r.focus===false) &&
    typeof r.rateBefore==='number' && Number.isFinite(r.rateBefore) && r.rateSetAck===true && r.captureCalledMs!==null && r.captureFulfilledMs!==null && r.captureRejectedMs===null && r.timeoutObservedMs===null &&
    r.captureFulfilledMs<1000 && r.restoreCalledMs!==null && r.restoreAckMs!==null && r.restoreReadbackMs!==null &&
    r.captureStatus==='success' && r.captureTerminal==='fulfilled' && typeof r.captureElapsedMs==='number' &&
    Number.isFinite(r.captureElapsedMs) && r.captureElapsedMs>=0 && r.captureElapsedMs<1000 && Number.isSafeInteger(r.bytes) && r.bytes>0 &&
    r.restoreAck===true && r.restoreReadback===true && r.detachAck===true && r.pendingRequests===0 && r.cleanup==='confirmed' && r.invalid===false;
}
