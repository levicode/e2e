# CI27 capture and hung-attempt evidence

P01 failed in both bounded runs. Its first trace screenshot rejection was `frame-inventory-fence / stale-scope`, before pixel capture. P27 passed four runs with the original configuration and one with passive timing. P19 and P21 each passed one original-configuration run and one passive-timing run on the separate hung-attempt adapter commit. The default clippy boundary failed; this evidence does not certify the candidate or a release.

This evidence-only branch has the fixed parent `b3a23a07c3f9068e7c0b122873b94f28cbb2e40b`. It changes no candidate implementation, main branch, workflow, budget or gate. Publishing these files required no new browser run, Rust compilation or test execution.

## Source and binary binding

| Role | Exact source |
| --- | --- |
| Native runtime | `levicode/agent-browser` at `bec755389f799ec3a9bb7448580a0b665c457544`, parent `49903189a6a8fc1b39c8ec503737d000fdde9d44` |
| P01/P27 adapter and collector | `levicode/e2e` at `9cfe7d62f4e6f1f947e595efd4ae0376f61d21cb`, parent `b3a23a07c3f9068e7c0b122873b94f28cbb2e40b` |
| P19/P21 adapter | `levicode/e2e` at `6cf930e2bbc2ac82cdc7f15b49fcee325551bb20`, parent `b3a23a07c3f9068e7c0b122873b94f28cbb2e40b`, tree `9f8c18912872d0963cce4d9ab47da66db5eb69e0` |
| Read-only retry reference | `levicode/agent-browser` at `ef34a641050c5a0b1412857e711604906d65e916` |

The single production binary was built with `cargo build --locked --profile ci --no-default-features -j 2 --message-format=json`. Its SHA-256 is `67f8626379049917b1df224151c9b0b087d6bae6fdcbb850be7b82f9942bd7ee`, size 30,848,656 bytes. The source-matched default test harness SHA-256 is `14fd5e72f5a187f7b55f9395e6d3e20abedc4bf4325340f139ac96a404a9827d`. P19/P21 reused that same production binary without rebuilding Rust. All three tested checkouts retained clean tracked source, and the binary hash was unchanged after the runs.

The production build took 298.022 s and the default harness build 512.549 s, with maximum child RSS of 4,270,068 KiB and 6,883,876 KiB respectively. The temporary environment had 4 vCPU and a 16 GiB memory limit; observed build cgroup peak was 11,214,065,664 bytes, with no OOM kill. Tool versions were Rust 1.99.1, Node 24.19.0 and pnpm 12.3.4. These are selected build facts, not an environment dump.

## P01 first failure

The unchanged title was `tells where the page went, apart from its own navigations, the screen each action left, and the browser` in `packages/web/tests/integration/app-log.test.ts`.

| Run | Configuration | Original screen assertion | Failed screenshot operations | Cleanup |
| --- | --- | --- | --- | --- |
| P01-01 | Original | Expected 3, received 1 | 11 and 13 | op 14 passed; exact request duration unknown |
| P01-02 | Passive request timing | Expected 3, received 2 | 11 | op 16 passed in 32.893 ms |

All three failure records have `screenshotStage=frame-inventory-fence`, `capturePhase=not-entered`, `error=stale-scope` and `inventoryAfterFailure=changed`. The two `.closed.jsonl` files preserve the original closed-schema lines byte for byte, including capture start and terminal scope cleanup.

In P01-02, tap op 10 completed, then trace screenshot op 11 returned `stale-scope / not-dispatched / usable` after 15.272 ms. Tap op 12 and its screenshot op 13 completed. The existing optional `screenAfterAction` path suppresses trace screenshot errors, so the screen callback count remains below the original assertion. This observed rejection was neither a raw capture failure nor exhaustion of that screenshot's 1 s budget.

The instrumented rejection is the final `page.targets.check_revision(revision)` in `verified_frame_inventory`. Its existing predicate can reject a sealed inventory, a changed revision, or nonzero reservations. The witness does not distinguish those atomic branches. Neither `observedRevision` nor `currentRevision` was emitted, and neither case contains an `InventorySnapshot` before/after event. All of these missing facts remain unknown in the JSON. The later `inventoryAfterFailure=changed` comparison cannot identify the atomic branch, a popup, an iframe or a navigation as the cause.

## P27 budget observations

The unchanged title was `refuses to swipe a node with no box even when its child is under aim` in `packages/web/tests/integration/lifecycle.test.ts`. The original 1 s swipe budget and assertions were retained.

| Run | Configuration | Result | entryUs | ackUs | wakeUs | failUs |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| P27-01 | Original | passed | 985386 | 309418 | 18100 | 292085 |
| P27-02 | Passive timing | passed | 985008 | 315191 | 16861 | 298970 |
| P27-03 | Original | passed | 987828 | 303312 | 17911 | 286155 |
| P27-04 | Original | passed | 984888 | 303369 | 18095 | 286253 |
| P27-05 | Original | passed | 985148 | 303975 | 18058 | 286766 |

Every record has `ack=current`, `window=entered`, `deadline=false`, `zeroInput=true`, `cleanup=not-observed` and `error=not-actionable`. Positive `failUs` shows remaining budget at the existing failed `perform_node` result, before exact-node release. It does not time later cleanup. `wakeUs` includes probe work and the actual pause return, rather than pure sleep. No authority is reconstructed from rounded time values.

P27-02's actual perform timeout was 999.347989 ms and its terminal arrived after 703.284 ms. Its two `scope.end` requests passed in 26.032 ms and 24.635 ms. Original assertions for `not-dispatched / usable`, zero input/scroll, and a usable next attempt passed. Five bounded runs did not reproduce the historical P27 test failure, so that historical failure's budget, ACK and wake state remain unknown. No load was added to induce a failure.

## P19/P21 request settlement

The exact unchanged titles in `packages/web/tests/integration/hung-page.test.ts` were checked before execution:

- P19: `ends a browser assertion on a stuck page at its own timeout, not the action timeout`
- P21: `times out a locate and a point tap on a page whose renderer is stuck in a script`

P19 retained the 30 s action/query budget and 1 s assertion budget. In the passive-timing run, `page.title` returned `deadline-exceeded / not-dispatched / usable` after 1001.583 ms. The later query's wire timeout was 29999.822235 ms. After the assertion's own timeout, `endAttempt` began; the captured query signal aborted after 0.639 ms and the query's `cancelled / not-dispatched / usable` terminal arrived after 1.591 ms. A separate `scope.end` started 182 microseconds after that terminal, with an initially un-aborted signal and 14998.418249 ms remaining from the original 15 s retirement. Scope cleanup passed after 43.701 ms, and `endAttempt` completed in 45.981 ms. No cancel-ACK arrival time was captured or treated as terminal proof.

P21's locate and point requests had wire budgets of 999.874634 ms and 999.858810 ms. They returned `deadline-exceeded / not-dispatched / usable` after 1003.897 ms and 1001.520 ms. The original timeout, nonretryable and native-not-dispatched assertions passed. Those requests were already terminal at retirement, so P21 is not evidence of P19's pending 30 s-query schedule. Its independent `scope.end` used 14999.452567 ms remaining, passed in 42.082 ms, and `endAttempt` completed in 43.323 ms.

The observed P19 order matches the supplied adapter change: ordinary requests capture their exact attempt's retirement signal, register settlement before dispatch, and join terminal requests within the same retirement remaining before independent cleanup. No old-baseline browser A/B was run here. Each P19/P21 case passed once under original configuration and once with passive timing. The supplied 10 new unit cases passed; independent core/Web builds and Web typecheck passed. The owner's previously reported full 1056-test Web result was not rerun or counted as this run's evidence.

## Compile and focused test results

- Format, acceptance-faults tests check and explicit proxy fixture check passed. Default clippy failed on `clippy::int_plus_one` at `cli/src/native/client_cleanup_diagnostic_tests.rs:652` and `:739` under `-D warnings`. Source and lint severity were not changed.
- The five new screenshot tests were run by exact name and passed; `readonly_timing_` passed 4/4, `readonly_prepare_failure_` 2/2, and the new collector suite 26/26.
- The full `ef34` identifier resolved the earlier lookup gap. Its three production classification helpers and four relevant strict test bodies are byte-identical in `bec755`. `center` is identical after removing only the added scalar diagnostic observations around its original pause. Function hashes and the comparison scope are in `hashes.json`.
- The already executed `readonly_preparation_` group passed all four exact named tests in the final JSON, including `readonly_preparation_accounts_for_actual_retry_wake_without_widening_tap`, the test introduced by `ef34`. The recorded execution-log SHA-256 is `b2f4750fdb554ac8de4573865fab910f2084911f56ad5200116e2e04799c75da`. This confirmation used source and existing logs only; no new compilation or execution was done.
- The initial broad `screenshot_` substring filter also included an old metadata pure WebSocket fixture. That result is excluded from P01/P27 causality. The five new screenshot tests were subsequently rerun exactly. No metadata browser probe, C03 case or restart operation was executed.

The original browser commands used `vitest run --project integration --maxWorkers=1 --bail=0 --reporter=verbose --reporter=json`, the original test file and the full `-t` title above. P19/P21 used a separate checkout and rebuilt Web. Passive timing added only a test setup observing the original returned Promises, with in-memory closed scalars and an afterAll write. It added no browser command, retry, per-request file I/O or budget change. Full reproducible compile/test argv and source bindings are in `final-verification.json`; temporary binary/output paths are represented by placeholders.

## Evidence limits and contents

All browser runs used the installed Chromium 154.0.8037.57 with the authorized process-local `--no-sandbox` on loopback synthetic pages. No accounts, business Cookies or business data were used, and no OS/SUID setting was changed. Chrome 156's known official download 403 was not retried or bypassed, so no Chrome 156 result is claimed. Actual common Chromium arguments are retained with only the random temporary profile path redacted.

Each case had a separate capture file and the correct adapter collector. Recorded snapshots have no gap/drop/overflow and have terminal cleanup results. `complete-observed-snapshots` does not prove complete process coverage, case association or overall cleanup. An empty final sampled process set is also not an OS-wide proof. `CleanupStarted` is retrospective, so its write distance to `CleanupResult` is never presented as cleanup duration. Missing timings are unknown.

`final-verification.json` holds the separate source/runtime bindings, results and explicit unknowns. `timing.json` holds compact relative request timings and order, not raw environments or complete protocol envelopes. `p01-01.closed.jsonl` and `p01-02.closed.jsonl` retain the complete closed P01 records. `hashes.json` contains source, binary, harness, input and function hashes; `SHA256SUMS` covers the published files. No raw environment, machine-specific temporary paths, secrets, account data or unrelated logs are included.

No release/npm publication, merge, workflow change or CI dispatch was performed. No additional browser run was made to publish this evidence. P01's missing inventory values/events and the historical P27 failure remain unknown; the two clippy failures remain failures.
