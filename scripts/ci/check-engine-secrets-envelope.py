"""Validate the closed projection in the ORIGINAL log; never adjudicate business success."""
import argparse, hashlib, json, os, pathlib, re, sys
P='ENGINE_SECRETS_DIAGNOSTIC'
BASE='ad67f6c766c093800a04315ae5f05feb148cf28c'
STATUS={'passed','failed','timed-out','interrupted','skipped'}
PHASE=set('config collection filter launch beforeAll beforeEach body afterEach afterAll cleanup report unknown not-present'.split())
ERROR=set('ACTION_MAY_HAVE_COMMITTED APP_NOT_OPEN ASSERTION_FAILED EXPECTATION_FAILED OPERATION_TIMEOUT CANCELLED LAUNCH_TIMEOUT CLEANUP_TIMEOUT INVALID_STATE unknown not-present'.split())
NATIVE=set('frame-not-found frame-ambiguous invalid-frame unsupported-protocol unsupported-capability stale-generation scope-unavailable sequence-reused invalid-sequence invalid-timeout capacity-exceeded operation-missing content-length-mismatch redirect-body-unavailable unsupported-command deadline-exceeded cancelled invalid-arguments invalid-locator browser-failure stale-scope cleanup-failed stale-reference policy-denied not-actionable intercepted-pointer checked-state-unchanged checked-control-replaced fill-unsupported-target no-editable-focus tap-target-replaced-before-press locator-not-found decision-missing decision-expired decision-kind-mismatch registry-missing registry-in-use identifier-exhausted unknown'.split())
ADMISSION=set('callback-check require-attempt owner-check pending-latch caller-aborted download-readiness ensure-connected final-owner-check'.split())
RETIRE=set('download-file retire-attempt finalized-video recording-stop late-recording-stop connection-cleanup native-video-retire interop-retire playwright-close scope-end native-close provider-release publication worker-release worker-acquisition-cleanup native-resource-cleanup unknown'.split())
GUARD=set('workerRetired workerCleanupUnconfirmed retirementFailurePresent attemptPresent retiringAttemptPresent connectingPresent'.split())
CLEAN=set('nativeRetired finalizedCleanupProven recordingsRetired released connectingCleanupFailurePresent retiringAttemptCleared'.split())
IDENTITY={'consumerRun','consumerAttempt','selector','nodeVersion','sourceCommit','sourceTree','caseSchema'}
class Invalid(Exception): pass
def need(ok,code):
    if not ok: raise Invalid(code)
def integer(v,lo=0,hi=9007199254740991): return type(v) is int and lo<=v<=hi
def exact(row,keys): need(type(row) is dict and set(row)==set(keys),'invalid-keys')
def member(v,values): need(type(v) is str and v in values,'invalid-enum')
def pairs(items):
    out={}
    for k,v in items:
        need(k not in out,'duplicate-json-key');out[k]=v
    return out
def parse(data):
    try: return json.loads(data,object_pairs_hook=pairs)
    except Invalid: raise
    except Exception: raise Invalid('invalid-json') from None
def error(row):
    exact(row,{'phase','errorCode'});member(row['phase'],PHASE);member(row['errorCode'],ERROR)
def identity(row):
    exact(row,IDENTITY)
    for k in ['consumerRun','consumerAttempt']: need(type(row[k]) is str and re.fullmatch('[1-9][0-9]{0,19}',row[k]),'invalid-identity')
    need(type(row['selector']) is str and re.fullmatch(r'(22|24)\.[0-9]{1,3}\.[0-9]{1,3}',row['selector']),'invalid-identity')
    need(row['nodeVersion']=='v'+row['selector'] and row['caseSchema']=='engine-secrets-five-v1','invalid-identity')
    for k in ['sourceCommit','sourceTree']: need(type(row[k]) is str and re.fullmatch('[a-f0-9]{40}',row[k]),'invalid-identity')
def envelope(row,expected):
    exact(row,IDENTITY|{'schemaVersion','suite','captureNonce'})
    need(type(row['schemaVersion']) is int and row['schemaVersion']==1 and row['suite']=='engine-secrets','invalid-envelope')
    need(type(row['captureNonce']) is str and re.fullmatch('[a-f0-9]{64}',row['captureNonce']),'invalid-nonce')
    actual={k:row[k] for k in IDENTITY};identity(actual);need(actual==expected,'identity-mismatch')
def case(row):
    keys={'v','kind','caseOrdinal','status','attemptCount','attemptStatus','phase','errorCode','cleanup','secondaryErrorCount','secondaryErrors'}
    if row.get('caseOrdinal')==1: keys|={'runErrorCount','runErrors'}
    exact(row,keys);need(integer(row['caseOrdinal'],1,5),'invalid-case');member(row['status'],STATUS)
    need(integer(row['attemptCount'],0,1),'invalid-case');member(row['attemptStatus'],STATUS|{'not-present'});member(row['cleanup'],{'complete','failed','forced','not-present'})
    if row['attemptCount']==0: need(row['status']=='skipped' and row['attemptStatus']==row['cleanup']=='not-present','invalid-case')
    else: need(row['attemptStatus'] in STATUS and row['cleanup']!='not-present','invalid-case')
    error({'phase':row['phase'],'errorCode':row['errorCode']})
    for n,a in [('secondaryErrorCount','secondaryErrors')]+([('runErrorCount','runErrors')] if row['caseOrdinal']==1 else []):
        need(integer(row[n],0,8) and type(row[a]) is list and len(row[a])==row[n],'invalid-error-count')
        for value in row[a]: error(value)
def validate_rows(rows,custody):
    owners={};workers=set();surfaces=set();cases={};retired=set();lost=False;query_counts={};witness=set()
    common={'v','kind','workerOrdinal','caseOrdinal','surface','attempt'}
    for row in rows:
        need(type(row) is dict and type(row.get('v')) is int and row['v']==1,'invalid-row')
        kind=row.get('kind')
        if kind=='case':
            case(row);n=row['caseOrdinal'];need(n not in cases,'duplicate-case');cases[n]=row;continue
        if kind=='capture-loss':
            exact(row,{'v','kind','reason'}|({'workerOrdinal'} if 'workerOrdinal' in row else {'worker'}))
            member(row['reason'],{'surface-cap','attempt-cap','client-cap','row-cap','owner-unjoined'})
            if 'workerOrdinal' in row: need(integer(row['workerOrdinal'],1,8),'invalid-worker')
            else: need(row['worker']=='unjoined','invalid-worker')
            lost=True;continue
        extras={'start':set(),'guard':GUARD,'admission':{'stage','origin','wire'},'retirement':{'stage','before','after'},'cleanup':CLEAN|{'reason','dirty'},'overflow':{'limit'},'query':set('client generation operationSeq command transmittedTimeoutMs selectedLocalCancel rawCode rawEffects rawScopeState returnedCode timeoutRewritten cancelAckSeen'.split())}
        need(type(kind) is str and kind in extras,'invalid-kind');exact(row,common|extras[kind])
        for k,hi in [('workerOrdinal',8),('caseOrdinal',5),('surface',16),('attempt',16)]: need(integer(row[k],1,hi),'invalid-owner')
        owner=(row['workerOrdinal'],row['surface'],row['attempt']);surface=owner[:2]
        if kind=='start':
            need(owner not in owners and row['caseOrdinal'] not in [x['case'] for x in owners.values()],'duplicate-owner')
            owners[owner]={'case':row['caseOrdinal'],'terminal':False};workers.add(owner[0]);surfaces.add(surface)
            need(len(owners)<=16 and len(surfaces)<=16,'owner-cap')
        need(owner in owners and owners[owner]['case']==row['caseOrdinal'],'unjoined-owner')
        if kind=='guard':
            need(all(type(row[k]) is bool for k in GUARD) and any(row[k] for k in GUARD),'invalid-guard')
            if row['retirementFailurePresent']: need(surface in retired,'missing-retirement')
            owners[owner]['terminal']=True
        elif kind=='admission':
            member(row['stage'],ADMISSION);need(row['wire']=='absent' and row['origin']=='unjoined','invalid-admission');witness.add(row['caseOrdinal'])
        elif kind=='retirement':
            member(row['stage'],RETIRE);member(row['before'],{'undefined','null'});member(row['after'],{'null','value'});need(row['before']!=row['after'],'invalid-retirement-transition')
            if row['after']!='undefined': retired.add(surface)
        elif kind=='cleanup':
            need(all(type(row[k]) is bool for k in CLEAN),'invalid-cleanup');member(row['reason'],{'receipt-failed','local-wait-departure','unresolved-custody','complete','unknown'});need(row['dirty']=='unknown','invalid-cleanup');owners[owner]['terminal']=True
            if row['reason']=='complete':need(all(row[k] for k in CLEAN-{'connectingCleanupFailurePresent'}) and not row['connectingCleanupFailurePresent'],'invalid-cleanup-conjunction')
        elif kind=='overflow': need(type(row['limit']) is int and row['limit']==8,'invalid-overflow');lost=True
        elif kind=='query':
            for k,hi in [('client',16),('generation',9007199254740991),('operationSeq',9007199254740991),('transmittedTimeoutMs',3600000)]:need(integer(row[k],1,hi),'invalid-query')
            member(row['command'],{'fixture.query','fixture.read-fields','browser.query'});member(row['selectedLocalCancel'],{'none','abort','deadline'})
            for k in ['rawCode','returnedCode']:member(row[k],NATIVE)
            member(row['rawEffects'],{'not-dispatched','completed','unknown'});member(row['rawScopeState'],{'usable','quarantined','closed','unknown'})
            need(type(row['timeoutRewritten']) is bool and type(row['cancelAckSeen']) is bool,'invalid-query')
            key=(owner[0],row['client']);query_counts[key]=query_counts.get(key,0)+1;need(query_counts[key]<=8 and len(query_counts)<=16,'query-cap');witness.add(row['caseOrdinal'])
    need(set(cases)=={1,2,3,4,5},'missing-cases');need(workers==set(range(1,len(workers)+1)),'invalid-worker-ordinals')
    for n,row in cases.items():
        if row['attemptCount']:need(any(v['case']==n for v in owners.values()),'missing-start')
        if row['errorCode']=='ACTION_MAY_HAVE_COMMITTED':need(n in witness,'missing-uncertainty-witness')
        if row['cleanup'] in {'failed','forced'}:need(any(x.get('kind')=='retirement' and x.get('caseOrdinal')==n for x in rows) or lost,'missing-cleanup-witness')
    if cases[1]['runErrorCount']:need(bool(retired) or lost,'missing-run-error-witness')
    keys=set('schemaVersion suite baseConsumer projection lifecycle coverage exhaustive noAbsenceInference invalidRecords overflow rows workerBindings surfaceBindings attemptBindings nativeOrigin began'.split())
    exact(custody,keys);need(type(custody['schemaVersion']) is int and custody['schemaVersion']==1 and custody['suite']=='engine-secrets' and custody['baseConsumer']==BASE,'invalid-custody')
    need(custody['coverage']=='observed-only' and custody['exhaustive'] is False and custody['noAbsenceInference'] is True and custody['nativeOrigin']=='unknown' and custody['began'] is True,'invalid-semantics')
    member(custody['projection'],{'complete','incomplete'});member(custody['lifecycle'],{'observed','incomplete'});need(type(custody['overflow']) is bool and integer(custody['invalidRecords'],0,65),'invalid-custody')
    for key,value in [('rows',len(rows)),('workerBindings',len(workers)),('surfaceBindings',len(surfaces)),('attemptBindings',len(owners))]:need(type(custody[key]) is int and custody[key]==value,'custody-count-mismatch')
    need(custody['projection']=='complete' and custody['lifecycle']=='observed' and custody['invalidRecords']==0 and not custody['overflow'] and not lost and all(x['terminal'] for x in owners.values()),'capture-incomplete')
    return [{'caseOrdinal':n,'status':cases[n]['status'],'cleanup':cases[n]['cleanup']} for n in range(1,6)]
def verify_log(stream,expected):
    result={'schemaVersion':1,'suite':'engine-secrets','artifactEnvelope':'incomplete','coverage':'observed-only','exhaustive':False,'noAbsenceInference':True,'businessGateUnchanged':True,'errors':[]}
    begin=None;ended=False;custody=None;rows=[];digest=hashlib.sha256();size=0;read_complete=False
    try:
        identity(expected)
        while True:
            line=stream.readline(1048577)
            if not line:read_complete=True;break
            digest.update(line);size+=len(line);need(len(line)<=1048576,'original-log-line-cap');need(size<=512*1024*1024,'original-log-size-cap')
            if not line.startswith(P.encode()):continue
            need(len(line)<=2048 and line.endswith(b'\n'),'diagnostic-line-cap')
            head,sep,data=line.partition(b' ');need(bool(sep),'invalid-prefix');head=head.decode('ascii');row=parse(data)
            if head==P+'_BEGIN':need(begin is None and not ended,'duplicate-region');envelope(row,expected);begin=row
            elif head==P+'_END':need(begin is not None and not ended and custody is not None,'invalid-end');envelope(row,expected);need(row==begin,'envelope-mismatch');ended=True
            elif head==P+'_CUSTODY':need(begin is not None and not ended and custody is None,'invalid-custody-order');custody=row
            elif head==P:need(begin is not None and not ended and custody is None,'row-outside-region');rows.append(row);need(len(rows)<=64,'row-cap')
            elif head==P+'_UNAVAILABLE':raise Invalid('identity-unavailable')
            else:raise Invalid('unknown-prefix')
        need(begin is not None and ended,'missing-envelope');result['cases']=validate_rows(rows,custody);result['artifactEnvelope']='accepted';result['identity']=expected;result['rows']=len(rows)
    except Invalid as exc: result['errors']=[str(exc)]
    except Exception: result['errors']=['validator-internal-error']
    result['readPrefixSha256']=digest.hexdigest();result['logBytesRead']=size;result['logReadComplete']=read_complete
    return result

def small(path,maximum=256):
    need(path.is_file() and not path.is_symlink() and path.stat().st_size<=maximum,'identity-file-invalid');return path.read_text().strip()
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--evidence',type=pathlib.Path,required=True);args=parser.parse_args();root=args.evidence
    result={'schemaVersion':1,'suite':'engine-secrets','artifactEnvelope':'incomplete','coverage':'observed-only','exhaustive':False,'noAbsenceInference':True,'businessGateUnchanged':True,'errors':['identity-file-invalid']}
    try:
        need(root.is_dir() and not root.is_symlink(),'evidence-root-invalid')
        expected={k:os.environ.get(v,'') for k,v in [('consumerRun','GITHUB_RUN_ID'),('consumerAttempt','GITHUB_RUN_ATTEMPT'),('selector','NODE_SELECTOR')]}
        expected.update(nodeVersion=small(root/'node.version'),sourceCommit=small(root/'source.commit'),sourceTree=small(root/'source.tree'),caseSchema='engine-secrets-five-v1');identity(expected)
        path=root/'fixtures'/expected['selector']/'core'/'test-e2e.log'
        need(all(not p.is_symlink() for p in [path,*list(path.parents)[:3]]) and path.is_file(),'original-log-invalid')
        with path.open('rb') as stream:result=verify_log(stream,expected)
        outcome=small(root/'test-e2e.exit');need(re.fullmatch('[0-9]{1,3}',outcome) is not None,'original-test-exit-invalid');result['originalPackageTestExit']=int(outcome)
    except Invalid as exc:result['artifactEnvelope']='incomplete';result['errors']=[str(exc)]
    except Exception:result['artifactEnvelope']='incomplete';result['errors']=['validator-internal-error']
    output=root/'engine-secrets-capture-status.json'
    need(root.is_dir() and not root.is_symlink() and not output.is_symlink(),'status-path-invalid')
    output.write_text(json.dumps(result,indent=2)+'\n')
    print('engine-secrets envelope: '+result['artifactEnvelope'])
    return 0 if result['artifactEnvelope']=='accepted' else 1
if __name__=='__main__':raise SystemExit(main())
