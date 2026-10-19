#!/usr/bin/env bash
set -euo pipefail
# Public maintained extension; never patches the user's global installation.
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SOURCE="${1:-$ROOT/.validation-tools/agent-browser-exact}"
PIN=1165952d74ceed98fdc2dd97190ad41f44dd0e24
if [[ ! -d "$SOURCE/.git" ]]; then
  mkdir -p "$SOURCE"
  git -C "$SOURCE" init
  git -C "$SOURCE" remote add origin https://github.com/vercel-labs/agent-browser.git
  git -C "$SOURCE" fetch --depth=1 origin "$PIN"
  git -C "$SOURCE" checkout --detach FETCH_HEAD
elif [[ "$(git -C "$SOURCE" rev-parse HEAD)" != "$PIN" ]]; then
  echo 'Refusing to patch a different agent-browser checkout' >&2
  exit 1
fi
PATCH="$ROOT/patches/agent-browser-exact-refs.patch"
if git -C "$SOURCE" apply --check "$PATCH"; then
  git -C "$SOURCE" apply "$PATCH"
elif ! git -C "$SOURCE" apply --reverse --check "$PATCH"; then
  echo 'Patch does not apply cleanly; inspect the pinned upstream contract' >&2
  exit 1
fi
cargo test --locked --manifest-path "$SOURCE/cli/Cargo.toml" --bin agent-browser
cargo build --locked --profile ci --manifest-path "$SOURCE/cli/Cargo.toml"
VERSION="$("$SOURCE/cli/target/ci/agent-browser" --version)"
if [[ "$VERSION" != "agent-browser 0.39.1-e2e.4" ]]; then
  echo "Native executable did not report the required maintained version" >&2
  exit 1
fi
printf '%s\n' "$VERSION"
