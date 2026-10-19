# Source-pinned agent-browser candidate

The complete source is on this feature branch. Upstream e2e remains pinned to `97f453fbcfd99b73faa0177ba60e489df9625b86`; the independent adapter does not replace the original Web or mobile packages.

Linux commit `e4d2561db569582525251c1d207a996f8ed235ef` passed 53/53 integration cases once, but its exact repeat exposed a screenshot pixel-proof defect. That older privacy epoch must not be treated as stable. The decoded-PNG follow-up at `ffa91805374e2aa05f283877c0daf40c93161bd5` passed all 12 independent masking rounds and its packaged consumer, but the full matrix remained 51/53 because of native target-lifetime timeouts. The next candidate requires native `0.39.1-e2e.4`, adds a 12-round public probe/native-command regression, retains the `agent-browser-exact-5` privacy epoch, and corrects the macOS workflow setup. Full repeated Linux and both hosted Mac gates remain required.

See `VALIDATION.md` for exact evidence and remaining platform/UAT boundaries, `INSTALL.md` for matching source-pinned package/native artifacts, and `UPSTREAM_SYNC.md` for maintenance. Only successful current workflows and their exact artifact manifests establish a tested candidate. The macOS workflow exercises native/unit and selected locator/runner/consumer acceptance, not the full Linux matrix.

No npm release, GitHub release, deployment or main-branch merge is performed by these workflows. Private-application acceptance on the user's actual computer remains separate.
