"""Validate only closed relay metadata before copying. Never copy raw traffic."""
import importlib.util
import json
from pathlib import Path
import sys
sys.dont_write_bytecode=True

def load(name, filename):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(filename));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
relay=load('relay','popup-passive-joint-relay.py')
secure=load('secure','check-engine-secrets-native-custody.py')

def validate(data):
    assert len(data)<=relay.MAX_BYTES and data.endswith(b'\n')
    lines=data.splitlines(keepends=True);assert 0<len(lines)<=relay.MAX_RECORDS
    def pairs(items):
        result={}
        for k,v in items:assert k not in result;result[k]=v
        return result
    rows=[]
    for line in lines:
        assert len(line)<=relay.MAX_LINE_BYTES
        r=json.loads(line,object_pairs_hook=pairs);assert type(r)is dict and r.get('kind') in relay.KINDS
        assert type(r.get('monotonicUs'))is int and 0<=r['monotonicUs']<=2**53-1
        assert set(r)<= {'kind','monotonicUs'}|relay.ORDINALS|relay.COUNTS|relay.BOOLS|set(relay.ENUMS)
        for k,v in r.items():
            if k in relay.ORDINALS:assert v is None or type(v)is int and 0<v<=2**53-1
            elif k in relay.COUNTS:assert type(v)is int and 0<=v<=2**53-1
            elif k in relay.BOOLS:assert v is None or type(v)is bool
            elif k in relay.ENUMS:assert type(v)is str and v in relay.ENUMS[k]
        if rows:assert r['monotonicUs']>=rows[-1]['monotonicUs']
        rows.append(r)
    assert [r['kind'] for r in rows].count('summary')==1 and rows[-1]['kind']=='summary'
    summary=rows[-1]
    assert summary.get('recordsWritten')==len(rows) and summary.get('bytesBeforeSummary')==sum(map(len,lines[:-1]))
    flags=[k for k in relay.BOOLS if k.endswith('Overflow') or k.endswith('Capped') or k in {'transportError','invalidJson','correlationLost'}]
    complete=summary.get('metadataComplete') is True and summary.get('connections',0)>0 and all(summary.get(k) is False for k in flags) and all(summary.get(k)==0 for k in ['pendingCount','discardedRecords','unknownRoles']) and not any(r.get('role') in ['unknown','mixed'] for r in rows)
    complete=complete and {'native','playwright'}<={r.get('role') for r in rows}
    return rows,complete

def main(root):
    root=Path(root);output=root/'evidence';result={'kind':'popup-joint-metadata','acceptanceEvidence':False,'status':'incomplete'}
    try:
        data=secure.read(root/'joint.jsonl',relay.MAX_BYTES);rows,complete=validate(data)
        with (output/'joint.closed.jsonl').open('xb') as out:out.write(data)
        result.update(status='complete' if complete else 'incomplete',records=len(rows),sha256=secure.sha(data))
    except Exception:pass
    with (output/'joint-result.json').open('x') as out:json.dump(result,out)
    return result['status']=='complete'
if __name__=='__main__':sys.exit(0 if main(sys.argv[1]) else 1)
