#!/usr/bin/env python3
"""Closed per-initialization witnesses; never a globally lossless-capture claim."""
import hashlib
import json
from pathlib import Path
import sys

KINDS = set(range(1, 8)) | set(range(20, 27)) | set(range(40, 44))
FIELDS = set('o k n g h s t st m id so ro c f e v a b w d'.split())
U64 = (1 << 64) - 1
READY_BITS = {13,14,15,16,17,18,19,20,29,30,31,48,49,50,51,52,53,54,55,56,57,59,60,61}
READY_TRUE = {29,56,57,59}
RETIRE_BITS = set(range(13,25)) | set(range(32,43)) | set(range(48,56)) | {58,59,61}
RETIRE_TRUE = {22,58}
CHECK_CODES = set(range(1,6)) | (set(range(32,47)) - {41,44}) | set(range(64,71)) | {80}
SCOPE_VERSION = 'sw-causal-scope-closure-v1'
FAILURE_BITS = {13,14,15,16,17,18,19,20,21} | set(range(32,43)) | set(range(48,56))


def dump(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def pairs(items):
    value = {}
    for key, item in items:
        if key in value:
            raise ValueError('duplicate JSON key')
        value[key] = item
    return value


def integer(value, minimum=0, maximum=U64):
    return type(value) is int and minimum <= value <= maximum


def validate_sw(sw):
    if not isinstance(sw, dict) or set(sw) - FIELDS or not {'o', 'k'} <= set(sw):
        return False
    if not integer(sw['o'], 1) or type(sw['k']) is not int or sw['k'] not in KINDS:
        return False
    for key, value in sw.items():
        if key in ('e', 'v'):
            if not isinstance(value, list) or len(value) != 2 or not all(integer(v, 0, (1 << 32)-1) for v in value): return False
        elif key == 'w':
            if not isinstance(value, list) or len(value) != 3 or not all(v is None or integer(v) for v in value): return False
        elif not integer(value, -(1 << 63) if key == 'c' else 0, (1 << 63)-1 if key == 'c' else U64): return False
    return True


def mask(sw, key):
    value = sw.get(key)
    return value[0] | value[1] << 32 if isinstance(value, list) and len(value) == 2 else None


def bits_match(sw, expected):
    evaluated, values = mask(sw, 'e'), mask(sw, 'v')
    return evaluated is not None and values is not None and not values & ~evaluated and all(
        evaluated & (1 << bit) and bool(values & (1 << bit)) == value for bit, value in expected.items())


def trace_verdict(group, owner_known, capture_started, artifact_issues):
    by = {kind: [r for r in group if r['sw']['k'] == kind] for kind in KINDS}
    missing = []
    def need(condition, label):
        if not condition: missing.append(label)
        return bool(condition)
    def one(kind):
        if not need(len(by[kind]) == 1, f'kind-{kind}-missing-or-duplicate'): return None
        return by[kind][0]
    pid, n = group[0]['pid'], group[0]['sw']['n']
    need(owner_known, 'native-writable-capture-owner-unverified')
    need(capture_started, 'capture-start-missing-or-ambiguous')
    need(integer(n, 1, 8), 'trace-ordinal-invalid')
    missing.extend('artifact:' + issue for issue in artifact_issues)
    origins = [r['sw']['o'] for r in group]
    need(len(origins) == len(set(origins)), 'duplicate-scope-origin')
    begin, final, end = one(1), one(6), one(7)
    if begin:
        b = begin['sw']
        need(b.get('h') == 1 and integer(b.get('g'), 1), 'begin-generation-or-hash-kind-missing')
        for key in ('s','t'): need(integer(b.get(key), 1, (1 << 53)-1), 'begin-' + key + '-missing')
    if final:
        f = final['sw']
        need(f.get('f') in (1,2,3), 'final-outcome-unknown')
        need(('error' not in final) if f.get('f') == 1 else isinstance(final.get('error'), str), 'final-error-outcome-mismatch')
    owned = [r for r in group if 1 <= r['sw']['k'] <= 6]
    if end:
        need(integer(end['sw'].get('b'), 2, 31) and end['sw']['b'] == len(owned), 'trace-attempt-prefix-count-mismatch')
        need(integer(end['sw'].get('a')) and end['sw']['a'] <= end['record'], 'end-global-attempt-snapshot-invalid')
        need(not any(r['sw']['o'] > end['sw']['o'] for r in group), 'scope-record-after-end')
    if begin and final and end:
        lo, finish, hi = begin['sw']['o'], final['sw']['o'], end['sw']['o']
        need(lo < finish < hi, 'begin-final-end-origin-order')
        need(all(lo <= r['sw']['o'] <= finish for r in owned), 'trace-owned-record-outside-closure')
    structural_missing = list(missing)
    decision = {'status':'unknown', 'kind':'unclassified', 'missingFacts':[]}
    outcome = final['sw'].get('f') if final else None
    identity = ({key:begin['sw'].get(key) for key in ('g','s','t','h')} if begin else None)

    def stages_through(last):
        result = {}
        for stage in range(2, last + 1):
            records = [r for r in by[2] if r['sw'].get('st') == stage]
            if need(len(records) == 1, f'stage-{stage}-missing-or-duplicate'):
                record = records[0]; result[stage] = record
                need(record['sw'].get('f') == 1 and 'error' not in record, f'stage-{stage}-not-success')
        return result

    def permit(completed):
        acquired, dropped = one(20), one(21)
        for label, record in [('permit-acquired',acquired),('permit-drop',dropped)]:
            if begin and record:
                need(record['sw'].get('h') == 1 and all(record['sw'].get(key) == begin['sw'].get(key) for key in ('s','t')), label + '-binding-mismatch')
        if dropped:
            flags = dropped['sw'].get('a')
            need(integer(flags, 0, 7) and bool(flags & 1) == completed and bool(flags & 2)
                 and bool(flags & 4) == (not completed) and integer(dropped['sw'].get('b')), 'permit-drop-state-incomplete-or-wrong')
        return acquired, dropped

    def methods(batch, allow_error):
        result = {}; expected = batch['sw'].get('b') if batch else None
        wanted = [1,2,3,5,6] if expected == 3 else [1,2,3,4,5,6] if expected == 4 else []
        need(bool(wanted), 'batch-expected-count-unknown')
        method_rows = by[3]
        need(sorted(r['sw'].get('m',-1) for r in method_rows) == wanted, 'fixed-method-slots-incomplete-or-duplicate')
        ids = [r['sw'].get('id') for r in method_rows]
        need(all(integer(v,1) for v in ids) and len(set(ids)) == len(ids), 'command-id-missing-or-duplicate')
        for record in method_rows:
            m = record['sw']; number = m.get('m'); result[number] = record
            flags = m.get('f',0)
            need(flags & (63|1024|16384) == (63|1024|16384) and (flags >> 11) & 7 == 2
                 and not flags & (128|256), f'method-{number}-terminal-or-status-incomplete')
            error = bool(flags & 512)
            need((error == bool(flags & 64)) and (integer(m.get('c'), -(1<<63), (1<<63)-1) if error else 'c' not in m)
                 and (allow_error or not error), f'method-{number}-error-classification-invalid')
            if number in (1,2): need(not error, f'prebatch-method-{number}-error')
            need(all(integer(m.get(key),1) for key in ('so','ro')) and m.get('so') != m.get('ro'), f'method-{number}-origin-missing-or-equal')
            if begin: need(m.get('h') == 1 and m.get('s') == begin['sw'].get('s'), f'method-{number}-session-mismatch')
        return result

    def ordered_common(stages, method, acquired, batch):
        if not begin or not batch or not acquired or set(stages) != {2,3,4,5} or not {1,2} <= set(method): return
        bs = begin['sw']['o']; p = [stages[i]['sw']['o'] for i in (2,3,4,5)]
        need(bs < p[0] < p[1] < p[2] < acquired['sw']['o'] < p[3], 'prebatch-origin-order')
        for number, start, stop in ((1,bs,p[0]), (2,p[0],p[1])):
            need(all(integer(method[number]['sw'].get(k),1) and start < method[number]['sw'][k] < stop for k in ('so','ro')), f'method-{number}-prebatch-origin-order')
        batch_methods = [method[k]['sw'] for k in (3,4,5,6) if k in method]
        for m in batch_methods:
            need(all(integer(m.get(k),1) and p[3] < m[k] < batch['sw']['o'] for k in ('so','ro')), f'method-{m.get("m")}-batch-origin-order')
        sends = [m.get('so',-1) for m in batch_methods]; ids = [m.get('id',-1) for m in batch_methods]
        need(sends == sorted(set(sends)) and ids == sorted(set(ids)), 'fixed-batch-submission-order')

    batch = one(4) if by[4] else None
    branch = batch['sw'].get('st') if batch else None
    if branch in (2,3,4):
        stages = stages_through(5)
        method = methods(batch, branch != 4)
        b = batch['sw']; expected = b.get('b'); flags = b.get('f',0)
        need(expected in (3,4) and b.get('a') == expected and flags & 35 == 35
             and (flags >> 8) & 15 == (1 << expected)-1 and not flags & (8|16), 'batch-completeness-or-status-match-missing')
        need(bool(flags & 4) == (branch != 4), 'batch-error-ack-flag-mismatch')
        need(bits_match(b, {0:True,1:True,2:False,3:False,4:False,5:False,6:False,7:False,12:False}), 'batch-bound-predicates-incomplete')
        acquired, dropped = permit(branch == 4 or outcome == 2)
        ordered_common(stages, method, acquired, batch)
        batch_stages = [r for r in by[2] if r['sw'].get('st') == 6]
        outer = [r for r in batch_stages if r['sw'].get('f') == 1 and 'error' not in r]
        need(len(outer) == 1, 'bounded-batch-return-missing-or-duplicate')
        if outer: need(batch['sw']['o'] < outer[0]['sw']['o'], 'batch-decision-after-outer-return')
        if branch == 4:
            decision['kind'] = 'ready-initialized'
            need(outcome == 1 and final and final['sw'].get('st') == 7, 'ready-final-not-initialized')
            need(len(batch_stages) == 1 and all(r['sw'].get('f') == 1 and 'error' not in r for r in by[2]), 'unexpected-local-stage-failure')
            gate = one(5)
            if gate:
                need(gate['sw'].get('st') == 7 and 'error' not in gate and 'b' not in gate['sw'], 'ready-gate-not-success')
                need(bits_match(gate['sw'], {bit:bit in READY_TRUE for bit in READY_BITS}), 'ready-gate-predicates-incomplete')
                expected_ready_e = sum(1 << bit for bit in READY_BITS | {0,1,2,3,4,5,6,7,12})
                expected_ready_v = sum(1 << bit for bit in READY_TRUE | {0,1})
                need(mask(gate['sw'],'e') == expected_ready_e and mask(gate['sw'],'v') == expected_ready_v, 'ready-gate-path-or-tenure-contradiction')
                need(integer(gate['sw'].get('a'),1) and gate['sw']['a'] < gate['sw']['o'], 'ready-gate-origin-missing')
                if final: need(all(final['sw'].get(k) == gate['sw'].get(k) for k in ('e','v','a','b','w')), 'final-gate-snapshot-mismatch')
                if outer and dropped and final:
                    need(integer(gate['sw'].get('a'),1) and outer[0]['sw']['o'] < gate['sw']['a'] < gate['sw']['o'] < dropped['sw']['o'] < final['sw']['o'], 'ready-gate-drop-final-order')
            need(not by[24], 'same-scope-poison-observed')
        else:
            decision['kind'] = 'error-ack-no-receipt' if branch == 2 else 'error-ack-retirement'
            need(any(r['sw'].get('f',0) & 512 for r in by[3]), 'typed-error-ack-missing')
            need(integer(b.get('d'),1) and b['d'] < b['o'] and bits_match(b, {8:True,9:True,10:branch==3,11:branch==3}), 'exact-unbound-decision-evidence-missing')
            if integer(b.get('d'),1): need(all(r['sw'].get('ro',U64) < b['d'] for r in by[3]), 'reply-after-unbound-decision')
            if branch == 2:
                need(outcome in (1,3), 'no-receipt-final-outcome-mismatch')
                need(any(r['sw'].get('f') == 0 and isinstance(r.get('error'),str) for r in batch_stages), 'no-receipt-local-error-missing')
                need(not by[5], 'unexpected-no-receipt-gate')
                if outer and dropped and final: need(outer[0]['sw']['o'] < dropped['sw']['o'] < final['sw']['o'], 'no-receipt-drop-final-order')
                decision['rejectingCondition'] = 'original-session-still-bound-at-unbound-read'
            else:
                need(final is not None and final['sw'].get('st') == 8, 'retirement-final-stage-mismatch')
                gate = one(5)
                if gate:
                    g = gate['sw']; evaluated, values = mask(g,'e'), mask(g,'v')
                    need(g.get('st') == 8 and evaluated is not None and values is not None and not values & ~evaluated, 'retirement-gate-mask-missing')
                    if 'error' in gate:
                        need(isinstance(gate.get('error'), str) and bool(gate['error']), 'retirement-gate-error-invalid')
                        code = g.get('b')
                        failed = [bit for bit in sorted(FAILURE_BITS) if evaluated is not None and values is not None and evaluated & values & (1 << bit)]
                        special = bits_match(g,{23:True,25:True,26:False,27:True}) or bits_match(g,{24:True,25:True,26:False,27:True})
                        need(code in CHECK_CODES or bool(failed) or special, 'retirement-rejecting-condition-unknown')
                        decision.update(firstCheckedFailure=code, observedRejectingPredicateBits=failed,
                                        indexPresentWithoutRetirementPublication=special, preDropError=gate['error'])
                        need(outcome in (1,3), 'retirement-error-final-outcome-mismatch')
                    else:
                        expected_e = sum(1 << bit for bit in RETIRE_BITS | set(range(13)))
                        expected_v = sum(1 << bit for bit in RETIRE_TRUE | {0,1,8,9,10,11})
                        need(outcome == 2 and mask(g,'e') == expected_e and mask(g,'v') == expected_v and 'b' not in g,
                             'retirement-success-exact-permit-gate-missing')
                        watermarks = g.get('w')
                        need(isinstance(watermarks,list) and len(watermarks)==3 and all(integer(x) for x in watermarks[:2])
                             and watermarks[1] >= watermarks[0], 'retirement-success-watermark-missing')
                        decision['kind'] = 'failed-retired'
                    if final: need(all(final['sw'].get(k) == g.get(k) for k in ('e','v','a','b','w')), 'final-retirement-gate-snapshot-mismatch')
                    if outer and dropped and final: need(outer[0]['sw']['o'] < g['o'] < dropped['sw']['o'] < final['sw']['o'], 'retirement-gate-drop-final-order')
        if dropped and final:
            need(all(dropped['sw']['o'] < r['sw']['o'] < final['sw']['o'] for r in by[3]), 'method-summary-outside-final-prefix')
    else:
        need(False, 'supported-complete-target-decision-missing')
    # Structural closure and branch evidence are separate; neither proves missing
    # global/lifecycle records absent. The successful source gate checks original
    # ResumePermit/AttachmentTenure. No serialized tenure ordinal is invented.
    decision['status'] = 'closed' if not missing else 'unknown'
    decision['missingFacts'] = sorted(set(missing))
    decision['finalOutcome'] = outcome
    decision['finalError'] = final.get('error') if final else None
    decision['batchOutcome'] = branch
    return {'source':group[0]['source'], 'pid':pid, 'traceOrdinal':n,
            'status':decision['status'], 'scopeClosed':not structural_missing,
            'successfulControl':not missing and decision['kind']=='ready-initialized',
            'missingFacts':sorted(set(missing)), 'identity':identity,
            'traceOwnedRecordsBeforeEnd':len([r for r in group if 1 <= r['sw']['k'] <= 6]),
            'traceAttemptPrefix':end['sw'].get('b') if end else None,
            'tenureEvidence':('source-checked-original-permit-commit; no serialized tenure ordinal' if not missing and decision['kind'] in ('ready-initialized','failed-retired') else 'not-proven'),
            'decisionEvidence':decision}


def decode_bytes(raw, inventory):
    rows=[]; issues=[]; fatal=[]; previous={}; trace_groups={}; starts={}; all_origins={}
    if len(raw)>256*1024: fatal.append('capture-byte-cap-exceeded')
    if raw and not raw.endswith(b'\n'): fatal.append('unterminated-final-line')
    for index,line in enumerate(raw.splitlines(),1):
        try:
            if len(line)+1>512: raise ValueError('row-byte-cap')
            row=json.loads(line,object_pairs_hook=pairs,parse_float=lambda _: (_ for _ in ()).throw(ValueError('noninteger fact')),parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite fact')))
            if not isinstance(row,dict) or row.get('schemaVersion')!=2 or row.get('source') not in ('native','proxy'): raise ValueError('record-schema')
            if not all(integer(row.get(k)) for k in ('pid','record','operationSeq','droppedBefore','emittedBefore','suppressedBefore')) or type(row.get('overflow')) is not bool: raise ValueError('record-counter-schema')
            key=(row['source'],row['pid']); last=previous.get(key)
            if last is not None and row['record'] <= last: fatal.append('record-replay-or-nonmonotonic')
            elif row['record'] != (last+1 if last is not None else 0): issues.append('record-forward-gap')
            previous[key]=row['record']
            if row['droppedBefore']: issues.append('observed-global-drops')
            if row['suppressedBefore'] or row['overflow'] or row.get('phase') in ('CaptureLimitReached','DetailLimit'): fatal.append('suppression-overflow-or-cap-marker')
            if row.get('phase')=='CaptureStarted': starts.setdefault(key,[]).append(row)
            if row.get('phase')=='ServiceWorkerCausal':
                if not validate_sw(row.get('sw')): raise ValueError('causal-closed-schema')
                sw=row['sw']; origin=(*key,sw['o'])
                if origin in all_origins: fatal.append('duplicate-causal-origin')
                all_origins[origin]=True
                if 'n' in sw: trace_groups.setdefault((*key,sw['n']),[]).append(row)
            elif 'sw' in row: raise ValueError('causal-phase-mismatch')
            rows.append(row)
        except (ValueError,TypeError) as error:
            fatal.append(f'line-{index}:{error}')
    if len(rows)>2048: fatal.append('record-cap-exceeded')
    native_pids={p.get('pid') for p in (inventory or {}).get('processes',[]) if p.get('role')=='native' and p.get('terminalFileOwnerObservation',{}).get('writable') is True}
    verdicts=[]
    for (source,pid,n), group in trace_groups.items():
        started=starts.get((source,pid),[])
        verdicts.append(trace_verdict(group, source=='native' and pid in native_pids,
                                     len(started)==1 and started[0]['record']==0, sorted(set(fatal))))
    visible=[v for v in verdicts if v['successfulControl']]
    return rows, {'scopeDecoderVersion':SCOPE_VERSION, 'positiveControlVisible':bool(visible),
        'status':'unknown', 'reason':'global-final-counter-and-exhaustive-coverage-unproven',
        'observedIssues':sorted(set(issues+fatal)), 'visiblePositiveTraceCount':len(visible),
        'traceVerdicts':verdicts, 'scopeWitnessPolicy':'all-trace-emissions-accounted; exact-required-permit-and-method-witnesses; original-ready-gate',
        'globalLosslessCapture':False, 'missingFacts':'unknown', 'hashIdentityCollisionExcluded':False,
        'nativeIntegersDecodedBy':'Python arbitrary-precision int', 'rawSha256':hashlib.sha256(raw).hexdigest(),
        'diagnosticOnly':True, 'formalCleanupPass':False, 'formalAcceptance':False}


def decode(directory):
    directory=Path(directory)
    raw=(directory/'native.jsonl').read_bytes()
    inventory=json.loads((directory/'inventory.json').read_text()) if (directory/'inventory.json').exists() else None
    rows,summary=decode_bytes(raw,inventory)
    dump(directory/'decoded-native.json',rows)
    dump(directory/'causal-summary.json',summary)

if __name__=='__main__':
    assert len(sys.argv)==3 and sys.argv[1]=='decode'
    decode(sys.argv[2])
