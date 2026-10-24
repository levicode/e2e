#!/usr/bin/env bash
# Original commands/configs/assertions; candidate-web only for genuine web-unit prerequisite.
set -euo pipefail
umask 077
: "${GITHUB_WORKSPACE:?}" "${EVIDENCE_DIR:?}" "${PLAYWRIGHT_BROWSERS_PATH:?}"
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO="$GITHUB_WORKSPACE/e2e-source"
PRODUCTION="$GITHUB_WORKSPACE/agent-browser"
FAULT="$GITHUB_WORKSPACE/agent-browser-acceptance-faults"
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
  test ! -e "$ROOT/home/.agent-browser/browsers"
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
selectors() {
  "$NODE" "$HERE/selection.mjs" "$REPO" "$OUT"
}
observed_cleanup_check() {
  "$NODE" --input-type=module - "$HERE/identity.mjs" "$OUT/$1.processes.jsonl.summary.json" "$(cat "$OUT/$1.observer.exit")" <<'JS'
import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; import {pathToFileURL} from 'node:url';
const {observedCleanupConfirmed}=await import(pathToFileURL(process.argv[2]));
const value=JSON.parse(readFileSync(process.argv[3]));
assert.equal(observedCleanupConfirmed(value,Number(process.argv[4])),true,'Observer error or owned marked process still observed: stop, do not signal unknown processes');
JS
  test "$(cat "$OUT/$1.observer.exit")" = 0
}
run_batch() {
  local name=$1 package=$2 cap; local -a files project=() command
  case "$name" in
    priority-upstream-5) cap=300 ;;
    paired-canvas-2) cap=180 ;;
    new-controls-3) cap=300 ;;
    priority-old-failures-6|decision-cli-4) cap=600 ;;
    original-remaining-296|callbacks-14) cap=1800 ;;
    cli-installed-1|cli-cancel-P14-1) cap=180 ;;
    *) printf 'Unknown exact phase: %s\n' "$name" >&2; return 2 ;;
  esac
  mapfile -t files < "$OUT/$name.files.txt"
  [[ "$package" == decision ]] || project=(--project integration)
  command=("$NODE" "$REPO/packages/$package/node_modules/vitest/vitest.mjs" run "${project[@]}" --maxWorkers=2 --bail=0
    --reporter=verbose --reporter=json "--outputFile.json=$OUT/$name.vitest.json"
    --testNamePattern "$(cat "$OUT/$name.regex.txt")" "${files[@]}")
  if [[ "$name" == cli-cancel-P14-1 ]]; then
    command=("$NODE" "$HERE/p14.mjs" "$REPO" "$PRODUCTION" "$FAULT" "$OUT/fault-negotiation.json" "$OUT/P14-installer-binding.json" "${command[@]}")
  fi
  if [[ "$name" == paired-canvas-2 ]]; then
    command=("$NODE" "$HERE/canvas-pair.mjs" run "$REPO" "$PRODUCTION" "$FAULT" "$OUT/production-negotiation.json" "$OUT/fault-negotiation.json" "$OUT" "${command[@]}")
  fi
  state "$name" running
  (cd "$REPO/packages/$package" && observed_command "$name" /usr/bin/timeout --foreground --signal=TERM --kill-after=5s "$cap" "${command[@]}")
  state "$name" finished '' "$(cat "$OUT/$name.exit")"
  observed_cleanup_check "$name"
  "$NODE" "$HERE/reconcile.mjs" "$HERE/runtime-manifest.json" "$OUT" "$REPO" "$name"
}
case "${1:-}" in
  probe)
    cd "$REPO"
    "$NODE" --input-type=module -e 'import {REQUIRED_CAPABILITIES} from "./packages/web/dist/native/capabilities.js";console.log(JSON.stringify(REQUIRED_CAPABILITIES))' > "$OUT/required-capabilities.json"
    "$NODE" --input-type=module -e 'import {REQUIRED_CAPABILITIES} from "./packages/web/dist/native/capabilities.js";console.log(JSON.stringify([...REQUIRED_CAPABILITIES,"acceptance.faults/1"]))' > "$OUT/fault-capabilities.json"
    for label in production fault; do
      fresh_environment
      binary="$PRODUCTION"; capabilities="$OUT/required-capabilities.json"; verify=verify-proof
      if [[ "$label" == fault ]]; then binary="$FAULT"; capabilities="$OUT/fault-capabilities.json"; verify=verify-fault-proof; fi
      observed_command "$label-probe" "E2E_CHROMIUM_EXECUTABLE=$CHROME" /usr/bin/timeout --foreground --signal=TERM --kill-after=5s 300         "$NODE" scripts/acceptance/probe-native.ts "$binary" "$capabilities" "$OUT/$label-negotiation.json"
      test "$COMMAND_STATUS" = 0
      observed_cleanup_check "$label-probe"
      "$NODE" "$HERE/identity.mjs" "$verify"
    done
    ;;
  cases)
    "$NODE" "$HERE/identity.mjs" verify-proof
    "$NODE" "$HERE/identity.mjs" verify-fault-proof
    selectors
    # P41's original reporter/exit was imported from the same-run focused runner.
    "$NODE" "$HERE/reconcile.mjs" "$HERE/runtime-manifest.json" "$OUT" "$REPO" priority-p41-1
    # Existing wrapper executes only suite web-unit and verifies the already produced proof.
    # It does not launch probe/installer/browser stages; no stdout-derived receipt is manufactured.
    fresh_environment
    test ! -e "$REPO/.artifacts/native-candidate/web-unit.result.json"
    observed_command canvas-web-unit /usr/bin/timeout --foreground --signal=TERM --kill-after=5s 600 "$NODE" "$REPO/scripts/acceptance/candidate-web.ts" web-unit "$PRODUCTION" "$OUT/production-negotiation.json" "$REPO/.artifacts/native-candidate"
    for kind in result vitest; do [[ ! -e "$REPO/.artifacts/native-candidate/web-unit.$kind.json" ]] || cp "$REPO/.artifacts/native-candidate/web-unit.$kind.json" "$OUT/canvas-web-unit.$kind.json"; done
    test "$COMMAND_STATUS" = 0
    observed_cleanup_check canvas-web-unit
    for group in priority-upstream-5 priority-old-failures-6 original-remaining-296 paired-canvas-2 new-controls-3 callbacks-14; do
      fresh_environment
      package=web; [[ "$group" == callbacks-14 ]] && package=e2e
      run_batch "$group" "$package"
    done
    "$NODE" "$HERE/canvas-pair.mjs" verify "$REPO" "$PRODUCTION" "$FAULT" "$OUT/production-negotiation.json" "$OUT/fault-negotiation.json" "$OUT"
    fresh_environment
    observed_command official-install /usr/bin/timeout --foreground --signal=TERM --kill-after=5s 1800 "$PRODUCTION" install
    observed_cleanup_check official-install
    if [[ "$COMMAND_STATUS" == 0 ]]; then
      if "${ENV[@]}" "$NODE" "$REPO/scripts/acceptance/installed-chromium.ts" "$ROOT/home/.agent-browser/browsers" "$OUT/cli-cache-before.json" > "$OUT/cli-cache-executable.txt" 2> "$OUT/cli-cache-preflight.stderr"; then
        CACHE_CHROME=$(cat "$OUT/cli-cache-executable.txt")
        "${ENV[@]}" "$CACHE_CHROME" --version > "$OUT/cli-cache-version.txt"
        "${ENV[@]}" /usr/bin/ldd "$CACHE_CHROME" > "$OUT/cli-cache.ldd.txt" 2>&1
        ! grep -Fq 'not found' "$OUT/cli-cache.ldd.txt"
        run_batch cli-installed-1 web
        set +e
        "${ENV[@]}" "$NODE" "$REPO/scripts/acceptance/installed-chromium.ts" "$ROOT/home/.agent-browser/browsers" "$OUT/cli-cache-after.json" > "$OUT/cli-cache-executable-after.txt" 2> "$OUT/cli-cache-final.stderr"
        CACHE_STATUS=$?
        if [[ "$CACHE_STATUS" == 0 ]]; then cmp "$OUT/cli-cache-before.json" "$OUT/cli-cache-after.json"; CACHE_STATUS=$?; fi
        printf '%s\n' "$CACHE_STATUS" > "$OUT/cli-cache-unchanged.exit"
        set -e
        test "$CACHE_STATUS" = 0
      else
        state cli-installed-1 not-run 'Official installer did not establish a verified exact warm-cache identity'
      fi
    else
      state cli-installed-1 not-run 'Official native install failed; no fake warm cache'
    fi
    fresh_environment
    "$NODE" "$HERE/identity.mjs" verify-fault-proof
    run_batch cli-cancel-P14-1 web
    fresh_environment
    run_batch decision-cli-4 decision
    ;;
  *) printf '%s\n' 'Explicit probe or cases command required' >&2; exit 2 ;;
esac
