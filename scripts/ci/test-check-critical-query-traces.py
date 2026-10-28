"""Pure filesystem/subprocess validator tests; no browser, native runner or socket."""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name('check-critical-query-traces.py').resolve()
spec = importlib.util.spec_from_file_location('query_validator', SCRIPT)
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


def record(phase='CaptureStarted', number=0, **extra):
    return {'schemaVersion': 2, 'source': 'native', 'pid': 41, 'record': number,
            'operationSeq': number, 'phase': phase, 'droppedBefore': 0,
            'emittedBefore': number, 'suppressedBefore': 0, 'overflow': False, **extra}


def refusal(number=1, **extra):
    return record('QueryScopeRefusal', number, generation=1,
                  queryScopeStage='warm-worlds', queryScopeReason='target-set-changed', **extra)


def failure(number=1, **extra):
    return record('QueryReadFailure', number, generation=1,
                  queryReadStage='metadata', queryReadError='backend-failure', **extra)


class QueryValidatorTests(unittest.TestCase):
    def run_capture(self, records=None, raw=None, setup=None, expected=1):
        with tempfile.TemporaryDirectory(prefix='query-validator-') as temp:
            root = pathlib.Path(temp) / 'evidence/native-trace'
            root.mkdir(parents=True)
            ordinary, query = root / 'native-41.jsonl', root / 'query-41.jsonl'
            ordinary.write_text('ordinary diagnostic not parsed by critical validator\n')
            query.write_bytes(raw if raw is not None else b''.join((json.dumps(x) + '\n').encode() for x in records))
            if setup:
                setup(ordinary, query)
            result = subprocess.run([sys.executable, str(SCRIPT), str(expected)], cwd=temp,
                                    capture_output=True, text=True)
            summary = json.loads((root / 'query-capture-validation.json').read_text())
            return result, summary

    def assert_invalid(self, value):
        result, summary = self.run_capture([record(), value])
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(summary['completeEvidence'])
        self.assertTrue(summary['errors'])
        self.assertTrue(summary['absenceDoesNotProveSuccess'])

    def test_existing_records_and_empty_refusal_capture(self):
        for values in ([record()], [record(), refusal()]):
            with self.subTest(values=values):
                result, summary = self.run_capture(values)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(summary['completeEvidence'])
                self.assertTrue(summary['absenceDoesNotProveSuccess'])
                self.assertTrue(summary['terminalUnreportedDropsMayBeUnobservable'])

    def test_all_closed_read_stages_and_errors(self):
        for stage in sorted(validator.READ_STAGES):
            for error in sorted(validator.READ_ERRORS):
                item = failure()
                item.update(queryReadStage=stage, queryReadError=error)
                self.assertTrue(validator.schema_valid(item), (stage, error))
        result, summary = self.run_capture([record(), failure()])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(summary['completeEvidence'])

    def test_candidate_schema_reasons_are_closed_and_payload_free(self):
        expected = {'candidate-plan-dom-object', 'candidate-plan-dom-backend', 'candidate-plan-attributes', 'candidate-plan-ax-decode', 'candidate-plan-duplicate-ax', 'candidate-plan-roots', 'candidate-plan-ax-child', 'candidate-plan-ax-rows', 'candidate-plan-author-ids', 'candidate-plan-fallback', 'candidate-plan-duplicate-dom', 'candidate-plan-missing-record'}
        self.assertEqual({s for s in validator.READ_STAGES if s.startswith('candidate-plan-')}, expected)
        for stage in sorted(expected):
            item = failure(); item['queryReadStage'] = stage
            result, summary = self.run_capture([record(), item])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(summary['completeEvidence'])
        for field in ['backendNodeId', 'attributes', 'dom', 'exceptionDetails']:
            item = failure(); item.update(queryReadStage='candidate-plan-attributes')
            item[field] = 'not-permitted'
            self.assert_invalid(item)
        item = failure(); item['queryReadStage'] = 'candidate-plan-invented'
        self.assert_invalid(item)

    def test_all_closed_scope_stages_and_reasons(self):
        for stage in sorted(validator.SCOPE_STAGES):
            for reason in sorted(validator.SCOPE_REASONS):
                item = refusal()
                item.update(queryScopeStage=stage, queryScopeReason=reason)
                self.assertTrue(validator.schema_valid(item), (stage, reason))

    def test_unknown_stage_error_reason_and_payload_rejected(self):
        for key, value in [('queryReadStage', 'dom-content'), ('queryReadError', 'arbitrary error'),
                           ('url', 'https://synthetic.invalid/secret'), ('nodeId', 'secret'),
                           ('payload', {'nested': 'secret'})]:
            item = failure(); item[key] = value
            with self.subTest(key=key):
                self.assert_invalid(item)
        item = refusal(); item['queryScopeReason'] = 'new-unreviewed-reason'
        self.assert_invalid(item)

    def test_wrong_phase_shape_and_missing_fields_rejected(self):
        for item in [dict(failure(), phase='QueryScopeRefusal'), dict(refusal(), phase='QueryReadFailure'),
                     dict(record(), generation=1), dict(failure(), queryScopeStage='acquire')]:
            self.assert_invalid(item)
        for key in failure():
            item = failure(); del item[key]
            with self.subTest(missing=key):
                self.assert_invalid(item)

    def test_bad_numeric_boolean_and_container_types(self):
        for key in ['schemaVersion', 'pid', 'record', 'operationSeq', 'generation',
                    'droppedBefore', 'emittedBefore', 'suppressedBefore']:
            for value in [True, -1, 1.0, '1', None, [], {}]:
                item = failure(); item[key] = value
                with self.subTest(key=key, value=value):
                    self.assert_invalid(item)
        for key, value in [('overflow', 0), ('overflow', 'false'), ('source', 'proxy'),
                           ('queryReadStage', []), ('queryReadError', {}), ('pid', 1 << 32),
                           ('record', 1 << 53), ('schemaVersion', 3)]:
            self.assert_invalid(dict(failure(), **{key: value}))
        for value in [None, [], 7, 'string']:
            self.assert_invalid(value)

    def test_duplicate_fields_and_malformed_json_rejected(self):
        start = (json.dumps(record()) + '\n').encode()
        for bad in [b'{bad}\n', b'{"phase":"CaptureStarted","phase":"CaptureStarted"}\n', b'[]\n']:
            result, summary = self.run_capture(raw=start + bad)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(summary['completeEvidence'])
            self.assertEqual(summary['processes'][0]['invalidLines'], 1)

    def test_loss_is_not_success_even_when_schema_valid(self):
        for update in [{'droppedBefore': 1}, {'suppressedBefore': 1}, {'overflow': True}]:
            result, summary = self.run_capture([record(), dict(failure(), **update)])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(summary['completeEvidence'])
            self.assertTrue(summary['processes'][0]['observedLoss'])
        result, summary = self.run_capture([record(), record('CaptureLimitReached', 1)])
        self.assertEqual(result.returncode, 0)
        self.assertFalse(summary['completeEvidence'])

    def test_record_and_byte_limits(self):
        result, summary = self.run_capture([record()] + [failure(i) for i in range(1, 130)])
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any('record bound' in x for x in summary['errors']))
        result, summary = self.run_capture(raw=b' ' * (65536 + 10))
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(summary['processes'][0]['sha256'])
        self.assertTrue(any('byte bound' in x for x in summary['errors']))

    def test_record_identity_and_start_invariants(self):
        for values in [[failure()], [record(), record(number=1)],
                       [record(), dict(failure(), pid=42)], [record(), failure(0)]]:
            result, summary = self.run_capture(values)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(summary['completeEvidence'])

    def test_concurrent_emission_need_not_follow_attempt_ordinal(self):
        # Native assigns the attempt ordinal before acquiring the sink lock.
        result, summary = self.run_capture([record(), failure(2), refusal(1)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(summary['completeEvidence'])

    def test_matching_file_sets_and_expected_processes(self):
        result, summary = self.run_capture([record()], setup=lambda ordinary, query: ordinary.unlink())
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any('file sets differ' in x for x in summary['errors']))
        result, summary = self.run_capture([record()], expected=2)
        self.assertNotEqual(result.returncode, 0)

    def test_hardlink_and_symlink_cannot_alias_or_read_outside(self):
        def hardlink(ordinary, query):
            ordinary.unlink(); os.link(query, ordinary)
        result, summary = self.run_capture([record()], setup=hardlink)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any('aliases ordinary' in x for x in summary['errors']))
        def symlink(ordinary, query):
            query.unlink(); query.symlink_to(ordinary)
        result, summary = self.run_capture([record()], setup=symlink)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(summary['processes'])
        self.assertTrue(any('not regular' in x for x in summary['errors']))
        def dangling_companion(ordinary, query):
            ordinary.unlink(); ordinary.symlink_to('missing-native-file')
        result, summary = self.run_capture([record()], setup=dangling_companion)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any('ordinary sink not regular' in x for x in summary['errors']))


if __name__ == '__main__':
    unittest.main()
