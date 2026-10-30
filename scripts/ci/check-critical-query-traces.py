"""Validate bounded, payload-free native query diagnostic captures (schema 2)."""
import argparse
import datetime
import hashlib
import json
import pathlib
import re
import stat
import sys
from urllib.parse import quote

SAFE_INTEGER = (1 << 53) - 1
BYTE_BUDGET = 64 * 1024
RECORD_BUDGET = 128
BASE_KEYS = {
    'schemaVersion', 'source', 'pid', 'record', 'operationSeq', 'phase',
    'droppedBefore', 'emittedBefore', 'suppressedBefore', 'overflow',
}
SCOPE_STAGES = set('warm-worlds initial-frames initial-frames-entry initial-frames-exit protected-frames final-frames classification acquire recheck barrier-acquire barrier-check publication'.split())
SCOPE_REASONS = set('owner-health owner-identity index-health pending-classification subscription-changed watermark-pending attribution-changed attribution-invalid registry-health creation-debt unclaimed-auxiliary guard-mismatch already-protected selected-not-ready foreign-owner unclassified-purpose unknown-lineage related-not-ready unretained-unrelated target-set-changed original-budget selected-target-missing dependency-revision-changed dependency-set-changed dependency-identity-changed target-revision-changed unknown-revision-changed target-count-changed target-identity-changed target-lineage-changed enrollment-target-set-changed'.split())
READ_STAGES = set('fresh-fields frame-entry ax dom candidate-plan candidate-plan-roots candidate-plan-dom-backend candidate-plan-attributes candidate-plan-duplicate-dom candidate-plan-ax-rows candidate-plan-ax-decode candidate-plan-duplicate-ax candidate-plan-author-ids candidate-plan-missing-record candidate-plan-ax-child candidate-plan-dom-object candidate-plan-fallback security metadata query-world query-resolve query-match candidate-confirm security-confirm metadata-confirm projection cleanup frame-final lease-final'.split())
READ_STAGES.update('read-admission read-ui read-frames-before fresh-inventory fresh-world fresh-resolve fresh-sample fresh-cleanup fresh-roots-final read-frames-after read-publish'.split())
PROTOCOL_ERRORS = set('frame-not-found frame-ambiguous invalid-frame unsupported-protocol unsupported-capability stale-generation scope-unavailable sequence-reused invalid-sequence invalid-timeout capacity-exceeded operation-missing content-length-mismatch redirect-body-unavailable unsupported-command deadline-exceeded cancelled invalid-arguments invalid-locator browser-failure stale-scope cleanup-failed stale-reference policy-denied not-actionable intercepted-pointer checked-state-unchanged checked-control-replaced fill-unsupported-target no-editable-focus tap-target-replaced-before-press locator-not-found decision-missing decision-expired decision-kind-mismatch registry-missing registry-in-use identifier-exhausted'.split())
READ_ERRORS = set('invalid-arguments invalid-locator frame-not-found frame-ambiguous unsupported-capability stale-reference superseded cancelled deadline-exceeded backend-failure policy-denied resource-limit cleanup-failed'.split())


def uint(value, maximum=SAFE_INTEGER):
    # bool is a Python int subclass; accepting it would corrupt loss evidence.
    return type(value) is int and 0 <= value <= maximum


def eval_valid(value):
    if not isinstance(value, dict) or set(value) != {'s', 'c', 'h', 'p', 't', 'r', 'w', 'v', 'e'}:
        return False
    if type(value['s']) is not str or value['s'] not in ('entry', 'wait', 'capture'):
        return False
    if type(value['c']) is not str or value['c'] not in ('entry', 'fence', 'pending', 'unresumed', 'retire', 'health', 'guard', 'p-empty', 'p-front', 'p-cap', 'p-rootent', 'p-rootid', 'p-active', 'p-roottgt', 'p-rootfrm', 'p-mement', 'p-memkind', 'p-memfrm', 'p-missing', 'p-owner', 'p-origin', 'p-binding', 'p-target', 'p-health', 'p-config', 'p-term', 'p-stage', 'p-custody', 'p-ready', 'p-confrev', 'p-fence', 'p-op', 'p-entryid', 'p-permit', 'p-ledger', 'p-eowner', 'p-stream', 'p-etarget', 'p-failed', 'p-index', 'p-snap'):
        return False
    if type(value['w']) is not str or value['w'] not in ('equal', 'behind', 'ahead', 'unk'):
        return False
    for key, size in (('p', 8), ('t', 3), ('r', 4)):
        item = value[key]
        if item is not None and (type(item) is not list or len(item) != size or
                not all(type(x) is bool if key == 'r' else uint(x, 65535) for x in item)):
            return False
    health = value['h']
    if health is not None and (type(health) is not list or len(health) != 3 or
            not uint(health[0], 65535) or not uint(health[1], 65535) or not uint(health[2], 7)):
        return False
    return all(value[key] is None or uint(value[key]) for key in ('v', 'e'))


def schema_valid(record):
    if not isinstance(record, dict):
        return False
    phase = record.get('phase')
    extra = set()
    if phase == 'QueryScopeRefusal':
        extra = {'generation', 'queryScopeStage', 'queryScopeReason'}
        if record.get('queryScopeStage') not in SCOPE_STAGES or record.get('queryScopeReason') not in SCOPE_REASONS:
            return False
    elif phase == 'QueryReadFailure':
        extra = {'generation', 'queryReadStage'}
        if record.get('queryReadStage') not in READ_STAGES:
            return False
        if 'queryReadError' in record:
            extra.add('queryReadError')
            if record['queryReadError'] not in READ_ERRORS:
                return False
        elif 'error' in record and 'readMs' in record:
            extra.add('error')
            if record['error'] not in PROTOCOL_ERRORS:
                return False
        else:
            return False
        if 'readMs' in record:
            extra.add('readMs')
            timing = record['readMs']
            if type(timing) is not list or len(timing) != 13 or not all(uint(value, 65535) for value in timing):
                return False
    elif phase == 'EvalAdmission':
        extra = {'generation', 'eval'}
        if not eval_valid(record.get('eval')):
            return False
    elif phase not in ('CaptureStarted', 'CaptureLimitReached'):
        return False
    if set(record) != BASE_KEYS | extra:
        return False
    if type(record['schemaVersion']) is not int or record['schemaVersion'] != 2 or record['source'] != 'native':
        return False
    if not uint(record['pid'], (1 << 32) - 1) or type(record['overflow']) is not bool:
        return False
    if not all(uint(record[key]) for key in ('record', 'operationSeq', 'droppedBefore', 'emittedBefore', 'suppressedBefore')):
        return False
    return not extra or uint(record['generation'])


def unique_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate field")
        value[key] = item
    return value


def regular(path):
    return not path.is_symlink() and stat.S_ISREG(path.lstat().st_mode)


JS_PREFIX = 'QUERY_READ_RESULT_DIAGNOSTIC '
CUSTODY_PREFIX = 'QUERY_READ_DIAGNOSTIC_CUSTODY '
JS_KEYS = set('phase suite generation operationSeq command transmittedTimeoutMs selectedLocalCancel rawCode rawEffects rawScopeState returnedCode timeoutRewritten cancelAckSeen'.split())
CUSTODY_KEYS = set('suite workerRecords invalidRecords lineOverflow recordOverflow'.split())


def js_valid(row):
    if not isinstance(row, dict):
        return False
    limit = row.get('phase') == 'capture-limit-reached'
    if set(row) != JS_KEYS | ({'limit', 'laterFailuresOmitted'} if limit else set()):
        return False
    enums = {
        'phase': ('settled-failure', 'capture-limit-reached'), 'suite': ('replaced-nodes',),
        'command': ('fixture.read-fields', 'fixture.query', 'browser.query'),
        'selectedLocalCancel': ('none', 'abort', 'deadline'),
        'rawEffects': ('not-dispatched', 'completed', 'unknown'),
        'rawScopeState': ('usable', 'quarantined', 'closed'),
        'rawCode': PROTOCOL_ERRORS, 'returnedCode': PROTOCOL_ERRORS,
    }
    if any(type(row[key]) is not str or row[key] not in choices for key, choices in enums.items()):
        return False
    return (all(uint(row[key]) and row[key] > 0 for key in ('generation', 'operationSeq'))
            and uint(row['transmittedTimeoutMs'], 3_600_000) and row['transmittedTimeoutMs'] > 0
            and all(type(row[key]) is bool for key in ('timeoutRewritten', 'cancelAckSeen'))
            and (not limit or (type(row['limit']) is int and row['limit'] == 8 and row['laterFailuresOmitted'] is True)))


def read_regular(path, maximum):
    if not regular(path):
        raise ValueError('not regular')
    with path.open('rb') as stream:
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError('byte bound exceeded')
    return data


# Exact original eight-case fixture at consumer c46de845; changes require review.
FIELD_FIXTURE_SHA256 = 'cb4946cff31e9ea1d78b389666f4ae4b19efa8c93c967c48e9266be6fe069ba3'
FIELD_FIXTURE = pathlib.Path(__file__).resolve().parents[2] / 'packages/e2e/tests/integration/web-replaced-nodes.test.ts'
FIELD_TITLES = (
    'a field replaced every frame never reads as hidden',
    'a field replaced every frame never reads as hidden on a starved runner',
    'a stable field beside one replaced every frame reads as shown',
    'toBeHidden fails on a field replaced every frame: testId',
    'toBeHidden fails on a field replaced every frame: label',
    'toBeHidden fails on a field replaced every frame: displayValue',
    'a stable field among fields replaced every frame resolves promptly',
    'a field removed while it is being replaced reads as hidden',
)


def report_timestamp(value):
    if type(value) is not str or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.]\d{1,6})?Z', value):
        raise ValueError('original field report timestamp missing or invalid')
    return datetime.datetime.fromisoformat(value.removesuffix('Z') + '+00:00')


def require_current_target_pass(report, expected_source):
    """No failure witness is applicable only for this executed, unfiltered case."""
    if hashlib.sha256(read_regular(FIELD_FIXTURE, 16384)).hexdigest() != FIELD_FIXTURE_SHA256:
        raise ValueError('original field fixture source identity mismatch')
    run = report.get('run')
    if report.get('schemaVersion') != 'report-1' or not isinstance(run, dict) or run.get('errors') != []:
        raise ValueError('missing targeted settled field failure: original run not complete')
    if (type(expected_source) is not str or not re.fullmatch('[0-9a-f]{40}', expected_source)
            or not isinstance(run.get('vcs'), dict) or run['vcs'].get('commit') != expected_source
            or run['vcs'].get('dirty') is not False):
        raise ValueError('original field report does not match independent current source')
    started = report_timestamp(run.get('startedAt'))
    finished = report_timestamp(run.get('finishedAt'))
    if finished < started or run.get('status') not in ('passed', 'failed'):
        raise ValueError('original field run is not terminal')
    totals = run.get('summary')
    results = run.get('results')
    if (not isinstance(totals, dict) or not isinstance(results, list) or len(results) != len(FIELD_TITLES)
            or any(type(totals.get(k)) is not int or totals[k] != len(FIELD_TITLES)
                   for k in ('discovered', 'selected', 'executed'))
            or any(type(totals.get(k)) is not int or totals[k] != 0 for k in ('skipped', 'interrupted', 'flaky'))):
        raise ValueError('missing targeted settled field failure: original inventory incomplete or filtered')
    by_title = {}
    for result in results:
        if not isinstance(result, dict) or not isinstance(result.get('titlePath'), list) or len(result['titlePath']) != 1:
            raise ValueError('invalid original field result identity')
        title = result['titlePath'][0]
        if type(title) is not str or title not in FIELD_TITLES or title in by_title:
            raise ValueError('ambiguous or unexpected original field result')
        if (result.get('file') != 'tests/replaced.e2e.ts' or result.get('kind') != 'test'
                or result.get('testId') != 'tests/replaced.e2e.ts::' + quote(title, safe='')
                or result.get('targetId') != 'web' or result.get('selected') is not True
                or type(result.get('repeat')) is not int or result['repeat'] != 0
                or type(result.get('declarationIndex')) is not int or result['declarationIndex'] != FIELD_TITLES.index(title)
                or result.get('status') not in ('passed', 'failed')):
            raise ValueError('original field result not selected/executed exactly once')
        attempts = result.get('attempts')
        if (not isinstance(attempts, list) or len(attempts) != 1 or not isinstance(attempts[0], dict)
                or type(attempts[0].get('index')) is not int or attempts[0]['index'] != 0
                or attempts[0].get('status') != result['status'] or attempts[0].get('cleanup') != 'complete'
                or attempts[0].get('secondaryErrors') != []):
            raise ValueError('original field attempt incomplete or ambiguous')
        attempt = attempts[0]
        attempt_start = report_timestamp(attempt.get('startedAt'))
        duration = attempt.get('durationMs')
        if (not uint(duration) or attempt_start < started or attempt_start > finished
                or datetime.timedelta(milliseconds=duration) > finished - attempt_start):
            raise ValueError('original field attempt lies outside completed run')
        by_title[title] = result
    passed = sum(result['status'] == 'passed' for result in results)
    failed = len(results) - passed
    if (type(totals.get('passed')) is not int or totals['passed'] != passed
            or type(totals.get('failed')) is not int or totals['failed'] != failed
            or run['status'] != ('failed' if failed else 'passed')
            or type(run.get('exitCode')) is not int or run['exitCode'] != (1 if failed else 0)):
        raise ValueError('original field run terminal status/counts contradict results')
    target = by_title[FIELD_TITLES[6]]
    if target['status'] != 'passed' or 'error' in target or 'error' in target['attempts'][0]:
        raise ValueError('missing targeted settled field failure')


def field_inputs(archive, log, errors, expected_source=None):
    """Accept exactly one fresh fixture-owned run, never select an old sibling."""
    summary = {'targetedFailures': 0, 'joinedFailures': 0, 'joins': []}
    try:
        if archive.is_symlink() or not archive.is_dir():
            raise ValueError('archive is not an owned directory')
        runs = [p for p in archive.iterdir() if p.name != 'query-capture-validation.json']
        if len(runs) != 1 or not runs[0].name.startswith('run-') or runs[0].is_symlink() or not runs[0].is_dir():
            raise ValueError('expected exactly one run-owned directory; stale/ambiguous siblings rejected')
        run = runs[0]
        if {p.name for p in run.iterdir()} != {'report.json', 'closed-js.jsonl', 'custody.json', 'native-trace'}:
            raise ValueError('missing or unexpected run-owned inputs')
        trace = run / 'native-trace'
        if trace.is_symlink() or not trace.is_dir():
            raise ValueError('native trace is not an owned directory')
        if any(not re.fullmatch(r'(native|query)-[0-9]+\.jsonl', p.name) for p in trace.iterdir()):
            raise ValueError('unexpected native trace input')
        custody = json.loads(read_regular(run / 'custody.json', 512), object_pairs_hook=unique_pairs)
        if (not isinstance(custody, dict) or set(custody) != {'schemaVersion', 'run', 'captureNonce', 'reportSHA256', 'closedJsSHA256'}
                or type(custody['schemaVersion']) is not int or custody['schemaVersion'] != 2
                or type(custody['captureNonce']) is not str or not re.fullmatch('[0-9a-f]{64}', custody['captureNonce'])
                or custody['run'] != run.name):
            raise ValueError('invalid archive custody')
        if log is None:
            raise ValueError('current harness log required for archive custody')
        receipts = []
        log_failures, log_custodies = [], []
        boundary = {'schemaVersion': 1, 'suite': 'replaced-nodes', 'captureNonce': custody['captureNonce']}
        active = False
        began = ended = 0
        # Scan bounded lines without retaining or echoing unrelated/raw test output.
        if not regular(log):
            raise ValueError('harness log not regular')
        with log.open('rb') as stream:
            while line := stream.readline(1_048_577):
                if len(line) > 1_048_576:
                    raise ValueError('harness log line bound exceeded')
                for prefix, is_begin in [(b'QUERY_READ_DIAGNOSTIC_BEGIN ', True), (b'QUERY_READ_DIAGNOSTIC_END ', False)]:
                    if line.startswith(prefix):
                        if len(line) > 256 or not line.endswith(b'\n'):
                            raise ValueError('invalid inline capture boundary')
                        marker = json.loads(line[len(prefix):], object_pairs_hook=unique_pairs)
                        if marker != boundary or type(marker.get('schemaVersion')) is not int:
                            raise ValueError('cross-run or malformed inline capture boundary')
                        if is_begin:
                            if active or began or ended:
                                raise ValueError('duplicate or interleaved inline capture BEGIN')
                            active = True; began += 1
                        else:
                            if not active or ended:
                                raise ValueError('missing or duplicate inline capture END')
                            active = False; ended += 1
                for prefix, terminal in [(JS_PREFIX.encode(), False), (CUSTODY_PREFIX.encode(), True)]:
                    if not line.startswith(prefix):
                        continue
                    if len(line) > 2048 or not line.endswith(b'\n'):
                        raise ValueError('inline closed JS line bound/termination invalid')
                    row = json.loads(line[len(prefix):], object_pairs_hook=unique_pairs)
                    if not isinstance(row, dict):
                        raise ValueError('invalid inline closed JS record')
                    if row.get('suite') != 'replaced-nodes':
                        continue
                    if not active:
                        raise ValueError('target JS record outside its current capture boundary')
                    if terminal:
                        log_custodies.append(row)
                        if len(log_custodies) > 1:
                            raise ValueError('duplicate inline terminal custody')
                    else:
                        if log_custodies or not js_valid(row) or row['phase'] != 'settled-failure':
                            raise ValueError('invalid, lossy, or post-terminal inline JS failure')
                        log_failures.append(row)
                        if len(log_failures) > 64:
                            raise ValueError('inline closed JS record bound exceeded')
                if b'REPLACED_FIELD_CAPTURE_CUSTODY_FAILED' in line:
                    raise ValueError('archive custody failure marker')
                if line.startswith(b'REPLACED_FIELD_CAPTURE_ARCHIVE '):
                    if len(line) > 512 or not line.endswith(b'\n'):
                        raise ValueError('invalid archive custody receipt')
                    receipts.append(json.loads(line[len(b'REPLACED_FIELD_CAPTURE_ARCHIVE '):], object_pairs_hook=unique_pairs))
                    if len(receipts) > 1:
                        raise ValueError('duplicate archive custody receipt')
        if began != 1 or ended != 1 or active:
            raise ValueError('missing inline capture boundary')
        if receipts != [custody]:
            raise ValueError('missing or mismatched current archive custody receipt')
        report = read_regular(run / 'report.json', 64 * 1024 * 1024)
        report_value = json.loads(report, object_pairs_hook=unique_pairs)
        if not isinstance(report_value, dict) or not isinstance(report_value.get('run'), dict):
            raise ValueError('missing original report')
        data = read_regular(run / 'closed-js.jsonl', 65 * 2048)
        if custody['reportSHA256'] != hashlib.sha256(report).hexdigest() or custody['closedJsSHA256'] != hashlib.sha256(data).hexdigest():
            raise ValueError('archive custody digest mismatch')
        failures, custodies = [], []
        lines = data.splitlines(keepends=True)
        if len(lines) > 65:
            raise ValueError('closed JS record bound exceeded')
        for line in lines:
            if len(line) > 2048 or not line.endswith(b'\n'):
                raise ValueError('closed JS line bound/termination invalid')
            text = line.decode('utf-8')
            if text.startswith(JS_PREFIX):
                if custodies:
                    raise ValueError('JS failure after terminal custody')
                row = json.loads(text[len(JS_PREFIX):], object_pairs_hook=unique_pairs)
                if not js_valid(row):
                    raise ValueError('invalid closed JS failure')
                if row['phase'] != 'settled-failure':
                    raise ValueError('JS capture limit/later failures omitted')
                failures.append(row)
            elif text.startswith(CUSTODY_PREFIX):
                row = json.loads(text[len(CUSTODY_PREFIX):], object_pairs_hook=unique_pairs)
                if (not isinstance(row, dict) or set(row) != CUSTODY_KEYS or row.get('suite') != 'replaced-nodes'
                        or not uint(row['workerRecords'], 64) or not uint(row['invalidRecords'], 65)
                        or type(row['lineOverflow']) is not bool or type(row['recordOverflow']) is not bool):
                    raise ValueError('invalid JS custody')
                custodies.append(row)
            else:
                raise ValueError('unexpected closed JS line')
        if len(custodies) != 1:
            raise ValueError('missing or duplicate JS custody')
        custody = custodies[0]
        if custody['workerRecords'] != len(failures) or custody['invalidRecords'] or custody['lineOverflow'] or custody['recordOverflow']:
            raise ValueError('JS custody loss/count mismatch')
        if log_custodies != [custody]:
            raise ValueError('current inline/worker terminal custody mismatch')
        # Archived worker records must occur exactly once in the current bounded
        # log. Direct inline rows may legitimately have workerRecords == 0.
        for row in failures:
            if log_failures.count(row) != 1:
                raise ValueError('missing or duplicate current worker failure')
        if len({(r['generation'], r['operationSeq']) for r in log_failures}) != len(log_failures):
            raise ValueError('duplicate current JS operation')
        targets = [row for row in log_failures if row['command'] == 'fixture.read-fields']
        summary['targetedFailures'] = len(targets)
        if not targets:
            if log_failures:
                raise ValueError('missing targeted settled field failure')
            require_current_target_pass(report_value, expected_source)
            summary['failureWitnessOutcome'] = 'not-applicable-target-passed'
        else:
            summary['failureWitnessOutcome'] = 'observed'
        if len({(r['generation'], r['operationSeq']) for r in targets}) != len(targets):
            raise ValueError('duplicate targeted JS operation')
        return trace, targets, summary
    except (OSError, ValueError, TypeError) as exc:
        errors.append('field capture: ' + (str(exc) if type(exc) is ValueError else 'malformed or unreadable owned input'))
        return archive / 'missing-native-trace', [], summary


def join_fields(targets, native_index, summary, errors):
    for target in targets:
        key = (target['generation'], target['operationSeq'])
        matches = native_index.get(key, [])
        # Index ALL owned QueryReadFailure rows first: one timed plus one untimed
        # collision is still ambiguous. Neither PID order nor error equality joins.
        if len(matches) != 1 or 'readMs' not in matches[0][1]:
            errors.append(f'field operation {key}: expected one unique timed native failure, got {len(matches)} matches')
            continue
        file, row = matches[0]
        summary['joins'].append({'generation': key[0], 'operationSeq': key[1], 'nativeFile': file,
                                 'nativePid': row['pid'], 'nativeRecord': row['record'],
                                 'stage': row['queryReadStage'], 'readMs': row['readMs']})
        summary['joinedFailures'] += 1

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('expected', type=int)
    parser.add_argument('root', nargs='?', default='evidence/native-trace')
    parser.add_argument('--field-only', action='store_true', help='root is the archived .e2e/replaced-nodes directory')
    parser.add_argument('--field-log', type=pathlib.Path, help='current archived test-e2e.log, required with --field-only')
    parser.add_argument('--field-source-commit', help='independent current evidence/source.commit; required to accept no target failure')
    args = parser.parse_args()
    root, expected = pathlib.Path(args.root), args.expected
    errors, targets, field_summary = [], [], None
    output_root = root
    if args.field_only:
        if expected < 1:
            errors.append('field capture: positive expected process count required')
        root, targets, field_summary = field_inputs(root, args.field_log, errors, args.field_source_commit)
    native_index = {}
    ordinary = sorted(root.glob('native-*.jsonl'))
    files = sorted(root.glob('query-*.jsonl'))
    rows = []
    if len(files) != expected:
        errors.append(f'Expected {expected} critical process captures, got {len(files)}')
    if {p.stem.removeprefix('query-') for p in files} != {p.stem.removeprefix('native-') for p in ordinary}:
        errors.append('Critical and ordinary process file sets differ')
    for p in files:
        companion = p.with_name(p.name.replace('query-', 'native-', 1))
        if not regular(p):
            errors.append(p.name + ': not regular')
            continue
        if companion.exists() or companion.is_symlink():
            if not regular(companion):
                errors.append(p.name + ': ordinary sink not regular')
            if companion.exists() and p.samefile(companion):
                errors.append(p.name + ': aliases ordinary sink')
        byte_count = p.stat().st_size
        with p.open('rb') as stream:
            data = stream.read(BYTE_BUDGET + 1)
        records, invalid, line_count = [], 0, 0
        for line in data.splitlines(keepends=True):
            line_count += 1
            try:
                record = json.loads(line, object_pairs_hook=unique_pairs)
                if not line.endswith(b'\n') or len(line) > 512 or not schema_valid(record):
                    invalid += 1
                    continue
                records.append(record)
                if record['phase'] == 'QueryReadFailure':
                    native_index.setdefault((record['generation'], record['operationSeq']), []).append((p.name, record))
            except (ValueError, TypeError):
                invalid += 1
        started = sum(x['phase'] == 'CaptureStarted' for x in records) == 1
        limited = any(x['phase'] == 'CaptureLimitReached' for x in records)
        row = {
            'file': p.name,
            'sha256': hashlib.sha256(data).hexdigest() if byte_count <= BYTE_BUDGET else None,
            'bytes': byte_count, 'records': line_count, 'invalidLines': invalid,
            'captureStarted': started, 'captureLimitReached': limited,
            'maxDroppedBefore': max([x['droppedBefore'] for x in records] + [0]),
            'maxSuppressedBefore': max([x['suppressedBefore'] for x in records] + [0]),
            'overflow': any(x['overflow'] for x in records),
        }
        row['observedLoss'] = bool(invalid or limited or row['maxDroppedBefore'] or row['maxSuppressedBefore'] or row['overflow'])
        rows.append(row)
        if not started:
            errors.append(p.name + ': missing or invalid CaptureStarted')
        if invalid:
            errors.append(p.name + ': malformed or non-schema JSONL')
        if byte_count > BYTE_BUDGET:
            errors.append(p.name + ': byte bound exceeded')
        if line_count > RECORD_BUDGET:
            errors.append(p.name + ': record bound exceeded')
        if records and (len({x['pid'] for x in records}) != 1 or len({x['record'] for x in records}) != len(records)):
            errors.append(p.name + ': inconsistent capture identity or duplicate record')
    if args.field_only:
        join_fields(targets, native_index, field_summary, errors)
        if any(x['observedLoss'] for x in rows):
            errors.append('field capture: native diagnostic loss')
    output_root.mkdir(parents=True, exist_ok=True)
    (output_root / 'query-capture-validation.json').write_text(json.dumps({
        **({'fieldOnly': field_summary} if args.field_only else {}),
        'expectedProcesses': expected, 'recordBudget': RECORD_BUDGET,
        'byteBudget': BYTE_BUDGET, 'processes': rows, 'errors': errors,
        'completeEvidence': not errors and not any(x['observedLoss'] for x in rows),
        'absenceDoesNotProveSuccess': True, 'terminalUnreportedDropsMayBeUnobservable': True,
    }, indent=2))
    if errors:
        raise SystemExit('; '.join(errors))


if __name__ == '__main__':
    main()
