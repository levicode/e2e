---
"@e2e-dev/web": patch
---

Restore CSS and XPath selector chains, positional `nth=` steps and final capture selectors in the native web engine. Classify invalid selector syntax and non-final captures as `INVALID_LOCATOR` without relabelling malformed native requests.
