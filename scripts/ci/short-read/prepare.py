"""Review-only CI preparation. Does not execute tests or native tools."""
import hashlib,json,os,pathlib,shutil,subprocess
D=pathlib.Path(__file__).resolve().parent;P=json.loads((D/'pins.json').read_text());E=pathlib.Path('evidence');E.mkdir();(E/'tools').mkdir()
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def git(*a):return subprocess.check_output(['git',*a],text=True).strip()
assert git('rev-parse','HEAD')==P['sourceCommit'];assert git('rev-parse','HEAD^{tree}')==P['sourceTree'];assert not git('status','--porcelain','--untracked-files=no')
for name,v in P['tests'].items():assert sha('packages/e2e/tests/integration/'+name+'.test.ts')==v['sha256']
for name in ['build-assets.py','download-runtime.py','verify-runtimes.ts']:shutil.copyfile(D/name,E/'tools'/name)
(E/'source.commit').write_text(P['sourceCommit']+'\n');(E/'source.tree').write_text(P['sourceTree']+'\n')
inv='\n'.join(x for x in git('ls-tree','-r','HEAD').splitlines() if not x.endswith('\t.github/workflows/full-standard-node-matrix.yml') and not x.endswith('\tscripts/ci/full-standard-runtime-pins.json'))+'\n';(E/'source-inventory.txt').write_text(inv)
assert sha(E/'source-inventory.txt')=='7b805c956f648d103d6a1e40796186d9f5e48e250bda5e55dfbfa39b58e8020d'
assert sha('scripts/ci/full-standard-runtime-pins.json')=='ce55875ce5f50ed3b976212da24f980b5fa549cd0e6d63722f26bce4b913c4ad'
# Diagnostic checkout owns ONLY these reviewed helper deltas; no product/test suite copy.
for name,digest in P['custodyHelperHashes'].items():
 h=D.parents[2]/'packages/e2e/tests/helpers'/name
 assert sha(h)==digest,'custody delta is not reviewed/pinned'
 shutil.copyfile(h,pathlib.Path('packages/e2e/tests/helpers')/name)
(E/'custody-helper-hashes.json').write_text(json.dumps(P['custodyHelperHashes'],indent=2)+'\n')
