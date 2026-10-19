# Source-pinned agent-browser candidate

The complete source is on this feature branch. Upstream e2e remains pinned to `97f453fbcfd99b73faa0177ba60e489df9625b86`; the independent adapter does not replace the original Web or mobile packages.

Linux commit `e4d2561db569582525251c1d207a996f8ed235ef` passed 53/53 integration cases once, but its exact repeat exposed a screenshot pixel-proof defect. That older privacy epoch must not be treated as stable. The follow-up adds decoded-PNG black-region attestation, repeated masking fixtures, the `agent-browser-exact-5` cache epoch, and safe short socket paths for macOS.

See `VALIDATION.md` for exact evidence and remaining platform/UAT boundaries, `INSTALL.md` for matching source-pinned package/native artifacts, and `UPSTREAM_SYNC.md` for maintenance. Only successful current workflows and their exact artifact manifests establish a tested candidate. The macOS workflow exercises native/unit and selected locator/runner/consumer acceptance, not the full Linux matrix.

No npm release, GitHub release, deployment or main-branch merge is performed by these workflows. Private-application acceptance on the user's actual computer remains separate.
