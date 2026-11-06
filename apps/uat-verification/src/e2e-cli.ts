/**
 * Runs the built e2e CLI from this app, exactly as a consumer project would.
 * The workspace links `e2e` and `@e2e-dev/web` into `node_modules`, and the
 * repository build must have produced their `dist` first.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** This app's project root: where its configs, tests, and output directory live. */
export const appRoot = path.resolve(import.meta.dirname, '..');

/** The built CLI entry, or a clear error when the repository was never built. */
export function e2eCli(): string {
  const file = path.join(appRoot, 'node_modules', 'e2e', 'dist', 'cli', 'bin.js');
  if (!existsSync(file)) throw new Error('E2E_NOT_BUILT: run `pnpm build` at the repository root before the UAT loop');
  return file;
}

/** Runs one e2e invocation, inheriting the terminal, and resolves its exit code. */
export function runE2e(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [e2eCli(), ...args], { cwd: appRoot, stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 130)));
  });
}
