"""Archive only the original delayed onAction case's closed native metadata."""
import hashlib,importlib.util,json,os,pathlib
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('hung_capture',HERE/'collect-spec-hung-cleanup.py')
hung=importlib.util.module_from_spec(spec)
SHARED_BYTES=(HERE/'collect-spec-hung-cleanup.py').read_bytes()
exec(compile(SHARED_BYTES,str(HERE/'collect-spec-hung-cleanup.py'),'exec'),hung.__dict__)
BOUND_FILES={
 'collectorSha256':'scripts/ci/collect-spec-on-action.py',
 'sharedCollectorSha256':'scripts/ci/collect-spec-hung-cleanup.py',
 'validatorSha256':'scripts/ci/check-engine-secrets-native-custody.py',
 'schemaSha256':'scripts/ci/native-closed-trace-schema.json',
 'testSha256':'packages/e2e/tests/integration/agent-act-on-action.test.ts',
 'helperSha256':'packages/e2e/tests/helpers/on-action-capture.ts',
}
def collect(workspace,evidence,raw,env):
 result={'schemaVersion':1,'caseId':'on-action-delayed','status':'unknown','reasons':[],
         'diagnosticOnly':True,'releaseEligible':False,'caseAssociation':'helper-filename-only',
         'processCoverage':'unproven','noAbsenceInference':True,'records':[]}
 try:
  raw=hung.directory(raw)
  hung.closed.need(raw!=evidence and evidence not in raw.parents and raw not in evidence.parents,'raw-placement')
  binding,schema=hung.identity(workspace,raw,env,BOUND_FILES)
  hung.closed.need(binding['sharedCollectorSha256']==hashlib.sha256(SHARED_BYTES).hexdigest(),'loaded-shared-collector')
  result['binding']=binding
 except Exception:
  result['reasons']=['binding-unavailable'];return result
 try:
  data=hung.closed.read(raw/'on-action-delayed.cleanup.jsonl',hung.MAX_BYTES)
  records,reasons=hung.inspect(data,schema)
  result.update(records=records,reasons=sorted(reasons),status='unknown' if reasons else 'observed')
 except Exception:result['reasons']=['capture-unavailable-or-byte-limit']
 return result

def main():
 try:
  evidence=hung.directory(os.environ.get('E2E_SPEC_EVIDENCE_DIR',''))
  workspace=pathlib.Path(os.environ['GITHUB_WORKSPACE']).resolve(strict=True)
  result=collect(workspace,evidence,os.environ.get('E2E_ON_ACTION_CAPTURE_DIR',''),os.environ)
  fd=os.open(evidence/'on-action-delayed.cleanup-diagnostics.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'w') as out:json.dump(result,out,separators=(',',':'));out.write('\n')
 except Exception:print('SPEC_ON_ACTION_CAPTURE_UNAVAILABLE')
if __name__=='__main__':main()
