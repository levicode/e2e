---
"@e2e-dev/web": patch
---

Record one diagnostic for every failed `browser.perform`, including a refusal
produced before the action context exists: operation admission, the verified
frame inventory, the frame geometry snapshot, and the reference snapshot. The
record keeps the receipt's operation sequence, a closed preflight stage and a
closed reason, so a `browser-failure` that never dispatched names the check that
refused it.
