import json,pathlib,sys,hashlib,stat
root=pathlib.Path('evidence/native-trace');expected=int(sys.argv[1]);ordinary=sorted(root.glob('native-*.jsonl'));files=sorted(root.glob('query-*.jsonl'));rows=[];errors=[]
if len(files)!=expected:errors.append(f'Expected {expected} critical process captures, got {len(files)}')
if {p.stem.removeprefix('query-') for p in files}!={p.stem.removeprefix('native-') for p in ordinary}:errors.append('Critical and ordinary process file sets differ')
for p in files:
 companion=p.with_name(p.name.replace('query-','native-',1))
 if p.is_symlink() or not stat.S_ISREG(p.lstat().st_mode):errors.append(p.name+': not regular')
 if companion.exists() and p.samefile(companion):errors.append(p.name+': aliases ordinary sink')
 data=p.read_bytes();records=[];invalid=0
 for line in data.splitlines():
  try:records.append(json.loads(line))
  except (ValueError,TypeError):invalid+=1
 started=any(x.get('phase')=='CaptureStarted' for x in records);limited=any(x.get('phase')=='CaptureLimitReached' for x in records)
 row={'file':p.name,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'records':len(records),'invalidLines':invalid,'captureStarted':started,'captureLimitReached':limited,'maxDroppedBefore':max([x.get('droppedBefore',0) for x in records]+[0]),'maxSuppressedBefore':max([x.get('suppressedBefore',0) for x in records]+[0]),'overflow':any(x.get('overflow') is True for x in records)}
 row['observedLoss']=bool(invalid or limited or row['maxDroppedBefore'] or row['maxSuppressedBefore'] or row['overflow']);rows.append(row)
 if not started:errors.append(p.name+': missing CaptureStarted')
 if invalid:errors.append(p.name+': malformed JSONL')
 if len(data)>64*1024:errors.append(p.name+': byte bound exceeded')
 if len(records)>129:errors.append(p.name+': record bound exceeded')
 if any(x.get('phase') not in ['CaptureStarted','QueryScopeRefusal','CaptureLimitReached'] for x in records):errors.append(p.name+': unexpected phase')
(root/'query-capture-validation.json').write_text(json.dumps({'expectedProcesses':expected,'recordBudget':128,'byteBudget':65536,'processes':rows,'errors':errors,'completeEvidence':not errors and not any(x['observedLoss'] for x in rows),'absenceDoesNotProveSuccess':True,'terminalUnreportedDropsMayBeUnobservable':True},indent=2))
if errors:raise SystemExit('; '.join(errors))
