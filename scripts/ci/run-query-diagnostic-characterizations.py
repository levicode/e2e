import json,pathlib,subprocess,re,hashlib
p=pathlib.Path('evidence');h=(p/'harness.path').read_text().strip();names=[s[:-6] for s in subprocess.check_output([h,'--list'],text=True).splitlines() if s.endswith(': test')]
ends=['query_scope_diagnostics_are_closed_and_contain_no_target_payload', 'selected_query_own_world_event_pending_application_refuses_then_recovers', 'query_target_kind_distinguishes_exact_other_from_unrecognized_without_raw_values', 'query_lineage_refusal_reasons_are_distinct_closed_labels', 'restart_post_create_refusal_has_closed_bounded_schema', 'restart_post_create_facts_do_not_add_outcome_or_identity_authority'];rows=[]
for end in ends:
 matches=[n for n in names if n.endswith('::'+end)];assert len(matches)==1,(end,matches)
 name=matches[0];r=subprocess.run([h,name,'--exact','--nocapture'],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT);(p/(end+'.log')).write_text(r.stdout)
 summaries=re.findall(r'test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out',r.stdout)
 rows.append({'name':name,'exit':r.returncode,'summaries':summaries,'passed':r.returncode==0 and len(summaries)==1 and summaries[0][0:5]==('ok','1','0','0','0')})
(p/'characterization-result.json').write_text(json.dumps({'kind':'diagnostic-schema-and-modeled-event-characterization','productionAcceptance':False,'realChrome':False,'profile':'ci-test-fast','harnessSha256':hashlib.sha256(pathlib.Path(h).read_bytes()).hexdigest(),'results':rows},indent=2))
assert len(rows)==6 and all(r['passed'] for r in rows),rows
