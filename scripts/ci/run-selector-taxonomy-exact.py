import pathlib,subprocess,re,json,hashlib,os
p=pathlib.Path('evidence/selector-taxonomy');p.mkdir(parents=True,exist_ok=True)
h=pathlib.Path('evidence/harness.path').read_text().strip();listing=subprocess.check_output([h,'--list','--format','terse'],text=True)
suffixes=['trailing_chain_syntax_keeps_engine_error_separate_from_capture','trailing_chain_syntax_is_backend_failure_not_capture_invalid_locator'];rows=[]
for suffix in suffixes:
 names=[l[:-6] for l in listing.splitlines() if l.endswith('::'+suffix+': test')];assert len(names)==1,names
 try:
  r=subprocess.run([h,'--exact',names[0],'--nocapture','--test-threads=1'],capture_output=True,text=True,timeout=120);text=r.stdout+r.stderr;code=r.returncode
 except subprocess.TimeoutExpired as e:
  text=str(e.stdout or '')+'\nOUTER_TIMEOUT';code=124
 (p/(suffix+'.log')).write_text(text);print(text);counts=re.findall(r'test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;',text);valid=len(counts)==1 and sum(map(int,counts[0][:2]))==1 and counts[0][2]=='0';rows.append({'name':names[0],'exit':code,'counts':counts,'exactOneNoSkip':valid})
result={'source':os.environ['NATIVE_SOURCE_SHA'],'tree':os.environ['NATIVE_SOURCE_TREE'],'tests':rows,'harnessSha256':hashlib.sha256(pathlib.Path(h).read_bytes()).hexdigest(),'budgetAssertionsAreNotIndependentTests':True};(p/'result.json').write_text(json.dumps(result,indent=2));raise SystemExit(0 if all(x['exit']==0 and x['exactOneNoSkip'] for x in rows) else 1)
