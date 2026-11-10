---
"e2e": patch
---

Name an unnamed action target by the one text of the container that holds it: a tag chip's remove icon reads `in="TAG-42"`, records that text as its target's container key (`within`), and its trace summary and replay re-find it in that chip instead of by its place among every identical icon. The screen-change diff no longer calls the twins changed when one is added or removed and their `nth=i/n` renumbers, so a one-control removal reports the removed line (with its text) instead of re-listing the whole screen; twins that swap places are still reported.
