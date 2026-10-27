---
"@e2e-dev/web": patch
---

Keep the native browser transport alive during foreground interrupts so runner-owned cleanup finishes without a spurious engine failure.
