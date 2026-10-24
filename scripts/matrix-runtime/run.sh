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
  "$NODE" "$HERE/selection.mjs" "$REPO" "$OUT" --first-cause-two
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
    first-cause-P01|first-cause-P04) cap=$((CAPTURE_DEADLINE-SECONDS)); (( cap > 0 )) || return 124 ;;
    priority-p41-1) cap=150 ;;
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
  [[ "$name" =~ ^first-cause-P(01|04)$ && "$package" == web ]] || { printf 'Only original P01/P04 allowed\n' >&2; return 2; }
  command=("$NODE" "$HERE/first-cause.mjs" run "${name#first-cause-}" "$REPO" "$PRODUCTION" "$FAULT" "$OUT/production-negotiation.json" "$OUT/fault-negotiation.json" "$OUT/$name-capture" "${command[@]}")
  state "$name" running
  (cd "$REPO/packages/$package" && observed_command "$name" /usr/bin/timeout --foreground --signal=TERM --kill-after=5s "$cap" "${command[@]}")
  state "$name" finished '' "$(cat "$OUT/$name.exit")"
  observed_cleanup_check "$name"
}
case "${1:-}" in
  cases)
    "$NODE" "$HERE/identity.mjs" verify-proof
    "$NODE" "$HERE/identity.mjs" verify-fault-proof
    selectors
    # Two separate case-local sinks, one unchanged total 600s outer allowance.
    CAPTURE_DEADLINE=$((SECONDS+600)); first_status=0
    for id in P01 P04; do
      name="first-cause-$id"
      fresh_environment
      mkdir -m700 "$OUT/$name-capture"
      set +e
      (set -e; run_batch "$name" web)
      safety_status=$?
      set -e
      status=$(cat "$OUT/$name.exit" 2>/dev/null || printf '%s' "$safety_status")
      if [[ "$first_status" == 0 && "$status" != 0 ]]; then first_status=$status; fi
      # Diagnostic UNKNOWN does not stop P04. Existing identity/residue failures do.
      if [[ "$safety_status" != 0 ]]; then [[ "$first_status" != 0 ]] || first_status=$safety_status; break; fi
    done
    # Preserve the earliest original Vitest failure, including body/finally failures.
    exit "$first_status"
    ;;
  *) printf '%s\n' 'Only explicit cases command permitted' >&2; exit 2 ;;
esac
