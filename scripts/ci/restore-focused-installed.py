"""Restore one original diagnostic-only focused build; never infer full acceptance."""
from pathlib import Path,PurePosixPath
import hashlib,io,json,os,stat,sys,urllib.request,urllib.error,zipfile
H=lambda b:hashlib.sha256(b).hexdigest()
def need(x,m):
 if not x:raise ValueError(m)
def verify_api(c,run,jobs,collection,artifacts):
 p=c['original'];need(c['purpose']=='focused-installed-diagnostic' and c['acceptanceEvidence'] is False,'purpose')
 for k in ['id','run_attempt','head_sha','workflow_id','status','conclusion']:
  need(run[k]==p['run'][k],'original run '+k)
 need(jobs['total_count']==len(jobs['jobs'])==1,'complete original jobs')
 j=jobs['jobs'][0]
 for k,v in p['job'].items():need(j[k]==v,'original job '+k)
 steps={s['number']:s for s in j['steps']};need(len(steps)==len(j['steps']),'unique steps')
 for s in p['requiredSuccessfulSteps']:need(steps[s['number']]['name']==s['name'] and steps[s['number']]['status']=='completed' and steps[s['number']]['conclusion']=='success','original compilation/stage step')
 need(collection['total_count']==len(collection['artifacts'])==len(p['artifacts'])==2,'complete original artifact collection')
 for pin in p['artifacts']:
  matches=[a for a in collection['artifacts'] if a['id']==pin['id']];need(len(matches)==1,'unique artifact')
  a=artifacts[str(pin['id'])];need(a==matches[0],'artifact API join')
  for k in ['id','name','size_in_bytes','digest','workflow_run']:need(a[k]==pin[k],'artifact metadata '+k)
  need(a['expired'] is False,'expired artifact')
def members(data,pin,selected):
 need(len(data)==pin['size_in_bytes'] and 'sha256:'+H(data)==pin['digest'],'original ZIP digest/size')
 with zipfile.ZipFile(io.BytesIO(data)) as z:
  xs=z.infolist();names=[x.filename for x in xs];need(len(names)==len(set(names)) and set(names)==set(pin['members']),'exact ZIP inventory')
  need(sum(x.file_size for x in xs)<=pin['uncompressedBytes'],'ZIP cap')
  for x in xs:
   parts=PurePosixPath(x.filename).parts;need(not x.is_dir() and parts and not x.filename.startswith('/') and not any(p in ('.','..')for p in parts) and '\\'not in x.filename and stat.S_IFMT(x.external_attr>>16)in[0,stat.S_IFREG] and not x.flag_bits&1,'ZIP type/path')
  return {n:z.read(n)for n in selected}
def verify_compiler(c,files):
 m=c['focusedManifest'];need(H(files['manifest.json'])==c['focusedManifestSHA256'] and json.loads(files['manifest.json'])==m,'focused manifest')
 need(m['diagnosticOnly'] is True and m['releaseEligible'] is False and m['build']['diagnosticOnly'] is True and m['build']['releaseEligible'] is False,'diagnostic flags')
 for kind,name in [('production','production-compiler.jsonl'),('default','compiler.jsonl')]:
  b=files[name];need({'sha256':H(b),'bytes':len(b)}==m['build']['compiler'][kind],'original compiler digest')
  rows=[json.loads(s)for s in b.splitlines()if s.strip()];finished=[x for x in rows if x.get('reason')=='build-finished'];need(len(finished)==1 and finished[0].get('success')is True,'compiler finished')
  expected=c['compilerSelections'][kind];selected=[x for x in rows if x.get('reason')=='compiler-artifact'and x.get('executable')==expected['executable']];need(len(selected)==1 and selected[0]==expected,'compiler selected artifact')
 for name in ['production','default-test-harness']:
  b=files[name];need({'sha256':H(b),'bytes':len(b)}==m['build']['files'][name] and b[:4]==b'\x7fELF','original ELF')
 return {'purpose':c['purpose'],'acceptanceEvidence':False,'recompiled':False,'originalRun':c['original']['run'],'nativeSource':m['build']['source']['native'],'originalRuntimeSource':m['build']['source']['e2e'],'focusedManifestSHA256':c['focusedManifestSHA256'],'compilerDigests':m['build']['compiler']}
def main():
 c=json.loads(Path('scripts/ci/focused-installed-binding.json').read_bytes());need(c['purpose']=='focused-installed-diagnostic'and c['acceptanceEvidence']is False,'purpose');e=Path('.artifacts/focused-installed-diagnostic');out=Path(os.environ['RUNNER_TEMP'])/'focused-installed-runtime';token=os.environ['GH_TOKEN'];base='https://api.github.com/repos/levicode/e2e/actions';headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json'}
 def api(path,name):
  with urllib.request.urlopen(urllib.request.Request(base+path,headers=headers),timeout=60)as q:b=q.read(5000001)
  need(len(b)<=5000000,'API cap');(e/name).write_bytes(b);return json.loads(b)
 runid=str(c['original']['run']['id']);run=api('/runs/'+runid+'/attempts/1','original-run-api.json');jobs=api('/runs/'+runid+'/attempts/1/jobs?per_page=100','original-jobs-api.json');coll=api('/runs/'+runid+'/artifacts?per_page=100','original-artifacts-api.json');arts={str(p['id']):api('/artifacts/'+str(p['id']),'artifact-'+str(p['id'])+'-api.json')for p in c['original']['artifacts']};verify_api(c,run,jobs,coll,arts)
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args,**kwargs):return None
 files={}
 for p in c['original']['artifacts']:
  try:
   urllib.request.build_opener(NoRedirect).open(urllib.request.Request(base+'/artifacts/'+str(p['id'])+'/zip',headers=headers),timeout=60);raise ValueError('expected signed redirect')
  except urllib.error.HTTPError as err:
   need(err.code in(301,302,303,307,308),'ZIP redirect');location=err.headers['Location'];need(location.startswith('https://'),'HTTPS required')
  with urllib.request.urlopen(location,timeout=120)as q:data=q.read(p['size_in_bytes']+1)
  (e/('original-'+str(p['id'])+'.zip')).write_bytes(data);files.update(members(data,p,p['selected']))
 proof=verify_compiler(c,files);out.mkdir()
 for n in ['production','default-test-harness','manifest.json']:(out/n).write_bytes(files[n])
 for n in ['production-compiler.jsonl','compiler.jsonl']:(e/n).write_bytes(files[n])
 (out/'production').chmod(0o755);(e/'restored-focused-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
if __name__=='__main__':
 try:main()
 except Exception as err:raise SystemExit('Focused diagnostic restore failed: '+type(err).__name__)from None
