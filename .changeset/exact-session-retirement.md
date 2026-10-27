---
"@e2e-dev/web": patch
---

Avoid a redundant identity-session detach only after that exact CDP session emits its close event; retain already-dispatched cleanup failures.
