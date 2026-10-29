import hashlib,json,pathlib,subprocess
P=json.loads((pathlib.Path(__file__).parent/'pins.json').read_text())
changed=subprocess.check_output(['git','diff','--name-only','HEAD'],text=True).splitlines();assert changed==['packages/e2e/tests/helpers/run-project.ts']
for name,digest in P['custodyHelperHashes'].items():assert hashlib.sha256(pathlib.Path('packages/e2e/tests/helpers',name).read_bytes()).hexdigest()==digest
for name,p in P['tests'].items():assert hashlib.sha256(pathlib.Path('packages/e2e/tests/integration',name+'.test.ts').read_bytes()).hexdigest()==p['sha256']

unknown=subprocess.check_output(['git','ls-files','--others','--exclude-standard'],text=True).splitlines()
allowed={'packages/e2e/tests/helpers/short-read-report-custody.ts'}
assert {x for x in unknown if x.startswith(('packages/','scripts/','.github/'))} <= allowed,'unexpected untracked product source'
