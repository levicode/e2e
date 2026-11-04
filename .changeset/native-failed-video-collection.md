---
'@e2e-dev/web': patch
---

Retain independently verified recording segments after terminal browser failures or a partial video transfer. Preserve the first collection fault alongside saved bytes through later timeouts, and retain unread handles for exact-attempt cleanup; same-attempt collection retries only pending local writes, never a recorder stop or browser mutation.
