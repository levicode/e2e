---
"e2e": patch
---

Add `agents.<name>.pixels` to the built-in agent: `always` keeps the historical behavior, where every action result carries a screenshot once the model has seen one; `on-request` sends pixels only when the model asks (`screenshot`, or a point action), and `off` never sends them and offers no pixel tool. The default is `always`, so existing configs are unchanged.
