import copy,importlib.util,json,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('v',Path(__file__).with_name('validate.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class ParserControls(unittest.TestCase):
 def raw(self,c,red=False):
  outcome='FAILED' if red else 'ok'; counts='0 passed; 1 failed' if red else '1 passed; 0 failed'
  s=f"running 1 test\ntest {c['name']} ... {outcome}\n"
  if red:
   pin=v.PINS['redSources'][c['id']]
   s+=f"\nfailures:\n\n---- {c['name']} stdout ----\n\nthread '{c['name']}' panicked at {pin['path']}:{pin['line']}:{pin['column']}:\n{pin['panicBody']}\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n\nfailures:\n    {c['name']}\n\n"
  return s+f'test result: {outcome}. {counts}; 0 ignored; 0 measured; 42 filtered out; finished in 1.60s\n'
 def inspect(self,c,s,exit):return v.inspect_case(c,s,'',{'exit':exit,'timed_out':False},'h','h')['expectedObservationConfirmed']
 def test_two_pass_two_red(self):
  v.validate_cases()
  for c in v.PINS['cases']:self.assertTrue(self.inspect(c,self.raw(c,c['expected']=='target-red'),101 if c['expected']=='target-red' else 0))
 def test_rust_backtrace_enabled(self):
  c=v.PINS['cases'][2];s=self.raw(c,True).replace('note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace','stack backtrace:\n   0: __rustc::rust_begin_unwind\n   1: core::panicking::panic_fmt');self.assertTrue(self.inspect(c,s,101))
 def test_changed_harness(self):
  c=v.PINS['cases'][0];self.assertFalse(v.inspect_case(c,self.raw(c),'',{'exit':0},'old','new')['expectedObservationConfirmed'])
 def test_wrong_exit(self):
  c=v.PINS['cases'][2];self.assertFalse(self.inspect(c,self.raw(c,True),1))
 def test_prior_control_failure(self):
  old=v.validate_pins;v.validate_pins=lambda:None;olde=v.EVIDENCE;oldv=v.verify_saved_case
  try:
   with tempfile.TemporaryDirectory() as d:
    v.EVIDENCE=Path(d)
    for name in v.COMPILE_PHASES:(v.EVIDENCE/(name+'.exit')).write_text('0')
    v.verify_saved_case=lambda c:dict(actual='failed',expectedObservationConfirmed=False)
    with self.assertRaisesRegex(AssertionError,'positive control'):v.run_case('native-deadline')
  finally:v.validate_pins=old;v.EVIDENCE=olde;v.verify_saved_case=oldv
 def test_wrong_panic(self):
  c=v.PINS['cases'][2];self.assertFalse(self.inspect(c,self.raw(c,True).replace('P04_OBSERVE_TRACE_SOURCE_OWNERSHIP_AND_CLEAN_CLOSE_CONTRACT','wrong'),101))
 def test_wrong_source(self):
  c=v.PINS['cases'][3];pin=v.PINS['redSources'][c['id']];self.assertFalse(self.inspect(c,self.raw(c,True).replace(f":{pin['line']}:{pin['column']}:",f":{pin['line']-1}:{pin['column']}:"),101))
 def test_missing_case(self):
  old=v.PINS; v.PINS=copy.deepcopy(old);v.PINS['cases'].pop()
  try:
   with self.assertRaises(AssertionError):v.validate_cases()
  finally:v.PINS=old
 def test_zero_tests(self):
  c=v.PINS['cases'][0];self.assertFalse(self.inspect(c,self.raw(c).replace('running 1 test','running 0 tests'),0))
 def test_multiple_summaries(self):
  c=v.PINS['cases'][0];self.assertFalse(self.inspect(c,self.raw(c)*2,0))
 def test_control_red(self):
  c=v.PINS['cases'][0];s=self.raw(c).replace('... ok','... FAILED').replace('result: ok. 1 passed; 0 failed','result: FAILED. 0 passed; 1 failed');self.assertFalse(self.inspect(c,s,101))
 def test_compile_failed(self):
  old=v.validate_pins;v.validate_pins=lambda:None;olde=v.EVIDENCE
  try:
   with tempfile.TemporaryDirectory() as d:
    v.EVIDENCE=Path(d)
    for name in v.COMPILE_PHASES:(v.EVIDENCE/(name+'.exit')).write_text('101' if name=='clippy' else '0')
    with self.assertRaisesRegex(AssertionError,'strict gates'):v.run_case('immediate')
  finally:v.validate_pins=old;v.EVIDENCE=olde
 def test_timeout_and_generic_101(self):
  c=v.PINS['cases'][2];self.assertFalse(self.inspect(c,'',101));self.assertFalse(v.inspect_case(c,self.raw(c,True),'',{'exit':101,'timed_out':True},'h','h')['expectedObservationConfirmed'])
 def test_multiple_panics(self):
  c=v.PINS['cases'][2];s=self.raw(c,True)+"thread 'peer' panicked at src/other.rs:1:1:\npeer died\n\n";self.assertFalse(self.inspect(c,s,101))
 def test_unexpected_green(self):
  c=v.PINS['cases'][3];self.assertFalse(self.inspect(c,self.raw(c),0))
if __name__=='__main__':unittest.main(verbosity=2)
