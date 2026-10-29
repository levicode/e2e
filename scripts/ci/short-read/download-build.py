"""Exact old build artifact; no current-run producer relabelling."""
import hashlib,io,json,os,pathlib,stat,urllib.request,urllib.error,zipfile
P=json.loads((pathlib.Path(__file__).parent/'pins.json').read_text());p=P['build'];token=os.environ['GH_TOKEN'];base='https://api.github.com/repos/levicode/e2e/actions/'
def api(url):return urllib.request.urlopen(urllib.request.Request(url,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json'}),timeout=60)
try:
 with api(base+'artifacts/'+str(p['id'])) as r:a=json.load(r)
 assert a['id']==p['id'] and a['name']==p['name'] and a['size_in_bytes']==p['bytes'] and a['digest']==p['digest'] and not a['expired'];assert str(a['workflow_run']['id'])==p['run'] and a['workflow_run']['head_sha']==P['sourceCommit']
 with api(base+'runs/'+p['run']+'/attempts/'+p['attempt']+'/jobs?per_page=100') as r:jobs=json.load(r)['jobs']
 j=[x for x in jobs if x['name']=='build_0'];assert len(j)==1 and j[0]['conclusion']=='success' and j[0]['status']=='completed' and str(j[0]['run_id'])==p['run'] and str(j[0]['run_attempt'])==p['attempt']
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args,**kwargs):return None
 try:urllib.request.build_opener(NoRedirect).open(urllib.request.Request(base+'artifacts/'+str(p['id'])+'/zip',headers={'Authorization':'Bearer '+token}),timeout=60);raise AssertionError()
 except urllib.error.HTTPError as x:assert x.code in (301,302,303,307,308);location=x.headers['Location'];assert location.startswith('https://')
 with urllib.request.urlopen(location,timeout=120) as r:data=r.read(p['bytes']+1)
 assert len(data)==p['bytes'] and 'sha256:'+hashlib.sha256(data).hexdigest()==p['digest']
 out=pathlib.Path('js-build-bundle');out.mkdir()
 with zipfile.ZipFile(io.BytesIO(data)) as z:
  infos=z.infolist();assert len(infos)==2 and {x.filename for x in infos}=={'manifest.json','outputs.tar.gz'}
  for x in infos:
   assert not stat.S_ISLNK(x.external_attr>>16)
   with (out/x.filename).open('xb') as f:f.write(z.read(x))
 assert hashlib.sha256((out/'manifest.json').read_bytes()).hexdigest()==p['manifestSHA256']
 pathlib.Path('evidence/build-producer.json').write_text(json.dumps({'artifactId':p['id'],'artifactDigest':p['digest'],'producerRun':p['run'],'producerAttempt':p['attempt'],'producerJob':j[0]['id'],'producerJobConclusion':j[0]['conclusion'],'producerSource':P['sourceCommit']},indent=2)+'\n')
except Exception as e:raise SystemExit('Build artifact verification failed: '+type(e).__name__) from None
