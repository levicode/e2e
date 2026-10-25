// Recipe-local adapter: original capture preparation and safe read, never formal acceptance.
import assert from 'node:assert/strict';
import {closeSync,constants,fstatSync,openSync,readFileSync,readSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {pins,requirePins} from './runtime.mjs';
import {createTimingInspector} from './collector-timing.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
const workspace=process.env.GITHUB_WORKSPACE,evidence=process.env.EVIDENCE_DIR;assert.ok(workspace&&evidence);requirePins();
const formal=path.join(workspace,'e2e-source/scripts/acceptance/candidate-cleanup-diagnostics.ts');
assert.equal(digest(readFileSync(formal)),pins.formalCollectorSha256);
assert.equal(digest(readFileSync(new URL('./collector-timing.mjs',import.meta.url))),pins.collectorSha256);
const{prepareCleanupCapture,validCleanupRecord,CLEANUP_BYTES}=await import(pathToFileURL(formal));
const file=path.join(evidence,'P04.capture-binding.json');
if(process.argv[2]==='prepare'){
  const binding={sourceRevision:pins.e2eSha,nativeSourceRevision:pins.nativeSha,testSourceDigest:pins.p04SourceSha256,binarySha256:pins.production.binarySha256,collectorSha256:pins.collectorSha256};
  const capture=prepareCleanupCapture(binding,{});
  writeFileSync(file,JSON.stringify(capture,null,2)+'\n',{flag:'wx',mode:0o600});
}else if(process.argv[2]==='collect'){
  let result;
  try{
    const capture=JSON.parse(readFileSync(file));
    assert.deepEqual(capture.binding,{sourceRevision:pins.e2eSha,nativeSourceRevision:pins.nativeSha,testSourceDigest:pins.p04SourceSha256,binarySha256:pins.production.binarySha256,collectorSha256:pins.collectorSha256});
    const fd=openSync(capture.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let bytes;
    try{
      const stat=fstatSync(fd);
      if(!stat.isFile()||stat.dev!==capture.device||stat.ino!==capture.inode||stat.size>CLEANUP_BYTES)throw Error('Unsafe cleanup evidence');
      const buffer=Buffer.alloc(CLEANUP_BYTES+1),length=readSync(fd,buffer,0,buffer.length,0);bytes=buffer.subarray(0,length);
      const after=fstatSync(fd);
      if(bytes.length!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('Changing cleanup evidence');
    }finally{closeSync(fd);}
    writeFileSync(path.join(evidence,'P04.native.jsonl'),bytes,{flag:'wx',mode:0o600});
    result={...createTimingInspector(validCleanupRecord)(bytes),binding:capture.binding,caseAssociation:'single original P04 invocation; selected operation not independently attributed',processCoverage:'sampled observer only'};
  }catch{result={schemaVersion:1,status:'unknown',reasons:['collection-unavailable'],diagnosticOnly:true,cleanupAcceptance:'unknown',releaseEligible:false};}
  writeFileSync(path.join(evidence,'P04.timing.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  // Completeness is a diagnostic checkpoint, never a replacement for P04/cleanup assertions.
  if(result.status!=='complete')process.exitCode=1;
}else throw Error('Closed capture command');
