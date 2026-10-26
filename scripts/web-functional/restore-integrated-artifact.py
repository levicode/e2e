"""Restore exact compiler outputs for a distinct evidence attempt; import no test pass."""
import hashlib,json,os,pathlib,re,stat,sys,urllib.request,zipfile
kind,archive,destination,out=sys.argv[1:];native='d3f1ce0cb4afaa42fe2ef07f7bf9badce4729be7';tree='92985c1815b8d0ce4b73e84c79e2cff2f5d3690a';run=40348769863;head='ba64ab6badb8df57a80a9d6849b68d1335506a7d'
entries={'harness':(12663387883,'6437eda79978712e118042e2b8975c6b7055ceef7599b11bbb563fde380809a1',{'agent-browser-tests','native-source.sha','native-source.tree','Cargo.lock.sha256','SHA256SUMS'}),'images':(12662683695,'43e74ae76cf828079743a10d3935418f4a63395e0b7b1f512330595c9877e232',{'production','acceptance-faults','native-source.sha','native-source.tree','producer-run.id','SHA256SUMS'})}
aid,digest,expected=entries[kind]
def get(path):
 req=urllib.request.Request('https://api.github.com/repos/levicode/e2e/'+path,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json'})
 with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)
a=get(f'actions/artifacts/{aid}');assert a['workflow_run']['id']==run and a['workflow_run']['head_sha']==head and a['digest']=='sha256:'+digest and not a['expired']
jobs=get(f'actions/runs/{run}/jobs?per_page=100')['jobs']
if kind=='images':assert any(j['name']=='build' and j['conclusion']=='success' for j in jobs)
else:
 j=next(j for j in jobs if j['name']=='native-units');assert any(s['name']=='Compile exact native test harness (no browser auto-discovery)' and s['conclusion']=='success' for s in j['steps']);assert any(s['name']=='Run actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9' and s['conclusion']=='success' for s in j['steps'])
assert hashlib.sha256(pathlib.Path(archive).read_bytes()).hexdigest()==digest
root=pathlib.Path(destination);assert not root.exists();root.mkdir(parents=True)
with zipfile.ZipFile(archive) as z:
 infos=z.infolist();assert len(infos)==len(expected) and {i.filename for i in infos}==expected
 for i in infos:assert not i.is_dir() and not stat.S_ISLNK(i.external_attr>>16)
 assert z.read('native-source.sha').decode().strip()==native and z.read('native-source.tree').decode().strip()==tree
 if kind=='images':assert z.read('producer-run.id').decode().strip()==str(run)
 sums={}
 for line in z.read('SHA256SUMS').decode().splitlines():
  digest2,name=line.split('  ');assert re.fullmatch('[a-f0-9]{64}',digest2);assert name in expected and name not in sums;sums[name]=digest2;assert hashlib.sha256(z.read(name)).hexdigest()==digest2
 assert set(sums)==({'agent-browser-tests'} if kind=='harness' else {'production','acceptance-faults'})
 for i in infos:
  p=root/i.filename;p.write_bytes(z.read(i));p.chmod(0o755 if i.filename in sums else 0o644)
pathlib.Path(out).mkdir(exist_ok=True,parents=True)
(pathlib.Path(out)/('recovered-'+kind+'-provenance.json')).write_text(json.dumps({'source':native,'tree':tree,'artifactId':aid,'producerRun':run,'producerHead':head,'archiveSha256':digest,'binarySha256':sums,'newCompile':False,'importedTestPass':False,'originalFailedFocusedStepStillUnresolved':True,'distinctAttempt':True},indent=2)+'\n')
