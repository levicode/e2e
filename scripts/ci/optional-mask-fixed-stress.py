import os,sys,pathlib,subprocess,json,re,time,signal
h=str(pathlib.Path(sys.argv[1]).resolve());out=pathlib.Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
names=json.loads(pathlib.Path(sys.argv[3]).read_text())
assert len(names)==2 and len(set(names))==2
alltests=subprocess.check_output([h,'--list'],text=True,timeout=30);ignored=subprocess.check_output([h,'--ignored','--list'],text=True,timeout=30)
for n in names:assert alltests.splitlines().count(n+': test')==1 and n+': test' not in ignored.splitlines()
(out/'all-tests.list').write_text(alltests);(out/'ignored-tests.list').write_text(ignored)
env={k:v for k,v in os.environ.items() if k not in ('GH_TOKEN','GITHUB_TOKEN','ACTIONS_RUNTIME_TOKEN')};results=[];start=time.monotonic()
for case,n in enumerate(names,1):
 for repetition in range(1,51):
  if time.monotonic()-start>=720:raise RuntimeError('fixed observation window exceeded; partial receipts retained')
  f=out/f'case-{case:02}-iteration-{repetition:02}.log';timed=False
  with f.open('w') as log:
   p=subprocess.Popen([h,n,'--exact','--test-threads=1','--nocapture'],stdout=log,stderr=subprocess.STDOUT,env=env,start_new_session=True)
   try:p.wait(timeout=min(30,720-(time.monotonic()-start)))
   except subprocess.TimeoutExpired:
    timed=True
    try:os.killpg(p.pid,signal.SIGTERM)
    except ProcessLookupError:pass
    try:p.wait(timeout=2)
    except subprocess.TimeoutExpired:
     try:os.killpg(p.pid,signal.SIGKILL)
     except ProcessLookupError:pass
     p.wait()
  s=f.read_text();m=re.findall(r'test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out',s)
  valid=len(m)==1 and int(m[0][1])+int(m[0][2])==1 and int(m[0][3])==0
  r=dict(selector=n,iteration=repetition,exit=p.returncode,timedOut=timed,exactOneNoIgnored=valid,passed=valid and p.returncode==0 and m[0][1]=='1',timingLines=[l for l in s.splitlines() if 'native-optional-mask-timing' in l],summary=m)
  r['timingRowCount']=len(r['timingLines']);r['timingMissing']=not r['timingLines'];r['passed']=r['passed'] and r['timingRowCount']==1
  results.append(r);(out/'results.json').write_text(json.dumps(dict(fixedIterationsPerCase=50,retries=0,notRootCauseClosure=True,results=results),indent=2))
assert len(results)==100
assert all(r['passed'] for r in results),'bounded stress observed failures; all receipts retained'
