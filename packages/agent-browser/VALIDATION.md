# Validation status

This is an implementation checkpoint, not a declaration of complete compatibility.

## Verified in the build workspace

- Public SPI-only package boundary; no core-to-engine dependency or Playwright runtime import.
- Adapter TypeScript build and typecheck.
- 292 unit tests passed in the latest workspace follow-up, including real ffmpeg encode/decode validation without Chromium. Unit suites cover CLI subprocess transport, strict error mapping, CDP concurrency, owned-target routing, observation preservation, storage codecs, masking checks, fixtures, and launch cleanup.
- The maintained Rust patch applies to the exact pinned upstream source.
- Fresh packaged consumption passed outside the workspace: actual `e2e` and adapter tarballs, offline installation and frozen reinstall, public imports resolving inside the consumer, installed TypeScript declarations, and installed CLI test collection. Its real-browser observation/action/report/trace smoke is a separate mandatory CI gate, not a local browser pass.

## Exact-commit real-browser evidence

- Latest executed checkpoint `85fbb0de468ca84e817cb99f76b2093abb5d583a` ([CI8](https://github.com/levicode/e2e/actions/runs/39307695383)) passed native compilation and the native suite: 1,498 passed, zero failed, 147 upstream ignored. Its adapter unit suite passed all 283 tests.
- Its real Chromium gate ran every one of 53 cases: 49 passed, four failed, zero skipped. The separate default-snapshot unnamed-icon smoke also passed.
- Public `openHost` and runner acceptance passed: an unchanged unnamed, below-viewport cursor-pointer icon opens a visible synthetic tag list through the default observation and normal action tool. Closed trace/report output, record/replay, strict cross-engine cache refusal, zero-executor replay with exactly one external click, and missing-target replay refusal all passed.
- The fresh packaged-consumer gate passed completely: actual tarballs installed outside the workspace, frozen reinstall, public import isolation, declarations, test collection, real observation/action/report/trace, zero model calls and exactly one external fixture commit. [The hashed artifact](https://github.com/levicode/e2e/actions/runs/39307695383/artifacts/12214937328) belongs to that exact commit. Its 17 evidence files and all 48 packed adapter output files were independently checked.
- Passing cases include ordered trusted ASCII key events, literal CLI-looking input, stale-ref refusal, lost-acknowledgement no-duplicate behavior, deterministic nested-frame/closed-shadow queries, controlled checkboxes, upload/select semantics, structured state replacement, attempt hook preservation, callback retirement, dedicated-provider nested OOPIF actions and popup initialization, shared-provider no-touch refusal, downloads and video artifacts.
- Four cases remain failing: a point-only swipe fixture enters standard selected-text HTML drag; navigation after masked capture can stall; protected same-renderer popup initialization can stall; and a cross-origin pixel/state case rejects pixel proof. Each remains a mandatory gate. Source changes and diagnostic improvements after this commit are not counted as real-browser passes.
- Main-frame/open-shadow/child-frame pixel assertions passed before the later navigation failure, but this does not establish complete screenshot lifecycle stability or all OOPIF masking behavior.
- The local workspace blocks Chromium sockets; the supported escalation path also fails during sandbox setup. No local real-browser pass is claimed.
- Private application UAT and real hosted-service accounts are separate and have not been exercised by these synthetic fixtures.

A fully passing exact-commit run and a second complete run of that same commit are required before describing this candidate as stable. Test source, a clean patch application, and isolated unit success do not substitute for those gates.

## Explicit compatibility limits

- Chromium only; non-Chromium CDP implementations, Firefox, and WebKit are refused.
- Remote endpoints must be dedicated to one explicit attempt, with no unrelated contexts, pages, clients, or users. The public factory rejects worker/default-scope providers and worker/default-scope callback endpoints before any acquire or resolver callback. Use an attempt-scoped provider or `connect: { scope: 'attempt', cdpEndpoint }`. The legacy two-callback form still implies attempt scope unless explicitly overridden.
- Provider-side preparation or recording clients must not retain competing process-wide locale/timezone overrides. Exact duplicate-override handling relies on this documented condition; it does not independently prove renderer identity. Local launches do not have such a competing client.
- Shared-browser/provider parity is unsupported. Real Chromium CI exposed that required first-popup interception and zero attachment/pause of unrelated targets cannot both be guaranteed through public CDP. Internal worker lease/source tests are implementation tests, not evidence of a supported public shared mode. Initial exclusive-context verification remains enabled; the provisioner is responsible for exclusive ownership throughout the attempt.
- State covers supported structured-clone IndexedDB values, cookies, localStorage and live-tab sessionStorage. Partitioned third-party storage, unsupported host objects such as CryptoKeys, and historical per-tab sessionStorage are not silently approximated.
- Artifact video is unredacted and never supplied as model pixels. Remote downloads require a provider transfer hook.
- Automatic reconnect/retry after ambiguous input is intentionally unavailable. A new explicit attempt is required.
- Real hosted-provider accounts and private application UAT remain separate from the synthetic local-service fixtures.
- Asynchronous fixture callbacks and input acknowledgements are fenced to their original browser generation. Callback continuations also cannot acquire fresh fixture operations after their invocation completes or expires. Route decision chains remain live through tracked fallback completion. These guards do not undo commands already dispatched. Unit regressions and the real-browser callback-retirement and restart gates passed CI8.
- Successful fill/clear, uncheck, hover, explicit scrolling, locator drag and coordinate swipe actions have mandatory real acceptance cases. The point-only swipe fixture remains failing as described above. Do not treat this development checkpoint as a production release.

- Scoped initial CLI attachment remains required within dedicated endpoint mode. Factory preflight regression tests assert that shared providers and callback endpoints are rejected without invoking any provider or endpoint callbacks. The dedicated-provider real-browser gates passed CI8; earlier shared-provider success expectations are not a supported compatibility claim.
