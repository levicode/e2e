#!/usr/bin/env bash
# Opt in only the existing original popup/replaced-field wrappers.
set -euo pipefail
python3 scripts/ci/test-check-critical-query-traces.py
python3 scripts/ci/test-original-capture-custody.py
install -m 700 scripts/ci/native-trace-wrapper.sh evidence/tools/popup-trace.sh
cmp scripts/ci/native-trace-wrapper.sh evidence/tools/popup-trace.sh
for name in popup-init-order popup-init-order-borrowed replaced-nodes popup-swipe-pair popup-swipe-borrowed-pair on-action-delayed; do
 test ! -e "packages/e2e/.e2e/$name"
done
mkdir -m 700 evidence/fixture-invocations
printf 'E2E_POPUP_EVAL_CAPTURE=1\nE2E_REPLACED_FIELD_CAPTURE=1\nE2E_POPUP_EVAL_WRAPPER=%s/evidence/tools/popup-trace.sh\nE2E_DIAGNOSTIC_INVOCATIONS=%s/evidence/fixture-invocations\nE2E_CAPTURE_SOURCE_TREE=%s\n' "$GITHUB_WORKSPACE" "$GITHUB_WORKSPACE" "$(cat evidence/source.tree)" >> "$GITHUB_ENV"
