---
"@e2e-dev/web": patch
---

Keep native attempt cleanup owned under one bounded deadline when its caller stops waiting. Wait for confirmed retirement before starting another attempt, and retain failed cleanup without releasing an unconfirmed lease.
