#!/usr/bin/env bash
# Focused RESPONSE; unchanged matrix environment/process observer and original full-text/JSON source test.
# Requires separately verified new product/source/browser identity.
set -euo pipefail
umask 077
: "${GITHUB_WORKSPACE:?}" "${EVIDENCE_DIR:?}" "${PLAYWRIGHT_BROWSERS_PATH:?}"
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO="$GITHUB_WORKSPACE/e2e-source"
PRODUCTION="$GITHUB_WORKSPACE/agent-browser"
NODE=$(command -v node)
BASE_PATH="$(dirname "$NODE"):$(dirname "$(command -v pnpm)"):/usr/bin:/bin"
CHROME=$("$NODE" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).full.executable)' "$EVIDENCE_DIR/images-before.json")
OUT="$EVIDENCE_DIR"
fresh_environment() {
  ROOT=$(mktemp -d /tmp/em-XXXXXX)
  mkdir -m700 "$ROOT/home" "$ROOT/tmp" "$ROOT/bin" "$ROOT/cache" "$ROOT/s"
  ln -s "$CHROME" "$ROOT/bin/google-chrome"
  test -z "$(ls -A "$ROOT/home")"
  test ! -e "$ROOT/home/.agent-browser/browsers"
  ENV=(env -i "PATH=$ROOT/bin:$BASE_PATH" "HOME=$ROOT/home" CI=1 LANG=C.UTF-8
    "TMPDIR=$ROOT/tmp" "TMP=$ROOT/tmp" "TEMP=$ROOT/tmp" "XDG_CACHE_HOME=$ROOT/cache"
    "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH" "AGENT_BROWSER_SOCKET_DIR=$ROOT/s"
    "E2E_AGENT_BROWSER_EXECUTABLE=$PRODUCTION" E2E_TELEMETRY_DISABLED=1 E2E_UPDATE_CHECK_DISABLED=1 E2E_CACHE_DIR=)
  test "$("${ENV[@]}" /usr/bin/readlink -f "$ROOT/bin/google-chrome")" = "$CHROME"
}
observed_command() {
  local name=$1; shift
  local marker="${ROOT##*/}-$name" observer status observer_status
  printf '%s\n' "$ROOT" > "$OUT/$name.environment-root.txt"
  # Only sanitized environment keys and explicit argv are retained, never inherited credentials.
  printf '%q ' "${ENV[@]}" "E2E_MATRIX_MARKER=$marker" "$@" > "$OUT/$name.command.txt"; printf '\n' >> "$OUT/$name.command.txt"
  /usr/bin/python3 "$HERE/observe-processes.py" "$marker" "$ROOT/$name.stop" "$OUT/$name.processes.jsonl" "$OUT/images-before.json" > "$OUT/$name.observer.log" 2>&1 & observer=$!
  set +e
  "${ENV[@]}" "E2E_MATRIX_MARKER=$marker" "$@" > "$OUT/$name.stdout-stderr.log" 2>&1
  status=$?
  # Preserve the earliest real command failure before any observer/cleanup gate.
  if [[ "$status" != 0 && ! -e "$OUT/first-failed-phase.txt" ]]; then printf '%s: exit %s\n' "$name" "$status" > "$OUT/first-failed-phase.txt"; fi
  # Stop via an owned file, never signal process names/groups/unknown descendants.
  touch "$ROOT/$name.stop"
  wait "$observer"; observer_status=$?
  set -e
  printf '%s\n' "$status" > "$OUT/$name.exit"
  printf '%s\n' "$observer_status" > "$OUT/$name.observer.exit"
  COMMAND_STATUS=$status
}

node "$HERE/runtime.mjs" sources
node "$HERE/runtime.mjs" browser
# Reuse the exclusive single-case invocation receipt before spawning any runtime.
node --input-type=module - "$OUT/selection.json" "$HERE/runtime.mjs" <<'JS'
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {pins}=await import(pathToFileURL(process.argv[3]));
writeFileSync(process.argv[2],JSON.stringify({scope:'RESPONSE-single-original-full-text-json',caseIds:['RESPONSE'],runtimeWebSource:{sha:pins.e2eSha,tree:pins.e2eTree}})+'\n',{flag:'wx',mode:0o600});
JS
fresh_environment
# Original 30s test/hooks, 2s operations/observe bound, 5s endAttempt/dispose remain unchanged; original remaining-batch outer safety cap 1800s, not a replacement for case deadlines.
pattern='^browser\.waitForResponse bodies > reads a full body as text and JSON$'
(cd "$REPO/packages/web" && observed_command RESPONSE /usr/bin/timeout --foreground --signal=TERM --kill-after=5s 1800 \
  "$NODE" "$REPO/packages/web/node_modules/vitest/vitest.mjs" run --project integration --maxWorkers=2 --bail=0 \
  --reporter=verbose --reporter=json "--outputFile.json=$OUT/RESPONSE.vitest.json" \
  --testNamePattern "$pattern" tests/integration/wait-for-response.test.ts)
# Reuse the exact report-selection predicate and process cleanup predicate; no full333 reconciliation.
"$NODE" --input-type=module - "$HERE/runtime.mjs" "$OUT" "$REPO" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [helper,out,repo]=process.argv.slice(2);
const {selectedReport,pins}=await import(pathToFileURL(helper));
const load=name=>JSON.parse(readFileSync(`${out}/${name}`));
const source=`${repo}/packages/web/tests/integration/wait-for-response.test.ts`;
assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),pins.responseSourceSha256);
const report=load('RESPONSE.vitest.json');
assert.equal(report.testResults.length,1);assert.equal(report.testResults[0].name,source);
const selected=selectedReport(report,'reads a full body as text and JSON');
const observed=load('RESPONSE.processes.jsonl.summary.json');
const observerExit=Number(readFileSync(`${out}/RESPONSE.observer.exit`,'utf8'));
const cleanupConfirmed=observerExit===0&&Array.isArray(observed?.errors)&&observed.errors.length===0
  &&Array.isArray(observed?.remainingObservedAtStop)&&observed.remainingObservedAtStop.length===0;
const rows=readFileSync(`${out}/RESPONSE.processes.jsonl`,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const images=load('images-before.json');
assert.equal(images.full.sha256,pins.chromeSha256);assert.equal(images.production.sha256,pins.production.binarySha256);
for(const image of [images.full,images.production]) {
  assert.equal(createHash('sha256').update(readFileSync(image.executable)).digest('hex'),image.sha256);
  const current=statSync(image.executable);
  for(const key of ['dev','ino','size']) assert.equal(current[key],image[key]);
}
const browsers=rows.filter(row=>row.executable===images.full.executable&&!row.argv.some(arg=>arg.startsWith('--type=')));
const browserLifetimes=new Set(browsers.map(row=>`${row.pid}:${row.startTicks}`));
const productionObserved=rows.some(row=>row.executable===images.production.executable&&row.expectedHashMatches===true);
const exit=Number(readFileSync(`${out}/RESPONSE.exit`,'utf8'));
const result={caseId:'RESPONSE',selected,exit,cleanupConfirmed,productionObserved,browserRootLifetimes:browserLifetimes.size,
  testSource:{sha:pins.e2eSha,tree:pins.e2eTree},artifactBuildE2e:{sha:pins.production.e2eSha,tree:pins.production.e2eTree},
  fullNativeSuitePassed:false,full333Complete:false,releaseEligible:false,
  pageCountClaim:'No page inventory claim; original full-text/JSON assertions and cleanup unchanged'};
writeFileSync(`${out}/RESPONSE.focused-result.json`,JSON.stringify(result,null,2)+'\n');
assert.equal(selected.selectionExact,true);assert.equal(selected.status,'passed');assert.equal(selected.success,true);assert.equal(exit,0);
assert.equal(cleanupConfirmed,true);assert.equal(productionObserved,true);assert.equal(browserLifetimes.size,1);
assert.ok(browsers.every(row=>row.expectedHashMatches===true));
JS
