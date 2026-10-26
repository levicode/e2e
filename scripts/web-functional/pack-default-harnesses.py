"""Bind all Cargo default test targets and the compiled CLI, without claiming test success."""
import hashlib,json,os,pathlib,shutil,subprocess,sys
root=pathlib.Path(os.environ['GITHUB_WORKSPACE']);e=root/'evidence';out=root/'default-harnesses';out.mkdir();(out/'bins').mkdir()
records=[json.loads(x) for x in (e/'harness.jsonl').read_text().splitlines()];assert [x.get('success') for x in records if x.get('reason')=='build-finished']==[True]
meta=json.loads(subprocess.check_output(['cargo','metadata','--locked','--no-deps','--format-version','1'],text=True));pkg=next(p for p in meta['packages'] if pathlib.Path(p['manifest_path']).resolve()==(root/'native/cli/Cargo.toml').resolve())
defaults={'default'};defaults.update(pkg['features'].get('default',[]));expected={t['name']:t for t in pkg['targets'] if t.get('test') and set(t['kind'])&{'bin','lib','test'} and set(t.get('required-features',[]))<=defaults}
artifacts=[x for x in records if x.get('reason')=='compiler-artifact' and x.get('package_id')==pkg['id'] and x.get('executable')]
assert set(expected)=={'agent-browser','dashboard_cli','doctor_cli','obscura_cli','pin_tab_cli','tls_cli'},set(expected)
tests={x['target']['name']:x for x in artifacts if x['profile']['test']};assert set(tests)==set(expected),(set(tests),set(expected))
normal=[x for x in artifacts if x['target']['name']=='agent-browser' and 'bin' in x['target']['kind'] and not x['profile']['test']];assert len(normal)==1
entries=[]
for x in list(tests.values())+normal:
 p=pathlib.Path(x['executable']);digest=hashlib.sha256(p.read_bytes()).hexdigest();name='bins/'+digest;shutil.copyfile(p,out/name)
 entries.append({'name':x['target']['name'],'kind':x['target']['kind'],'isTest':x['profile']['test'],'features':x['features'],'absolutePath':str(p),'archivePath':name,'sha256':digest,'bytes':p.stat().st_size})
unit=tests['agent-browser'];(e/'harness.path').write_text(unit['executable']+'\n')
manifest={'nativeSource':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'nativeTree':subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip(),'cargoLockSha256':hashlib.sha256(pathlib.Path('Cargo.lock').read_bytes()).hexdigest(),'manifestPath':pkg['manifest_path'],'targetDir':os.environ['CARGO_TARGET_DIR'],'producerRun':os.environ['GITHUB_RUN_ID'],'compilerCommand':'cargo test --locked --profile ci --no-run --message-format=json','defaultTestTargets':sorted(expected),'doctestTargets':[t['name'] for t in pkg['targets'] if t.get('doctest') and 'lib' in t['kind']],'entries':entries,'testPassClaim':False}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');shutil.copyfile(out/'manifest.json',e/'default-harness-manifest.json');(out/'SHA256SUMS').write_text(''.join(v['sha256']+'  '+v['archivePath']+'\n' for v in entries));print(json.dumps({'defaultTargets':sorted(expected),'doctestTargets':manifest['doctestTargets'],'executables':len(entries)}))
