import json,pathlib,subprocess,re,hashlib,os
p=pathlib.Path('evidence');h=(p/'harness.path').read_text().strip();names=[s[:-6] for s in subprocess.check_output([h,'--list'],text=True).splitlines() if s.endswith(': test')]
ends=['restart_page_ready_waits_exact_resume_release_not_unrelated_initializers', 'restart_page_ready_resume_release_wait_honors_independent_cancel', 'restart_page_ready_resume_release_wait_keeps_original_deadline', 'replacement_validation_rejects_snapshot_with_retained_resume_permit'];rows=[]
for end in ends:
 matches=[n for n in names if n.endswith('::'+end)];assert len(matches)==1,(end,matches)
 name=matches[0];r=subprocess.run([h,name,'--exact','--nocapture'],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT);(p/(end+'.log')).write_text(r.stdout)
 summaries=re.findall(r'test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out',r.stdout)
 rows.append({'name':name,'exit':r.returncode,'summaries':summaries,'passed':r.returncode==0 and len(summaries)==1 and summaries[0][0:5]==('ok','1','0','0','0')})
(p/'baseline-result.json').write_text(json.dumps({'kind':'unfixed-baseline-controls','productionAcceptance':False,'expectedGreen':False,'profile':'ci-test-fast','source':os.environ['NATIVE_SOURCE_SHA'],'harnessSha256':hashlib.sha256(pathlib.Path(h).read_bytes()).hexdigest(),'results':rows},indent=2))
assert len(rows)==4 and all(r['passed'] for r in rows),rows
