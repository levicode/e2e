"""Restore exact compiler outputs for a distinct evidence attempt; import no test pass."""
import hashlib,json,os,pathlib,re,stat,sys,urllib.request,zipfile
kind,archive,destination,out=sys.argv[1:];native='011700397727e2351c2c60fa04be96e17887702b';tree='ee24e878213ca2d5489cd544fd8126a5a885da79';run=40358679059;head='68a28285983a35098dea4723fb89d79e2cb22187'
entries={'images':(12668260008,'2a5ce0bd08f01528a8251dee7c87391a93d46237261205d3a7de7432ff0cb4c1',{'production','acceptance-faults','native-source.sha','native-source.tree','producer-run.id','SHA256SUMS'})}
aid,digest,expected=entries[kind]
def get(path):
 req=urllib.request.Request('https://api.github.com/repos/levicode/e2e/'+path,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json'})
 with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)
a=get(f'actions/artifacts/{aid}');assert a['workflow_run']['id']==run and a['workflow_run']['head_sha']==head and a['digest']=='sha256:'+digest and not a['expired']
jobs=get(f'actions/runs/{run}/jobs?per_page=100')['jobs']
assert kind=='images' and any(j['name']=='build' and j['conclusion']=='success' for j in jobs)
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
(pathlib.Path(out)/('recovered-'+kind+'-provenance.json')).write_text(json.dumps({'source':native,'tree':tree,'artifactId':aid,'producerRun':run,'producerHead':head,'archiveSha256':digest,'binarySha256':sums,'newCompile':False,'importedTestPass':False,'nativeTestsNotImported':True,'distinctAttempt':True},indent=2)+'\n')
