#!/usr/bin/env python3
"""Pure parser/identity tests only. Never starts Cargo, Rust, a browser or CI."""
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

class ExactSwReceipts(unittest.TestCase):
    def setUp(self):
        self.pins = copy.deepcopy(recipe.PINS)
        self.pins['pendingSourcePins'] = False
        self.pins['publishedNativeSha'] = 'a' * 40
        self.patch = patch.object(recipe, 'PINS', self.pins)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.red = self.pins['cases'][-1]
        self.control = self.pins['cases'][0]
        self.source = {'publishedHead': self.pins['publishedNativeSha'], 'baseHead': self.pins['baseNativeSha'], 'baseTree': self.pins['baseNativeTree'], 'effectiveTree': self.pins['candidateTree'], 'lockSha256': self.pins['nativeLockSha256'], 'onlyTestOverlay': True}
        self.result = {'exit': 101, 'timed_out': False}
        n = self.red['name']
        self.log = (f'running 1 test\ntest {n} ... FAILED\n\nfailures:\n\n---- {n} stdout ----\n'
                    + self.red['diagnosticPrefix'] + 'joined_error=Runtime.enable: CDP error (Runtime.enable): synthetic observer failure; failure=Some(BrowserFailure); health=Err(BrowserFailure)\n'
                    + f"\nthread '{n}' panicked at src/native/client_enrollment.rs:{self.red['failureLine']}:9:\n"
                    + 'assertion `left == right` failed: ' + self.red['failureMarker'] + '\n  left: Some(BrowserFailure)\n right: None\n'
                    + f'\nfailures:\n    {n}\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 999 filtered out; finished in 0.01s\n')

    def inspect(self, log=None, result=None, source=None, post='h'):
        return recipe.inspect_case(self.red, self.log if log is None else log, '', self.result if result is None else result, 'h', post, self.source if source is None else source)

    def test_exact_architectural_red_is_confirmed_but_not_passed(self):
        out = self.inspect()
        self.assertTrue(out['expectedObservationConfirmed'])
        self.assertEqual(out['classification'], 'expected-red-observed')
        self.assertFalse(out['testPassed'])
        self.assertEqual(out['process']['exit'], 101)

    def test_both_controls_need_one_pass_zero_ignored(self):
        for case in self.pins['cases'][:2]:
            n = case['name']
            log = f'running 1 test\ntest {n} ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 99 filtered out; finished in 0.01s\n'
            good = recipe.inspect_case(case, log, '', {'exit':0}, 'h', 'h', self.source)
            self.assertTrue(good['expectedObservationConfirmed'])
            bad = recipe.inspect_case(case, log.replace('0 ignored', '1 ignored'), '', {'exit':0}, 'h', 'h', self.source)
            self.assertFalse(bad['expectedObservationConfirmed'])

    def test_wrong_panic_rejected(self):
        self.assertFalse(self.inspect(self.log.replace(self.red['failureMarker'], 'unrelated panic'))['expectedObservationConfirmed'])

    def test_wrong_file_rejected(self):
        self.assertFalse(self.inspect(self.log.replace('src/native/client_enrollment.rs:', 'src/native/cdp/client.rs:'))['expectedObservationConfirmed'])

    def test_early_characterization_assertion_rejected(self):
        early = self.log.replace(':'+str(self.red['failureLine'])+':', ':'+str(self.red['characterizationLine'])+':')
        self.assertFalse(self.inspect(early)['expectedObservationConfirmed'])

    def test_missing_browserfailure_characterization_rejected(self):
        self.assertFalse(self.inspect(self.log.replace('failure=Some(BrowserFailure);', 'failure=None;'))['expectedObservationConfirmed'])

    def test_wrong_failure_value_rejected(self):
        self.assertFalse(self.inspect(self.log.replace('left: Some(BrowserFailure)', 'left: Some(Timeout)'))['expectedObservationConfirmed'])

    def test_timeout_rejected_even_with_full_log(self):
        self.assertFalse(self.inspect(result={'exit':101,'timed_out':True})['expectedObservationConfirmed'])

    def test_zero_match_rejected(self):
        log = 'running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 999 filtered out; finished in 0.00s\n'
        self.assertFalse(self.inspect(log, {'exit':0})['expectedObservationConfirmed'])

    def test_wrong_source_tree_rejected(self):
        source = dict(self.source, effectiveTree='0'*40)
        out = self.inspect(source=source)
        self.assertFalse(out['expectedObservationConfirmed'])
        self.assertFalse(out['sourceIdentityConfirmed'])

    def test_wrong_source_sha_rejected(self):
        self.assertFalse(self.inspect(source=dict(self.source,publishedHead='0'*40))['expectedObservationConfirmed'])

    def test_harness_mutation_rejected(self):
        self.assertFalse(self.inspect(post='changed')['expectedObservationConfirmed'])

    def test_second_panic_rejected(self):
        self.assertFalse(self.inspect(self.log+"thread 'other' panicked at other.rs:1:1:\nother panic\n")['expectedObservationConfirmed'])

    def test_duplicate_test_rejected(self):
        self.assertFalse(self.inspect(self.log+f"test {self.red['name']} ... FAILED\n")['expectedObservationConfirmed'])

    def test_pending_pin_refuses(self):
        self.pins['pendingSourcePins'] = True
        with self.assertRaisesRegex(AssertionError, 'pending'):
            recipe.require_frozen_pins()

    def test_placeholder_sha_refuses_even_if_pending_flag_false(self):
        self.pins['publishedNativeSha'] = 'PENDING_NATIVE_SHA_DO_NOT_EXECUTE'
        with self.assertRaisesRegex(AssertionError, 'Unfrozen'):
            recipe.require_frozen_pins()

    def test_formal_base_substitution_refuses(self):
        self.pins['baseNativeTree'] = '37e8593d44f514afcfa633c94a374b3213ab7dda'
        with self.assertRaises(AssertionError):
            recipe.require_frozen_pins()

    def test_source_identity_mismatched_head_refuses_before_files(self):
        with patch.object(recipe,'git',return_value='b'*40):
            with self.assertRaises(AssertionError):
                recipe.source_identity('/tmp/pure-fixture-no-checkout',True)

    def test_source_assertion_line_and_prior_characterization_bound(self):
        red = self.red
        lines = [''] * red['failureLine']
        start = red['characterizationLine'] - 10
        lines[start-2] = '#[tokio::test]'
        lines[start-1] = 'async fn '+red['name'].split('::')[-1]+'() {'
        lines[red['characterizationLine']-1] = red['characterizationAssertion']
        lines[red['failureLine']-1] = red['failureAssertion']
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/red['failureSource']; p.parent.mkdir(parents=True)
            p.write_text('\n'.join(lines)+'\n')
            recipe.verify_architecture_source(tmp)
            lines[red['characterizationLine']-1] = 'assert_eq!(failure, None);'
            p.write_text('\n'.join(lines)+'\n')
            with self.assertRaises(AssertionError):
                recipe.verify_architecture_source(tmp)

if __name__ == '__main__':
    unittest.main(verbosity=2)
