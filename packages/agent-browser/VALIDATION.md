# Verified validation status

The evidence below belongs to the pre-migration `0.39.1-e2e.4` delivery. It does not validate the prepared `0.39.1-e2e.5` fork-source migration. That candidate needs a reviewed source lock and new Linux/macOS runs before these claims can apply to it.

Updated October 19, 2026. The tested runtime is **`e1c7458d44a6ce0d7b7cb12bfdd727271898ae72`**, native **`0.39.1-e2e.4`**, engine/cache identity **`agent-browser-exact-5`**, engine version **`0.0.0-ab.0.39.1-exact.4-cdp.5`**.

The documented synthetic acceptance gates pass. Private-application UAT and the user's actual computer have not been exercised. This is a source-pinned fork candidate, not an npm release or a claim of unrestricted Web/Playwright compatibility.

## Linux: two complete runs of the exact final commit

[Attempt 1](https://github.com/levicode/e2e/actions/runs/39324527722/attempts/1), job `118306808095`, and [attempt 2](https://github.com/levicode/e2e/actions/runs/39324527722/attempts/2), job `118312315969`, both passed:

- Focused native launch-isolation regression: 1 passed.
- Entire native suite: 1,501 passed, zero failed, 147 existing upstream ignored tests, explicitly reported.
- Adapter build, typecheck, lint and all 333 units, with zero skipped.
- Focused native default unnamed-icon smoke: 1 passed.
- All 54 integration cases, zero failed and zero skipped. These include real Chromium contracts, explicit configuration-refusal checks and the real video encoder check.
- Fresh outside-workspace installation of the actual core/adapter tarballs, frozen reinstall, public imports, declarations, test collection and real-browser action/report/trace.
- Native executable packaging and architecture/provenance checks.

Each fresh consumer records exactly one fixture-side mutation and zero model calls. Both runs include 12 independent decoded-PNG mask captures and a separate 12-round public state-capture → native-observe → masked-observe → native-open regression. Required opaque-black pixels, unrelated-white controls, restoration, retained storage and subsequent native actions all pass without retries or enlarged operation budgets.

## macOS: both native architectures

The [macOS workflow](https://github.com/levicode/e2e/actions/runs/39324527558) passed on standard hosted macOS 15 ARM64 and Intel machines, both reporting macOS 15.7.9:

- [ARM64 job `118306807904`](https://github.com/levicode/e2e/actions/runs/39324527558/job/118306807904).
- [Intel job `118306807693`](https://github.com/levicode/e2e/actions/runs/39324527558/job/118306807693).

Each passed the focused native regression, all 1,499 platform-native tests (147 upstream ignored), all 333 units with zero skips, build/typecheck/lint, five real locator/default-glyph cases, two public runner/replay cases, fresh installed consumer and native artifact upload. The platform-specific native counts differ from Linux; no additional skip was introduced.

**This macOS scope is seven selected browser cases plus the fresh consumer, not the full Linux matrix.** Pixel/state/network/video contracts have not received that complete matrix on macOS. Hosted Macs are not the user's actual desktop or private application.

## What the fixtures establish

- The unchanged unnamed, below-viewport cursor-pointer font icon stays in the default observation, including overflow scrolling. Public host/runner actions use its observed ref, automatically scroll, open a visible synthetic tag list and mutate exactly once. No preloaded business label or selector query supplies the agent's target.
- Detached refs cannot retarget replacement nodes. Controlled checkboxes do not click twice. Actual lost-acknowledgement fault injection commits once, reports nonretryable uncertainty and poisons the attempt.
- Actionability, fill/clear/uncheck/hover/scroll/gestures, trusted ASCII key pairs, literal CLI-looking input, selection/upload semantics, semantic/CSS/XPath locators and nested-frame/closed-shadow scopes are covered by the Linux matrix.
- Lifecycle/state cases cover attempt isolation, restart/reset/replacement, supported structured-clone IndexedDB graphs, cookies/localStorage/live sessionStorage, prepared dedicated providers and callback retirement.
- Network/fixture cases cover asynchronous routing, protected popup/OOPIF first requests, scoped headers and Basic authorization, early scripts, dialogs, downloads, diagnostics and recording.
- Screenshot proof requires source ownership, exact supported geometry, actual decoded opaque-black pixels and successful cleanup. A failed proof withholds bytes; no unmasked fallback is tested or allowed.
- Public e2e report/trace closure, record/replay, zero-executor replay and strict refusal of Web/previous-privacy-epoch/missing-target caches pass. Deterministic executors exercise execution, not model reasoning quality.

## Independent artifact checks

The final Linux repeat [consumer](https://github.com/levicode/e2e/actions/runs/39324527722/artifacts/12222124713) and [native](https://github.com/levicode/e2e/actions/runs/39324527722/artifacts/12222448273), ARM64 [consumer](https://github.com/levicode/e2e/actions/runs/39324527558/artifacts/12222277507) and [native](https://github.com/levicode/e2e/actions/runs/39324527558/artifacts/12222073579), and Intel [consumer](https://github.com/levicode/e2e/actions/runs/39324527558/artifacts/12223776234) and [native](https://github.com/levicode/e2e/actions/runs/39324527558/artifacts/12223508115) were independently checked.

All 17 consumer evidence hashes and all 50 packed adapter output files match the reviewed build. Core/adapter tarballs are byte-identical across platforms. Native archive checksums, binary hashes, ELF/Mach-O architecture, executable mode 0755, license/NOTICE and exact source/patch metadata verify. The Linux binary is byte-identical across both complete final-commit builds.

Artifacts record Node 24.19.0, Rust 1.93.0 and Chrome for Testing 156.0.8078.4. Linux is Ubuntu 24.04.5 x64/glibc 2.39. GitHub artifacts expire after seven days; supplied durable copies and their hashes do not depend on that retention. Read `INSTALL.md`, `ADAPTER_COMPATIBILITY.md` and the repository-root `VERIFIED_DELIVERY.md`.

## Boundaries and maintenance

- Chromium only. Shared/worker endpoints are refused before acquisition or connection; remote attempts require exclusive ownership of the whole endpoint. Provider-side preparation/recording clients must retain no competing locale/timezone overrides. Initial checks do not prove continued ownership or renderer identity.
- Fill uses exact-node DOM setters and synthetic input events. Trusted physical typing is a separate keyboard contract; unmapped Unicode uses text insertion.
- Partitioned third-party storage, unsupported IndexedDB host objects such as CryptoKeys, and historical per-tab sessionStorage are not silently approximated.
- Screenshot format/geometry/resource limits fail closed. Artifact video is unredacted and never supplied as model pixels; remote downloads require a provider transfer hook.
- Ambiguous input is not automatically retried or reconnected. A new explicit attempt is required. Lifetime guards cannot undo already-dispatched commands.
- Real hosted Kernel/smol accounts, private UAT, actual user desktops, Windows and other OS/browser versions remain untested. The local build workspace's Chromium socket restriction was respected; local units are not represented as local browser proof.

A previous privacy epoch failed a repeated real pixel assertion. The current epoch adds decoded-PNG attestation, preserves that assertion, and rejects old cache identities. Transient native target-lifetime stalls were fixed without raising stack or operation limits. Both complete final-source Linux runs pass the added stress regressions. See `UPSTREAM_SYNC.md` before changing either upstream pin or the maintained native source.

Later documentation-only commits do not represent new runtime test runs. The evidence above always names the exact tested runtime commit. No npm release, GitHub Release, deployment or main-branch merge is performed by these validation workflows.
