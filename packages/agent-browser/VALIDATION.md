# Validation status

This is an implementation checkpoint, not a declaration of complete compatibility.

## Verified in the build workspace

- Public SPI-only package boundary; no core-to-engine dependency or Playwright runtime import.
- Adapter TypeScript build and typecheck.
- 332 unit tests passed in the latest workspace follow-up. Unit suites cover CLI subprocess transport, strict error mapping, CDP concurrency, owned-target routing, observation preservation, storage codecs, masking checks, fixtures, and launch cleanup.
- The maintained Rust patch applies to the exact pinned upstream source.
- Fresh packaged consumption passed outside the workspace: actual `e2e` and adapter tarballs, offline installation and frozen reinstall, public imports resolving inside the consumer, installed TypeScript declarations, and installed CLI test collection. Its real-browser observation/action/report/trace smoke is a separate mandatory CI gate, not a local browser pass.

## Exact-commit real-browser evidence

The exact runtime at `e4d2561db569582525251c1d207a996f8ed235ef` passed [CI9 attempt 1](https://github.com/levicode/e2e/actions/runs/39310203701/attempts/1):

- Native compilation and tests: 1,498 passed, zero failed, 147 upstream ignored.
- Adapter unit tests: 292 passed, zero skipped; build, typecheck and lint passed.
- Focused default-snapshot unnamed-icon smoke: passed.
- Full integration gate: 53 passed, zero failed, zero skipped. This includes real Chromium contracts and the separate real ffmpeg encoder check.
- Fresh packaged-consumer installation and browser gate: passed, with exactly one external fixture mutation and zero model calls.

The default observation preserves an unchanged unnamed, below-viewport cursor-pointer icon. Public `openHost` and runner tests use it to open a visible synthetic tag list, without a preloaded business label or selector workaround. Closed trace/report output, record/replay, strict cross-engine cache refusal, zero-executor replay with exactly one click, and missing-target replay refusal pass.

Other passing Linux cases cover ordered trusted ASCII events, literal CLI-looking input, stale-ref refusal, lost-acknowledgement no-duplicate behavior, frame/closed-shadow locators, actionability, controlled checkboxes, upload/select semantics, rich IndexedDB state replacement, attempt hook preservation, callback retirement, protected popup initialization, OOPIF source-mask PNG pixels, post-capture task resumption, dedicated-provider ownership, shared-provider no-touch refusal, downloads and video artifacts.

[The exact packaged-consumer artifact](https://github.com/levicode/e2e/actions/runs/39310203701/artifacts/12215766306) was independently checked: all 17 evidence files and all 48 adapter output files match the frozen source build. It contains no private application data.

The exact-commit repeat (attempt 2) passed 52/53 integration cases and the fresh consumer again, but failed a real password-mask pixel assertion: the returned image contained white where opaque black was required. This blocks release and proves the first green run was insufficient. The follow-up requires decoded-PNG mask attestation, a new privacy/cache epoch (`agent-browser-exact-5`), and a fresh repeated full run.

[The decoded-PNG follow-up at `ffa91805374e2aa05f283877c0daf40c93161bd5`](https://github.com/levicode/e2e/actions/runs/39314268883) passed native 1,498 tests, all 331 then-current adapter units, the icon smoke and fresh consumer. All 12 independent repeated masking captures passed actual opaque-black pixel checks and cleanup assertions. The full matrix was 51/53: two existing native lifecycle timeouts still blocked restart and navigation after a temporary probe. No native binary artifact was uploaded from the failed full gate.

The next candidate gates native version `0.39.1-e2e.4`, with cancellation tied to destroyed probe targets, and adds a separate 12-round public native-observe/open regression. Its real matrix now has 54 mandatory cases. Those source changes and the macOS workflow corrections require new execution evidence; they are not a completed acceptance result.

A second complete green run of the corrected exact commit is required before calling this candidate stable. Test source and isolated unit success do not substitute for a full run.

## Platform and application boundaries

- Linux full-contract evidence targets GitHub-hosted Ubuntu 24.04 x86_64 and the workflow's pinned Chromium distribution.
- The separate macOS workflow targets standard macOS 15 ARM64 and Intel runners. Its required scope is native compilation/tests, all adapter units, all seven locator/runner integration cases, and a fresh packaged-consumer browser run. It does **not** run the full Linux integration matrix: pixel/state/network/video contracts are not independently validated on macOS by that workflow. A workflow file is not an executed platform pass; check each architecture's successful job and artifact manifest.
- The local build workspace blocks Chromium sockets; its supported escalation path also fails during sandbox setup. No local real-browser pass is claimed.
- Private application UAT and real hosted-service accounts remain separate from these synthetic fixtures. The user's actual desktop environment has not been exercised.
- Artifacts identify exact source, compiler, OS, architecture and browser version. Older OS releases, other distributions, other browsers, and Windows are not implicitly supported.

## Explicit compatibility limits

- Chromium only; non-Chromium CDP implementations, Firefox, and WebKit are refused.
- Remote endpoints must be dedicated to one explicit attempt, with no unrelated contexts, pages, clients, or users. The public factory rejects worker/default-scope providers and worker/default-scope callback endpoints before any acquire or resolver callback. Use an attempt-scoped provider or `connect: { scope: 'attempt', cdpEndpoint }`. The legacy two-callback form still implies attempt scope unless explicitly overridden.
- Provider-side preparation or recording clients must not retain competing process-wide locale/timezone overrides. Exact duplicate-override handling relies on this documented condition; it does not independently prove renderer identity. Local launches do not have such a competing client.
- Shared-browser/provider parity is unsupported. Real Chromium CI exposed that required first-popup interception and zero attachment/pause of unrelated targets cannot both be guaranteed through public CDP. Internal worker lease/source tests are implementation tests, not evidence of a supported public shared mode. Initial exclusive-context verification remains enabled; the provisioner is responsible for exclusive ownership throughout the attempt.
- State covers supported structured-clone IndexedDB values, cookies, localStorage and live-tab sessionStorage. Partitioned third-party storage, unsupported host objects such as CryptoKeys, and historical per-tab sessionStorage are not silently approximated.
- Screenshot proof rejects unsupported frame geometry and PNG formats/resource sizes; see the exact limits in `ADAPTER_COMPATIBILITY.md`. Rejected screenshot bytes are neither returned nor written to artifacts.
- Artifact video is unredacted and never supplied as model pixels. Remote downloads require a provider transfer hook.
- Automatic reconnect/retry after ambiguous input is intentionally unavailable. A new explicit attempt is required.
- Real hosted-provider accounts and private application UAT remain separate from the synthetic local-service fixtures.
- Asynchronous fixture callbacks and input acknowledgements are fenced to their original browser generation. Callback continuations also cannot acquire fresh fixture operations after their invocation completes or expires. Route decision chains remain live through tracked fallback completion. These guards do not undo commands already dispatched. Unit regressions and the real-browser callback-retirement and restart gates passed CI9.
- Successful fill/clear, uncheck, hover, explicit scrolling, locator drag and coordinate swipe actions have mandatory real acceptance cases. The pointer-only swipe fixture and its trusted event assertions passed CI9. Do not treat this development checkpoint as a production release.

- Scoped initial CLI attachment remains required within dedicated endpoint mode. Factory preflight regression tests assert that shared providers and callback endpoints are rejected without invoking any provider or endpoint callbacks. The dedicated-provider real-browser gates passed CI9; earlier shared-provider success expectations are not a supported compatibility claim.
