"""Restore exact absolute compiler paths and execute every default test target without a filter."""
import hashlib,json,os,pathlib,re,shutil,subprocess,sys
root=pathlib.Path(os.environ['GITHUB_WORKSPACE']);out=root/'evidence';out.mkdir(exist_ok=True);archive=root/'default-harnesses';m=json.loads((archive/'manifest.json').read_text());native=root/'native';target=pathlib.Path(os.environ['RUNNER_TEMP'])/'native-regressions-target'
assert m['nativeSource']==subprocess.check_output(['git','-C',str(native),'rev-parse','HEAD'],text=True).strip();assert m['nativeTree']==subprocess.check_output(['git','-C',str(native),'rev-parse','HEAD^{tree}'],text=True).strip();assert m['producerRun']==os.environ['GITHUB_RUN_ID'];assert pathlib.Path(m['manifestPath'])==native/'cli/Cargo.toml';assert pathlib.Path(m['targetDir'])==target;assert hashlib.sha256((native/'cli/Cargo.lock').read_bytes()).hexdigest()==m['cargoLockSha256']
assert len({x['absolutePath'] for x in m['entries']})==len(m['entries'])
for x in m['entries']:
 src=archive/x['archivePath'];assert re.fullmatch(r'bins/[a-f0-9]{64}',x['archivePath']);assert hashlib.sha256(src.read_bytes()).hexdigest()==x['sha256'];dst=pathlib.Path(x['absolutePath']);assert dst.is_relative_to(target) and not dst.exists();dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst);dst.chmod(0o755)
shutil.copyfile(archive/'manifest.json',out/'default-harness-manifest.json')
unit=next(x for x in m['entries'] if x['name']=='agent-browser' and x['isTest']);(out/'harness.path').write_text(unit['absolutePath']+'\n')
if '--restore-only' in sys.argv:sys.exit(0)
failed=False;results=[]
# No doctest target may disappear from a claim of Cargo-equivalent coverage.
if m['doctestTargets']:
 (out/'unsupported-doctests.json').write_text(json.dumps(m['doctestTargets'])+'\n');failed=True
selected=sys.argv[sys.argv.index('--target')+1] if '--target' in sys.argv else None
assert selected is None or selected in m['defaultTestTargets']
for index,x in enumerate([x for x in m['entries'] if x['isTest'] and (selected is None or x['name']==selected)],1):
 stem=out/f'default-{index}';p=x['absolutePath'];listed=subprocess.run([p,'--list'],capture_output=True,text=True,cwd=native/'cli');stem.with_suffix('.inventory').write_text(listed.stdout+listed.stderr);assert listed.returncode==0
 with stem.with_suffix('.log').open('w') as log:
  result=subprocess.run([p],cwd=native/'cli',stdout=log,stderr=subprocess.STDOUT,env={**os.environ,'CARGO_MANIFEST_DIR':str(native/'cli'),'CARGO_MANIFEST_PATH':str(native/'cli/Cargo.toml'),'RUST_MIN_STACK':'16777216'})
 stem.with_suffix('.exit').write_text(str(result.returncode)+'\n');text=stem.with_suffix('.log').read_text();counts=re.findall(r'test result: .*? (\d+) passed; (\d+) failed; (\d+) ignored;',text);results.append({'name':x['name'],'exit':result.returncode,'counts':counts,'filter':None,'ignoredExplicitlyEnabled':False});failed|=result.returncode!=0 or len(counts)!=1
 (out/'default-progress.json').write_text(json.dumps({'executed':results,'expected':m['defaultTestTargets'],'literalCargoExecution':False,'compilerSelectedDefaultTargets':True},indent=2)+'\n')
sys.exit(1 if failed else 0)
