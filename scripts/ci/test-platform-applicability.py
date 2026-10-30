"""Pure synthetic applicability/custody controls; never execute native/browser tests.

The true-capability fixtures model the opposite filesystem; they do not claim that
this host has a case-insensitive filesystem or that skipped branches executed.
"""
import ast
import collections
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]
CONTAINER = ROOT / 'scripts/ci/full-standard-helpers-2.sh'
SOURCE = CONTAINER.read_bytes()
START = b"cat > evidence/tools/validate-vitest.py <<'HELPER_3'\n"
BODY = SOURCE.split(START, 1)[1].split(b'\nHELPER_3\n', 1)[0] + b'\n'
validator = types.ModuleType('current_platform_applicability_validator')
validator.__file__ = str(ROOT / 'evidence/tools/validate-vitest.py')
exec(compile(BODY, validator.__file__, 'exec'), validator.__dict__)


def encoded(value):
    return (json.dumps(value, indent=2) + '\n').encode()


class ClassifierControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='platform-classifier-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.make(False)

    def make(self, capability):
        self.capability = capability
        filename = str(self.root / validator.COLLECT)
        declarations = [(*case[:2],) for case in validator.CASES] + [(('ordinary assertions', 'actual business assertion'), None)]
        self.rows = []
        for title_path, applies in declarations:
            self.rows.append({'ancestorTitles': list(title_path[:-1]), 'title': title_path[-1], 'fullName': ' '.join(title_path),
                              'status': 'pending' if applies is not None and applies != capability else 'passed'})
        self.collection = [{'file': filename, 'name': ' > '.join(a['ancestorTitles'] + [a['title']])} for a in self.rows]
        self.result = {'testResults': [{'name': filename, 'assertionResults': self.rows}], 'success': True}
        self.recount()
        self.expected = {'sourceCommit': 'a' * 40, 'sourceTree': 'b' * 40, 'sourceInventorySHA256': 'c' * 64,
                         'collectSourceSHA256': 'd' * 64, 'observerSourceSHA256': 'e' * 64, 'validatorSourceSHA256': 'f' * 64,
                         'consumerRun': '123', 'consumerAttempt': '1', 'job': 'consume_0', 'nodeSelector': '22.23.4',
                         'nodeVersion': 'v22.23.4', 'collectionSHA256': validator.sha(encoded(self.collection)), 'tempRootRealpath': '/tmp'}
        self.context = dict(self.expected, schemaVersion=1, kind='collect-fs-context/v1', invocationKind='core-full-suite', nonce='1' * 64)
        root = '/tmp/e2e-collect-SyntheticFixture1'
        identity = lambda path, ino: {'realpath': path, 'dev': '1', 'ino': str(ino), 'type': 'directory', 'symlink': False}
        canonical = identity(root + '/tests/agent', 103)
        observation = {'root': identity(root, 101), 'tests': identity(root + '/tests', 102), 'canonical': canonical,
                       'alternate': copy.deepcopy(canonical) if capability else None,
                       'alternateLookupOutcome': 'same-directory' if capability else 'absent-ENOENT'}
        self.receipt = {'schemaVersion': 1, 'kind': 'collect-fixture-case-capability/v1', 'contextSHA256': validator.sha(encoded(self.context)),
                        'nonce': self.context['nonce'], 'workerPid': 12345, 'moduleSourceSHA256': self.expected['collectSourceSHA256'],
                        'observerSourceSHA256': self.expected['observerSourceSHA256'], 'rootRealpath': root,
                        'originalCaseInsensitiveFs': capability, 'validatedCaseInsensitiveFs': capability,
                        'observation': observation, 'recheckedObservation': copy.deepcopy(observation)}
        self.command_exit = 0

    def recount(self):
        rows = [a for suite in self.result['testResults'] for a in suite['assertionResults']]
        self.result.update(numTotalTests=len(rows), numPassedTests=sum(a['status'] == 'passed' for a in rows),
                           numFailedTests=sum(a['status'] == 'failed' for a in rows),
                           numPendingTests=sum(a['status'] in ['pending', 'skipped'] for a in rows),
                           numTodoTests=sum(a['status'] == 'todo' for a in rows))

    def refresh_context_hash(self):
        self.receipt['contextSHA256'] = validator.sha(encoded(self.context))

    def refresh_observation(self):
        self.receipt['recheckedObservation'] = copy.deepcopy(self.receipt['observation'])

    def classify(self, context_bytes=None, receipt_bytes=None):
        return validator.classify_core(self.root, self.collection, self.result, self.command_exit,
                                       encoded(self.context) if context_bytes is None else context_bytes,
                                       encoded(self.receipt) if receipt_bytes is None else receipt_bytes, self.expected)

    def rejected(self):
        with self.assertRaises((AssertionError, KeyError, TypeError, ValueError)):
            self.classify()

    def test_false_exact_two_not_applicable_not_pass(self):
        before = copy.deepcopy(self.result)
        report = self.classify()
        self.assertEqual((report['declaredRequired'], report['reportedRequired'], report['applicableRequired'], report['requiredPassed']), (4, 4, 2, 2))
        self.assertEqual(len(report['notApplicable']), 2)
        self.assertEqual({x['originalSkipPredicate'] for x in report['notApplicable']}, {'!caseInsensitiveFs'})
        self.assertEqual(before, self.result)

    def test_true_exact_one_not_applicable_not_pass(self):
        self.make(True)
        report = self.classify()
        self.assertEqual((report['declaredRequired'], report['reportedRequired'], report['applicableRequired'], report['requiredPassed']), (4, 4, 3, 3))
        self.assertEqual(len(report['notApplicable']), 1)
        self.assertEqual(report['notApplicable'][0]['originalSkipPredicate'], 'caseInsensitiveFs')

    def test_raw_skipped_spelling_preserved(self):
        for row in self.rows:
            if row['status'] == 'pending': row['status'] = 'skipped'
        report = self.classify(); self.assertEqual({x['rawStatus'] for x in report['notApplicable']}, {'skipped'})

    def test_census_precedes_receipt_classification(self):
        self.collection.pop()
        with self.assertRaisesRegex(AssertionError, 'collection/result identity multiplicity mismatch'):
            self.classify(context_bytes=b'not JSON', receipt_bytes=b'not JSON')

    def test_every_context_field_independently_joined(self):
        for key in validator.EXPECTED_KEYS:
            with self.subTest(key=key):
                original = self.context[key]
                self.context[key] = original + '-foreign'; self.refresh_context_hash()
                self.rejected(); self.context[key] = original; self.refresh_context_hash()

    def test_untrusted_context_cannot_redefine_expected_schema(self):
        self.expected['allowedSkipNames'] = []; self.rejected()

    def test_bad_context_constants(self):
        for key, value in [('schemaVersion', 2), ('schemaVersion', True), ('kind', 'other'), ('invocationKind', 'filtered-suite')]:
            with self.subTest(key=key, value=value):
                original = self.context[key]; self.context[key] = value; self.refresh_context_hash(); self.rejected()
                self.context[key] = original; self.refresh_context_hash()

    def test_context_unknown_or_missing_key(self):
        self.context['category'] = 'platform'; self.refresh_context_hash(); self.rejected()
        del self.context['category']; del self.context['nonce']; self.rejected()

    def test_nonce_missing_or_nonrandom_shape(self):
        self.context['nonce'] = 'short'; self.receipt['nonce'] = 'short'; self.refresh_context_hash(); self.rejected()

    def test_foreign_receipt_nonce(self): self.receipt['nonce'] = '2' * 64; self.rejected()
    def test_context_hash_binds_raw_newline(self):
        self.receipt['contextSHA256'] = validator.sha(encoded(self.context).rstrip(b'\n')); self.rejected()
    def test_bad_receipt_constants(self):
        self.receipt['kind'] = 'arbitrary-platform-exception'; self.rejected()
    def test_unknown_receipt_allowlist(self): self.receipt['allowedSkipNames'] = [self.rows[0]['fullName']]; self.rejected()
    def test_unknown_receipt_category(self): self.receipt['category'] = 'platform'; self.rejected()
    def test_missing_receipt_field(self): del self.receipt['observation']; self.rejected()
    def test_foreign_module_source(self): self.receipt['moduleSourceSHA256'] = '9' * 64; self.rejected()
    def test_foreign_observer_source(self): self.receipt['observerSourceSHA256'] = '9' * 64; self.rejected()
    def test_worker_pid_not_boolean_or_zero(self):
        for value in [True, 0, -1, '12']:
            with self.subTest(value=value): self.receipt['workerPid'] = value; self.rejected()
    def test_capability_unknown_or_disagreement(self):
        for value in [None, 0, 'false', True]:
            with self.subTest(value=value): self.receipt['validatedCaseInsensitiveFs'] = value; self.rejected()
    def test_false_only_enoent_not_eacces_eio_enotdir(self):
        for value in ['EACCES', 'EIO', 'ENOTDIR', 'unknown', 'same-directory']:
            with self.subTest(value=value):
                self.receipt['observation']['alternateLookupOutcome'] = value; self.refresh_observation(); self.rejected()
    def test_false_canonical_missing_or_inaccessible(self):
        self.receipt['observation']['canonical'] = None; self.refresh_observation(); self.rejected()
    def test_false_canonical_symlink(self):
        self.receipt['observation']['canonical']['symlink'] = True; self.refresh_observation(); self.rejected()
    def test_false_alternate_must_be_null(self):
        self.receipt['observation']['alternate'] = copy.deepcopy(self.receipt['observation']['canonical']); self.refresh_observation(); self.rejected()
    def test_true_alternate_unrelated_directory(self):
        self.make(True); self.receipt['observation']['alternate']['ino'] = '999'; self.refresh_observation(); self.rejected()
    def test_true_alternate_symlink(self):
        self.make(True); self.receipt['observation']['alternate']['symlink'] = True; self.refresh_observation(); self.rejected()
    def test_true_alternate_wrong_realpath(self):
        self.make(True); self.receipt['observation']['alternate']['realpath'] += '-other'; self.refresh_observation(); self.rejected()
    def test_root_join_wrong_parent(self):
        self.receipt['rootRealpath'] = '/foreign/e2e-collect-Other'; self.rejected()
    def test_root_join_wrong_prefix(self): self.receipt['rootRealpath'] = '/tmp/unrelated'; self.rejected()
    def test_tests_or_canonical_path_wrong(self):
        self.receipt['observation']['tests']['realpath'] += '-foreign'; self.refresh_observation(); self.rejected()
    def test_identity_noncanonical_path_or_bad_numbers(self):
        for key, value in [('realpath', '/tmp/../tmp/e2e-collect-X'), ('dev', '-1'), ('ino', '0'), ('ino', 12), ('type', 'file')]:
            with self.subTest(key=key):
                original = self.receipt['observation']['root'][key]; self.receipt['observation']['root'][key] = value
                self.refresh_observation(); self.rejected(); self.receipt['observation']['root'][key] = original
        self.refresh_observation()
    def test_observation_unknown_key(self):
        self.receipt['observation']['category'] = 'case-sensitive'; self.refresh_observation(); self.rejected()
    def test_identity_unknown_key(self):
        self.receipt['observation']['root']['ignoredError'] = 'EACCES'; self.refresh_observation(); self.rejected()
    def test_same_root_recheck_disagreement(self): self.receipt['recheckedObservation']['root']['ino'] = '555'; self.rejected()
    def test_rechecked_observation_bool_int_alias_rejected(self): self.receipt['recheckedObservation']['canonical']['symlink'] = 0; self.rejected()
    def test_false_sensitive_row_must_pass(self): self.rows[1]['status'] = 'pending'; self.recount(); self.rejected()
    def test_true_insensitive_row_must_pass(self): self.make(True); self.rows[0]['status'] = 'pending'; self.recount(); self.rejected()
    def test_inapplicable_row_cannot_be_manufactured_pass(self): self.rows[0]['status'] = 'passed'; self.recount(); self.rejected()
    def test_extra_pending_business_case(self): self.rows[-1]['status'] = 'pending'; self.recount(); self.rejected()
    def test_business_failure_cancel_todo_unknown(self):
        for status in ['failed', 'cancelled', 'todo', 'unknown']:
            with self.subTest(status=status): self.rows[-1]['status'] = status; self.recount(); self.rejected()
    def duplicate_ordinary(self, copies=1):
        declaration, result = copy.deepcopy(self.collection[-1]), copy.deepcopy(self.rows[-1])
        for _ in range(copies):
            self.collection.append(copy.deepcopy(declaration)); self.rows.append(copy.deepcopy(result))
        self.recount()
        self.expected['collectionSHA256'] = validator.sha(encoded(self.collection))
        self.context['collectionSHA256'] = self.expected['collectionSHA256']; self.refresh_context_hash()
    def test_ordinary_parameterized_multiplicities_preserved_without_deduplication(self):
        self.duplicate_ordinary(copies=2)
        report = self.classify()
        self.assertEqual((report['declaredRequired'], report['reportedRequired'], report['requiredPassed']), (6, 6, 4))
        self.assertEqual(len(report['notApplicable']), 2)
        self.assertIn('not a unique-task-ID claim', report['censusMeaning'])
    def test_ordinary_duplicate_excess_result_rejected(self):
        self.duplicate_ordinary(); self.rows.append(copy.deepcopy(self.rows[-1])); self.recount(); self.rejected()
    def test_ordinary_duplicate_missing_result_rejected(self):
        self.duplicate_ordinary(); self.rows.pop(); self.recount(); self.rejected()
    def test_ordinary_duplicate_excess_collection_rejected(self):
        self.duplicate_ordinary(); self.collection.append(copy.deepcopy(self.collection[-1])); self.rejected()
    def test_ordinary_duplicate_first_pending_cannot_be_hidden_by_later_pass(self):
        self.duplicate_ordinary(); self.rows[-2]['status'] = 'pending'; self.recount(); self.rejected()
    def test_ordinary_duplicate_first_failure_cannot_be_hidden_by_later_pass(self):
        self.duplicate_ordinary(); self.rows[-2]['status'] = 'failed'; self.recount(); self.rejected()
    def test_missing_collection_identity(self): self.collection.pop(); self.rejected()
    def test_missing_result_identity(self): self.rows.pop(); self.recount(); self.rejected()
    def test_duplicate_conditional_collection_even_if_result_also_duplicated(self):
        self.collection.append(copy.deepcopy(self.collection[0])); self.rows.append(copy.deepcopy(self.rows[0])); self.recount(); self.rejected()
    def test_duplicate_result_identity(self): self.rows.append(copy.deepcopy(self.rows[0])); self.recount(); self.rejected()
    def test_same_title_wrong_file(self): self.result['testResults'][0]['name'] += '-foreign'; self.rejected()
    def test_renamed_original_conditional_both_censuses(self):
        self.rows[0]['title'] += '-renamed'; self.rows[0]['fullName'] += '-renamed'; self.collection[0]['name'] += '-renamed'; self.rejected()
    def test_structurally_changed_conditional_even_same_join(self):
        row = self.rows[0]; row['title'] = ' > '.join(row['ancestorTitles'] + [row['title']]); row['ancestorTitles'] = []; row['fullName'] = row['title']; self.rejected()
    def test_ambiguous_joined_result_identity(self):
        self.rows.append({'ancestorTitles': [], 'title': self.collection[-1]['name'], 'fullName': self.collection[-1]['name'], 'status': 'passed'})
        self.collection.append(copy.deepcopy(self.collection[-1]))
        self.recount(); self.rejected()
    def test_full_name_must_match_structural_path(self): self.rows[0]['fullName'] = 'forged'; self.rejected()
    def test_file_paths_must_be_canonical(self): self.collection[0]['file'] = str(self.root) + '/other/../' + validator.COLLECT; self.rejected()
    def test_counters_match_raw_rows_exactly(self):
        for key in ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests']:
            with self.subTest(key=key):
                original = self.result[key]; self.result[key] += 1; self.rejected(); self.result[key] = original
    def test_not_applicable_never_added_to_passed_count(self): self.result['numPassedTests'] += 2; self.rejected()
    def test_remove_not_applicable_from_both_censuses(self):
        del self.collection[0]; del self.rows[0]; self.recount(); self.rejected()
    def test_counter_bool_rejected(self): self.result['numFailedTests'] = False; self.rejected()
    def test_nonzero_exit_or_success_false(self):
        self.command_exit = 1; self.rejected(); self.command_exit = 0; self.result['success'] = False; self.rejected()
    def test_runtime_error_not_platform_applicability(self): self.result['unhandledErrors'] = ['error']; self.rejected()
    def test_failed_suite_not_hidden_by_passed_assertions(self): self.result['testResults'][0]['status'] = 'failed'; self.rejected()
    def test_duplicate_json_keys_context_and_receipt(self):
        for which in ['context', 'receipt']:
            with self.subTest(which=which):
                value = encoded(getattr(self, which)); duplicate = b'{"schemaVersion":1,' + value[1:]
                with self.assertRaisesRegex(AssertionError, 'duplicate JSON key'):
                    self.classify(**{which + '_bytes': duplicate})


class FileAndPreservationControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='platform-files-'); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(); self.directory = self.root / 'platform-applicability'; self.directory.mkdir()
        (self.directory / 'context.json').write_bytes(b'{}\n'); (self.directory / 'receipt.json').write_bytes(b'{}\n')

    def test_regular_closed_files_read_without_interpreting_category(self):
        self.assertEqual(validator.load_receipts(self.directory), (b'{}\n', b'{}\n'))
    def test_missing_context_or_receipt(self):
        (self.directory / 'receipt.json').unlink()
        with self.assertRaises(AssertionError): validator.load_receipts(self.directory)
    def test_duplicate_receipt_file(self):
        (self.directory / 'receipt-copy.json').write_text('{}')
        with self.assertRaises(AssertionError): validator.load_receipts(self.directory)
    def test_receipt_symlink_rejected(self):
        target = self.root / 'elsewhere'; target.write_text('{}'); (self.directory / 'receipt.json').unlink(); (self.directory / 'receipt.json').symlink_to(target)
        with self.assertRaises(AssertionError): validator.load_receipts(self.directory)
    def test_receipt_hardlink_rejected(self):
        os.link(self.directory / 'receipt.json', self.root / 'receipt-link')
        with self.assertRaises(AssertionError): validator.load_receipts(self.directory)
    def test_directory_symlink_rejected(self):
        link = self.root / 'linked'; link.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(AssertionError): validator.load_receipts(link)
    def test_nonregular_fifo_rejected_without_read(self):
        p = self.directory / 'receipt.json'; p.unlink(); os.mkfifo(p)
        with self.assertRaises(AssertionError): validator.load_receipts(self.directory)
    def test_receipt_and_context_size_bounded(self):
        for name, size in [('context.json', 8193), ('receipt.json', 16385)]:
            with self.subTest(name=name):
                p = self.directory / name; p.write_bytes(b' ' * size)
                with self.assertRaises(AssertionError): validator.load_receipts(self.directory)
                p.write_bytes(b'{}\n')
    def test_empty_file_not_missing_success(self):
        (self.directory / 'receipt.json').write_bytes(b'')
        with self.assertRaises(AssertionError): validator.load_receipts(self.directory)
    def test_original_collect_all_bytes_preserved_except_exact_observer(self):
        validator.verify_collect_source((ROOT / validator.COLLECT).read_bytes())
    def test_original_predicate_cannot_change(self):
        source = (ROOT / validator.COLLECT).read_bytes().replace(b'if (!caseInsensitiveFs) ctx.skip();', b'if (caseInsensitiveFs) ctx.skip();', 1)
        with self.assertRaises(AssertionError): validator.verify_collect_source(source)
    def test_observer_cannot_move_before_original_capability_assignment(self):
        source = (ROOT / validator.COLLECT).read_text()
        assignment = "  caseInsensitiveFs = existsSync(path.join(root, 'tests', 'Agent'));\n"
        source = source.replace(assignment + validator.OBSERVER_CALL, validator.OBSERVER_CALL + assignment)
        with self.assertRaises(AssertionError): validator.verify_collect_source(source.encode())
    def test_duplicate_or_missing_observer_call_rejected(self):
        source = (ROOT / validator.COLLECT).read_text()
        for replacement in ['', validator.OBSERVER_CALL * 2]:
            with self.subTest(replacement=replacement):
                with self.assertRaises(AssertionError): validator.verify_collect_source(source.replace(validator.OBSERVER_CALL, replacement).encode())
    def test_other_quoted_helpers_byte_identical(self):
        expected = OTHER_HELPER_SHA256
        for helper, expected_sha in expected.items():
            marker = ("<<'" + helper + "'\n").encode()
            body = SOURCE.split(marker, 1)[1].split(('\n' + helper + '\n').encode(), 1)[0] + b'\n'
            self.assertEqual(validator.sha(body), expected_sha, helper)
    def test_noncore_legacy_body_preserved(self):
        node = next(n for n in ast.parse(BODY).body if isinstance(n, ast.FunctionDef) and n.name == 'legacy_validate')
        text = ast.get_source_segment(BODY.decode(), node)
        legacy = textwrap.dedent('\n'.join(text.splitlines()[1:])).rstrip() + '\n'
        self.assertEqual(validator.sha(legacy.encode()), LEGACY_NORMALIZED_SHA256)


class CLIPureControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='platform-cli-'); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.ev = self.root / 'evidence/e2e'; self.ev.mkdir(parents=True)
        (self.root / 'evidence/tools').mkdir()
        (self.root / validator.GENERATED).write_bytes(BODY)
        for path in [validator.COLLECT, validator.OBSERVER, validator.CONTAINER]:
            dest = self.root / path; dest.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(ROOT / path, dest)
        self.git('init', '-q'); self.git('add', 'packages', 'scripts'); self.git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic source integrity control, not publication')
        commit = self.git('rev-parse', 'HEAD').decode().strip(); tree = self.git('rev-parse', 'HEAD^{tree}').decode().strip()
        inventory = self.git('ls-tree', '-r', 'HEAD')
        (self.root / 'evidence/source.commit').write_text(commit + '\n'); (self.root / 'evidence/source.tree').write_text(tree + '\n')
        (self.root / 'evidence/source-inventory.txt').write_bytes(inventory)
        node = subprocess.check_output(['node', '--version'], text=True).strip()
        temp_root = subprocess.check_output(['node', '-p', "require('node:fs').realpathSync(require('node:os').tmpdir())"], text=True).strip()
        (self.root / 'evidence/node.version').write_text(node + '\n')
        self.env = dict({key: value for key, value in os.environ.items() if not key.startswith('GIT_')}, GITHUB_WORKSPACE=str(self.root), GITHUB_SHA=commit, GITHUB_RUN_ID='98765', GITHUB_RUN_ATTEMPT='1', GITHUB_JOB='consume_synthetic', NODE_SELECTOR=node[1:], LANE='core')
        model = ClassifierControls(); model.setUp(); self.addCleanup(model.doCleanups); model.root = self.root; model.make(False)
        self.model = model
        self.model.expected.update(sourceCommit=commit, sourceTree=tree, sourceInventorySHA256=validator.sha(inventory),
                                   collectSourceSHA256=validator.sha((self.root / validator.COLLECT).read_bytes()),
                                   observerSourceSHA256=validator.sha((self.root / validator.OBSERVER).read_bytes()), validatorSourceSHA256=validator.sha(BODY),
                                   consumerRun='98765', consumerAttempt='1', job='consume_synthetic', nodeSelector=node[1:], nodeVersion=node, tempRootRealpath=temp_root)
        self.make_receipts(False, emit_receipt=not self._testMethodName.startswith('test_ts_'))

    def git(self, *args):
        env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        return subprocess.check_output(['git', '-C', str(self.root), '-c', 'core.hooksPath=/dev/null', *args], stderr=subprocess.PIPE, env=env)
    def make_receipts(self, capability, emit_receipt=True):
        expected = dict(self.model.expected); self.model.make(capability); self.model.expected.update(expected)
        self.model.expected['collectionSHA256'] = validator.sha(encoded(self.model.collection))
        self.model.context.update(self.model.expected)
        fixture = str(Path(expected['tempRootRealpath']) / 'e2e-collect-SyntheticFixture1')
        self.model.receipt['rootRealpath'] = fixture
        for key, suffix in [('root', ''), ('tests', '/tests'), ('canonical', '/tests/agent')]:
            self.model.receipt['observation'][key]['realpath'] = fixture + suffix
        if capability: self.model.receipt['observation']['alternate'] = copy.deepcopy(self.model.receipt['observation']['canonical'])
        self.model.refresh_observation(); self.model.refresh_context_hash()
        self.model.receipt['moduleSourceSHA256'] = expected['collectSourceSHA256']; self.model.receipt['observerSourceSHA256'] = expected['observerSourceSHA256']
        (self.ev / 'collection.json').write_bytes(encoded(self.model.collection)); (self.ev / 'results.json').write_bytes(encoded(self.model.result)); (self.ev / 'command.exit').write_text('0\n')
        if emit_receipt:
            directory = self.ev / 'platform-applicability'; directory.mkdir(exist_ok=True)
            (directory / 'context.json').write_bytes(encoded(self.model.context)); (directory / 'receipt.json').write_bytes(encoded(self.model.receipt))
    def run_validator(self, path='evidence/e2e'):
        return subprocess.run([sys.executable, validator.GENERATED, path], cwd=self.root, env=self.env, text=True, capture_output=True, timeout=30)
    def assert_failed(self):
        result = self.run_validator(); self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(json.loads((self.ev / 'coverage.json').read_text())['coverageComplete'])
    def prepare_ts(self):
        return subprocess.run(['node', validator.OBSERVER, 'prepare'], cwd=self.root, env=self.env, text=True, capture_output=True, timeout=30)
    def record_ts(self, duplicate=False):
        # Executes only the test-only receipt observer, not collect.test.ts or any business/native/browser test.
        code = """
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { recordCollectFsCapability } = await import(pathToFileURL(path.resolve('packages/e2e/tests/helpers/collect-fs-applicability.ts')).href);
const root = mkdtempSync(path.join(tmpdir(), 'e2e-collect-'));
try {
  mkdirSync(path.join(root, 'tests', 'agent'), { recursive: true });
  const original = existsSync(path.join(root, 'tests', 'Agent'));
  const moduleUrl = pathToFileURL(path.resolve('packages/e2e/tests/unit/collect.test.ts')).href;
  recordCollectFsCapability(root, original, moduleUrl);
  if (process.env.SYNTHETIC_DUPLICATE === '1') {
    assert.throws(() => recordCollectFsCapability(root, original, moduleUrl), (error) => error?.code === 'EEXIST');
  }
  process.stdout.write(JSON.stringify({syntheticCI: true, caseInsensitiveFs: original, duplicateRejected: process.env.SYNTHETIC_DUPLICATE === '1'}));
} finally { rmSync(root, { recursive: true, force: true }); }
"""
        env = dict(self.env, E2E_COLLECT_CAPABILITY_CONTEXT=str(self.ev / 'platform-applicability/context.json'), SYNTHETIC_DUPLICATE='1' if duplicate else '0')
        return subprocess.run(['node', '--input-type=module', '-e', code], cwd=self.root, env=env, text=True, capture_output=True, timeout=30)
    def adapt_only_synthetic_results(self, capability):
        # This synthetic report is test input, NOT a real collect.test.ts execution.
        # Never rewrite the actual TS-generated context/receipt to fit an assumed host.
        self.assertIs(type(capability), bool)
        capture = self.ev / 'platform-applicability'
        before = {p.name: p.read_bytes() for p in capture.iterdir()}
        collection_before = (self.ev / 'collection.json').read_bytes()
        applies = {title_path: active for title_path, active, _ in validator.CASES}
        for row in self.model.rows:
            title_path = tuple(row['ancestorTitles'] + [row['title']])
            row['status'] = 'pending' if title_path in applies and applies[title_path] != capability else 'passed'
        self.model.recount()
        (self.ev / 'results.json').write_bytes(encoded(self.model.result))
        self.assertEqual({p.name: p.read_bytes() for p in capture.iterdir()}, before)
        self.assertEqual((self.ev / 'collection.json').read_bytes(), collection_before)
    def test_ts_prepare_observe_measured_capability_schema_matches_python(self):
        prepared = self.prepare_ts(); self.assertEqual(prepared.returncode, 0, prepared.stderr)
        recorded = self.record_ts(); self.assertEqual(recorded.returncode, 0, recorded.stderr)
        observed = json.loads(recorded.stdout)
        self.assertIs(observed['syntheticCI'], True); self.assertIs(observed['duplicateRejected'], False)
        capability = observed['caseInsensitiveFs']; self.assertIs(type(capability), bool)
        self.adapt_only_synthetic_results(capability)
        result = self.run_validator(); self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((self.ev / 'coverage.json').read_text())
        self.assertEqual(len(report['notApplicable']), 1 if capability else 2)
        self.assertEqual(report['applicability']['caseInsensitiveFs'], capability)
    def test_ts_synthetic_result_adapter_both_capabilities_preserves_receipts(self):
        # Opposite-capability branch here is PURE SYNTHETIC, not a Mac/live-alias claim.
        self.make_receipts(False)
        for capability in [True, False]:
            self.adapt_only_synthetic_results(capability)
            self.assertEqual(self.model.result['numPendingTests'], 1 if capability else 2)
            self.assertEqual(self.model.result['numPassedTests'], 3 if capability else 2)
    def test_ts_duplicate_prepare_rejected_without_clean_and_reuse(self):
        first = self.prepare_ts(); self.assertEqual(first.returncode, 0, first.stderr)
        original = (self.ev / 'platform-applicability/context.json').read_bytes()
        duplicate = self.prepare_ts(); self.assertNotEqual(duplicate.returncode, 0); self.assertIn('EEXIST', duplicate.stderr)
        self.assertEqual((self.ev / 'platform-applicability/context.json').read_bytes(), original)
    def test_ts_duplicate_receipt_emission_rejected(self):
        prepared = self.prepare_ts(); self.assertEqual(prepared.returncode, 0, prepared.stderr)
        recorded = self.record_ts(duplicate=True); self.assertEqual(recorded.returncode, 0, recorded.stderr)
        self.assertTrue(json.loads(recorded.stdout)['duplicateRejected'])
        self.assertEqual({p.name for p in (self.ev / 'platform-applicability').iterdir()}, {'context.json', 'receipt.json'})
    def test_ts_without_opt_in_observes_nothing(self):
        code = """
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { recordCollectFsCapability } = await import(pathToFileURL(path.resolve('packages/e2e/tests/helpers/collect-fs-applicability.ts')).href);
recordCollectFsCapability('/nonexistent-synthetic-root', false, 'not-a-module-url');
assert.equal(existsSync('evidence/e2e/platform-applicability'), false);
"""
        env = dict(self.env); env.pop('E2E_COLLECT_CAPABILITY_CONTEXT', None)
        result = subprocess.run(['node', '--input-type=module', '-e', code], cwd=self.root, env=env, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.ev / 'platform-applicability').exists())
    def test_cli_false_current_git_source_and_environment_pass(self):
        result = self.run_validator(); self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((self.ev / 'coverage.json').read_text()); self.assertEqual(len(report['notApplicable']), 2)
        self.assertEqual(report['captures']['collectionSHA256'], validator.sha((self.ev / 'collection.json').read_bytes()))
    def test_cli_true_synthetic_capability_pass(self):
        self.make_receipts(True); result = self.run_validator(); self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((self.ev / 'coverage.json').read_text()); self.assertEqual((len(report['notApplicable']), report['requiredPassed']), (1, 3))
    def test_cli_foreign_github_sha(self): self.env['GITHUB_SHA'] = 'f' * 40; self.assert_failed()
    def test_cli_foreign_current_run(self): self.env['GITHUB_RUN_ID'] = '98766'; self.assert_failed()
    def test_cli_foreign_current_attempt(self): self.env['GITHUB_RUN_ATTEMPT'] = '2'; self.assert_failed()
    def test_cli_foreign_current_job(self): self.env['GITHUB_JOB'] = 'foreign_job'; self.assert_failed()
    def test_cli_foreign_selected_node(self): self.env['NODE_SELECTOR'] = '0.0.0'; self.assert_failed()
    def test_cli_changed_current_tracked_source(self):
        with (self.root / validator.OBSERVER).open('a') as stream: stream.write('\n// changed\n')
        self.assert_failed()
    def test_cli_source_inventory_not_just_selfreported_hash(self):
        (self.root / 'evidence/source-inventory.txt').write_text('forged source inventory\n'); self.assert_failed()
    def test_cli_generated_validator_exact_source_bound(self):
        with (self.root / validator.GENERATED).open('a') as stream: stream.write('\n# changed\n')
        self.assert_failed()
    def test_cli_collection_hash_binds_original_bytes(self):
        with (self.ev / 'collection.json').open('a') as stream: stream.write('\n')
        self.assert_failed()
    def test_cli_missing_context_is_not_opt_out(self): (self.ev / 'platform-applicability/context.json').unlink(); self.assert_failed()
    def test_cli_noncanonical_core_alias_cannot_use_legacy_validator(self):
        (self.ev.parent / 'alias').mkdir()
        result = self.run_validator('evidence/alias/../e2e')
        self.assertNotEqual(result.returncode, 0)
    def test_cli_missing_receipt_is_not_opt_out(self): (self.ev / 'platform-applicability/receipt.json').unlink(); self.assert_failed()
    def test_cli_context_and_receipt_forged_join_still_rejects_current_source(self):
        self.model.context['sourceCommit'] = 'f' * 40; self.model.refresh_context_hash()
        (self.ev / 'platform-applicability/context.json').write_bytes(encoded(self.model.context)); (self.ev / 'platform-applicability/receipt.json').write_bytes(encoded(self.model.receipt)); self.assert_failed()
    def test_noncore_all_pass_legacy_behavior(self):
        path = self.root / 'evidence/mobile'; path.mkdir()
        filename = str(self.root / 'packages/mobile/test.ts'); row = {'ancestorTitles': ['ordinary'], 'title': 'passes', 'fullName': 'ordinary passes', 'status': 'passed'}
        (path / 'collection.json').write_bytes(encoded([{'file': filename, 'name': 'ordinary > passes'}])); (path / 'results.json').write_bytes(encoded({'testResults': [{'name': filename, 'assertionResults': [row]}], 'numTotalTests': 1, 'numPassedTests': 1, 'numFailedTests': 0, 'numPendingTests': 0, 'numTodoTests': 0, 'success': True})); (path / 'command.exit').write_text('0\n')
        result = self.run_validator('evidence/mobile'); self.assertEqual(result.returncode, 0, result.stderr)
    def test_noncore_pending_not_new_platform_exception(self):
        path = self.root / 'evidence/mobile'; path.mkdir()
        filename = str(self.root / 'packages/mobile/test.ts'); row = {'ancestorTitles': ['ordinary'], 'title': 'pending', 'fullName': 'ordinary pending', 'status': 'pending'}
        (path / 'collection.json').write_bytes(encoded([{'file': filename, 'name': 'ordinary > pending'}])); (path / 'results.json').write_bytes(encoded({'testResults': [{'name': filename, 'assertionResults': [row]}], 'numTotalTests': 1, 'numPassedTests': 0, 'numFailedTests': 0, 'numPendingTests': 1, 'numTodoTests': 0, 'success': True})); (path / 'command.exit').write_text('0\n')
        self.assertNotEqual(self.run_validator('evidence/mobile').returncode, 0)
    def test_existing_web_optional_benchmark_contract_unchanged(self):
        path = self.root / 'evidence/web/ordinary'; path.mkdir(parents=True)
        filename = str(self.root / 'packages/web/tests/integration/crosscheck.test.ts')
        passed = {'ancestorTitles': ['ordinary'], 'title': 'passes', 'fullName': 'ordinary passes', 'status': 'passed'}
        optional = {'ancestorTitles': ['cross-check web-benchmark scenarios'], 'title': 'every scenario', 'fullName': 'cross-check web-benchmark scenarios every scenario', 'status': 'pending'}
        (path / 'collection.json').write_bytes(encoded([{'file': filename, 'name': 'ordinary > passes'}])); (path / 'results.json').write_bytes(encoded({'testResults': [{'name': filename, 'assertionResults': [passed, optional]}], 'numTotalTests': 2, 'numPassedTests': 1, 'numFailedTests': 0, 'numPendingTests': 1, 'numTodoTests': 0, 'success': True})); (path / 'command.exit').write_text('0\n')
        result = self.run_validator('evidence/web/ordinary'); self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((path / 'coverage.json').read_text()); self.assertEqual(report['requiredPassed'], 1); self.assertEqual(len(report['optionalNotExecuted']), 1)


# Exact retained helper bytes and normalized original validator source, not a copy of new policy.
OTHER_HELPER_SHA256 = {'HELPER_4': 'b3209c04d9bd6cb4e367ee55e8ff7c6014bd91d1c4d5baa8cb8909349d23e091', 'HELPER_5': '8a79a4c52e8c5415e69f9eaa92132e01ccbc25aceb18bdc9bed77e884d40829b', 'HELPER_6': '59e7d7145041acdb875b63926edb57f3a6419065c66666effc26cd47a4c80bf8', 'HELPER_7': '5f6cb3ee27c612ec015c91b13a3304d0176215dd014f1c2f7deea9407e3fc89c'}
LEGACY_NORMALIZED_SHA256 = '882e7b73b96e19c52f7bf830fd20e097bb4c9e1796a9f41b87f49a681fc6124e'

if __name__ == '__main__':
    unittest.main(verbosity=2)
