---
"e2e": patch
---

Say why a passing step whose first action came after the engine truncated the semantic tree was not recorded: the step had no start baseline it could trust, and its cache detail now reads `notRecorded: "observation-truncated"` (report-1 admits the value) instead of leaving the report with no write and no reason.
