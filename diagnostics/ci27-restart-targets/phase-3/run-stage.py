#!/usr/bin/env python3
"""Local diagnostic runner: preserves command exit and records process resources."""
import datetime
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time

stage, cwd, stdout_path, *command = sys.argv[1:]
output = Path(__file__).resolve().parent
def read_cgroup(name):
    try:
        return Path('/sys/fs/cgroup', name).read_text().strip()
    except OSError:
        return None
def process_group_rss(group):
    total = 0
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            stat = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(stat[2]) == group:
                total += int(stat[21]) * os.sysconf('SC_PAGE_SIZE')
        except (OSError, ValueError, IndexError):
            pass
    return total
start = time.monotonic()
started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
events_before = read_cgroup('memory.events')
peak_rss = 0
peak_cgroup = 0
with (output / (stage + '.log')).open('wb') as log:
    separate = stdout_path != '-'
    stdout = open(stdout_path, 'wb') if separate else log
    try:
        process = subprocess.Popen(command, cwd=cwd, stdout=stdout, stderr=log, start_new_session=True)
        while True:
            peak_rss = max(peak_rss, process_group_rss(process.pid))
            value = read_cgroup('memory.current')
            if value and value.isdecimal():
                peak_cgroup = max(peak_cgroup, int(value))
            if process.poll() is not None:
                break
            time.sleep(0.5)
        status = process.wait()
    finally:
        if separate:
            stdout.close()
usage = resource.getrusage(resource.RUSAGE_CHILDREN)
result = dict(stage=stage, command=command, cwd=cwd, startedAt=started_at,
    elapsedSeconds=round(time.monotonic()-start,3), exitCode=status,
    sampledPeakProcessGroupRssBytes=peak_rss, maximumChildRssKiB=usage.ru_maxrss,
    sampledPeakCgroupMemoryBytes=peak_cgroup, cgroupMemoryPeak=read_cgroup('memory.peak'),
    cgroupMemoryEventsBefore=events_before, cgroupMemoryEventsAfter=read_cgroup('memory.events'))
(output / (stage + '.resource.json')).write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps(result), flush=True)
sys.exit(status if status >= 0 else 128-status)
