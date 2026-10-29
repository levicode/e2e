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
    def run_capture(self, records=None, raw=None, setup=None, expected=1, explicit_root=False):
        with tempfile.TemporaryDirectory(prefix='query-validator-') as temp:
            root = pathlib.Path(temp) / 'evidence/native-trace'
            root.mkdir(parents=True)
            ordinary, query = root / 'native-41.jsonl', root / 'query-41.jsonl'
            ordinary.write_text('ordinary diagnostic not parsed by critical validator\n')
            query.write_bytes(raw if raw is not None else b''.join((json.dumps(x) + '\n').encode() for x in records))
            if setup:
                setup(ordinary, query)
            result = subprocess.run([sys.executable, str(SCRIPT), str(expected), *([str(root)] if explicit_root else [])], cwd=temp,
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


    def test_explicit_fixture_capture_root_preserves_original_validation(self):
        result, summary = self.run_capture([record()], explicit_root=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(summary['completeEvidence'])

    def test_eval_all_closed_enums_and_nulls(self):
        for stage in ('entry', 'wait', 'capture'):
            for reason in ('entry', 'fence', 'pending', 'unresumed', 'retire', 'health', 'guard'):
                for watermark in ('equal', 'behind', 'ahead', 'unk'):
                    value = dict(s=stage, c=reason, h=None, p=None, t=None, r=None, w=watermark, v=None, e=None)
                    self.assertTrue(validator.schema_valid(record('EvalAdmission', 1, generation=1, eval=value)))
        value.update(h=[65535,65535,7], p=[65535]*8, t=[65535]*3, r=[False]*4, v=validator.SAFE_INTEGER, e=validator.SAFE_INTEGER)
        result, summary = self.run_capture([record(), record('EvalAdmission', 1, generation=1, eval=value)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(summary['completeEvidence'])
        worst = record('EvalAdmission', validator.SAFE_INTEGER, generation=validator.SAFE_INTEGER, eval=value)
        worst.update(pid=(1 << 32)-1, droppedBefore=validator.SAFE_INTEGER,
                     emittedBefore=validator.SAFE_INTEGER, suppressedBefore=validator.SAFE_INTEGER)
        value.update(s='capture', c='unresumed', w='behind')
        encoded = json.dumps(worst, separators=(',', ':')).encode() + b'\n'
        self.assertLessEqual(len(encoded), 512)
        self.assertTrue(validator.schema_valid(worst))

    def test_eval_closed_types_and_bounds(self):
        import copy
        good = dict(s='entry', c='entry', h=[0,0,0], p=[0]*8, t=[0]*3, r=[True]*4, w='equal', v=0, e=0)
        bad = [('s', 'raw'), ('s', []), ('c', {}), ('w', 'payload'),
               ('p', [0]*7), ('p', [True]*8), ('p', [65536]*8), ('p', [-1]*8),
               ('t', [0]*4), ('t', [1.0]*3), ('r', [0]*4), ('r', [True]*3),
               ('v', True), ('e', -1), ('v', validator.SAFE_INTEGER+1), ('e', '123'), ('h', [0,0,8]), ('h', [0,0,True]), ('h', [65536,0,0]), ('h', [0,0]), ('h', [0,0,0,0])]
        for key, item in bad:
            value = copy.deepcopy(good); value[key] = item
            with self.subTest(key=key, item=item):
                self.assert_invalid(record('EvalAdmission', 1, generation=1, eval=value))
        for key in good:
            value = copy.deepcopy(good); del value[key]
            self.assert_invalid(record('EvalAdmission', 1, generation=1, eval=value))
        value = copy.deepcopy(good); value['url'] = 'forbidden'
        self.assert_invalid(record('EvalAdmission', 1, generation=1, eval=value))
        self.assert_invalid(record('EvalAdmission', 1, generation=1, eval=good, message='forbidden'))

    def test_eval_duplicate_nested_field_rejected_and_loss_retained(self):
        value = dict(s='capture', c='guard', h=None, p=None, t=None, r=None, w='unk', v=None, e=None)
        row = record('EvalAdmission', 1, generation=1, eval=value)
        raw = (json.dumps(record())+'\n'+json.dumps(row).replace('"s": "capture"', '"s":"capture","s":"entry"')+'\n').encode()
        result, summary = self.run_capture(raw=raw)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(summary['completeEvidence'])
        row['droppedBefore'] = 1
        result, summary = self.run_capture([record(), row])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(summary['completeEvidence'])
        self.assertTrue(summary['processes'][0]['observedLoss'])

class FieldTimingValidatorTests(unittest.TestCase):
    run_capture = QueryValidatorTests.run_capture
    def test_field_timing_extension_accepts_exact_closed_protocol_and_observation_failures(self):
        for fields in ({'queryReadError': 'deadline-exceeded'}, {'error': 'cancelled'}):
            row = record('QueryReadFailure', 1, generation=1,
                         queryReadStage='fresh-sample', readMs=[0, 1, 2, 3, 4, 5, 6, 65535, 0, 0, 0, 0, 0], **fields)
            self.assertTrue(validator.schema_valid(row))
            result, summary = self.run_capture([record(), row])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(summary['completeEvidence'])

    def test_timing_extension_is_strict_and_never_accepts_unbounded_payload(self):
        good = record('QueryReadFailure', 1, generation=1, queryReadStage='fresh-resolve',
                      queryReadError='deadline-exceeded', readMs=[0] * 13)
        for timing in ([0] * 12, [0] * 14, [True] + [0] * 12, [-1] + [0] * 12,
                       [65536] + [0] * 12, [0.5] + [0] * 12, 'secret'):
            self.assertFalse(validator.schema_valid(dict(good, readMs=timing)))
        for extra in ({'url': 'secret'}, {'query': 'secret'}, {'error': 'cancelled'},
                      {'queryReadStage': 'arbitrary'}, {'queryReadError': 'arbitrary'}):
            self.assertFalse(validator.schema_valid(dict(good, **extra)))
        protocol = dict(good); protocol.pop('queryReadError'); protocol['error'] = 'cancelled'
        protocol.pop('readMs')
        self.assertFalse(validator.schema_valid(protocol))

    def test_maximum_timing_record_stays_under_existing_512_byte_line_limit(self):
        safe = validator.SAFE_INTEGER
        row = record('QueryReadFailure', safe, generation=safe, queryReadStage='read-frames-before',
                     queryReadError='unsupported-capability', readMs=[65535] * 13)
        row.update(pid=(1 << 32) - 1, droppedBefore=safe, emittedBefore=safe,
                   suppressedBefore=safe, overflow=True)
        wire = json.dumps(row, separators=(',', ':')).encode() + b'\n'
        self.assertLessEqual(len(wire), 512)
        self.assertEqual(validator.RECORD_BUDGET, 128)
        self.assertEqual(validator.BYTE_BUDGET, 65536)

class StrictBoundaryTests(unittest.TestCase):
    run_capture = QueryValidatorTests.run_capture

    def test_native_record_limit_is_128_inclusive(self):
        for count, valid in [(128, True), (129, False)]:
            result, summary = self.run_capture([record()] + [failure(i) for i in range(1, count)])
            self.assertEqual(result.returncode == 0, valid)
            self.assertEqual(summary['completeEvidence'], valid)

    def test_native_line_limit_counts_newline(self):
        line = json.dumps(record()).encode()
        for length, valid in [(512, True), (513, False)]:
            result, summary = self.run_capture(raw=line + b' ' * (length - len(line) - 1) + b'\n')
            self.assertEqual(result.returncode == 0, valid)
            self.assertEqual(summary['completeEvidence'], valid)

    def test_native_terminal_json_requires_newline(self):
        result, summary = self.run_capture(raw=json.dumps(record()).encode())
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(summary['completeEvidence'])


class FieldJoinTests(unittest.TestCase):
    @staticmethod
    def js(**extra):
        return dict(phase='settled-failure', suite='replaced-nodes', generation=4, operationSeq=1,
                    command='fixture.read-fields', transmittedTimeoutMs=1000, selectedLocalCancel='none',
                    rawCode='deadline-exceeded', rawEffects='not-dispatched', rawScopeState='usable',
                    returnedCode='cleanup-failed', timeoutRewritten=False, cancelAckSeen=False, **extra)

    @staticmethod
    def timed(pid=41, generation=4, sequence=1):
        return dict(failure(readMs=[0] * 13), pid=pid, generation=generation, operationSeq=sequence)

    def run_field(self, native=None, js=None, custody=None, raw=None, setup=None, receipt=None):
        import hashlib
        with tempfile.TemporaryDirectory(prefix='field-validator-') as temp:
            archive = pathlib.Path(temp) / 'replaced-nodes'
            run = archive / 'run-fresh'
            trace = run / 'native-trace'
            trace.mkdir(parents=True)
            native = native if native is not None else {41: [self.timed()]}
            for pid, rows in native.items():
                (trace / f'native-{pid}.jsonl').write_text('ordinary\n')
                (trace / f'query-{pid}.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in [dict(record(), pid=pid), *rows]))
            js = js if js is not None else [self.js()]
            custody = custody if custody is not None else [dict(suite='replaced-nodes', workerRecords=len(js), invalidRecords=0, lineOverflow=False, recordOverflow=False)]
            data = raw if raw is not None else ''.join(validator.JS_PREFIX + json.dumps(row) + '\n' for row in js) + ''.join(validator.CUSTODY_PREFIX + json.dumps(row) + '\n' for row in custody)
            report = json.dumps({'run': {'errors': []}, 'tests': []})
            (run / 'report.json').write_text(report)
            (run / 'closed-js.jsonl').write_text(data)
            proof = dict(schemaVersion=1, run=run.name, reportSHA256=hashlib.sha256(report.encode()).hexdigest(), closedJsSHA256=hashlib.sha256(data.encode()).hexdigest())
            (run / 'custody.json').write_text(json.dumps(proof))
            log = pathlib.Path(temp) / 'test-e2e.log'
            log.write_text('REPLACED_FIELD_CAPTURE_ARCHIVE ' + json.dumps(proof) + '\n' if receipt is None else receipt)
            if setup:
                setup(archive, run, trace, log)
            result = subprocess.run([sys.executable, str(SCRIPT), str(len(native)), str(archive), '--field-only', '--field-log', str(log)], capture_output=True, text=True)
            summary = json.loads((archive / 'query-capture-validation.json').read_text())
            return result, summary

    def rejects(self, **kwargs):
        result, summary = self.run_field(**kwargs)
        self.assertNotEqual(result.returncode, 0, summary)
        self.assertFalse(summary['completeEvidence'])
        self.assertTrue(summary['errors'])
        return summary

    def test_unique_timed_wire_join_accepts_different_error_codes(self):
        result, summary = self.run_field()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(summary['completeEvidence'])
        self.assertEqual(summary['fieldOnly']['joinedFailures'], 1)
        self.assertEqual(summary['fieldOnly']['joins'][0]['nativePid'], 41)

    def test_two_process_same_coordinates_are_ambiguous(self):
        for second in [self.timed(42), dict(failure(), pid=42, generation=4, operationSeq=1)]:
            summary = self.rejects(native={41: [self.timed()], 42: [second]})
            self.assertEqual(summary['fieldOnly']['joinedFailures'], 0)
            self.assertTrue(any('got 2 matches' in e for e in summary['errors']))

    def test_zero_matches_untimed_or_two_matches_in_same_file_rejected(self):
        self.rejects(native={41: [self.timed(sequence=2)]})
        self.rejects(native={41: [dict(failure(), generation=4)]})
        self.rejects(native={41: [self.timed(), dict(self.timed(), record=2)]})

    def test_multiple_processes_with_unique_coordinates_do_not_assume_pid_order(self):
        result, summary = self.run_field(native={41: [self.timed(generation=3)], 42: [self.timed(42)]})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(summary['completeEvidence'])
        self.assertEqual(summary['fieldOnly']['joins'][0]['nativePid'], 42)

    def test_every_target_must_join_and_duplicates_are_rejected(self):
        self.rejects(js=[self.js(), dict(self.js(), operationSeq=2)])
        self.rejects(js=[self.js(), self.js()])
        self.rejects(js=[])
        self.rejects(js=[dict(self.js(), command='fixture.query')])

    def test_closed_js_schema_rejects_payload_types_unknowns_and_missing_fields(self):
        for update in [{'generation': True}, {'operationSeq': 0}, {'operationSeq': 1 << 53},
                       {'query': 'PRIVATE'}, {'rawCode': 'private-error'}, {'timeoutRewritten': 0},
                       {'suite': 'web-platform'}, {'laterFailuresOmitted': True}, {'command': []}]:
            self.rejects(js=[dict(self.js(), **update)])
        row = self.js(); del row['operationSeq']; self.rejects(js=[row])

    def test_missing_duplicate_or_lossy_js_custody_rejected(self):
        good = dict(suite='replaced-nodes', workerRecords=1, invalidRecords=0, lineOverflow=False, recordOverflow=False)
        self.rejects(custody=[])
        self.rejects(custody=[good, good])
        for update in [{'invalidRecords': 1}, {'lineOverflow': True}, {'recordOverflow': True},
                       {'workerRecords': 0}, {'workerRecords': True}, {'raw': 'PRIVATE'}]:
            self.rejects(custody=[dict(good, **update)])

    def test_capture_limit_and_native_loss_cannot_be_complete(self):
        self.rejects(js=[dict(self.js(), phase='capture-limit-reached', limit=8, laterFailuresOmitted=True)])
        for update in [{'droppedBefore': 1}, {'suppressedBefore': 1}, {'overflow': True}]:
            self.rejects(native={41: [dict(self.timed(), **update)]})
        self.rejects(native={41: [self.timed(), record('CaptureLimitReached', 2)]})

    def test_closed_js_duplicate_keys_terminal_line_and_invalid_utf8_rejected(self):
        row = validator.JS_PREFIX + json.dumps(self.js())
        self.rejects(raw=row.replace('"generation": 4', '"generation":4,"generation":4') + '\n')
        self.rejects(raw=row)
        self.rejects(raw='PRIVATE RAW\n')
        custody = dict(suite='replaced-nodes', workerRecords=1, invalidRecords=0, lineOverflow=False, recordOverflow=False)
        self.rejects(raw=validator.CUSTODY_PREFIX + json.dumps(custody) + '\n' + row + '\n')

    def test_missing_inputs_and_stale_sibling_directory_rejected(self):
        for name in ['report.json', 'closed-js.jsonl', 'custody.json']:
            self.rejects(setup=lambda archive, run, trace, log: (run / name).unlink())
        self.rejects(setup=lambda archive, run, trace, log: trace.rename(run / 'old-trace'))
        self.rejects(setup=lambda archive, run, trace, log: (archive / 'run-stale').mkdir())
        self.rejects(setup=lambda archive, run, trace, log: (run / 'report.json').write_text('{}'))
        self.rejects(setup=lambda archive, run, trace, log: (trace / 'unowned.jsonl').write_text(''))

    def test_missing_duplicate_stale_or_failure_current_log_receipt_rejected(self):
        self.rejects(receipt='')
        self.rejects(receipt='REPLACED_FIELD_CAPTURE_CUSTODY_FAILED\n')
        self.rejects(receipt='REPLACED_FIELD_CAPTURE_ARCHIVE {}\n')
        self.rejects(setup=lambda archive, run, trace, log: log.write_text(log.read_text() * 2))
        self.rejects(setup=lambda archive, run, trace, log: log.write_text(log.read_text() + 'REPLACED_FIELD_CAPTURE_CUSTODY_FAILED\n'))

    def test_owned_capture_and_js_custody_cannot_be_symlinks(self):
        for name in ['report.json', 'closed-js.jsonl', 'custody.json']:
            def setup(archive, run, trace, log):
                original = run / name
                other = run / ('copy-' + name)
                original.rename(other)
                original.symlink_to(other)
            self.rejects(setup=setup)


if __name__ == '__main__':
    unittest.main()
