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

INV={'processes':[{'role':'native','pid':42,'terminalFileOwnerObservation':{'writable':True}}]}
def envelope(sw=None):
    row=dict(schemaVersion=2,source='native',pid=42,record=0,operationSeq=0,phase='ServiceWorkerCausal' if sw else 'CaptureStarted',droppedBefore=0,emittedBefore=0,suppressedBefore=0,overflow=False)
    if sw:row['sw']=dict(n=1,**sw)
    return row

def fix_counters(rows):
    for i,r in enumerate(rows):r.update(record=i,emittedBefore=i)
    for r in rows:
        if r.get('sw',{}).get('k')==7:
            r['sw']['a']=r['record'];r['sw']['b']=sum(1 for x in rows if x.get('sw',{}).get('n')==r['sw']['n'] and 1<=x['sw']['k']<=6)
    return rows

def find(rows,kind,field=None,value=None):
    return next(r for r in rows if r.get('sw',{}).get('k')==kind and (field is None or r['sw'].get(field)==value))

def fixture(branch='ready'):
    rows=[envelope()]
    def add(sw,**extra):rows.append(dict(envelope(sw),**extra))
    e=sum(1<<i for i in E.READY_BITS|{0,1,2,3,4,5,6,7,12});v=sum(1<<i for i in E.READY_TRUE|{0,1})
    pair=lambda x:[x&0xffffffff,x>>32]
    add(dict(o=1,k=1,g=1,h=1,s=123,t=456))
    for st,o in [(2,25),(3,28),(4,33)]:add(dict(o=o,k=2,st=st,f=1))
    add(dict(o=34,k=20,h=1,s=123,t=456))
    add(dict(o=35,k=2,st=5,f=1))
    add(dict(o=51,k=4,st=4,a=3,b=3,f=1827,e=[4351,0],v=[3,0]))
    add(dict(o=52,k=2,st=6,f=1))
    add(dict(o=77,k=5,st=7,e=pair(e),v=pair(v),a=76,w=[None,None,None]))
    add(dict(o=78,k=21,h=1,s=123,t=456,a=3,b=0))
    for j,(m,so,ro) in enumerate([(1,23,22),(2,26,27),(3,37,42),(5,38,43),(6,39,44)]):
        add(dict(o=79+j,k=3,m=m,id=(1<<63)+m,so=so,ro=ro,f=21567,h=1,s=123))
    add(dict(o=84,k=6,st=7,f=1,e=pair(e),v=pair(v),a=76,w=[None,None,None]))
    add(dict(o=85,k=7,a=0,b=0))
    if branch!='ready':
        batch=find(rows,4)['sw'];batch.update(o=60,st=2 if branch=='no-receipt' else 3,f=1831,e=[8191,0],v=[771 if branch=='no-receipt' else 3843,0],d=50)
        outer=find(rows,2,'st',6);outer['sw']['o']=62
        method=find(rows,3,'m',3)['sw'];method['f']|=64|512;method['c']=-32000
        find(rows,21)['sw']['a']=6
        final=find(rows,6);final['sw'].update(st=6 if branch=='no-receipt' else 8,f=3);final['error']='browser-failure'
        if branch=='no-receipt':
            rows.remove(find(rows,5));rows.insert(rows.index(outer),dict(envelope(dict(o=61,k=2,st=6,f=0)),error='browser-failure'))
            rows.insert(rows.index(outer)+1,dict(envelope(dict(o=63,k=2,st=6,f=0)),error='browser-failure'))
        else:
            gate=find(rows,5);gate['sw'].update(st=8,e=pair(1<<41),v=pair(1<<41),b=81,w=[9,9,None]);gate['error']='stale-scope'
            final['error']='scope-unavailable' # later quarantine may replace error
            if branch=='retired':
                gate.pop('error');gate['sw'].pop('b');gate['sw'].update(e=pair(sum(1<<i for i in E.RETIRE_BITS|set(range(13)))),v=pair(sum(1<<i for i in E.RETIRE_TRUE|{0,1,8,9,10,11})))
                find(rows,21)['sw']['a']=3;final['sw']['f']=2;final['error']='browser-failure'
            for key in ('e','v','a','b','w'):
                if key in gate['sw']: final['sw'][key]=copy.deepcopy(gate['sw'][key])
                else: final['sw'].pop(key,None)
    return fix_counters(rows)

def decode(rows,inventory=INV):return E.decode_bytes(('\n'.join(json.dumps(r) for r in rows)+'\n').encode(),inventory)
def verdict(rows):return decode(rows)[1]['traceVerdicts'][0]

class PureChecks(unittest.TestCase):
    def test_strict_success_scope_not_global_lossless(self):
        rows,result=decode(fixture());self.assertTrue(result['positiveControlVisible']);self.assertEqual(result['status'],'unknown');self.assertFalse(result['globalLosslessCapture']);self.assertEqual(result['scopeDecoderVersion'],'sw-causal-scope-closure-v1')
        self.assertEqual(find(rows,3,'m',1)['sw']['id'],(1<<63)+1);self.assertEqual(result['traceVerdicts'][0]['traceAttemptPrefix'],14)
    def test_ro_before_so_valid_but_before_relevant_decision_required(self):self.assertTrue(decode(fixture())[1]['positiveControlVisible'])
    def test_global_drops_and_forward_gaps_do_not_erase_complete_scope(self):
        rows=fixture()
        for r in rows[2:]:r['record']+=18;r['droppedBefore']=18
        find(rows,7)['sw']['a']+=18
        result=decode(rows)[1];self.assertTrue(result['positiveControlVisible']);self.assertFalse(result['globalLosslessCapture']);self.assertIn('observed-global-drops',result['observedIssues'])
    def test_missing_each_actual_required_row_blocks(self):
        for i in range(len(fixture())):
            rows=fixture();del rows[i];self.assertFalse(decode(rows)[1]['positiveControlVisible'],i)
    def test_missing_each_begin_target_field_blocks(self):
        for key in ('g','s','t','h'):
            rows=fixture();find(rows,1)['sw'].pop(key);self.assertFalse(decode(rows)[1]['positiveControlVisible'],key)
    def test_wrong_permit_target_session_or_scope_blocks(self):
        for kind in (20,21):
            for key,val in [('s',321),('t',654),('h',0),('n',2)]:
                rows=fixture();find(rows,kind)['sw'][key]=val;self.assertFalse(decode(rows)[1]['positiveControlVisible'],(kind,key))
    def test_incomplete_permit_drop_not_completed_or_integrity_lost_blocks(self):
        for key,val in [('a',0),('a',1),('a',7),('b',None)]:
            rows=fixture();find(rows,21)['sw'][key]=val;self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_wrong_tenure_predicate_cannot_be_accepted_as_ready(self):
        rows=fixture()
        for kind in (5,6):find(rows,kind)['sw']['e'][1]|=1<<(44-32)
        self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_hidden_trace_attempt_or_final_missing_blocks(self):
        for delta in (-1,1):
            rows=fixture();find(rows,7)['sw']['b']+=delta;self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_gate_masks_unknown_or_inconsistent_blocks(self):
        for key,val in [('e',[0,0]),('v',[0,0]),('a',None),('st',8)]:
            rows=fixture();find(rows,5)['sw'][key]=val;self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_required_origin_relations_and_fixed_order(self):
        for kind,field,val in [(6,'o',0),(7,'o',80),(5,'o',50),(20,'o',36),(21,'o',76)]:
            rows=fixture();find(rows,kind)['sw'][field]=val;self.assertFalse(decode(rows)[1]['positiveControlVisible'])
        for method,key,val in [(3,'ro',1000),(1,'ro',26),(2,'so',20),(5,'so',36),(6,'id',(1<<63)+1)]:
            rows=fixture();find(rows,3,'m',method)['sw'][key]=val;self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_loss_of_unrelated_trace_cannot_supply_required_begin(self):
        rows=fixture();other=copy.deepcopy(rows[1:])
        for r in other:r['sw']['n']=2;r['sw']['o']+=100
        other=[r for r in other if r['sw']['k']!=1]
        rows+=other
        for i,r in enumerate(rows):r['record']=i;r['emittedBefore']=i
        for r in rows:
            if r.get('sw',{}).get('k')==7:r['sw']['a']=r['record']
        result=decode(rows)[1];self.assertTrue(result['positiveControlVisible']);self.assertEqual(result['visiblePositiveTraceCount'],1)
        bad=result['traceVerdicts'][1];self.assertEqual(bad['status'],'unknown');self.assertIn('trace-attempt-prefix-count-mismatch',bad['missingFacts'])
    def test_code_lossless_not_success(self):
        rows=fixture();m=find(rows,3,'m',3)['sw'];m['c']=-(1<<63);m['f']|=64|512
        parsed,result=decode(rows);self.assertEqual(find(parsed,3,'m',3)['sw']['c'],-(1<<63));self.assertFalse(result['positiveControlVisible'])
    def test_owner_or_capture_start_missing_blocks(self):
        self.assertFalse(decode(fixture(),{})[1]['positiveControlVisible'])
        rows=fixture();rows[0]['phase']='Other';self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_floats_closed_schema_and_ambiguous_duplicates_block(self):
        for key,val in [('id',float(1<<63)),('payload','forbidden'),('ro',None),('f',True)]:
            rows=fixture();find(rows,3,'m',3)['sw'][key]=val;self.assertFalse(decode(rows)[1]['positiveControlVisible'])
        for mutate in ('slot','origin','record'):
            rows=fixture()
            if mutate=='slot':find(rows,3,'m',2)['sw']['m']=1
            if mutate=='origin':find(rows,3,'m',2)['sw']['o']=find(rows,3,'m',1)['sw']['o']
            if mutate=='record':rows[-1]['record']=rows[-2]['record']
            self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_suppression_overflow_caps_remain_unknown(self):
        for key,val in [('suppressedBefore',1),('overflow',True),('phase','CaptureLimitReached')]:
            rows=fixture();rows[-1][key]=val;self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_success_session_flags_and_batch_counts_required(self):
        for field,value in [('s',321),('h',0),('f',21567^16384),('f',21567^2048)]:
            rows=fixture();find(rows,3,'m',3)['sw'][field]=value;self.assertFalse(decode(rows)[1]['positiveControlVisible'])
        for field,value in [('a',2),('b',4),('f',3),('st',2)]:
            rows=fixture();find(rows,4)['sw'][field]=value;self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_outer_ok_is_not_final_success(self):
        rows=fixture();find(rows,6)['sw']['f']=3;find(rows,6)['error']='browser-failure';self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_duplicate_json_key_refused(self):
        self.assertFalse(E.decode_bytes(b'{"schemaVersion":2,"schemaVersion":2}\n',INV)[1]['positiveControlVisible'])
    def test_unknown_phase_does_not_invoke_old_collector(self):
        self.assertIn('ServiceWorkerCausal',(HERE/'runtime.mjs').read_text());self.assertNotIn('collector.collectCleanupCapture',(HERE/'runtime.mjs').read_text())
    def test_no_receipt_requires_same_scope_typed_error_and_actual_bound_read(self):
        result=verdict(fixture('no-receipt'));self.assertEqual(result['status'],'closed',result);self.assertFalse(result['successfulControl']);self.assertEqual(result['decisionEvidence']['rejectingCondition'],'original-session-still-bound-at-unbound-read')
        for mutation in ('code','d','unbound','reply','end','permit'):
            rows=fixture('no-receipt')
            if mutation=='code':find(rows,3,'m',3)['sw'].pop('c')
            if mutation=='d':find(rows,4)['sw'].pop('d')
            if mutation=='unbound':find(rows,4)['sw']['v'][0]|=1<<10
            if mutation=='reply':find(rows,3,'m',3)['sw']['ro']=51
            if mutation=='end':rows.remove(find(rows,7))
            if mutation=='permit':find(rows,21)['sw']['t']=654
            self.assertEqual(verdict(rows)['decisionEvidence']['status'],'unknown',mutation)
    def test_receipt_gate_requires_exact_rejection_not_browserfailure_guess(self):
        result=verdict(fixture('retirement-error'));self.assertEqual(result['status'],'closed',result)
        d=result['decisionEvidence'];self.assertEqual(d['observedRejectingPredicateBits'],[41]);self.assertEqual(d['preDropError'],'stale-scope');self.assertEqual(d['finalError'],'scope-unavailable')
        for mutation in ('mask','gate','final','d'):
            rows=fixture('retirement-error')
            if mutation=='mask':find(rows,5)['sw'].update(e=[0,0],v=[0,0])
            if mutation=='gate':rows.remove(find(rows,5))
            if mutation=='final':rows.remove(find(rows,6))
            if mutation=='d':find(rows,4)['sw'].pop('d')
            self.assertEqual(verdict(rows)['decisionEvidence']['status'],'unknown',mutation)
    def test_failed_retired_is_not_ready_or_formal_acceptance(self):
        result=verdict(fixture('retired'));self.assertEqual(result['status'],'closed',result);self.assertEqual(result['decisionEvidence']['kind'],'failed-retired');self.assertFalse(result['successfulControl'])

    def test_ready_gate_origin_must_follow_actual_outer_batch_return(self):
        rows=fixture()
        for kind in (5,6):find(rows,kind)['sw']['a']=1
        self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_reply_and_send_return_must_not_share_an_origin(self):
        rows=fixture();m=find(rows,3,'m',1)['sw'];m['ro']=m['so']
        self.assertFalse(decode(rows)[1]['positiveControlVisible'])
    def test_failed_retired_cannot_hide_an_evaluated_failure_predicate(self):
        rows=fixture('retired')
        for kind in (5,6):find(rows,kind)['sw']['v'][0]|=1<<16
        self.assertEqual(verdict(rows)['status'],'unknown')
    def test_retirement_error_requires_an_actual_nonempty_protocol_error(self):
        for value in (None,False,0,''):
            rows=fixture('retirement-error');find(rows,5)['error']=value
            self.assertEqual(verdict(rows)['status'],'unknown')

    def test_retirement_final_stage_must_match_observed_gate(self):
        for branch in ('retirement-error','retired'):
            rows=fixture(branch);find(rows,6)['sw']['st']=99
            self.assertEqual(verdict(rows)['status'],'unknown')

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
