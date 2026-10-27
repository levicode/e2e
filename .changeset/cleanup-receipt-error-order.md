---
"@e2e-dev/web": patch
---

Preserve the first actual cleanup receipt failure even when the caller has stopped waiting. Native close, recorder, artifact and provider-lease receipts remain joined without reordering errors or granting retired UI reuse.
