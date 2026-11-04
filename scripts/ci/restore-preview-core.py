"""Restore exact previously installed Linux bundle; never modify installer or producer flags."""
from pathlib import Path,PurePosixPath
import hashlib,io,json,os,stat,sys,urllib.request,urllib.error,zipfile,subprocess
H=lambda b:hashlib.sha256(b).hexdigest()
def need(x,m):
 if not x:raise ValueError(m)
def verify_api(c,run,jobs,collection,artifacts):
 p=c['original'];need(c['purpose']=='linux-preview-core-diagnostic' and c['acceptanceEvidence'] is False,'purpose')
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
def verify_bundle(c,files):
 need(H(files['manifest.json'])==c['manifestSHA256'],'external manifest digest');m=json.loads(files['manifest.json']);need(m==c['manifest'],'original manifest bytes/object')
 need(m['source']==c['bundleSource']and m['nativeSource']==c['nativeSource']and m['platform']=='linux'and m['architecture']=='x64','platform/source binding')
 for name,pin in c['memberDigests'].items():need(len(files[name])==pin['bytes']and H(files[name])==pin['sha256'],'all bundle member bytes '+name)
 names=[x['path']for x in m['installation']['installerFiles']];need(all(n in names for n in ['install.mjs','installer/bundle.js','installer/bundle-install.js','installer/installed-runtime.js','installer/package.json']),'mandatory original installer members')
 for item in [*m['packages'].values(),m['native'],m['producer'],m['negotiation'],*m['installation']['installerFiles']]:need(H(files[item['path']])==item['sha256'],'manifest member identity')
 producer=json.loads(files[m['producer']['path']]);need(producer['acceptanceEvidence']is False and producer['releaseEligible']is False,'original diagnostic flags')
 return {'purpose':c['purpose'],'acceptanceEvidence':False,'bundleSource':m['source'],'nativeSource':m['nativeSource'],'manifestSHA256':c['manifestSHA256'],'artifactId':c['bundleArtifactId'],'allMembersVerified':True,'installerExecuted':False}
def verify_source(c,git,env):
 need(env['GITHUB_REPOSITORY']=='levicode/e2e'and env['GITHUB_REF']=='refs/heads/'+c['branch']and env['GITHUB_RUN_ATTEMPT']=='1','source invocation')
 head=git('rev-parse','HEAD').strip();tree=git('rev-parse','HEAD^{tree}').strip();need(head==env['GITHUB_SHA']and head!=c['baseCommit']and git('rev-parse','HEAD^').strip()==c['baseCommit'],'current actual source')
 need(git('status','--porcelain').strip()=='','pristine');need(sorted(git('diff-tree','--no-commit-id','--name-only','-r','HEAD^','HEAD').splitlines())==c['allowedDelta'],'exact source delta')
 lines=[s for s in git('ls-tree','-r','HEAD').splitlines()if s.split('\t')[1]not in c['sourceSealExclusions']];need(H(('\n'.join(lines)+'\n').encode())==c['sourceSealSHA256'],'complete source seal')
 return {'commit':head,'tree':tree,'repository':env['GITHUB_REPOSITORY'],'ref':env['GITHUB_REF'],'runId':env['GITHUB_RUN_ID'],'runAttempt':env['GITHUB_RUN_ATTEMPT']}
def main():
 c=json.loads(Path('scripts/ci/preview-core-binding.json').read_bytes());need(sys.argv[1:]in[[],['source']],'restore mode')
 if sys.argv[1:]==['source']:
  source=verify_source(c,lambda *args:subprocess.check_output(['git',*args],text=True),os.environ);p=Path('.artifacts/linux-preview-core/source-verified.json');p.write_text(json.dumps(source,indent=2)+'\n');return
 e=Path('.artifacts/linux-preview-core/transport');e.mkdir(parents=True,exist_ok=False);git=lambda *args:subprocess.check_output(['git',*args],text=True);source=verify_source(c,git,os.environ);(e/'orchestrator-source.json').write_text(json.dumps(source,indent=2)+'\n');out=Path(os.environ['RUNNER_TEMP'])/'preview-core-bundle';token=os.environ['GH_TOKEN'];base='https://api.github.com/repos/levicode/e2e/actions';headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json'}
 def api(path,name):
  with urllib.request.urlopen(urllib.request.Request(base+path,headers=headers),timeout=60)as q:b=q.read(5000001)
  need(len(b)<=5000000,'API cap');(e/name).write_bytes(b);return json.loads(b)
 runid=str(c['original']['run']['id']);run=api('/runs/'+runid+'/attempts/1','original-run-api.json');jobs=api('/runs/'+runid+'/attempts/1/jobs?per_page=100','original-jobs-api.json');coll=api('/runs/'+runid+'/artifacts?per_page=100','original-artifacts-api.json');arts={str(p['id']):api('/artifacts/'+str(p['id']),'artifact-'+str(p['id'])+'-api.json')for p in c['original']['artifacts']};verify_api(c,run,jobs,coll,arts)
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args,**kwargs):return None
 pin=next(p for p in c['original']['artifacts']if p['id']==c['bundleArtifactId'])
 try:
  urllib.request.build_opener(NoRedirect).open(urllib.request.Request(base+'/artifacts/'+str(pin['id'])+'/zip',headers=headers),timeout=60);raise ValueError('expected signed redirect')
 except urllib.error.HTTPError as err:
  need(err.code in(301,302,303,307,308),'ZIP redirect');location=err.headers['Location'];need(location.startswith('https://'),'HTTPS required')
 with urllib.request.urlopen(location,timeout=120)as q:data=q.read(pin['size_in_bytes']+1)
 (e/'original-bundle.zip').write_bytes(data);files=members(data,pin,pin['members']);proof=verify_bundle(c,files);out.mkdir()
 for name,b in files.items():
  p=out/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b)
 (e/'restored-bundle.json').write_text(json.dumps(proof,indent=2)+'\n')
if __name__=='__main__':
 try:main()
 except Exception as err:raise SystemExit('Preview bundle restore failed: '+type(err).__name__)from None
