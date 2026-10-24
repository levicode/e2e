#!/usr/bin/env python3
"""Temporary causal trace readback only. Python int preserves every native integer."""
import hashlib
import json
from pathlib import Path
import sys

KINDS = set(range(1, 8)) | set(range(20, 27)) | set(range(40, 44))
FIELDS = set('o k n g h s t st m id so ro c f e v a b w d'.split())
U64 = (1 << 64) - 1

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
    if not integer(sw['o']) or sw['k'] not in KINDS or type(sw['k']) is not int:
        return False
    for key, value in sw.items():
        if key in ('e', 'v'):
            if not isinstance(value, list) or len(value) != 2 or not all(integer(v, 0, (1 << 32)-1) for v in value): return False
        elif key == 'w':
            if not isinstance(value, list) or len(value) != 3 or not all(v is None or integer(v) for v in value): return False
        elif not integer(value, -(1 << 63) if key == 'c' else 0, (1 << 63)-1 if key == 'c' else U64): return False
    return True

def positive_trace(rows):
    by_kind = {kind:[r for r in rows if r['sw']['k']==kind] for kind in range(1,8)}
    if any(len(by_kind[k]) != 1 for k in (1,6,7)): return False
    if by_kind[6][0]['sw'].get('f') != 1 or 'error' in by_kind[6][0]: return False
    begin=by_kind[1][0]['sw']
    if begin.get('h')!=1 or any(not integer(begin.get(k),1) for k in ('g','s','t')): return False
    methods = [r['sw'] for r in by_kind[3]]
    if sorted(m.get('m') for m in methods) not in ([1,2,3,5,6], [1,2,3,4,5,6]): return False
    if len({m.get('id') for m in methods}) != len(methods): return False
    for m in methods:
        flags=m.get('f',0)
        # Assigned/tracked/sent/replied/valid/exact, known Acknowledged status;
        # no typed/error/duplicate/local-failure flag. ro may precede so.
        if flags & 63 != 63 or not flags & 1024 or (flags >> 11) & 7 != 2 or flags & (64|128|256|512): return False
        if any(not integer(m.get(k),1) for k in ('id','so','ro')) or m.get('h') != 1 or m.get('s')!=begin['s'] or 'c' in m: return False
    stages={r['sw'].get('st') for r in by_kind[2] if r['sw'].get('f')==1 and 'error' not in r}
    if not {2,3,4,5,6} <= stages: return False
    if any(r['sw'].get('f')==0 for r in by_kind[2]): return False
    if len(by_kind[4])!=1: return False
    ready=by_kind[4][0]['sw']; expected=len(methods)-2; flags=ready.get('f',0)
    if ready.get('st')!=4 or ready.get('a')!=expected or ready.get('b')!=expected or flags&35!=35 or flags&28 or (flags>>8)&15!=(1<<expected)-1: return False
    if not any(r['sw'].get('st')==7 and 'error' not in r and 'e' in r['sw'] and 'v' in r['sw'] for r in by_kind[5]): return False
    return True

def decode_bytes(raw, inventory):
    rows=[]; issues=[]; previous={}; trace_groups={}
    if len(raw)>256*1024: issues.append('capture-byte-cap-exceeded')
    if raw and not raw.endswith(b'\n'): issues.append('unterminated-final-line')
    for index,line in enumerate(raw.splitlines(),1):
        try:
            if len(line)+1>512: raise ValueError('row-byte-cap')
            row=json.loads(line,object_pairs_hook=pairs,parse_float=lambda _: (_ for _ in ()).throw(ValueError('noninteger fact')),parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite fact')))
            if not isinstance(row,dict) or row.get('schemaVersion')!=2 or row.get('source') not in ('native','proxy'): raise ValueError('record-schema')
            if not all(integer(row.get(k)) for k in ('pid','record','operationSeq','droppedBefore','emittedBefore','suppressedBefore')) or type(row.get('overflow')) is not bool: raise ValueError('record-counter-schema')
            key=(row['source'],row['pid']); last=previous.get(key)
            if row['record'] != (last+1 if last is not None else 0): issues.append('record-gap-or-replay')
            previous[key]=row['record']
            if row['droppedBefore'] or row['suppressedBefore'] or row['overflow'] or row.get('phase') in ('CaptureLimitReached','DetailLimit'): issues.append('loss-or-cap-marker')
            if row.get('phase')=='ServiceWorkerCausal':
                if not validate_sw(row.get('sw')): raise ValueError('causal-closed-schema')
                sw=row['sw']
                if 'n' in sw: trace_groups.setdefault((*key,sw['n']),[]).append(row)
            elif 'sw' in row: raise ValueError('causal-phase-mismatch')
            rows.append(row)
        except (ValueError,TypeError) as error:
            issues.append(f'line-{index}:{error}')
    if len(rows)>2048: issues.append('record-cap-exceeded')
    native_pids={p.get('pid') for p in (inventory or {}).get('processes',[]) if p.get('role')=='native' and p.get('terminalFileOwnerObservation',{}).get('writable') is True}
    visible=[]
    for (source,pid,n), group in trace_groups.items():
        orders=[r['sw']['o'] for r in group]
        if len(orders)!=len(set(orders)): issues.append('duplicate-causal-origin')
        if source=='native' and pid in native_pids and positive_trace(group): visible.append((pid,n))
    # Even a clean end marker cannot prove a final globally-quiescent drop count.
    return rows, {'positiveControlVisible':bool(visible) and not issues,
        'status':'unknown', 'reason':'global-final-counter-and-exhaustive-coverage-unproven',
        'observedIssues':sorted(set(issues)), 'visiblePositiveTraceCount':len(visible),
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
