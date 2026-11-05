---
'@e2e-dev/web': patch
---

Fall back to a tree-only observation when an optional masked pixel capture loses its references after a same-document route change, so the post-action screen stays usable instead of failing as NODE_STALE.
