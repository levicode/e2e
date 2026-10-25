#!/usr/bin/env python3
"""Read-only sampled identities for this sanitized diagnostic batch; never signal a process.
Not an exhaustive launch or cleanup observer. Missing observations remain unknown.
"""
import hashlib, json, os, sys, time
from pathlib import Path


IMAGE_FIELDS=('executable','dev','ino','size','mtimeNs')
INACTIVE_STATES=('Z','X','x')


def process_stat(base):
    head,tail=(base/'stat').read_text().rsplit(')',1)
    fields=tail.split()
    if int(head.split('(',1)[0])!=int(base.name): raise ValueError('PID mismatch')
    return {'state':fields[0],'parentPid':int(fields[1]),'startTicks':fields[19]}


def image_stat(base):
    executable=os.readlink(base/'exe'); info=(base/'exe').stat()
    return {'executable':executable,'dev':info.st_dev,'ino':info.st_ino,
            'size':info.st_size,'mtimeNs':info.st_mtime_ns}


def snapshot(pid, marker, expected, proc=Path('/proc')):
    base=proc/str(pid)
    try:
        before=process_stat(base)
        if base.stat().st_uid != os.getuid(): return None
        if ('E2E_MATRIX_MARKER='+marker).encode() not in (base/'environ').read_bytes().split(b'\0'): return None
        image=image_stat(base); executable=image['executable']
        if executable not in expected and Path(executable).name not in ('chrome','chromium','chrome-headless-shell'): return None
        argv=[x.decode('utf-8','replace') for x in (base/'cmdline').read_bytes().split(b'\0') if x]
        image_after=image_stat(base); after=process_stat(base)
        if before['startTicks']!=after['startTicks'] or image!=image_after: return None
        return {'pid':int(pid),**after,**image,'argv':argv,'approvedImage':executable in expected}
    except (OSError,ValueError,IndexError): return None  # process exited or unreadable; never a positive observation


def terminal_observation(value, proc=Path('/proc')):
    """Recheck a known owned lifetime after stop. Unreadable/changed is not exited."""
    base=proc/str(value['pid'])
    result={k:value[k] for k in ('pid','startTicks',*IMAGE_FIELDS)}
    result.update(lastObservedState=value['state'],lastObservedParentPid=value['parentPid'],checkedAt=time.time())

    def state_check():
        try: current=process_stat(base)
        except FileNotFoundError:
            return {'status':'exited','reason':'process stat absent at terminal recheck'}
        except (OSError,ValueError,IndexError):
            return {'status':'unknown','reason':'process stat unreadable at terminal recheck'}
        result.update(state=current['state'],parentPid=current['parentPid'])
        if current['startTicks']!=value['startTicks']:
            return {'status':'unknown','reason':'PID lifetime changed at terminal recheck','currentStartTicks':current['startTicks']}
        if current['state'] in INACTIVE_STATES:
            return {'status':'inactive','reason':'same lifetime is zombie/dead; not executing'}
        return None

    end=state_check()
    if end is not None: return {**result,**end}
    try: current_image=image_stat(base)
    except (OSError,ValueError,IndexError):
        end=state_check()  # exe can vanish during exit, or be unreadable while still active.
        return {**result,**(end or {'status':'unknown','reason':'process image unreadable at terminal recheck'})}
    end=state_check()
    if end is not None: return {**result,**end}
    if any(current_image[k]!=value[k] for k in IMAGE_FIELDS):
        return {**result,'status':'unknown','reason':'process image changed at terminal recheck'}
    return {**result,'status':'active','reason':'same lifetime and image still observed at terminal recheck'}


def observe(marker, stop_file, output, expected, proc=Path('/proc')):
    seen=set(); image_hashes={}; observations=0; scans=0; errors=[]; known={}
    with open(output,'x') as stream:
        while True:
            scans+=1
            for entry in proc.iterdir():
                if not entry.name.isdigit(): continue
                value=snapshot(entry.name,marker,expected,proc)
                if value is None: continue
                # Retain even a candidate that exits while hashing; never call it alive yet.
                known[(value['pid'],value['startTicks'])]=value
                key=(value['pid'],value['startTicks'],*(value[k] for k in IMAGE_FIELDS))
                if key in seen: continue
                try:
                    # Read the actual /proc image, then recheck identity against PID reuse/exec.
                    image_key=(value['dev'],value['ino'],value['size'],value['mtimeNs'])
                    digest=image_hashes.get(image_key)
                    if digest is None: digest=hashlib.sha256((entry/'exe').read_bytes()).hexdigest()
                    again=snapshot(entry.name,marker,expected,proc)
                    if again is None or any(again[k]!=value[k] for k in ('startTicks',*IMAGE_FIELDS)): continue
                    image_hashes[image_key]=digest
                    value=again
                    known[(value['pid'],value['startTicks'])]=value
                    value.update(sha256=digest,expectedHashMatches=digest==expected.get(value['executable']),observedAt=time.time())
                    if not value['expectedHashMatches']: errors.append({'pid':value['pid'],'reason':'Unapproved or changed runtime image','executable':value['executable']})
                    stream.write(json.dumps(value)+'\n');stream.flush();seen.add(key);observations+=1
                except OSError: continue
            if Path(stop_file).exists(): break
            time.sleep(.1)
    # This is after stop, not a stale candidate list collected before an expensive hash.
    terminal=[terminal_observation(value,proc) for value in known.values()]
    alive=[value for value in terminal if value['status'] in ('active','unknown')]
    Path(str(output)+'.summary.json').write_text(json.dumps({'mode':'read-only sampled /proc identities','scans':scans,'observations':observations,
        'remainingObservedAtStop':alive,'inactiveObservedAtStop':[value for value in terminal if value['status'] in ('exited','inactive')],
        'observationCoverage':'incomplete; short-lived or unreadable processes may be missed',
        'cleanupStatus':'unknown; no signals or descendant cleanup performed','errors':errors,'releaseEligible':False},indent=2)+'\n')
    return 1 if errors else 0


def main():
    marker,stop_file,output,images_file=sys.argv[1:]
    images=json.loads(Path(images_file).read_text())
    expected={images[name]['executable']:images[name]['sha256'] for name in ('full','production')}
    sys.exit(observe(marker,stop_file,output,expected))


if __name__=='__main__': main()
