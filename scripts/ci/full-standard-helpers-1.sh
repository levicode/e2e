cat > evidence/tools/build-assets.py <<'HELPER_0'
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
def identity():return {'sourceCommit':cmd('git','rev-parse','HEAD'),'sourceTree':cmd('git','rev-parse','HEAD^{tree}'),'sourceInventorySHA256':sha('evidence/source-inventory.txt'),'lockSHA256':sha('pnpm-lock.yaml'),'producerRun':os.environ['GITHUB_RUN_ID'],'producerAttempt':os.environ.get('EXPECTED_BUILD_ATTEMPT',os.environ['GITHUB_RUN_ATTEMPT']),'nodeSelector':os.environ['NODE_SELECTOR'],'platform':platform.system(),'architecture':platform.machine()}
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

HELPER_0
cat > evidence/tools/download-runtime.py <<'HELPER_1'
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

HELPER_1
cat > evidence/tools/verify-runtimes.ts <<'HELPER_2'
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,lstatSync,chmodSync,appendFileSync,copyFileSync,writeFileSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyArtifact} from '../../scripts/ci/native-runtime.ts';
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
function verifyCompilerPin(dir:string,p:any,m:any,fault:boolean) {
 const c=p.compiler;assert.equal(m.compilerSha256,c.compilerSHA256);assert.equal(m.rustcSha256,c.rustcSHA256);
 assert.equal(readFileSync(join(dir,'rustc.txt'),'utf8').split('\n')[0],c.rustcVersion);
 for(const k of ['manifestPath','sourcePath','executable'])assert.equal(m.compilation[k],c[k]);
 assert.ok(c.manifestPath.endsWith('/cli/Cargo.toml'));assert.equal(c.sourcePath,c.manifestPath.replace(/Cargo\.toml$/,'src/main.rs'));assert.ok(c.executable.endsWith('/ci/agent-browser'));
 assert.deepEqual(c.command,['cargo','build','--locked','--profile','ci','--no-default-features',...(fault?['--features','acceptance-faults']:[]),'--message-format=json']);
}
const pins=JSON.parse(readFileSync('scripts/ci/full-standard-runtime-pins.json','utf8'));
assert.equal(pins.configured,true);const current=JSON.parse(readFileSync('.github/native-candidate.json','utf8'));
assert.deepEqual(pins.ordinary.nativeSource,pins.fault.nativeSource);assert.equal(current.commit,pins.ordinary.nativeSource.commit);
const ordinaryDir=join(process.env.RUNNER_TEMP!,'ci-native-ordinary');const op=pins.ordinary;
assert.equal(op.expected.platform,process.platform);assert.equal(op.expected.architecture,process.arch);
const ordinary=verifyArtifact(ordinaryDir,op.manifestSha256,op.expected);const om=JSON.parse(readFileSync(join(ordinaryDir,'manifest.json'),'utf8'));
verifyCompilerPin(ordinaryDir,op,om,false);assert.deepEqual(om.nativeSource,op.nativeSource);assert.equal(hash(ordinary),op.binarySha256);chmodSync(ordinary,0o755);
appendFileSync(process.env.GITHUB_ENV!,`E2E_AGENT_BROWSER_EXECUTABLE=${ordinary}\n`);
copyFileSync(join(ordinaryDir,'manifest.json'),'evidence/ordinary.manifest.json');
if(process.env['NEED_FAULT']==='1') {
 const p=pins.fault;assert.equal(p.testOnly,true);const dir=join(process.env.RUNNER_TEMP!,'ci-native-fault');
 const files=['agent-browser','compiler.jsonl','manifest.json','rustc.txt'].sort();assert.deepEqual(readdirSync(dir).sort(),files);
 for(const f of files)assert.ok(lstatSync(join(dir,f)).isFile());assert.equal(hash(join(dir,'manifest.json')),p.manifestSha256);
 const m=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));assert.equal(m.schemaVersion,1);assert.equal(m.kind,'source-built-ci-runtime');assert.equal(m.acceptanceEvidence,false);
 for(const [k,v] of Object.entries(p.expected))if(k!=='nativeCommit')assert.deepEqual(m[k],v);
 assert.equal(m.platform,process.platform);assert.equal(m.architecture,process.arch);assert.equal(m.nativeRepository,'levicode/agent-browser');assert.deepEqual(m.nativeSource,p.nativeSource);assert.equal(m.nativeSource.commit,p.expected.nativeCommit);
 verifyCompilerPin(dir,p,m,true);assert.equal(m.compilation.profile,'ci');assert.deepEqual(m.compilation.features,['acceptance-faults']);for(const k of ['manifestPath','sourcePath','executable'])assert.ok(isAbsolute(m.compilation[k]));
 for(const [f,k] of [['agent-browser','binarySha256'],['compiler.jsonl','compilerSha256'],['rustc.txt','rustcSha256']])assert.equal(hash(join(dir,f!)),m[k!]);assert.equal(m.binarySha256,p.binarySha256);assert.notEqual(m.binarySha256,op.binarySha256);
 const rows=readFileSync(join(dir,'compiler.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));const done=rows.filter(x=>x.reason==='build-finished');assert.equal(done.length,1);assert.equal(done[0].success,true);
 const binaries=rows.filter(x=>x.reason==='compiler-artifact'&&x.target?.name==='agent-browser'&&x.profile?.test===false);assert.equal(binaries.length,1);const b=binaries[0];assert.deepEqual(b.features,['acceptance-faults']);assert.deepEqual(b.target.kind,['bin']);assert.equal(b.manifest_path,m.compilation.manifestPath);assert.equal(b.target.src_path,m.compilation.sourcePath);assert.equal(b.executable,m.compilation.executable);
 const fault=resolve(dir,'agent-browser');chmodSync(fault,0o755);appendFileSync(process.env.GITHUB_ENV!,`FULL_NODE_FAULT_EXECUTABLE=${fault}\n`);copyFileSync(join(dir,'manifest.json'),'evidence/fault.manifest.json');
}

HELPER_2
