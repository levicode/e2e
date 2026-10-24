#!/usr/bin/env bash
# Original commands/configs/assertions; diagnostic batches, never candidate-web main.
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
state() {
  "$NODE" --input-type=module - "$OUT/$1.state.json" "$2" "${3:-}" "${4:-}" <<'JS'
import {writeFileSync} from 'node:fs';
const [file,status,reason,exit]=process.argv.slice(2);
writeFileSync(file,JSON.stringify({status,reason:reason||undefined,exitCode:exit===''?undefined:Number(exit)},null,2)+'\n');
JS
}
fresh_environment() {
  ROOT=$(mktemp -d /tmp/em-XXXXXX)
  mkdir -m700 "$ROOT/home" "$ROOT/tmp" "$ROOT/bin" "$ROOT/cache" "$ROOT/s"
  ln -s "$CHROME" "$ROOT/bin/google-chrome"
  test -z "$(ls -A "$ROOT/home")"
  ENV=(env -i "PATH=$ROOT/bin:$BASE_PATH" "HOME=$ROOT/home" CI=1 LANG=C.UTF-8
    "TMPDIR=$ROOT/tmp" "TMP=$ROOT/tmp" "TEMP=$ROOT/tmp" "XDG_CACHE_HOME=$ROOT/cache"
    "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH" "AGENT_BROWSER_SOCKET_DIR=$ROOT/s"
    "E2E_AGENT_BROWSER_EXECUTABLE=$PRODUCTION" E2E_TELEMETRY_DISABLED=1 E2E_UPDATE_CHECK_DISABLED=1 E2E_CACHE_DIR=)
  test "$("${ENV[@]}" /usr/bin/readlink -f "$ROOT/bin/google-chrome")" = "$CHROME"
  test "$("${ENV[@]}" /usr/bin/which ffmpeg)" = /usr/bin/ffmpeg
  test "$("${ENV[@]}" /usr/bin/which ffprobe)" = /usr/bin/ffprobe
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
  # Stop via an owned file, never signal process names/groups/unknown descendants.
  touch "$ROOT/$name.stop"
  wait "$observer"; observer_status=$?
  set -e
  printf '%s\n' "$status" > "$OUT/$name.exit"
  printf '%s\n' "$observer_status" > "$OUT/$name.observer.exit"
  COMMAND_STATUS=$status
}
selectors() {
  "$NODE" --input-type=module - "$HERE" "$OUT" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const [here,out]=process.argv.slice(2);
const {loadManifest,verifyPrior}=await import(pathToFileURL(here+'/prior-artifact.mjs'));
const manifest=loadManifest();
verifyPrior(out+'/prior-run40116161447',manifest);
const require=createRequire(process.env.GITHUB_WORKSPACE+'/e2e-source/packages/web/package.json');
const packageFile=require.resolve('vitest/package.json');
if(JSON.parse(readFileSync(packageFile)).version!=='5.0.1') throw Error('Exact reviewed Vitest5.0.1 required');
const {createTaskName}=await import(pathToFileURL(packageFile.replace('/package.json','/dist/task-utils.js')));
for(const name of ['original-noncli-304','new-4','callbacks-14','cli-installed-1']) {
 const cases=manifest.selected.filter(c=>c.partition===name),prefix=name==='callbacks-14'?'packages/e2e/':'packages/web/';
 if(!cases.length) throw Error('Empty continuation partition');
 writeFileSync(`${out}/${name}.files.txt`,[...new Set(cases.map(c=>c.file.slice(prefix.length)))].sort().join('\n')+'\n');
 const names=cases.map(c=>createTaskName([...c.ancestorTitles,c.title]));
 writeFileSync(`${out}/${name}.regex.txt`,'^(?:'+names.map(name=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')$\n');
}
writeFileSync(out+'/continuation-selection.json',JSON.stringify({priorRun:manifest.prior.runId,selected:manifest.selected,retained:manifest.retained,P14:'not-run',sameExecution:false},null,2)+'\n');
JS
}
run_batch() {
  local name=$1 package=$2; local -a files
  mapfile -t files < "$OUT/$name.files.txt"
  state "$name" running
  (cd "$REPO/packages/$package" && observed_command "$name" /usr/bin/timeout --foreground --signal=TERM --kill-after=5s 1800 \
    "$NODE" "$REPO/packages/$package/node_modules/vitest/vitest.mjs" run --project integration --maxWorkers=2 --bail=0 \
    --reporter=verbose --reporter=json "--outputFile.json=$OUT/$name.vitest.json" \
    --testNamePattern "$(cat "$OUT/$name.regex.txt")" "${files[@]}")
  state "$name" finished '' "$(cat "$OUT/$name.exit")"
}
case "${1:-}" in
  probe)
    fresh_environment
    # The unmodified probe itself creates a fresh short /tmp/abp-* hostile-config HOME.
    # Its surrounding env remains clean, PATH-pinned and disjoint from installer HOME.
    cd "$REPO"
    "$NODE" --input-type=module -e 'import {REQUIRED_CAPABILITIES} from "./packages/web/dist/native/capabilities.js";console.log(JSON.stringify(REQUIRED_CAPABILITIES))' > "$OUT/required-capabilities.json"
    observed_command production-probe "E2E_CHROMIUM_EXECUTABLE=$CHROME" /usr/bin/timeout --foreground --signal=TERM --kill-after=5s 1800 \
      "$NODE" scripts/acceptance/probe-native.ts "$PRODUCTION" "$OUT/required-capabilities.json" "$OUT/production-negotiation.json"
    test "$COMMAND_STATUS" = 0
    "$NODE" "$HERE/identity.mjs" verify-proof
    ;;
  cases)
    # Reverify the genuinely generated proof. An old or fabricated receipt never substitutes.
    "$NODE" "$HERE/identity.mjs" verify-proof
    selectors
    state cli-cancel-P14-1 not-run 'Missing separate native2647 acceptance-faults artifact and genuine matching proof; production-only recipe never runs P14'
    for group in original-noncli-304 new-4 callbacks-14 cli-installed-1; do state "$group" not-run 'Batch has not started'; done
    for group in original-noncli-304 new-4 callbacks-14; do
      fresh_environment
      package=web; [[ "$group" == callbacks-14 ]] && package=e2e
      run_batch "$group" "$package"
    done
    # This separate HOME is populated only by the actual unmodified native installer.
    # Official Stable manifest/archive traffic is explicit, not called loopback-only.
    fresh_environment
    observed_command official-install /usr/bin/timeout --foreground --signal=TERM --kill-after=5s 1800 "$PRODUCTION" install
    if [[ "$COMMAND_STATUS" == 0 ]]; then
      if "${ENV[@]}" "$NODE" "$REPO/scripts/acceptance/installed-chromium.ts" "$ROOT/home/.agent-browser/browsers" "$OUT/cli-cache-before.json" > "$OUT/cli-cache-executable.txt" 2> "$OUT/cli-cache-preflight.stderr"; then
        CACHE_CHROME=$(cat "$OUT/cli-cache-executable.txt")
        "${ENV[@]}" "$CACHE_CHROME" --version > "$OUT/cli-cache-version.txt"
        run_batch cli-installed-1 web
        set +e
        "${ENV[@]}" "$NODE" "$REPO/scripts/acceptance/installed-chromium.ts" "$ROOT/home/.agent-browser/browsers" "$OUT/cli-cache-after.json" > "$OUT/cli-cache-executable-after.txt" 2> "$OUT/cli-cache-final.stderr"
        CACHE_STATUS=$?
        if [[ "$CACHE_STATUS" == 0 ]]; then cmp "$OUT/cli-cache-before.json" "$OUT/cli-cache-after.json"; CACHE_STATUS=$?; fi
        printf '%s\n' "$CACHE_STATUS" > "$OUT/cli-cache-unchanged.exit"
        set -e
      else
        state cli-installed-1 not-run 'Real official installer returned success but valid exact cache identity was not established'
      fi
    else
      state cli-installed-1 not-run 'Official native install precondition failed; inspect official-install exit and log'
    fi
    ;;
  *) printf '%s\n' 'Explicit probe or cases command required' >&2; exit 2 ;;
esac
