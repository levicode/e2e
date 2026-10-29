"""CI only: source/Node-bound generated JS assets, never node_modules/native binaries."""
import hashlib,json,os,pathlib,platform,subprocess,sys,tarfile,stat
ROOT=pathlib.Path.cwd();PACKAGES=['e2e','web','mobile','github','kernel','lightpanda','eas','smol','limrun','decision','testmu'];ROOTS=['packages/'+p+'/dist' for p in PACKAGES]+['packages/e2e/docs','packages/e2e/skills','packages/e2e/README.md']
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def cmd(*a):return subprocess.check_output(a,text=True).strip()
def inventory():
 out={}
 for root in ROOTS:
  p=pathlib.Path(root);assert p.exists(),root
  for f in ([p] if p.is_file() else sorted(p.rglob('*'))):
   assert not f.is_symlink(),str(f)
   if f.is_file():out[str(f)]={'sha256':sha(f),'mode':stat.S_IMODE(f.stat().st_mode),'bytes':f.stat().st_size}
 return out
def identity():return {'sourceCommit':cmd('git','rev-parse','HEAD'),'sourceTree':cmd('git','rev-parse','HEAD^{tree}'),'sourceInventorySHA256':sha('evidence/source-inventory.txt'),'lockSHA256':sha('pnpm-lock.yaml'),'producerRun':os.environ['EXPECTED_BUILD_RUN'],'producerAttempt':os.environ.get('EXPECTED_BUILD_ATTEMPT',os.environ['GITHUB_RUN_ATTEMPT']),'nodeSelector':os.environ['NODE_SELECTOR'],'platform':platform.system(),'architecture':platform.machine()}
mode=sys.argv[1];bundle=pathlib.Path('js-build-bundle')
if mode=='pack':
 bundle.mkdir();files=inventory()
 for package in PACKAGES:
  actual=json.loads(pathlib.Path('packages/'+package+'/package.json').read_text())['version'];assert json.loads(pathlib.Path('packages/'+package+'/dist/.build.json').read_text())['version']==actual
 m={**identity(),'nodeVersion':cmd('node','--version'),'pnpmVersion':cmd('pnpm','--version'),'typescriptVersion':cmd('pnpm','exec','tsc','--version'),'roots':ROOTS,'files':files,'buildCommand':'pnpm run build','buildExit':0}
 with tarfile.open(bundle/'outputs.tar.gz','w:gz') as t:
  for root in ROOTS:t.add(root,arcname=root,recursive=True)
 m['archiveSHA256']=sha(bundle/'outputs.tar.gz');(bundle/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
 pathlib.Path('evidence/build-manifest.json').write_text(json.dumps(m,indent=2)+'\n')
 with open(os.environ['GITHUB_OUTPUT'],'a') as f:f.write('manifest_sha='+sha(bundle/'manifest.json')+'\nattempt='+m['producerAttempt']+'\n')
elif mode in ('identity','restore','postcheck'):
 assert sha(bundle/'manifest.json')==os.environ['EXPECTED_BUILD_MANIFEST_SHA256']
 m=json.loads((bundle/'manifest.json').read_text());assert all(m[k]==v for k,v in identity().items()),'producer/source/host mismatch'
 assert m['roots']==ROOTS and m['buildExit']==0 and m['buildCommand']=='pnpm run build';assert sha(bundle/'outputs.tar.gz')==m['archiveSHA256']
 assert __import__('re').fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+',m['nodeVersion'])
 if mode=='identity':
  with open(os.environ['GITHUB_OUTPUT'],'a') as f:f.write('node_version='+m['nodeVersion']+'\n')
 elif mode=='restore':
  assert cmd('node','--version')==m['nodeVersion'];assert cmd('pnpm','--version')==m['pnpmVersion']
  # Clean only declared generated roots in this job-owned fresh checkout, never shared data.
  import shutil
  for root in ROOTS:
   p=pathlib.Path(root)
   if p.is_dir():shutil.rmtree(p)
   elif p.exists():p.unlink()
  with tarfile.open(bundle/'outputs.tar.gz','r:gz') as t:
   members=t.getmembers();regular=[]
   for x in members:
    assert not x.name.startswith('/') and '..' not in pathlib.PurePosixPath(x.name).parts
    assert any(x.name==r or x.name.startswith(r+'/') for r in ROOTS)
    assert x.isfile() or x.isdir()
    if x.isfile():regular.append(x.name)
   assert len(regular)==len(set(regular)) and set(regular)==set(m['files'])
   t.extractall('.',filter='data')
  assert inventory()==m['files'];pathlib.Path('evidence/build-manifest.json').write_text(json.dumps(m,indent=2)+'\n')
 else:
  current=inventory();assert current==m['files'],'test changed build assets; retain diff, do not pass altered inputs'
else:raise SystemExit('unknown mode')

