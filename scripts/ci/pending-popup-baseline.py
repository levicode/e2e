import json,os,pathlib,subprocess,hashlib,re
out=pathlib.Path('evidence');paths=set();finished=[]
for line in (out/'harness.jsonl').read_text().splitlines():
 r=json.loads(line)
 if r.get('reason')=='build-finished':finished.append(r.get('success'))
 if r.get('reason')=='compiler-artifact' and r.get('target',{}).get('name')=='agent-browser' and r.get('profile',{}).get('test') and r.get('features')==['acceptance-faults'] and r.get('executable'):paths.add(r['executable'])
assert finished==[True] and len(paths)==1
h=paths.pop();listed=subprocess.check_output([h,'--list'],text=True);(out/'test-list.txt').write_text(listed)
ends=['pending_popup_owned_retirement_does_not_poison_phase_one','pending_popup_requested_cancel_cannot_borrow_later_owner_retirement','pending_popup_hard_failure_survives_owner_retirement']
rows=[]
for i,end in enumerate(ends):
 names=[l[:-6] for l in listed.splitlines() if l.endswith('::'+end+': test')];assert len(names)==1,(end,names)
 r=subprocess.run([h,'--exact',names[0],'--nocapture','--test-threads=1'],capture_output=True,text=True,timeout=120)
 text=r.stdout+r.stderr;(out/(str(i+1)+'.log')).write_text(text)
 m=re.search(r'test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;',text)
 valid=m is not None and sum(map(int,m.groups()[:2]))==1 and int(m.group(3))==0
 rows.append(dict(name=names[0],exit=r.returncode,summary=m.groups() if m else None,exactOneNoSkip=valid))
result=dict(source=os.environ['NATIVE_SOURCE_SHA'],tree=os.environ['NATIVE_SOURCE_TREE'],harnessSha256=hashlib.sha256(pathlib.Path(h).read_bytes()).hexdigest(),results=rows)
(out/'results.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
assert all(x['exactOneNoSkip'] for x in rows),'execution count or skip mismatch'
raise SystemExit(1 if any(x['exit'] for x in rows) else 0)
