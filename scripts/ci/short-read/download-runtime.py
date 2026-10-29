"""Restore one reviewed producer artifact; never re-label it as current-run compilation."""
import hashlib, io, json, os, pathlib, stat, urllib.request, zipfile
kind=os.environ['RUNTIME_KIND'];assert kind in ('ordinary','fault')
allpins=json.loads(pathlib.Path('scripts/ci/full-standard-runtime-pins.json').read_text());assert allpins['configured'] is True
p=allpins[kind]
base='https://api.github.com/repos/levicode/e2e/actions/artifacts/'+str(p['artifactId'])
token=os.environ['GH_TOKEN']
def api(url):
    return urllib.request.urlopen(urllib.request.Request(url,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json'}),timeout=60)
try:
    producer=p['producer']
    with api('https://api.github.com/repos/levicode/e2e/actions/runs/'+p['expected']['runId']+'/attempts/'+p['expected']['runAttempt']) as response: run=json.load(response)
    assert str(run['id'])==p['expected']['runId'] and str(run['run_attempt'])==p['expected']['runAttempt']
    assert run['head_sha']==p['expected']['source']['commit'] and run['status']=='completed'
    assert run['workflow_id']==producer['workflowId'] and run['path']==producer['workflowPath']
    assert run['conclusion']==producer['runConclusion']
    with api('https://api.github.com/repos/levicode/e2e/actions/jobs/'+str(producer['jobId'])) as response: job=json.load(response)
    assert str(job['run_id'])==p['expected']['runId'] and str(job['run_attempt'])==p['expected']['runAttempt']
    assert job['name']==producer['jobName'] and job['status']=='completed' and job['conclusion']=='success'
    pathlib.Path('evidence/'+kind+'-producer.json').write_text(json.dumps({'runId':run['id'],'runAttempt':run['run_attempt'],'headSha':run['head_sha'],'workflowId':run['workflow_id'],'workflowPath':run['path'],'runConclusion':run['conclusion'],'jobId':job['id'],'jobName':job['name'],'jobConclusion':job['conclusion']},indent=2)+'\n')
    with api(base) as response: a=json.load(response)
    assert a['id']==p['artifactId'] and a['name']==p['artifactName'] and not a['expired']
    assert a['size_in_bytes']==p['artifactSize'] and a['digest']==p['artifactDigest']
    assert str(a['workflow_run']['id'])==p['expected']['runId']
    assert a['workflow_run']['head_sha']==p['expected']['source']['commit']
    # Follow signed redirect without forwarding GitHub authentication to blob storage.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs): return None
    opener=urllib.request.build_opener(NoRedirect)
    try:
        response=opener.open(urllib.request.Request(base+'/zip',headers={'Authorization':'Bearer '+token}),timeout=60)
        raise AssertionError('Artifact endpoint did not redirect')
    except urllib.error.HTTPError as error:
        assert error.code in (301,302,303,307,308)
        location=error.headers['Location']
        assert location.startswith('https://')
    with urllib.request.urlopen(location,timeout=120) as response: data=response.read(p['artifactSize']+1)
    assert len(data)==p['artifactSize'] and 'sha256:'+hashlib.sha256(data).hexdigest()==p['artifactDigest']
    target=pathlib.Path(os.environ['RUNNER_TEMP'])/('ci-native-'+kind); target.mkdir()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos=archive.infolist(); expected={'agent-browser','compiler.jsonl','manifest.json','rustc.txt'}
        assert len(infos)==4 and {x.filename for x in infos}==expected
        for info in infos:
            assert not stat.S_ISLNK(info.external_attr>>16)
            with (target/info.filename).open('xb') as output: output.write(archive.read(info))
    pathlib.Path('evidence/reused-'+kind+'-artifact.json').write_text(json.dumps({'artifactId':p['artifactId'],'zipDigest':p['artifactDigest'],'producer':p['expected'],'acceptanceEvidence':False},indent=2)+'\n')
except Exception as error:
    # Exception text may include a signed URL. Only its fixed class is public.
    raise SystemExit('Runtime artifact verification failed: '+type(error).__name__) from None

