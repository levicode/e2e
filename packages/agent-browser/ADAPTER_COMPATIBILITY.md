# Adapter and migration inventory

This inventory is based on e2e commit `97f453fbcfd99b73faa0177ba60e489df9625b86`. It describes implemented boundaries and the evidence still required; source compatibility is not a claim that a hosted account has been exercised.

## Browser engines and providers

| Existing package or option | New engine path | Validation boundary |
| --- | --- | --- |
| `@e2e-dev/web`, local Chromium | Change factory to `agentBrowser()` and typed `test` import to this package. The reviewed patched agent-browser executable and Chromium are explicit prerequisites. | Synthetic real-browser workflow covers public SPI, browser fixture, runner, replay, and artifacts. |
| `@e2e-dev/kernel` | Pass an explicitly attempt-scoped provider as `browser: kernel({ ...options, scope: 'attempt' })` only when each lease exclusively owns its whole browser. Worker/default scope is rejected before acquire. Provider download and recording hooks are honored. | Dedicated lease-manager unit tests and real Chromium service-fixture gates. Actual Kernel service credentials/session execution remain untested. |
| `@e2e-dev/smol` | Pass `browser: smol({ ...options, scope: 'attempt' })` only when each lease exclusively owns its whole browser. Initial attachment preserves its prepared default context; restart/reset replace the attempt context, and the next attempt receives a new lease. `smol()` already defaults to attempt scope; explicit worker scope is rejected. | Real Chromium fixture gates model prepared cookies/storage and exact release ownership. Actual smol provisioning remains untested. |
| `@e2e-dev/lightpanda` | Its worker-scoped provider is rejected at configuration time. A manually supplied non-Chromium CDP endpoint is also refused by the runtime handshake. | Lightpanda is not a rendering/Chromium substitute for this adapter. Do not claim provider, screenshot, pointer, or frame parity. |
| Firefox / WebKit | Unsupported. | agent-browser's maintained execution path and this companion require Chromium. |
| Browser-provider `reconnectEndpoint` | Accepted structurally; never automatically invoked after a lost or ambiguous command. | An uncertain mutation poisons the attempt. A new attempt is required; no replay of the same input is attempted. |
| `connect: { cdpEndpoint }` or `connect.scope: 'worker'` | Unsupported. The factory rejects shared/worker scope before calling the endpoint resolver, including an explicit worker scope with a reconnect callback. | Unit tests prove synchronous failure and zero callback invocations. Internal worker lifecycle helpers do not establish public compatibility. |
| `connect: { scope: 'attempt', cdpEndpoint }` | The callback provisions a dedicated browser once per explicit attempt. The entire endpoint must belong exclusively to that attempt. | Callback lifecycle, cancellation, sanitized errors, and late-completion fencing have unit coverage. Runtime verifies initial context exclusivity. External CDP services still require authorized UAT. |
| `connect: { cdpEndpoint, reconnectEndpoint }` | Retained legacy attempt-provisioning shape when scope is omitted. It has the same dedicated-browser requirement as explicit attempt scope. The reconnect callback is never invoked. | Prepared default-context state is preserved on initial attachment. An ambiguous mutation ends the attempt instead of reconnecting. |

The companion attaches to the same browser and exact page target reported by agent-browser. It does not run Playwright. Both CLI connections carry immutable initial target/context bindings before discovery or attachment; the version gate refuses older unscoped builds. These bindings do not make a shared endpoint safe: real Chromium CI exposed that public CDP cannot provide the required first-popup interception while guaranteeing zero attachment or pause of unrelated targets. Shared-browser/provider parity is therefore unsupported, not a pending parity claim.

Every remote endpoint must exclusively belong to its current attempt for the full lease lifetime: no unrelated contexts, pages, clients, or users may share it. Setting `scope: 'attempt'` is an ownership assertion, not an isolation mechanism. The runtime retains its initial check for foreign browser contexts before accepting exclusive default-context ownership. That check cannot prove who owns pages in the default context or prevent a service from introducing another user later; the provisioner must uphold the dedicated-browser contract. Existing attempt-owned prepared pages are allowed. Local launches already provide a new browser process and profile per attempt.

The source basis for this boundary is Chromium's [`TargetHandler::ShouldThrottlePopups`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/target_handler.cc), which returns the handler's browser-wide `auto_attach_` state, and [`ShouldWaitForDebuggerInWindowOpen`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/devtools_instrumentation.cc), which consults browser-agent-host target handlers. The public [`Target.autoAttachRelated` command](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-autoAttachRelated) is not equivalent to that browser-wide popup throttle. Together with the real Chromium failure, these sources motivate this adapter's dedicated-only policy; narrower target discovery does not establish the required shared-browser safety guarantee. Within a dedicated browser, the companion can enable browser-wide attachment while retaining exact context checks before installing hooks or applying attempt state.

Remote file downloads require the provider's `downloads` transfer hook. Without it, the fixture refuses before triggering the download; it never mistakes a remote path for a local file. Provider recordings are unredacted artifacts with the same explicitly incomplete-redaction policy as the original Web engine.

### Callback connection compatibility

`connect.cdpEndpoint(signal)` returns a dedicated Chromium CDP HTTP discovery or WebSocket endpoint. Specify `scope: 'attempt'`; the single-callback shape without a scope defaults to worker scope and is rejected synchronously. It is mutually exclusive with a browser provider and local launch configuration. The engine detaches its connections and cleans up only the context/pages it owns; a callback-supplied endpoint does not authorize terminating the remote browser.

The two-callback shape is retained for source compatibility with the old engine's attempt-provisioning form, but its recovery behavior deliberately changes: `reconnectEndpoint` is never called, whether a read, input, or disconnect fails. The original endpoint is reused only inside the same explicit attempt lifecycle. The provisioner must supply an exclusive browser for each new attempt; it must not return another user's browser, retain unrelated pages, or allow concurrent users or clients. Explicit `scope: 'worker'` always fails preflight, even when the legacy reconnect callback is present. A new attempt can call `cdpEndpoint` again, but this is provisioning a new attempt rather than retrying an uncertain action.

Endpoint callbacks have a bounded initial resolution budget and receive cancellation. A callback that ignores cancellation cannot install a late endpoint into a later attempt. Errors never include callback exception text, returned endpoint credentials, or provider diagnostics. Raw callback connections provide no remote-file transfer hook, so `browser.waitForDownload` is explicitly unavailable; use a browser provider with `downloads` when remote downloads are required.

## Other packages

- `@e2e-dev/mobile` remains the independent agent-device engine. Native iOS/Android app declarations are rejected by this Web engine.
- `@e2e-dev/limrun`, `@e2e-dev/testmu`, and `@e2e-dev/eas` implement the device-provider contract, not the browser-provider contract. They continue to use the mobile engine unchanged.
- `@e2e-dev/github` consumes runner reports and remains unchanged. No GitHub write or credential is required by the adapter's fixture workflow.
- `@e2e-dev/decision` and shared runner/model packages remain unchanged. The engine implements the public SPI rather than importing a Web-engine implementation or adding core-to-engine dependencies.

## Deliberate security and behavior changes

- Basic authentication defaults to the configured app site. `basicAuth.scope: 'any-origin'` explicitly opts into the original engine's broader server-challenge behavior. Proxy challenges and mismatched challenge origins are never answered.
- Protected header values may be declared `Secret` values and are resolved through the attempt's redaction ledger. No protected value is placed in CLI arguments or state files.
- Exact-node `fill` uses the native DOM value setter and a synthetic `InputEvent` after actionability validation. It does not reproduce trusted text-entry events; applications that require `event.isTrusted` for fill need separate compatibility validation. `keyboard.type` emits trusted keydown/up for US-layout characters and uses trusted text insertion for unmapped Unicode, matching the original browser keyboard behavior.
- Node and coordinate swipes use trusted CDP wheel input with the original engine's direction and momentum distances; element swipes target the element center after exact-ref hover.
- Concurrent UI input sequences are rejected rather than serialized behind waits. Network waits, asynchronous route handlers, response delivery, and diagnostics remain independent of the UI-command path.
- Route, dialog, and download-trigger continuations retain their originating browser generation and invocation lifetime. Once a callback completes or expires, it cannot obtain a new fixture operation even if the browser generation is unchanged. This does not cancel or undo browser commands that were already dispatched.
- The factory's cache identity is `agent-browser-exact-4`. The runner keys by engine name and SPI, not package version. Incompatible semantic changes require a new identity epoch.
- Stock agent-browser is refused. The maintained public CLI extension supplies strict refs and several necessary semantic safeguards; upgrading only the npm executable is not supported.

## Remaining proof

A passing unit suite is insufficient. The exact published commit must pass native Rust tests and all mandatory real Chromium integration files. Hosted service accounts and the user's private preproduction application require separate authorized UAT. No private application source, address, account, or credential is included in these fixtures.
