---
'e2e': patch
---

Report a recording that cannot replay as `step.cache.write: saved-unreplayable`, naming the actions a replay could not re-find (`step.cache.writeDetail`), instead of a plain `saved` the next run then refuses. Record the page `id` or `class` of an unnamed action target (an icon-only control, a clickable box) as its replay target, so such a control relocates in a later session instead of making the whole recording `truncated`.
