---
"e2e": patch
---

Accept a node id copied from a listing without the engine's `@` decoration (`#@e347` written as `e347`) when the current screen lists that node. When a target names no listed node, the `LOCATOR_NOT_FOUND` error now names the current listing, its id form, and a short sample of ids, and says when the listing is truncated.
