# Mask failure four-exact verification

Source `d383cd081caa3c47636f19be217075c2815efebf`, parent `5a8123306683aa24c1336df12ea88f142fc3d928`, tree `b4e7d09b3baa09eda6b0e7d48d7f9447d713235f`. Actual totals: 4 discovered, 4 executed, 4 passed, 0 failed, 0 ignored. Exact process exit codes: [0, 0, 0, 0]. Full names, individual output hashes and results are in `result.json`.

The reviewed diff adds only the 498-line fixture and three test-module registration lines. The isolated worktree stayed clean; no production code, original 80 ms schedule, assertion or gate was changed. The existing Cargo cache and environment were reused.

```sh
cargo test --locked --profile ci --no-default-features --bin agent-browser --no-run --message-format=json
# Four separate sequential invocations of the compiler-selected harness:
<harness> --exact <full-case-name> --nocapture
```

Compilation ran once without executing tests. `build.json` records the selected test artifact, empty feature set, original compiler JSON digest and harness SHA-256 `23d2c86ba9983a1b2564b7629f02471e4ebde0d5f06c75e8b4e3cc2087e07eca`. Each exact invocation confirmed its actual discovery and execution count; a zero-match command cannot count as a pass.

The original assertions distinguish an independent reader's detached-shaped JavaScript exception from a CDP protocol rejection with the same words. The former expects IndependentCoverage/MaskingUnproven; the latter expects IndependentCoverage/BrowserFailure. The two dispatcher cases use real native scheduling with an 80 ms original parent deadline and require completion after at least 60 ms but before that original deadline. They check that detached-shaped independent coverage preserves the semantic DeadlineExceeded, while protocol rejection remains BrowserFailure. No pixels or publication may escape; peer object groups and animation restoration are also checked. Actual per-case pass/fail status is explicit in the JSON.

The peer supplies strict CDP exception/rejection shapes and pins the emitted reader guard. It does not execute a renderer or establish actual DOM detachment. It does not install a real production OwnerDebtLedger or operation debt journal. ProtectedReadJournal is exercised for capture and animation restoration, which is a separate contract. The old TypeScript 1000 ms injected timeout is not millisecond-equivalent to this native schedule. Even four passing cases do not establish completion of all legacy obligations or full candidate acceptance.

`test-output.json` preserves the exact synthetic stdout/stderr strings. Per-case output hashes and result digests are retained. C03 and the previous acquisition/frame-owner cases were not rerun. No browser, restart, main/candidate update, PR or CI dispatch is part of this directed verification.
