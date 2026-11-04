---
"@e2e-dev/web": patch
---

Decode the native correlated close receipt: a close that cannot prove every remote obligation now reports a cleanup failure instead of corrupting the session protocol and wedging later attempts.
