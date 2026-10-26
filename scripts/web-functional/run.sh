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
Native 70ac7f3fb2a53de79c5fabf43b5009b7e5fefebb; E2E 26dd30fd149f0b055bdfdbd789cd1c7490591e0b.
NOT RUN (excluded scope): activated beforeunload tests: leaves host untouched first open/video; registered dialog before provider recording; unhandled beforeunload first open/video.
NOT RUN (excluded scope): protected-app service-worker registration P41.
NOT RUN: native auto-discovery, optional benchmark sweep, iOS.
macOS: separate diagnostic override-build jobs only; no full macOS acceptance claim.
BLOCKED/NOT RUN: final producer, package-bundle and no-override installed-package acceptance. Original final gates are unchanged.
Final acceptance/retirement evidence for pointer position preservation and stale-reference mapping after focus/reset is NOT established by this diagnostic matrix.
Legacy/oracle results (including observation.test.ts and read-node-names.test.ts) are reference results, not native implementation proof.
SCOPE
if [[ "$mode" == setup ]]; then
  # Public .deb cache: producer may seed pinned prior bytes, then apt validates current requirements.
  # Repository/trust/signature settings and product tests remain unchanged.
  cache="$GITHUB_WORKSPACE/apt-cache"
  cache_config=/etc/apt/apt.conf.d/99-e2e-diagnostic-cache
  case "${E2E_APT_CACHE_ROLE:?missing cache role}" in
    produce) mkdir -p "$cache" ;;
    consume)
      python3 - "$cache" <<'PY_VERIFY_CACHE'
import hashlib, json, os, pathlib, re, subprocess, sys
root = pathlib.Path(sys.argv[1])
meta = json.loads((root / 'cache-metadata.json').read_text())
assert meta['runId'] == os.environ['GITHUB_RUN_ID']
assert meta['runAttempt'] == os.environ['GITHUB_RUN_ATTEMPT']
assert meta['architecture'] == subprocess.check_output(['dpkg', '--print-architecture'], text=True).strip()
assert meta['packageCount'] > 0
lines = (root / 'SHA256SUMS').read_text().splitlines()
assert len(lines) == meta['packageCount']
assert {line.split('  ', 1)[1] for line in lines} == {f.name for f in root.glob('*.deb')}
for line in lines:
    digest, name = line.split('  ', 1)
    assert re.fullmatch(r'[A-Za-z0-9.+%_~:-]+\.deb', name), name
    f = root / name
    assert f.is_file() and not f.is_symlink()
    assert hashlib.sha256(f.read_bytes()).hexdigest() == digest, name
print(f"Verified {len(lines)} same-run package archives; apt still verifies its official indexes.")
PY_VERIFY_CACHE
      ;;
    *) echo 'Invalid apt cache role' >&2; exit 2 ;;
  esac
  sudo test ! -e "$cache_config"
  printf 'Dir::Cache::archives "%s";\nAPT::Keep-Downloaded-Packages "true";\nBinary::apt-get::APT::Keep-Downloaded-Packages "true";\n' "$cache" | sudo tee "$cache_config" >/dev/null
  trap 'sudo rm -f -- "$cache_config"' EXIT
  sudo install -d -o _apt -g root -m 0700 "$cache/partial"
  test "$(git rev-parse HEAD)" = 26dd30fd149f0b055bdfdbd789cd1c7490591e0b
  test "$(git rev-parse HEAD^{tree})" = a9e6b13236b45daebc19399a417bb72104d555b0
  test -z "$(git status --porcelain)"
  (cd "$GITHUB_WORKSPACE/images"; sha256sum --check SHA256SUMS)
  cp "$GITHUB_WORKSPACE/images/SHA256SUMS" "$out/native-images.sha256"
  chmod +x "$PROD" "$FAULT"
  pnpm install --frozen-lockfile
  pnpm run build
  pnpm --filter @e2e-dev/web exec vitest run --project unit tests/unit/native-document.test.ts --maxWorkers=1 --bail=0 --reporter=verbose --reporter=json --outputFile="$out/native-document.vitest.json" 2>&1 | tee "$out/native-document.log"
  pnpm --filter @e2e-dev/web exec vitest run --project unit tests/unit/native-terminal-close-observer.test.ts tests/unit/synthetic-native-outcomes.test.ts --maxWorkers=1 --bail=0 --reporter=verbose --reporter=json --outputFile="$out/terminal-observer.vitest.json" 2>&1 | tee "$out/terminal-observer.log"
  set +e
  node scripts/acceptance/candidate-source.ts "$out"
  source_status=$?
  set -e
  printf '%s\n' "$source_status" > "$out/source-removal.exit"
  "$PROD" install --with-deps
  pnpm --filter @e2e-dev/web exec playwright-core install chromium
  if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
    sudo apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update
    sudo apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 install -y ffmpeg
  fi
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
  if [[ "$E2E_APT_CACHE_ROLE" == produce ]]; then
    python3 - "$cache" <<'PY_SAVE_CACHE'
import hashlib, json, os, pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1]); files = sorted(root.glob('*.deb'))
if not files: raise SystemExit('No package archives were retained; cache was NOT produced')
for f in files:
    assert f.is_file() and not f.is_symlink()
(root / 'SHA256SUMS').write_text(''.join(hashlib.sha256(f.read_bytes()).hexdigest() + '  ' + f.name + '\n' for f in files))
meta = {'schemaVersion': 1, 'runId': os.environ['GITHUB_RUN_ID'], 'runAttempt': os.environ['GITHUB_RUN_ATTEMPT'], 'architecture': subprocess.check_output(['dpkg', '--print-architecture'], text=True).strip(), 'packageCount': len(files), 'source': 'unchanged official apt repositories; apt authentication retained', 'productTestPass': False}
if (root / 'seed-source.json').is_file(): meta['seedSource'] = json.loads((root / 'seed-source.json').read_text())
(root / 'cache-metadata.json').write_text(json.dumps(meta, indent=2) + '\n')
print(f'Prepared {len(files)} public package archives after successful current setup; seed provenance retained')
PY_SAVE_CACHE
  fi
  exit 0
fi
run_group() {
 case "$mode" in
  callbacks) node scripts/acceptance/candidate-web.ts public-callbacks "$PROD" "$PROOF" "$out" ;;
  web)
   # Raw bounded native metadata only; not a cleanup success/acceptance receipt.
   node --input-type=module -e "import {openSync,closeSync,writeFileSync} from 'node:fs'; closeSync(openSync(process.argv[1], 'wx', 0o600)); writeFileSync(process.argv[2], JSON.stringify({schemaVersion:1,status:'prepared',validation:'raw-not-validated',releaseEligible:false})+'\\n', {flag:'wx',mode:0o600});" "$out/web.cleanup.jsonl" "$out/web.cleanup.status.json" || return $?
   # activatedHost is called only within these five test bodies; shared hooks do not invoke it.
   AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE="$out/web.cleanup.jsonl" pnpm --filter @e2e-dev/web exec vitest run --project integration --maxWorkers=2 --bail=0 --reporter=verbose --reporter=json --outputFile="$out/web-browser.vitest.json" \
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
