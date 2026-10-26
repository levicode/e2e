"""One exact attempt per reviewed producer test; retain real exits and child binary identity."""
import hashlib,json,os,pathlib,subprocess,sys,time
harness=pathlib.Path(sys.argv[1]).resolve(); meta=json.loads(pathlib.Path(sys.argv[2]).read_text());out=pathlib.Path(sys.argv[3]).resolve()
chrome=pathlib.Path(meta['executablePath']).resolve(); digest=hashlib.sha256(chrome.read_bytes()).hexdigest();assert digest==meta['sha256']
version=subprocess.check_output([str(chrome),'--version'],text=True).strip();assert '156.' in version,version
names=['native::client_observation::equivalence_tests::chromium_twenty_controls_budget_and_frame_truncation_contract', 'native::client_observation::equivalence_tests::chromium_original_child_frame_budget_three_contract', 'native::client_observation::equivalence_tests::chromium_original_offsite_data_frame_budget_three_contract', 'native::client_observation::equivalence_tests::chromium_original_onsite_frame_depth_four_five_contract', 'native::client_observation::equivalence_tests::chromium_observation_frame_dfs_budget_eight_contract', 'native::client_observation::equivalence_tests::chromium_embedded_control_and_password_public_labels_contract', 'native::client_observation::equivalence_tests::chromium_observation_metadata_gc_and_exact_ref_actionability']
failed=False
for index,name in enumerate(names,1):
 stem=out/f'producer-{index}';inventory=subprocess.run([str(harness),'--exact',name,'--ignored','--list'],capture_output=True,text=True)
 stem.with_suffix('.inventory').write_text(inventory.stdout+inventory.stderr)
 if inventory.returncode or inventory.stdout.splitlines().count(name+': test')!=1:raise SystemExit('Exact producer test missing')
 cleanup=stem.with_suffix('.cleanup.jsonl');fd=os.open(cleanup,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
 seen={}; started=time.monotonic()
 with stem.with_suffix('.log').open('w') as log:
  proc=subprocess.Popen([str(harness),'--exact',name,'--ignored','--nocapture','--test-threads=1'],stdout=log,stderr=subprocess.STDOUT,env={**os.environ,'AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE':str(cleanup),'RUST_MIN_STACK':'16777216'})
  while proc.poll() is None:
   table={}
   for entry in pathlib.Path('/proc').iterdir():
    if not entry.name.isdigit():continue
    try:
     fields=(entry/'stat').read_text().rsplit(')',1)[1].split();table[int(entry.name)]=int(fields[1])
    except (OSError,ValueError):pass
   descendants={proc.pid};changed=True
   while changed:
    before=len(descendants);descendants.update(pid for pid,parent in table.items() if parent in descendants);changed=len(descendants)>before
   for pid in descendants-{proc.pid}:
    try:
     exe=(pathlib.Path('/proc')/str(pid)/'exe').resolve(strict=True)
     if exe==chrome:seen[pid]={'pid':pid,'executablePath':str(exe),'sha256':digest,'version':version}
    except OSError:pass
   time.sleep(.01)
  code=proc.wait()
 remaining=[]
 for pid in seen:
  try:
   if (pathlib.Path('/proc')/str(pid)/'exe').resolve(strict=True)==chrome:remaining.append(pid)
  except OSError:pass
 receipt={'test':name,'attempt':1,'testExit':code,'durationSeconds':time.monotonic()-started,'observedDescendantBrowserBinaries':list(seen.values()),'remainingBrowserPids':remaining,'binaryUnchangedAfter':hashlib.sha256(chrome.read_bytes()).hexdigest()==digest,'formalAcceptance':False}
 stem.with_suffix('.identity.json').write_text(json.dumps(receipt,indent=2)+'\n');stem.with_suffix('.exit').write_text(str(code)+'\n')
 # Identity failure does not rewrite the original test exit or kill/modify its browser.
 if code or not seen or remaining or not receipt['binaryUnchangedAfter']:failed=True
sys.exit(1 if failed else 0)
