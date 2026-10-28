---
"@e2e-dev/web": patch
---

Recover a disconnected persistent Playwright client through its configured reconnect endpoint while retaining native context and Page identity, original operation budgets, and actual cleanup receipts. Preserve validated pending Page reopen events and raw viewport settings during recovery.
