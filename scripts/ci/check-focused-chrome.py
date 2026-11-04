"""Focused host preflight, not complete consumer installation acceptance."""
import hashlib,json,os,pathlib,signal,subprocess,tempfile
out=pathlib.Path('evidence'); roots=sorted((pathlib.Path.home()/'.agent-browser/browsers').glob('chrome-*'),reverse=True)
paths=[p for r in roots for p in (r/'chrome',r/'chrome-linux64/chrome') if p.is_file()]
assert paths,'installed native Chrome missing'
chrome=paths[0].resolve()
def depcheck():
 r=subprocess.run(['ldd',str(chrome)],capture_output=True,text=True,timeout=20)
 (out/'chrome-ldd.txt').write_text(r.stdout+r.stderr)
 return r.returncode==0 and 'not found' not in r.stdout+r.stderr
fallback=False
if not depcheck():
 fallback=True
 with (out/'missing-library-official-install.log').open('w') as log:
  subprocess.run([os.environ['E2E_AGENT_BROWSER_EXECUTABLE'],'install','--with-deps'],stdout=log,stderr=subprocess.STDOUT,timeout=180,check=True)
 assert depcheck(),'Chrome libraries still missing after bounded official dependency install'
version=subprocess.check_output([str(chrome),'--version'],text=True,timeout=10).strip()
with tempfile.TemporaryDirectory(prefix='focused-owned-chrome-',dir=os.environ['RUNNER_TEMP']) as profile:
 command=[str(chrome),'--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-default-browser-check','--user-data-dir='+profile,'--dump-dom','about:blank']
 proc=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 timed=False
 try:
  stdout,stderr=proc.communicate(timeout=15)
 except subprocess.TimeoutExpired:
  timed=True;os.killpg(proc.pid,signal.SIGKILL);stdout,stderr=proc.communicate(timeout=5)
 finally:
  try:os.killpg(proc.pid,signal.SIGKILL)
  except ProcessLookupError:pass
 assert not timed and proc.returncode==0 and b'<html' in stdout,'owned Chrome preflight did not exit normally'
fonts=subprocess.run(['fc-list'],capture_output=True,timeout=15)
(out/'focused-chrome.json').write_text(json.dumps({'acceptanceEvidence':False,'fullInstallationAcceptance':False,'chrome':str(chrome),'sha256':hashlib.sha256(chrome.read_bytes()).hexdigest(),'version':version,'lddMissing':False,'dependencyFallbackUsed':fallback,'ownedLaunchExit':proc.returncode,'ownedLaunchTimedOut':timed,'ownedProcessReaped':True,'osRelease':pathlib.Path('/etc/os-release').read_text(),'fontInventorySha256':hashlib.sha256(fonts.stdout).hexdigest(),'fontInventoryLines':len(fonts.stdout.splitlines())},indent=2)+'\n')
(out/'font-environment.txt').write_bytes(fonts.stdout)
