#!/usr/bin/env bash
set -euo pipefail
out="$GITHUB_WORKSPACE/evidence"
mkdir -m 700 "$out/case-cleanup"
test "$(realpath "$out/case-cleanup")" = "$out/case-cleanup"
export E2E_CASE_CLEANUP_DIAGNOSTIC_DIR="$out/case-cleanup"
export E2E_AGENT_BROWSER_EXECUTABLE="$GITHUB_WORKSPACE/images/production"
case "$DIAGNOSTIC_CASE" in
 concurrent-recovery) test "$DIAGNOSTIC_FILE" = tests/integration/cdp-recovery.test.ts ;;
 state-roundtrip) test "$DIAGNOSTIC_FILE" = tests/integration/native-state-roundtrip.test.ts ;;
 *) exit 2 ;;
esac
printf '%s\n' 'One original case, one attempt, original operation/test budgets. Same verified native9b source/binary. Not a fix, not full Web, no imported passes; a nonreproduction is not a repair.' > "$out/scope.txt"
cd "$GITHUB_WORKSPACE/source"
set +e
pnpm --filter @e2e-dev/web exec vitest run --project integration "$DIAGNOSTIC_FILE" -t "^${DIAGNOSTIC_TITLE}$" --maxWorkers=1 --bail=0 --reporter=verbose --reporter=json --outputFile="$out/case.vitest.json" 2>&1 | tee "$out/case.log"
status=${PIPESTATUS[0]}
set -e
printf '%s\n' "$status" > "$out/case.exit"
python3 - "$out/case.vitest.json" <<'PY'
import json,sys,os,pathlib
j=json.load(open(sys.argv[1]));executed=[a for suite in j['testResults'] for a in suite.get('assertionResults',[]) if a['status'] in ('passed','failed')]
assert j['numPassedTests']+j['numFailedTests']==1 and len(executed)==1
assert executed[0]['fullName']==os.environ['DIAGNOSTIC_TITLE']
pathlib.Path(sys.argv[1]).with_name('selected-case-count.json').write_text(json.dumps({'executed':1,'selectedTitle':executed[0]['fullName'],'status':executed[0]['status'],'registeredTotal':j['numTotalTests'],'unselectedByExactFilter':j['numPendingTests'],'fullSuiteClaim':False},indent=2)+'\n')
PY
exit "$status"
