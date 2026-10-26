#!/usr/bin/env bash
set -euo pipefail
out="$GITHUB_WORKSPACE/evidence"
export E2E_AGENT_BROWSER_EXECUTABLE="$GITHUB_WORKSPACE/images/production"
export E2E_TELEMETRY_DISABLED=1 E2E_UPDATE_CHECK_DISABLED=1 NEXT_TELEMETRY_DISABLED=1
cd "$GITHUB_WORKSPACE/source"
case "${1:?group}" in
 names-eight) files=(tests/integration/read-node-public-names.test.ts); pattern='^native public accessible naming '; expected=8 ;;
 budget-four) files=(tests/integration/read-node-names.test.ts); pattern='^native observation frame and completeness contracts '; expected=4 ;;
 first-two) files=(tests/integration/read-node-names.test.ts tests/integration/observation.test.ts); pattern="^(?:names from content and precedence keeps an embedded control's value out of label text and a secure field's value out of every name|collects captured metadata while published element references stay actionable)$"; expected=2 ;;
 *) exit 2 ;;
esac
node --input-type=module -e "import {openSync,closeSync} from 'node:fs';closeSync(openSync(process.argv[1],'wx',0o600))" "$out/public.cleanup.jsonl"
printf '%s\n' 'Focused actual browser contracts only; no native test pass imported; original budgets/assertions unchanged; no legacy removal or formal acceptance claim.' > "$out/scope.txt"
set +e
AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE="$out/public.cleanup.jsonl" pnpm --filter @e2e-dev/web exec vitest run --project integration "${files[@]}" --testNamePattern="$pattern" --maxWorkers=2 --bail=0 --reporter=verbose --reporter=json --outputFile="$out/public.vitest.json" 2>&1 | tee "$out/public.log"
status=${PIPESTATUS[0]}
set -e
printf '%s\n' "$status" > "$out/public.exit"
python3 - "$out/public.vitest.json" "$expected" <<'PY'
import json,sys
j=json.load(open(sys.argv[1]));assert j['numPassedTests']+j['numFailedTests']==int(sys.argv[2]),j
PY
exit "$status"
