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


class S6EvidenceTests(unittest.TestCase):
    """All byte fixtures are synthetic text. No harness or JavaScript is executed."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.here = self.root / 'helper'; self.here.mkdir()
        self.ev = self.root / 'evidence'; self.ev.mkdir()
        self.target = self.root / 'target'; self.target.mkdir()
        self.native = self.root / 'native'; (self.native / 'cli').mkdir(parents=True)
        self.binary = self.target / 'agent-browser-tests'; self.binary.write_text('synthetic non-executable harness bytes\n')
        self.new = ['native::new_control_' + str(i).zfill(2) for i in range(20)]
        self.retained = ['native::retained_control_' + str(i).zfill(2) for i in range(43)]
        self.s9 = ['native::s9_control_' + str(i).zfill(2) for i in range(21)]
        self.names = ['attribute-only assertion samples pure control ' + str(i).zfill(2) for i in range(23)]
        self.test_file = 'packages/e2e/tests/unit/attribute-field-assertions.test.ts'
        self.pins = {'toolchain': '1.99.1', 'profile': 'ci', 'commit': 'a' * 40, 'tree': 'b' * 40,
                     'requiredNewTests': self.new, 'retainedRequiredTests': self.retained, 's9RequiredTests': self.s9,
                     'pureProjection': {'file': self.test_file, 'testNames': self.names, 'nodeMajor': 24,
                                        'pnpmVersion': '12.3.4', 'vitestVersion': '5.0.5'},
                     'files': {}, 'producerFiles': [self.test_file]}
        self.collection = {'allTests': sorted(self.new + self.retained + self.s9 + ['native::baseline_only']),
                           'ignoredTests': ['native::baseline_only']}
        self.collection.update(total=85, ignored=1, nonignored=84)
        for gate in ['default', 'fault']:
            expected = dict(self.collection, nativeCommit=self.pins['commit'], nativeTree=self.pins['tree'],
                            profile='ci', features=['acceptance-faults'] if gate == 'fault' else [])
            self.write_json(self.here / ('inventory-' + gate + '.json'), expected)
        self.all_text = ''.join(name + ': test\n' for name in self.collection['allTests']) + '\n85 tests, 0 benchmarks\n'
        self.ignored_text = 'native::baseline_only: test\n\n1 tests, 0 benchmarks\n'
        (self.ev / 'all-tests.list').write_text(self.all_text)
        (self.ev / 'ignored-tests.list').write_text(self.ignored_text)
        for name in ['all-tests.exit', 'ignored-tests.exit', 'harness-build.exit', 'new-native-exact.exit']:
            (self.ev / name).write_text('0\n')
        self.write_json(self.ev / 'inventory.json', dict(self.collection, profile='ci', features=['acceptance-faults'],
                        allListSHA256=ci.digest(self.ev / 'all-tests.list'), ignoredListSHA256=ci.digest(self.ev / 'ignored-tests.list')))
        self.here_patch = patch.object(ci, 'HERE', self.here)
        self.here_patch.start(); self.addCleanup(self.here_patch.stop)
        self.write_json(self.ev / 'required-controls.json', ci.required_controls_report(self.ev, self.pins, 'fault'))
        self.write_json(self.ev / 'new-native-exact-inventory.json', {'selectors': self.new, 'count': 20})
        self.write_json(self.ev / 's9-required-controls.json', ci.s9_required_controls_report(self.ev, self.pins, 'fault'))
        self.write_json(self.ev / 's9-native-exact-inventory.json', {'selectors': self.s9, 'count': 21})
        self.profile = {'test': True, 'opt_level': '3', 'debug_assertions': False, 'overflow_checks': False}
        artifact = {'reason': 'compiler-artifact', 'target': {'name': 'agent-browser', 'kind': ['bin']},
                    'profile': self.profile, 'features': ['acceptance-faults'], 'fresh': False, 'executable': str(self.binary)}
        (self.ev / 'harness.jsonl').write_text(json.dumps(artifact) + '\n' + json.dumps({'reason': 'build-finished', 'success': True}) + '\n')
        (self.ev / 'compiler-argv.txt').write_text('synthetic argv capture; never executed\n')
        self.write_json(self.ev / 'test-binary.json', {'sha256': ci.digest(self.binary), 'relativePath': self.binary.name,
                        'fresh': False, 'features': ['acceptance-faults'], 'profile': self.profile,
                        'cargoArtifactsSHA256': ci.digest(self.ev / 'harness.jsonl'), 'compilerArgvSHA256': ci.digest(self.ev / 'compiler-argv.txt')})
        (self.ev / 'harness.path').write_text(str(self.binary) + '\n')
        self.exact_dir = self.ev / 'new-native-exact'; self.exact_dir.mkdir()
        (self.exact_dir / 'harness-list.log').write_text(self.all_text)
        self.rows = []
        for i, name in enumerate(self.new, 1):
            log = f'\nrunning 1 test\ntest {name} ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 84 filtered out; finished in 0.01s\n'
            path = self.exact_dir / f'test-{i:02d}.log'; path.write_text(log)
            (self.exact_dir / f'test-{i:02d}.cleanup.jsonl').write_text('')
            self.rows.append({'name': name, 'command': [str(self.binary), '--exact', name, '--nocapture', '--test-threads=1'],
                              'exit': 0, 'timedOut': False, 'counts': [['1', '0', '0']], 'passed': True, 'logSha256': ci.digest(path)})
        self.exact = {'harnessSha256': ci.digest(self.binary), 'features': ['acceptance-faults'],
                      'notFullAcceptance': True, 'expected': 20, 'results': self.rows}
        self.save_exact()
        source = self.root / self.test_file; source.parent.mkdir(parents=True); source.write_text('// synthetic pure source\n')
        self.pins['pureProjection']['sourceSHA256'] = ci.digest(source)
        self.producer = {'gate': 'fault', 'profile': 'ci', 'features': ['acceptance-faults'],
                         'commit': 'c' * 40, 'tree': 'd' * 40, 'nativeCommit': self.pins['commit'], 'nativeTree': self.pins['tree'],
                         'files': {self.test_file: ci.digest(source)}}
        self.write_json(self.ev / 'producer.json', self.producer)
        self.pure_dir = self.ev / 'attribute-projection'; self.pure_dir.mkdir()
        self.pure = {'success': True, 'numTotalTests': 23, 'numPassedTests': 23, 'numFailedTests': 0,
                     'numPendingTests': 0, 'numTodoTests': 0, 'numTotalTestSuites': 2, 'numPassedTestSuites': 2,
                     'numFailedTestSuites': 0, 'numPendingTestSuites': 0,
                     'testResults': [{'name': str(source), 'status': 'passed', 'message': '',
                                      'assertionResults': [{'fullName': name, 'status': 'passed', 'failureMessages': []} for name in self.names]}]}
        self.write_json(self.pure_dir / 'raw-result.json', self.pure)
        self.write_json(self.pure_dir / 'command.json', ['pnpm', '--filter', 'e2e', 'exec', 'vitest', 'run',
                        'tests/unit/attribute-field-assertions.test.ts', '--project', 'unit', '--reporter=json',
                        '--outputFile=' + str(self.pure_dir / 'raw-result.json')])
        self.write_json(self.pure_dir / 'install-command.json', ['pnpm', 'install', '--frozen-lockfile'])
        self.versions = {'node': 'v24.19.0', 'pnpm': '12.3.4', 'vitest': 'vitest/5.0.5 linux-x64 node-v24.19.0'}
        self.save_versions()
        for name in ['run.exit', 'install.exit']: (self.pure_dir / name).write_text('0\n')
        for name in ['raw.log', 'install.log']: (self.pure_dir / name).write_text('synthetic command output\n')

    @staticmethod
    def write_json(path, value): path.write_text(json.dumps(value) + '\n')
    def save_exact(self):
        self.write_json(self.exact_dir / 'results.json', self.exact)
        (self.ev / 'new-native-exact.log').write_text(''.join(json.dumps(row) + '\n' for row in self.exact['results']))
    def save_versions(self):
        self.write_json(self.pure_dir / 'versions.json', self.versions)
        for key, value in self.versions.items(): (self.pure_dir / (key + '-version.txt')).write_text(value + '\n')
    def exact_report(self): return ci.exact_results_report(self.ev, self.pins, self.target)
    def pure_report(self): return ci.pure_results_report(self.root, self.ev, self.pins)
    def reject_exact(self):
        with self.assertRaises((AssertionError, KeyError, TypeError, FileNotFoundError)): self.exact_report()
    def reject_pure(self):
        with self.assertRaises((AssertionError, KeyError, TypeError, FileNotFoundError)): self.pure_report()
    def edit_exact_log(self, old, new):
        path = self.exact_dir / 'test-01.log'; path.write_text(path.read_text().replace(old, new))
        self.rows[0]['logSha256'] = ci.digest(path); self.save_exact()

    def test_bound_identity_accepts_complete_shape(self): ci.bound_identity(self.pins)
    def test_unbound_identity_never_type_errors_or_succeeds(self):
        for key in ['commit', 'tree']:
            for value in [None, '', 'UNBOUND_NATIVE_COMMIT', '0' * 40, 'f' * 39, 123, True]:
                with self.subTest(key=key, value=value):
                    pins = dict(self.pins); pins[key] = value
                    with self.assertRaises(AssertionError): ci.bound_identity(pins)
    def test_required_controls_valid_and_reruns_not_new_coverage(self):
        report = ci.required_controls(self.pins, self.collection)
        self.assertEqual(report['newCount'], 20); self.assertEqual(report['retainedCount'], 43)
        self.assertIn('not additional coverage', report['coverage'])
    def test_required_controls_reject_empty_duplicate_or_nonexact(self):
        for key in ['requiredNewTests', 'retainedRequiredTests']:
            for value in [[], ['native::same'] * len(self.pins[key]), ['substring'] + self.pins[key][1:]]:
                with self.subTest(key=key, value=value):
                    pins = dict(self.pins); pins[key] = value
                    with self.assertRaises(AssertionError): ci.required_controls(pins, self.collection)
    def test_required_controls_missing_from_full_collection(self):
        self.collection['allTests'].remove(self.new[0])
        with self.assertRaises(AssertionError): ci.required_controls(self.pins, self.collection)
    def test_required_controls_ignored_rejected(self):
        self.collection['ignoredTests'] = sorted(self.collection['ignoredTests'] + [self.retained[0]])
        with self.assertRaises(AssertionError): ci.required_controls(self.pins, self.collection)
    def test_required_control_groups_overlap_rejected(self):
        self.pins['retainedRequiredTests'][0] = self.new[0]
        with self.assertRaises(AssertionError): ci.required_controls(self.pins, self.collection)
    def test_exact_all_twenty_valid_same_harness(self):
        report = self.exact_report(); self.assertTrue(report['accepted']); self.assertEqual(report['count'], 20)
        self.assertEqual(report['binarySHA256'], ci.digest(self.binary))
    def test_exact_empty_results_no_vacuous_success(self): self.exact['results'] = []; self.save_exact(); self.reject_exact()
    def test_exact_duplicate_and_reordered_rows(self):
        self.exact['results'][0], self.exact['results'][1] = self.exact['results'][1], self.exact['results'][0]
        self.save_exact(); self.reject_exact()
    def test_exact_wrong_expected_count(self): self.exact['expected'] = 0; self.save_exact(); self.reject_exact()
    def test_exact_wrong_feature(self): self.exact['features'] = []; self.save_exact(); self.reject_exact()
    def test_exact_foreign_harness_sha(self): self.exact['harnessSha256'] = 'e' * 64; self.save_exact(); self.reject_exact()
    def test_exact_foreign_harness_argv(self): self.rows[0]['command'][0] += '-foreign'; self.save_exact(); self.reject_exact()
    def test_exact_nonexact_argv(self): self.rows[0]['command'].remove('--exact'); self.save_exact(); self.reject_exact()
    def test_exact_raw_log_hash_mismatch(self): self.rows[0]['logSha256'] = 'e' * 64; self.save_exact(); self.reject_exact()
    def test_exact_nonzero_exit_even_pass_true(self): self.rows[0]['exit'] = 101; self.save_exact(); self.reject_exact()
    def test_exact_timeout_even_pass_true(self): self.rows[0]['timedOut'] = True; self.save_exact(); self.reject_exact()
    def test_exact_ignored_raw_row(self): self.edit_exact_log(' ... ok', ' ... ignored'); self.reject_exact()
    def test_exact_missing_named_row(self): self.edit_exact_log(f'test {self.new[0]} ... ok\n', ''); self.reject_exact()
    def test_exact_duplicate_named_row(self):
        row = f'test {self.new[0]} ... ok\n'; self.edit_exact_log(row, row + row); self.reject_exact()
    def test_exact_zero_pass_summary(self): self.edit_exact_log('1 passed;', '0 passed;'); self.reject_exact()
    def test_exact_wrong_filtered_count(self): self.edit_exact_log('84 filtered out', '0 filtered out'); self.reject_exact()
    def test_exact_measured_summary(self): self.edit_exact_log('0 measured;', '1 measured;'); self.reject_exact()
    def test_exact_missing_cleanup_capture(self): (self.exact_dir / 'test-01.cleanup.jsonl').unlink(); self.reject_exact()
    def test_exact_command_log_tamper(self): (self.ev / 'new-native-exact.log').write_text(''); self.reject_exact()
    def test_exact_collection_mismatch(self): (self.exact_dir / 'harness-list.log').write_text('native::foreign: test\n1 tests, 0 benchmarks\n'); self.reject_exact()
    def test_exact_compiler_harness_path_mismatch(self): (self.ev / 'harness.path').write_text(str(self.binary) + '-foreign'); self.reject_exact()
    def test_exact_compiler_harness_bytes_changed(self): self.binary.write_text('different bytes'); self.reject_exact()
    def test_exact_compiler_artifact_changed(self): (self.ev / 'harness.jsonl').write_text('{}\n'); self.reject_exact()
    def test_pure_twenty_three_valid_and_two_suites_accepted(self):
        report = self.pure_report(); self.assertTrue(report['accepted']); self.assertEqual(report['count'], 23)
    def test_pure_duplicate_name(self):
        self.pure['testResults'][0]['assertionResults'][0]['fullName'] = self.names[1]
        self.write_json(self.pure_dir / 'raw-result.json', self.pure); self.reject_pure()
    def test_pure_wrong_file(self):
        self.pure['testResults'][0]['name'] = str(self.root / 'other.test.ts')
        self.write_json(self.pure_dir / 'raw-result.json', self.pure); self.reject_pure()
    def test_pure_wrong_count(self):
        self.pure['numTotalTests'] = 22; self.write_json(self.pure_dir / 'raw-result.json', self.pure); self.reject_pure()
    def test_pure_pending_assertion_even_counts_pass(self):
        self.pure['testResults'][0]['assertionResults'][0]['status'] = 'pending'
        self.write_json(self.pure_dir / 'raw-result.json', self.pure); self.reject_pure()
    def test_pure_todo_count(self):
        self.pure['numTodoTests'] = 1; self.write_json(self.pure_dir / 'raw-result.json', self.pure); self.reject_pure()
    def test_pure_runtime_error(self):
        self.pure['unhandledErrors'] = ['error']; self.write_json(self.pure_dir / 'raw-result.json', self.pure); self.reject_pure()
    def test_pure_false_success(self):
        self.pure['success'] = False; self.write_json(self.pure_dir / 'raw-result.json', self.pure); self.reject_pure()
    def test_pure_extra_file(self):
        self.pure['testResults'].append(copy.deepcopy(self.pure['testResults'][0]))
        self.write_json(self.pure_dir / 'raw-result.json', self.pure); self.reject_pure()
    def test_pure_integration_command_rejected(self):
        value = json.loads((self.pure_dir / 'command.json').read_text()); value[value.index('unit')] = 'integration'
        self.write_json(self.pure_dir / 'command.json', value); self.reject_pure()
    def test_pure_nonfrozen_install_rejected(self): self.write_json(self.pure_dir / 'install-command.json', ['pnpm', 'install']); self.reject_pure()
    def test_pure_old_vitest_rejected(self): self.versions['vitest'] = 'vitest/5.0.1 linux-x64 node-v24.19.0'; self.save_versions(); self.reject_pure()
    def test_pure_wrong_node_rejected(self): self.versions['node'] = 'v22.10.0'; self.save_versions(); self.reject_pure()
    def test_pure_wrong_pnpm_rejected(self): self.versions['pnpm'] = '10.1.0'; self.save_versions(); self.reject_pure()
    def test_pure_version_raw_mismatch(self): (self.pure_dir / 'node-version.txt').write_text('v22.10.0'); self.reject_pure()
    def test_pure_nonzero_run_exit(self): (self.pure_dir / 'run.exit').write_text('1'); self.reject_pure()
    def test_pure_nonzero_install_exit(self): (self.pure_dir / 'install.exit').write_text('1'); self.reject_pure()
    def test_pure_changed_source_bytes(self): (self.root / self.test_file).write_text('// changed'); self.reject_pure()
    def test_pure_wrong_reviewed_source_pin(self): self.pins['pureProjection']['sourceSHA256'] = 'e' * 64; self.reject_pure()
    def test_pure_empty_raw_capture(self): (self.pure_dir / 'raw.log').write_text(''); self.reject_pure()
    def test_pure_missing_version_capture(self): (self.pure_dir / 'pnpm-version.txt').unlink(); self.reject_pure()
    def test_validation_receipt_failure_is_explicit(self):
        report = ci.validation_receipt(lambda: (_ for _ in ()).throw(AssertionError('synthetic fail')))
        self.assertFalse(report['accepted']); self.assertEqual(report['errors'][0]['detail'], 'synthetic fail')

    def run_main(self, command):
        self.write_json(self.here / 'pins.json', self.pins)
        def fake_git(path, *args):
            is_native = path == self.native
            if args == ('rev-parse', 'HEAD'): return self.pins['commit'] if is_native else self.producer['commit']
            if args == ('rev-parse', 'HEAD^{tree}'): return self.pins['tree'] if is_native else self.producer['tree']
            return ''
        env = {'GITHUB_WORKSPACE': str(self.root), 'REGRESSION_EVIDENCE': 'evidence', 'REGRESSION_NATIVE': 'native',
               'CARGO_TARGET_DIR': str(self.target)}
        with patch.object(ci, 'git', fake_git), patch.dict(os.environ, env), patch.object(sys, 'argv', ['ci.py', command, '--gate', 'fault']):
            ci.main()
    def test_main_failed_pure_retains_receipt(self):
        self.pure['numTodoTests'] = 1; self.write_json(self.pure_dir / 'raw-result.json', self.pure)
        with self.assertRaises(AssertionError): self.run_main('pure-results')
        report = json.loads((self.ev / 'pure-projection-receipt.json').read_text())
        self.assertFalse(report['accepted']); self.assertTrue(report['errors'])
    def test_main_failed_exact_retains_receipt(self):
        self.exact['expected'] = 0; self.save_exact()
        with self.assertRaises(AssertionError): self.run_main('exact-results')
        self.assertFalse(json.loads((self.ev / 'new-native-exact-receipt.json').read_text())['accepted'])
    def test_main_unbound_does_not_create_receipt(self):
        self.pins['commit'] = None
        with self.assertRaises(AssertionError): self.run_main('pure-results')
        self.assertFalse((self.ev / 'pure-projection-receipt.json').exists())

    def audit_fixture(self):
        attach_s9_exact_fixture(self)
        self.write_json(self.ev / 's9-native-exact-receipt.json', ci.s9_exact_results_report(self.ev, self.pins, self.target))
        attach_class_fixture(self)
        self.write_json(self.ev / 'class-projection-receipt.json', ci.class_results_report(self.root, self.ev, self.pins))
        self.write_json(self.ev / 'new-native-exact-receipt.json', self.exact_report())
        self.write_json(self.ev / 'pure-projection-receipt.json', self.pure_report())
        (self.native / 'cli/source.rs').write_text('// synthetic native source; never executed\n')
        self.pins['files'] = {'cli/source.rs': ci.digest(self.native / 'cli/source.rs')}
        copied = self.root / 'native-harness/agent-browser-tests'; copied.parent.mkdir(); copied.write_bytes(self.binary.read_bytes())
        tool = self.root / 'synthetic-rustc'; tool.write_text('not an executable compiler\n')
        self.write_json(self.ev / 'toolchain.json', {'binaries': {'rustc': {'path': str(tool), 'sha256': ci.digest(tool)}}})
        self.write_json(self.ev / 'result.json', {'accepted': True, 'captureLoss': False})
        self.write_json(self.ev / 'source-before.json', {'synthetic': True})
        for name in ['toolchain-install.log', 'toolchain-install.exit', 'rustc-version.txt', 'cargo-version.txt',
                     'harness-build.log', 'all-tests.stderr.log', 'ignored-tests.stderr.log', 'full-suite.log', 'full-suite.exit']:
            (self.ev / name).write_text('synthetic capture\n')
    def test_audit_revalidates_complete_new_raw_evidence(self):
        self.audit_fixture(); self.run_main('audit')
        report = json.loads((self.ev / 'custody-after.json').read_text())
        self.assertTrue(report['custodyAccepted']); self.assertTrue(report['requiredControlsAccepted'])
        self.assertTrue(report['newExactAccepted']); self.assertTrue(report['pureProjectionAccepted'])
        self.assertIn('new-native-exact/test-20.cleanup.jsonl', report['captures'])
    def test_audit_distrusts_accepted_exact_receipt_after_raw_tamper(self):
        self.audit_fixture(); self.edit_exact_log('84 filtered out', '0 filtered out')
        with self.assertRaises(AssertionError): self.run_main('audit')
        report = json.loads((self.ev / 'custody-after.json').read_text())
        self.assertFalse(report['custodyAccepted']); self.assertFalse(report['newExactAccepted'])
        self.assertTrue(report['pureProjectionAccepted']); self.assertIn('new-native-exact/test-01.log', report['captures'])
    def test_audit_distrusts_accepted_pure_receipt_after_raw_tamper(self):
        self.audit_fixture(); self.pure['numTodoTests'] = 1; self.write_json(self.pure_dir / 'raw-result.json', self.pure)
        with self.assertRaises(AssertionError): self.run_main('audit')
        report = json.loads((self.ev / 'custody-after.json').read_text())
        self.assertFalse(report['custodyAccepted']); self.assertFalse(report['pureProjectionAccepted'])
        self.assertTrue(report['newExactAccepted']); self.assertIn('attribute-projection/raw-result.json', report['captures'])


def attach_class_fixture(test):
    """Synthetic non-executable bytes only; no JS/native project execution."""
    test.class_dir = test.ev / 'class-projection'; test.class_dir.mkdir(exist_ok=True)
    source_hashes = {}
    for name in ci.CLASS_SOURCE_FILES + [ci.CLASS_CONFIG_FILE]:
        path = test.root / name; path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('// synthetic class source: ' + name + '\n')
        source_hashes[name] = ci.digest(path)
    groups = [{'file': path, 'sourceSHA256': source_hashes[path],
               'testNames': (['class group ' + str(i) + ' control ' + str(n).zfill(2) for n in range(20)] if i < 2 else list(ci.CLASS_OWNED_DEADLINE_NAMES))}
              for i, path in enumerate(ci.CLASS_TEST_FILES)]
    test.pins['classProjection'] = {'configFile': ci.CLASS_CONFIG_FILE, 'configSHA256': source_hashes[ci.CLASS_CONFIG_FILE],
        'files': groups, 'replacedDiagnosticTests': list(ci.CLASS_REPLACED_DIAGNOSTIC_NAMES), 'additionalDiagnosticTests': list(ci.CLASS_ADDITIONAL_DIAGNOSTIC_NAMES), 'sourceFiles': {name: source_hashes[name] for name in ci.CLASS_SOURCE_FILES},
        'nodeMajor': 24, 'pnpmVersion': '12.3.4', 'vitestVersion': '5.0.5'}
    test.pins['producerFiles'] = sorted(set(test.pins['producerFiles']) | set(source_hashes))
    test.producer['files'].update(source_hashes)
    test.write_json(test.ev / 'producer.json', test.producer)
    test.class_raw = {'success': True, 'numTotalTests': 61, 'numPassedTests': 61, 'numFailedTests': 0,
        'numPendingTests': 0, 'numTodoTests': 0, 'numTotalTestSuites': 4, 'numPassedTestSuites': 4,
        'numFailedTestSuites': 0, 'numPendingTestSuites': 0,
        'testResults': [{'name': str(test.root / group['file']), 'status': 'passed', 'message': '',
            'assertionResults': [{'fullName': name, 'status': 'passed', 'failureMessages': []} for name in group['testNames']]} for group in groups]}
    test.class_raw['testResults'][1]['assertionResults'] += [
        {'fullName': name, 'status': 'passed', 'failureMessages': []}
        for name in ci.CLASS_ADDITIONAL_DIAGNOSTIC_NAMES]
    test.write_json(test.class_dir / 'raw-result.json', test.class_raw)
    test.write_json(test.class_dir / 'command.json', ['pnpm', '--filter', 'e2e', 'exec', 'vitest', 'run', '--config',
        '../../' + ci.CLASS_CONFIG_FILE, '--reporter=json', '--outputFile=' + str(test.class_dir / 'raw-result.json')])
    test.write_json(test.class_dir / 'versions.json', test.versions)
    for key, value in test.versions.items(): (test.class_dir / (key + '-version.txt')).write_text(value + '\n')
    (test.class_dir / 'raw.log').write_text('synthetic class command output\n')
    (test.class_dir / 'run.exit').write_text('0\n')


class ClassProjectionTests(unittest.TestCase):
    def setUp(self):
        self.b = S6EvidenceTests(); self.b.setUp(); self.addCleanup(self.b.doCleanups)
        attach_class_fixture(self.b)
    def report(self): return ci.class_results_report(self.b.root, self.b.ev, self.b.pins)
    def save(self): self.b.write_json(self.b.class_dir / 'raw-result.json', self.b.class_raw)
    def reject(self):
        with self.assertRaises((AssertionError, KeyError, TypeError, FileNotFoundError, ValueError)): self.report()
    def test_original_twenty_each_plus_two_diagnostics_success(self):
        r=self.report(); self.assertTrue(r['accepted']);self.assertEqual(r['count'],61);self.assertEqual(r['ownedDeadlineCount'],19);self.assertEqual(r['originalCount'],40);self.assertEqual(r['additionalDiagnosticCount'],2);self.assertFalse(r['browserAcceptance'])
    def test_missing_diagnostic_contract_rejected(self):
        del self.b.pins['classProjection']['additionalDiagnosticTests'];self.reject()
    def test_substituted_diagnostic_name_rejected(self):
        self.b.pins['classProjection']['additionalDiagnosticTests'][0]='other diagnostic';self.reject()
    def test_duplicate_diagnostic_name_rejected(self):
        self.b.pins['classProjection']['additionalDiagnosticTests'][1]=ci.CLASS_ADDITIONAL_DIAGNOSTIC_NAMES[0];self.reject()
    def test_original40_only_result_rejected(self):
        self.b.class_raw['testResults'][1]['assertionResults']=self.b.class_raw['testResults'][1]['assertionResults'][:-2]
        self.b.class_raw['numTotalTests']=40;self.b.class_raw['numPassedTests']=40;self.save();self.reject()
    def test_missing_original_name_even_with_42_total_rejected(self):
        self.b.class_raw['testResults'][0]['assertionResults'][0]['fullName']='foreign replacement';self.save();self.reject()
    def test_diagnostic_wrong_file_rejected(self):
        row=self.b.class_raw['testResults'][1]['assertionResults'].pop()
        self.b.class_raw['testResults'][0]['assertionResults'].append(row);self.save();self.reject()
    def test_diagnostic_skipped_rejected(self):
        self.b.class_raw['testResults'][1]['assertionResults'][-1]['status']='skipped';self.save();self.reject()
    def test_diagnostic_failed_rejected(self):
        self.b.class_raw['testResults'][1]['assertionResults'][-1]['status']='failed';self.save();self.reject()
    def test_original_attribute23_receipt_independent(self):
        before=self.b.pure_report();self.b.class_raw['numTodoTests']=1;self.save();self.assertEqual(before,self.b.pure_report())
    def test_missing_class_contract(self): del self.b.pins['classProjection'];self.reject()
    def test_empty_class_groups(self): self.b.pins['classProjection']['files']=[];self.reject()
    def test_one_class_group(self): self.b.pins['classProjection']['files'].pop();self.reject()
    def test_duplicate_class_group(self): self.b.pins['classProjection']['files'][1]=self.b.pins['classProjection']['files'][0];self.reject()
    def test_duplicate_pin_name(self):
        names=self.b.pins['classProjection']['files'][0]['testNames'];names[0]=names[1];self.reject()
    def test_cross_file_pin_name_overlap(self):
        g=self.b.pins['classProjection']['files'];g[1]['testNames'][0]=g[0]['testNames'][0];self.reject()
    def test_missing_reviewed_production_source(self): self.b.pins['classProjection']['sourceFiles'].pop('packages/web/src/browser.ts');self.reject()
    def test_wrong_config_path(self): self.b.pins['classProjection']['configFile']='other.ts';self.reject()
    def test_wrong_config_pin(self): self.b.pins['classProjection']['configSHA256']='e'*64;self.reject()
    def test_changed_config_bytes(self): (self.b.root/ci.CLASS_CONFIG_FILE).write_text('// changed');self.reject()
    def test_changed_production_bytes(self): (self.b.root/'packages/web/src/browser.ts').write_text('// changed');self.reject()
    def test_changed_test_bytes(self): (self.b.root/ci.CLASS_TEST_FILES[0]).write_text('// changed');self.reject()
    def test_test_and_source_pin_mismatch(self): self.b.pins['classProjection']['files'][0]['sourceSHA256']='e'*64;self.reject()
    def test_producer_source_capture_mismatch(self):
        self.b.producer['files'][ci.CLASS_TEST_FILES[0]]='e'*64;self.b.write_json(self.b.ev/'producer.json',self.b.producer);self.reject()
    def test_foreign_native_identity(self):
        self.b.producer['nativeCommit']='e'*40;self.b.write_json(self.b.ev/'producer.json',self.b.producer);self.reject()
    def test_wrong_gate(self):
        self.b.producer['gate']='default';self.b.write_json(self.b.ev/'producer.json',self.b.producer);self.reject()
    def test_unbound_native(self): self.b.pins['commit']=None;self.reject()
    def test_unknown_producer_commit(self):
        self.b.producer['commit']='unknown';self.b.write_json(self.b.ev/'producer.json',self.b.producer);self.reject()
    def test_raw_wrong_total(self): self.b.class_raw['numTotalTests']=39;self.save();self.reject()
    def test_raw_boolean_count(self): self.b.class_raw['numFailedTests']=False;self.save();self.reject()
    def test_raw_skip_count(self): self.b.class_raw['numPendingTests']=1;self.save();self.reject()
    def test_raw_todo_count(self): self.b.class_raw['numTodoTests']=1;self.save();self.reject()
    def test_raw_failure_count(self): self.b.class_raw['numFailedTests']=1;self.save();self.reject()
    def test_raw_false_success(self): self.b.class_raw['success']=False;self.save();self.reject()
    def test_raw_runtime_error(self): self.b.class_raw['unhandledErrors']=['unknown'];self.save();self.reject()
    def test_raw_missing_file(self): self.b.class_raw['testResults'].pop();self.save();self.reject()
    def test_raw_extra_file(self): self.b.class_raw['testResults'].append(copy.deepcopy(self.b.class_raw['testResults'][0]));self.save();self.reject()
    def test_raw_duplicate_file(self): self.b.class_raw['testResults'][1]['name']=self.b.class_raw['testResults'][0]['name'];self.save();self.reject()
    def test_raw_foreign_file(self): self.b.class_raw['testResults'][0]['name']=str(self.b.root/'foreign.ts');self.save();self.reject()
    def test_raw_relative_file(self): self.b.class_raw['testResults'][0]['name']=ci.CLASS_TEST_FILES[0];self.save();self.reject()
    def test_raw_duplicate_test_name(self):
        a=self.b.class_raw['testResults'][0]['assertionResults'];a[0]['fullName']=a[1]['fullName'];self.save();self.reject()
    def test_raw_foreign_test_name(self): self.b.class_raw['testResults'][0]['assertionResults'][0]['fullName']='foreign';self.save();self.reject()
    def test_raw_skipped_test(self): self.b.class_raw['testResults'][0]['assertionResults'][0]['status']='pending';self.save();self.reject()
    def test_raw_failure_message(self): self.b.class_raw['testResults'][0]['assertionResults'][0]['failureMessages']=['unknown'];self.save();self.reject()
    def test_raw_file_error(self): self.b.class_raw['testResults'][0]['testExecError']='failed';self.save();self.reject()
    def test_wrong_per_file_count(self): self.b.class_raw['testResults'][0]['assertionResults'].pop();self.save();self.reject()
    def test_missing_raw_file(self): (self.b.class_dir/'raw-result.json').unlink();self.reject()
    def test_empty_raw_log(self): (self.b.class_dir/'raw.log').write_text('');self.reject()
    def test_nonzero_run(self): (self.b.class_dir/'run.exit').write_text('1');self.reject()
    def test_nonzero_shared_install(self): (self.b.pure_dir/'install.exit').write_text('1');self.reject()
    def test_nonfrozen_shared_install(self): self.b.write_json(self.b.pure_dir/'install-command.json',['pnpm','install']);self.reject()
    def test_wrong_argv(self): self.b.write_json(self.b.class_dir/'command.json',['pnpm','test']);self.reject()
    def test_class_version_capture_mismatch(self): (self.b.class_dir/'node-version.txt').write_text('v22.0.0');self.reject()
    def test_class_version_wrong_vitest(self):
        v=dict(self.b.versions,vitest='vitest/5.0.1 linux-x64 node-v24.19.0');self.b.write_json(self.b.class_dir/'versions.json',v);(self.b.class_dir/'vitest-version.txt').write_text(v['vitest']);self.reject()
    def test_class_version_differs_shared_install(self):
        v=dict(self.b.versions,node='v24.22.1');self.b.write_json(self.b.class_dir/'versions.json',v);(self.b.class_dir/'node-version.txt').write_text(v['node']);self.reject()
    def test_main_class_failure_retains_explicit_receipt(self):
        self.b.class_raw['numTodoTests']=1;self.save()
        with self.assertRaises(AssertionError): self.b.run_main('class-results')
        r=json.loads((self.b.ev/'class-projection-receipt.json').read_text());self.assertFalse(r['accepted']);self.assertTrue(r['errors'])
    def test_audit_revalidates_not_saved_green(self):
        self.b.audit_fixture();self.b.class_raw['numPendingTests']=1;self.save()
        with self.assertRaises(AssertionError): self.b.run_main('audit')
        r=json.loads((self.b.ev/'custody-after.json').read_text());self.assertFalse(r['classProjectionAccepted']);self.assertTrue(r['pureProjectionAccepted']);self.assertFalse(r['custodyAccepted'])
    def test_accept_rejects_missing_class_boolean(self):
        self.b.audit_fixture();self.b.run_main('audit');r=json.loads((self.b.ev/'custody-after.json').read_text());del r['classProjectionAccepted'];self.b.write_json(self.b.ev/'custody-after.json',r)
        with self.assertRaises(KeyError): self.b.run_main('accept')
    def test_all_current_source_names_exact_twenty_each(self):
        pins=json.loads((HERE/'pins.json').read_text())
        # Parent binds this contract only after native identity/readback; no optional success.
        contract=pins['classProjection']
        self.assertEqual([len(g['testNames']) for g in contract['files']],[20,20,19]);self.assertEqual(contract['files'][2]['testNames'],ci.CLASS_OWNED_DEADLINE_NAMES)


class OwnedDeadlineProjectionTests(unittest.TestCase):
    setUp = ClassProjectionTests.setUp
    report = ClassProjectionTests.report
    save = ClassProjectionTests.save
    reject = ClassProjectionTests.reject
    def test_missing_explicit_replacement_contract(self):
        del self.b.pins['classProjection']['replacedDiagnosticTests']; self.reject()
    def test_foreign_replaced_diagnostic_identity(self):
        self.b.pins['classProjection']['replacedDiagnosticTests'][0]='foreign'; self.reject()
    def test_old_diagnostic_pair_cannot_stand_in_for_attribution(self):
        self.b.pins['classProjection']['additionalDiagnosticTests']=list(ci.CLASS_REPLACED_DIAGNOSTIC_NAMES); self.reject()
    def test_missing_owned_source_identity(self):
        self.b.pins['classProjection']['sourceFiles'].pop(ci.CLASS_TEST_FILES[2]); self.reject()
    def test_missing_core_ownership_source_identity(self):
        self.b.pins['classProjection']['sourceFiles'].pop('packages/e2e/src/internal/time.ts'); self.reject()
    def test_owned_names_substituted_even_with_same_count(self):
        self.b.pins['classProjection']['files'][2]['testNames'][0]='foreign'; self.reject()
    def test_owned_name_duplicate(self):
        names=self.b.pins['classProjection']['files'][2]['testNames']; names[0]=names[1]; self.reject()
    def test_owned_raw_missing_with_original42_present(self):
        self.b.class_raw['testResults'].pop(); self.b.class_raw['numTotalTests']=42; self.b.class_raw['numPassedTests']=42; self.save(); self.reject()
    def test_owned_raw_wrong_file(self):
        row=self.b.class_raw['testResults'][2]['assertionResults'].pop(); self.b.class_raw['testResults'][1]['assertionResults'].append(row); self.save(); self.reject()
    def test_owned_raw_skip(self):
        self.b.class_raw['testResults'][2]['assertionResults'][0]['status']='pending'; self.save(); self.reject()
    def test_owned_raw_failure(self):
        self.b.class_raw['testResults'][2]['assertionResults'][0]['status']='failed'; self.save(); self.reject()
    def test_owned_raw_foreign_same_count(self):
        self.b.class_raw['testResults'][2]['assertionResults'][0]['fullName']='foreign'; self.save(); self.reject()
    def test_owned_source_tamper(self):
        (self.b.root/ci.CLASS_TEST_FILES[2]).write_text('// changed'); self.reject()

def attach_s9_exact_fixture(test):
    """Synthetic text receipts only; no native harness is executed."""
    test.s9_dir = test.ev / 's9-native-exact'; test.s9_dir.mkdir(exist_ok=True)
    (test.s9_dir / 'harness-list.log').write_text(test.all_text)
    (test.ev / 's9-native-exact.exit').write_text('0\n')
    test.s9_rows = []
    for i, name in enumerate(test.s9, 1):
        log = f'\nrunning 1 test\ntest {name} ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 84 filtered out; finished in 0.01s\n'
        path = test.s9_dir / f'test-{i:02d}.log'; path.write_text(log)
        (test.s9_dir / f'test-{i:02d}.cleanup.jsonl').write_text('')
        test.s9_rows.append({'name': name, 'command': [str(test.binary), '--exact', name, '--nocapture', '--test-threads=1'],
            'exit': 0, 'timedOut': False, 'counts': [['1', '0', '0']], 'passed': True, 'logSha256': ci.digest(path)})
    test.s9_exact = {'harnessSha256': ci.digest(test.binary), 'features': ['acceptance-faults'],
                    'notFullAcceptance': True, 'expected': 21, 'results': test.s9_rows}
    save_s9_exact(test)

def save_s9_exact(test):
    test.write_json(test.s9_dir / 'results.json', test.s9_exact)
    (test.ev / 's9-native-exact.log').write_text(''.join(json.dumps(row) + '\n' for row in test.s9_exact['results']))

class S9ExactTests(unittest.TestCase):
    def setUp(self):
        self.b = S6EvidenceTests(); self.b.setUp(); self.addCleanup(self.b.doCleanups)
        attach_s9_exact_fixture(self.b)
    def report(self): return ci.s9_exact_results_report(self.b.ev, self.b.pins, self.b.target)
    def save(self): save_s9_exact(self.b)
    def reject(self):
        with self.assertRaises((AssertionError, KeyError, TypeError, FileNotFoundError, ValueError)): self.report()
    def edit_log(self, old, new):
        p=self.b.s9_dir/'test-01.log';p.write_text(p.read_text().replace(old,new));self.b.s9_rows[0]['logSha256']=ci.digest(p);self.save()
    def test_valid_separate_twenty_one_same_harness(self):
        r=self.report();self.assertTrue(r['accepted']);self.assertEqual(r['count'],21);self.assertEqual(r['binarySHA256'],ci.digest(self.b.binary));self.assertFalse(r['browserAcceptance']);self.assertIn('not additional coverage',r['coverage'])
    def test_old_exact_twenty_unchanged_receipt_and_success(self):
        before=self.b.exact_report();self.b.s9_exact['expected']=0;self.save();self.assertEqual(before,self.b.exact_report());self.assertEqual(before['count'],20)
    def test_old_required_control_schema_unchanged(self):
        r=ci.required_controls(self.b.pins,self.b.collection);self.assertEqual(set(r),{'accepted','requiredNewTests','retainedRequiredTests','newCount','retainedCount','coverage'})
    def test_s9_required_both_default_and_fault(self):
        for gate in ['default','fault']:
            saved=json.loads((self.b.ev/'inventory.json').read_text());saved['features']=[] if gate=='default' else ['acceptance-faults'];self.b.write_json(self.b.ev/'inventory.json',saved)
            r=ci.s9_required_controls_report(self.b.ev,self.b.pins,gate);self.assertEqual(r['s9Count'],21);self.assertEqual(r['gate'],gate)
    def test_s9_missing_pin_fails(self): del self.b.pins['s9RequiredTests'];self.reject()
    def test_s9_empty_pin_fails(self): self.b.pins['s9RequiredTests']=[];self.reject()
    def test_s9_wrong_count_pin_fails(self): self.b.pins['s9RequiredTests']=self.b.s9[:20];self.reject()
    def test_s9_duplicate_pin_fails(self): self.b.pins['s9RequiredTests'][0]=self.b.s9[1];self.reject()
    def test_s9_nonexact_pin_fails(self): self.b.pins['s9RequiredTests'][0]='substring';self.reject()
    def test_s9_overlaps_old_twenty_fails(self): self.b.pins['s9RequiredTests'][0]=self.b.new[0];self.reject()
    def test_s9_overlaps_retained43_fails(self): self.b.pins['s9RequiredTests'][0]=self.b.retained[0];self.reject()
    def test_s9_required_missing_from_full_inventory_fails(self):
        c=copy.deepcopy(self.b.collection);c['allTests'].remove(self.b.s9[0])
        with self.assertRaises(AssertionError): ci.s9_required_controls(self.b.pins,c)
    def test_s9_required_ignored_fails(self):
        c=copy.deepcopy(self.b.collection);c['ignoredTests']=sorted(c['ignoredTests']+[self.b.s9[0]])
        with self.assertRaises(AssertionError): ci.s9_required_controls(self.b.pins,c)
    def test_s9_preserves_old_required_guards(self): self.b.pins['requiredNewTests']=[];self.reject()
    def test_s9_unbound_native_fails(self): self.b.pins['commit']=None;self.reject()
    def test_s9_mismatched_native_tree_fails(self): self.b.pins['tree']='e'*40;self.reject()
    def test_s9_selector_file_wrong_count(self): self.b.write_json(self.b.ev/'s9-native-exact-inventory.json',{'selectors':self.b.s9,'count':20});self.reject()
    def test_s9_selector_file_missing(self): (self.b.ev/'s9-native-exact-inventory.json').unlink();self.reject()
    def test_s9_selector_file_old_group(self): self.b.write_json(self.b.ev/'s9-native-exact-inventory.json',{'selectors':self.b.new,'count':20});self.reject()
    def test_s9_required_receipt_old_group(self): self.b.write_json(self.b.ev/'s9-required-controls.json',json.loads((self.b.ev/'required-controls.json').read_text()));self.reject()
    def test_s9_required_receipt_unknown(self): self.b.write_json(self.b.ev/'s9-required-controls.json',{'accepted':True});self.reject()
    def test_s9_required_receipt_missing(self): (self.b.ev/'s9-required-controls.json').unlink();self.reject()
    def test_s9_missing_results(self): (self.b.s9_dir/'results.json').unlink();self.reject()
    def test_s9_empty_results(self): self.b.s9_exact['results']=[];self.save();self.reject()
    def test_s9_expected_wrong_count(self): self.b.s9_exact['expected']=20;self.save();self.reject()
    def test_s9_expected_bool(self): self.b.s9_exact['expected']=True;self.save();self.reject()
    def test_s9_missing_row(self): self.b.s9_exact['results'].pop();self.save();self.reject()
    def test_s9_duplicate_row(self): self.b.s9_exact['results'][0]=self.b.s9_exact['results'][1];self.save();self.reject()
    def test_s9_reordered_rows(self): self.b.s9_rows[0],self.b.s9_rows[1]=self.b.s9_rows[1],self.b.s9_rows[0];self.save();self.reject()
    def test_s9_wrong_features(self): self.b.s9_exact['features']=[];self.save();self.reject()
    def test_s9_foreign_harness_hash(self): self.b.s9_exact['harnessSha256']='e'*64;self.save();self.reject()
    def test_s9_claimed_full_acceptance_fails(self): self.b.s9_exact['notFullAcceptance']=False;self.save();self.reject()
    def test_s9_command_log_missing(self): (self.b.ev/'s9-native-exact.log').unlink();self.reject()
    def test_s9_command_log_tamper(self): (self.b.ev/'s9-native-exact.log').write_text('{}\n');self.reject()
    def test_s9_nonzero_runner_exit(self): (self.b.ev/'s9-native-exact.exit').write_text('101');self.reject()
    def test_s9_timeout_runner_exit(self): (self.b.ev/'s9-native-exact.exit').write_text('124');self.reject()
    def test_s9_nonzero_row_exit(self): self.b.s9_rows[0]['exit']=101;self.save();self.reject()
    def test_s9_boolean_row_exit(self): self.b.s9_rows[0]['exit']=False;self.save();self.reject()
    def test_s9_timed_out_row(self): self.b.s9_rows[0]['timedOut']=True;self.save();self.reject()
    def test_s9_false_pass_row(self): self.b.s9_rows[0]['passed']=False;self.save();self.reject()
    def test_s9_wrong_counts_row(self): self.b.s9_rows[0]['counts']=[['0','0','1']];self.save();self.reject()
    def test_s9_foreign_harness_argv(self): self.b.s9_rows[0]['command'][0]+='-foreign';self.save();self.reject()
    def test_s9_nonexact_argv(self): self.b.s9_rows[0]['command'].remove('--exact');self.save();self.reject()
    def test_s9_wrong_raw_hash(self): self.b.s9_rows[0]['logSha256']='e'*64;self.save();self.reject()
    def test_s9_raw_failed(self): self.edit_log(' ... ok',' ... FAILED');self.reject()
    def test_s9_raw_ignored(self): self.edit_log(' ... ok',' ... ignored');self.reject()
    def test_s9_raw_wrong_name(self): self.edit_log(self.b.s9[0],'native::foreign');self.reject()
    def test_s9_raw_duplicate_name(self):
        row=f'test {self.b.s9[0]} ... ok\n';self.edit_log(row,row+row);self.reject()
    def test_s9_raw_missing_name(self): self.edit_log(f'test {self.b.s9[0]} ... ok\n','');self.reject()
    def test_s9_wrong_filtered_count(self): self.edit_log('84 filtered out','0 filtered out');self.reject()
    def test_s9_wrong_pass_summary(self): self.edit_log('1 passed;','0 passed;');self.reject()
    def test_s9_measured_summary(self): self.edit_log('0 measured;','1 measured;');self.reject()
    def test_s9_duplicate_summary(self):
        p=self.b.s9_dir/'test-01.log';s=p.read_text();p.write_text(s+s[s.index('test result:'):]);self.b.s9_rows[0]['logSha256']=ci.digest(p);self.save();self.reject()
    def test_s9_missing_cleanup(self): (self.b.s9_dir/'test-01.cleanup.jsonl').unlink();self.reject()
    def test_s9_missing_last_raw_log(self): (self.b.s9_dir/'test-21.log').unlink();self.reject()
    def test_s9_different_harness_collection(self): (self.b.s9_dir/'harness-list.log').write_text('native::foreign: test\n1 tests, 0 benchmarks\n');self.reject()
    def test_s9_changed_harness_bytes(self): self.b.binary.write_text('changed');self.reject()
    def test_s9_changed_compiler_artifact(self): (self.b.ev/'harness.jsonl').write_text('{}\n');self.reject()
    def test_s9_compiler_profile_mismatch(self):
        meta=json.loads((self.b.ev/'test-binary.json').read_text());meta['profile']['opt_level']='0';self.b.write_json(self.b.ev/'test-binary.json',meta);self.reject()
    def test_s9_harness_path_mismatch(self): (self.b.ev/'harness.path').write_text(str(self.b.binary)+'-foreign');self.reject()
    def test_group_helper_rejects_foreign_prefix(self):
        with self.assertRaises(AssertionError): ci.exact_group_results_report(self.b.ev,self.b.pins,self.b.target,self.b.collection,self.b.s9,'../escape')
    def test_main_required_controls_separate_both_groups(self):
        for name in ['required-controls.json','new-native-exact-inventory.json','s9-required-controls.json','s9-native-exact-inventory.json']: (self.b.ev/name).unlink()
        self.b.run_main('required-controls');self.assertEqual(json.loads((self.b.ev/'new-native-exact-inventory.json').read_text())['count'],20);self.assertEqual(json.loads((self.b.ev/'s9-native-exact-inventory.json').read_text())['count'],21)
    def test_main_failed_s9_retains_explicit_receipt(self):
        self.b.s9_exact['expected']=0;self.save()
        with self.assertRaises(AssertionError): self.b.run_main('s9-exact-results')
        r=json.loads((self.b.ev/'s9-native-exact-receipt.json').read_text());self.assertFalse(r['accepted']);self.assertTrue(r['errors'])
    def test_main_s9_cannot_use_default_gate(self):
        with patch.object(sys,'argv',['ci.py','s9-exact-results','--gate','default']),patch.dict(os.environ,{'GITHUB_WORKSPACE':str(self.b.root),'REGRESSION_EVIDENCE':'evidence','REGRESSION_NATIVE':'native','CARGO_TARGET_DIR':str(self.b.target)}):
            self.b.write_json(self.b.here/'pins.json',self.b.pins)
            with self.assertRaises(AssertionError): ci.main()
    def test_audit_requires_new_raw_even_saved_green(self):
        self.b.audit_fixture();self.edit_log('84 filtered out','0 filtered out')
        with self.assertRaises(AssertionError): self.b.run_main('audit')
        r=json.loads((self.b.ev/'custody-after.json').read_text());self.assertFalse(r['s9ExactAccepted']);self.assertTrue(r['newExactAccepted']);self.assertFalse(r['custodyAccepted']);self.assertIn('s9-native-exact/test-21.cleanup.jsonl',r['captures'])
    def test_audit_requires_s9_named_receipt(self):
        self.b.audit_fixture();(self.b.ev/'s9-required-controls.json').unlink()
        with self.assertRaises(AssertionError): self.b.run_main('audit')
        r=json.loads((self.b.ev/'custody-after.json').read_text());self.assertFalse(r['s9RequiredControlsAccepted']);self.assertTrue(r['requiredControlsAccepted']);self.assertFalse(r['custodyAccepted'])
    def test_audit_requires_s9_selector_receipt(self):
        self.b.audit_fixture();self.b.write_json(self.b.ev/'s9-native-exact-inventory.json',{'selectors':self.b.new,'count':20})
        with self.assertRaises(AssertionError): self.b.run_main('audit')
        self.assertFalse(json.loads((self.b.ev/'custody-after.json').read_text())['s9RequiredControlsAccepted'])
    def test_accept_requires_s9_boolean(self):
        self.b.audit_fixture();self.b.run_main('audit');r=json.loads((self.b.ev/'custody-after.json').read_text());r['s9ExactAccepted']=False;self.b.write_json(self.b.ev/'custody-after.json',r)
        with self.assertRaises(AssertionError): self.b.run_main('accept')
    def test_accept_requires_s9_required_boolean(self):
        self.b.audit_fixture();self.b.run_main('audit');r=json.loads((self.b.ev/'custody-after.json').read_text());r['s9RequiredControlsAccepted']=False;self.b.write_json(self.b.ev/'custody-after.json',r)
        with self.assertRaises(AssertionError): self.b.run_main('accept')
    def test_real_s9_pin_names_present_and_active_both_inventories(self):
        pins=json.loads((HERE/'pins.json').read_text());self.assertEqual(len(pins['s9RequiredTests']),21)
        for gate in ['default','fault']:
            expected=json.loads((HERE/('inventory-'+gate+'.json')).read_text());names=ci.exact_names(pins['s9RequiredTests'],21,'S9 source expectations');self.assertTrue(set(names)<=set(expected['allTests']));self.assertFalse(set(names)&set(expected['ignoredTests']));self.assertFalse(set(names)&set(pins['requiredNewTests']+pins['retainedRequiredTests']))


if __name__ == '__main__': unittest.main(verbosity=2)
