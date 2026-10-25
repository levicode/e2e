import assert from 'node:assert/strict';
import {directCapture,newDirectRecord,validDirectResult,validDirectTiming,CAPTURE_PARAMS} from './direct-capture.mjs';
let count=0;
const expected={targetId:'same-target',marker:'same-document'};
const state={marker:expected.marker,input:'unsaved',session:'kept',local:'kept',cookie:'session=kept',width:800,height:600,visibility:'hidden',focus:false};
async function run(options={}) {
  const calls=[]; let rate=2, time=0, stateReads=0;
  const session={async send(method,params){
    calls.push([method,params]);
    if(options.reject===method) throw Error('synthetic');
    if(method==='Target.getTargetInfo')return{targetInfo:{targetId:options.wrongTarget?'other':expected.targetId}};
    if(method==='Runtime.evaluate')return{result:{value:{...state,...options.state,...(stateReads++?options.stateAfter:{})}}};
    if(method==='Animation.enable')return{};
    if(method==='Animation.getPlaybackRate')return{playbackRate:options.badReadback&&rate===2&&calls.some(c=>c[0]==='Page.captureScreenshot')?3:rate};
    if(method==='Animation.setPlaybackRate'){rate=params.playbackRate;return{};}
    if(method==='Page.captureScreenshot') {assert.deepEqual(params,{format:'png',fromSurface:true});if(options.late)time=1000;return{data:'cG5n'};}
    throw Error('unrecognized method');
  },async detach(){calls.push(['detach']);if(options.detachReject)throw Error('synthetic');}};
  const page={context:()=>({newCDPSession:async()=>session})},record=newDirectRecord(options.rateMode);
  await directCapture(page,expected,record,()=>time);
  return{record,calls,page};
}
const positive=await run();assert.equal(validDirectResult(positive.record),true);count++;
assert.equal(positive.calls.filter(c=>c[0]==='Page.captureScreenshot').length,1);assert.equal(positive.record.rateBefore,2);count++;
for(const options of [{wrongTarget:true},{state:{visibility:'invalid'}},{state:{focus:'invalid'}},{state:{input:'changed'}},{reject:'Page.captureScreenshot'},{badReadback:true},{detachReject:true},{late:true}]) {
  const {record}=await run(options);assert.equal(validDirectResult(record),false);count++;
  if(options.late){assert.equal(record.captureStatus,'timeout');assert.equal(record.captureTerminal,'fulfilled');assert.equal(record.cleanup,'confirmed');count++;}
}
await directCapture(positive.page,expected,positive.record);assert.equal(positive.record.invalid,true);assert.equal(positive.record.captureRequests,1);count++;
for(const [key,value] of Object.entries({calls:2,captureRequests:0,restoreAck:false,restoreReadback:false,detachAck:false,captureStatus:'timeout',captureTerminal:'pending',cleanup:'unknown',originalP04Pass:true,nativeMaskEquivalent:true,pendingRequests:1,bytes:0,background:false,budgetMs:1001,captureElapsedMs:1000,rateBefore:null})) {
 const r=(await run()).record;r[key]=value;assert.equal(validDirectResult(r),false,key);count++;
}
const extra=(await run()).record;extra.extra=true;assert.equal(validDirectResult(extra),false);count++;
const missing=(await run()).record;delete missing.restoreAck;assert.equal(validDirectResult(missing),false);count++;
// Real bounded timeout ownership: timeout at1s; restore resolves the retained capture late.
{
 let finish;let rate=2;const record=newDirectRecord();
 const session={async send(method,params){
   if(method==='Target.getTargetInfo')return{targetInfo:{targetId:expected.targetId}};
   if(method==='Runtime.evaluate')return{result:{value:state}};
   if(method==='Animation.getPlaybackRate')return{playbackRate:rate};
   if(method==='Animation.enable')return{};
   if(method==='Animation.setPlaybackRate'){rate=params.playbackRate;if(rate===2)finish?.({data:'cG5n'});return{};}
   if(method==='Page.captureScreenshot')return new Promise(resolve=>{finish=resolve;});
 },async detach(){}};
 await directCapture({context:()=>({newCDPSession:async()=>session})},expected,record);
 assert.equal(record.captureStatus,'timeout');assert.equal(record.captureTerminal,'fulfilled');assert.equal(record.restoreReadback,true);assert.equal(record.cleanup,'confirmed');assert.equal(validDirectResult(record),false);count++;
}
// A never-replied capture is not made clean by detach rejecting its promise.
{
 let rejectCapture;let rate=2;const record=newDirectRecord();
 const session={async send(method,params){
   if(method==='Target.getTargetInfo')return{targetInfo:{targetId:expected.targetId}};
   if(method==='Runtime.evaluate')return{result:{value:state}};
   if(method==='Animation.getPlaybackRate')return{playbackRate:rate};
   if(method==='Animation.enable')return{};
   if(method==='Animation.setPlaybackRate'){rate=params.playbackRate;return{};}
   if(method==='Page.captureScreenshot')return new Promise((_,reject)=>{rejectCapture=reject;});
 },async detach(){rejectCapture(Error('session detached'));}};
 await directCapture({context:()=>({newCDPSession:async()=>session})},expected,record);
 assert.equal(record.captureStatus,'timeout');assert.equal(record.captureTerminal,'pending');assert.equal(record.restoreReadback,true);assert.equal(record.detachAck,true);assert.equal(record.cleanup,'unknown');assert.equal(validDirectResult(record),false);count++;
}
// Foreground is an observed state, not a reason to skip the sole capture.
for(const foreground of [{visibility:'visible',focus:true},{visibility:'visible',focus:false},{visibility:'hidden',focus:true}]) {
 const {record,calls}=await run({state:foreground});assert.equal(validDirectResult(record),true);assert.equal(record.captureRequests,1);
 assert.equal(record.visibility,foreground.visibility);assert.equal(record.focus,foreground.focus);
 assert.equal(calls.filter(c=>c[0]==='Page.captureScreenshot').length,1);count++;
}
for(const change of [{visibility:'visible'},{focus:true},{input:'changed'}]) {
 const {record}=await run({stateAfter:change});assert.equal(record.captureRequests,1);assert.equal(record.captureStatus,'success');
 assert.equal(record.stateAfterMatches,false);assert.equal(record.cleanup,'unknown');assert.equal(validDirectResult(record),false);count++;
}
for(const [key,value]of [['visibility','invalid'],['focus',null],['background',true]]) {
 const {record}=await run({state:{visibility:'visible',focus:true}});record[key]=value;assert.equal(validDirectResult(record),false);count++;
}
// Only the first set-rate argument differs; all CDP methods/other args stay identical.
{
 const zero=await run(),original=await run({rateMode:'original'});
 assert.equal(validDirectResult(original.record),true);assert.equal(original.record.rateBefore,2);assert.equal(original.record.requestedRate,2);
 const a=structuredClone(zero.calls),b=structuredClone(original.calls),index=a.findIndex(c=>c[0]==='Animation.setPlaybackRate');
 assert.equal(a[index][1].playbackRate,0);assert.equal(b[index][1].playbackRate,2);a[index][1].playbackRate=2;assert.deepEqual(a,b);
 assert.deepEqual(b.filter(c=>c[0]==='Animation.setPlaybackRate').map(c=>c[1].playbackRate),[2,2]);count++;
}
for(const position of ['before','during','after']) {
 let clock=0,rate=2,sets=0,finish;const record=newDirectRecord();
 const session={send(method,params){
  if(method==='Target.getTargetInfo')return{targetInfo:{targetId:expected.targetId}};
  if(method==='Runtime.evaluate')return{result:{value:state}};
  if(method==='Animation.enable')return{};
  if(method==='Animation.getPlaybackRate') {
   if(sets===2&&position==='after')return{then(resolve){resolve({playbackRate:rate});queueMicrotask(()=>finish({data:'cG5n'}));}};
   return{playbackRate:rate};
  }
  if(method==='Animation.setPlaybackRate'){rate=params.playbackRate;sets++;if(sets===2&&position==='during')finish({data:'cG5n'});return{};}
  if(method==='Page.captureScreenshot'){clock=1000;if(position==='before')return{data:'cG5n'};return new Promise(resolve=>{finish=resolve;});}
 },detach(){}};
 await directCapture({context:()=>({newCDPSession:()=>session})},expected,record,()=>clock++);
 assert.equal(record.captureStatus,'timeout');assert.equal(record.captureTerminal,'fulfilled');assert.equal(record.cleanup,'confirmed');
 assert.equal(validDirectTiming(record),true);assert.equal(validDirectResult(record),false);assert.ok(record.timeoutObservedMs>=1000);
 if(position==='before')assert.ok(record.captureFulfilledMs<record.restoreCalledMs);
 if(position==='during')assert.ok(record.restoreCalledMs<record.captureFulfilledMs&&record.captureFulfilledMs<record.restoreAckMs);
 if(position==='after')assert.ok(record.restoreReadbackMs<record.captureFulfilledMs);
 count++;
}
const error=(await run({reject:'Page.captureScreenshot'})).record;
assert.equal(error.captureTerminal,'rejected');assert.equal(typeof error.captureRejectedMs,'number');assert.equal(error.captureFulfilledMs,null);assert.equal(validDirectTiming(error),true);assert.equal(validDirectResult(error),false);count++;
for(const [key,value]of [['captureCalledMs',null],['captureFulfilledMs',null],['captureRejectedMs',0],['timeoutObservedMs',1000],['restoreCalledMs',null],['restoreAckMs',null],['restoreReadbackMs',null],['requestedRate',2],['rateMode','invalid']]) {
 const {record}=await run();record[key]=value;assert.equal(validDirectResult(record),false,key);count++;
}
for(const mutation of [r=>{r.captureFulfilledMs=-1;},r=>{r.captureFulfilledMs=NaN;},r=>{r.captureFulfilledMs=60001;},r=>{r.captureCalledMs=10;r.captureFulfilledMs=5;},r=>{r.restoreCalledMs=10;r.restoreAckMs=5;},r=>{r.restoreAckMs=10;r.restoreReadbackMs=5;}]) {
 const {record}=await run();mutation(record);assert.equal(validDirectTiming(record),false);count++;
}
for(const terminal of ['pending','not-issued','rejected']){const {record}=await run();record.captureTerminal=terminal;assert.equal(validDirectTiming(record),false);count++;}
console.log(JSON.stringify({pureControls:count,passed:true,browserExecuted:false}));
