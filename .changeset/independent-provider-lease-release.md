---
"@e2e-dev/web": patch
---

Attempt provider lease release even when native, recording, or artifact cleanup fails. Preserve the original cleanup failure and keep unresolved UI ownership fenced; releasing a billed lease does not make that UI reusable.
