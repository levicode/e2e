---
"@e2e-dev/web": patch
---

Keep ordinary browser and provider cleanup within the caller's budget. Retain exact native close and already-started recorder, artifact, and release receipts after a caller leaves, without replaying work, extending its effect deadline, or reusing an unconfirmed scope.
