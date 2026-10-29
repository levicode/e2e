"""One original full file, no retries or scheduling/budget/oracle overrides."""
import collections,hashlib,json,os,pathlib,stat,subprocess,sys,tempfile
D=pathlib.Path(__file__).resolve().parent;P=json.loads((D/'pins.json').read_text());suite=os.environ['E2E_SHORT_READ_SUITE'];assert suite in P['tests'];E=pathlib.Path('evidence');public=E/'diagnostic';public.mkdir();private=pathlib.Path(tempfile.mkdtemp(prefix='short-read-',dir=os.environ['RUNNER_TEMP']));custody=private/'custody';custody.mkdir(mode=0o700)
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def safe_file(p,maxbytes=16*1024*1024):
 s=p.lstat();assert stat.S_ISREG(s.st_mode) and not p.is_symlink() and s.st_size<=maxbytes;return p.read_bytes()
# Exactly the frozen synthetic fixture forms. Never print values or recursively scan a tree.
token='Tok-9f3aC0DeB1e7';note='first line 4417\nsecond line Qx';forms=[x.encode() for x in [token,token.upper(),token.lower(),note,note.replace('\n',' '),json.dumps(note)[1:-1]]]
forms += [json.dumps(x.decode(),ensure_ascii=False)[1:-1].encode() for x in forms]
def publish(p,dest,maxbytes=16*1024*1024):
 data=safe_file(p,maxbytes)
 if any(x in data for x in forms):return 'redaction-refused'
 with dest.open('xb') as f:f.write(data)
 return 'captured'
env=dict(os.environ);env['E2E_SHORT_READ_CUSTODY_DIR']=str(custody)
for x in ['GH_TOKEN','GITHUB_TOKEN','ACTIONS_RUNTIME_TOKEN','AI_GATEWAY_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','E2E_PLATFORM_HANDLER_DIAGNOSTIC','AGENT_BROWSER_ACCEPTANCE_PHASE_FILE','AGENT_BROWSER_DEBUG']:env.pop(x,None)
for kind in ['cleanup','query']:
 p=private/('native-'+kind+'.jsonl');p.touch(mode=0o600,exist_ok=False);env['AGENT_BROWSER_'+kind.upper()+'_DIAGNOSTIC_FILE']=str(p)
identity={'schema':1,'suite':suite,'diagnosticConsumerRun':os.environ['GITHUB_RUN_ID'],'diagnosticConsumerAttempt':os.environ['GITHUB_RUN_ATTEMPT'],'sourceCommit':P['sourceCommit'],'sourceTree':P['sourceTree'],'helperHashes':P['custodyHelperHashes'],'buildProducer':json.loads((E/'build-producer.json').read_text()),'buildManifestSHA256':sha(E/'build-manifest.json'),'nativeProducer':json.loads((E/'ordinary-producer.json').read_text()),'nativeManifestSHA256':sha(E/'ordinary.manifest.json'),'actualBinarySHA256':sha(env['E2E_AGENT_BROWSER_EXECUTABLE']),'actualBrowserSHA256':sha(env['E2E_CHROMIUM_EXECUTABLE']),'browserVersion':subprocess.check_output([env['E2E_CHROMIUM_EXECUTABLE'],'--version'],text=True).strip(),'nodeVersion':subprocess.check_output(['node','--version'],text=True).strip(),'pnpmVersion':subprocess.check_output(['pnpm','--version'],text=True).strip()}
assert identity['actualBinarySHA256']=='399675a321e9f1286e05f477f65709e4002827729aff5779dce1bc55f3eb1a09';assert identity['actualBrowserSHA256']==P['browserSHA256'];assert identity['nodeVersion']=='v22.23.4' and identity['pnpmVersion']=='12.3.4'
(public/'identity.json').write_text(json.dumps(identity,indent=2)+'\n')
commands={};file='tests/integration/'+suite+'.test.ts'
def run(name,args):
 try:
  with (private/(name+'.log')).open('xb') as log:r=subprocess.run(args,env=env,stdout=log,stderr=subprocess.STDOUT)
  commands[name]=r.returncode
 except OSError:commands[name]=128
 return commands[name]
col=[];collectionState='not-completed'
try:
 listed=run('collection',['pnpm','--filter','e2e','exec','vitest','list',file,'--no-staticParse','--json='+str(private/'collection.json')])
 if listed==0:
  col=json.loads(safe_file(private/'collection.json'));assert len(col)==P['tests'][suite]['count'];assert all(x['file'].endswith('/packages/e2e/'+file) for x in col)
  collectionState='verified'
  run('test',['pnpm','--filter','e2e','run','test',file,'--reporter=verbose','--reporter=json','--outputFile.json='+str(private/'results.json')])
except Exception:collectionState='refused'
# No repeated command. Missing terminal outputs stay incomplete; never turn Unknown into timeout.
receipt={'schema':1,'suite':suite,'commands':commands,'listed':len(col) if isinstance(col,list) else 0,'collectionState':collectionState,'expected':P['tests'][suite]['count'],'privacy':{},'custody':'incomplete','collectionCoverage':False,'nativeTraceMeaning':'first-failure and completed-cleanup snapshots only; no exact release ACK proof'}
for name in ['collection.log','collection.json','test.log','results.json','native-cleanup.jsonl','native-query.jsonl']:
 p=private/name
 if p.exists():
  try:receipt['privacy'][name]=publish(p,public/name)
  except Exception:receipt['privacy'][name]='capture-refused'
 else:receipt['privacy'][name]='missing'
try:
 entries=list(custody.iterdir());assert len(entries)==1;f=entries[0];assert f.name.startswith('fixture-') and f.is_dir() and not f.is_symlink();assert {x.name for x in f.iterdir()}=={'custody.json','reports'}
 meta=json.loads(safe_file(f/'custody.json'));assert meta['status']=='captured' and meta['suite']==suite and meta['fixtureHash']==P['tests'][suite]['fixtureHash']
 assert (f/'reports').is_dir() and not (f/'reports').is_symlink();assert meta['schema']==1 and meta['representation']=='unmodified-outcome-report-json'
 report=f/'reports/report.json';assert sha(report)==meta['sha256'] and report.stat().st_size==meta['bytes'];assert {x.name for x in (f/'reports').iterdir()}=={'report.json'}
 out=public/f.name;out.mkdir();(out/'reports').mkdir();assert publish(report,out/'reports/report.json')=='captured';assert publish(f/'custody.json',out/'custody.json')=='captured';(out/'identity.json').write_text(json.dumps(identity,indent=2)+'\n');receipt['custody']='captured'
except Exception:receipt['custody']='incomplete'
try:
 r=json.loads(safe_file(private/'results.json'));actual=collections.Counter((f['name'],' > '.join(a['ancestorTitles']+[a['title']])) for f in r['testResults'] for a in f['assertionResults']);expected=collections.Counter((x['file'],x['name']) for x in col);receipt['collectionCoverage']=bool(col) and expected==actual;receipt['counts']={k:r.get(k) for k in ['numTotalTests','numPassedTests','numFailedTests','numPendingTests','numTodoTests']}
except Exception:pass
receipt['nativeTraceCapture']={}
for kind in ['cleanup','query']:
 try:
  rows=[json.loads(x) for x in safe_file(private/('native-'+kind+'.jsonl')).splitlines()];pids={x['pid'] for x in rows};started={x['pid'] for x in rows if x['phase']=='CaptureStarted'}
  loss=any(x.get('droppedBefore',0)>0 or x.get('suppressedBefore',0)>0 or x.get('overflow',False) or x['phase']=='CaptureLimitReached' for x in rows)
  receipt['nativeTraceCapture'][kind]={'records':len(rows),'processes':len(pids),'captureStartedForEveryObservedProcess':bool(pids) and pids==started,'observedLoss':loss,'interpretation':'missing events remain unknown; no terminal ACK inference'}
 except Exception:receipt['nativeTraceCapture'][kind]={'incomplete':True}
receipt['traceCaptureLossFree']=all(x.get('captureStartedForEveryObservedProcess') is True and x.get('observedLoss') is False for x in receipt['nativeTraceCapture'].values())
receipt['diagnosticComplete']=receipt['traceCaptureLossFree'] and receipt['collectionCoverage'] and receipt['custody']=='captured' and all(v=='captured' for v in receipt['privacy'].values());(public/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
sys.exit(0 if receipt['diagnosticComplete'] and commands.get('test')==0 else 1)
