---
"@e2e-dev/web": patch
---

Accept a quarantine recovery receipt on a page-read-only command's clean non-dispatch: an interrupted read that provably never dispatched no longer fails the session protocol, while page-writing commands, pixel captures, and screenshots still require an Unknown result.
