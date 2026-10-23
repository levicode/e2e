# Frame owner deadline owner-bound fence verification

Exact source `1ee866faeb8f41d996c6ef7bb29517d0d840f563`, parent `c9ad21c72460e6a2ffc21f046c1a745baacedc78`, tree `0630d722f45f14ae9d3971a3be47c539d1e6fdf1`. The original filter discovered two cases. Actual result: 2 passed, 0 failed, 0 ignored, Cargo exit 0. The complete case names and current harness digest are in `result.json`.

```sh
cargo test --locked --profile ci --no-default-features 'native::client_observation_dispatch::supersession_tests::frame_owner_deadline_tests::' -- --nocapture
```

The reviewed fixture-only change is four additions and one deletion. It binds the Browser.getVersion fence using `client.owner_view(ledger.clone())`. It does not revive the expired operation journal. All pre-fence test code and all post-fence assertions are byte-identical to the parent; the original 80 ms deadline, production files and module registration are unchanged. Source checks and the post-fence assertion hash are in `source-review.json`.

The old run remains preserved in commit `a79c88e252f7e30503acf5fcb58ad590bb3ec9ec`: 0 passed, 2 failed, 0 ignored, exit 101 on `c9ad21c7`. Its failure was the unbound post-ACK transport fence, after the earlier terminal and accounted-debt checks but before final debt-zero and no-continuation checks. Its original logs and harness were retained; this result is a separate run.

The fixtures use the complete production observation dispatcher, a real installed OwnerDebtLedger and a loopback resource-producing CDP peer, without launching a browser. The original assertions cover the exact late owner release; accounted object-only debt while the release ACK is withheld; terminal DeadlineExceeded/NotDispatched with dirty=false and zero publication; and, after the owner-bound fence, zero old-owner/global debt and outstanding commands, no resumed old work, no duplicate release and publication remaining zero. The actual status of each final postcondition is explicit in `result.json`.

Cleanup may outlive the unchanged parent deadline. The recorded terminal delays are not successful fallback timings. Coverage is only the safe ownership portion of legacy capture obligation #5, not equivalence to the old 60 ms successful fallback, complete old-engine equivalence or renderer garbage collection. No old module was removed.

The isolated worktree and existing Cargo dependency/ci cache were reused. No local source patch was applied. C03 and the prior acquisition cases were not rerun. `test-output.json` preserves exact stdout/stderr strings, with their digests in `result.json`. This is not a full candidate or release approval.
