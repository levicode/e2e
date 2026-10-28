import json,subprocess,pathlib,re,hashlib,sys,os
out=pathlib.Path('evidence/query-final-stage');out.mkdir(parents=True,exist_ok=True)
harness=pathlib.Path('evidence/harness.path').read_text().strip()
listing=subprocess.run([harness,'--list','--format','terse'],capture_output=True,text=True,check=True).stdout
suffixes=['protected_query_dispatch_catches_final_event_without_content_replay']
candidate=os.environ['QUERY_PAIR_SIDE']=='candidate'
if candidate:suffixes+=['actual_query_commit_pending_preserves_staged_refs_and_retirement_fence']
rows=[]
for index,suffix in enumerate(suffixes):
 names=[line[:-6] for line in listing.splitlines() if line.endswith(': test') and line[:-6].endswith('::'+suffix)];assert len(names)==1,names
 name=names[0]
 try:
  result=subprocess.run([harness,'--exact',name,'--nocapture','--test-threads=1'],capture_output=True,text=True,timeout=120);log=result.stdout+result.stderr;code=result.returncode
 except subprocess.TimeoutExpired as error:
  log=(error.stdout or b'').decode() if isinstance(error.stdout,bytes) else (error.stdout or '');log+='\nOUTER_TIMEOUT\n';code=124
 (out/f'{index+1}.log').write_text(log)
 counts=re.findall(r'test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;',log)
 valid=len(counts)==1 and sum(map(int,counts[0][:2]))==1 and int(counts[0][2])==0
 phase=log.find('FINAL_QUERY_PHASE_STARTED phase=final-frames');pending=log.find('FINAL_QUERY_PREFIX_OBSERVED phase=final-frames command_ack_consumed=true');scope=log.find('ScopeUnavailable',max(0,pending))
 rows.append({'name':name,'exit':code,'counts':counts,'exactOneNoSkip':valid,'phaseStarted':phase>=0,'pendingObservedAfterPhase':pending>phase>=0,'causalBaselineRed':not candidate and code!=0 and pending>phase>=0 and scope>pending,'log':f'{index+1}.log'})
q={'source':pathlib.Path('native-harness/native-source.sha').read_text().strip(),'tree':pathlib.Path('native-harness/native-source.tree').read_text().strip(),'harnessSha256':hashlib.sha256(pathlib.Path(harness).read_bytes()).hexdigest(),'results':rows,'profile':'ci-test-fast','features':['acceptance-faults'],'outerTimeoutSeconds':120,'kind':'test-only-final-stage-paired-control','candidateSide':candidate,'fullAcceptance':False,'failureIsPreservedNotConvertedToSuccess':True}
(out/'result.json').write_text(json.dumps(q,indent=2))
for row in rows:
 if row['exit']!=0:sys.exit(row['exit'])
 if not row['exactOneNoSkip']:sys.exit(2)
 if row['name'].endswith('protected_query_dispatch_catches_final_event_without_content_replay') and not row['pendingObservedAfterPhase']:sys.exit(3)
