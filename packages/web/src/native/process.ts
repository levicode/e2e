import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { EngineError, type OperationContext } from 'e2e/engine';
import { NativeClient } from './client.ts';
import type { NativeEvent } from './protocol.ts';

export interface NativeProcessOptions {
  /** Absolute, installer/provenance-verified native executable; never a shell command. */
  readonly executable: string;
  readonly cwd: string;
  /** Explicit runtime environment. Provider credentials travel in protocol, not argv. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly capabilities: readonly string[];
}

/** A dedicated negotiated client, never a reconnect to an unknown old daemon. */
export async function connectNativeProcess(options: NativeProcessOptions, operation: OperationContext,
  onEvent: (event: NativeEvent) => void | Promise<void>): Promise<NativeClient> {
  if (!path.isAbsolute(options.executable)) throw new EngineError('INVALID_STATE', 'The native browser executable must be an absolute verified path', { retryable: false });
  if (operation.signal.aborted) throw new EngineError('CANCELLED', 'The native browser startup was cancelled', { retryable: false });
  const child = spawn(options.executable, ['--session', `e2e-${randomUUID()}`, 'session', 'connect', '--json'], {
    cwd: options.cwd, env: { ...options.env }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Native diagnostics may include browser/provider data. Drain without echoing
  // them into model/tool errors or retaining an unbounded stderr buffer.
  child.stderr.resume();
  child.on('error', () => child.stdout.destroy(new Error('Native browser process failed')));
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2_000);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }
  };
  const settle = (context: OperationContext): Promise<void> => new Promise((resolve, reject) => {
    const failure = () => new EngineError('ENGINE_FAILURE', 'The native browser proxy did not exit cleanly', { retryable: false });
    if (child.exitCode !== null || child.signalCode !== null) { child.exitCode === 0 ? resolve() : reject(failure()); return; }
    if (context.signal.aborted || context.timeoutMs <= 0) { reject(failure()); return; }
    const finish = (code: number | null) => { clearTimeout(timer); context.signal.removeEventListener('abort', abort); child.removeListener('exit', finish); code === 0 ? resolve() : reject(failure()); };
    const abort = () => finish(null);
    const timer = setTimeout(abort, context.timeoutMs);
    child.once('exit', finish);
    context.signal.addEventListener('abort', abort, { once: true });
    child.stdin.end();
    if (context.signal.aborted) abort();
  });
  try {
    return await NativeClient.connect({ readable: child.stdout, writable: child.stdin, dispose, settle }, options.capabilities, operation, onEvent);
  } catch (error) {
    dispose();
    throw error;
  }
}
