# Source-pinned agent-browser delivery

This dated status describes the pre-migration `0.39.1-e2e.4` delivery. The prepared `0.39.1-e2e.5` source-lock migration requires separate review and validation; see `VALIDATION.md`.

Updated October 19, 2026. Tested runtime: **`e1c7458d44a6ce0d7b7cb12bfdd727271898ae72`**.

The final runtime passes two complete Linux runs: 1,501 native tests, all 333 units, default unnamed-icon smoke, all 54 integration cases with zero skips, and fresh installed-package execution. Both macOS 15 ARM64 and Intel pass their native/unit/static gates, five locator cases, two public runner/replay cases and fresh installed consumer. The 147 existing upstream native ignored tests remain explicitly reported.

The Mac workflow covers selected browser contracts; the complete pixel/state/network/video matrix remains Linux-only. Private-application UAT and the user's actual computer remain untested. This is a usable source-pinned candidate within the explicit Chromium/dedicated-endpoint scope, not unrestricted Web/Playwright parity.

Read `VALIDATION.md` for exact run/artifact links and limitations, `INSTALL.md` for installation, `ADAPTER_COMPATIBILITY.md` for migration, `UPSTREAM_SYNC.md` for maintenance, and repository-root `VERIFIED_DELIVERY.md` for the dated delivery summary. Native version is `0.39.1-e2e.4`; cache identity is `agent-browser-exact-5`.

Original Web/mobile packages and upstream core remain preserved. Later status-document updates change documentation only and do not create another tested runtime build. No npm/GitHub release, deployment or main merge has been performed.
