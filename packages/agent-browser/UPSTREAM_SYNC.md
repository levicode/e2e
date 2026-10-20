# Maintain the forks without replacing upstream packages

The upstream e2e baseline is `97f453fbcfd99b73faa0177ba60e489df9625b86`. The native baseline and exact maintained fork commit/tree live in `native-source.lock.json`. Upgrade them independently. The e2e fork adds a separate package and workflows; it does not replace `@e2e-dev/web`, alter core execution, or add a core-to-Web dependency.

Keep upstream-tracking branches separate from maintained delivery branches in both repositories. Review updates in pull requests. Never treat a clean merge as proof that public contracts stayed compatible. A source lock with a placeholder is a draft, not a distributable build.

## e2e upgrade checklist

1. Compare the public `e2e/engine` SPI and browser fixture contracts, including lifecycle, state, privacy, errors and replay behavior.
2. Compare the vendored single-node semantic reader with upstream. Retain its license/notice. Do not import the old filtered tree traversal into the default agent observation.
3. Rebuild core and adapter, typecheck, lint, run all units, then all native and real-browser workflows. Verify the fresh installed tarballs, not only workspace imports.
4. Confirm provider shape changes for Kernel/smol and preserve explicit dedicated-attempt ownership. A successful synthetic service fixture is not a hosted-account UAT result.
5. Preserve the old engine and mobile/device adapters. Document migration rather than silently changing their execution.

## agent-browser upgrade checklist

1. Work in a review branch of [levicode/agent-browser](https://github.com/levicode/agent-browser). Compare the proposed upstream range before merging. Inspect public CLI JSON, flag parsing, default snapshot behavior, exact refs, target/context attachment, input errors and action completion. Keep native changes in that repository, not in a second e2e patch file.
2. Audit every mutation for same-node identity, pre-dispatch failure classification and post-dispatch uncertainty. No role/name fallback, automatic input retry, or second checkbox click may reappear. Keep changes isolated and propose portable fixes upstream where practical; retire local changes only after equivalent upstream behavior passes the same tests.
3. Keep scoped native attachment passive: the companion alone owns debugger pause/resume. Review popup and OOPIF first-navigation handling with multiple CDP connections.
4. Update the native fork's `maintainer/upstream.json` with the reviewed upstream base. Bump the native version for changed native builds. Change the protocol contract only when its compatibility requirements change. Commit the candidate in the native fork, then set the e2e lock to its full immutable commit and tree. Do not lock a branch, tag or moving upstream HEAD.
5. Cross-check repository, upstream base, Cargo version, protocol contract and cache epoch against the fork metadata. The build script validates these fields and rejects a dirty, wrong-origin, wrong-commit or wrong-tree checkout. It never repairs an old patched checkout automatically. Preserve it and build into a new directory instead.
6. Run the focused native launch-safety test and the entire native suite. Explicitly run the native browser editing and exact/semantic-ref regression tests with real Chromium; their normal ignored status is not evidence. Build the exact official upstream source separately and compare ordinary snapshots, native input events and UI effects against it. Keep this oracle in validation only, not in the shipped runtime. Preserve the count of upstream ignored tests explicitly. Then run mandatory integration suites, including below-fold unnamed glyphs, lost acknowledgements, stale refs, frame/pixel proof, protected popups, state replacement and runner replay.
7. Repeat the full Linux suite at the exact same e2e and native commits after its first green run. Run macOS ARM64 and Intel validation before making claims for those platforms. Verify binary architecture and every distributed artifact hash. Artifacts must identify both source repositories, the exact native tree and the upstream base; a version string alone is not provenance.

The native protocol contract is `e2e-exact-1`. The core cache key uses engine name plus SPI version, not package or native version. Incompatible observation/action semantics therefore require a new engine identity epoch, currently `agent-browser-exact-6`. The new browser-insertion fill semantics use epoch 6; entries from the previously distributed synthetic-fill epoch 5 must not replay. Moving source repositories alone would not require an epoch bump.

The old `patches/agent-browser-exact-refs.patch` is preserved in Git history as migration evidence. It is no longer an active build input. Build provenance uses `native-source.lock.json`, a clean native checkout and a post-test binary-hash stamp.

## Privacy and release gates

- Keep public fixtures synthetic. Never commit private application URLs, accounts, state, screenshots or credentials.
- Failed frame/mask proof must withhold pixels. No unmasked fallback is acceptable.
- Keep uncertain actions non-retryable and poison their attempt. A CLI client timeout is not daemon cancellation.
- Re-test asynchronous route/dialog lifetime fencing and first-request protected headers after CDP or Chromium upgrades.
- Native archives must contain only the executable and public license/provenance files. Do not upload browser profiles or runner sessions.
- Preserve the documented Chromium-only, dedicated-endpoint and storage limitations. Test the user's actual private application separately with authorized access.
- This fork has no automatic npm release, GitHub release, deployment or main-branch merge step. Publication needs its own explicit release decision.
