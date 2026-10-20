# Maintained fork validation

Updated October 20, 2026 UTC. The supported native line is `0.39.1-e2e.5`, contract `e2e-exact-1`, engine/cache identity `agent-browser-exact-6`. `native-source.lock.json` is authoritative for the final source commit, tree, upstream baseline and Rust compiler. Older `.4` artifacts and caches are not interchangeable.

## Evidence and final delivery gate

- The maintained native tree `4f52f3e35fc26bee9f2a9ad29e75467e9c9907f8` passed [all three native platforms](https://github.com/levicode/agent-browser/actions/runs/39388024889): Linux 1,519 tests; macOS ARM64 and Intel 1,517 each; zero failures and 150 inherited ignored browser tests. Those ignored tests are not represented as executed. Two selected real-browser native regressions execute separately in consumer CI.
- The pre-final integration candidate `7e23a28bf61c0d457dbf13975764abc927d7e053` passed [Linux](https://github.com/levicode/e2e/actions/runs/39397607020): 355 units, 56 browser cases without skips, three independent popup ownership attempts, and fresh packaged installation/browser acceptance. It does not validate later fixture or source-pin changes by itself.
- The independently built, unmodified official baseline and the maintained artifact are compared using the same pinned Chromium and ordinary CLI-owned lifecycle. [The three-platform focused diagnostic](https://github.com/levicode/e2e/actions/runs/39408233796) at `a9ec137d5dc7f2b9c65269ea542ff292e0569db8` passed using exact verified artifacts and only this fixture; it does not replace the complete delivery matrix.
- Final delivery requires the exact final pin and candidate tree to pass both [Linux workflow](../../.github/workflows/agent-browser-adapter.yml) and [macOS workflow](../../.github/workflows/agent-browser-macos.yml). The final successful runs and downloadable artifacts are available from [integration PR #2](https://github.com/levicode/e2e/pull/2) and its resulting main commit. Never install from a failed or incomplete run.

The final pin-only source transition must preserve the tested native tree. Squash merging changes commit identity, not the validated file tree; the consumer build still fetches and verifies the actual final native commit, rather than relabeling an older artifact.

## Required scope

Linux runs native launch safety and the complete serial suite, two real native regressions, adapter build/typecheck/lint, all units, three fresh-browser popup attempts, all browser contracts, and a fresh outside-workspace installation of the actual core/adapter tarballs. The fresh consumer verifies declarations, public imports, frozen reinstall, a real action/report/trace, one fixture mutation and zero model calls.

macOS ARM64 and Intel independently build and test native code, execute the two native browser regressions, run all units and the ordinary baseline comparison, then three action/editing cases, five locator cases, two public runner/replay cases and the fresh installed consumer. **This is not the complete Linux pixel/state/network/video matrix on macOS.**

Native tests share inherited process-global environment variables, so the libtest harness runs with one test thread. Explicit Tokio/socket concurrency inside individual tests is preserved. Tests are not silently skipped, retried until green, or granted larger operation deadlines.

## Provenance and installation

Builds verify clean Git origin/commit/tree, actual Rust 1.99.1, package/native versions, contract capabilities and executable hash. Dependency caches are isolated by OS, architecture, compiler and source identities; final executables, build stamps and test-success results are not restored from that cache. Every delivery build compiles and runs its required gates.

Use [INSTALL.md](INSTALL.md) for the single supported installation route. Download native and consumer artifacts from the same successful final workflow commit, and verify their manifests and hashes. This is a private-version source build, not an npm release. No Apple notarization or Developer ID signing is supplied; do not bypass OS security warnings.

## Limits retained

- Chromium only, with a dedicated browser for each attempt. The native scoped attachment is passive; the companion owns interception/debugger lifecycle. Ownership assertions do not prove a remote provider remains exclusive.
- Exact references prevent hidden native rebinding, not atomic pointer hit-testing. The harness may explicitly re-observe before dispatch after a stale target; uncertain dispatched input is not automatically replayed. This is not business-level exactly-once execution.
- Ordinary fill follows browser editing; constrained date/time-style controls use documented setters. Trusted physical typing and text insertion have distinct supported input semantics.
- Ordinary unscoped external attachment on macOS has a documented unresolved upstream/browser limitation shared by the official and maintained executables. The successful CLI-owned comparison does not establish that path works. See [ADAPTER_COMPATIBILITY.md](ADAPTER_COMPATIBILITY.md).
- Private-application UAT, actual user desktops, real hosted provider accounts, Windows and non-Chromium browsers remain untested. Synthetic deterministic executors do not measure model reasoning quality.

Previous `.4` delivery records remain in Git history, not as an alternate runtime or installation recommendation. Upstream updates require review and the same regression gates; see [UPSTREAM_SYNC.md](UPSTREAM_SYNC.md).
