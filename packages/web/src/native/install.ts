/** Explicit Chromium installation through the same trusted native executable as the runtime. */
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { EngineError } from 'e2e/engine';
import { resolveNativeExecutable } from './runtime.ts';

export interface NativeInstallContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}
export async function runNativeInstall(args: readonly string[], context: NativeInstallContext = { cwd: process.cwd(), env: process.env }): Promise<number> {
  if (args[0] !== 'install' || args.length > 2 || (args.length === 2 && args[1] !== '--with-deps')) throw failure();
  const executable = await resolveNativeExecutable(context.env, context.cwd);
  return new Promise((resolve, reject) => {
    // No shell, PATH fallback, or implicit package manager installation.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], { cwd: context.cwd, env: { ...context.env }, shell: false, stdio: 'inherit', windowsHide: true });
    } catch { reject(failure()); return; }
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on('SIGINT', forward); process.on('SIGTERM', forward);
    const clean = () => { process.off('SIGINT', forward); process.off('SIGTERM', forward); };
    child.once('error', () => { clean(); reject(failure()); });
    child.once('exit', (code, signal) => { clean(); resolve(code ?? (signal === null ? 1 : 128 + constants.signals[signal])); });
  });
}
function failure(): EngineError { return new EngineError('ENGINE_FAILURE', 'The trusted native Chromium installer could not run', { retryable: false }); }
