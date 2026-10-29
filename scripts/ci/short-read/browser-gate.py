import hashlib,json,pathlib,os
P=json.loads((pathlib.Path(__file__).parent/'pins.json').read_text());rows=json.loads(pathlib.Path('evidence/native-installed-browsers.json').read_text());assert len(rows)==1
r=rows[0];assert r['sha256']==P['browserSHA256'] and r['version']==P['browserVersion'];assert hashlib.sha256(pathlib.Path(r['path']).read_bytes()).hexdigest()==P['browserSHA256']
