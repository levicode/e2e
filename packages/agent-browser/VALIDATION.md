# Validation status

This is an implementation checkpoint, not a declaration of complete compatibility.

## Verified in the build workspace

- Public SPI-only package boundary; no core-to-engine dependency or Playwright runtime import.
- Adapter TypeScript build and typecheck.
- 271 unit tests passed in the latest workspace follow-up, including real ffmpeg encode/decode validation without Chromium. Unit suites cover CLI subprocess transport, strict error mapping, CDP concurrency, owned-target routing, observation preservation, storage codecs, masking checks, fixtures, and launch cleanup.
- The maintained Rust patch applies to the exact pinned upstream source.
- Fresh packaged consumption passed outside the workspace: actual `e2e` and adapter tarballs, offline installation and frozen reinstall, public imports resolving inside the consumer, installed TypeScript declarations, and installed CLI test collection. Its real-browser observation/action/report/trace smoke is a separate mandatory CI gate, not a local browser pass.

## Awaiting the required execution environment

- Latest frozen CI checkpoint `b30215e9` (CI6) passed native compilation and the native suite: 1,493 passed, zero failed, 147 upstream ignored. The adapter unit suite passed 257 tests at that commit.
- Its real Chromium gate ran all 53 cases: 39 passed, 14 failed, zero skipped. A separate default-snapshot unnamed-icon smoke passed: the real public CLI exposed the offscreen generic cursor ref and clicked it exactly once with automatic scrolling. The complete public runner/action path and packaged-consumer browser run still failed after observation, so the smoke alone is not end-to-end acceptance.
- CI6 also passed fresh tarball install, frozen reinstall, public imports, installed declarations, and test collection. Its browser failure artifacts are retained in the workflow.
- The latest source fixes the diagnosed native lifecycle-envelope pointer synchronization, empty-file clearing, iframe padding, and omitted OOPIF focus edge. Storage recapture and masked-capture navigation have fixed, value-free diagnostic phase labels; their unresolved failures must be investigated, not treated as passes. Every real acceptance case remains mandatory.
- Shared endpoints are rejected before provisioning. The real no-touch rejection sentinel and dedicated attempt lifecycle passed; the dedicated nested-OOPIF/popup fixture still requires rerun after correcting its synthetic hostnames to the existing HTTP loopback policy. Passing unit tests does not establish complete browser or application compatibility.
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
