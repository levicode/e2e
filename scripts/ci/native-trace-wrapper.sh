#!/usr/bin/env bash
set -euo pipefail
: "${E2E_DIAGNOSTIC_NATIVE_EXECUTABLE:?verified native binary missing}"
: "${E2E_DIAGNOSTIC_DIR:?trace directory missing}"
[[ -d "$E2E_DIAGNOSTIC_DIR" ]]
[[ "$E2E_DIAGNOSTIC_NATIVE_EXECUTABLE" != "$0" ]]
export AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE="$E2E_DIAGNOSTIC_DIR/native-$$.jsonl"
# The native sink refuses missing files and symlinks. Create only our new
# process-owned regular file; a collision must fail rather than truncate evidence.
( set -o noclobber; umask 077; : > "$AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE" )
exec "$E2E_DIAGNOSTIC_NATIVE_EXECUTABLE" "$@"
