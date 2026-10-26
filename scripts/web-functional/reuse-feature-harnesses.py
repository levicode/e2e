"""Strict prior-run binary reuse diagnostics; never a formal compilation receipt."""
import hashlib,json,os,pathlib,re,shutil,signal,subprocess,sys,urllib.request,zipfile
ROOT=pathlib.Path(os.environ['GITHUB_WORKSPACE']); OUT=ROOT/'evidence'; OUT.mkdir(exist_ok=True)
NATIVE='6e974b470e925c51b8452bdb66cfdcfbc310a471'; TREE='bedd7add22e5bbc77c4734bf00d95cecce8f2d2a'; RUN=40372992837; HEAD='f8bc474ea46db47e82a5c571d0423e8039b35130'
ARTIFACTS={'default':(12675660412,'all-default-native-harnesses','52142cb45e1e6afb7f67fb7acdb5403a8b1a41ff4236b958dd3153e2986416a3'),'feature':(12674332347,'optional-screenshot-fault-harness','186f3f75a9c2b9f691659f03a2d71929ea83f7f80b28c81f2a0b89daf3375168')}
def sha(p): return hashlib.file_digest(open(p,'rb'),'sha256').hexdigest()
def api(path):
 req=urllib.request.Request('https://api.github.com/repos/levicode/e2e/'+path,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json'})
 return json.load(urllib.request.urlopen(req,timeout=30))
def write(name,value): (OUT/name).write_text(json.dumps(value,indent=2)+'\n')
def git(arg): return subprocess.check_output(['git','-C',str(ROOT/'native'),'rev-parse',arg],text=True).strip()
assert git('HEAD')==NATIVE and git('HEAD^{tree}')==TREE
assert not subprocess.check_output(['git','-C',str(ROOT/'native'),'status','--porcelain'],text=True).strip()
r=api(f'actions/runs/{RUN}'); assert r['head_sha']==HEAD and r['status']=='completed'
for kind,(aid,name,digest) in ARTIFACTS.items():
 a=api(f'actions/artifacts/{aid}'); assert a['id']==aid and a['name']==name and not a['expired'] and a['digest']=='sha256:'+digest
 assert a['workflow_run']['id']==RUN and a['workflow_run']['head_sha']==HEAD
 z=ROOT/(kind+'.zip')
 subprocess.run(['curl','--fail','--silent','--show-error','--location','--retry','2','--max-time','180','-H','@-',f'https://api.github.com/repos/levicode/e2e/actions/artifacts/{aid}/zip','-o',str(z)],input='Authorization: Bearer '+os.environ['GH_TOKEN']+'\n',text=True,check=True)
 assert sha(z)==digest
 dest=ROOT/(kind+'-archive'); dest.mkdir()
 with zipfile.ZipFile(z) as zip:
  for info in zip.infolist():
   p=pathlib.PurePosixPath(info.filename); assert not p.is_absolute() and '..' not in p.parts and (info.external_attr>>16)&0o170000!=0o120000
  zip.extractall(dest)
 z.unlink(); write(kind+'-artifact-provenance.json',a)
m=json.loads((ROOT/'default-archive/manifest.json').read_text()); assert m['nativeSource']==NATIVE and m['nativeTree']==TREE and m['producerRun']==str(RUN)
assert m['manifestPath']==str(ROOT/'native/cli/Cargo.toml') and m['targetDir']==str(pathlib.Path(os.environ['RUNNER_TEMP'])/'native-regressions-target')
assert sha(ROOT/'native/cli/Cargo.lock')==m['cargoLockSha256']
for e in m['entries']:
 assert e['features']==['default']
 assert re.fullmatch(r'bins/[a-f0-9]{64}',e['archivePath'])
 src=ROOT/'default-archive'/e['archivePath']; assert sha(src)==e['sha256']
 dst=pathlib.Path(e['absolutePath']).resolve(); fixed_target=(pathlib.Path(os.environ['RUNNER_TEMP'])/'native-regressions-target').resolve(); assert dst.is_relative_to(fixed_target) and not dst.exists()
 dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst);dst.chmod(0o755)
unit=[e for e in m['entries'] if e['name']=='agent-browser' and e['isTest']];assert len(unit)==1
normal=pathlib.Path(unit[0]['absolutePath']); feature=ROOT/'feature-archive/agent-browser-tests'; feature.chmod(0o755)
f=ROOT/'feature-archive'
assert (f/'native-source.sha').read_text().strip()==NATIVE and (f/'native-source.tree').read_text().strip()==TREE
assert (f/'producer-run.id').read_text().strip()==str(RUN) and (f/'features.txt').read_text().strip()=='acceptance-faults'
subprocess.run(['sha256sum','-c','SHA256SUMS'],cwd=f,check=True)
write('reuse-binding.json',{'nativeSource':NATIVE,'nativeTree':TREE,'producerRun':RUN,'producerRecipe':HEAD,'currentRun':os.environ['GITHUB_RUN_ID'],'defaultHarnessSha256':sha(normal),'featureHarnessSha256':sha(feature),'formalCompilationReceipt':False,'formalAcceptance':False,'defaultFeatures':['default'],'featureFeatures':['acceptance-faults']})
inv=json.loads((pathlib.Path(__file__).parent/'feature-reuse-inventory.json').read_text())
def run(binary,args,seconds,stem,cleanup=False):
 env={k:v for k,v in os.environ.items() if k not in ('GH_TOKEN','GITHUB_TOKEN')}; env.update({'RUST_MIN_STACK':'16777216','CARGO_MANIFEST_DIR':str(ROOT/'native/cli')})
 if cleanup:
  path=OUT/(stem+'.cleanup.jsonl');fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.close(fd);env['AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE']=str(path)
 p=subprocess.Popen([str(binary),*args],cwd=ROOT/'native/cli',env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
 timed=False
 try: data,_=p.communicate(timeout=seconds)
 except subprocess.TimeoutExpired:
  timed=True;os.killpg(p.pid,signal.SIGKILL);data,_=p.communicate()
 finally:
  try: os.killpg(p.pid,signal.SIGKILL)
  except ProcessLookupError: pass
 (OUT/(stem+'.log')).write_bytes(data);write(stem+'.process.json',{'exitCode':p.returncode,'timedOut':timed,'timeoutSeconds':seconds,'formalProcessReceipt':False})
 return p.returncode,data.decode(errors='replace'),timed
def listing(binary,stem):
 code,text,timed=run(binary,['--list','--format=terse'],30,stem);assert code==0 and not timed
 names=re.findall(r'^([^\n]+): test$',text,re.M);assert len(names)==len(set(names));return set(names)
a=listing(normal,'default-list');b=listing(feature,'feature-list');delta=b-a;required=set(inv['REQUIRED_NATIVE_FEATURE_TESTS']);prep=inv['PREPARATION_SETTLEMENT_TESTS']
write('inventory-delta.json',{'defaultCount':len(a),'featureCount':len(b),'added':sorted(delta),'removed':sorted(a-b),'required':sorted(required),'verified':delta==required and not a-b})
assert delta==required and not a-b and len(required)==len(inv['REQUIRED_NATIVE_FEATURE_TESTS']) and set(prep)<=a
failed=False;results=[]
for mode,binary,names,timeout in [('feature',feature,inv['REQUIRED_NATIVE_FEATURE_TESTS'],180),('preparation',normal,prep,30)]:
 for i,name in enumerate(names,1):
  stem=f'{mode}-{i:02d}';code,text,timed=run(binary,[name,'--exact','--test-threads=1','--format=pretty','--color=never'],timeout,stem,True)
  counts=re.findall(r'test result: .*? (\d+) passed; (\d+) failed; (\d+) ignored;',text)
  passed=code==0 and not timed and counts==[('1','0','0')];failed|=not passed
  results.append({'name':name,'mode':mode,'exitCode':code,'timedOut':timed,'counts':counts,'passed':passed});write('results.json',{'results':results,'formalAcceptance':False,'rawCleanupNotValidated':True})
assert sha(normal)==unit[0]['sha256'];subprocess.run(['sha256sum','-c','SHA256SUMS'],cwd=f,check=True)
assert git('HEAD')==NATIVE and git('HEAD^{tree}')==TREE
sys.exit(1 if failed else 0)
