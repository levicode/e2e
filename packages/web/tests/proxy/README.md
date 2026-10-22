# Production byte-proxy settlement contract

This explicit suite runs NativeClient against a child whose stdin/stdout are forwarded by the actual native connection::proxy_client_session function to a private temporary Unix socket peer. It does not launch a browser or daemon, does not exercise isolated-daemon startup/admission, and is not proof that the browser-backed semantic fault suite passes. The ordinary CLI cannot attach to this fake peer because its isolated startup intentionally rejects an existing session.

Build the native test-only child explicitly from the matching native checkout:

```sh
cargo test --manifest-path cli/Cargo.toml --locked --features acceptance-faults --test client-proxy-fixture --no-run --message-format=json
```

Use the exact executable returned in Cargo's compiler-artifact record, not a guessed target path. This target has harness=false and test=false; it adds no production CLI command, and requires explicit fixture arguments. Neither compilation nor the pure diagnostics unit tests exercise child pipes or Unix sockets.

Run the hosted chain from the e2e checkout:

```sh
E2E_AGENT_BROWSER_PROXY_FIXTURE=/absolute/compiler-artifact/executable pnpm --filter @e2e-dev/web exec vitest run --config tests/proxy/vitest.config.ts
```

Missing fixture path or unsupported platform fails rather than silently skipping. This suite is intentionally outside the default unit/browser test includes and needs its explicit config. The ordinary pure unit file tests/unit/native-proxy-diagnostics.test.ts validates the bounded diagnostic schema and the actual Writable observer without sockets.

## Assertions and limits

- The original operation budget remains 2 seconds and NativeClient's existing settlement budget remains 5 seconds. No fake timers, timeout increases, fabricated client-side ACK state, or acknowledgement bypasses are used. Every ACK is a correlated scripted-peer frame carried over the real proxy, not native-broker execution evidence.
- A separate early-result control emits a successful completed/usable result immediately after the concurrent status completes and requires observed result-before-cancel ordering with zero cancel/ACK and fresh reuse. Near-deadline cases separately schedule a result at dispatch plus 1999, 2000, or 2001 milliseconds. Scheduling a timer in another event-loop callback is not proof of cross-process simultaneity. The suite records observed local cancel-write versus complete result order separately. A result consumed before the local timer needs zero cancels; a locally cancelled request requires exactly one complete peer cancel and one correlated ACK before reuse.
- A concurrent status request must reach the peer and complete while the original request is pending. Fresh requests are rejected between cancellation and complete settlement, then a new request succeeds once both the known result and real ACK arrive. Explicit abort uses ACK-first ordering; deadline cases with cancellation use result-first ordering and a legitimate rejected-late-cancel ACK.
- Missing ACK and unknown/quarantined-result controls remain non-reusable. The unknown-result control sends its terminal result only after the peer has received the complete cancel, because quarantine may legitimately destroy the transport immediately. A known execute result is never treated as cancellation acknowledgement.
- TS observations include the original child's write-enter, return value, callback, byte count, and writableLength. No second Writable or transport buffer is inserted. Peer observations prove complete framed cancel receipt; TS observes a full correlated ACK and then requires NativeClient's request to settle.
- The native function's test-only observers wrap its existing std::io::copy calls. They record only read/write byte counts, cumulative counts, ordinals, closed error enums, and a capture-limit flag. At most 129 records are emitted, and the TS collector is also capped. These observers may perturb scheduling; passing controlled interleavings does not locate or disprove the original CI failure.
- The production runtime phase sink is unchanged. Missing final records alone do not prove a phase did not occur. Runtime try-lock loss, cap, and failure limitations still apply to the original browser-backed artifacts.

Execution status must be reported separately: authored, compiled/pure unit-checked, or hosted child-pipe/Unix-chain executed. Until the explicit hosted suite runs successfully, the actual chain remains pending.

## Opt-in hosted candidate wiring

The existing `native-candidate.yml` workflow explicitly runs this diagnostic after the default native harnesses and the separate fault-runtime build. It uses the reviewed native revision already selected by the workflow; it does not update the source pin. The diagnostic does not depend on browser installation or browser-suite success, and its result cannot replace any existing candidate gate.

`scripts/acceptance/candidate-proxy-diagnostic.ts` compiles only `--test client-proxy-fixture` with `--locked --profile ci --no-default-features --features acceptance-faults --no-run --message-format=json`. It requires one successful, feature-matched compiler artifact from the exact fixture source, validates the executable stays inside the selected Cargo target, then passes that exact executable to the explicit Vitest config. Both copied production and acceptance-faults runtime hashes are checked separately and must remain unchanged. No fixture binary enters the production bundle.

Compilation has a 15-minute process-group limit and the complete seven-scenario suite a 4-minute limit, within a 25-minute workflow step. The asynchronous runner owns each command's detached process group directly, caps stdout and stderr independently, sends group TERM then group KILL after 5 seconds on overflow, deadline, interruption, or surviving descendants, and waits up to 3 more seconds for pipe closure and group disappearance. The first observed group disappearance permanently retires its numeric PGID, independently of pipe closure; no later timer may probe or signal that number again. An inherited pipe held outside the retired group therefore fails cleanup rather than risking a signal to a reused PGID. Unconfirmed cleanup fails the diagnostic; an outer supervisor's exit is never treated as descendant cleanup. Uncatchable runner/OS termination remains outside these in-process cleanup guarantees. These outer limits do not change the 2-second operation, 5-second settlement, or per-test budgets. The runner does not retry an interleaving or silently skip a missing fixture.

The normal candidate evidence upload includes separate `proxy-diagnostic.execution.json`, `proxy-diagnostic.result.json`, and, when the suite started and output could be collected, `proxy-diagnostic.traces.json`. An always-run finalizer records failed, interrupted, or prerequisite-skipped execution without claiming the chain passed. Diagnostic failure remains a workflow failure, but the existing mandatory candidate receipt schema and gates are unchanged. The final receipt is bound to the execution receipt's hash.

Only the existing closed, bounded failure traces are retained: at most seven scenarios with at most 256 records each. The suite emits these traces on failure, not on success; an empty trace list is not phase or ordering evidence. Cargo output and raw Vitest stdout, stderr, stack traces, and assertion payloads are not uploaded. A successful diagnostic proves only the exact seven scripted-peer scenarios ran without skips, never native-broker settlement, browser-backed semantic recovery, or release readiness.
