---
"@e2e-dev/web": patch
---

Allow explicit initialization of a fresh worker on the same engine handle after disposal confirms all cleanup, even if disposal still reports an earlier scope error. Unconfirmed native, artifact, recording, or lease cleanup continues to block reuse.
