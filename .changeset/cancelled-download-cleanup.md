---
"@e2e-dev/web": patch
---

Keep download subscription and handle cleanup alive under their owning attempt when a run is interrupted, without replacing cancellation with a browser contract failure.
