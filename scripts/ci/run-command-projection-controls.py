import json,pathlib,subprocess,re,hashlib,os
out=pathlib.Path('evidence/command-projection');out.mkdir(parents=True,exist_ok=True)
h=pathlib.Path('evidence/harness.path').read_text().strip();listed=subprocess.check_output([h,'--list','--format','terse'],text=True)
suffixes=['object_command_cancelled_admission_currently_projects_browser_failure','object_command_real_hard_error_precedes_later_cancel'];results=[]
for suffix in suffixes:
 names=[l[:-6] for l in listed.splitlines() if l.endswith('::'+suffix+': test')];assert len(names)==1
 try:
  r=subprocess.run([h,'--exact',names[0],'--nocapture','--test-threads=1'],capture_output=True,text=True,timeout=120);text=r.stdout+r.stderr;code=r.returncode
 except subprocess.TimeoutExpired as error:
  text=(error.stdout or b'').decode() if isinstance(error.stdout,bytes) else (error.stdout or '');text+='\nOUTER_TIMEOUT\n';code=124
 (out/(suffix+'.log')).write_text(text);counts=re.findall(r'test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;',text);valid=len(counts)==1 and sum(map(int,counts[0][:2]))==1 and counts[0][2]=='0';results.append({'name':names[0],'exit':code,'counts':counts,'exactOneNoSkip':valid});print(text)
q={'source':os.environ['NATIVE_SOURCE_SHA'],'tree':os.environ['NATIVE_SOURCE_TREE'],'results':results,'harnessSha256':hashlib.sha256(pathlib.Path(h).read_bytes()).hexdigest(),'currentBehaviorCharacterizationOnly':True,'passingDoesNotFixPreviousFailure':True};(out/'result.json').write_text(json.dumps(q,indent=2));print(json.dumps(q));raise SystemExit(0 if len(results)==2 and all(x['exit']==0 and x['exactOneNoSkip'] for x in results) else 1)
