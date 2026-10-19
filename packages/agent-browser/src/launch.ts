import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EngineError, type OperationContext } from 'e2e/engine';

export interface OwnedBrowser {
  readonly endpoint: string;
  close(): Promise<void>;
}

/** Owns exactly one local Chromium process group and one disposable profile. */
export async function launchChromium(options: {
  executable: string;
  headed?: boolean;
  args?: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
}, context: OperationContext): Promise<OwnedBrowser> {
  if (context.signal.aborted) throw new EngineError('CANCELLED', 'Browser launch cancelled', { retryable: false });
  const profile = await mkdtemp(path.join(tmpdir(), 'e2e-agent-browser-'));
  const endsAt = Date.now() + Math.max(0, context.timeoutMs);
  let process: ChildProcess;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (process?.pid && process.exitCode === null && process.signalCode === null) {
      const exited = new Promise<void>((resolve) => process.once('close', () => resolve()));
      try { if (process.pid) globalThis.process.kill(-process.pid, 'SIGTERM'); } catch { process.kill('SIGTERM'); }
      const force = setTimeout(() => {
        try { if (process.pid) globalThis.process.kill(-process.pid, 'SIGKILL'); } catch { process.kill('SIGKILL'); }
      }, 1500);
      await exited;
      clearTimeout(force);
    }
    await rm(profile, { recursive: true, force: true });
  };
  try {
    process = spawn(options.executable, [
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update',
      '--disable-sync', '--disable-extensions', '--disable-dev-shm-usage',
      ...(options.headed ? [] : ['--headless=new']),
      ...(options.args ?? []), 'about:blank',
    ], { env: { ...options.env }, stdio: 'ignore', detached: globalThis.process.platform !== 'win32' });
    let spawnError = false;
    process.once('error', () => { spawnError = true; });
    while (Date.now() < endsAt) {
      if (context.signal.aborted) throw new EngineError('CANCELLED', 'Browser launch cancelled', { retryable: false });
      if (spawnError || process.exitCode !== null || process.signalCode !== null) throw new EngineError('ENGINE_FAILURE', 'Chromium exited before exposing its debugging endpoint', { retryable: false });
      try {
        const [port, wsPath] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
        if (port && /^\d+$/.test(port) && wsPath?.startsWith('/devtools/browser/')) {
          return { endpoint: `ws://127.0.0.1:${port}${wsPath}`, close };
        }
      } catch { /* endpoint file is created only when ready */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new EngineError('OPERATION_TIMEOUT', 'Chromium launch timed out', { retryable: false });
  } catch (error) {
    await close();
    throw error;
  }
}
