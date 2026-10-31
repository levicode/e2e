"""Pure synthetic API/ZIP controls; never contact a service."""
from pathlib import Path
import importlib.util,json,copy,io,zipfile,hashlib
p=Path(__file__).with_name('restore-baseline-installed.py');s=importlib.util.spec_from_file_location('restore',p);r=importlib.util.module_from_spec(s);s.loader.exec_module(r)
pin=json.loads(Path(__file__).with_name('baseline-installed-binding.json').read_bytes())['ordinary'];exp=pin['expected'];a={'id':pin['artifactId'],'name':pin['artifactName'],'expired':False,'size_in_bytes':pin['artifactSize'],'digest':pin['artifactDigest'],'workflow_run':{'id':int(exp['runId']),'head_sha':exp['source']['commit']}};run={'id':int(exp['runId']),'run_attempt':1,'head_sha':exp['source']['commit'],'workflow_id':pin['producer']['workflowId'],'status':'completed','conclusion':'success'};jobs={'total_count':1,'jobs':[{'id':pin['producer']['jobId'],'name':pin['producer']['jobName'],'head_sha':exp['source']['commit'],'run_id':int(exp['runId']),'run_attempt':1,'status':'completed','conclusion':'success'}]};collection={'total_count':1,'artifacts':[a]};r.verify_api(pin,a,run,jobs,collection)
def rejects(f):
 try:f()
 except (ValueError,KeyError,AssertionError):return
 raise AssertionError('negative accepted')
for where,key,value in [('artifact','id',1),('artifact','expired',True),('artifact','digest','sha256:'+'0'*64),('run','run_attempt',2),('run','head_sha','f'*40),('run','workflow_id',1),('run','conclusion','failure'),('jobs','total_count',2),('collection','total_count',2)]:
 aa,rr,jj,cc=copy.deepcopy((a,run,jobs,collection));target={'artifact':aa,'run':rr,'jobs':jj,'collection':cc}[where];target[key]=value;rejects(lambda:r.verify_api(pin,aa,rr,jj,cc))
def archive(extra=False):
 b=io.BytesIO()
 with zipfile.ZipFile(b,'w')as z:
  for name in ['agent-browser','compiler.jsonl','manifest.json','rustc.txt']+(['../foreign']if extra else[]):z.writestr(name,b'never executable')
 return b.getvalue()
b=archive();p={**pin,'artifactSize':len(b),'artifactDigest':'sha256:'+hashlib.sha256(b).hexdigest()};assert len(r.members(b,p))==4;rejects(lambda:r.members(b+b'x',p));bad=archive(True);rejects(lambda:r.members(bad,{**p,'artifactSize':len(bad),'artifactDigest':'sha256:'+hashlib.sha256(bad).hexdigest()}));print('PASS 2 positive / 11 negative API+ZIP pure controls; no network/native/install')
