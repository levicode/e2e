#!/usr/bin/env bash
set -euo pipefail
: "${E2E_DIAGNOSTIC_NATIVE_EXECUTABLE:?verified native binary missing}"
: "${E2E_DIAGNOSTIC_DIR:?trace directory missing}"
[[ -d "$E2E_DIAGNOSTIC_DIR" ]]
[[ "$E2E_DIAGNOSTIC_NATIVE_EXECUTABLE" != "$0" ]]
# Optional, independently archived pre-exec invocation custody. Receipts live
# outside the strict native/query-only trace directory and never count traces.
if [[ -n "${E2E_DIAGNOSTIC_INVOCATIONS:-}" ]]; then
if python3 - "$$" "$0" <<'INVOCATION'
import hashlib,json,os,pathlib,secrets,stat,sys
root=pathlib.Path(os.environ['E2E_DIAGNOSTIC_INVOCATIONS'])
assert root.is_absolute() and root == pathlib.Path(os.environ['GITHUB_WORKSPACE'])/'evidence/fixture-invocations'
assert root.is_dir() and not root.is_symlink() and stat.S_IMODE(root.stat().st_mode)==0o700
assert root.stat().st_uid==os.geteuid()
for part in [root,*root.parents]:assert not part.is_symlink()
trace=pathlib.Path(os.environ['E2E_DIAGNOSTIC_DIR'])
assert trace.is_absolute() and trace.is_dir() and not trace.is_symlink()
def filehash(p):
 p=pathlib.Path(p);assert p.is_file() and not p.is_symlink()
 return hashlib.sha256(p.read_bytes()).hexdigest()
native=os.environ['E2E_DIAGNOSTIC_NATIVE_EXECUTABLE'];pid=int(sys.argv[1])
row={'schemaVersion':2,'pid':pid,'nonce':secrets.token_hex(32),'traceDirectory':str(trace),'nativeExecutable':native,
 'nativeSHA256':filehash(native),'wrapperSHA256':filehash(sys.argv[2]),
 'run':os.environ['GITHUB_RUN_ID'],'attempt':os.environ['GITHUB_RUN_ATTEMPT'],
 'sourceCommit':os.environ['GITHUB_SHA'],'sourceTree':os.environ['E2E_CAPTURE_SOURCE_TREE']}
fd=os.open(root/f'invocation-{pid}.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'w') as f:f.write(json.dumps(row)+'\n')
INVOCATION
then
 export AGENT_BROWSER_INVOCATION_CUSTODY=1
else
 # No receipt means incomplete diagnostics, not a replacement business error.
 printf 'NATIVE_INVOCATION_CUSTODY_FAILED\n' >&2 || true
 unset AGENT_BROWSER_INVOCATION_CUSTODY
fi
else
 unset AGENT_BROWSER_INVOCATION_CUSTODY
fi
export AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE="$E2E_DIAGNOSTIC_DIR/native-$$.jsonl"
# The native sink refuses missing files and symlinks. Create only our new
# process-owned regular file; a collision must fail rather than truncate evidence.
( set -o noclobber; umask 077; : > "$AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE" )
export AGENT_BROWSER_QUERY_DIAGNOSTIC_FILE="$E2E_DIAGNOSTIC_DIR/query-$$.jsonl"
( set -o noclobber; umask 077; : > "$AGENT_BROWSER_QUERY_DIAGNOSTIC_FILE" )
[[ -f "$AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE" && ! -L "$AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE" ]]
[[ -f "$AGENT_BROWSER_QUERY_DIAGNOSTIC_FILE" && ! -L "$AGENT_BROWSER_QUERY_DIAGNOSTIC_FILE" ]]
[[ ! "$AGENT_BROWSER_QUERY_DIAGNOSTIC_FILE" -ef "$AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE" ]]
exec "$E2E_DIAGNOSTIC_NATIVE_EXECUTABLE" "$@"
