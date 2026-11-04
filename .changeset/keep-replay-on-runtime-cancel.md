---
"e2e": patch
---

Preserve a consumed replay entry when a pending custom executor is cancelled by the run. Classify cancellation from the runtime signal before settling the cache, rather than treating an arbitrary abort reason as a failed action.
