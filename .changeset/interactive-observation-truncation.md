---
"e2e": patch
---

Keep the interactive nodes a dense screen's byte budget would have cut: when an observation does not fit, the listing now keeps the nodes whose role the agent can act on by id, with the ancestors that place them, in preference to non-interactive structure, and fills what remains with the rest of the tree in document order. Previously the cut ran in document order, so controls past it, often the ones below the fold, were invisible to the model and had to be found by scrolling and screenshots. Names, attributes, and states of listed nodes are unchanged; the truncation marker says interactive nodes were prioritized, and the model-facing notes say nodes were left out rather than calling them past the cut.
