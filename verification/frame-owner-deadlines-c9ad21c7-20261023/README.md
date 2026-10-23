# Frame owner deadline directed verification

Exact source `c9ad21c72460e6a2ffc21f046c1a745baacedc78`, parent `219c37358cf2c947846bb907da689429f720bd72`, tree `53e79dda59a615e374fba6d9587c590500c2a442`. The original filter discovered two cases. Actual result: 0 passed, 2 failed, 0 ignored; Cargo exit 101. `result.json` records the full case names, harness digest and actual terminal timing observations.

The complete reviewed diff adds a 369-line test file and three test-module registration lines. The isolated worktree remained clean throughout execution. No production code, assertion, original 80 ms parent deadline, old test or gate was modified. Existing Cargo dependencies and ci build cache were reused with two jobs.

```sh
cargo test --locked --profile ci --no-default-features 'native::client_observation_dispatch::supersession_tests::frame_owner_deadline_tests::' -- --nocapture
```

Both fixtures use the complete observation dispatcher and a real installed OwnerDebtLedger with a loopback WebSocket CDP peer. They do not launch a browser. The actual DOM.resolveNode owner reply is held beyond the parent deadline. Cleanup must release that exact late object once under the correct session. Withholding its release ACK retains accounted object_debt=1 and outstanding_commands=1, with input_debt=0 and intact integrity. This accounted object-only debt is not classified as dirty/quarantined cleanup uncertainty. A new operation cannot clear the exact old owner's debt.

The terminal assertions require DeadlineExceeded, NotDispatched effects and zero publication. An exact late release ACK may clear the old debt, but must not restart enumeration, geometry, screenshot or duplicate release. These are the original assertions; their actual pass status is explicit in `result.json`. Cleanup may outlive the unchanged parent deadline. The observed terminal delays are not evidence of a successful fallback.

These fixtures target only the safe resource-ownership portion of legacy capture obligation #5. The suite remains red, and the post-ACK safety checks remain unverified. It does not establish equivalence to the old 60 ms successful fallback, complete old-engine equivalence, real-browser behavior or renderer garbage collection. No old module was removed.

`test-output.json` retains exact stdout/stderr strings with their hashes in `result.json`. Parent acquisition test evidence remains separate in commit `099d8ba12749c3c0c5b31e76948d0efc7cf549cb`; those four cases and C03 were not rerun. The preserved C03 production binary SHA-256 remains `34259ec5aace51e3fd2a4d4fcb721a96e5af73a904e25fa28e0b98b2cb8c5325`. This is not a full candidate or release approval.

The two cases failed in the fixture's post-ACK fence, not at the original 80 ms deadline. Both panic at `client_capture_frame_owner_deadline_tests.rs:31`, called from line 314. The real ledger was installed at line 159; `journal.scope` only covers dispatch startup. The later helper calls `client.send_command("Browser.getVersion", None, None)` with the original unbound client outside any active journal. The unchanged production guard at `cdp/client.rs:1201` rejects that ambient command with `Native CDP requires an owner-bound view` before it is sent.

Both cases entered and passed the earlier core assertions: exact late-owner release, pending accounted object debt, terminal DeadlineExceeded/NotDispatched, dirty=false, usable inventory, zero publication, retained old-owner debt when the ACK is withheld, and no clearing of that debt by a new operation. The peer then sent the cleanup ACK and notified the test. The fence failure prevents the subsequent client-side debt-zero, no-continuation and final publication/command-log checks from running. Those postconditions remain unverified. No test helper, assertion, production code or deadline was changed or rerun to obtain a green result.
