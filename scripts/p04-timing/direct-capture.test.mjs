import assert from 'node:assert/strict';
import {directCapture,newDirectRecord,validDirectResult,CAPTURE_PARAMS} from './direct-capture.mjs';
let count=0;
const expected={targetId:'same-target',marker:'same-document'};
const state={marker:expected.marker,input:'unsaved',session:'kept',local:'kept',cookie:'session=kept',width:800,height:600,visibility:'hidden',focus:false};
async function run(options={}) {
  const calls=[]; let rate=2, time=0;
  const session={async send(method,params){
    calls.push([method,params]);
    if(options.reject===method) throw Error('synthetic');
    if(method==='Target.getTargetInfo')return{targetInfo:{targetId:options.wrongTarget?'other':expected.targetId}};
    if(method==='Runtime.evaluate')return{result:{value:{...state,...options.state}}};
    if(method==='Animation.enable')return{};
    if(method==='Animation.getPlaybackRate')return{playbackRate:options.badReadback&&rate===2&&calls.some(c=>c[0]==='Page.captureScreenshot')?3:rate};
    if(method==='Animation.setPlaybackRate'){rate=params.playbackRate;return{};}
    if(method==='Page.captureScreenshot') {assert.deepEqual(params,{format:'png',fromSurface:true});if(options.late)time=1000;return{data:'cG5n'};}
    throw Error('unrecognized method');
  },async detach(){calls.push(['detach']);if(options.detachReject)throw Error('synthetic');}};
  const page={context:()=>({newCDPSession:async()=>session})},record=newDirectRecord();
  await directCapture(page,expected,record,()=>time);
  return{record,calls,page};
}
const positive=await run();assert.equal(validDirectResult(positive.record),true);count++;
assert.equal(positive.calls.filter(c=>c[0]==='Page.captureScreenshot').length,1);assert.equal(positive.record.rateBefore,2);count++;
for(const options of [{wrongTarget:true},{state:{visibility:'visible'}},{state:{focus:true}},{state:{input:'changed'}},{reject:'Page.captureScreenshot'},{badReadback:true},{detachReject:true},{late:true}]) {
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
console.log(JSON.stringify({pureControls:count,passed:true,browserExecuted:false}));
