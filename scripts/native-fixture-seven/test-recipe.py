#!/usr/bin/env python3
"""Pure receipt/source-binding tests. Never starts Cargo, Rust, browser or CI."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('fixture_recipe', HERE / 'fixture-recipe.py')
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)

class ExactRepairReceipts(unittest.TestCase):
    def setUp(self):
        self.pins = copy.deepcopy(recipe.PINS)
        self.pins['pendingSourcePins'] = False
        self.pins['publishedNativeSha'] = 'a' * 40
        self.patch = patch.object(recipe, 'PINS', self.pins)
        self.patch.start(); self.addCleanup(self.patch.stop)
        self.case = self.pins['cases'][0]
        self.source = {'publishedHead': self.pins['publishedNativeSha'], 'baseHead': self.pins['baseNativeSha'], 'baseTree': self.pins['baseNativeTree'], 'effectiveTree': self.pins['candidateTree'], 'lockSha256': self.pins['nativeLockSha256'], 'productionSourceChanged': True}
        self.log = self.passing_log(self.case)

    @staticmethod
    def passing_log(case):
        return f"running 1 test\ntest {case['name']} ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 999 filtered out; finished in 0.01s\n"

    def inspect(self, log=None, result=None, source=None, post='h', case=None):
        return recipe.inspect_case(self.case if case is None else case, self.log if log is None else log, '', {'exit':0,'timed_out':False} if result is None else result, 'h', post, self.source if source is None else source)

    def test_all_twelve_require_one_real_pass_zero_ignored(self):
        for case in self.pins['cases']:
            out = self.inspect(self.passing_log(case),case=case)
            self.assertTrue(out['expectedObservationConfirmed'])
            self.assertTrue(out['testPassed'])
            self.assertTrue(out['productionSourceChanged'])
            self.assertEqual(out['classification'],'expected-pass-observed')

    def test_historical_exact_red101_is_now_failure_not_success(self):
        n = self.case['name']
        log = f"running 1 test\ntest {n} ... FAILED\n\n---- {n} stdout ----\nthread '{n}' panicked at src/native/client_enrollment.rs:13075:9:\nassertion `left == right` failed: desired architectural RED: exact detach applied after the fixed no-receipt decision, but the whole owner was poisoned\n  left: Some(BrowserFailure)\n right: None\n\nfailures:\n    {n}\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 999 filtered out; finished in 0.01s\n"
        out = self.inspect(log,{'exit':101})
        self.assertEqual(out['actual'],'failed')
        self.assertEqual(out['classification'],'unexpected-failure')
        self.assertFalse(out['expectedObservationConfirmed'])
        self.assertFalse(out['testPassed'])
        self.assertEqual(out['process']['exit'],101)

    def test_any_other_panic_nonzero_rejected(self):
        self.assertFalse(self.inspect(self.log+"thread 'other' panicked at other.rs:1:1:\nwrong panic\n",{'exit':101})['expectedObservationConfirmed'])

    def test_early_assertion_nonzero_rejected(self):
        self.assertFalse(self.inspect("thread 'test' panicked at src/native/client_enrollment.rs:1:1:\nearly\n",{'exit':101})['expectedObservationConfirmed'])

    def test_exit101_cannot_be_hidden_by_passing_text(self):
        self.assertFalse(self.inspect(result={'exit':101})['expectedObservationConfirmed'])

    def test_timeout_with_passing_text_rejected(self):
        self.assertFalse(self.inspect(result={'exit':0,'timed_out':True})['expectedObservationConfirmed'])

    def test_interruption_rejected(self):
        self.assertFalse(self.inspect(result={'exit':0,'interrupted':True})['expectedObservationConfirmed'])

    def test_zero_match_rejected(self):
        self.assertFalse(self.inspect('running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 999 filtered out; finished in 0.00s\n')['expectedObservationConfirmed'])

    def test_ignored_rejected(self):
        self.assertFalse(self.inspect(self.log.replace('0 ignored','1 ignored'))['expectedObservationConfirmed'])

    def test_wrong_exact_name_rejected(self):
        self.assertFalse(self.inspect(self.log.replace(self.case['name'],'another::test'))['expectedObservationConfirmed'])

    def test_duplicate_test_rejected(self):
        self.assertFalse(self.inspect(self.log+f"test {self.case['name']} ... ok\n")['expectedObservationConfirmed'])

    def test_wrong_source_tree_rejected(self):
        self.assertFalse(self.inspect(source=dict(self.source,effectiveTree='0'*40))['expectedObservationConfirmed'])

    def test_wrong_source_sha_rejected(self):
        self.assertFalse(self.inspect(source=dict(self.source,publishedHead='0'*40))['expectedObservationConfirmed'])

    def test_false_test_only_binding_rejected(self):
        old=dict(self.source);old.pop('productionSourceChanged');old['onlyTestOverlay']=True
        self.assertFalse(self.inspect(source=old)['expectedObservationConfirmed'])

    def test_harness_mutation_rejected(self):
        self.assertFalse(self.inspect(post='changed')['expectedObservationConfirmed'])

    def test_pending_source_refuses_execution(self):
        self.pins['pendingSourcePins']=True
        with self.assertRaisesRegex(AssertionError,'pending'):recipe.require_frozen_pins()

    def test_placeholder_source_refuses_even_if_pending_flag_false(self):
        self.pins['publishedNativeSha']='PENDING_NATIVE_SHA_DO_NOT_EXECUTE'
        with self.assertRaisesRegex(AssertionError,'Unfrozen'):recipe.require_frozen_pins()

    def test_any_expected_failed_pin_refuses(self):
        self.pins['cases'][0]['expected']='failed'
        with self.assertRaises(AssertionError):recipe.require_frozen_pins()

    def test_incorrect_production_claim_refuses(self):
        self.pins['productionSourceChanged']=False
        with self.assertRaises(AssertionError):recipe.require_frozen_pins()

    def test_wrong_base_refuses(self):
        self.pins['baseNativeTree']='c0f32f260978e3631c4fce79513780820dc7218d'
        with self.assertRaises(AssertionError):recipe.require_frozen_pins()

    def test_exact_source_identity_mismatched_head_refuses(self):
        with patch.object(recipe,'git',return_value='b'*40):
            with self.assertRaises(AssertionError):recipe.source_identity('/tmp/no-checkout',True)

    def test_selected_source_definitions_unique_nonignored(self):
        files={}
        for case in self.pins['cases']:
            lines=files.setdefault(case['sourcePath'],['#[cfg(test)]','mod tests {'])
            lines.append('#[tokio::test]')
            case['definitionLine']=len(lines)+1
            lines.append('async fn '+case['name'].split('::')[-1]+'() {')
            lines.append('}')
        with tempfile.TemporaryDirectory() as t:
            for path,lines in files.items():
                p=Path(t)/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('\n'.join(lines)+'\n')
            recipe.verify_selected_test_sources(t)
            p=Path(t)/self.case['sourcePath']
            p.write_text(p.read_text().replace('#[tokio::test]','#[ignore]\n#[tokio::test]',1))
            with self.assertRaises(AssertionError):recipe.verify_selected_test_sources(t)

    def test_summary_requires_all_twelve_passes(self):
        good=[{'id':c['id'],'test':c['name'],'expected':'passed','actual':'passed','testPassed':True,'expectedObservationConfirmed':True} for c in self.pins['cases']]
        with tempfile.TemporaryDirectory() as t, patch.object(recipe,'EVIDENCE',Path(t)), patch('builtins.print'):
            for phase in recipe.COMPILE_PHASES+['source-after']:(Path(t)/(phase+'.exit')).write_text('0\n')
            with patch.object(recipe,'verify_saved_case',side_effect=copy.deepcopy(good)):
                self.assertEqual(recipe.summarize(),0)
            bad=copy.deepcopy(good);bad[0].update(actual='failed',testPassed=False,expectedObservationConfirmed=False)
            with patch.object(recipe,'verify_saved_case',side_effect=bad):
                self.assertEqual(recipe.summarize(),1)
            (Path(t)/'clippy.exit').write_text('101\n')
            with patch.object(recipe,'verify_saved_case',side_effect=copy.deepcopy(good)):
                self.assertEqual(recipe.summarize(),1)

if __name__ == '__main__':unittest.main(verbosity=2)
