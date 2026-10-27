"""Exact44 existing contracts plus 13 separate encoder contracts; no blanket execution."""
import hashlib,json,os,pathlib,re,shutil,subprocess,sys,time
harness=pathlib.Path(sys.argv[1]).resolve(); meta=json.loads(pathlib.Path(sys.argv[2]).read_text());out=pathlib.Path(sys.argv[3]).resolve();out.mkdir(parents=True,exist_ok=True)
inventory=json.loads(pathlib.Path(sys.argv[4]).read_text());required=[x['name'] for x in inventory['names']];additional=inventory['additionalContracts'];browser_names=required+additional;encoder_contracts=inventory['encoderContracts'];encoder_names=[x['name'] for x in encoder_contracts];names=browser_names+encoder_names
assert len(required)==1 and len(browser_names)==len(set(browser_names))==1
assert len(encoder_names)==len(set(encoder_names))==0 and len(names)==len(set(names))==1
encoder_requirements={x['name']:set(x['requires']) for x in encoder_contracts};assert all(x['browserIdentityRequired'] is False for x in encoder_contracts)
encoder_only=set(inventory['encoderOnly']);assert len(encoder_only)==0
recording_two='native::client_browser::recording_attempt_tests::chromium_two_attempt_recording_late_old_completion_cannot_mutate_new_artifact'
# These fixtures own fresh processes. Unexpected ambient attachment is a setup failure.
for key in ['AGENT_BROWSER_CDP','AGENT_BROWSER_AUTO_CONNECT','AGENT_BROWSER_PROVIDER','AGENT_BROWSER_PROFILE']:
 if os.environ.get(key):raise SystemExit('Unexpected ambient browser attachment/profile: '+key)
chrome=pathlib.Path(meta['executablePath']).resolve();digest=hashlib.sha256(chrome.read_bytes()).hexdigest();assert digest==meta['sha256'];version=subprocess.check_output([str(chrome),'--version'],text=True).strip();assert '156.' in version
encoder_paths={k:pathlib.Path(shutil.which(k)).resolve() for k in ['ffmpeg','ffprobe']}; encoder_hashes={k:hashlib.sha256(v.read_bytes()).hexdigest() for k,v in encoder_paths.items()}; versions={k:{'path':str(encoder_paths[k]),'sha256':encoder_hashes[k],'version':subprocess.check_output([k,'-version'],text=True).splitlines()[0]} for k in encoder_paths};(out/'encoder-tools.json').write_text(json.dumps(versions,indent=2)+'\n')
listing=subprocess.run([str(harness),'--ignored','--list'],capture_output=True,text=True,timeout=30);(out/'native-ignored-inventory.log').write_text(listing.stdout+listing.stderr);assert listing.returncode==0
found=[x[:-6] for x in listing.stdout.splitlines() if x.endswith(': test')];assert len(found)==len(set(found))
unknown=[] # This diagnostic selects one exact contract, not full inventory acceptance.;failures=['unclassified: '+x for x in unknown];results=[]
for index,name in enumerate(names,1):
 stem=out/(f'encoder-contract-{encoder_names.index(name)+1:02}' if name in encoder_names else f'contract-{index:02}');timed_out=False;seen={};seen_encoders={};started=time.monotonic()
 exact=subprocess.run([str(harness),'--exact',name,'--ignored','--list'],capture_output=True,text=True,timeout=30);stem.with_suffix('.inventory').write_text(exact.stdout+exact.stderr)
 if exact.returncode or [x for x in exact.stdout.splitlines() if x.endswith(': test')]!=[name+': test']:
  failures.append(name+': expected exactly one test');continue
 cleanup=stem.with_suffix('.cleanup.jsonl');fd=os.open(cleanup,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
 with stem.with_suffix('.log').open('w') as log:
  proc=subprocess.Popen([str(harness),'--exact',name,'--ignored','--test-threads=1','--nocapture'],cwd=pathlib.Path(os.environ['GITHUB_WORKSPACE'])/'native/cli',stdout=log,stderr=subprocess.STDOUT,env={**os.environ,'AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE':str(cleanup),'RUST_MIN_STACK':'16777216'})
  launched=time.monotonic()
  while proc.poll() is None:
   if time.monotonic()-launched>=180:
    timed_out=True;proc.terminate()
    try:proc.wait(timeout=1)
    except subprocess.TimeoutExpired:proc.kill();proc.wait()
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
      if exe==path:seen_encoders[tool]={'pid':pid,'executablePath':str(exe),'sha256':encoder_hashes[tool],'version':versions[tool]['version']}
    except OSError:pass
   time.sleep(.01)
  code=proc.wait()
 remaining=[]
 for pid in seen:
  try:
   if (pathlib.Path('/proc')/str(pid)/'exe').resolve(strict=True)==chrome:remaining.append(pid)
  except OSError:pass
 counts=re.findall(r'test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;',stem.with_suffix('.log').read_text())
 unchanged=hashlib.sha256(chrome.read_bytes()).hexdigest()==digest
 receipt={'name':name,'kind':'encoder-contract' if name in encoder_names else 'original-required' if name in required else 'additional-required','attempt':1,'exitCode':code,'timedOut':timed_out,'outerTimeoutSeconds':180,'counts':counts,'observedDescendantEncoderBinaries':seen_encoders,'encoderBinariesUnchangedAfter':all(hashlib.sha256(v.read_bytes()).hexdigest()==encoder_hashes[k] for k,v in encoder_paths.items()),'observedDescendantBrowserBinaries':list(seen.values()),'remainingBrowserPids':remaining,'browserIdentityRequired':name not in encoder_only and name not in encoder_names,'binaryUnchangedAfter':unchanged,'durationSeconds':time.monotonic()-started}
 stem.with_suffix('.result.json').write_text(json.dumps(receipt,indent=2)+'\n');results.append(receipt)
 if code or timed_out or counts!=[('1','0','0')] or remaining or not unchanged or (name not in encoder_only and name not in encoder_names and not seen) or (name in encoder_only and set(seen_encoders)!=set(encoder_paths)) or (name==recording_two and 'ffmpeg' not in seen_encoders) or (name in encoder_names and not encoder_requirements[name]<=set(seen_encoders)) or not receipt['encoderBinariesUnchangedAfter']:failures.append(name+': failed test or evidence')
 (out/'progress.json').write_text(json.dumps({'results':results,'failures':failures,'releaseEligible':False},indent=2)+'\n')
(out/'contracts.result.json').write_text(json.dumps({'required':required,'additional':additional,'excludedDiagnostics':inventory['diagnostics'],'results':[r for r in results if r['name'] in browser_names],'failures':[f for f in failures if not any(f.startswith(n+':') for n in encoder_names)],'releaseEligible':False},indent=2)+'\n')
(out/'encoder-contracts.result.json').write_text(json.dumps({'category':'fake-cdp-real-encoder-contract','required':encoder_contracts,'results':[r for r in results if r['name'] in encoder_names],'failures':[f for f in failures if any(f.startswith(n+':') for n in encoder_names)],'browserIdentityRequired':False,'releaseEligible':False},indent=2)+'\n')
sys.exit(1 if failures else 0)