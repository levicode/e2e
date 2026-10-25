import path from 'node:path';

// Pure admission/cleanup predicate. Unknown identity never authorizes a signal.
export function borrowedOwnedSnapshot(value) {
  const { profile, runtimeTmp, profileStat: s, process: p, launcher, argv,
    executable, expectedExecutable, expectedArgv, environment, ownerEnvironment } = value;
  if (!s || !p || !launcher || !Array.isArray(expectedArgv) || !Object.keys(ownerEnvironment ?? {}).length) return null;
  if (path.dirname(profile) !== runtimeTmp || !/^e2e-cdp-host-[A-Za-z0-9]{6}$/.test(path.basename(profile))) return null;
  if (!s.directory || s.symlink || s.uid !== p.uid || s.mode !== 0o700 || !Number.isSafeInteger(s.dev) || !Number.isSafeInteger(s.ino)) return null;
  if (p.status !== 'live' || launcher.status !== 'live' || p.uid !== launcher.uid || p.pgrp !== launcher.pgrp || p.pgrp !== launcher.pid) return null;
  if (executable !== expectedExecutable || JSON.stringify(argv) !== JSON.stringify(expectedArgv)) return null;
  if (!Object.entries(ownerEnvironment).every(([key, value]) => environment.includes(key + '=' + value))) return null;
  const identity = { dev: s.dev, ino: s.ino };
  if (value.expectedProfileIdentity && JSON.stringify(identity) !== JSON.stringify(value.expectedProfileIdentity)) return null;
  return identity;
}
