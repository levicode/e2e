import { bindSecretsClientProcess, captureSecretsContext, captureSecretsProcessContext } from './secrets-diagnostics.ts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { EngineError, type OperationContext } from 'e2e/engine';
import type { AcceptanceTrace } from './acceptance-trace.ts';
import { NativeClient } from './client.ts';
import type { NativeEvent } from './protocol.ts';
import { retainUnresolvedProcess } from './process-cleanup.ts';

export interface NativeProcessOptions {
  /** Absolute, installer/provenance-verified native executable; never a shell command. */
  readonly executable: string;
  readonly cwd: string;
  /** Explicit runtime environment. Provider credentials travel in protocol, not argv. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly capabilities: readonly string[];
  /** Supplied only by acceptance tests, never inferred from the environment. */
  readonly acceptanceTrace?: AcceptanceTrace;
}

/** A dedicated negotiated client, never a reconnect to an unknown old daemon. */
export async function connectNativeProcess(options: NativeProcessOptions, operation: OperationContext,
  onEvent: (event: NativeEvent) => void | Promise<void>): Promise<NativeClient> {
  if (!path.isAbsolute(options.executable)) throw new EngineError('INVALID_STATE', 'The native browser executable must be an absolute verified path', { retryable: false });
  if (operation.signal.aborted) throw new EngineError('CANCELLED', 'The native browser startup was cancelled', { retryable: false });
  const diagnostic = captureSecretsContext();
  const diagnosticProcess = captureSecretsProcessContext();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.executable, ['--session', `e2e-${randomUUID()}`, 'session', 'connect', '--json'], {
      cwd: options.cwd, env: { ...options.env }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      // The runner owns foreground interrupts. Keep the proxy alive for its
      // acknowledged cleanup; pipes and the child handle retain ownership.
      detached: process.platform !== 'win32',
    });
  } catch {
    throw new EngineError('ENGINE_FAILURE', 'The native browser process could not start', { retryable: false });
  }
  const trace = options.acceptanceTrace;
  trace?.observeComputed('ProcessSpawned', () => child.pid === undefined ? {} : { proxyPid: child.pid });
  if (trace !== undefined) child.on('exit', (code, signal) => trace?.observe('ProcessExit', { codeKnown: code !== null, ...(code === null || code < 0 ? {} : { exitCode: code }), signalled: signal !== null }));
  if (trace !== undefined) child.on('close', (code, signal) => trace?.observe('ProcessClose', { codeKnown: code !== null, ...(code === null || code < 0 ? {} : { exitCode: code }), signalled: signal !== null }));
  // Native diagnostics may include browser/provider data. Drain without echoing
  // them into model/tool errors or retaining an unbounded stderr buffer.
  child.stderr.resume();
  child.on('error', () => child.stdout.destroy(new Error('Native browser process failed')));
  let disposal: Promise<boolean> | undefined;
  const dispose = () => {
    if (disposal !== undefined) return;
    let finish = (_settled: boolean): void => {};
    disposal = new Promise<boolean>(resolve => {
      let done = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const exited = () => finish(true);
      finish = settled => {
        if (done) return; done = true;
        clearTimeout(killTimer); clearTimeout(deadline);
        child.removeListener('exit', exited); child.removeListener('close', exited);
        resolve(settled);
      };
      child.once('exit', exited); child.once('close', exited);
      if (child.exitCode !== null || child.signalCode !== null) { finish(true); return; }
      // Fresh cleanup budget: cancellation of startup does not cancel process ownership.
      killTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) { finish(true); return; }
        try { child.kill('SIGKILL'); } catch { /* The bounded exit proof below remains authoritative. */ }
      }, 2_000);
      deadline = setTimeout(() => finish(false), 3_000);
    });
    trace?.observe('StreamsDestroyEntered');
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
    else { try { child.kill('SIGTERM'); } catch { /* Still attempt bounded final cleanup. */ } }
  };
  const settle = (context: OperationContext): Promise<void> => new Promise((resolve, reject) => {
    const failure = () => new EngineError('ENGINE_FAILURE', 'The native browser proxy did not exit cleanly', { retryable: false });
    if (child.exitCode !== null || child.signalCode !== null) { if (child.exitCode === 0) resolve(); else reject(failure()); return; }
    if (context.signal.aborted || context.timeoutMs <= 0) { reject(failure()); return; }
    const finish = (code: number | null) => { clearTimeout(timer); context.signal.removeEventListener('abort', abort); child.removeListener('exit', finish); if (code === 0) resolve(); else reject(failure()); };
    const abort = () => finish(null);
    const timer = setTimeout(abort, context.timeoutMs);
    child.once('exit', finish);
    context.signal.addEventListener('abort', abort, { once: true });
    trace?.observe('StdinEndEntered');
    child.stdin.end();
    if (context.signal.aborted) abort();
  });
  try {
    const client = await NativeClient.connect({ readable: child.stdout, writable: child.stdin, dispose, settle, ...(trace === undefined ? {} : { acceptanceTrace: trace }) }, options.capabilities, operation, onEvent);
    bindSecretsClientProcess(client, child.pid, diagnosticProcess, diagnostic);
    return client;
  } catch (error) {
    dispose();
    if (!(await disposal!)) {
      const primary = error instanceof EngineError ? error : new EngineError('ENGINE_FAILURE', 'The native browser startup failed', { retryable: false });
      const cleanup = new EngineError('ENGINE_FAILURE', 'The failed native browser proxy could not be confirmed stopped', { retryable: false });
      const failure = new EngineError(primary.code, primary.message, { retryable: false, cause: new AggregateError([primary, cleanup], 'Native startup failed with unresolved process cleanup') });
      // Keep the exact unresolved child attached to the retained failure; never adopt another process.
      retainUnresolvedProcess(failure, child);
      throw failure;
    }
    throw error;
  }
}
