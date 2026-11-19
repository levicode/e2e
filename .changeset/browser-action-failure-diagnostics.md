---
"@e2e-dev/web": patch
---

Settle a browser action whose exact target the page destroyed as `NODE_STALE`
instead of an opaque engine failure, so the runner can re-resolve it from a
fresh read. A failed action now also records its closed kind, stage, CDP method
and failure class in the cleanup diagnostics trace.
