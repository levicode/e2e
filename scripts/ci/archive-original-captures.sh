#!/usr/bin/env bash
set -euo pipefail
root="$GITHUB_WORKSPACE/evidence/fixtures/$NODE_SELECTOR/core"
mkdir -p "$root"
for name in popup-swipe-borrowed-pair popup-init-order popup-init-order-borrowed replaced-nodes; do
 if test -d "packages/e2e/.e2e/$name"; then
  if test -e "$root/$name"; then test -d "$root/$name" && test ! -L "$root/$name" && test -z "$(ls -A "$root/$name")"; else mkdir "$root/$name"; fi
  cp -a "packages/e2e/.e2e/$name/." "$root/$name/"
 fi
done
test -f evidence/test-e2e.log && test ! -L evidence/test-e2e.log
test ! -e "$root/test-e2e.log"
cp -p evidence/test-e2e.log "$root/test-e2e.log"
test -d evidence/fixture-invocations && test ! -L evidence/fixture-invocations
test ! -e "$root/invocations"
cp -a evidence/fixture-invocations "$root/invocations"
