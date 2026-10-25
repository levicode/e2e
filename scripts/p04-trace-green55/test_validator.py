import copy,importlib.util,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('v',Path(__file__).with_name('validate.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class Controls(unittest.TestCase):
 def raw(self,c):return f"running 1 test\ntest {c['name']} ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 42 filtered out; finished in 1.60s\n"
 def ok(self,c,s,code=0,**kw):return v.inspect_case(c,s,'',dict(exit=code,**kw),'h','h')['expectedObservationConfirmed']
 def test_all_exact_pass(self):
  v.validate_cases()
  for c in v.PINS['cases']:self.assertTrue(self.ok(c,self.raw(c)))
 def test_target_red_is_failure(self):
  for c in v.PINS['cases']:
   s=self.raw(c).replace('... ok','... FAILED').replace('result: ok. 1 passed; 0 failed','result: FAILED. 0 passed; 1 failed');self.assertFalse(self.ok(c,s,101))
 def test_background_panic_rejected(self):
  c=v.PINS['cases'][0];self.assertFalse(self.ok(c,self.raw(c)+"thread 'peer' panicked at src/peer.rs:1:1:\n"))
 def test_zero_tests(self):
  c=v.PINS['cases'][0];self.assertFalse(self.ok(c,self.raw(c).replace('running 1 test','running 0 tests')))
 def test_multiple_summaries(self):
  c=v.PINS['cases'][0];self.assertFalse(self.ok(c,self.raw(c)*2))
 def test_wrong_case(self):
  c=v.PINS['cases'][0];self.assertFalse(self.ok(c,self.raw(v.PINS['cases'][1])))
 def test_wrong_exit(self):
  c=v.PINS['cases'][0];self.assertFalse(self.ok(c,self.raw(c),101))
 def test_timeout_interrupted(self):
  c=v.PINS['cases'][0]
  for k in ['timed_out','interrupted']:self.assertFalse(self.ok(c,self.raw(c),**{k:True}))
 def test_generic_failure(self):self.assertFalse(self.ok(v.PINS['cases'][0],'compile failed',101))
 def test_harness_changed(self):
  c=v.PINS['cases'][0];self.assertFalse(v.inspect_case(c,self.raw(c),'',{'exit':0},'a','b')['expectedObservationConfirmed'])
 def test_missing_case(self):
  old=v.PINS;v.PINS=copy.deepcopy(old);v.PINS['cases'].pop()
  try:
   with self.assertRaises(AssertionError):v.validate_cases()
  finally:v.PINS=old
 def test_compile_failed(self):
  old,olde=v.validate_pins,v.EVIDENCE;v.validate_pins=lambda:None
  try:
   with tempfile.TemporaryDirectory() as d:
    v.EVIDENCE=Path(d)
    for n in v.COMPILE_PHASES:(v.EVIDENCE/(n+'.exit')).write_text('101' if n=='clippy' else '0')
    with self.assertRaisesRegex(AssertionError,'strict gates'):v.run_case(v.PINS['cases'][0]['id'])
  finally:v.validate_pins,v.EVIDENCE=old,olde
 def test_prior_control_failed(self):
  old,olde,oldv=v.validate_pins,v.EVIDENCE,v.verify_saved_case;v.validate_pins=lambda:None
  try:
   with tempfile.TemporaryDirectory() as d:
    v.EVIDENCE=Path(d)
    for n in v.COMPILE_PHASES:(v.EVIDENCE/(n+'.exit')).write_text('0')
    v.verify_saved_case=lambda c:dict(actual='failed',expectedObservationConfirmed=False)
    with self.assertRaisesRegex(AssertionError,'positive control'):v.run_case(v.PINS['cases'][1]['id'])
  finally:v.validate_pins,v.EVIDENCE,v.verify_saved_case=old,olde,oldv
if __name__=='__main__':unittest.main(verbosity=2)
