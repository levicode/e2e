"""Restore verified prior-run compiler paths and select the unit harness for separate 44+13 contracts."""
import hashlib,json,os,pathlib,re,shutil,subprocess,sys
root=pathlib.Path(os.environ['GITHUB_WORKSPACE']);out=root/'evidence';out.mkdir(exist_ok=True);archive=root/'default-harnesses';m=json.loads((archive/'manifest.json').read_text());native=root/'native';target=pathlib.Path(os.environ['RUNNER_TEMP'])/'native-regressions-target'
assert m['nativeSource']==subprocess.check_output(['git','-C',str(native),'rev-parse','HEAD'],text=True).strip();assert m['nativeTree']==subprocess.check_output(['git','-C',str(native),'rev-parse','HEAD^{tree}'],text=True).strip();assert m['producerRun']=='40418477337';assert pathlib.Path(m['manifestPath'])==native/'cli/Cargo.toml';assert pathlib.Path(m['targetDir'])==target;assert hashlib.sha256((native/'cli/Cargo.lock').read_bytes()).hexdigest()==m['cargoLockSha256']
assert len({x['absolutePath'] for x in m['entries']})==len(m['entries'])
for x in m['entries']:
 src=archive/x['archivePath'];assert re.fullmatch(r'bins/[a-f0-9]{64}',x['archivePath']);assert hashlib.sha256(src.read_bytes()).hexdigest()==x['sha256'];dst=pathlib.Path(x['absolutePath']).resolve();assert dst.is_relative_to(target.resolve()) and not dst.exists();dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst);dst.chmod(0o755)
shutil.copyfile(archive/'manifest.json',out/'default-harness-manifest.json')
unit=next(x for x in m['entries'] if x['name']=='agent-browser' and x['isTest']);(out/'harness.path').write_text(unit['absolutePath']+'\n')
assert all(x["features"]==["default"] for x in m["entries"])
