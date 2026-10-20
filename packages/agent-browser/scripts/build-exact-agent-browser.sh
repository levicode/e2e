#!/usr/bin/env bash
set -euo pipefail
# Build the reviewed fork commit; never patch a checkout or a global installation.
if [[ "$#" -gt 1 ]]; then
  echo 'Usage: build-exact-agent-browser.sh [source-directory]' >&2
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SOURCE="${1:-$ROOT/.validation-tools/agent-browser-exact}"
VALIDATOR="$ROOT/packages/agent-browser/scripts/native-source.ts"
LOCK_VALUES="$(node "$VALIDATOR" lock-values)"
read -r REPOSITORY PIN VERSION RUSTUP_TOOLCHAIN <<< "$LOCK_VALUES"
if [[ ! -e "$SOURCE/.git" ]]; then
  if [[ -e "$SOURCE" && ( ! -d "$SOURCE" || -n "$(ls -A "$SOURCE")" ) ]]; then
    echo 'Refusing to initialize native source in a nonempty directory' >&2
    exit 1
  fi
  mkdir -p "$SOURCE"
  git -C "$SOURCE" init
  git -C "$SOURCE" remote add origin "$REPOSITORY"
  git -C "$SOURCE" fetch --depth=1 origin "$PIN"
  git -C "$SOURCE" checkout --detach "$PIN"
fi
node "$VALIDATOR" verify "$SOURCE"
if [[ "$SOURCE" == "$ROOT/.validation-tools/agent-browser-exact" ]]; then
  bash "$ROOT/packages/agent-browser/scripts/cache-native-dependencies.sh" restore maintained
fi
export RUSTUP_TOOLCHAIN
node "$VALIDATOR" toolchain
# Do not retain a success stamp if any subsequent test or build fails.
rm -f "$SOURCE/cli/target/ci/e2e-native-build.json"
# Keep the isolated inherited-CDP launch-safety assertion visible even if a later
# test aborts the harness. The complete suite still runs after a focused failure.
focused_status=0
cargo test --profile ci --locked --target-dir "$SOURCE/cli/target" --manifest-path "$SOURCE/cli/Cargo.toml" --bin agent-browser \
  native::e2e_tests::test_obscura_e2e_unlaunchable_binary_does_not_attach_to_inherited_cdp \
  -- --exact --nocapture --test-threads=1 || focused_status=$?
# Inherited tests share process-global environment; concurrency within each test remains intact.
suite_status=0
cargo test --profile ci --locked --target-dir "$SOURCE/cli/target" --manifest-path "$SOURCE/cli/Cargo.toml" --bin agent-browser -- --test-threads=1 || suite_status=$?
if [[ "$focused_status" != 0 || "$suite_status" != 0 ]]; then
  echo 'Native launch-safety or complete-suite validation failed' >&2
  exit 1
fi
rm -f "$SOURCE/cli/target/ci/agent-browser"
cargo build --locked --profile ci --target-dir "$SOURCE/cli/target" --manifest-path "$SOURCE/cli/Cargo.toml"
ACTUAL_VERSION="$("$SOURCE/cli/target/ci/agent-browser" --version)"
if [[ "$ACTUAL_VERSION" != "agent-browser $VERSION" ]]; then
  echo "Native executable did not report the required maintained version" >&2
  exit 1
fi
node "$VALIDATOR" stamp "$SOURCE"
printf '%s\n' "$ACTUAL_VERSION"
