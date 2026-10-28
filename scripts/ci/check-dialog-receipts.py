import pathlib,json
p=pathlib.Path('evidence/dialog-receipts');p.mkdir(exist_ok=True,parents=True);files=sorted(p.glob('dialog-*.jsonl'));items=[];errors=[]
for f in files:
 rows=[json.loads(l) for l in f.read_text().splitlines()];installed=any(r.get('phase')=='installed' for r in rows);ended=any(r.get('phase')=='attempt-ended' for r in rows);maxdrop=max([r.get('droppedBefore',0) for r in rows]+[0]);atcap=len(rows)>=32
 items.append({'file':f.name,'records':len(rows),'installed':installed,'attemptEnded':ended,'maxDroppedBefore':maxdrop,'atCap':atcap,'observedLoss':bool(maxdrop or atcap)})
 if not installed:errors.append(f.name+': missing installed row')
 if len(rows)>32:errors.append(f.name+': cap exceeded')
if not files:errors.append('No dialog receipt files')
(p/'validation.json').write_text(json.dumps({'files':items,'errors':errors,'completeEvidence':not errors and all(i['attemptEnded'] and not i['observedLoss'] for i in items),'absenceDoesNotProveSuccess':True,'diagnosticTimingMayChangeReproduction':True},indent=2));assert not errors,errors
