---
"@e2e-dev/web": patch
---

Restore download trigger timing diagnostics and preserve trigger errors. Attach downloaded files to the waiting fixture step after its trigger succeeds, and discard unpublished files after failure, cancellation, or scope retirement.
