import json,subprocess,pathlib,re,hashlib,sys
out=pathlib.Path('evidence/query-final-event-baseline');out.mkdir(parents=True,exist_ok=True)
harness=pathlib.Path('evidence/harness.path').read_text().strip()
listing=subprocess.run([harness,'--list','--format','terse'],capture_output=True,text=True,check=True).stdout
suffix='protected_query_dispatch_catches_final_event_without_content_replay'
names=[line[:-6] for line in listing.splitlines() if line.endswith(': test') and line[:-6].endswith('::'+suffix)]
assert len(names)==1,names
name=names[0]
result=subprocess.run([harness,'--exact',name,'--nocapture','--test-threads=1'],capture_output=True,text=True,timeout=120)
log=result.stdout+result.stderr;(out/'test.log').write_text(log)
counts=re.findall(r'test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;',log)
valid=len(counts)==1 and sum(map(int,counts[0][:2]))==1 and int(counts[0][2])==0
q={'source':pathlib.Path('native-harness/native-source.sha').read_text().strip(),'tree':pathlib.Path('native-harness/native-source.tree').read_text().strip(),'harnessSha256':hashlib.sha256(pathlib.Path(harness).read_bytes()).hexdigest(),'name':name,'exit':result.returncode,'counts':counts,'exactOneNoSkip':valid,'profile':'ci-test-fast','features':['acceptance-faults'],'outerTimeoutSeconds':120,'kind':'unfixed-baseline-counterexample','candidateAcceptance':False,'failureIsPreservedNotConvertedToSuccess':True}
(out/'result.json').write_text(json.dumps(q,indent=2));assert valid,q
sys.exit(result.returncode)
