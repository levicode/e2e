---
"@e2e-dev/web": patch
---

Publish an attempt's provider-release receipt before invoking provider callbacks so synchronous cleanup reentry cannot release the same lease twice.
