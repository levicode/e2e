import importlib.util,json,pathlib,tempfile,os,subprocess,hashlib,copy
ROOT=pathlib.Path(__file__).resolve().parents[2]
s=importlib.util.spec_from_file_location('collector',ROOT/'scripts/ci/collect-spec-on-action.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
schema=json.loads((ROOT/'scripts/ci/native-closed-trace-schema.json').read_text())
row={'schemaVersion':2,'source':'native','pid':123,'record':0,'operationSeq':0,'phase':'CaptureStarted','droppedBefore':0,'emittedBefore':0,'suppressedBefore':0,'overflow':False}
last={**row,'record':1,'emittedBefore':1,'phase':'TerminalCleanupCheckpoint','terminalCleanupStage':'shutdown-joins'}
def wire(rows):return b''.join(json.dumps(r,separators=(',',':')).encode()+b'\n' for r in rows)
count=0
def ok(v):
 global count
 assert v;count+=1
records,reasons=m.hung.inspect(wire([row,last]),schema);ok(len(records)==2 and not reasons)
for change in [{'secret':'NEVER_EXPORT_THIS'},{'phase':'unknown-secret'},{'pid':True},{'terminalCleanupStage':'private-text'},{'extra':{}},{'source':'proxy'}]:
 r={**row,**change};a,b=m.hung.inspect(wire([r,last]),schema);ok('invalid-record' in b and 'NEVER_EXPORT_THIS' not in json.dumps(a) and r not in a)
for r in [{**last,'record':4},{**last,'pid':124},{**last,'droppedBefore':1},{**last,'overflow':True}]:ok(bool(m.hung.inspect(wire([row,r]),schema)[1]))
ok('missing-shutdown-checkpoint' in m.hung.inspect(wire([row]),schema)[1]);ok('empty' in m.hung.inspect(b'',schema)[1])
ok(m.hung.inspect(wire([row])*2049,schema)==([],{'record-limit'}))
ok('invalid-record' in m.hung.inspect(wire([row]).rstrip(b'\n'),schema)[1])
ok('invalid-record' in m.hung.inspect(b'{"schemaVersion":2,"schemaVersion":2}\n',schema)[1])
ok('invalid-record' in m.hung.inspect(b' '*513+wire([row]),schema)[1])
with tempfile.TemporaryDirectory() as td:
 root=pathlib.Path(td);ws=root/'ws';ws.mkdir();raw=root/'raw';raw.mkdir(mode=0o700);ev=root/'evidence';ev.mkdir(mode=0o700)
 for k,p in m.BOUND_FILES.items():
  f=ws/p;f.parent.mkdir(parents=True,exist_ok=True)
  f.write_bytes((ROOT/p).read_bytes() if (ROOT/p).exists() else b'bound synthetic source\n')
 pin=ws/'.github/native-candidate.json';pin.parent.mkdir();pin.write_text(json.dumps({'commit':'1'*40}))
 binary=root/'binary';binary.write_bytes(b'SYNTHETIC NEVER EXECUTED')
 def git(*a):return subprocess.check_output(['git',*a],cwd=ws,text=True).strip()
 git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','fixture');git('add','.');git('commit','-qm','fixture')
 env={'GITHUB_SHA':git('rev-parse','HEAD'),'GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1','E2E_AGENT_BROWSER_EXECUTABLE':str(binary)}
 binding={'schemaVersion':1,'sourceCommit':env['GITHUB_SHA'],'sourceTree':git('rev-parse','HEAD^{tree}'),'run':'1','attempt':'1','nodeVersion':'v24.22.1','nativeCommit':'1'*40,'nativeSha256':m.hung.closed.sha(binary.read_bytes()),**{k:m.hung.closed.sha((ws/p).read_bytes()) for k,p in m.BOUND_FILES.items()}}
 (raw/'binding.json').write_text(json.dumps(binding));f=raw/'on-action-delayed.cleanup.jsonl';f.write_bytes(wire([row,last]))
 result=m.collect(ws,ev,raw,env);ok(result['status']=='observed' and result['releaseEligible'] is False and result['processCoverage']=='unproven' and result['noAbsenceInference'] is True)
 for key in ['sourceCommit','sourceTree','nativeCommit','nativeSha256',*m.BOUND_FILES]:
  bad={**binding,key:'9'*len(binding[key])};(raw/'binding.json').write_text(json.dumps(bad));ok(m.collect(ws,ev,raw,env)['reasons']==['binding-unavailable'])
 (raw/'binding.json').write_text(json.dumps(binding))
 f.write_bytes(wire([{**row,'secret':'NEVER_EXPORT_THIS'},last]));result=m.collect(ws,ev,raw,env);ok(result['status']=='unknown' and 'NEVER_EXPORT_THIS' not in json.dumps(result))
 f.write_bytes(b'x'*(m.hung.MAX_BYTES+1));ok(m.collect(ws,ev,raw,env)['reasons']==['capture-unavailable-or-byte-limit'])
 f.unlink();os.mkfifo(f,0o600);ok(m.collect(ws,ev,raw,env)['reasons']==['capture-unavailable-or-byte-limit']);f.unlink()
 outside=root/'outside';outside.write_bytes(wire([row,last]));f.symlink_to(outside);ok(m.collect(ws,ev,raw,env)['reasons']==['capture-unavailable-or-byte-limit']);f.unlink()
 f.write_bytes(wire([row,last]));alias=root/'alias';alias.symlink_to(raw,target_is_directory=True);ok(m.collect(ws,ev,alias,env)['reasons']==['binding-unavailable'])
 raw.chmod(0o755);ok(m.collect(ws,ev,raw,env)['reasons']==['binding-unavailable']);raw.chmod(0o700)
 ok(m.collect(ws,raw,raw,env)['reasons']==['binding-unavailable'])
 os.environ.update(env,GITHUB_WORKSPACE=str(ws),E2E_SPEC_EVIDENCE_DIR=str(ev),E2E_ON_ACTION_CAPTURE_DIR=str(raw));m.main();target=ev/'on-action-delayed.cleanup-diagnostics.json';ok(json.loads(target.read_bytes())['status']=='observed');before=target.read_bytes();m.main();ok(target.read_bytes()==before)
first={**row,'record':1,'emittedBefore':1,'phase':'ScreenshotFirstFailure','readError':{'geometry':'node-box-read'}}
end={**last,'record':2,'emittedBefore':2}
records,reasons=m.hung.inspect(wire([row,first,end]),schema)
ok(not reasons and records[1]['readError']=={'geometry':'node-box-read'})
print(json.dumps({'passed':count,'nativeExecuted':False,'browserExecuted':False,'syntheticOnly':True}))
