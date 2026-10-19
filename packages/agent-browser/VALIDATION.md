# Validation status

This is an implementation checkpoint, not a declaration of complete compatibility.

## Verified in the build workspace

- Public SPI-only package boundary; no core-to-engine dependency or Playwright runtime import.
- Adapter TypeScript build and typecheck.
- 283 unit tests passed in the latest workspace follow-up, including real ffmpeg encode/decode validation without Chromium. Unit suites cover CLI subprocess transport, strict error mapping, CDP concurrency, owned-target routing, observation preservation, storage codecs, masking checks, fixtures, and launch cleanup.
- The maintained Rust patch applies to the exact pinned upstream source.
- Fresh packaged consumption passed outside the workspace: actual `e2e` and adapter tarballs, offline installation and frozen reinstall, public imports resolving inside the consumer, installed TypeScript declarations, and installed CLI test collection. Its real-browser observation/action/report/trace smoke is a separate mandatory CI gate, not a local browser pass.

## Awaiting the required execution environment

- Latest frozen CI checkpoint `a3f69efa` (CI7) passed native compilation and the native suite: 1,495 passed, zero failed, 147 upstream ignored. The adapter unit suite passed 271 tests at that commit.
- Its real Chromium gate ran all 53 cases: 46 passed, seven failed, zero skipped. The default-snapshot unnamed-icon smoke and public `openHost` observation/action/closed-trace/report test passed. The public runner recorded successfully but its test stopped at an incorrect JSON report comparison before completing replay assertions; replay still requires its full gate.
- The fresh packaged-consumer gate passed completely: actual tarballs installed outside the workspace, frozen reinstall, public import isolation, declarations, test collection, real observation/action/report/trace, zero model calls and exactly one external fixture commit. The workflow retains hashed evidence for that exact commit.
- Remaining failures exposed missing native ASCII key events, a closing-probe target race, automatic-interception cleanup cancellation, and intermittent popup protection. The latest source addresses these with bounded owned-target destruction checks, teardown-specific cancellation handling, and a newly gated passive scoped CLI build. Public popup setup belongs exclusively to the companion; an older native client must not resume its debugger pause.
- Coordinate swipe event diagnostics and lifecycle phase labels retain their original assertions and budgets. The runner fixture now asserts that the unchanged unnamed icon opens a visible synthetic tag list. Every real acceptance case remains mandatory at the next exact commit.
- Shared endpoints are rejected before provisioning. Both the no-touch shared rejection sentinel and dedicated nested-OOPIF/default-ref/popup-init fixture passed CI7. This does not establish hosted-service or private-application compatibility.
- The local workspace blocks Chromium sockets; the supported escalation path also fails during sandbox setup. No local real-browser pass is claimed.
- Private application UAT is separate and has not been run by these synthetic fixtures.

## Implemented paths awaiting real-browser validation

- Full CSS/XPath/frame locator semantics and frame-relative geometry/replay anchors.
- Protected app-site request headers and authentication.
- Preservation of attempt-scoped routes, dialogs, scripts and media across browser restart/reset.
- Composite-action deadline/cancellation accounting and input actionability edge cases.
- Hosted-provider compatibility, screencast/video, and runner-level trace/replay acceptance.
- Structured-clone IndexedDB and frame/closed-shadow screenshot behavior need real browser evidence.

No item above is treated as passing merely because its API or test source exists. CI failures must be fixed and rerun against the exact published commit before upgrading this status.

## Explicit compatibility limits

- Chromium only; non-Chromium CDP implementations, Firefox, and WebKit are refused.
- Remote endpoints must be dedicated to one explicit attempt, with no unrelated contexts, pages, clients, or users. The public factory rejects worker/default-scope providers and worker/default-scope callback endpoints before any acquire or resolver callback. Use an attempt-scoped provider or `connect: { scope: 'attempt', cdpEndpoint }`. The legacy two-callback form still implies attempt scope unless explicitly overridden.
- Shared-browser/provider parity is unsupported. Real Chromium CI exposed that required first-popup interception and zero attachment/pause of unrelated targets cannot both be guaranteed through public CDP. Internal worker lease/source tests are implementation tests, not evidence of a supported public shared mode. Initial exclusive-context verification remains enabled; the provisioner is responsible for exclusive ownership throughout the attempt.
- State covers supported structured-clone IndexedDB values, cookies, localStorage and live-tab sessionStorage. Partitioned third-party storage, unsupported host objects such as CryptoKeys, and historical per-tab sessionStorage are not silently approximated.
- Artifact video is unredacted and never supplied as model pixels. Remote downloads require a provider transfer hook.
- Automatic reconnect/retry after ambiguous input is intentionally unavailable. A new explicit attempt is required.
- Real hosted-provider accounts and private application UAT remain separate from the synthetic local-service fixtures.
- Asynchronous fixture callbacks and input acknowledgements are fenced to their original browser generation. Callback continuations also cannot acquire fresh fixture operations after their invocation completes or expires. Route decision chains remain live through tracked fallback completion. These guards do not undo commands already dispatched. Unit regressions pass; the real-browser callback-retirement and restart gates still require execution.
- Successful fill/clear, uncheck, hover, explicit scrolling, locator drag/swipe, and coordinate swipe actions now have mandatory real acceptance cases. They still await execution. Do not treat this development checkpoint as a production release.

- Scoped initial CLI attachment remains required within dedicated endpoint mode. Factory preflight regression tests assert that shared providers and callback endpoints are rejected without invoking any provider or endpoint callbacks. The revised dedicated-provider real-browser gates must still pass at the exact candidate commit; the earlier shared-provider sentinel expectations are not a supported compatibility claim.
