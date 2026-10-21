# @e2e-dev/web

The browser engine for [`e2e`](https://www.npmjs.com/package/e2e), built on
[agent-browser](https://github.com/vercel-labs/agent-browser).

`e2e` ships no engine of its own: every target names the engine that drives
it, and this package is the one for browsers. It implements the public
`e2e/engine` contract, so a device or desktop engine plugs into the same
seam with no privilege either way.

## Install

Use a matching e2e/Web/native bundle. This source branch replaces the existing
`@e2e-dev/web` implementation; it does not add a second runtime package. A package
version alone does not establish that an arbitrary native binary matches it.

The adapter requires the complete negotiated native capability contract before
starting a browser. A foundation-only binary is rejected, never used as a
reduced-feature fallback. The development override
`E2E_AGENT_BROWSER_EXECUTABLE` must name an absolute trusted executable; setting
it does not verify release provenance or install Chromium. Installing the
upstream npm package alone does not install this migration's matched bundle.

The default runtime is selected by the project-owned `.e2e/native-runtime.json`
created by the explicit bundle installer. From an independently trusted matching source checkout, run
`node scripts/acceptance/install-bundle.ts /absolute/bundle EXTERNAL_MANIFEST_SHA256 /absolute/project`.
Obtain the digest from the independently trusted release or CI artifact, not the
bundle's own `manifest.sha256`. The generated `install.mjs` is not a trust bootstrap: it imports bundled code before verification. Run it only after independently verifying the entire installer inventory with a trusted verifier. Passing a digest to untrusted installer code cannot authenticate code already executing. The installer adds the exact local core and Web
tarballs with install scripts disabled, checks their complete published file
inventories, then creates the descriptor. It refuses to overwrite an existing
trust descriptor. It requires Node and pnpm and does not download a native runtime or install Chromium.

Every default startup verifies those package bytes, the core actually imported
by Web, the platform, and the native binary/producer/handshake tuple. The descriptor
is trusted project configuration, not a signature. Dependency directories are
package-manager-owned and are not certified by the core/Web file inventories.
There is no PATH or automatic download fallback. A verified bundle still must
negotiate the complete native contract; integrity is not browser acceptance.

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [{ name: 'web', engine: web(), app: { url: 'http://localhost:3000' } }],
} satisfies E2EConfig;
```

The target declares the app; the engine only drives it. The target's `app`
takes `url` (the base URL `app.open()` opens; required on a `web()` target),
`command` (a process the runner starts before the run and stops after it,
with `readyUrl` to poll, default `url`), `environment` (`test`, `staging`,
`production`; inferred from the host), and `identity` (a stable cache and
session key when the origin is ephemeral). `web({ url })` and the other old
app options are `INVALID_CONFIG`. A target with `app.url` is a `browser`
target, so a test can `requires: ['browser']`. Browser options:
`browser` (`chromium`, the current supported backend; or a
`BrowserProvider` that leases hosted browsers, see below), `viewport`
(`{ width, height }`; default 1280x720), `testIdAttribute` (the attribute
`getByTestId` and a node's `testId` read; default `data-testid`), `userAgent`
(the `User-Agent` every attempt sends and `navigator.userAgent` reports),
`locale` and `timezoneId` (the language and time zone every attempt runs in,
such as `de-DE` and `Europe/Berlin`), `colorScheme` and `reducedMotion` (the
`prefers-color-scheme` and `prefers-reduced-motion` every page reports, from
first paint; `browser.emulateMedia` changes them in a test), `initScripts` (scripts every document
runs before the page's own), and
`connect` — attach to a remote browser over CDP instead of launching a local
one.

### Attaching to a remote browser (`connect`)

Set `connect.cdpEndpoint` to attach over the Chrome DevTools Protocol rather
than launch. The resolver is async and called at worker init, and again at the
start of any attempt that finds the session dropped, so a hosted browser whose
endpoint is provisioned per run — a cloud session URL that is not known at
config load — resolves each time it is needed. The resolver receives an
`AbortSignal` that fires when the init or attempt is cancelled or exceeds its
budget; a browser that connects after that is detached, never used. CDP attach
is chromium-only, and disposing the engine detaches the session without
killing the remote process the host owns.

```ts
engine: web({
  connect: { cdpEndpoint: async () => acquireCloudBrowserSession() },
});
```

For transport recovery, add `connect.reconnectEndpoint(signal)`. This opts
into the remote browser's persistent default context. `cdpEndpoint` then
provisions a fresh, dedicated browser for every attempt, including retries;
`reconnectEndpoint` must return that same browser after a disconnect. The
engine verifies the default context ID and active page target ID, clears stale
references, and never repeats a dispatched operation. A missing target fails
the attempt. The host owns deleting the remote browser after cleanup.

This mode does not support `headers`, `basicAuth`, `userAgent`, `locale`, `timezoneId`, context reset, or session
state capture and restore. Recording resumes after reconnect, but a segment
lost during the disconnect remains unavailable. See the
[Web reference](../../docs/reference/web.mdx#recovering-a-cdp-transport)
for the lifecycle and ownership contract.

### Leasing hosted browsers (`browser`)

`connect` has no lifecycle: nothing tells the host when to delete the browser
it provisioned. Pass a `BrowserProvider` as `browser` instead and the engine
asks for a browser when one is needed and gives it back when its scope ends,
on every exit path. `scope: 'worker'` (the default) leases one browser per
worker slot in `prepare` and releases them in `finish`; a worker whose browser
drops leases a replacement itself. `scope: 'attempt'` leases a fresh browser in
every `startAttempt` and releases it in `endAttempt`, reattaching through the
lease's `reconnectEndpoint` after a transport drop, with the limits of
`connect.reconnectEndpoint`. A provider implies chromium and excludes
`connect`; no vendor ships in the package. See
[Hosted browsers](../../docs/browser.mdx#hosted-browsers) for the contract
and an example against a generic session API.

```ts
engine: web({
  browser: {
    name: 'hosted-browsers',
    acquire: async (request) => ({ id: session.id, cdpEndpoint: session.cdpUrl }),
    release: async (lease) => stopSession(lease.id),
  },
});
```

## The `browser` fixture

The engine contributes `browser`: navigation, routes, cookies, dialogs, frames,
downloads, keyboard and mouse, plus `expect(browser).toHaveURL()` and
`toHaveTitle()` and `toHaveClass()`. Import `test` from this package to have it
typed; it is the same runtime `test` as `e2e`'s.

```ts
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('signs in', async ({ app, screen, browser }) => {
  await app.open('/login');
  await screen.getByLabel('Email').fill('user@example.test');
  await expect(browser).toHaveURL('/dashboard');
});
```

## Browsers

Chromium acquisition is an explicit setup step, not an implicit effect of a test
run. After installing the matching trusted native runtime, prepare Chromium and
any required Linux libraries with:

```bash
pnpm exec e2e-web install chromium --with-deps
```

The CLI invokes that exact native executable with `install --with-deps`, without
a shell, PATH fallback, or package-manager auto-install. The native installer
owns the Chromium version/cache and reports its exit status. `--with-deps` is
only forwarded when requested. Firefox and WebKit are not accepted by this
backend. Playwright remains a development-only independent validation oracle,
not a production dependency or selectable fallback.

### Recorder cleanup failures

A provider recording error is not silently treated as successful cleanup. If
recording completion cannot be established, cleanup reports the provider-named
failure and retains the affected lease instead of handing its browser to another
attempt. A malformed artifact report does not prove that recording is still
running, but also cannot establish safe completion on its own. A later explicit,
contract-safe stop or confirmed teardown must resolve that ownership. This is an
intentional reliability correction to the former best-effort cleanup behavior.

## Documentation

Full documentation lives at [e2e.tester.army/docs](https://e2e.tester.army/docs).
