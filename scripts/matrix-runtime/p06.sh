#!/usr/bin/env bash
# Focused P06; unchanged matrix environment/process observer and original source test.
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
    "E2E_AGENT_BROWSER_EXECUTABLE=$PRODUCTION" E2E_TELEMETRY_DISABLED=1 E2E_UPDATE_CHECK_DISABLED=1 E2E_CACHE_DIR=
    "AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE=$OUT/P06.native.jsonl")
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

node "$HERE/../runtime-probe/runtime.mjs" sources
node "$HERE/../runtime-probe/runtime.mjs" browser
# Match the existing HTTP500 exclusive invocation receipt before spawning any runtime.
node --input-type=module - "$OUT/selection.json" "$HERE/../runtime-probe/runtime.mjs" <<'JS'
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {pins}=await import(pathToFileURL(process.argv[3]));
writeFileSync(process.argv[2],JSON.stringify({scope:'P06-single-pass-paired-Web-comparison',caseIds:['P06'],runtimeCell:pins.runtimeCell,runtimeWebSource:{sha:pins.e2eSha,tree:pins.e2eTree}})+'\n',{flag:'wx',mode:0o600});
JS
# Existing native closed, bounded diagnostic carrier only; never an acceptance gate.
node --input-type=module - "$OUT" "$HERE/../runtime-probe/runtime.mjs" <<'JS'
import assert from 'node:assert/strict';
import {lstatSync,realpathSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [out,helper]=process.argv.slice(2); const {pins}=await import(pathToFileURL(helper));
const directory=lstatSync(out); assert.ok(directory.isDirectory()&&!directory.isSymbolicLink());
assert.equal(directory.uid,process.getuid());assert.equal(directory.mode&0o777,0o700);assert.equal(realpathSync(out),out);
const file=out+'/P06.native.jsonl';writeFileSync(file,'',{flag:'wx',mode:0o600});
const stat=lstatSync(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.mode&0o777,0o600);assert.equal(stat.uid,process.getuid());
writeFileSync(out+'/P06.native-binding.json',JSON.stringify({diagnosticOnly:true,acceptanceGate:false,runtimeCell:pins.runtimeCell,missingRecords:'unknown',caseAssociation:'unproven',processCoverage:'unproven',
  sourceRevision:pins.e2eSha,nativeSourceRevision:pins.nativeSha,testSourceDigest:pins.p06SourceSha256,binarySha256:pins.production.binarySha256,
  file,device:stat.dev,inode:stat.ino,initialBytes:stat.size,format:'existing native schema2 closed bounded JSONL; ScreenshotFirstFailure/CleanupFirstFailure retained if emitted'})+'\n',{flag:'wx',mode:0o600});
JS
fresh_environment
# Preserve the original 600s phase cap and source's 60s case/30s hooks/10s operations.
pattern='^CDP session recovery > fails an uncertain click without reconnecting or dispatching it twice$'
(cd "$REPO/packages/web" && observed_command P06 /usr/bin/timeout --foreground --signal=TERM --kill-after=5s 600 \
  "$NODE" "$REPO/packages/web/node_modules/vitest/vitest.mjs" run --project integration --maxWorkers=2 --bail=0 \
  --reporter=verbose --reporter=json "--outputFile.json=$OUT/P06.vitest.json" \
  --testNamePattern "$pattern" tests/integration/cdp-recovery.test.ts)
# Reuse the exact report-selection predicate and process cleanup predicate; no full333 reconciliation.
"$NODE" --input-type=module - "$HERE/../runtime-probe/runtime.mjs" "$OUT" "$REPO" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [helper,out,repo]=process.argv.slice(2);
const {selectedReport,pins}=await import(pathToFileURL(helper));
const load=name=>JSON.parse(readFileSync(`${out}/${name}`));
const source=`${repo}/packages/web/tests/integration/cdp-recovery.test.ts`;
assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),pins.p06SourceSha256);
const report=load('P06.vitest.json');
assert.equal(report.testResults.length,1);assert.equal(report.testResults[0].name,source);
const selected=selectedReport(report,'fails an uncertain click without reconnecting or dispatching it twice');
const observed=load('P06.processes.jsonl.summary.json');
const observerExit=Number(readFileSync(`${out}/P06.observer.exit`,'utf8'));
const cleanupConfirmed=observerExit===0&&Array.isArray(observed?.errors)&&observed.errors.length===0
  &&Array.isArray(observed?.remainingObservedAtStop)&&observed.remainingObservedAtStop.length===0;
const rows=readFileSync(`${out}/P06.processes.jsonl`,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
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
const exit=Number(readFileSync(`${out}/P06.exit`,'utf8'));
const result={caseId:'P06',runtimeCell:pins.runtimeCell,selected,exit,cleanupConfirmed,productionObserved,browserRootLifetimes:browserLifetimes.size,
  testSource:{sha:pins.e2eSha,tree:pins.e2eTree},artifactBuildE2e:{sha:pins.production.e2eSha,tree:pins.production.e2eTree},
  fullNativeSuitePassed:false,full333Complete:false,releaseEligible:false,
  pageCountClaim:'unchanged original single-marker witness only; no new page inventory or diagnostics'};
writeFileSync(`${out}/P06.focused-result.json`,JSON.stringify(result,null,2)+'\n');
assert.equal(selected.selectionExact,true);assert.equal(selected.status,'passed');assert.equal(selected.success,true);assert.equal(exit,0);
assert.equal(cleanupConfirmed,true);assert.equal(productionObserved,true);assert.equal(browserLifetimes.size,1);
assert.ok(browsers.every(row=>row.expectedHashMatches===true));
JS
