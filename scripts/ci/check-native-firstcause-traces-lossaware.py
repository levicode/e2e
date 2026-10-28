import json,pathlib,sys,hashlib
root=pathlib.Path('evidence/native-trace');expected=int(sys.argv[1]);files=sorted(root.glob('native-*.jsonl'));rows=[];errors=[]
if len(files)!=expected:errors.append(f'Expected {expected} process captures, got {len(files)}')
for p in files:
 data=p.read_bytes();records=[];invalid=0
 for line in data.splitlines():
  try: records.append(json.loads(line))
  except (ValueError,TypeError): invalid+=1
 started=any(x.get('phase')=='CaptureStarted' for x in records);limited=any(x.get('phase')=='CaptureLimitReached' for x in records)
 row={'file':p.name,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'records':len(records),'invalidLines':invalid,'captureStarted':started,'captureLimitReached':limited,'maxDroppedBefore':max([x.get('droppedBefore',0) for x in records]+[0]),'maxSuppressedBefore':max([x.get('suppressedBefore',0) for x in records]+[0]),'overflow':any(x.get('overflow') is True for x in records)}
 row['observedLoss']=bool(invalid or limited or row['maxDroppedBefore'] or row['maxSuppressedBefore'] or row['overflow']);rows.append(row)
 if not records or not started:errors.append(p.name+': missing CaptureStarted')
 if invalid:errors.append(p.name+': malformed JSONL')
 if len(data)>256*1024:errors.append(p.name+': byte bound exceeded')
(root/'capture-validation.json').write_text(json.dumps({'expectedProcesses':expected,'processes':rows,'errors':errors,'completeEvidence':not errors and not any(x['observedLoss'] for x in rows),'absenceDoesNotProveSuccess':True},indent=2))
if errors:raise SystemExit('; '.join(errors))
