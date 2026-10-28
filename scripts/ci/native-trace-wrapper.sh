#!/usr/bin/env bash
set -euo pipefail
: "${E2E_DIAGNOSTIC_NATIVE_EXECUTABLE:?verified native binary missing}"
: "${E2E_DIAGNOSTIC_DIR:?trace directory missing}"
[[ -d "$E2E_DIAGNOSTIC_DIR" ]]
[[ "$E2E_DIAGNOSTIC_NATIVE_EXECUTABLE" != "$0" ]]
export AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE="$E2E_DIAGNOSTIC_DIR/native-$$.jsonl"
exec "$E2E_DIAGNOSTIC_NATIVE_EXECUTABLE" "$@"
