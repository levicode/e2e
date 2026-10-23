# Acquisition deadline arrival-order fix verification

Exact source `219c37358cf2c947846bb907da689429f720bd72`, parent `a78e23a491fcd5ae3c53db00075b12e292622aa5`, tree `3a27ef57c607cc4c7fa2ead39fbf3bd9343fc2df`. Actual original-filter result: 4 passed, 0 failed, 0 ignored, four discovered cases, Cargo exit 0.

The reviewed change touches only `client_capture_acquisition_deadline_tests.rs`, with 12 additions and 7 deletions. The peer records held or immediate-ACK ownership before notifying readiness and waits for all required acquisitions. It supports either node 7 or node 1 arriving first. The complete core test body is byte-identical to the parent, including the original 80 ms deadline and late-ACK, sibling-drain, object-group release, Unknown/quarantine and publication assertions. `source-review.json` records that core-body hash.

```sh
cargo test --locked --profile ci --no-default-features 'native::client_observation_dispatch::supersession_tests::acquisition_deadline_tests::' -- --nocapture
```

The original earlier run on `a78e23a` remains recorded as 2 passed, 2 failed, 0 ignored in commit `c815e3c900585100f0b5f683a46f4f4b8d1544d8`. Its two failures were the peer arrival-order assertion at line 199 and consequent readiness-channel closure at line 367. That evidence and the old harness were preserved. This result is a separate run of the reviewed fix.

`result.json` lists the four complete case names, actual statuses and the current harness digest. `test-output.json` preserves exact stdout/stderr strings; their hashes are in the result. The isolated acquisition worktree and existing Cargo dependency/ci cache were reused. The source remained clean, and no local test or production patch was applied.

These cases use a loopback resource-producing CDP peer and the production observation dispatcher. They provide only the safe portions of legacy capture obligations #1/#3/#4. They do not establish successful terminal delivery before a manually withheld late resource ACK, complete equivalence with the old engine, or Chromium renderer garbage collection. No old module was removed. C03 was not rerun; its preserved production binary SHA-256 remains `34259ec5aace51e3fd2a4d4fcb721a96e5af73a904e25fa28e0b98b2cb8c5325`.
