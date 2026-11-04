# Private held-out model acceptance

This suite was authored against the fresh official e2e baseline. It consumes only the public `e2e/runner`, `e2e`, and `@e2e-dev/web` package APIs. It does not implement browser/CDP behavior or reuse the retired adapter.

## Current status

Structural checks are runnable now. Actual model acceptance is blocked until the acceptance lane provides a verified full-native candidate and an approved local model configuration exists. A foundation-only `browser.scope/1` + `browser.evaluate/1` binary is insufficient. The entry point uses `scripts/acceptance/heldout-candidate.ts` to verify installed package contents, native identity, and actual full-capability negotiation before importing a model; absent or rejected proof fails closed. There is no “trust me, ready” override.

The acceptance verifier must bind package bytes actually imported by this process to the trusted candidate bundle, bind the selected native executable to its producer and live negotiation, and require the NativeSurface mandatory capabilities. Bundle hash integrity alone is insufficient. The suite does not infer readiness from versions or a user-authored JSON success flag.

## Structural checks

After the normal workspace install and package build:

```
pnpm --filter @e2e-dev/heldout-release typecheck
pnpm --filter @e2e-dev/heldout-release test
node apps/heldout-release/run.ts
```

The last command intentionally exits 2 and writes a unique `results/<run-id>/result.json` with `blocked`. These checks make no model calls. Unit tests validate fixture/oracle invariants, not browser operation or model quality.

## Local model handoff, after full candidate verification exists

Use the same already-approved DeepSeek provider configuration as the normal runner. Point `HELDOUT_MODEL_MODULE` at a local module exporting its AI SDK `model` plus `metadata: { endpoint }`. The endpoint must contain no credentials, query, or fragment. Do not copy keys into this repository or chat, create new credentials, change provider, or upgrade a plan for this test.

```
HELDOUT_MODEL_MODULE=/absolute/path/to/existing-approved-provider.mjs \
HELDOUT_BUNDLE=/absolute/path/to/verified-candidate \
HELDOUT_MANIFEST_SHA256=<trusted-producer-manifest-sha256> \
E2E_AGENT_BROWSER_EXECUTABLE=/absolute/path/to/verified-agent-browser \
node apps/heldout-release/run.ts --run-model
```

This is not enabled in default CI. No actual model calls have been made for this harness. The real agent gets an outcome request, not a tool sequence; cache replay is disabled. Native initialization still performs its own mandatory negotiation before the first `agent.act`.

## Evidence and limits

Six synthetic paper-shelf cases cover absent targets, legitimate already-selected no-ops, persisted defaults that must be preserved, changed ordering, a target deep in a long list, and an iframe. Every editable case separates inner draft application from outer commit. No private UAT names, routes, labels, traces or credentials are included.

The oracle reconstructs committed selections from a server-owned append-only journal. A changed collection must have exactly one commit followed by a matching read. Missing/already-persisted targets require zero commits and at least two matching saved-state reads. Initial state alone, model “done”, a draft-only update, dropped defaults, and redundant writes cannot pass. This proves server readback, not visual reasoning by itself.

One run, no automatic retry, first failed scenario stops the run. Each scenario allows at most 12 model calls, 18 actions, 12,000 input tokens per request and 120 seconds; the six-scenario maximum is 72 calls, with a 780-second run signal. Observed over-budget calls/time fail independently. Input ceiling is enforced by the normal runner; provider output limits and monetary spend caps must already be configured on the approved provider route. Unknown cost remains `null`, never zero. Actual model ids, adapter/policy version, accounting mode, calls, input/output tokens, estimated cost when supplied, latency and oracle verdict are retained. Raw prompts and provider errors are omitted from the summary.

Each attempt creates a unique output directory; old failures are never overwritten. Normal runner artifacts may include synthetic page screenshots/traces, and should still be reviewed before publication. Runtime cancellation follows the normal runner contract, not an OS hard-kill guarantee.

Screenshot-denial/semantic-fallback coverage is pending a verified native fixture and is explicitly not claimed. Chromium-only runtime coverage is not evidence for other browser engines, external providers, or complete legacy Web parity. Exit 0 requires all six actual-model cases passing; exit 1 is an executed failure; exit 2 is blocked setup/readiness.

## Installed-candidate bridge contract

`verifyHeldoutCandidate({ bundle, expectedManifestHash, installedCoreEntry, installedWebEntry, nativeExecutable })` must perform verification, not trust an input status flag. A successful return is `{ status: 'verified', manifestHash, nativeSha256, source: { commit, tree }, protocol, capabilities, installed: { core: { entry, inventorySha256 }, web: { entry, inventorySha256 } } }`. Inventory digests cover the complete installed package content, not just the entry file. The consumer rejects false, undefined, blocked, foundation-only, mismatched binary and mismatched entry results. The reviewed mandatory capability list in `readiness.ts` matches the current NativeSurface; keep this check aligned when that contract changes.

The bridge is implemented, but a complete native candidate and approved local provider setup remain required. Its synthetic foundation-only peer test proves rejection, not successful full-native or model acceptance. A fixture-shaped proof in the unit tests is only a parser test, never installation or runtime evidence.
