"""Exact 19 encoder contracts; same reviewed process sampler, no Chrome claim."""
import hashlib,json,os,pathlib,re,shutil,signal,subprocess,sys,time
def process_identity(pid):
 try:
  stat=(pathlib.Path('/proc')/str(pid)/'stat').read_text().rsplit(')',1)[1].split()
  return {'pid':pid,'startTime':int(stat[19]),'processGroup':int(stat[2]),'session':int(stat[3]),'executablePath':str((pathlib.Path('/proc')/str(pid)/'exe').resolve(strict=True))}
 except (OSError,ValueError,IndexError):return None

def same_process(identity):
 current=process_identity(identity['pid'])
 return current is not None and all(current[k]==identity[k] for k in ['startTime','executablePath','processGroup','session'])

def owned_members(owner):
 return [v for p in pathlib.Path('/proc').iterdir() if p.name.isdigit() for v in [process_identity(int(p.name))] if v and v['processGroup']==owner['pid'] and v['session']==owner['pid'] and v['startTime']>=owner['startTime']]

def stop_owned_group(proc,owner):
 # Only the new session created for this exact test, never an ambient process.
 for sig in [signal.SIGTERM,signal.SIGKILL]:
  if owned_members(owner):
   try:os.killpg(owner['pid'],sig)
   except ProcessLookupError:pass
  try:proc.wait(timeout=1)
  except subprocess.TimeoutExpired:pass
  until=time.monotonic()+1
  while owned_members(owner) and time.monotonic()<until:time.sleep(.01)
 if proc.poll() is None:proc.wait(timeout=1)
 return owned_members(owner)

harness=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
inventory=json.loads(pathlib.Path(sys.argv[3]).read_text());encoder_contracts=inventory['contracts'];encoder_names=[x['name'] for x in encoder_contracts];names=encoder_names;browser_names=[];required=[];additional=[];encoder_only=set();recording_two=''
assert len(names)==len(set(names))==19
encoder_requirements={x['name']:set(x['requires']) for x in encoder_contracts};assert all(x['browserIdentityRequired'] is False for x in encoder_contracts)
child_env={k:v for k,v in os.environ.items() if k not in {'GH_TOKEN','GITHUB_TOKEN','ACTIONS_RUNTIME_TOKEN'}}
# These fixtures own fresh processes. Unexpected ambient attachment is a setup failure.
for key in ['AGENT_BROWSER_CDP','AGENT_BROWSER_AUTO_CONNECT','AGENT_BROWSER_PROVIDER','AGENT_BROWSER_PROFILE']:
 if os.environ.get(key):raise SystemExit('Unexpected ambient browser attachment/profile: '+key)
chrome=None;digest=None;version=None
encoder_paths={k:pathlib.Path(shutil.which(k)).resolve() for k in ['ffmpeg','ffprobe']}; encoder_hashes={k:hashlib.sha256(v.read_bytes()).hexdigest() for k,v in encoder_paths.items()}; versions={k:{'path':str(encoder_paths[k]),'sha256':encoder_hashes[k],'version':subprocess.check_output([k,'-version'],text=True).splitlines()[0]} for k in encoder_paths};(out/'encoder-tools.json').write_text(json.dumps(versions,indent=2)+'\n')
listing=subprocess.run([str(harness),'--ignored','--list'],capture_output=True,text=True,timeout=30);(out/'native-ignored-inventory.log').write_text(listing.stdout+listing.stderr);assert listing.returncode==0
found=[x[:-6] for x in listing.stdout.splitlines() if x.endswith(': test')];assert len(found)==len(set(found))
missing=[x for x in names if x not in found];assert not missing,missing;failures=[];results=[]
for index,name in enumerate(names,1):
 stem=out/(f'encoder-contract-{encoder_names.index(name)+1:02}' if name in encoder_names else f'contract-{index:02}');timed_out=False;seen={};seen_encoders={};all_encoder_processes={};started=time.monotonic()
 exact=subprocess.run([str(harness),'--exact',name,'--ignored','--list'],capture_output=True,text=True,timeout=30);stem.with_suffix('.inventory').write_text(exact.stdout+exact.stderr)
 if exact.returncode or [x for x in exact.stdout.splitlines() if x.endswith(': test')]!=[name+': test']:
  failures.append(name+': expected exactly one test');continue
 cleanup=stem.with_suffix('.cleanup.jsonl');fd=os.open(cleanup,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
 proc=None;owner=None
 try:
  with stem.with_suffix('.log').open('w') as log:
   proc=subprocess.Popen([str(harness),'--exact',name,'--ignored','--test-threads=1','--nocapture'],start_new_session=True,cwd=pathlib.Path(os.environ['GITHUB_WORKSPACE'])/'native/cli',stdout=log,stderr=subprocess.STDOUT,env={**child_env,'AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE':str(cleanup),'RUST_MIN_STACK':'16777216'})
   owner=process_identity(proc.pid);assert owner and owner['session']==proc.pid and owner['processGroup']==proc.pid
   launched=time.monotonic()
   while proc.poll() is None:
    if time.monotonic()-launched>=180:
     timed_out=True;stop_owned_group(proc,owner)
     break
    table={}
    for entry in pathlib.Path('/proc').iterdir():
     if not entry.name.isdigit():continue
     try:table[int(entry.name)]=int((entry/'stat').read_text().rsplit(')',1)[1].split()[1])
     except (OSError,ValueError):pass
    descendants={proc.pid}
    while True:
     old=len(descendants);descendants.update(pid for pid,parent in table.items() if parent in descendants)
     if old==len(descendants):break
    for pid in descendants-{proc.pid}:
     try:
      exe=(pathlib.Path('/proc')/str(pid)/'exe').resolve(strict=True)
      if exe==chrome:seen[pid]={'pid':pid,'executablePath':str(exe),'sha256':digest,'version':version}
      for tool,path in encoder_paths.items():
       if exe==path:
        identity=process_identity(pid)
        if identity and identity['processGroup']==proc.pid and identity['session']==proc.pid:
         record={**identity,'sha256':encoder_hashes[tool],'version':versions[tool]['version'],'tool':tool};seen_encoders[tool]=record;all_encoder_processes[(pid,identity['startTime'])]=record
     except OSError:pass
    time.sleep(.01)
   code=proc.wait()
 except BaseException:
  if proc is not None and owner is not None:stop_owned_group(proc,owner)
  raise
 remaining_encoders=[v for v in all_encoder_processes.values() if same_process(v)]
 remaining_owned=owned_members(owner)
 after_cleanup=stop_owned_group(proc,owner) if remaining_owned else []
 remaining=[]
 for pid in seen:
  try:
   if (pathlib.Path('/proc')/str(pid)/'exe').resolve(strict=True)==chrome:remaining.append(pid)
  except OSError:pass
 counts=re.findall(r'test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;',stem.with_suffix('.log').read_text())
 unchanged=True
 receipt={'name':name,'kind':'encoder-contract' if name in encoder_names else 'original-required' if name in required else 'additional-required','attempt':1,'exitCode':code,'timedOut':timed_out,'outerTimeoutSeconds':180,'counts':counts,'observedDescendantEncoderBinaries':seen_encoders,'allObservedEncoderProcesses':list(all_encoder_processes.values()),'remainingEncoderProcesses':remaining_encoders,'remainingOwnedGroupBeforeCleanup':remaining_owned,'remainingOwnedGroupAfterCleanup':after_cleanup,'encoderBinariesUnchangedAfter':all(hashlib.sha256(v.read_bytes()).hexdigest()==encoder_hashes[k] for k,v in encoder_paths.items()),'observedDescendantBrowserBinaries':list(seen.values()),'remainingBrowserPids':remaining,'browserIdentityRequired':name not in encoder_only and name not in encoder_names,'binaryUnchangedAfter':unchanged,'durationSeconds':time.monotonic()-started}
 stem.with_suffix('.result.json').write_text(json.dumps(receipt,indent=2)+'\n');results.append(receipt)
 if code or timed_out or remaining_encoders or remaining_owned or after_cleanup or counts!=[('1','0','0')] or remaining or not unchanged or (name not in encoder_only and name not in encoder_names and not seen) or (name in encoder_only and set(seen_encoders)!=set(encoder_paths)) or (name==recording_two and 'ffmpeg' not in seen_encoders) or (name in encoder_names and not encoder_requirements[name]<=set(seen_encoders)) or not receipt['encoderBinariesUnchangedAfter']:failures.append(name+': failed test or evidence')
 (out/'progress.json').write_text(json.dumps({'results':results,'failures':failures,'releaseEligible':False,'harnessSha256':hashlib.sha256(harness.read_bytes()).hexdigest(),'features':['acceptance-faults']},indent=2)+'\n')
(out/'contracts.result.json').write_text(json.dumps({'required':required,'additional':additional,'excludedDiagnostics':[],'results':[r for r in results if r['name'] in browser_names],'failures':[f for f in failures if not any(f.startswith(n+':') for n in encoder_names)],'releaseEligible':False,'harnessSha256':hashlib.sha256(harness.read_bytes()).hexdigest(),'features':['acceptance-faults']},indent=2)+'\n')
(out/'encoder-contracts.result.json').write_text(json.dumps({'category':'managed-and-component-real-encoder-plus-codec-negative','required':encoder_contracts,'results':[r for r in results if r['name'] in encoder_names],'failures':[f for f in failures if any(f.startswith(n+':') for n in encoder_names)],'browserIdentityRequired':False,'releaseEligible':False,'harnessSha256':hashlib.sha256(harness.read_bytes()).hexdigest(),'features':['acceptance-faults']},indent=2)+'\n')
sys.exit(1 if failures else 0)
