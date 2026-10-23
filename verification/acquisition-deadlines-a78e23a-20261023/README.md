# Acquisition deadline directed result

The requested filter on agent-browser `a78e23a491fcd5ae3c53db00075b12e292622aa5` compiled and discovered all four original cases. Actual result: 2 passed, 2 failed, 0 ignored, 2579 filtered out. Cargo exited 101. Compilation took 9m45s; test execution took 0.08s. The unchanged 80 ms parent budget remains in the source. No source, assertion, old test, production logic or gate was modified.

The commit parent is `49903189a6a8fc1b39c8ec503737d000fdde9d44`, tree `273a9ca40e1c4c444f759a924e98dc37fd004203`. Its complete diff adds the 546-line test file and three test-module registration lines. It was checked out in a separate worktree without the C03 changes. P27 and metadata production files remain untouched. The existing Cargo dependency cache and ci target directory were reused with two build jobs.

```sh
# cli directory of the exact source worktree
cargo test --locked --profile ci --no-default-features 'native::client_observation_dispatch::supersession_tests::acquisition_deadline_tests::' -- --nocapture
```

Passed:

- `first_native_acquisition_deadline_cleans_before_fresh_fallback`
- `candidate_deadline_drains_all_started_siblings_before_group_release`

Failed:

- `candidate_acquisition_deadline_stops_metadata_before_fresh_fallback`
- `unacknowledged_candidate_deadline_never_becomes_clean_fallback`

Both failures originate at `client_capture_acquisition_deadline_tests.rs:199`, where the peer sees one started acquisition but requires two. The production author graph visits children before appending a parent's id. Metadata candidates preserve that order, so this fixture produces node 7 before node 1. The new peer's node-7 branch assumes both have already started. It panics before sending the readiness notification; the test subsequently receives `RecvError` at line 367. `failure-source-excerpts.txt` shows the source chain. This is a fixture arrival-order assumption, not an 80 ms timeout failure. The two failed cases did not reach their later deadline, unknown-effects, quarantine or zero-publication assertions.

The two successful cases provide bounded evidence for first-acquisition fallback and draining both started sibling ACKs before group release. The four-case suite remains red, so legacy capture obligations #1/#3/#4 are not marked complete. This result does not establish successful terminal delivery before a manually withheld late resource ACK or complete equivalence with the old engine. No old module was removed.

These four tests use an actual loopback WebSocket CDP peer and the production observation dispatcher. They do not run Chromium or establish renderer garbage collection. The earlier C03 browser result remains separate and was not rerun. Its preserved production binary SHA-256 is still `34259ec5aace51e3fd2a4d4fcb721a96e5af73a904e25fa28e0b98b2cb8c5325`.

`result.json` contains the exact case names, results, harness digest and failure locations. The raw stdout/stderr are preserved as exact strings in `test-output.json`, with their digests in `result.json`. The source worktree remained clean. No production failure claim, fixture repair or success claim for the two failed cases is made.
