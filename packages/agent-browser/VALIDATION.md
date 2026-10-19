# Validation status

This is an implementation checkpoint, not a declaration of complete compatibility.

## Verified in the build workspace

- Public SPI-only package boundary; no core-to-engine dependency or Playwright runtime import.
- Adapter TypeScript build and typecheck.
- 195 unit tests passed at checkpoint 3 preparation, including real ffmpeg encode/decode validation without Chromium. Unit suites cover CLI subprocess transport, strict error mapping, CDP concurrency, browser-wide routing, observation preservation, storage codecs, masking checks, fixtures, and launch cleanup.
- The maintained Rust patch applies to the exact pinned upstream source.

## Awaiting the required execution environment

- Native Rust compilation/tests and real Chromium fixture suites run in the dedicated GitHub workflow.
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
- Asynchronous fixture callbacks surviving a same-attempt restart require additional generation review; do not treat this development checkpoint as a production release.
