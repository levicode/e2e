# Validation status

This is an implementation checkpoint, not a declaration of complete compatibility.

## Verified in the build workspace

- Public SPI-only package boundary; no core-to-engine dependency or Playwright runtime import.
- Adapter TypeScript build and typecheck.
- 233 unit tests passed in the latest workspace follow-up, including real ffmpeg encode/decode validation without Chromium. Unit suites cover CLI subprocess transport, strict error mapping, CDP concurrency, owned-target routing, observation preservation, storage codecs, masking checks, fixtures, and launch cleanup.
- The maintained Rust patch applies to the exact pinned upstream source.

## Awaiting the required execution environment

- CI run 39295892553 on commit `134a1826427983c850d8ded7ae38d153d83f6209` passed native compilation and the native suite: 1,470 passed, zero failed, 147 upstream ignored. Adapter build, typecheck, lint and 209 unit tests also passed.
- Its first real Chromium gate ran all 43 cases: seven passed, 36 failed, zero skipped. Most public-engine tests stopped at a default-context identity mismatch; other failures exposed remote-frame topology, popup initialization and visibility restoration. Follow-up fixes must pass a new exact-commit CI run before these paths are called verified.
- The seven browser passes cover same-target fulfilment, asynchronous LIFO rewrite, truncated-body rejection, scoped-auth redirect isolation, excluded-frame observation policy, ffmpeg timing, and real Chromium screencast segments. They do not establish glyph/input/state/runner acceptance.
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
- State covers supported structured-clone IndexedDB values, cookies, localStorage and live-tab sessionStorage. Partitioned third-party storage, unsupported host objects such as CryptoKeys, and historical per-tab sessionStorage are not silently approximated.
- Artifact video is unredacted and never supplied as model pixels. Remote downloads require a provider transfer hook.
- Automatic reconnect/retry after ambiguous input is intentionally unavailable. A new explicit attempt is required.
- Real hosted-provider accounts and private application UAT remain separate from the synthetic local-service fixtures.
- Asynchronous fixture callbacks and input acknowledgements are fenced to their original browser generation. The regressions pass locally, but real-browser restart acceptance still awaits CI.
- Successful fill/clear, uncheck, hover, explicit scrolling, locator drag/swipe, and coordinate swipe actions now have mandatory real acceptance cases. They still await execution. Do not treat this development checkpoint as a production release.

- Scoped initial CLI attachment and owned-family companion monitoring have been implemented. Their transparent-proxy provider-isolation fixtures remain mandatory and unverified; they assert no foreign attachment/pause and owned popup interception before application code.
