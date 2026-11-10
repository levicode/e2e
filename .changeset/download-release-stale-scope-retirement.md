---
'@e2e-dev/web': patch
---

Retire a download or response-body release that races a scope replacement instead of invalidating the native transport. When a release was admitted just before `app.clearState()` and the replacement sealed the old scope first, the release came back `stale-scope` and the engine treated it as a capability-contract violation: the attempt's cleanup failed, and every later attempt on that worker failed to start with `APP_NOT_OPEN`. The replacement retires the old scope's handles, so the release now waits for that proof and is retired with it.
