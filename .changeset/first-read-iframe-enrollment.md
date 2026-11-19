---
'@e2e-dev/web': patch
---

Wait out a frame target that is still registering before the first observation refuses, then re-sample once under the original deadline. A startup iframe that is attached and configured but not yet resumed no longer turns the first read into `stale-scope`; the discarded sample is never published, and a changed owner, a stop or lost cleanup still end the read exactly as before. The cleanup diagnostics now name an initial frame refusal's closed class (frame topology, target not registered, frame binding, revision) and the phase of a refused `state.capture` (pre-attestation, export, post-attestation).
