---
"@e2e-dev/web": patch
---

Reject observations still transferring pixels when browser recovery starts, after releasing their original blob. Preserve cancellation and cleanup failures, and allow fresh observations after a successful reconnect.
