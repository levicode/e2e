#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${1:?restore or save}"
FLAVOR="${2:?maintained or upstream}"
case "$FLAVOR" in
  maintained) SOURCE="$ROOT/.validation-tools/agent-browser-exact" ;;
  upstream) SOURCE="$ROOT/.validation-tools/agent-browser-upstream" ;;
  *) echo 'Unknown native cache flavor' >&2; exit 1 ;;
esac
case "$MODE" in restore|save) ;; *) echo 'Unknown native cache operation' >&2; exit 1 ;; esac
# Never prepopulate source checkout directories: pristine-source validation owns them.
CACHE="$ROOT/.validation-tools/native-dependency-cache/$FLAVOR"
TARGET="$SOURCE/cli/target/ci"
for part in deps build .fingerprint; do
  if [[ "$MODE" == restore ]]; then FROM="$CACHE/$part"; TO="$TARGET/$part";
  else FROM="$TARGET/$part"; TO="$CACHE/$part"; fi
  [[ -d "$FROM" ]] || continue
  mkdir -p "$TO"
  # Exclude this workspace's executable, tests, build scripts and fingerprints.
  node --input-type=module - "$FROM" "$TO" <<'NODE'
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
const [from, to] = process.argv.slice(2);
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true, preserveTimestamps: true,
  filter: source => !/^agent[-_]browser-/.test(path.basename(source)),
});
NODE
done
