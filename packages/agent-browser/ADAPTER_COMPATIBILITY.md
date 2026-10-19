# Adapter and migration inventory

This inventory is based on e2e commit `97f453fbcfd99b73faa0177ba60e489df9625b86`. It describes implemented boundaries and the evidence still required; source compatibility is not a claim that a hosted account has been exercised.

## Browser engines and providers

| Existing package or option | New engine path | Validation boundary |
| --- | --- | --- |
| `@e2e-dev/web`, local Chromium | Change factory to `agentBrowser()` and typed `test` import to this package. The reviewed patched agent-browser executable and Chromium are explicit prerequisites. | Synthetic real-browser workflow covers public SPI, browser fixture, runner, replay, and artifacts. |
| `@e2e-dev/kernel` | Pass the existing structural provider as `browser: kernel(...)`. Worker leases get an owned context per attempt; attempt leases exclusively own their default context. Provider download and recording hooks are honored. | Lease-manager unit tests and real Chromium service-fixture tests. Actual Kernel service credentials/session execution remain untested. |
| `@e2e-dev/smol` | Pass `browser: smol(...)`. The first attempt-scoped attachment preserves the prepared default context. Restart/reset replace the attempt context; the next attempt receives a new lease. | Real Chromium fixture tests model prepared cookies/storage and exact release ownership. Actual smol provisioning remains untested. |
| `@e2e-dev/lightpanda` | Its provider shape is accepted, but a non-Chromium CDP implementation is refused by the runtime handshake. | Lightpanda is not a rendering/Chromium substitute for this adapter. Do not claim screenshot, pointer, or frame parity. |
| Firefox / WebKit | Unsupported. | agent-browser's maintained execution path and this companion require Chromium. |
| Browser-provider `reconnectEndpoint` | Accepted structurally; never automatically invoked after a lost or ambiguous command. | An uncertain mutation poisons the attempt. A new attempt is required; no replay of the same input is attempted. |
| `connect: { cdpEndpoint }` | The callback resolves once per worker. Every attempt receives its own browser context; the shared default context is left alone. | Callback lifecycle, cancellation, sanitized errors, and late-completion fencing have unit coverage. External CDP services still require authorized UAT. |
| `connect: { cdpEndpoint, reconnectEndpoint }` | The initial callback resolves once per explicit attempt, which must exclusively own a prepared default context. The reconnect callback is accepted but never invoked. | Prepared default-context state is preserved on initial attachment. An ambiguous mutation ends the attempt instead of reconnecting. |

The companion attaches to the same browser and exact page target reported by agent-browser. It does not run Playwright. Both CLI connections carry immutable initial target/context bindings before discovery or attachment; the version gate refuses older unscoped builds. The companion discovers target metadata, filters by ownership, and monitors only owned page families instead of enabling browser-wide automatic attachment. The real transparent-proxy sentinel suite checks foreign initial/new pages remain unattached and unpaused, while owned popup first requests and initialization are handled. This safety claim remains pending that real-browser gate. Attempt-scoped leases must contain no foreign browser contexts before the engine accepts exclusive default-context ownership.

Remote file downloads require the provider's `downloads` transfer hook. Without it, the fixture refuses before triggering the download; it never mistakes a remote path for a local file. Provider recordings are unredacted artifacts with the same explicitly incomplete-redaction policy as the original Web engine.

### Callback connection compatibility

`connect.cdpEndpoint(signal)` returns a Chromium CDP HTTP discovery or WebSocket endpoint. It is mutually exclusive with a browser provider and local launch configuration. The engine detaches its connections and cleans up only the context/pages it owns; a callback-supplied endpoint does not authorize terminating the remote browser.

The two-callback shape is retained for source compatibility with the old engine's attempt-provisioning form, but its recovery behavior deliberately changes: `reconnectEndpoint` is never called, whether a read, input, or disconnect fails. The original endpoint is reused only inside the same explicit attempt lifecycle. The provisioner must supply an exclusive browser for each new attempt; it must not return another user's browser or leave foreign contexts in it. A new attempt can call `cdpEndpoint` again, but this is provisioning a new attempt rather than retrying an uncertain action.

Endpoint callbacks have a bounded initial resolution budget and receive cancellation. A callback that ignores cancellation cannot install a late endpoint into a later attempt. Errors never include callback exception text, returned endpoint credentials, or provider diagnostics. Raw callback connections provide no remote-file transfer hook, so `browser.waitForDownload` is explicitly unavailable; use a browser provider with `downloads` when remote downloads are required.

## Other packages

- `@e2e-dev/mobile` remains the independent agent-device engine. Native iOS/Android app declarations are rejected by this Web engine.
- `@e2e-dev/limrun`, `@e2e-dev/testmu`, and `@e2e-dev/eas` implement the device-provider contract, not the browser-provider contract. They continue to use the mobile engine unchanged.
- `@e2e-dev/github` consumes runner reports and remains unchanged. No GitHub write or credential is required by the adapter's fixture workflow.
- `@e2e-dev/decision` and shared runner/model packages remain unchanged. The engine implements the public SPI rather than importing a Web-engine implementation or adding core-to-engine dependencies.

## Deliberate security and behavior changes

- Basic authentication defaults to the configured app site. `basicAuth.scope: 'any-origin'` explicitly opts into the original engine's broader server-challenge behavior. Proxy challenges and mismatched challenge origins are never answered.
- Protected header values may be declared `Secret` values and are resolved through the attempt's redaction ledger. No protected value is placed in CLI arguments or state files.
- Exact-node `fill` uses the native DOM value setter and a synthetic `InputEvent` after actionability validation. It does not reproduce trusted text-entry events; applications that require `event.isTrusted` for fill need separate compatibility validation. `keyboard.type` emits per-character keyboard input instead.
- Node and coordinate swipes use trusted CDP wheel input with the original engine's direction and momentum distances; element swipes target the element center after exact-ref hover.
- Concurrent UI input sequences are rejected rather than serialized behind waits. Network waits, asynchronous route handlers, response delivery, and diagnostics remain independent of the UI-command path.
- The factory's cache identity is `agent-browser-exact-2`. The runner keys by engine name and SPI, not package version. Incompatible semantic changes require a new identity epoch.
- Stock agent-browser is refused. The maintained public CLI extension supplies strict refs and several necessary semantic safeguards; upgrading only the npm executable is not supported.

## Remaining proof

A passing unit suite is insufficient. The exact published commit must pass native Rust tests and all mandatory real Chromium integration files. Hosted service accounts and the user's private preproduction application require separate authorized UAT. No private application source, address, account, or credential is included in these fixtures.
