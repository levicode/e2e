# Native public candidate workflow

`native-foundation.yml` remains a narrow foundation checkpoint, not release
acceptance. `native-candidate.yml` is a separate opt-in Linux candidate gate.
Neither workflow publishes packages, calls models or certifies a release.

Before the workflow exists on the default branch, run it by pushing the reviewed
e2e commit to the dedicated `implement/native-full-ci` branch. First set
`.github/native-candidate.json` to the exact verified public native commit and
whether the optional benchmark sweep is requested. The initial null commit is an
intentional fail-closed handoff, not a runnable source pin. No other push branch
or pull request triggers this workflow, and this does not require merging main.
GitHub documents the [manual default-branch requirement](https://docs.github.com/actions/managing-workflow-runs/manually-running-a-workflow)
and [branch-local push behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push).

Once registered on the default branch, manual dispatch from the committed e2e
revision being reviewed accepts:

- `native_sha`: the exact, public, reviewed 40-character commit in
  `levicode/agent-browser`. Branch names and unpushed local commits are not inputs.
- `benchmark_sweep`: optional boolean, default `false`. When selected, the
  repository's synthetic `apps/web-benchmark` runs at `127.0.0.1:4280`. Its gates
  become mandatory for that run. No external/private application URL is accepted.

Prerequisites are ordinary GitHub-hosted Ubuntu access to the two public
repositories, locked npm/Cargo dependencies, the official Rust/Chromium downloads
and Ubuntu's ffmpeg package. The workflow provisions them. No repository secrets,
model credentials, private UAT data or reusable native build artifact are inputs.
The native revision must supply Cargo's `ci` profile and `acceptance-faults`
feature and all exact contracts in `candidate-manifest.ts`.

## Required evidence

- Complete core/Web builds, package/test typechecks and the unchanged production
  package-import test. Source removal is a separate mandatory gate: unreachable
  old backend files or tests staged under `legacy-oracle` cannot count as final
  native delivery. Existing assertion-bearing migration files must remain in
  ordinary discovery. Removing assertions is not a migration fix.
- Fresh default runtime and compiler-selected default test harnesses from the
  same clean native commit. Each harness runs directly, without repeating Cargo
  compilation for every browser contract. Upstream ignored inventory remains
  visible; every required hosted contract must run exactly once, with no skips.
  Unclassified ignored `native::client_*` tests fail inventory review.
- Both exact controlled preparation schedules must pass. Their bounded receipt
  is revalidated against the bundle's source/runtime identities, the reviewed
  fixture hash and the actual default compiler/harness before the final candidate
  can pass. Missing, skipped, failed, known-red or incomplete schedules never
  permit a candidate bundle upload.
- Separate production and feature runtime negotiations, including all 14 Web
  capability families. Only the semantic fault suite uses the feature binary;
  its bytes never enter a distributable bundle.
- All discovered Web unit/browser files, the canonical reference contract, and
  genuine public callback/primitives consumers. The semantic fault and
  differential files are explicit required partitions, not dropped tests.
- All five exact semantic fault assertions: the original tree-only deadline,
  tree-only cancellation, masked fallback and abandoned-ID cases, plus public
  capture supersession. The supersession fixture uses the same native client,
  channel and browser with the existing semantic-publish hold. B must finish
  and its committed ref must perform an actual action before manual release of
  A; A must settle as `NODE_STALE`. After release, B's ref must still act and a
  fresh same-scope observation must remain usable. The original cancellation
  case stays separate. Both ignored native supersession contracts are required
  in addition to the original 34 native contracts, with omission checks.
- All original 15 named differential fixtures and expectation reconciliation,
  independently of the optional benchmark sweep. Only the precisely named
  optional benchmark assertion may be skipped in this dedicated fixture gate;
  any missing/skipped required assertion fails.
- Existing bundle assembly, packed inventories and installer verification,
  followed by an actual installed `e2e/runner` / `@e2e-dev/web` public browser
  session without `E2E_AGENT_BROWSER_EXECUTABLE`. Package bytes are checked before
  and after, and the final receipt binds packed executable files to suite-tested
  builds, the production hash and native source identity.

Independent diagnostics continue after unrelated failures. The final receipt
requires every applicable gate to succeed. Evidence is uploaded on failures; the
installable production bundle is uploaded only after the complete candidate gate
passes. Foundation metadata or advertised capabilities never waive other gates.
The explicitly excluded external-direct-URL ingress diagnostic is recorded as a
known unsupported ingress path, not reported as a passing containment contract.

The semantic diagnostic inventory has five fixed TS case files, five exclusive
owner directories and one shared native/proxy file. Each TS file is capped at
400 records / 200 KiB (reduced from 512 / 256 KiB); the shared native file remains
2048 records / 256 KiB. Total limits remain 4096 records / 1280 KiB, and each
record remains at most 512 bytes. The reader applies these same bounds and
requires all five process links. Schema v2 scalar-only records are unchanged;
missing, capped, partial or invalid evidence remains inconclusive, independent
of functional results. Adding fixtures or passing orchestration checks is not
real-browser proof: the new public and native supersession gates require hosted
execution before claiming that behavior passed. The optional benchmark remains
unchanged and is not a substitute for these mandatory cases.

## Diagnostic-only exact-build reuse

The same ordinary candidate run may upload `native-focused-diagnostic-<native SHA>-<run>-<attempt>`
with three-day retention. This is not the installable candidate bundle and is
never release or acceptance evidence, even when its packaging succeeds.
It contains exactly `production`, `default-test-harness`, and `manifest.json`.
No target directory, workspace, environment, cache, home, browser profile,
feature runtime, credentials, or raw compiler/listing output enters it.

The build receipt is captured before any acceptance-faults build. Packaging
reuses only the existing verified preparation listing, including when a later
exact test failed; a missing or unverified listing produces no artifact. The
closed manifest binds both repositories/commits/trees, Cargo.lock, workflow,
compiler metadata, default features/profile, toolchain/host triple, installed
Chromium version/hash, listing digest, binary lengths and SHA256 values. Source,
compiler manifests and original/copied bytes are rechecked before atomic staging.
All existing mandatory gates and the gated installable bundle remain unchanged.

To use a downloaded artifact, first check the GitHub-returned artifact digest
and inspect archive entries before extracting into a fresh directory (reject
absolute/parent paths, links, duplicates, extra files and oversized entries).
Cross-check the manifest against the desired native/e2e revisions and current
clean source trees, then check its trusted digest and every file digest; the
`verifyFocusedArtifact` helper checks a safely extracted directory against an
independently trusted manifest and digest. It does not extract, install, chmod,
or execute anything. Do not assume host compatibility from filenames. Native
execution requires separate authorization, a compatible Linux host/toolchain
runtime, the same Chromium version, and fresh runtime negotiation. Use only an
existing exact allowlisted test with `--exact`, retaining its original body,
timeout and cleanup. Focused evidence never replaces full candidate CI.

## Local checks

`node --test scripts/acceptance/candidate.test.ts` checks only fail-closed
orchestration. `tsc --project scripts` checks script types. Existing acceptance
script tests also need complete built core/Web packages and a working pnpm.
These checks are not Chromium, Rust, installed-public-consumer or hosted workflow
acceptance. Do not label an unexecuted workflow as passed.
