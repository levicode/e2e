"""Verify exact immutable prior-run artifacts; this is not a formal compilation receipt."""
import hashlib,json,os,pathlib,re,subprocess,sys,urllib.request,zipfile
ROOT=pathlib.Path(os.environ['GITHUB_WORKSPACE']);OUT=ROOT/'evidence';OUT.mkdir(exist_ok=True)
CONFIG=json.loads((pathlib.Path(__file__).parent/'source-reuse-pins.json').read_text())
kind=sys.argv[1];assert kind in ('images','default');spec=CONFIG['artifacts'][kind]
def api(path):
 req=urllib.request.Request('https://api.github.com/repos/levicode/e2e/'+path,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json'})
 return json.load(urllib.request.urlopen(req,timeout=30))
def sha(p):
 with open(p,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
r=api(f"actions/runs/{CONFIG['producerRun']}");assert r['head_sha']==CONFIG['producerRecipe']
a=api(f"actions/artifacts/{spec['id']}");assert a['id']==spec['id'] and a['name']==spec['name'] and not a['expired'] and a['digest']=='sha256:'+spec['sha256']
assert a['workflow_run']['id']==CONFIG['producerRun'] and a['workflow_run']['head_sha']==CONFIG['producerRecipe']
z=ROOT/(kind+'-verified.zip');subprocess.run(['curl','--fail','--silent','--show-error','--location','--retry','2','--max-time','180','-H','@-',f"https://api.github.com/repos/levicode/e2e/actions/artifacts/{spec['id']}/zip",'-o',str(z)],input='Authorization: Bearer '+os.environ['GH_TOKEN']+'\n',text=True,check=True)
assert sha(z)==spec['sha256'];dest=ROOT/('images' if kind=='images' else 'default-harnesses');dest.mkdir()
with zipfile.ZipFile(z) as archive:
 names=set()
 for info in archive.infolist():
  path=pathlib.PurePosixPath(info.filename);assert not path.is_absolute() and '..' not in path.parts and (info.external_attr>>16)&0o170000!=0o120000
  assert info.filename not in names;names.add(info.filename)
 archive.extractall(dest)
z.unlink()
if kind=='images':
 assert (dest/'native-source.sha').read_text().strip()==CONFIG['nativeSource'] and (dest/'native-source.tree').read_text().strip()==CONFIG['nativeTree'] and (dest/'producer-run.id').read_text().strip()==str(CONFIG['producerRun'])
 sums=(dest/'SHA256SUMS').read_text().splitlines();assert len(sums)==2 and {line.split()[1] for line in sums}=={'production','acceptance-faults'}
 for line in sums:
  digest,name=line.split();assert name in ('production','acceptance-faults') and re.fullmatch('[a-f0-9]{64}',digest);assert sha(dest/name)==digest
else:
 m=json.loads((dest/'manifest.json').read_text());assert m['nativeSource']==CONFIG['nativeSource'] and m['nativeTree']==CONFIG['nativeTree'] and m['producerRun']==str(CONFIG['producerRun'])
(OUT/(kind+'-reuse-binding.json')).write_text(json.dumps({'artifact':a,'producerRun':CONFIG['producerRun'],'producerRecipe':CONFIG['producerRecipe'],'currentRun':os.environ['GITHUB_RUN_ID'],'nativeSource':CONFIG['nativeSource'],'nativeTree':CONFIG['nativeTree'],'formalCompilationReceipt':False,'formalAcceptance':False},indent=2)+'\n')
