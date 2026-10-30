"""One original fixture, existing scalar diagnostics only. Never ordinary acceptance."""
import collections, hashlib, json, pathlib, shutil, sys
MAX_TEXT = 16 * 1024 * 1024
MAX_PHASE = 256 * 1024
SAFE = (1 << 53) - 1
FILE = 'tests/integration/web-popup-swipe-pair.test.ts'
TITLES = ('init scripts and partial media updates cover frames and new tabs', 'a path swipe drags and drops on the board')
NAMES = {'same-fixture popup and path-swipe diagnostic pair > ' + t for t in TITLES}
PREFIX = 'PAGE_URL_RESULT_DIAGNOSTIC '
COMMON = {'schemaVersion','source','pid','record','operationSeq','phase','droppedBefore','emittedBefore','suppressedBefore','overflow'}
NUMBERS = {'generation','daemonPid','length','total','calls','pendingBytes','frameBytes','consumedBytes'}
BOOLS = {'accepted','outstanding','seedKnown'}
ENUMS = {'effects': {'not-dispatched','completed','unknown'}, 'scopeState': {'usable','quarantined','closed'}, 'leg': {'to-native','from-native'}, 'messageKind': {'hello','request','cancel','decision','close'}, 'io': {'ok','eof','interrupted','would-block','broken-pipe','connection-reset','connection-aborted','not-connected','timed-out','unexpected-eof','write-zero','other'}}
# Exact efa7 settlement sink vocabulary, not arbitrary phase/error strings.
PHASES = set('CleanupStarted CleanupFirstFailure CleanupResult RestartPostCreateRefused ScopeReplacementRefused InventorySnapshot TargetAttribution TargetLifecycle TargetInventory TargetInventorySummary TargetObservationLost ScreenshotFirstFailure ProtectedCaptureFailure ObservationPixelResult FrameInventoryRejection ReadonlyPrepareFailure QueryScopeRefusal QueryReadFailure QueryCommandTiming QueryCommandSummary EvalAdmission UploadPreflightRefusal TerminalCleanupCheckpoint ServiceWorkerAdmission ExecuteStarted ExecuteReturned CancelObserved DeadlineObserved GraceReturned GraceExpired CompletionJoined ResultQueued ResultFlushed ControlFlushed CancelReceived CancelAccepted CancelRejected CancelQueued ReaderEnded ReaderRefused WriterFailed PublicationExpired HealthFailed CompletionLost ResultQueueFailed UnknownOutcome CloseReceived ControlQueueFailed ShutdownStarted ShutdownProven ShutdownUnproven PendingResultQueued CaptureLimitReached CaptureStarted ProxyDaemonSpawned PrefaceReturned CopyStarted CopyReturned SocketWriteEntered SocketWriteReturned SocketReadEntered SocketReadReturned InputHalfCloseEntered InputHalfCloseReturned OutputFlushEntered OutputFlushReturned ProxySummary FrameComplete FrameCleanEof FramePartialEof FrameIoError FrameOversize FrameParseRefused FrameDecoded FrameAdmissionRefused FrameSummary DetailLimit'.split())
ERRORS = set('invalid-frame unsupported-protocol unsupported-capability stale-generation scope-unavailable sequence-reused invalid-sequence invalid-timeout capacity-exceeded operation-missing decision-missing decision-expired decision-kind-mismatch registry-missing registry-in-use identifier-exhausted unsupported-command deadline-exceeded cancelled invalid-arguments invalid-locator browser-failure stale-scope cleanup-failed stale-reference policy-denied not-actionable locator-not-found content-length-mismatch redirect-body-unavailable intercepted-pointer checked-state-unchanged checked-control-replaced fill-unsupported-target no-editable-focus tap-target-replaced-before-press frame-not-found frame-ambiguous'.split())

def integer(v, low=0, high=SAFE):
    return type(v) is int and low <= v <= high

def pairs(items):
    out = {}
    for key, value in items:
        if key in out: raise ValueError('duplicate-key')
        out[key] = value
    return out

def decode(raw):
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))

def read(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_TEXT: raise ValueError('file-bound')
    return decode(path.read_bytes())

def collection(rows, root):
    expected = str((root / 'packages/e2e' / FILE).resolve())
    if not isinstance(rows,list) or len(rows) != 2: raise ValueError('collection-count')
    if any(not isinstance(r,dict) or set(r) != {'file','name','projectName'} or r['file'] != expected or r['projectName'] != 'integration' for r in rows): raise ValueError('collection-identity')
    if collections.Counter(r['name'] for r in rows) != collections.Counter(NAMES): raise ValueError('collection-titles')

def results(data, selected, command_exit):
    rows = [(f['name'], ' > '.join(a['ancestorTitles']+[a['title']]), a['status']) for f in data['testResults'] for a in f['assertionResults']]
    if collections.Counter((f,n) for f,n,_ in rows) != collections.Counter((r['file'],r['name']) for r in selected): raise ValueError('result-identity')
    if any(s not in ('passed','failed') for _,_,s in rows): raise ValueError('skip-or-retry')
    passed = sum(s=='passed' for _,_,s in rows); failed = len(rows)-passed
    if data['numTotalTests'] != 2 or data['numPassedTests'] != passed or data['numFailedTests'] != failed or data['numPendingTests'] != 0 or data.get('numTodoTests',0) != 0: raise ValueError('result-counts')
    if (command_exit == 0) != (failed == 0) or data['success'] != (failed == 0): raise ValueError('result-exit')
    return {'passed':passed,'failed':failed,'commandExit':command_exit,'byTitle':{n.split(' > ',1)[1]:status for _,n,status in rows}}

def phases(raw):
    if not raw or len(raw)>MAX_PHASE or not raw.endswith(b'\n'): raise ValueError('phase-file-bound')
    lines=raw.splitlines(keepends=True)
    if len(lines)>2048 or any(len(line)>512 or not line.endswith(b'\n') for line in lines): raise ValueError('phase-line-bound')
    rows=[]; issues=set(); groups=collections.defaultdict(list)
    for line in lines:
        row=decode(line)
        if not isinstance(row,dict) or not COMMON<=set(row) or set(row)-COMMON-NUMBERS-BOOLS-set(ENUMS)-{'error'}: raise ValueError('phase-keys')
        if row['schemaVersion'] != 2 or type(row['schemaVersion']) is not int or row['source'] not in ('native','proxy') or type(row['phase']) is not str or row['phase'] not in PHASES: raise ValueError('phase-enum')
        if not integer(row['pid'],1,(1<<32)-1) or type(row['overflow']) is not bool: raise ValueError('phase-common')
        if any(not integer(row[k]) for k in ('record','operationSeq','droppedBefore','emittedBefore','suppressedBefore')): raise ValueError('phase-counter')
        if any(not integer(row[k],1 if k in ('generation','daemonPid') else 0, (1<<32)-1 if k=='daemonPid' else SAFE) for k in NUMBERS & set(row)): raise ValueError('phase-number')
        if any(type(row[k]) is not bool for k in BOOLS & set(row)): raise ValueError('phase-bool')
        if any(type(row[k]) is not str or row[k] not in values for k,values in ENUMS.items() if k in row) or ('error' in row and (type(row['error']) is not str or row['error'] not in ERRORS)): raise ValueError('phase-fact-enum')
        if row['phase']=='ResultFlushed' and not {'generation','effects','scopeState'}<=set(row): raise ValueError('result-facts')
        if row['phase'] in ('CancelAccepted','CancelRejected') and not {'generation','accepted','scopeState'}<=set(row): raise ValueError('cancel-facts')
        if row['phase'] in ('CancelAccepted','CancelRejected') and row['accepted'] != (row['phase']=='CancelAccepted'): raise ValueError('cancel-facts')
        if row['phase']=='ProxyDaemonSpawned' and (row['source']!='proxy' or 'daemonPid' not in row): raise ValueError('spawn-facts')
        if row['overflow'] or row['droppedBefore'] or row['suppressedBefore'] or row['phase'] in ('CaptureLimitReached','DetailLimit'): issues.add('recorded-loss-or-limit')
        groups[row['source'],row['pid']].append(row); rows.append(row)
    for (source,pid), values in groups.items():
        if values[0]['phase']!='CaptureStarted' or values[0]['record']!=0: issues.add('missing-start')
        if any(v['record']!=i or v['emittedBefore']!=i for i,v in enumerate(values)): issues.add('physical-order-or-counter-gap')
        if not any(v['phase']==('FrameSummary' if source=='native' else 'ProxySummary') for v in values): issues.add('missing-end-observation')
    spawned=[(r['pid'],r['daemonPid']) for r in rows if r['phase']=='ProxyDaemonSpawned']
    proxies={pid for source,pid in groups if source=='proxy'}; natives={pid for source,pid in groups if source=='native'}
    if proxies & natives or len(spawned)!=len(proxies) or {p for p,n in spawned}!=proxies or {n for p,n in spawned}!=natives or len({n for p,n in spawned})!=len(spawned): issues.add('spawn-custody-ambiguous')
    return rows, sorted(issues), spawned

def url_diagnostics(text):
    # Exact native client stderr lines from the outer test log. These have no
    # attempt/PID/generation/op identity; report error/app text is never searched.
    if type(text) is not str: raise ValueError('url-diagnostic-log')
    out=[]
    for line in text.splitlines(keepends=True):
        if not line.startswith(PREFIX): continue
        if not line.endswith('\n'): raise ValueError('url-diagnostic-partial-line')
        row=decode(line[len(PREFIX):])
        if not isinstance(row,dict): raise ValueError('url-diagnostic-schema')
        if row.get('phase')=='capture-limit-reached': raise ValueError('url-diagnostic-limit')
        keys={'phase','command','transmittedTimeoutMs','selectedLocalCancel','rawCode','rawEffects','rawScopeState','returnedCode','timeoutRewritten','cancelAckSeen'}
        if set(row)!=keys or row['phase']!='settled-failure' or row['command']!='page.url' or not integer(row['transmittedTimeoutMs'],1): raise ValueError('url-diagnostic-schema')
        if row['selectedLocalCancel'] not in ('none','abort','deadline') or row['rawCode'] not in ERRORS or row['returnedCode'] not in ERRORS or row['rawEffects'] not in ENUMS['effects'] or row['rawScopeState'] not in ENUMS['scopeState'] or type(row['timeoutRewritten']) is not bool or type(row['cancelAckSeen']) is not bool: raise ValueError('url-diagnostic-facts')
        out.append(row)
    return out

def analyze(rows, issues, report, log_text, outer=None):
    if report.get('schemaVersion')!='report-1': raise ValueError('inner-schema')
    tests=report['run']['results']
    if len(tests)!=2 or collections.Counter(tuple(t['titlePath']) for t in tests)!=collections.Counter((t,) for t in TITLES): raise ValueError('inner-titles')
    if any(len(t['attempts'])!=1 or t.get('repeat')!=0 or t['attempts'][0]['index']!=0 for t in tests): raise ValueError('inner-retry')
    if any(t.get('status') not in ('passed','failed') or t['attempts'][0].get('status')!=t['status'] for t in tests): raise ValueError('inner-status')
    if outer is not None and outer.get('byTitle')!={t['titlePath'][0]:t['status'] for t in tests}: raise ValueError('outer-inner-status')
    url_steps=[(t,s) for t in tests for s in t['attempts'][0].get('steps',[]) if s.get('api')=='browser.url']
    if any(s.get('status') not in ('passed','failed','blocked','timed-out','cancelled') for _,s in url_steps): raise ValueError('url-step-status')
    # Exact StepRecorder taxonomy: CANCELLED is a cancelled step, while its
    # owning attempt/result fails. Never accept a status string without codes.
    for t,s in url_steps:
        code=s.get('error',{}).get('code')
        if (s['status']=='cancelled') != (code=='CANCELLED'): raise ValueError('url-step-cancel-code')
        if s['status']=='cancelled' and t['attempts'][0].get('error',{}).get('code')!='CANCELLED': raise ValueError('url-step-cancel-code')
    owners=[t for t,s in url_steps if s['status'] in ('failed','cancelled')]
    cancelled_owner=any(s['status']=='cancelled' for _,s in url_steps)
    if len(owners)>1 or any(t['status']!='failed' or t['titlePath']!=[TITLES[0]] for t in owners): raise ValueError('url-step-owner')
    url_failed=bool(owners)
    diag=url_diagnostics(log_text)
    result={'urlStepFailed':url_failed,'urlDiagnosticCount':len(diag),'attribution':'unknown','nativeCandidates':[],'issues':list(issues),'absenceIsProof':False,'typedCancelSignal':'not-recorded','ordinaryAcceptance':False,'urlDiagnosticSource':'outer-test-log-unowned','stderrAttemptIdentityProven':False}
    if any(t['attempts'][0].get('cleanup')!='complete' for t in tests): result['issues'].append('inner-cleanup-incomplete')
    if not url_failed:
        result['attribution']='not-reproduced' if all(t['status']=='passed' for t in tests) else 'different-failure'
        if diag: result['issues'].append('unexpected-url-diagnostic')
        return result
    if len(diag)!=1: result['issues'].append('missing-or-ambiguous-url-diagnostic'); return result
    d=diag[0]; result['urlDiagnostic']=d
    if cancelled_owner and (d['rawCode']!='cancelled' or d['returnedCode']!='cancelled' or d['timeoutRewritten']): result['issues'].append('url-cancel-diagnostic-mismatch'); return result
    candidates=[r for r in rows if r['source']=='native' and r['phase']=='ResultFlushed' and r.get('error')==d['rawCode'] and r.get('effects')==d['rawEffects'] and r.get('scopeState')==d['rawScopeState']]
    result['nativeCandidates']=[{k:r[k] for k in ('pid','generation','operationSeq')} for r in candidates]
    if len(candidates)!=1: result['issues'].append('nonunique-native-result'); return result
    c=candidates[0]
    same=[r for r in rows if r['source']=='native' and r['pid']==c['pid'] and r['operationSeq']==c['operationSeq']]
    if any('generation' in r and r['generation']!=c['generation'] for r in same): result['issues'].append('generation-ambiguous')
    result['observedPhases']=[r['phase'] for r in same]
    if not result['issues']: result['attribution']='conditional-unique-raw-result-match'
    return result

def archive(root, destination, steps):
    if destination.exists(): raise ValueError('artifact-destination-exists')
    destination.mkdir()
    selected={}
    for p in (root/'evidence').rglob('*'):
        if p.is_symlink(): raise ValueError('evidence-symlink')
        if p.is_file() and 'tools' not in p.relative_to(root/'evidence').parts:
            selected['evidence/'+str(p.relative_to(root/'evidence'))]=p
    source=root/'packages/e2e/.e2e/popup-swipe-pair'
    for p in source.rglob('*') if source.exists() else []:
        if p.is_symlink(): raise ValueError('fixture-symlink')
        if p.is_file() and p.suffix in ('.json','.jsonl','.log','.txt'):
            selected['original/'+str(p.relative_to(source))]=p
    if sum(p.stat().st_size for p in selected.values())>MAX_TEXT-65536: raise ValueError('text-artifact-over-limit')
    for name,p in selected.items():
        p.read_text(encoding='utf8')
        target=destination/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,target)
    required=['source','versions','dependencies','build','download_fault','verify_fault','browsers','collect','postcheck']
    if any(steps.get(s,{}).get('outcome')!='success' for s in required) or steps.get('test',{}).get('outcome') not in ('success','failure'): raise ValueError('required-step-missing')
    binding=read(root/'evidence/source-binding.json')
    if binding.get('businessCommit')!='37fb93624331ef832757daf4e7501dfd9d646f93' or binding.get('businessTree')!='57dea5c8f78a49ece84425a33a2f99806fff2f64' or binding.get('artifactId')!=12959831145 or binding.get('ordinaryAcceptance') is not False or binding.get('attempt')!='1': raise ValueError('source-binding')
    for name in ('runtime-pins.json','fault.manifest.json','reused-fault-artifact.json','fault-producer.json','native-browser-identities.json','playwright-browser-identity.json','build-manifest.json'):
        read(root/'evidence'/name)
    inventory=root/'evidence/source-inventory.txt'
    if inventory.is_symlink() or not inventory.is_file() or not inventory.stat().st_size: raise ValueError('source-inventory')
    for name,value in (('node.version','v24.22.1'),('pnpm.version','12.3.4')):
        p=root/'evidence'/name
        if p.is_symlink() or not p.is_file() or p.stat().st_size>128 or p.read_text().strip()!=value: raise ValueError('version-binding')
    evidence=root/'evidence/popup-url'; picked=read(evidence/'collection.json');collection(picked,root)
    outer=results(read(evidence/'results.json'),picked,int((evidence/'command.exit').read_text()))
    rows,issues,spawned=phases((evidence/'phases.jsonl').read_bytes())
    report=analyze(rows,issues,read(source/'report.json'),(evidence/'test.log').read_text(encoding='utf8'),outer)
    read(source/'facts.json')
    report.update({'schemaVersion':1,'behavior':outer,'proxyDaemonPairs':spawned,'runtimeClass':'acceptance-faults-diagnostic','captureStatus':'bounded-observations-no-recorded-loss' if not report['issues'] else 'incomplete-or-ambiguous','allPhaseCompletenessProven':False})
    (destination/'diagnostic-report.json').write_text(json.dumps(report,indent=2)+'\n')
    inventory={str(p.relative_to(destination)):{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(destination.rglob('*')) if p.is_file()}
    (destination/'text-inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
    if sum(p.stat().st_size for p in destination.rglob('*') if p.is_file())>MAX_TEXT:
        # This destination was exclusively created above; delete only generated
        # copies, never the original business evidence. main writes a bounded
        # incomplete-capture stub for the unconditional artifact upload.
        shutil.rmtree(destination)
        destination.mkdir()
        raise ValueError('final-text-artifact-over-limit')
    return not report['issues']

def main():
    mode=sys.argv[1];root=pathlib.Path(sys.argv[2]).resolve()
    if mode=='collection': collection(read(root/'evidence/popup-url/collection.json'),root);return
    if mode!='archive': raise ValueError('mode')
    dest=pathlib.Path(sys.argv[3]).resolve()
    try:
        ok=archive(root,dest,decode(sys.argv[4]))
    except Exception as e:
        dest.mkdir(exist_ok=True)
        reason=str(e) if type(e) is ValueError and str(e) in {'artifact-destination-exists','evidence-symlink','fixture-symlink','text-artifact-over-limit','final-text-artifact-over-limit','required-step-missing','source-binding','version-binding','file-bound','phase-file-bound','phase-line-bound','phase-keys','phase-enum','phase-common','phase-counter','phase-number','phase-bool','phase-fact-enum','result-facts','cancel-facts','spawn-facts','duplicate-key','nonfinite','collection-count','collection-identity','collection-titles','result-identity','skip-or-retry','result-counts','result-exit','url-diagnostic-limit','url-diagnostic-schema','url-diagnostic-facts','inner-schema','inner-titles','inner-retry','inner-status','outer-inner-status','url-step-owner','url-step-status','url-step-cancel-code','url-diagnostic-log','url-diagnostic-partial-line','source-inventory'} else type(e).__name__
        (dest/'capture-refusal.json').write_text(json.dumps({'captureStatus':'incomplete','reason':reason,'ordinaryAcceptance':False})+'\n')
        raise SystemExit(1) from None
    raise SystemExit(0 if ok else 1)
if __name__=='__main__': main()
