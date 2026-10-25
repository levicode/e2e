// Temporary D-only comparator. No source masks, native acceptance, payload logging or retry.
export const CAPTURE_PARAMS = Object.freeze({format: 'png', fromSurface: true});
const STATE = `({marker:window.recoveryWitness,input:document.querySelector('input[name=user]')?.value,session:sessionStorage.getItem('attempt'),local:localStorage.getItem('login'),cookie:document.cookie,width:innerWidth,height:innerHeight,visibility:document.visibilityState,focus:document.hasFocus()})`;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function tracked(promise) {
  const item = {state: 'pending', value: undefined};
  item.done = Promise.resolve(promise).then(value => { item.state='fulfilled'; item.value=value; }, () => { item.state='rejected'; });
  return item;
}
async function until(item, deadline, now) {
  const left=deadline-now();
  if (left<=0) throw new Error('deadline');
  let timer;
  try {
    await Promise.race([item.done, new Promise((_, reject) => { timer=setTimeout(()=>reject(new Error('deadline')),Math.ceil(left)); })]);
    if(now()>=deadline) throw new Error('deadline');
    if(item.state!=='fulfilled') throw new Error('request');
    return item.value;
  } finally { clearTimeout(timer); }
}
export function newDirectRecord() {
  return {schemaVersion:1,diagnosticOnly:true,originalP04Pass:false,nativeMaskEquivalent:false,
    sessionRoute:'oracle-direct-new-session',budgetMs:1000,cleanupBudgetMs:3000,calls:0,captureRequests:0,
    targetMatches:false,stateBeforeMatches:false,stateAfterMatches:false,background:false,visibility:'unknown',focus:null,rateBefore:null,
    rateZeroAck:false,captureStatus:'not-run',captureTerminal:'not-issued',captureElapsedMs:null,bytes:null,
    restoreAck:false,restoreReadback:false,detachAck:false,pendingRequests:null,cleanup:'unknown',invalid:false};
}
// Every started promise remains observed. A timed-out capture can never become a success.
// A rejected CDP promise may be a transport rejection, so it is not browser completion proof.
export async function directCapture(page, expected, record, now=()=>performance.now()) {
  record.calls++;
  if(record.calls!==1) { record.invalid=true; return; }
  const start=now(), deadline=start+1000, requests=[];
  let session, touched=false, capture, before;
  const begin = fn => { let promise; try { promise=fn(); } catch { promise=Promise.reject(new Error('request')); } const item=tracked(promise); requests.push(item); return item; };
  const send = (method,params,limit=deadline) => { if(now()>=limit) throw new Error('deadline'); return until(begin(()=>session.send(method,params)),limit,now); };
  try {
    session=await until(begin(()=>page.context().newCDPSession(page)),deadline,now);
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
    await send('Animation.setPlaybackRate',{playbackRate:0}); record.rateZeroAck=true;
    if(now()>=deadline) throw new Error('deadline');
    record.captureRequests++;
    capture=begin(()=>session.send('Page.captureScreenshot',CAPTURE_PARAMS));
    const result=await until(capture,deadline,now);
    if(typeof result.data!=='string'||result.data.length===0) throw new Error('payload');
    record.captureElapsedMs=now()-start;
    if(record.captureElapsedMs>=1000) throw new Error('deadline');
    record.bytes=Buffer.byteLength(result.data,'base64');
    record.captureStatus=record.bytes>0?'success':'error';
  } catch (cause) {
    record.captureStatus=cause?.message==='deadline'||now()>=deadline?'timeout':'error';
    record.captureElapsedMs=now()-start;
  } finally {
    const cleanupDeadline=now()+3000;
    if(session) {
      if(touched && record.rateBefore!==null) {
        try {
          await send('Animation.setPlaybackRate',{playbackRate:record.rateBefore},cleanupDeadline-100);
          record.restoreAck=true;
          record.restoreReadback=(await send('Animation.getPlaybackRate',undefined,cleanupDeadline-100)).playbackRate===record.rateBefore;
        } catch { /* Unknown is preserved; cleanup never extends screenshot success. */ }
      }
      if(capture?.state==='pending') { try { await until(capture,cleanupDeadline-100,now); } catch {} }
      if(before && now()<cleanupDeadline-100) {
        try { record.stateAfterMatches=same(before,(await send('Runtime.evaluate',{expression:STATE,returnByValue:true},cleanupDeadline-100)).result?.value); } catch {}
      }
      // Snapshot capture terminal BEFORE detach; detach rejection is not a Chrome reply.
      record.captureTerminal=capture?.state??'not-issued';
      try { if(now()>=cleanupDeadline) throw new Error('deadline'); await until(begin(()=>session.detach()),cleanupDeadline,now); record.detachAck=true; } catch {}
    }
    record.pendingRequests=requests.filter(item=>item.state==='pending').length;
    record.cleanup=record.restoreAck && record.restoreReadback && record.detachAck &&
      record.captureTerminal==='fulfilled' && record.pendingRequests===0 && record.stateAfterMatches?'confirmed':'unknown';
  }
}
export function validDirectResult(r) {
  const shape=newDirectRecord();
  if(!r || !same(Object.keys(r).sort(),Object.keys(shape).sort())) return false;
  return r.schemaVersion===1 && r.diagnosticOnly===true && r.originalP04Pass===false && r.nativeMaskEquivalent===false &&
    r.sessionRoute===shape.sessionRoute && r.budgetMs===1000 && r.cleanupBudgetMs===3000 && r.calls===1 && r.captureRequests===1 &&
    r.targetMatches===true && r.stateBeforeMatches===true && r.stateAfterMatches===true && ['visible','hidden'].includes(r.visibility) && typeof r.focus==='boolean' &&
    r.background===(r.visibility==='hidden' && r.focus===false) &&
    typeof r.rateBefore==='number' && Number.isFinite(r.rateBefore) && r.rateZeroAck===true &&
    r.captureStatus==='success' && r.captureTerminal==='fulfilled' && typeof r.captureElapsedMs==='number' &&
    Number.isFinite(r.captureElapsedMs) && r.captureElapsedMs>=0 && r.captureElapsedMs<1000 && Number.isSafeInteger(r.bytes) && r.bytes>0 &&
    r.restoreAck===true && r.restoreReadback===true && r.detachAck===true && r.pendingRequests===0 && r.cleanup==='confirmed' && r.invalid===false;
}
