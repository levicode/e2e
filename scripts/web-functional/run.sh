#!/usr/bin/env bash
# Diagnostic orchestration only. Product tests, assertions and budgets are unchanged.
set -euo pipefail
mode=${1:?mode}; root="$GITHUB_WORKSPACE/source"; out="$GITHUB_WORKSPACE/evidence"
mkdir -p "$out"
export E2E_TELEMETRY_DISABLED=1 E2E_UPDATE_CHECK_DISABLED=1 NEXT_TELEMETRY_DISABLED=1
export E2E_AGENT_BROWSER_EXECUTABLE="$GITHUB_WORKSPACE/images/production"
export PROD="$E2E_AGENT_BROWSER_EXECUTABLE" FAULT="$GITHUB_WORKSPACE/images/acceptance-faults"
export PROOF="$out/negotiation.json" FAULT_PROOF="$out/fault-negotiation.json"
cd "$root"
# This is not a full-candidate receipt. Known untested semantics remain visible.
cat > "$out/scope.txt" <<'SCOPE'
DIAGNOSTIC ONLY; no release/acceptance claim; no imported prior passes.
Native 0eafeb33ee8b5749c8a82f527007e8ae0c1ac0cc; E2E 8dbffaee4b4be9edc2d4647273761b535534a840.
NOT RUN (excluded scope): activated beforeunload tests: leaves host untouched first open/video; registered dialog before provider recording; unhandled beforeunload first open/video.
NOT RUN (excluded scope): protected-app service-worker registration P41.
NOT RUN: native auto-discovery, optional benchmark sweep, iOS, macOS.
BLOCKED/NOT RUN: final producer, package-bundle and installed-package acceptance. Original final gates are unchanged.
Known unresolved public semantics, NOT cleared by this matrix: pointer position preservation; stale-reference mapping after focus/reset.
Legacy/oracle results (including observation.test.ts and read-node-names.test.ts) are reference results, not native implementation proof.
SCOPE
if [[ "$mode" == setup ]]; then
  test "$(git rev-parse HEAD)" = 8dbffaee4b4be9edc2d4647273761b535534a840
  test -z "$(git status --porcelain)"
  (cd "$GITHUB_WORKSPACE/images"; sha256sum --check SHA256SUMS)
  cp "$GITHUB_WORKSPACE/images/SHA256SUMS" "$out/native-images.sha256"
  chmod +x "$PROD" "$FAULT"
  pnpm install --frozen-lockfile
  pnpm run build
  set +e
  node scripts/acceptance/candidate-source.ts "$out"
  source_status=$?
  set -e
  printf '%s\n' "$source_status" > "$out/source-removal.exit"
  "$PROD" install --with-deps
  pnpm --filter @e2e-dev/web exec playwright-core install chromium
  sudo apt-get update
  sudo apt-get install -y ffmpeg
  ffmpeg -version; ffprobe -version
  chrome="$(node scripts/acceptance/installed-chromium.ts "$HOME/.agent-browser/browsers" "$out/chromium-executable.json")"
  echo "E2E_CHROMIUM_EXECUTABLE=$chrome" >> "$GITHUB_ENV"
  export E2E_CHROMIUM_EXECUTABLE="$chrome"
  "$chrome" --version > "$out/chromium-version.txt"
  ffmpeg -version > "$out/ffmpeg-version.txt"
  node --input-type=module -e "import { REQUIRED_CAPABILITIES } from './packages/web/dist/native/capabilities.js'; console.log(JSON.stringify(REQUIRED_CAPABILITIES))" > "$out/required-capabilities.json"
  node scripts/acceptance/probe-native.ts "$PROD" "$out/required-capabilities.json" "$PROOF"
  node --input-type=module -e "import { REQUIRED_CAPABILITIES } from './packages/web/dist/native/capabilities.js'; console.log(JSON.stringify([...REQUIRED_CAPABILITIES,'acceptance.faults/1']))" > "$out/fault-capabilities.json"
  node scripts/acceptance/probe-native.ts "$FAULT" "$out/fault-capabilities.json" "$FAULT_PROOF"
  exit 0
fi
run_group() {
 case "$mode" in
  callbacks) node scripts/acceptance/candidate-web.ts public-callbacks "$PROD" "$PROOF" "$out" ;;
  web)
   # activatedHost is called only within these five test bodies; shared hooks do not invoke it.
   pnpm --filter @e2e-dev/web exec vitest run --project integration --maxWorkers=2 --bail=0 --reporter=json --outputFile="$out/web-browser.vitest.json" \
    --exclude '**/semantic-fallback.test.ts' --exclude '**/crosscheck.test.ts' --exclude '**/cli.test.ts' \
    --testNamePattern='^(?!.*(?:beforeunload|leaves the host untouched until first (?:open|video) and allows a pre-open dialog handler|activates the borrowed first page through the registered dialog handler before provider recording|blocks service workers under headers)).*$' ;;
  differential) node scripts/acceptance/candidate-web.ts crosscheck-fixtures "$PROD" "$PROOF" "$out" ;;
  semantic) node scripts/acceptance/candidate-web.ts semantic-faults "$FAULT" "$FAULT_PROOF" "$out" ;;
  cli)
   export E2E_INSTALLER_FIXTURE_EXECUTABLE="$FAULT"
   E2E_INSTALLER_FIXTURE_BINDING="$(node --input-type=module -e "import {verifyInstallerFixtureRuntime} from './scripts/acceptance/candidate-web.ts'; import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; const p=process.env; console.log(JSON.stringify(verifyInstallerFixtureRuntime('web-browser',p.FAULT,p.FAULT_PROOF,p.PROD,createHash('sha256').update(readFileSync(p.PROD)).digest('hex')).binding));")" || return $?
   export E2E_INSTALLER_FIXTURE_BINDING
   pnpm --filter @e2e-dev/web exec vitest run --project integration tests/integration/cli.test.ts --maxWorkers=2 --bail=0 --reporter=json --outputFile="$out/cli.vitest.json" ;;
  *) echo "Unknown group: $mode" >&2; return 2 ;;
 esac
}
set +e
run_group 2>&1 | tee "$out/$mode.log"
status=${PIPESTATUS[0]}
set -e
printf '%s\n' "$status" > "$out/$mode.exit"
# Preserve original failure status. Independent groups use different runner VMs.
exit "$status"
