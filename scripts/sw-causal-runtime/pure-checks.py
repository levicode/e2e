#!/usr/bin/env python3
import copy
import importlib.util
import json
import os
from unittest.mock import patch
from pathlib import Path
import unittest
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('evidence',HERE/'evidence.py'); E=importlib.util.module_from_spec(spec);spec.loader.exec_module(E)

def fixture():
    rows=[]
    def add(sw,**extra):
        i=len(rows);rows.append(dict(schemaVersion=2,source='native',pid=42,record=i,operationSeq=0,phase='ServiceWorkerCausal',droppedBefore=0,emittedBefore=i,suppressedBefore=0,overflow=False,sw=dict(o=i+1,n=1,**sw),**extra))
    add(dict(k=1,g=1,h=1,s=123,t=456))
    for st in (2,3,4,5,6): add(dict(k=2,st=st,f=1))
    add(dict(k=4,st=4,a=3,b=3,f=35|(7<<8)))
    add(dict(k=5,st=7,e=[0xffffffff,0],v=[0,0],w=[5,5,None]))
    for m in (1,2,3,5,6): add(dict(k=3,m=m,id=(1<<63)+m,so=100+m,ro=90+m,f=63|1024|(2<<11)|16384,h=1,s=123))
    add(dict(k=6,st=7,f=1,e=[0xffffffff,0],v=[0,0]))
    add(dict(k=7,a=len(rows),b=len(rows)))
    return rows

INV={'processes':[{'role':'native','pid':42,'terminalFileOwnerObservation':{'writable':True}}]}
def decode(rows,inventory=INV):return E.decode_bytes(('\n'.join(json.dumps(r) for r in rows)+'\n').encode(),inventory)

class PureChecks(unittest.TestCase):
    def test_success_requires_actual_hook_records_not_title(self):
        rows,result=decode(fixture());self.assertTrue(result['positiveControlVisible']);self.assertEqual(result['status'],'unknown');self.assertFalse(result['globalLosslessCapture']);self.assertEqual(rows[8]['sw']['id'],(1<<63)+1)
    def test_ro_before_so_is_valid_observation(self):self.assertTrue(decode(fixture())[1]['positiveControlVisible'])
    def test_missing_each_required_kind_and_method_blocks(self):
        for i in range(len(fixture())):
            rows=fixture();del rows[i];self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_code_is_lossless_but_not_success(self):
        rows=fixture();rows[8]['sw']['c']=-(1<<63);rows[8]['sw']['f']|=64|512
        parsed,result=decode(rows);self.assertEqual(parsed[8]['sw']['c'],-(1<<63));self.assertFalse(result['positiveControlVisible'])
    def test_missing_owner_blocks(self):self.assertFalse(decode(fixture(),{})[1]['positiveControlVisible'])
    def test_integer_precision_not_float(self):
        rows=fixture();rows[8]['sw']['id']=float(1<<63);self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_unknown_phase_not_rejected_old_collector(self):
        rows=fixture();self.assertTrue(decode(rows)[1]['positiveControlVisible']);self.assertIn('ServiceWorkerCausal',(HERE/'runtime.mjs').read_text());self.assertNotIn('collector.collectCleanupCapture',(HERE/'runtime.mjs').read_text())
    def test_loss_and_caps_unknown(self):
        for key,value in [('droppedBefore',1),('suppressedBefore',1),('overflow',True)]:
            rows=fixture();rows[-1][key]=value;self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_closed_fields_and_duplicate_slot(self):
        for change in ('extra','duplicate','status','unknown'):
            rows=fixture()
            if change=='extra':rows[8]['sw']['payload']='forbidden'
            if change=='duplicate':rows[9]['sw']['m']=1
            if change=='status':rows[8]['sw']['f'] ^= (1<<11)
            if change=='unknown':rows[8]['sw'].pop('ro')
            self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_batch_outer_ok_is_not_final_success(self):
        rows=fixture();rows[-2]['sw']['f']=3;self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_duplicate_json_key_refused(self):
        raw=b'{"schemaVersion":2,"schemaVersion":2}\n';self.assertFalse(E.decode_bytes(raw,INV)[1]['positiveControlVisible'])
    def test_masks_unknown_unevaluated_preserved(self):
        rows=fixture();rows[7]['sw']['e']=[0,0];rows[7]['sw']['w']=[None,None,None];actual,_=decode(rows);self.assertEqual(actual[7]['sw']['w'],[None,None,None]);self.assertEqual(actual[7]['sw']['e'],[0,0])

    def test_success_association_and_batch_counts_required(self):
        for field,value in [('s',321),('h',0)]:
            rows=fixture();rows[8]['sw'][field]=value;self.assertFalse(decode(rows)[1]['positiveControlVisible'])
        for field,value in [('a',2),('b',4),('f',3),('st',2)]:
            rows=fixture();rows[6]['sw'][field]=value;self.assertFalse(decode(rows)[1]['positiveControlVisible'])

class ArtifactMetadataChecks(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location('artifact',HERE/'artifact.py');self.A=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.A)
        self.env={'DIAGNOSTIC_ARTIFACT_ID':'123','DIAGNOSTIC_ARTIFACT_DIGEST':'a'*64,'GITHUB_RUN_ID':'456','GITHUB_RUN_ATTEMPT':'1','GITHUB_WORKFLOW_SHA':'b'*40}
        self.meta={'id':123,'expired':False,'digest':'sha256:'+'a'*64,'name':f"temporary-sw-causal-native-linux-x64-{self.A.PINS['nativeSha']}-456-1",'workflow_run':{'id':456,'head_sha':'b'*40}}
        self.jobs={'jobs':[{'name':'temporary-sw-causal-compile','run_id':456,'run_attempt':1,'head_sha':'b'*40,'status':'completed','conclusion':'success'}]}
    def test_current_metadata_accepted(self):
        with patch.dict(os.environ,self.env):self.A.verify_metadata(self.meta,self.jobs,'a'*64)
    def test_prior_run_attempt_recipe_or_failed_job_rejected(self):
        for key,value in [('run_id',455),('run_attempt',2),('head_sha','c'*40),('status','in_progress'),('conclusion','failure')]:
            jobs=copy.deepcopy(self.jobs);jobs['jobs'][0][key]=value
            with patch.dict(os.environ,self.env),self.assertRaises(AssertionError):self.A.verify_metadata(self.meta,jobs,'a'*64)
    def test_archive_wrong_metadata_or_digest_rejected(self):
        for key,value in [('id',124),('expired',True),('digest','sha256:'+'c'*64),('name','formal-production')]:
            meta=copy.deepcopy(self.meta);meta[key]=value
            with patch.dict(os.environ,self.env),self.assertRaises(AssertionError):self.A.verify_metadata(meta,self.jobs,'a'*64)
        with patch.dict(os.environ,self.env),self.assertRaises(AssertionError):self.A.verify_metadata(self.meta,self.jobs,'c'*64)
    def test_duplicate_compile_or_wrong_source_run_rejected(self):
        jobs=copy.deepcopy(self.jobs);jobs['jobs']*=2
        with patch.dict(os.environ,self.env),self.assertRaises(AssertionError):self.A.verify_metadata(self.meta,jobs,'a'*64)
        for key,value in [('id',455),('head_sha','c'*40)]:
            meta=copy.deepcopy(self.meta);meta['workflow_run'][key]=value
            with patch.dict(os.environ,self.env),self.assertRaises(AssertionError):self.A.verify_metadata(meta,self.jobs,'a'*64)

if __name__=='__main__':unittest.main()
