import json,pathlib,sys
root=pathlib.Path('evidence/native-trace'); expected=int(sys.argv[1]);files=sorted(root.glob('native-*.jsonl'));rows=[];errors=[]
if len(files)!=expected:errors.append(f'Expected {expected} process captures, got {len(files)}')
for p in files:
 data=p.read_bytes(); records=[json.loads(line) for line in data.splitlines()];started=any(x.get('phase')=='CaptureStarted' for x in records);limited=any(x.get('phase')=='CaptureLimitReached' for x in records)
 rows.append({'file':p.name,'bytes':len(data),'records':len(records),'captureStarted':started,'captureLimitReached':limited})
 if not records or not started:errors.append(p.name+': missing CaptureStarted')
 if len(data)>256*1024:errors.append(p.name+': byte bound exceeded')
(root/'capture-validation.json').write_text(json.dumps({'expectedProcesses':expected,'processes':rows,'errors':errors,'completeEvidence':not errors and not any(x['captureLimitReached'] for x in rows)},indent=2))
if errors:raise SystemExit('; '.join(errors))
