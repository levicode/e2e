# Agent-browser engine for e2e

Development candidate for a separate `@e2e-dev/agent-browser` package. This package is not published and does not replace or modify `@e2e-dev/web`. It implements the public `e2e/engine` SPI version 1 with a distinct engine/cache identity.

See [installation and source-pinned artifacts](INSTALL.md), [exact validation evidence](VALIDATION.md), and the [upstream synchronization checklist](UPSTREAM_SYNC.md). Native artifacts identify their tested OS and CPU architecture; a Linux pass is not macOS or private-application UAT proof.

## Architecture

- agent-browser owns default accessibility snapshots, refs, and primary node actions. No interactive-only, compact, depth, viewport, accessible-name, or cursor filtering is added. Unnamed font-icon controls stay in the observation.
- A documented public Chromium CDP companion uses the exact browser and target reported by agent-browser's public tab listing. It supplements metadata, deterministic locators, async network handlers, response events, state, and masked screenshots. It never starts a second browser or uses Playwright execution.
- Each local attempt owns a new Chromium process and disposable profile. Cancellation with uncertain mutation outcomes poisons that attempt. The adapter does not equate killing a CLI client with cancelling the daemon.
- Engine-owned ref IDs are unique across attempts and workers. The runner owns revisions; sequential locator resolutions retain their exact native identities so a drag destination cannot erase its source.
- Optional trace capture uses a second isolated agent-browser CLI session attached to the same browser and exact target. Its non-activating tab binding and separate ref namespace cannot replace action refs; a failed optional read disables trace capture without retrying input.
- Trace/report/replay remain e2e's own. The engine cache identity is `agent-browser-exact-5`. Core keys include the engine name and SPI, not its package version; incompatible observation/action changes require incrementing this name's semantic epoch.

## Required CLI extension

Stock agent-browser 0.39.1 cannot safely reproduce strict e2e ref identity: its snapshot refs can fall back to a different node with the same role and name. Its checkbox path can also issue a second click after a delayed state update.

`patches/agent-browser-exact-refs.patch` is a maintained public extension against upstream commit `1165952d74ceed98fdc2dd97190ad41f44dd0e24`. It exposes version `0.39.1-e2e.3`, exact refs, authoritative node IDs, public exact-ref registration, immutable initial target/context attachment scope, validated navigation wait options, per-key ASCII typing, read-only checkbox completion checks, and passive scoped attachment that leaves debugger pause/resume exclusively to the companion. This adapter refuses the stock binary rather than claiming unsupported safety.

Build the pinned extension from this repository:

```sh
bash packages/agent-browser/scripts/build-exact-agent-browser.sh
export E2E_AGENT_BROWSER_EXECUTABLE="$PWD/.validation-tools/agent-browser-exact/cli/target/ci/agent-browser"
pnpm --filter e2e build
pnpm --filter @e2e-dev/agent-browser build
```

Requires Node 24.8+, a Rust toolchain compatible with the pinned lockfile, and Chromium. CI uses Rust 1.93.0 and the Chromium distribution pinned by the existing workspace browser dependency. The adapter itself has no Playwright runtime dependency. Set `E2E_CHROMIUM_EXECUTABLE` or `executablePath` to the browser executable.

## Migration

Change the engine factory and the typed test import. Existing `e2e` runner/model/report configuration remains unchanged:

```ts
import { agentBrowser } from '@e2e-dev/agent-browser';

const engine = agentBrowser({
  executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE,
  executablePath: process.env.E2E_CHROMIUM_EXECUTABLE,
  viewport: { width: 1280, height: 720 },
});
```

Tests use `test` from the new package for its `browser` fixture, and `expect` from `e2e`. The factory supports Chromium, not Firefox or WebKit. Read `VALIDATION.md` before treating this development candidate as a complete Web-engine replacement.

## Dedicated remote endpoints

Remote browsers are supported only with dedicated ownership for each attempt. A structural browser provider must explicitly set `scope: 'attempt'`. Its lease must grant this attempt exclusive use of the entire Chromium browser for its lifetime, including every context and page. No unrelated clients or users may share the endpoint.

For a callback provisioner, use an explicit attempt scope:

```ts
const engine = agentBrowser({
  executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE,
  connect: {
    scope: 'attempt',
    cdpEndpoint: async (signal) => provisionDedicatedChromium(signal),
  },
});
```

`provisionDedicatedChromium` is your provisioner and must return a Chromium CDP HTTP discovery or WebSocket endpoint for that attempt. It is called once at each explicit attempt boundary, never to recover an uncertain action. You remain responsible for releasing the remote browser; callback connection cleanup does not terminate it.

Worker/shared providers, including providers whose scope is omitted, are rejected by the factory before `acquire`. Likewise, `connect: { cdpEndpoint }` and explicit `connect.scope: 'worker'` fail before endpoint resolution. The old two-callback form `{ cdpEndpoint, reconnectEndpoint }` still selects attempt scope when scope is omitted, but `reconnectEndpoint` is never invoked.

Provider preparation and recording clients must not retain competing locale/timezone emulation overrides, even within the same attempt; see the exact condition in `ADAPTER_COMPATIBILITY.md`.

A scope declaration does not create isolation. The runtime still checks initial context exclusivity, but cannot determine whether a default-context page belongs to another user or prevent a service from adding other users later. The provisioner must enforce the ownership contract. Real Chromium CI exposed that the shared-browser zero-foreign-attachment guarantee and first-popup interception cannot both be delivered through public CDP; this package makes no shared-provider compatibility claim. See [the adapter inventory](ADAPTER_COMPATIBILITY.md) for provider-specific migration limits.

## Verification

```sh
pnpm --filter @e2e-dev/agent-browser build
pnpm --filter @e2e-dev/agent-browser typecheck
pnpm --filter @e2e-dev/agent-browser test
pnpm --filter @e2e-dev/agent-browser test:browser
```

Browser tests require the patched binary and a runnable Chromium. They use local synthetic HTTP fixtures and no model, account, private service, or credentials. Integration tests deliberately fail if prerequisites are missing; a skipped real-browser check must never be reported as proof.

The [packaged-consumer example](examples/packaged-consumer/README.md) includes a complete config, deterministic test, fresh tarball installation checks, and a runnable browser smoke with hashed CI artifacts.

## Upstream maintenance

Keep `@e2e-dev/web`, `e2e` core, mobile engines, and service integrations unchanged. Upgrade the e2e pin and agent-browser pin independently. For an agent-browser upgrade, apply the patch to the new clean source, review the public JSON schemas and exact-ref dispatch paths, run native tests, then run all integration suites. A clean patch application alone is not compatibility evidence.

The single-node semantic reader is vendored from e2e commit `97f453fbcfd99b73faa0177ba60e489df9625b86`, under Apache-2.0. It is used only to read already-bound DOM nodes. Its old filtered tree walk is never used as an agent observation. Compare that file with upstream on every e2e upgrade.

## Video artifacts

Local video uses Chromium's repaint-driven CDP screencast and a separately installed `ffmpeg` executable with the `libvpx` VP8 encoder. Set `screencast.ffmpegPath`, or `E2E_FFMPEG_EXECUTABLE` in the runner's environment, to select it; otherwise the executable is `ffmpeg`. No encoder is downloaded at runtime. CI installs Ubuntu's `ffmpeg` package and verifies its version.

The encoder receives JPEG frames through a pipe and writes WebM directly into the attempt's `video/` directory. There are no intermediate frame files. At 25 frames per second, the newest frame is repeated during idle periods to preserve wall-clock timing. Changing the active page, restarting, or replacing state ends the current segment and starts a new one. The `screencast.size` and `screencast.quality` options control output dimensions and CDP JPEG source quality.

When a hosted browser provider supplies its own recording hook, that recording is preferred and returned through the public provider-recording contract as a file or hosted link. A native provider recording spans page/context changes within its lease and does not require local ffmpeg.

**Video redaction is incomplete, matching the existing Web engine's policy.** Artifact videos are unredacted and may contain passwords, private page content, or other sensitive pixels. They are never used as model observation pixels. Screenshots use the separate fail-closed source-masking path; enabling video does not weaken screenshot masking or the post-sensitive-fill screenshot restriction.
