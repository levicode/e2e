---
"@e2e-dev/web": patch
---

Retry one clean stale observation after a same-document navigation. When native proves an observation or screenshot had no effects (`not-dispatched`) on a still-usable scope, Web dispatches one fresh read after a poll tick instead of failing the action. Unknown or completed outcomes, and a replaced page, never retry.
