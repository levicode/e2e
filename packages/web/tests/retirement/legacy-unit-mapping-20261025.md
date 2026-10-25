# Legacy test retirement evidence, 2026-10-25

Formal acceptance remains 30/93. The previously reviewed staging 39 has been transplanted onto e2e `5adcc69574da30c539b585d92a793bca87fae2bc` and native `0ea3dce92bec2e1d059f30b6839f444a42f6a4eb`. Original actions case 4 is one additional local proposal for the parent integrator. The proposed source contains 40 retired original identities and 53 retained, including 14 browser identities. Three additional upstream locator identities remain separate. No compound test has been split.

Only the final accepted patch pair and cold-unarmed patch were applied. Rejected checkpoints 1 and 7 remain excluded. True three-way application preserved the current recovery test and native misleading-query fixture. Native production source remains byte-identical to the exact requested base.

Raw logs, exact commands, SHA256 digests, binary/toolchain provenance and original test bodies are in the private handoff archive. `original93-evidence-mapping.json` is the full machine-readable ledger. Passing adapter peers establish framing and public results only; producer evidence is listed separately. Baseline 30 is inherited acceptance, with reruns explicitly distinguished from historical evidence.

The complete Web unit run has 62 files and 1137 passing tests, with no skipped tests. Web typecheck and full repository oxlint pass. The source-removal gate remains red at 35 diagnostics, down from 38 only because the three old locator/semantic imports disappeared. No gate or frozen test inventory was relaxed.

Native canonical validation uses Rust 1.99.1, the unchanged ci profile, default features, `RUST_MIN_STACK=16777216`, exact test names and one test thread. This test-harness stack setting follows the existing validation convention. It changes no production stack or operation deadline. Earlier Rust 1.93 debug stack overflows and all setup failures remain in the archive; Rust 1.93 opt1 passes are supplemental and are not the canonical receipts.

## Additional action case 4

Production MATCH_QUERY treats performing click action and click action done as ordinary author text, with one- and two-match controls. Actual native query publication gives one ref; action-time revalidation yields two for the same exact expression, returns StaleReference/NotDispatched, keeps ref allocation/identity counts unchanged, releases query groups and emits no input or scroll. Real adapter forwards one query and one original tap at 1000ms, maps genuine non-dispatched NODE_STALE/retryable:true, and still permits page.title. Removed only the corresponding old classification row after the opt1 producer and adapter both passed; canonical execution is recorded separately.

## Retained priorities

- Actions 6 and 7 still need actual noneditable and closed-page producer triggers with the complete original public result. A static typed error cannot supply that evidence.
- Actions 21,22 and 23 retain the exact 400x300 aiming, read-count, no-move and render assertions. Current center/scroll code does not establish those three branches within the original budget.
- Actions 29 keeps the exact 16ms pacing checkpoints. Video 1, 2 and 5 keep first-frame timing, real segment lifecycle and failed screencast-start obligations.
- Capture, attempt, recovery and all 14 browser identities remain with the parent. Beforeunload, service-worker attachments and iOS are outside this task.

## Original identity ledger

The file/case index is the original legacy-only cohort described by the accepted manifests. The expanded public source has additional tests and is not used as a new denominator. Each row retains its exact source snapshot and body hash in the machine ledger.

| Identity | State | Adapter or retained source | Producer receipts |
| --- | --- | --- | --- |
| closed-shadow:1 | retained | `packages/web/tests/unit/closed-shadow.test.ts` | original retained |
| closed-shadow:2 | retained | `packages/web/tests/unit/closed-shadow.test.ts` | original retained |
| closed-shadow:3 | retained | `packages/web/tests/unit/closed-shadow.test.ts` | original retained |
| actions:1 | formal-baseline-30 | `packages/web/tests/unit/actions.test.ts` | inherited acceptance; no rerun |
| actions:2 | formal-baseline-30 | `packages/web/tests/unit/actions.test.ts` | canonical-misleading-producer.json |
| actions:3 | formal-baseline-30 | `packages/web/tests/unit/actions.test.ts` | canonical-baseline-11.json |
| actions:4 | proposed-40 | `packages/web/tests/unit/actions.test.ts` | canonical-node-query-matcher.json, canonical-misleading-producer.json |
| actions:5 | formal-baseline-30 | `packages/web/tests/unit/actions.test.ts` | canonical-misleading-producer.json |
| actions:6 | retained | `packages/web/tests/unit/actions.test.ts` | original retained |
| actions:7 | retained | `packages/web/tests/unit/actions.test.ts` | original retained |
| actions:8 | retained | `packages/web/tests/unit/actions.test.ts` | original retained |
| actions:9 | retained | `packages/web/tests/unit/actions.test.ts` | original retained |
| actions:10 | retained | `packages/web/tests/unit/actions.test.ts` | original retained |
| actions:11 | retained | `packages/web/tests/unit/actions.test.ts` | original retained |
| actions:12 | accepted-staging-39 | `packages/web/tests/unit/actions.test.ts` | canonical39-rust-08.json |
| actions:13 | retained | `packages/web/tests/unit/actions.test.ts` | original retained |
| actions:14 | retained | `packages/web/tests/unit/actions.test.ts` | original retained |
| actions:15 | retained | `packages/web/tests/unit/actions.test.ts` | original retained |
| actions:16 | retained | `packages/web/tests/unit/actions.test.ts` | original retained |
| actions:17 | formal-baseline-30 | `packages/web/tests/unit/actions.test.ts` | canonical-baseline-09.json |
| actions:18 | formal-baseline-30 | `packages/web/tests/unit/actions.test.ts` | canonical-baseline-08.json |
| actions:19 | formal-baseline-30 | `packages/web/tests/unit/actions.test.ts` | canonical-baseline-13.json |
| actions:20 | formal-baseline-30 | `packages/web/tests/unit/actions.test.ts` | canonical-baseline-10.json |
| actions:21 | retained | `packages/web/tests/unit/actions.test.ts` | original retained |
| actions:22 | retained | `packages/web/tests/unit/actions.test.ts` | original retained |
| actions:23 | retained | `packages/web/tests/unit/actions.test.ts` | original retained |
| actions:24 | formal-baseline-30 | `packages/web/tests/unit/actions.test.ts` | inherited acceptance; no rerun |
| actions:25 | formal-baseline-30 | `packages/web/tests/unit/actions.test.ts` | canonical-baseline-11.json, canonical-baseline-12.json |
| actions:26 | formal-baseline-30 | `packages/web/tests/unit/native-surface.test.ts` | canonical-baseline-01.json, canonical-baseline-02.json, canonical-baseline-03.json, canonical-baseline-04.json |
| actions:27 | formal-baseline-30 | `packages/web/tests/unit/native-surface.test.ts` | canonical-baseline-05.json |
| actions:28 | formal-baseline-30 | `packages/web/tests/unit/native-surface.test.ts` | canonical-baseline-06.json |
| actions:29 | retained | `packages/web/tests/unit/actions.test.ts` | original retained |
| actions:30 | formal-baseline-30 | `packages/web/tests/unit/native-surface.test.ts` | canonical-baseline-07.json |
| actions:31 | formal-baseline-30 | `packages/web/tests/unit/native-surface.test.ts` | canonical-baseline-17.json |
| actions:32 | formal-baseline-30 | `packages/web/tests/unit/native-surface.test.ts` | canonical-baseline-17.json |
| observation-capture:1 | retained | `packages/web/tests/unit/observation-capture.test.ts` | original retained |
| observation-capture:2 | retained | `packages/web/tests/unit/observation-capture.test.ts` | original retained |
| observation-capture:3 | retained | `packages/web/tests/unit/observation-capture.test.ts` | original retained |
| observation-capture:4 | retained | `packages/web/tests/unit/observation-capture.test.ts` | original retained |
| observation-capture:5 | retained | `packages/web/tests/unit/observation-capture.test.ts` | original retained |
| observation-capture:6 | formal-baseline-30 | `packages/web/tests/unit/observation-capture.test.ts` | inherited acceptance; no rerun |
| observation-capture:7 | retained | `packages/web/tests/unit/observation-capture.test.ts` | original retained |
| observation-capture:8 | formal-baseline-30 | `packages/web/tests/unit/observation-capture.test.ts` | inherited acceptance; no rerun |
| observation-capture:9 | retained | `packages/web/tests/unit/observation-capture.test.ts` | original retained |
| observation-capture:10 | formal-baseline-30 | `packages/web/tests/unit/observation-capture.test.ts` | inherited acceptance; no rerun |
| observation-capture:11 | retained | `packages/web/tests/unit/observation-capture.test.ts` | original retained |
| surface-lifecycle:1 | retained | `packages/web/tests/unit/surface-lifecycle.test.ts` | original retained |
| surface-lifecycle:2 | formal-baseline-30 | `packages/web/tests/unit/surface-lifecycle.test.ts` | inherited acceptance; no rerun |
| surface-lifecycle:3 | retained | `packages/web/tests/unit/surface-lifecycle.test.ts` | original retained |
| locators:1 | formal-baseline-30 | `packages/web/tests/unit/locators.test.ts` | canonical-node-query-matcher.json, canonical39-rust-04.json, canonical-baseline-16.json |
| locators:2 | formal-baseline-30 | `packages/web/tests/unit/locators.test.ts` | canonical-node-query-matcher.json, canonical39-rust-04.json, canonical-baseline-16.json |
| locators:3 | accepted-staging-39 | `packages/web/tests/unit/locators.test.ts` | canonical-node-author-metadata.json, canonical-node-locator-projection.json |
| locators:4 | accepted-staging-39 | `packages/web/tests/unit/locators.test.ts` | canonical-node-locator-projection.json, canonical39-rust-05.json, canonical39-rust-06.json |
| locators:5 | accepted-staging-39 | `packages/web/tests/unit/locators.test.ts` | canonical-node-locator-projection.json, canonical39-rust-07.json |
| locators:6 | formal-baseline-30 | `packages/web/tests/unit/locators.test.ts` | canonical-node-query-matcher.json, canonical39-rust-04.json, canonical-baseline-16.json |
| locators:7 | accepted-staging-39 | `packages/web/tests/unit/locators.test.ts` | canonical-node-query-matcher.json, canonical39-rust-04.json |
| locators:8 | formal-baseline-30 | `packages/web/tests/unit/locators.test.ts` | canonical-node-query-matcher.json, canonical39-rust-04.json, canonical-baseline-16.json |
| locators:9 | accepted-staging-39 | `packages/web/tests/unit/locators.test.ts` | canonical-node-query-matcher.json, canonical39-rust-04.json |
| locators:10 | formal-baseline-30 | `packages/web/tests/unit/locators.test.ts` | canonical-node-query-matcher.json, canonical39-rust-04.json, canonical-baseline-16.json |
| locators:11 | formal-baseline-30 | `packages/web/tests/unit/locators.test.ts` | canonical-node-query-matcher.json, canonical39-rust-04.json, canonical-baseline-16.json |
| locators:12 | formal-baseline-30 | `packages/web/tests/unit/locators.test.ts` | canonical-node-query-matcher.json, canonical39-rust-04.json, canonical-baseline-16.json |
| locators:13 | formal-baseline-30 | `packages/web/tests/unit/locators.test.ts` | canonical-node-query-matcher.json, canonical39-rust-04.json, canonical-baseline-16.json |
| locators:14 | accepted-staging-39 | `packages/web/tests/unit/locators.test.ts` | canonical-node-query-matcher.json |
| semantic-fallback:1 | accepted-staging-39 | `packages/web/tests/unit/semantic-fallback.test.ts` | canonical39-rust-10.json, canonical39-rust-11.json, canonical39-rust-12.json, canonical39-rust-13.json |
| attempt-session:1 | retained | `packages/web/tests/unit/attempt-session.test.ts` | original retained |
| attempt-session:2 | retained | `packages/web/tests/unit/attempt-session.test.ts` | original retained |
| attempt-session:3 | retained | `packages/web/tests/unit/attempt-session.test.ts` | original retained |
| attempt-session:4 | retained | `packages/web/tests/unit/attempt-session.test.ts` | original retained |
| attempt-session:5 | retained | `packages/web/tests/unit/attempt-session.test.ts` | original retained |
| attempt-session:6 | retained | `packages/web/tests/unit/attempt-session.test.ts` | original retained |
| attempt-session:7 | retained | `packages/web/tests/unit/attempt-session.test.ts` | original retained |
| attempt-session:8 | retained | `packages/web/tests/unit/attempt-session.test.ts` | original retained |
| attempt-session:9 | retained | `packages/web/tests/unit/attempt-session.test.ts` | original retained |
| video:1 | retained | `packages/web/tests/unit/video.test.ts` | original retained |
| video:2 | retained | `packages/web/tests/unit/video.test.ts` | original retained |
| video:3 | formal-baseline-30 | `packages/web/tests/unit/native-surface.test.ts` | canonical-baseline-14.json |
| video:4 | formal-baseline-30 | `packages/web/tests/unit/native-surface.test.ts` | canonical-baseline-15.json |
| video:5 | retained | `packages/web/tests/unit/video.test.ts` | original retained |
| video:6 | accepted-staging-39 | `packages/web/tests/unit/native-surface.test.ts` | canonical39-rust-09.json |
| read-node-names:1 | retained | `packages/web/tests/integration/read-node-names.test.ts` | original retained |
| read-node-names:2 | retained | `packages/web/tests/integration/read-node-names.test.ts` | original retained |
| read-node-names:3 | retained | `packages/web/tests/integration/read-node-names.test.ts` | original retained |
| read-node-names:4 | retained | `packages/web/tests/integration/read-node-names.test.ts` | original retained |
| read-node-names:5 | retained | `packages/web/tests/integration/read-node-names.test.ts` | original retained |
| read-node-names:6 | retained | `packages/web/tests/integration/read-node-names.test.ts` | original retained |
| read-node-names:7 | retained | `packages/web/tests/integration/read-node-names.test.ts` | original retained |
| read-node-names:8 | retained | `packages/web/tests/integration/read-node-names.test.ts` | original retained |
| read-node-names:9 | retained | `packages/web/tests/integration/read-node-names.test.ts` | original retained |
| read-node-names:10 | retained | `packages/web/tests/integration/read-node-names.test.ts` | original retained |
| read-node-names:11 | retained | `packages/web/tests/integration/read-node-names.test.ts` | original retained |
| read-node-names:12 | retained | `packages/web/tests/integration/read-node-names.test.ts` | original retained |
| read-node-names:13 | retained | `packages/web/tests/integration/read-node-names.test.ts` | original retained |
| observation:1 | retained | `packages/web/tests/integration/observation.test.ts` | original retained |

The full mapping records original titles and table rows, assertion bodies and SHA256, adapter scope, producer run status and the remaining proof gap for every identity. All raw failed, passed and unrun states are reported separately in the archive manifest.
