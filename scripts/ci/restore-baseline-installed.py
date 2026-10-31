"""Restore the explicitly historical S22 ordinary runtime. No compile or acceptance claim."""
from pathlib import Path
import hashlib,io,json,os,stat,sys,urllib.request,urllib.error,zipfile
H=lambda b:hashlib.sha256(b).hexdigest()
def need(x,m):
 if not x:raise ValueError(m)
def verify_api(pin,a,run,jobs,collection):
 need(a['id']==pin['artifactId'] and a['name']==pin['artifactName'] and a['expired'] is False and a['size_in_bytes']==pin['artifactSize'] and a['digest']==pin['artifactDigest'],'artifact metadata')
 exp=pin['expected'];need(str(a['workflow_run']['id'])==exp['runId'] and a['workflow_run']['head_sha']==exp['source']['commit'],'artifact producer')
 need(str(run['id'])==exp['runId'] and str(run['run_attempt'])==exp['runAttempt'] and run['head_sha']==exp['source']['commit'] and run['workflow_id']==pin['producer']['workflowId'] and run['status']=='completed' and run['conclusion']=='success','original run')
 need(jobs['total_count']==len(jobs['jobs']) and len(jobs['jobs'])==1,'complete unique original job')
 j=jobs['jobs'][0];need(j['id']==pin['producer']['jobId'] and j['name']==pin['producer']['jobName'] and j['head_sha']==exp['source']['commit'] and str(j['run_id'])==exp['runId'] and str(j['run_attempt'])==exp['runAttempt'] and j['status']=='completed' and j['conclusion']=='success','original job')
 need(collection['total_count']==len(collection['artifacts']) and len(collection['artifacts'])==1 and collection['artifacts'][0]==a,'complete unique artifact collection')
def members(data,pin):
 need(len(data)==pin['artifactSize'] and 'sha256:'+H(data)==pin['artifactDigest'],'original ZIP digest/size')
 with zipfile.ZipFile(io.BytesIO(data)) as z:
  xs=z.infolist();need(len(xs)==4 and {x.filename for x in xs}=={'agent-browser','compiler.jsonl','manifest.json','rustc.txt'},'exact ZIP inventory');need(sum(x.file_size for x in xs)<=150000000,'ZIP cap')
  for x in xs:need(not x.is_dir() and stat.S_IFMT(x.external_attr>>16)in[0,stat.S_IFREG] and not x.flag_bits&1,'ZIP type')
  return {x.filename:z.read(x) for x in xs}
def main():
 c=json.loads(Path('scripts/ci/baseline-installed-binding.json').read_bytes());need(c['purpose']=='baseline-installed-diagnostic' and c['acceptanceEvidence'] is False,'purpose');p=c['ordinary'];out=Path(os.environ['RUNNER_TEMP'])/'baseline-installed-runtime';e=Path('evidence');e.mkdir(exist_ok=True);token=os.environ['GH_TOKEN'];base='https://api.github.com/repos/levicode/e2e/actions';headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json'}
 def api(path,name):
  with urllib.request.urlopen(urllib.request.Request(base+path,headers=headers),timeout=60) as q:b=q.read(5000001)
  need(len(b)<=5000000,'API cap');(e/name).write_bytes(b);return json.loads(b)
 a=api('/artifacts/'+str(p['artifactId']),'original-artifact-api.json');run=api('/runs/'+p['expected']['runId']+'/attempts/1','original-run-api.json');jobs=api('/runs/'+p['expected']['runId']+'/attempts/1/jobs?per_page=100','original-jobs-api.json');collection=api('/runs/'+p['expected']['runId']+'/artifacts?per_page=100','original-artifacts-api.json');verify_api(p,a,run,jobs,collection)
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args,**kwargs):return None
 try:
  urllib.request.build_opener(NoRedirect).open(urllib.request.Request(base+'/artifacts/'+str(p['artifactId'])+'/zip',headers=headers),timeout=60);raise ValueError('expected signed redirect')
 except urllib.error.HTTPError as err:
  need(err.code in (301,302,303,307,308),'ZIP redirect');location=err.headers['Location'];need(location.startswith('https://'),'HTTPS required')
 with urllib.request.urlopen(location,timeout=120) as q:data=q.read(p['artifactSize']+1)
 files=members(data,p);(e/'original-runtime.zip').write_bytes(data);out.mkdir()
 for name,b in files.items():(out/name).write_bytes(b)
 (out/'agent-browser').chmod(0o755)
 (e/'reused-runtime.json').write_text(json.dumps({'purpose':c['purpose'],'acceptanceEvidence':False,'recompiled':False,'originalArtifactId':p['artifactId'],'originalProducer':p['expected'],'zipSHA256':H(data)},indent=2)+'\n')
if __name__=='__main__':
 try:main()
 except Exception as err:raise SystemExit('Historical runtime restore failed: '+type(err).__name__) from None
