#!/usr/bin/env bash
# Focused P04; unchanged matrix environment/process observer and original source test.
# Requires separately verified new product/source/browser identity.
set -euo pipefail
umask 077
: "${P04_CAPTURE_RATE_MODE:?}" "${COMPARISON_CELL:?}" "${GITHUB_WORKSPACE:?}" "${EVIDENCE_DIR:?}" "${PLAYWRIGHT_BROWSERS_PATH:?}"
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
writeFileSync(process.argv[2],JSON.stringify({scope:'P04-fixed-N-D-once-per-independent-runner',cell:process.env.COMPARISON_CELL,rateMode:process.env.P04_CAPTURE_RATE_MODE,attempt:1,caseIds:['P04'],runtimeWebSource:{sha:pins.e2eSha,tree:pins.e2eTree}})+'\n',{flag:'wx',mode:0o600});
JS
"$NODE" "$HERE/capture.mjs" prepare
P04_NATIVE_FILE=$("$NODE" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).file)' "$OUT/P04.capture-binding.json")
[[ "$P04_CAPTURE_RATE_MODE" = zero || "$P04_CAPTURE_RATE_MODE" = original ]]
fresh_environment
ENV+=("P04_CAPTURE_RATE_MODE=$P04_CAPTURE_RATE_MODE")
ENV+=("AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE=$P04_NATIVE_FILE")
# Preserve the original 600s phase cap and source's 60s case/30s hooks/10s operations.
test_file=tests/integration/cdp-recovery.test.ts
pattern='^CDP session recovery > keeps the exact page, document state, storage, viewport, routes, and dialog handlers$'
if [[ "$COMPARISON_CELL" = D ]]; then
  test_file=tests/integration/cdp-recovery-direct.test.ts
  pattern='^CDP session recovery > DIAGNOSTIC D: keeps the exact page, document state, storage, viewport, routes, and dialog handlers$'
else test "$COMPARISON_CELL" = N; fi
(cd "$REPO/packages/web" && observed_command P04 /usr/bin/timeout --foreground --signal=TERM --kill-after=5s 600 \
  "$NODE" "$REPO/packages/web/node_modules/vitest/vitest.mjs" run --project integration --maxWorkers=2 --bail=0 \
  --reporter=verbose --reporter=json "--outputFile.json=$OUT/P04.vitest.json" \
  --testNamePattern "$pattern" "$test_file")
# Reuse the exact report-selection predicate and process cleanup predicate; no full333 reconciliation.
"$NODE" --input-type=module - "$HERE/runtime.mjs" "$OUT" "$REPO" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [helper,out,repo]=process.argv.slice(2);
const {selectedReport,pins}=await import(pathToFileURL(helper));
const load=name=>JSON.parse(readFileSync(`${out}/${name}`));
const source=`${repo}/packages/web/tests/integration/cdp-recovery.test.ts`;
assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),pins.p04SourceSha256);
const report=load('P04.vitest.json');
const cell=process.env.COMPARISON_CELL;assert.ok(['N','D'].includes(cell));
assert.equal(report.testResults.length,1);assert.equal(report.testResults[0].name,cell==='N'?source:`${repo}/packages/web/tests/integration/cdp-recovery-direct.test.ts`);
const selected=selectedReport(report,(cell==='D'?'DIAGNOSTIC D: ':'')+'keeps the exact page, document state, storage, viewport, routes, and dialog handlers');
const observed=load('P04.processes.jsonl.summary.json');
const observerExit=Number(readFileSync(`${out}/P04.observer.exit`,'utf8'));
const cleanupConfirmed=observerExit===0&&Array.isArray(observed?.errors)&&observed.errors.length===0
  &&Array.isArray(observed?.remainingObservedAtStop)&&observed.remainingObservedAtStop.length===0;
const rows=readFileSync(`${out}/P04.processes.jsonl`,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
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
const exit=Number(readFileSync(`${out}/P04.exit`,'utf8'));
const direct=cell==='D'?selected.meta?.p04DirectDiagnostic??null:null;
const result={caseId:'P04',cell,originalP04Acceptance:cell==='N'?selected.status:'not-applicable-diagnostic-replacement',direct,selected,exit,cleanupConfirmed,productionObserved,browserRootLifetimes:browserLifetimes.size,
  testSource:{sha:pins.e2eSha,tree:pins.e2eTree},artifactBuildE2e:{sha:pins.production.e2eSha,tree:pins.production.e2eTree},
  fullNativeSuitePassed:false,full333Complete:false,releaseEligible:false,
  pageCountClaim:'unchanged original unique-marker witness and same-URL second-tab assertions; no new page inventory'};
writeFileSync(`${out}/P04.focused-result.json`,JSON.stringify(result,null,2)+'\n');
if(cell==='D') {assert.equal(direct?.rateMode,process.env.P04_CAPTURE_RATE_MODE);const {validDirectResult}=await import(pathToFileURL(helper.replace('runtime.mjs','direct-capture.mjs')));assert.equal(validDirectResult(direct),true,'D evidence missing/unknown/failed; never original P04 acceptance');}
assert.equal(selected.selectionExact,true);assert.equal(selected.status,'passed');assert.equal(selected.success,true);assert.equal(exit,0);
assert.equal(cleanupConfirmed,true);assert.equal(productionObserved,true);assert.equal(browserLifetimes.size,1);
assert.ok(browsers.every(row=>row.expectedHashMatches===true));
JS
