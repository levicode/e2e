#!/usr/bin/env python3
"""Read-only sampled identities for this sanitized diagnostic batch; never signal a process.
Not an exhaustive launch or cleanup observer. Missing observations remain unknown.
"""
import hashlib, json, os, sys, time
from pathlib import Path


def snapshot(pid, marker, expected, proc=Path('/proc')):
    base=proc/str(pid)
    try:
        if base.stat().st_uid != os.getuid(): return None
        if ('E2E_MATRIX_MARKER='+marker).encode() not in (base/'environ').read_bytes().split(b'\0'): return None
        before=(base/'stat').read_text().rsplit(')',1)[1].split()
        executable=os.readlink(base/'exe')
        if executable not in expected and Path(executable).name not in ('chrome','chromium','chrome-headless-shell'): return None
        info=(base/'exe').stat()
        argv=[x.decode('utf-8','replace') for x in (base/'cmdline').read_bytes().split(b'\0') if x]
        value={'pid':int(pid),'parentPid':int(before[1]),'startTicks':before[19], 'executable':executable,
               'argv':argv,'dev':info.st_dev,'ino':info.st_ino,'size':info.st_size,'mtimeNs':info.st_mtime_ns,'approvedImage':executable in expected}
        after=(base/'stat').read_text().rsplit(')',1)[1].split()
        if before[19]!=after[19] or os.readlink(base/'exe')!=executable: return None
        return value
    except (OSError,ValueError,IndexError): return None  # process exited or unreadable; never a positive observation


def main():
    marker,stop_file,output,images_file=sys.argv[1:]
    images=json.loads(Path(images_file).read_text())
    expected={images[name]['executable']:images[name]['sha256'] for name in ('full','shell','production')}
    seen=set(); image_hashes={}; observations=0; scans=0; errors=[]; alive=[]
    with open(output,'x') as stream:
        while True:
            scans+=1; alive=[]
            for entry in Path('/proc').iterdir():
                if not entry.name.isdigit(): continue
                value=snapshot(entry.name,marker,expected)
                if value is None: continue
                key=(value['pid'],value['startTicks'],value['dev'],value['ino'])
                alive.append({'pid':value['pid'],'startTicks':value['startTicks'],'executable':value['executable']})
                if key in seen: continue
                try:
                    # Read the actual /proc image, then recheck identity against PID reuse/exec.
                    image_key=(value['dev'],value['ino'],value['size'],value['mtimeNs'])
                    if image_key not in image_hashes: image_hashes[image_key]=hashlib.sha256((entry/'exe').read_bytes()).hexdigest()
                    digest=image_hashes[image_key]
                    again=snapshot(entry.name,marker,expected)
                    if again is None or any(again[k]!=value[k] for k in ('startTicks','executable','dev','ino','size','mtimeNs')): continue
                    value.update(sha256=digest,expectedHashMatches=digest==expected.get(value['executable']),observedAt=time.time())
                    if not value['expectedHashMatches']: errors.append({'pid':value['pid'],'reason':'Unapproved or changed runtime image','executable':value['executable']})
                    stream.write(json.dumps(value)+'\n');stream.flush();seen.add(key);observations+=1
                except OSError: continue
            if Path(stop_file).exists(): break
            time.sleep(.1)
    Path(output+'.summary.json').write_text(json.dumps({'mode':'read-only sampled /proc identities','scans':scans,'observations':observations,
        'remainingObservedAtStop':alive,'observationCoverage':'incomplete; short-lived or unreadable processes may be missed',
        'cleanupStatus':'unknown; no signals or descendant cleanup performed','errors':errors,'releaseEligible':False},indent=2)+'\n')
    if errors: sys.exit(1)

if __name__=='__main__': main()
