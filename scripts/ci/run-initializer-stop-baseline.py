import json,subprocess,pathlib,re,hashlib,os
out=pathlib.Path('evidence/initializer-stop-baseline');out.mkdir(parents=True,exist_ok=True)
harness=pathlib.Path('evidence/harness.path').read_text().strip()
listing=subprocess.check_output([harness,'--list','--format','terse'],text=True)
suffixes=['component_network_prepare_owner_stop_is_retirement_not_poison', 'component_network_commit_owner_stop_is_retirement_not_poison', 'component_network_boundary_requested_stop_remains_failure', 'component_network_boundary_preexisting_failure_precedes_owner_stop', 'component_worker_ack_commit_owner_stop_keeps_retirement_clean', 'component_worker_ack_commit_requested_cancel_stays_failure', 'component_worker_ack_commit_network_failure_precedes_stop']
rows=[]
for index,suffix in enumerate(suffixes):
 names=[line[:-6] for line in listing.splitlines() if line.endswith(': test') and line[:-6].endswith('::'+suffix)];assert len(names)==1,names
 try:
  result=subprocess.run([harness,'--exact',names[0],'--nocapture','--test-threads=1'],capture_output=True,text=True,timeout=120);log=result.stdout+result.stderr;code=result.returncode
 except subprocess.TimeoutExpired as error:
  log=(error.stdout or b'').decode() if isinstance(error.stdout,bytes) else (error.stdout or '');log+='\nOUTER_TIMEOUT\n';code=124
 (out/f'{index+1}.log').write_text(log)
 counts=re.findall(r'test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;',log)
 valid=len(counts)==1 and sum(map(int,counts[0][:2]))==1 and int(counts[0][2])==0
 rows.append({'name':names[0],'exit':code,'counts':counts,'exactOneNoSkip':valid,'log':f'{index+1}.log','causalRedNotInferredFromExit':True})
q={'source':os.environ['NATIVE_SOURCE_SHA'],'tree':os.environ['NATIVE_SOURCE_TREE'],'harnessSha256':hashlib.sha256(pathlib.Path(harness).read_bytes()).hexdigest(),'results':rows,'expected':7,'baselineCharacterizationOnly':True}
(out/'results.json').write_text(json.dumps(q,indent=2));print(json.dumps(q));assert len(rows)==7 and all(x['exactOneNoSkip'] for x in rows)
raise SystemExit(1 if any(x['exit'] for x in rows) else 0)
