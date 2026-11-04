---
"e2e": patch
"@e2e-dev/web": patch
---

Restore Web observation and locator IDs as public `nN` aliases and the stable `root`, with `#` formatting across observations, action feedback, errors, and screen updates. Keep exact native reference authority behind the adapter, preserve the identity of still-present observed elements across captures, retire absent or replaced authority, and prevent locator churn from evicting live observed references.
