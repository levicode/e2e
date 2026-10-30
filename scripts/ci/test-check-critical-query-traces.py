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
            for reason in ('entry', 'fence', 'pending', 'unresumed', 'retire', 'health', 'guard', 'p-empty', 'p-front', 'p-cap', 'p-rootent', 'p-rootid', 'p-active', 'p-roottgt', 'p-rootfrm', 'p-mement', 'p-memkind', 'p-memfrm', 'p-missing', 'p-owner', 'p-origin', 'p-binding', 'p-target', 'p-health', 'p-config', 'p-term', 'p-stage', 'p-custody', 'p-ready', 'p-confrev', 'p-fence', 'p-op', 'p-entryid', 'p-permit', 'p-ledger', 'p-eowner', 'p-stream', 'p-etarget', 'p-failed', 'p-index', 'p-snap', 'p-c1s0', 'p-c1s1', 'p-c1s2', 'p-c1s3', 'p-c1sx', 'p-c2s0', 'p-c2s1', 'p-c2s2', 'p-c2s3', 'p-c2sx', 'p-c3s0', 'p-c3s1', 'p-c3s2', 'p-c3s3', 'p-c3sx', 'p-c4s0', 'p-c4s1', 'p-c4s2', 'p-c4s3', 'p-c4sx', 'p-c5s0', 'p-c5s1', 'p-c5s2', 'p-c5s3', 'p-c5sx', 'p-c6s0', 'p-c6s1', 'p-c6s2', 'p-c6s3', 'p-c6sx'):
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


    def test_typed_preparation_refusals_preserve_closed_fields_and_512_byte_ceiling(self):
        safe = validator.SAFE_INTEGER
        for reason in ('p-empty', 'p-front', 'p-cap', 'p-rootent', 'p-rootid', 'p-active', 'p-roottgt', 'p-rootfrm', 'p-mement', 'p-memkind', 'p-memfrm', 'p-missing', 'p-owner', 'p-origin', 'p-binding', 'p-target', 'p-health', 'p-config', 'p-term', 'p-stage', 'p-custody', 'p-ready', 'p-confrev', 'p-fence', 'p-op', 'p-entryid', 'p-permit', 'p-ledger', 'p-eowner', 'p-stream', 'p-etarget', 'p-failed', 'p-index', 'p-snap', 'p-c1s0', 'p-c1s1', 'p-c1s2', 'p-c1s3', 'p-c1sx', 'p-c2s0', 'p-c2s1', 'p-c2s2', 'p-c2s3', 'p-c2sx', 'p-c3s0', 'p-c3s1', 'p-c3s2', 'p-c3s3', 'p-c3sx', 'p-c4s0', 'p-c4s1', 'p-c4s2', 'p-c4s3', 'p-c4sx', 'p-c5s0', 'p-c5s1', 'p-c5s2', 'p-c5s3', 'p-c5sx', 'p-c6s0', 'p-c6s1', 'p-c6s2', 'p-c6s3', 'p-c6sx'):
            value = dict(s='capture', c=reason, h=[65535,65535,7], p=[65535]*8,
                         t=[65535]*3, r=[False]*4, w='behind', v=safe, e=safe)
            row = record('EvalAdmission', safe, generation=safe, eval=value)
            row.update(pid=(1 << 32)-1, droppedBefore=safe, emittedBefore=safe, suppressedBefore=safe)
            self.assertTrue(validator.schema_valid(row))
            self.assertLessEqual(len(json.dumps(row, separators=(',', ':')).encode()) + 1, 512)
            self.assertFalse(validator.schema_valid(dict(row, arbitrary='PRIVATE')))

    def test_eval_closed_types_and_bounds(self):
        import copy
        good = dict(s='entry', c='entry', h=[0,0,0], p=[0]*8, t=[0]*3, r=[True]*4, w='equal', v=0, e=0)
        bad = [('s', 'raw'), ('s', []), ('c', {}), ('c', 'p-unknown'), ('c', 'p-c0s0'), ('c', 'p-c7s0'), ('c', 'p-c1s4'), ('c', 'p-c1sX'), ('c', 'p-c1sunknown'), ('c', 'PRIVATE'), ('w', 'payload'),
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
            result, summary = self.run_capture([record(), row, record('QueryCommandSummary', 2, generation=1, operationSeq=1, cmdSummary=[0, 0, 0])])
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

    def run_field(self, native=None, js=None, custody=None, raw=None, setup=None, receipt=None, inline=None, report_value=None, expected_source='a' * 40):
        import hashlib
        with tempfile.TemporaryDirectory(prefix='field-validator-') as temp:
            archive = pathlib.Path(temp) / 'replaced-nodes'
            run = archive / 'run-fresh'
            trace = run / 'native-trace'
            trace.mkdir(parents=True)
            native = native if native is not None else {41: [self.timed()]}
            for pid, rows in native.items():
                (trace / f'native-{pid}.jsonl').write_text('ordinary\n')
                # Synthetic S9 fixtures: close each timed anchor explicitly. Tests for
                # missing evidence remove these rows after fixture creation.
                last = max([r['record'] for r in rows] + [0])
                summaries = [dict(record('QueryCommandSummary', last + i + 1, generation=r['generation'],
                                        cmdSummary=[0, 0, 0]), pid=pid, operationSeq=r['operationSeq'])
                             for i, r in enumerate(rows) if r.get('phase') == 'QueryReadFailure' and 'readMs' in r]
                (trace / f'query-{pid}.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in [dict(record(), pid=pid), *rows, *summaries]))
            js = js if js is not None else [self.js()]
            custody = custody if custody is not None else [dict(suite='replaced-nodes', workerRecords=len(js), invalidRecords=0, lineOverflow=False, recordOverflow=False)]
            data = raw if raw is not None else ''.join(validator.JS_PREFIX + json.dumps(row) + '\n' for row in js) + ''.join(validator.CUSTODY_PREFIX + json.dumps(row) + '\n' for row in custody)
            report = json.dumps(report_value if report_value is not None else {'run': {'errors': []}, 'tests': []})
            (run / 'report.json').write_text(report)
            (run / 'closed-js.jsonl').write_text(data)
            proof = dict(schemaVersion=2, run=run.name, captureNonce='a' * 64, reportSHA256=hashlib.sha256(report.encode()).hexdigest(), closedJsSHA256=hashlib.sha256(data.encode()).hexdigest())
            (run / 'custody.json').write_text(json.dumps(proof))
            log = pathlib.Path(temp) / 'test-e2e.log'
            boundary = json.dumps(dict(schemaVersion=1, suite='replaced-nodes', captureNonce=proof['captureNonce']))
            log_rows = ''.join(validator.JS_PREFIX + json.dumps(row) + '\n' for row in (inline or [])) + data
            current_log = ('QUERY_READ_DIAGNOSTIC_BEGIN ' + boundary + '\n' + log_rows
                           + 'QUERY_READ_DIAGNOSTIC_END ' + boundary + '\n'
                           + 'REPLACED_FIELD_CAPTURE_ARCHIVE ' + json.dumps(proof) + '\n')
            log.write_text(current_log if receipt is None else receipt)
            if setup:
                setup(archive, run, trace, log)
            result = subprocess.run([sys.executable, str(SCRIPT), str(len(native)), str(archive), '--field-only', '--field-log', str(log), '--field-source-commit', expected_source], capture_output=True, text=True)
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

    def test_actual_inline_failure_joins_with_zero_worker_records(self):
        result, summary = self.run_field(js=[], inline=[self.js()])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(summary['completeEvidence'])
        self.assertEqual(summary['fieldOnly']['joinedFailures'], 1)

    def test_inline_boundary_missing_replayed_cross_run_and_interleaved_rejected(self):
        def rewrite(fn):
            return lambda archive, run, trace, log: log.write_text(fn(log.read_text()))
        changes = [
            lambda text: '\n'.join(line for line in text.splitlines() if not line.startswith('QUERY_READ_DIAGNOSTIC_BEGIN ')) + '\n',
            lambda text: '\n'.join(line for line in text.splitlines() if not line.startswith('QUERY_READ_DIAGNOSTIC_END ')) + '\n',
            lambda text: text.replace('a' * 64, 'b' * 64, 1),
            lambda text: text.splitlines(keepends=True)[0] + text,
            lambda text: text + text,
            lambda text: validator.JS_PREFIX + json.dumps(self.js()) + '\n' + text,
            lambda text: text + validator.JS_PREFIX + json.dumps(self.js()) + '\n',
            lambda text: text.replace('QUERY_READ_DIAGNOSTIC_END ', 'QUERY_READ_DIAGNOSTIC_BEGIN '),
        ]
        for change in changes:
            with self.subTest(change=change):
                self.rejects(js=[], inline=[self.js()], setup=rewrite(change))

    def test_inline_missing_duplicate_lossy_or_malformed_witness_rejected(self):
        self.rejects(js=[], inline=[])
        self.rejects(js=[], inline=[self.js(), self.js()])
        self.rejects(js=[], inline=[dict(self.js(), query='PRIVATE')])
        self.rejects(js=[], inline=[dict(self.js(), phase='capture-limit-reached', limit=8, laterFailuresOmitted=True)])
        self.rejects(js=[], inline=[dict(self.js(), operationSeq=2)])

    def test_worker_archive_requires_matching_single_current_log_copy(self):
        def missing(archive, run, trace, log):
            log.write_text(''.join(line for line in log.read_text().splitlines(keepends=True)
                                   if not line.startswith(validator.JS_PREFIX)))
        self.rejects(setup=missing)

    def test_owned_capture_and_js_custody_cannot_be_symlinks(self):
        for name in ['report.json', 'closed-js.jsonl', 'custody.json']:
            def setup(archive, run, trace, log):
                original = run / name
                other = run / ('copy-' + name)
                original.rename(other)
                original.symlink_to(other)
            self.rejects(setup=setup)



class NoFailureCaptureTests(unittest.TestCase):
    run_field = FieldJoinTests.run_field
    rejects = FieldJoinTests.rejects
    js = staticmethod(FieldJoinTests.js)
    timed = staticmethod(FieldJoinTests.timed)

    @staticmethod
    def report():
        results = []
        for i, title in enumerate(validator.FIELD_TITLES):
            status = 'failed' if 3 <= i <= 5 else 'passed'
            results.append(dict(file='tests/replaced.e2e.ts', kind='test', titlePath=[title],
                testId='tests/replaced.e2e.ts::' + validator.quote(title, safe=''), targetId='web',
                selected=True, repeat=0, declarationIndex=i, status=status,
                attempts=[dict(index=0, status=status, cleanup='complete', secondaryErrors=[],
                               startedAt='2026-10-30T00:00:00.000Z', durationMs=1)]))
        return dict(schemaVersion='report-1', run=dict(errors=[], results=results, status='failed', exitCode=1,
                    startedAt='2026-10-30T00:00:00.000Z', finishedAt='2026-10-30T00:00:01.000Z',
                    vcs=dict(commit='a' * 40, dirty=False),
                    summary=dict(discovered=8, selected=8, executed=8, passed=5, failed=3, skipped=0, interrupted=0, flaky=0)))

    def test_current_target_pass_all_original_cases_and_empty_failure_stream_accept(self):
        result, summary = self.run_field(js=[], native={41: []}, report_value=self.report())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(summary['completeEvidence'])
        self.assertEqual(len(summary['processes']), 1)
        self.assertEqual(summary['fieldOnly'], dict(targetedFailures=0, joinedFailures=0, joins=[],
                          failureWitnessOutcome='not-applicable-target-passed'))
        self.assertTrue(summary['absenceDoesNotProveSuccess'])

    def test_no_failure_requires_source_bound_original_fixture(self):
        from unittest.mock import patch
        with patch.object(validator, 'FIELD_FIXTURE_SHA256', '0' * 64):
            with self.assertRaisesRegex(ValueError, 'source identity mismatch'):
                validator.require_current_target_pass(self.report(), 'a' * 40)

    def test_missing_filtered_duplicate_and_unexecuted_inventory_rejected(self):
        mutations = [lambda r: r['run']['results'].pop(),
                     lambda r: r['run']['results'].__setitem__(0, r['run']['results'][6]),
                     lambda r: r['run'].__setitem__('errors', ['failed']),
                     lambda r: r.__setitem__('schemaVersion', 'unknown')]
        for key in ('discovered', 'selected', 'executed', 'skipped', 'interrupted', 'flaky'):
            for value in (True, None, 7 if key in ('discovered', 'selected', 'executed') else 1):
                mutations.append(lambda r, k=key, v=value: r['run']['summary'].__setitem__(k, v))
        for change in mutations:
            report = self.report(); change(report)
            self.rejects(js=[], report_value=report)

    def test_unproven_target_pass_and_ambiguous_attempt_rejected(self):
        for update in [dict(status='failed'), dict(status='skipped'), dict(selected=False), dict(repeat=True),
                       dict(file='other.ts'), dict(testId='wrong'), dict(targetId='other'), dict(declarationIndex=True),
                       dict(attempts=[]), dict(error=None), dict(titlePath=['unknown'])]:
            report = self.report(); report['run']['results'][6].update(update)
            self.rejects(js=[], report_value=report)
        for update in [dict(status='failed'), dict(index=True), dict(cleanup='incomplete'),
                       dict(secondaryErrors=['lost']), dict(error=None)]:
            report = self.report(); report['run']['results'][6]['attempts'][0].update(update)
            self.rejects(js=[], report_value=report)
        report = self.report(); report['run']['results'][6]['attempts'] *= 2
        self.rejects(js=[], report_value=report)

    def test_resealed_nonterminal_foreign_source_and_contradictory_report_rejected(self):
        mutations = [
            lambda r: r['run'].update(status='running', finishedAt=None),
            lambda r: [r['run'].pop(k) for k in ('status', 'exitCode', 'finishedAt')],
            lambda r: r['run']['vcs'].update(commit='0' * 40),
            lambda r: r['run'].pop('vcs'),
            lambda r: r['run']['vcs'].update(dirty=True),
            lambda r: r['run']['vcs'].update(dirty=0),
            lambda r: r['run']['vcs'].pop('dirty'),
            lambda r: r['run']['summary'].update(passed=0, failed=8),
            lambda r: r['run']['summary'].update(passed=True),
            lambda r: r['run'].update(status='passed', exitCode=0),
            lambda r: r['run'].update(exitCode=True),
            lambda r: r['run'].update(finishedAt='2026-10-29T23:59:59.000Z'),
            lambda r: r['run'].update(startedAt='bad'),
            lambda r: r['run']['results'][6]['attempts'][0].update(startedAt='2026-10-30T00:00:02.000Z'),
            lambda r: r['run']['results'][6]['attempts'][0].update(durationMs=1001),
            lambda r: r['run']['results'][6]['attempts'][0].update(durationMs=True),
        ]
        for change in mutations:
            report = self.report(); change(report)
            # run_field hashes/reseals each mutated report into current custody.
            self.rejects(js=[], report_value=report)
        for expected in ('', 'invalid', 'b' * 40):
            self.rejects(js=[], report_value=self.report(), expected_source=expected)

    def test_clean_pass_does_not_bypass_capture_missing_empty_or_loss(self):
        self.rejects(js=[], report_value=self.report(), native={})
        for change in [lambda a,r,t,l: (t/'query-41.jsonl').write_text(''),
                       lambda a,r,t,l: (t/'query-41.jsonl').unlink(),
                       lambda a,r,t,l: (t/'native-41.jsonl').unlink(),
                       lambda a,r,t,l: (r/'closed-js.jsonl').write_text(''),
                       lambda a,r,t,l: (r/'report.json').write_text('{}'),
                       lambda a,r,t,l: l.write_text(l.read_text().replace('a' * 64, 'b' * 64, 1))]:
            self.rejects(js=[], report_value=self.report(), setup=change)
        for update in [dict(droppedBefore=1), dict(suppressedBefore=1), dict(overflow=True)]:
            self.rejects(js=[], report_value=self.report(), native={41: [dict(self.timed(), **update)]})

    def test_clean_pass_never_exempts_observed_failure_join(self):
        self.rejects(js=[self.js()], report_value=self.report(), native={41: []})
        self.rejects(js=[self.js()], report_value=self.report(), native={41: [self.timed(), dict(self.timed(), record=2)]})
        result, summary = self.run_field(report_value=self.report())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(summary['fieldOnly']['joinedFailures'], 1)
        self.assertEqual(summary['fieldOnly']['failureWitnessOutcome'], 'observed')


class CommandTimingTests(unittest.TestCase):
    run_capture = QueryValidatorTests.run_capture

    @staticmethod
    def bundle(count=1, seen=None, flags=0):
        rows = [record(), dict(failure(readMs=[0] * 13), operationSeq=7)]
        for ordinal in range(count):
            rows.append(record('QueryCommandTiming', ordinal + 2, generation=1, operationSeq=7,
                               queryReadStage='fresh-sample', cmd=[ordinal, 6, 1], cmdMs=[1, 2, 3, 4, 5]))
        rows.append(record('QueryCommandSummary', count + 2, generation=1, operationSeq=7,
                           cmdSummary=[count if seen is None else seen, count, flags]))
        return rows

    def rejected(self, rows=None, raw=None):
        result, summary = self.run_capture(rows, raw=raw)
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertFalse(summary['completeEvidence'])
        self.assertTrue(summary['errors'])
        return summary

    def test_all_closed_method_and_terminal_outcome_codes_and_stage_values(self):
        for method in range(8):
            for outcome in range(1, 7):
                rows = self.bundle(); rows[2]['cmd'] = [0, method, outcome]
                result, summary = self.run_capture(rows)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(summary['completeEvidence'])
                self.assertTrue(summary['processes'][0]['commandTiming']['complete'])
        for stage in validator.READ_STAGES:
            row = self.bundle()[2]; row['queryReadStage'] = stage
            self.assertTrue(validator.schema_valid(row))

    def test_zero_and_exactly_24_commands_are_complete_bounded_captures(self):
        for count in (0, 1, 24):
            result, summary = self.run_capture(self.bundle(count))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(summary['completeEvidence'])
            capture = summary['processes'][0]['commandTiming']
            self.assertEqual((capture['requiredFailures'], capture['completeFailures'], capture['capturedCommands']), (1, 1, count))
            self.assertEqual(capture['bundles'][0]['captured'], count)
        rows = self.bundle(); rows[2]['cmdMs'] = [65535] * 5
        result, summary = self.run_capture(rows)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(summary['completeEvidence'])  # Exactly representable, not inferred saturation.

    def test_terminal_deadline_or_drop_is_complete_but_active_row_is_not(self):
        for outcome in (5, 6):
            rows = self.bundle(); rows[2]['cmd'][2] = outcome
            result, summary = self.run_capture(rows)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(summary['completeEvidence'])
            self.assertEqual(summary['processes'][0]['commandTiming']['bundles'][0]['commands'][0]['cmdMs'], [1, 2, 3, 4, 5])
        rows = self.bundle(flags=4); rows[2]['cmd'][2] = 0
        self.rejected(rows)

    def test_every_flag_and_unfinished_outcome_are_incomplete(self):
        for flags in range(1, 16):
            self.rejected(self.bundle(flags=flags))
        rows = self.bundle(); rows[2]['cmd'][2] = 0
        self.rejected(rows)
        rows[-1]['cmdSummary'][2] = 4
        self.rejected(rows)
        self.rejected(self.bundle(24, seen=25, flags=1))
        self.rejected(self.bundle(24, seen=65535, flags=1))

    def test_closed_arrays_types_enums_and_private_fields_rejected(self):
        good = self.bundle()[2]
        for key, values in [('cmd', [[], [0, 1], [0, 1, 1, 1], [24, 1, 1], [0, 8, 1], [0, 1, 7],
                                     [True, 1, 1], [0, False, 1], [0, 1, True], [-1, 1, 1], [0, 1.0, 1], 'PRIVATE']),
                            ('cmdMs', [[], [0] * 4, [0] * 6, [65536] * 5, [-1] * 5, [True] * 5, [0.5] * 5, 'PRIVATE']),
                            ('queryReadStage', ['PRIVATE', [], None])]:
            for value in values:
                row = dict(good); row[key] = value
                self.assertFalse(validator.schema_valid(row), (key, value))
        for key in ('url', 'args', 'selector', 'targetId', 'sessionId', 'method', 'errorMessage'):
            self.assertFalse(validator.schema_valid(dict(good, **{key: 'PRIVATE'})))
        for key in ('cmd', 'cmdMs', 'queryReadStage', 'generation'):
            row = dict(good); del row[key]
            self.assertFalse(validator.schema_valid(row))
        summary = self.bundle()[-1]
        for value in ([], [1, 1], [1, 1, 0, 0], [65536, 1, 0], [1, 25, 0], [1, 1, 16],
                      [True, 1, 0], [1, True, 0], [1, 1, False], [-1, 1, 0], [1, 1, 0.0], 'PRIVATE'):
            self.assertFalse(validator.schema_valid(dict(summary, cmdSummary=value)))
        self.assertFalse(validator.schema_valid(dict(summary, queryReadStage='fresh-sample')))
        self.assertFalse(validator.schema_valid(dict(summary, payload='PRIVATE')))

    def test_missing_failure_rows_summary_and_old_timed_only_are_rejected(self):
        rows = self.bundle()
        for index in (1, 2, 3):
            self.rejected([row for i, row in enumerate(rows) if i != index])
        self.rejected(rows[:2])  # No legacy loose fallback in S9.
        rows = self.bundle(0); rows.pop(1)
        self.rejected(rows)
        result, summary = self.run_capture([record(), failure()])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(summary['completeEvidence'])  # Untimed non-field compatibility.

    def test_duplicate_or_discontinuous_ordinals_counts_and_anchor_rejected(self):
        for change in [lambda r: r[3]['cmd'].__setitem__(0, 0),
                       lambda r: r[3]['cmd'].__setitem__(0, 2),
                       lambda r: r[-1]['cmdSummary'].__setitem__(0, 1),
                       lambda r: r[-1]['cmdSummary'].__setitem__(0, 3),
                       lambda r: r[-1]['cmdSummary'].__setitem__(1, 1)]:
            rows = self.bundle(2); change(rows); self.rejected(rows)
        rows = self.bundle(); rows.append(dict(rows[-1], record=20)); self.rejected(rows)
        rows = self.bundle(); rows.append(dict(rows[1], record=20)); self.rejected(rows)
        rows = self.bundle(); rows.append(dict(failure(), record=20, operationSeq=7)); self.rejected(rows)

    def test_record_order_cross_operation_generation_pid_and_foreign_file_rejected(self):
        for index, key, value in [(2, 'record', 0), (3, 'record', 1),
                                  (2, 'operationSeq', 8), (3, 'operationSeq', 8),
                                  (2, 'generation', 2), (3, 'generation', 2),
                                  (2, 'pid', 42), (3, 'pid', 42)]:
            rows = self.bundle(); rows[index][key] = value; self.rejected(rows)
        rows = self.bundle(2); rows[2]['record'], rows[3]['record'] = rows[3]['record'], rows[2]['record']
        self.rejected(rows)
        errors = []
        validator.command_bundles(self.bundle()[:2], 'query-41.jsonl', errors)
        validator.command_bundles(self.bundle()[2:], 'query-42.jsonl', errors)
        self.assertTrue(errors)  # Same coordinates in another file never supply missing custody.

    def test_physical_line_order_is_not_repaired_by_ordinal_or_record_sort(self):
        from itertools import permutations
        rows = self.bundle(2)
        # Includes the reviewer's exact false-greens: summary before failure,
        # command before failure, and reversed commands with unchanged record IDs.
        for order in permutations(range(1, 5)):
            if order == (1, 2, 3, 4):
                continue
            with self.subTest(order=order):
                summary = self.rejected([rows[0], *(rows[i] for i in order)])
                self.assertTrue(any('physical line order' in e or 'command ordinals' in e
                                    for e in summary['errors']))
        rows = self.bundle(0)
        self.rejected([rows[0], rows[2], rows[1]])  # Zero commands still requires failure first.

    def test_interleaving_distinct_operations_retains_each_continuous_bundle(self):
        first = self.bundle()
        second = [dict(r, operationSeq=8, record=r['record'] + 10) for r in self.bundle()[1:]]
        rows = [first[0], first[1], second[0], first[2], second[1], first[3], second[2]]
        result, summary = self.run_capture(rows)
        self.assertEqual(result.returncode, 0, result.stderr)
        capture = summary['processes'][0]['commandTiming']
        self.assertTrue(capture['complete'])
        self.assertEqual(capture['completeFailures'], 2)

    def test_existing_native_loss_and_capture_limit_remain_incomplete(self):
        for change in [dict(droppedBefore=1), dict(suppressedBefore=1), dict(overflow=True)]:
            rows = self.bundle(); rows[2].update(change)
            result, summary = self.run_capture(rows)
            self.assertFalse(summary['completeEvidence'])
        rows = self.bundle(); rows.append(record('CaptureLimitReached', 30))
        result, summary = self.run_capture(rows)
        self.assertFalse(summary['completeEvidence'])

    def test_maximum_closed_command_and_summary_rows_stay_within_512_bytes(self):
        safe = validator.SAFE_INTEGER
        for row in self.bundle()[2:]:
            row.update(pid=(1 << 32) - 1, record=safe, operationSeq=safe, generation=safe,
                       droppedBefore=safe, emittedBefore=safe, suppressedBefore=safe, overflow=False)
            if row['phase'] == 'QueryCommandTiming':
                row.update(queryReadStage=max(validator.READ_STAGES, key=len), cmd=[23, 7, 6], cmdMs=[65535] * 5)
            else:
                row['cmdSummary'] = [65535, 24, 15]
            self.assertTrue(validator.schema_valid(row))
            self.assertLessEqual(len(json.dumps(row, separators=(',', ':')).encode()) + 1, 512)
        self.assertEqual((validator.COMMAND_BUDGET, validator.RECORD_BUDGET, validator.BYTE_BUDGET), (24, 128, 65536))

    def test_command_128_record_64kib_512byte_and_duplicate_key_limits_preserved(self):
        rows = self.bundle()
        line = json.dumps(rows[2], separators=(',', ':'))
        raw = ''.join(json.dumps(r) + '\n' for r in rows[:2]).encode()
        suffix = (json.dumps(rows[3]) + '\n').encode()
        result, summary = self.run_capture(raw=raw + line.encode() + b' ' * (512 - len(line) - 1) + b'\n' + suffix)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(summary['completeEvidence'])
        self.rejected(raw=raw + line.encode() + b' ' * (513 - len(line) - 1) + b'\n' + suffix)
        self.rejected(raw=raw + line.replace('"cmd":', '"cmd":[0,6,1],"cmd":').encode() + b'\n' + suffix)
        self.rejected(raw=raw + line.encode() + suffix)  # Missing newline.
        self.rejected(rows + [dict(failure(i), operationSeq=1000+i) for i in range(4, 130)])

    def test_no_target_pass_cannot_bypass_missing_command_detail(self):
        def remove_summary(a, r, trace, log):
            p = trace/'query-41.jsonl'
            p.write_text(''.join(line for line in p.read_text().splitlines(keepends=True)
                                 if json.loads(line)['phase'] != 'QueryCommandSummary'))
        helper = NoFailureCaptureTests()
        result, summary = helper.run_field(js=[], report_value=helper.report(), setup=remove_summary)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(summary['completeEvidence'])
        self.assertTrue(any('command summary' in e for e in summary['errors']))

if __name__ == '__main__':
    unittest.main()
