#!/usr/bin/env bash
set -euo pipefail

# The comparison oracle is an unmodified official checkout, never a runtime mode
# or a patched copy of the maintained executable.
if [[ "$#" -ne 0 ]]; then
  echo 'Usage: build-upstream-agent-browser.sh' >&2
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SOURCE="$ROOT/.validation-tools/agent-browser-upstream"
LOCK="$ROOT/packages/agent-browser/native-source.lock.json"
LOCK_VALUES="$(node --input-type=module - "$LOCK" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const lock = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(lock.schemaVersion, 1, 'Unsupported native source lock schema');
assert.equal(lock.upstreamRepository, 'https://github.com/vercel-labs/agent-browser.git');
assert.match(lock.upstreamBase, /^[a-f0-9]{40}$/);
assert.ok(!/^0+$/.test(lock.upstreamBase), 'Upstream base must be a nonzero commit');
process.stdout.write(`${lock.upstreamRepository} ${lock.upstreamBase} ${lock.rustToolchain}\n`);
NODE
)"
read -r REPOSITORY PIN RUSTUP_TOOLCHAIN <<< "$LOCK_VALUES"

export RUSTUP_TOOLCHAIN
node "$ROOT/packages/agent-browser/scripts/native-source.ts" toolchain

if [[ ! -e "$SOURCE/.git" ]]; then
  if [[ -e "$SOURCE" && ( ! -d "$SOURCE" || -n "$(ls -A "$SOURCE")" ) ]]; then
    echo 'Refusing to initialize upstream source in a nonempty directory' >&2
    exit 1
  fi
  mkdir -p "$SOURCE"
  git -C "$SOURCE" init
  git -C "$SOURCE" remote add origin "$REPOSITORY"
  git -C "$SOURCE" fetch --depth=1 origin "$PIN"
  git -C "$SOURCE" checkout --detach "$PIN"
fi

# Check before and after Cargo; neither local edits nor hidden tracked changes
# may silently turn the official oracle into a second downstream build.
verify_source() {
  node --input-type=module - "$SOURCE" "$REPOSITORY" "$PIN" <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
const [source, repository, commit] = process.argv.slice(2);
const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
assert.equal(realpathSync(git('rev-parse', '--show-toplevel')), realpathSync(source));
assert.equal(git('config', '--get', 'remote.origin.url'), repository, 'Upstream origin must be official');
assert.equal(git('rev-parse', 'HEAD'), commit, 'Use a fresh checkout for a changed upstream base');
assert.ok(!/^[a-zS] /m.test(git('ls-files', '-v')), 'Upstream source must not hide tracked modifications');
assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), '', 'Upstream source must be pristine');
NODE
}
verify_source
bash "$ROOT/packages/agent-browser/scripts/cache-native-dependencies.sh" restore upstream
EXECUTABLE="$SOURCE/cli/target/ci/agent-browser"
STAMP="$SOURCE/cli/target/ci/e2e-upstream-build.json"
rm -f "$STAMP" "$EXECUTABLE"
cargo build --locked --profile ci --target-dir "$SOURCE/cli/target" --manifest-path "$SOURCE/cli/Cargo.toml"
verify_source
node --input-type=module - "$SOURCE" "$REPOSITORY" "$PIN" "$EXECUTABLE" "$STAMP" <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [source, repository, commit, executable, stamp] = process.argv.slice(2);
const manifest = readFileSync(path.join(source, 'cli/Cargo.toml'), 'utf8');
const section = manifest.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '';
const version = /^version\s*=\s*"([^"]+)"\s*$/m.exec(section)?.[1];
assert.ok(version, 'Official Cargo package must declare its version');
assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim(), `agent-browser ${version}`);
const binary = readFileSync(executable);
assert.ok(binary.length > 0, 'Official upstream executable is empty');
writeFileSync(stamp, `${JSON.stringify({
  schemaVersion: 1, repository, commit,
  tree: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
  nativeVersion: version,
  binarySha256: createHash('sha256').update(binary).digest('hex'),
}, null, 2)}\n`);
NODE
if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'E2E_AGENT_BROWSER_UPSTREAM_EXECUTABLE=%s\n' "$EXECUTABLE" >> "$GITHUB_ENV"
fi
printf 'export E2E_AGENT_BROWSER_UPSTREAM_EXECUTABLE=%q\n' "$EXECUTABLE"
