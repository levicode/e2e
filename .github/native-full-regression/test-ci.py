"""Pure adversarial evidence controls. Never compiles or executes a native harness."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('regression_custody', HERE / 'ci.py')
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)

class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.expected = {'allTests': ['a', 'b', 'baseline_only'], 'ignoredTests': ['baseline_only']}
        self.all = 'a: test\nb: test\nbaseline_only: test\n\n3 tests, 0 benchmarks\n'
        self.ignored = 'baseline_only: test\n\n1 tests, 0 benchmarks\n'
        self.log = '\nrunning 3 tests\ntest a ... ok\ntest baseline_only ... ignored, baseline-only witness\ntest b ... ok\n\ntest result: ok. 2 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s\n'

    def accepted(self, text=None, code=0):
        return ci.results(self.log if text is None else text, code, self.expected)['accepted']

    def test_valid_inventory(self):
        self.assertEqual(ci.inventory(self.all, self.ignored, self.expected)['nonignored'], 2)
    def test_valid_results(self): self.assertTrue(self.accepted())
    def test_collection_missing(self):
        with self.assertRaises(AssertionError): ci.inventory(self.all.replace('a: test\n', ''), self.ignored, self.expected)
    def test_collection_duplicate(self):
        with self.assertRaises(AssertionError): ci.inventory(self.all.replace('a: test\n', 'a: test\na: test\n'), self.ignored, self.expected)
    def test_collection_unexpected(self):
        with self.assertRaises(AssertionError): ci.inventory(self.all.replace('a: test', 'c: test'), self.ignored, self.expected)
    def test_collection_missing_trailer(self):
        with self.assertRaises(AssertionError): ci.listed('a: test\n')
    def test_collection_benchmarks(self):
        with self.assertRaises(AssertionError): ci.listed('a: test\n1 tests, 1 benchmarks\n')
    def test_collection_duplicate_trailer(self):
        with self.assertRaises(AssertionError): ci.listed(self.all+'3 tests, 0 benchmarks\n')
    def test_new_ignore_not_allowed(self):
        with self.assertRaises(AssertionError): ci.inventory(self.all, 'a: test\nbaseline_only: test\n2 tests, 0 benchmarks\n', self.expected)
    def test_original_ignore_not_removed(self):
        with self.assertRaises(AssertionError): ci.inventory(self.all, 'a: test\n1 tests, 0 benchmarks\n', self.expected)
    def test_result_missing(self): self.assertFalse(self.accepted(self.log.replace('test a ... ok\n', '')))
    def test_result_duplicate(self): self.assertFalse(self.accepted(self.log.replace('test a ... ok\n', 'test a ... ok\ntest a ... ok\n')))
    def test_result_unexpected(self): self.assertFalse(self.accepted(self.log.replace('test a ... ok', 'test unknown ... ok')))
    def test_unexpected_skip(self): self.assertFalse(self.accepted(self.log.replace('test a ... ok', 'test a ... ignored')))
    def test_baseline_witness_run_as_pass_rejected(self): self.assertFalse(self.accepted(self.log.replace('ignored, baseline-only witness', 'ok')))
    def test_no_summary(self): self.assertFalse(self.accepted(self.log.split('test result:')[0]))
    def test_duplicate_summary(self): self.assertFalse(self.accepted(self.log+'test result: ok. 2 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 1s\n'))
    def test_false_counts(self): self.assertFalse(self.accepted(self.log.replace('2 passed', '3 passed')))
    def test_filtered(self): self.assertFalse(self.accepted(self.log.replace('0 filtered out', '1 filtered out')))
    def test_measured(self): self.assertFalse(self.accepted(self.log.replace('0 measured', '1 measured')))
    def test_timeout(self): self.assertFalse(self.accepted(code=124))
    def test_killed(self): self.assertFalse(self.accepted(code=137))
    def test_sigterm(self): self.assertFalse(self.accepted(code=-15))
    def test_test_failure(self): self.assertFalse(self.accepted(self.log.replace('test a ... ok', 'test a ... FAILED').replace('result: ok. 2 passed; 0 failed', 'result: FAILED. 1 passed; 1 failed'), 101))
    def test_empty_log_loss_explicit(self):
        report = ci.results('', 0, self.expected)
        self.assertFalse(report['accepted']); self.assertTrue(report['captureLoss'])
    def test_truncated_rows_loss_explicit(self):
        report=ci.results(self.log.replace('test b ... ok\n',''),0,self.expected)
        self.assertTrue(report['captureLoss']); self.assertEqual(report['missingTests'],['b'])
    def test_exact_real_source_collections(self):
        pins=json.loads((HERE/'pins.json').read_text())
        for gate in ['default','fault']:
            expected=json.loads((HERE/('inventory-'+gate+'.json')).read_text())
            names=expected['allTests']; ignored=expected['ignoredTests']
            self.assertEqual(names, sorted(set(names)))
            self.assertEqual(ignored, sorted(set(ignored)))
            self.assertEqual(len(names), pins['expectedInventories'][gate]['total'])
            self.assertEqual(len(ignored), 242)
            added=pins['addedTests']; self.assertEqual(len(added), 37)
            self.assertEqual(set(ignored)&set(added),set(pins['addedIgnoredBaselineOnly']))
            expected_suffixes=['query_read_receipt_is_closed_and_contains_no_scope_or_renderer_payload','timed_field_failure_fits_unchanged_record_bound']
            for suffix in expected_suffixes:
                self.assertIn('native::client_settlement_trace::query_read_schema_tests::'+suffix,names)
                self.assertNotIn('native::client_settlement_trace::tests::'+suffix,names)
            log=''.join('test '+name+' ... '+('ignored' if name in set(ignored) else 'ok')+'\n' for name in names)
            log+=f'test result: ok. {len(names)-len(ignored)} passed; 0 failed; {len(ignored)} ignored; 0 measured; 0 filtered out; finished in 1s\n'
            self.assertTrue(ci.results(log,0,expected)['accepted'])

class FailureCustodyTests(unittest.TestCase):
    def test_valid_json_bad_shapes_still_retain_independent_audit(self):
        for filename, value in [('producer.json', {}), ('test-binary.json', {'sha256': 'a'*64}), ('test-binary.json', {'sha256': 'a'*64, 'relativePath': '\x00'}), ('test-binary.json', {'sha256': 'a'*64, 'relativePath': '../escaped'}), ('toolchain.json', {'binaries': {'rustc': []}}), ('result.json', [])]:
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as td:
                root=Path(td); here=root/'helper'; here.mkdir(); ev=root/'evidence'; ev.mkdir()
                pins={'toolchain':'1.99.1','profile':'ci','commit':'a'*40,'tree':'b'*40,'files':{},'producerFiles':[]}
                (here/'pins.json').write_text(json.dumps(pins)); (ev/filename).write_text(json.dumps(value))
                def fake_git(path,*args): return 'a'*40 if args==('rev-parse','HEAD') else 'b'*40 if args==('rev-parse','HEAD^{tree}') else ''
                env={'GITHUB_WORKSPACE':str(root),'REGRESSION_EVIDENCE':'evidence','REGRESSION_NATIVE':'native','CARGO_TARGET_DIR':str(root/'target')}
                with patch.object(ci,'HERE',here),patch.object(ci,'git',fake_git),patch.dict(os.environ,env),patch.object(sys,'argv',['ci.py','audit','--gate','default']):
                    with self.assertRaises(AssertionError): ci.main()
                report=json.loads((ev/'custody-after.json').read_text())
                self.assertFalse(report['custodyAccepted']);self.assertTrue(report['errors'])
                self.assertIn('full-suite.log',report['captures'])
                self.assertTrue(report['sourceVerified'])

    def test_always_audit_independent_when_every_prior_stage_failed(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td); here=root/'helper'; here.mkdir(); ev=root/'evidence'; ev.mkdir()
            pins={'toolchain':'1.99.1','profile':'ci','commit':'a'*40,'tree':'b'*40,'files':{'cli/source.rs':'c'*64},'producerFiles':['missing-helper.py']}
            (here/'pins.json').write_text(json.dumps(pins))
            (ev/'harness-build.log').write_text('raw compiler failure; do not truncate\n')
            observed=[]
            def fake_git(path,*args):
                observed.append((str(path),args))
                if args==('rev-parse','HEAD'): return 'd'*40
                if args==('rev-parse','HEAD^{tree}'): return 'e'*40
                if args==('status','--porcelain'): return ' M cli/source.rs'
                return ''
            env={'GITHUB_WORKSPACE':str(root),'REGRESSION_EVIDENCE':'evidence','REGRESSION_NATIVE':'native','CARGO_TARGET_DIR':str(root/'target')}
            with patch.object(ci,'HERE',here),patch.object(ci,'git',fake_git),patch.dict(os.environ,env),patch.object(sys,'argv',['ci.py','audit','--gate','default']):
                with self.assertRaises(AssertionError): ci.main()
            report=json.loads((ev/'custody-after.json').read_text())
            self.assertEqual(report['native']['commit'],'d'*40)
            self.assertFalse(report['sourceVerified']);self.assertFalse(report['producerVerified']);self.assertFalse(report['custodyAccepted'])
            self.assertFalse(report['fullSuiteAccepted']);self.assertIsNone(report['binary'])
            self.assertIn('full-suite.log',report['missingCaptures'])
            self.assertIsNone(report['captures']['full-suite.log']['captureLoss'])
            self.assertEqual(report['captures']['harness-build.log']['sha256'],ci.digest(ev/'harness-build.log'))
            checks={error['check'] for error in report['errors']}
            self.assertTrue({'source-cli/source.rs','producer-before','binary-metadata','toolchain-metadata','full-suite-result'}<=checks)
            self.assertGreaterEqual(len(observed),6)

if __name__ == '__main__': unittest.main(verbosity=2)
