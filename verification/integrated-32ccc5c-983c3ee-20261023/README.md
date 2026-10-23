# Integrated compile and directed mock verification

Frozen native source `32ccc5c0548162016586bbef59ea2e78c6745bf9`, tree `c509da2b86ea0d40959c1d38e68ea60fbec80954`; e2e source `983c3ee8232bef9f73061f3821c50f3111f722df`, tree `b8425ea99ca4b6f8709240dce51f54a528c554eb`. Both independent worktrees remained clean. Overall status: failed. Passing mock fixtures do not waive failed compile gates.

Rust fmt, acceptance-faults tests compilation and the explicit proxy fixture check completed with their recorded exit codes. Strict default clippy reports `await_holding_lock` in `client_capture_frame_owner_deadline_tests.rs:350` across `server.await` at line 369 and `client_capture_mask_failure_tests.rs:308` across `self.server.await` at line 326. Both test helpers contain explicit drop(log), but this source still fails the requested strict lint. No source edit or lint exception was applied.

Core and Web dist builds and their package typechecks were run from the same e2e commit. Scripts typechecking reports TS2412 at `scripts/acceptance/candidate-cleanup-diagnostics.ts:182`: assigning undefined to an optional string under exactOptionalPropertyTypes. The same error occurred with the initial installed pnpm 11 and with the repository's fixed pnpm 12.3.4. The fixed package manager download was recovered using the environment's existing proxy configuration; final static stage records use pnpm 12.3.4.

Production and default harness compilation used locked profile ci with no default features. The default harness command contains --no-run. A separate acceptance-faults unit harness was compiled with the same profile and --no-run. Compiler-selected artifacts, exact feature sets, source paths and copied-byte hashes are in `binaries.json`; original compiler streams are preserved separately. Production SHA-256: `60d8d13c6a62e829941189ffaffe77463dadeea63eea99066fde5a373563abca`. The existing Rust build script created its Rust-only dashboard placeholder, whose index digest is bound with the compiled bytes. These are diagnostic build artifacts, not a release bundle.

Only the supplied pure-fixture list was eligible to execute. Each name was first listed with `<test-name> --list --exact` and required one match, then run with `<test-name> --exact --test-threads=1 --nocapture`. The default group result is 25 passed, 0 failed, 0 ignored, all exact list/run checks confirmed; acceptance-faults group result is 3 passed, 0 failed, 0 ignored, all exact list/run checks confirmed. Exact commands, exit codes, output hashes and actual 1-passed/0-ignored status for every case are in `fixtures.json`. No all-tests or ignored-test invocation was used.

The whitelist covers P01 inventory fixtures, the existing acquisition/frame-owner/mask peer fixtures and three old feature-only P41 diagnostic tests. It does not include the new P41 typed diagnostic B. These are mock/CDP-peer observations, not browser QA or proof of complete legacy-engine equivalence. The mask peer does not establish real DOM detachment or production debt-ledger/journal settlement; its real 80 ms native schedule is not millisecond-equivalent to the old TypeScript 1000 ms injected timeout.

Rust used two build jobs. The environment reports CPU quota 400000 100000 and memory limit 17179869184 bytes. Stage PIDs, wall times, child CPU time and maximum child RSS are retained; the RSS metric is not an aggregate of simultaneous processes. No browser, browser installation probe, restart probe, main/candidate update, PR, CI dispatch or release publication was performed. No source or budget was changed to obtain a passing result.

| Stage | Exit | Wall seconds | Maximum child RSS KiB |
| --- | ---: | ---: | ---: |
| native-format | 0 | 2.85 | 245320 |
| native-default-clippy | 101 | 87.46 | 4560892 |
| native-feature-check | 0 | 60.53 | 4500988 |
| native-proxy-check | 0 | 0.54 | 245672 |
| native-production | 0 | 204.78 | 4268292 |
| native-default-harness | 0 | 441.31 | 7001908 |
| native-feature-harness | 0 | 447.33 | 7037820 |
| web12-core-build | 0 | 2.07 | 583904 |
| web12-web-build | 0 | 0.60 | 136416 |
| web12-core-types | 0 | 4.30 | 983096 |
| web12-web-types | 0 | 2.85 | 425244 |
| web12-scripts-types | 1 | 1.78 | 227040 |
