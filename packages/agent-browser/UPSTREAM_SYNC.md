# Maintain the fork without replacing upstream packages

The upstream e2e baseline is `97f453fbcfd99b73faa0177ba60e489df9625b86`. The agent-browser baseline is `1165952d74ceed98fdc2dd97190ad41f44dd0e24` (0.39.1). Upgrade these independently. The fork adds a separate package, workflows and a public native patch; it does not replace `@e2e-dev/web`, alter core execution, or add a core-to-Web dependency.

Keep an upstream-tracking main branch and a separate adapter branch. Review an upstream merge in a new branch before moving the delivery branch. Never treat a clean merge or patch application as proof that public contracts stayed compatible.

## e2e upgrade checklist

1. Compare the public `e2e/engine` SPI and browser fixture contracts, including lifecycle, state, privacy, errors and replay behavior.
2. Compare the vendored single-node semantic reader with upstream. Retain its license/notice. Do not import the old filtered tree traversal into the default agent observation.
3. Rebuild core and adapter, typecheck, lint, run all units, then all native and real-browser workflows. Verify the fresh installed tarballs, not only workspace imports.
4. Confirm provider shape changes for Kernel/smol and preserve explicit dedicated-attempt ownership. A successful synthetic service fixture is not a hosted-account UAT result.
5. Preserve the old engine and mobile/device adapters. Document migration rather than silently changing their execution.

## agent-browser upgrade checklist

1. Update the pinned upstream source only in a review branch. Inspect public CLI JSON, flag parsing, default snapshot behavior, exact refs, target/context attachment, input errors and action completion.
2. Rebase `patches/agent-browser-exact-refs.patch`. Audit every mutation for same-node identity, pre-dispatch failure classification and post-dispatch uncertainty. No role/name fallback, automatic input retry, or second checkbox click may reappear.
3. Keep scoped native attachment passive: the companion alone owns debugger pause/resume. Review popup and OOPIF first-navigation handling with multiple CDP connections.
4. Bump the required native CLI version whenever the patched public contract changes. Older binaries must fail preflight rather than ignore unfamiliar flags.
5. Run the entire native suite and preserve the count of upstream ignored tests explicitly. Then run mandatory integration suites, including below-fold unnamed glyphs, lost acknowledgements, stale refs, frame/pixel proof, protected popups, state replacement and runner replay.
6. Repeat the full Linux suite at the exact same commit after its first green run. Run macOS ARM64 and Intel validation before making claims for those platforms. Verify binary architecture and every distributed artifact hash.

The core cache key uses engine name plus SPI version, not package version. Incompatible observation/action semantics therefore require a new engine identity epoch, currently `agent-browser-exact-5`; changing only `version` cannot invalidate old replay entries safely.

## Privacy and release gates

- Keep public fixtures synthetic. Never commit private application URLs, accounts, state, screenshots or credentials.
- Failed frame/mask proof must withhold pixels. No unmasked fallback is acceptable.
- Keep uncertain actions non-retryable and poison their attempt. A CLI client timeout is not daemon cancellation.
- Re-test asynchronous route/dialog lifetime fencing and first-request protected headers after CDP or Chromium upgrades.
- Native archives must contain only the executable and public license/provenance files. Do not upload browser profiles or runner sessions.
- Preserve the documented Chromium-only, dedicated-endpoint and storage limitations. Test the user's actual private application separately with authorized access.
- This fork has no automatic npm release, GitHub release, deployment or main-branch merge step. Publication needs its own explicit release decision.
