"""Validate bounded, payload-free native query diagnostic captures (schema 2)."""
import hashlib
import json
import pathlib
import stat
import sys

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
READ_ERRORS = set('invalid-arguments invalid-locator frame-not-found frame-ambiguous unsupported-capability stale-reference superseded cancelled deadline-exceeded backend-failure policy-denied resource-limit cleanup-failed'.split())


def uint(value, maximum=SAFE_INTEGER):
    # bool is a Python int subclass; accepting it would corrupt loss evidence.
    return type(value) is int and 0 <= value <= maximum


def eval_valid(value):
    if not isinstance(value, dict) or set(value) != {'s', 'c', 'h', 'p', 't', 'r', 'w', 'v', 'e'}:
        return False
    if type(value['s']) is not str or value['s'] not in ('entry', 'wait', 'capture'):
        return False
    if type(value['c']) is not str or value['c'] not in ('entry', 'fence', 'pending', 'unresumed', 'retire', 'health', 'guard'):
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
        extra = {'generation', 'queryReadStage', 'queryReadError'}
        if record.get('queryReadStage') not in READ_STAGES or record.get('queryReadError') not in READ_ERRORS:
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


def main():
    root = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path('evidence/native-trace')
    expected = int(sys.argv[1])
    ordinary = sorted(root.glob('native-*.jsonl'))
    files = sorted(root.glob('query-*.jsonl'))
    rows, errors = [], []
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
        for line in data.splitlines():
            line_count += 1
            try:
                record = json.loads(line, object_pairs_hook=unique_pairs)
                if len(line) > 512 or not schema_valid(record):
                    invalid += 1
                    continue
                records.append(record)
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
        if line_count > RECORD_BUDGET + 1:
            errors.append(p.name + ': record bound exceeded')
        if records and (len({x['pid'] for x in records}) != 1 or len({x['record'] for x in records}) != len(records)):
            errors.append(p.name + ': inconsistent capture identity or duplicate record')
    root.mkdir(parents=True, exist_ok=True)
    (root / 'query-capture-validation.json').write_text(json.dumps({
        'expectedProcesses': expected, 'recordBudget': RECORD_BUDGET,
        'byteBudget': BYTE_BUDGET, 'processes': rows, 'errors': errors,
        'completeEvidence': not errors and not any(x['observedLoss'] for x in rows),
        'absenceDoesNotProveSuccess': True, 'terminalUnreportedDropsMayBeUnobservable': True,
    }, indent=2))
    if errors:
        raise SystemExit('; '.join(errors))


if __name__ == '__main__':
    main()
