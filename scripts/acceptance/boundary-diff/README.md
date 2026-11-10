# Boundary diff: Playwright 1.64.1 vs the native Web engine

Measurement for [#159](https://github.com/levicode/e2e/issues/159), the
evidence block of [#23](https://github.com/levicode/e2e/issues/23). It runs the
same six capacity/budget families through the old Playwright 1.64.1 driver and
the native `@e2e-dev/web` engine on the same Chromium build, and it changes no
product code. Each row says whether the old engine could do it, whether the new
one can, and whether a failure left a usable browser behind.

## Running it

The harness reads the built packages, so build them first. It also needs a
trusted native build and an explicit Chromium so both engines share one binary;
without `BOUNDARY_DIFF_CHROMIUM` the old side uses Playwright's Chromium and the
native side resolves its own. The native side reads `AGENT_BROWSER_EXECUTABLE_PATH`
when it launches (`cli/src/native/actions.rs` in `levicode/agent-browser`), the
same override its own test harnesses use.

```bash
pnpm --filter e2e run build
pnpm --filter @e2e-dev/web run build

E2E_AGENT_BROWSER_EXECUTABLE=/abs/path/to/agent-browser \
BOUNDARY_DIFF_CHROMIUM="/abs/path/to/chrome" \
node scripts/acceptance/boundary-diff/run.mjs --json /tmp/boundary-diff.json
```

The harness drives the engine's public browser fixture directly, the way the
Web package's acceptance tests do, instead of starting the scheduler; that keeps
one case to one browser and one measurement.

`--only <case|family>` narrows the table, `--engine new|old` runs one side, and
`--list` prints every case. Each case runs in its own child process with a
120s watchdog, so a hanging boundary becomes a `hang` cell instead of a stuck
run. A timed-out case gets SIGTERM first (Playwright closes its contexts on
it), its detached native daemon is killed through the pid files in this
harness's `AGENT_BROWSER_SOCKET_DIR`, its e2e-prefixed proxy is killed through
its argv, and the case process is SIGKILLed after a 5s grace. The runner exits
3 when any row is a hang or `setup-failed`, so a table that is not a full
measurement does not look successful.

Verdicts: `narrowed` means the old engine succeeded and the new one failed (a
real capability loss), `widened` means the opposite, `same` both succeeded,
`both-fail` neither could do it, `old-cannot` means the old API cannot express
the scenario at all, `old-hang` / `new-hang` / `both-hang` mark a watchdog
expiry, and `setup-failed` means the harness could not start an engine (a
missing binary, an unbuilt `dist`, or a refused handshake) so no measurement
was attempted.

## Environment of the recorded table

| Item | Value |
|---|---|
| Host | macOS arm64 (Apple Silicon), Node 24.22.1 |
| Chromium | Playwright revision 1248, Chrome for Testing 156.0.8078.4, used by both engines |
| Old engine | `playwright-core` 1.64.1, `chromium.launch()` |
| New engine | `agent-browser` 0.39.4 at `9069cb4e228bd68ac44b6cdf04e21e68e48fb860`, `cargo build --profile ci` |
| Wire | `agent-browser-session/1` |
| Built packages | `e2e` and `@e2e-dev/web` at this branch |
| Measured | 2026-11-10 |

The native revision is the repository's declared candidate
(`.github/native-candidate.json`). The older CI pin `d6d7d5d` predates
capabilities the current engine requires, so it cannot negotiate
(`unsupported-capability`) and cannot be measured with this branch. The one
source difference between the two lineages on these boundaries is
`MAX_STATE_BYTES = 32MiB` in `d6d7d5d`'s `client_state_dispatch.rs`, absent at
`9069cb4`; the state rows therefore describe the current candidate, and the
pinned 32MiB clamp is called out instead of silently mixed in.

## Results

| Family | Case | Scenario | Old (Playwright 1.64.1) | New (native) | Verdict | New cleanup |
|---|---|---|---|---|---|---|
| evaluate size | evaluate-size-512KiB | evaluate returns 'x'.repeat(512KiB) | ok (len=524288, 32ms) | ok (len=524288, 27ms) | same | usable; endAttempt=ok; dispose=ok |
| evaluate size | evaluate-size-900KiB | evaluate returns 'x'.repeat(900KiB) | ok (len=921600, 34ms) | ok (len=921600, 37ms) | same | usable; endAttempt=ok; dispose=ok |
| evaluate size | evaluate-size-1MiB | evaluate returns 'x'.repeat(1MiB) | ok (len=1048576, 38ms) | ACTION_MAY_HAVE_COMMITTED: The native browser action outcome is unknown (native capacity-exceeded; effects unknown; scope usable) | narrowed | usable; endAttempt=ok; dispose=ok |
| evaluate size | evaluate-size-4MiB | evaluate returns 'x'.repeat(4MiB) | ok (len=4194304, 60ms) | ACTION_MAY_HAVE_COMMITTED: The native browser action outcome is unknown (native capacity-exceeded; effects unknown; scope usable) | narrowed | usable; endAttempt=ok; dispose=ok |
| evaluate depth | evaluate-depth-80 | evaluate returns an object nested 80 deep | ok (depth=80, 27ms) | ok (depth=80, 30ms) | same | usable; endAttempt=ok; dispose=ok |
| evaluate depth | evaluate-depth-100 | evaluate returns an object nested 100 deep | Error: page.evaluate: Cannot serialize result: object reference chain is too long. | ok (depth=100, 24ms) | widened | usable; endAttempt=ok; dispose=ok |
| evaluate depth | evaluate-depth-126 | evaluate returns an object nested 126 deep | Error: page.evaluate: Cannot serialize result: object reference chain is too long. | ACTION_MAY_HAVE_COMMITTED: The native browser action outcome is unknown (native browser-failure; effects unknown; scope quarantined) | both-fail | unusable; endAttempt=ENGINE_FAILURE: The native browser cleanup could not be proven; dispose=ENGINE_FAILURE: The native browser cleanup could not be proven |
| evaluate depth | evaluate-depth-128 | evaluate returns an object nested 128 deep | Error: page.evaluate: Cannot serialize result: object reference chain is too long. | ACTION_MAY_HAVE_COMMITTED: The native browser action outcome is unknown (native browser-failure; effects unknown; scope quarantined) | both-fail | unusable; endAttempt=ENGINE_FAILURE: The native browser cleanup could not be proven; dispose=ENGINE_FAILURE: The native browser cleanup could not be proven |
| initScript count | init-count-100 | add 100 init scripts, navigate, read the last marker | ok (99, 62ms) | ok (99, 64ms) | same | usable; endAttempt=ok; dispose=ok |
| initScript count | init-count-1024 | add 1024 init scripts, navigate, read the last marker | ok (1023, 204ms) | ok (1023, 245ms) | same | usable; endAttempt=ok; dispose=ok |
| initScript count | init-count-1025 | add 1025 init scripts | ok (ok, 190ms) | ENGINE_FAILURE: The native browser operation failed (capacity-exceeded) | narrowed | usable; endAttempt=ok; dispose=ok |
| initScript total | init-total-8x950KiB | add 8 comment-only init scripts of 950KiB each (7,782,432B) | ok (ok, 84ms) | ok (ok, 133ms) | same | usable; endAttempt=ok; dispose=ok |
| initScript total | init-total-9x950KiB | add 9 comment-only init scripts of 950KiB each (8,755,236B) | ok (ok, 89ms) | ENGINE_FAILURE: The native browser operation failed (capacity-exceeded) | narrowed | usable; endAttempt=ok; dispose=ok |
| initScript per script | init-single-1.2MB | add one 1,200,000-byte init script | ok (ok, 37ms) | ENGINE_FAILURE: The native browser request exceeded its protocol bounds | narrowed | usable; endAttempt=ok; dispose=ok |
| blob single | blob-response-8MiB | waitForResponse and read an 8MiB response body | ok (body=8388608, 167ms) | ok (body=8388608, 258ms) | same | usable; endAttempt=ok; dispose=ok |
| blob single | blob-response-16MiB | waitForResponse and read a 16MiB response body | Error: response.body: Protocol error (Network.getResponseBody): Request content was evicted from inspector cache | ok (body=16777216, 447ms) | widened | usable; endAttempt=ok; dispose=ok |
| blob single | blob-response-32MiB | waitForResponse and read a 32MiB response body | Error: response.body: Protocol error (Network.getResponseBody): Request content was evicted from inspector cache | ok (body=33554432, 736ms) | widened | usable; endAttempt=ok; dispose=ok |
| blob single | blob-response-48MiB | waitForResponse and read a 48MiB response body | Error: response.body: Protocol error (Network.getResponseBody): Request content was evicted from inspector cache | ok (body=50331648, 1094ms) | widened | usable; endAttempt=ok; dispose=ok |
| blob single | blob-response-50MiB | waitForResponse and read a 50MiB response body | Error: response.body: Protocol error (Network.getResponseBody): Request content was evicted from inspector cache | ACTION_FAILED: waitForResponse: response body could not be read: The native browser operation failed (browser-failure) | both-fail | usable; endAttempt=ok; dispose=ok |
| blob single | blob-response-63MiB | waitForResponse and read a 63MiB response body | hang: no result before 120000ms; the watchdog killed the case | ACTION_FAILED: waitForResponse: response body did not finish within 60000ms | old-hang | usable; endAttempt=ok; dispose=ok |
| blob single | blob-download-64MiB | download one 64MiB file and read it from disk | ok ({"bytes":67108864}, 121ms) | ok ({"bytes":67108864}, 445ms) | same | usable; endAttempt=ok; dispose=ok |
| blob total | blob-download-130MiB | download one 130MiB file and read it from disk | ok ({"bytes":136314880}, 198ms) | ok ({"bytes":136314880}, 837ms) | same | usable; endAttempt=ok; dispose=ok |
| blob total | blob-download-total-150MiB | download three 50MiB files in sequence | ok (52428800+52428800+52428800 = 157286400, 218ms) | ok (52428800+52428800+52428800 = 157286400, 1008ms) | same | usable; endAttempt=ok; dispose=ok |
| state | state-localstorage-4MiB | capture storage state after 4MiB of localStorage | ok (state=4194409B indexedDb=false, 70ms) | ok (state=4194436B, 140ms) | same | usable; endAttempt=ok; dispose=ok |
| state | state-indexeddb-16MiB | capture storage state after 16MiB in IndexedDB | ok (state=27B indexedDb=false, 42ms) | ok (state=16777526B, 360ms) | old-cannot | usable; endAttempt=ok; dispose=ok |
| state | state-indexeddb-33MiB | capture storage state after 33MiB in IndexedDB | ok (state=27B indexedDb=false, 47ms) | ok (state=34603318B, 629ms) | old-cannot | usable; endAttempt=ok; dispose=ok |
| state | state-indexeddb-40MiB | capture storage state after 40MiB in IndexedDB | ok (state=27B indexedDb=false, 54ms) | ok (state=41943350B, 754ms) | old-cannot | usable; endAttempt=ok; dispose=ok |
| route timeout | route-background-31s | a page-timer request whose route handler awaits 31s | ok (done, 36034ms) | ACTION_FAILED: route handler exceeded its decision deadline | narrowed | unusable; endAttempt=OPERATION_TIMEOUT: The native browser callback exceeded its operation budget; dispose=OPERATION_TIMEOUT: The native browser callback exceeded its operation budget |
| route timeout | route-foreground-31s | a goto whose route handler awaits 31s | ok (boundary, 31086ms) | ACTION_MAY_HAVE_COMMITTED: The native browser action outcome is unknown (native browser-failure; effects unknown; scope usable) | narrowed | unusable; endAttempt=ok; dispose=ok |
| dialog timeout | dialog-background-31s | a page-timer alert whose dialog handler awaits 31s | ok (1, 36036ms) | ACTION_FAILED: dialog handler exceeded its decision deadline | narrowed | unusable; endAttempt=OPERATION_TIMEOUT: The native browser callback exceeded its operation budget; dispose=OPERATION_TIMEOUT: The native browser callback exceeded its operation budget |
| outer budget | budget-timeout-0 | navigate with timeout: 0 | ok (ok, 35ms) | OPERATION_TIMEOUT: Native browser recovery exhausted the operation budget | narrowed | usable; endAttempt=ok; dispose=ok |
| outer budget | budget-timeout-2h | navigate with timeout: 7200000 (2h) | ok (ok, 34ms) | ok (ok, 36ms) | same | usable; endAttempt=ok; dispose=ok |
| video | video-2s | record 2s of video and collect the segment files | ok (segments=1 bytes=5078, 2090ms) | ok (segments=1 bytes=10004, 2418ms) | same | usable; endAttempt=ok; dispose=ok |

| Verdict | Cases |
|---|---|
| narrowed | evaluate-size-1MiB, evaluate-size-4MiB, init-count-1025, init-total-9x950KiB, init-single-1.2MB, route-background-31s, route-foreground-31s, dialog-background-31s, budget-timeout-0 |
| old-hang | blob-response-63MiB |
| old-cannot | state-indexeddb-16MiB, state-indexeddb-33MiB, state-indexeddb-40MiB |
| both-fail | evaluate-depth-126, evaluate-depth-128, blob-response-50MiB |
| widened | evaluate-depth-100, blob-response-16MiB, blob-response-32MiB, blob-response-48MiB |
| same | evaluate-size-512KiB, evaluate-size-900KiB, evaluate-depth-80, init-count-100, init-count-1024, init-total-8x950KiB, blob-response-8MiB, blob-download-64MiB, blob-download-130MiB, blob-download-total-150MiB, state-localstorage-4MiB, budget-timeout-2h, video-2s |

The old side closed its context and browser cleanly in every row that
returned. One row did not return: the old 63MiB response read was killed by the
watchdog, so its cleanup is not observed. The harness asks a timed-out case for
SIGTERM (Playwright closes its browser on it), kills the detached native daemon
through its pid file, and SIGKILLs the case after a 5s grace; a browser that
ignores the grace can still outlive the run. The new cleanup column above is
the one that varies; the JSON records both sides' cleanup.

## What the table says

**True narrowings (old succeeds, new fails).**

| Family | Case | Old | New |
|---|---|---|---|
| evaluate size | 1MiB and 4MiB results | returns the value | `capacity-exceeded`, outcome reported unknown |
| initScript count | 1025 scripts | accepted | `capacity-exceeded` |
| initScript total | 9 scripts of 950KiB each (8,755,236B) | accepted | `capacity-exceeded` |
| initScript per script | one 1,200,000-byte script | accepted | request exceeds the protocol bounds |
| route timeout | goto or page-timer request, 31s handler | completes at 31s | fails at the 30s decision deadline |
| dialog timeout | page-timer alert, 31s handler | completes at 31s | fails at the 30s decision deadline |
| outer budget | `timeout: 0` | disables the timeout | `OPERATION_TIMEOUT` before dispatch |

**Stricter bound, but the old engine cannot do it either (not a narrowing).**

- `evaluate` depth 126 and 128: the old serializer already fails at depth 100
  (`object reference chain is too long`); the new depth bound is above it.
- A 50MiB response body: Chrome's inspector cache already failed the old
  engine at 16MiB, and both fail here.
- A 63MiB response body is not a clean capacity answer on either side: the old
  engine did not return within the 120s watchdog, and the new engine's read
  stalled until the caller's 60s operation budget expired. Neither reports a
  capacity error, and the new engine's 64MiB blob bound is never reached
  because Chromium's response-body ceiling comes first.

**Widened.**

- `evaluate` depth 100: old fails, new succeeds.
- Response bodies of 16, 32, and 48MiB: old fails
  (`Request content was evicted from inspector cache`), new reads them.

**Old API cannot express the scenario.**

- IndexedDB state: Playwright's `storageState()` carries cookies and
  localStorage only; the native state carries IndexedDB too. The 16, 33, and
  40MiB rows are capability gaps, not narrowings.

**Same.**

- 512KiB and 900KiB evaluate results, depth 80, 100-script and 1024-script
  init lists, 7,782,432B of init scripts, an 8MiB response body,
  64/130/150MiB of downloads (local downloads never enter the blob store),
  a 2h timeout, and a 2s video recording.

## Narrowing details and fix-scope estimates

No product code was changed; these are estimates to decide whether a follow-up
ticket should.

### evaluate result at or above ~1MiB

- Measured: 900KiB succeeds, 1MiB fails. The bound is the single JSON frame,
  `MAX_FRAME_BYTES = 1_048_576` in `packages/web/src/native/protocol.ts:5`; the
  envelope around the value pushes a 1MiB payload over it.
- Impact: a test that asserts on a large value returned from the page (a long
  `innerText`, a generated JSON report, an array of DOM data). App-scale values
  are far smaller; data-heavy applications can reach it.
- Workaround: project or chunk in the page (`slice`, counts, hashes) and return
  several smaller values. A single value over the bound cannot be returned.
- Estimate: medium, cross-repo. The native already advertises
  `browser.evaluate-blobs/1`, so an oversized result can travel through the
  blob store, with `Browser.evaluate` (`packages/web/src/browser.ts:479`)
  reading it in chunks. Roughly 150-300 lines in `levicode/agent-browser` and
  this repository, plus protocol tests. No public API change.

### initScript count above 1024 or total above 8MiB

- Measured: 1024 scripts and 7,782,432B pass; 1025 scripts and 8,755,236B fail
  `capacity-exceeded`. The caps are in `append_script`
  (`cli/src/native/client_page.rs`) and `scope.open`
  (`cli/src/native/client_browser.rs`).
- Impact: a generated init bundle stops applying at the cap. A thousand
  separate scripts or 8MiB of source is unusual; a generated fixture bundle is
  the realistic case.
- Workaround: concatenate scripts (count cap), split or trim the bundle (total
  cap). Both are practical.
- Estimate: small and native-only, but the caps bound per-attempt memory and
  script setup, so raising them is a resource-policy decision, not a defect
  fix.

### One initScript above ~1MiB

- Measured: one 1,200,000-byte script fails with
  `ENGINE_FAILURE: ... protocol bounds`; the old engine accepts it. One source
  travels in one command frame.
- Impact: a single generated bundle over 1MiB cannot be added as one script.
- Workaround: split it into several scripts, each under 1MiB; the 1024-script
  cap leaves room.
- Estimate: medium, cross-repo: chunked upload or a blob handle for init-script
  sources in the scope-open and `context.init-script` commands.

### route and dialog callbacks over 30s with no waiting test operation

- Measured: a request fired by a page timer whose route handler awaits 31s,
  an alert fired by a page timer whose dialog handler awaits 31s, and a `goto`
  whose own route handler awaits 31s (with a 60s goto budget) all fail with
  `route/dialog handler exceeded its decision deadline`; the old engine
  completes. The window is `DEFAULT_DECISION_TIMEOUT_MS = 30_000`
  (`cli/src/native/client_session.rs:21`); the source computes it from the live
  operations and floors it there, but the 60s goto in this table did not extend
  it.
- Impact: any route or dialog handler that runs longer than 30s, including one
  a navigation is waiting on, not only a background callback.
- Workaround: keep background handlers under 30s; answer dialogs immediately.
- Estimate: small code in agent-browser (the default and the per-scope
  window), but the bound retires abandoned callbacks, so a new default or a
  knob is a product decision.

### `timeout: 0`

- Measured: old `page.goto(url, { timeout: 0 })` disables the timeout and
  succeeds; the new engine fails `OPERATION_TIMEOUT` before dispatch.
  `timeout()` in `packages/web/src/native/client.ts` rejects a non-positive
  budget; the ceiling is `MAX_TIMEOUT_MS = 3_600_000` (1h).
- Impact: migrated Playwright tests that use 0 for "no timeout". The rest of
  the budget surface is equal: a 2h timeout is accepted (clamped silently to
  1h).
- Workaround: omit `timeout`, or pass the largest supported value.
- Estimate: tiny and this-repository-only: map 0 to the 1h ceiling in
  `client.ts`, add a test and a docs line. It changes public timeout semantics,
  so it needs sign-off.

### state 32MiB and video

- Not a narrowing at the measured candidate: 33MiB and 40MiB IndexedDB states
  capture as 34.6MB and 41.9MB JSON. Playwright's `storageState()` excludes
  IndexedDB entirely, so it cannot express the scenario.
- The 32MiB clamp exists only in the older pinned native `d6d7d5d`
  (`MAX_STATE_BYTES`), which cannot negotiate with the current engine. Treat it
  as historical rather than a current boundary.
- Video: a 2s recording succeeds on both engines. The 64MiB/128MiB segment caps
  were not reachable in a practical recording.

## Defects found on the failure paths (not fixed)

1. An over-deep evaluate result (depth 126/128) fails with `scope quarantined`,
   and `endAttempt`/`dispose` cannot prove cleanup
   (`ENGINE_FAILURE: The native browser cleanup could not be proven`). The
   browser process can leak. This is not a narrowing, since the old engine
   fails at depth 100, but the failure path needs fixing.
2. A background callback deadline leaves the engine unusable and cleanup
   unproven (`OPERATION_TIMEOUT` from `endAttempt` and `dispose`). Same class
   as above.
3. Near Chromium's response-body ceiling (63MiB), neither engine settles
   cleanly: the old engine hung past the 120s watchdog, and the new engine's
   read stalled until the caller's 60s budget expired. Neither reports a clean
   capacity error; the new engine's 64MiB blob bound is never reached because
   Chromium's ceiling comes first.
4. `browser.evaluate` over the frame bound reports `ACTION_MAY_HAVE_COMMITTED`
   with `scopeState: usable`. That is defensible because the page code ran, but
   it makes a read-only call look like an uncertain mutation.

## Limitations

- 128 blob handles and the 128MiB blob total were not exercised: no public
  scenario holds that many handles or that much blob data at once. Downloads
  stay on disk and response-body handles release after the read, so only the
  source constants confirm those bounds.
- The video segment size caps (64MiB single, 128MiB total) need a recording
  long enough to exceed them and were not measured; only a 2s recording was.
- IndexedDB state rows compare a capability the old engine does not have, not a
  capacity.
- A 2h timeout is accepted by both, but the new engine clamps it to 1h
  silently; a boundary above one hour was not waited for.
- The pinned native revision cannot negotiate with this branch, so every row
  measures the declared candidate `9069cb4`, not the older CI pin `d6d7d5d`.
