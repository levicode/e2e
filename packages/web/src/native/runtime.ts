/** Resolve the explicitly trusted developer runtime without installing or invoking a shell. */
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { EngineError } from 'e2e/engine';
import { resolveInstalledRuntime } from './installed-runtime.ts';

/** An override is explicit trust in a local build, not a claim of upstream provenance. */
export async function resolveNativeExecutable(env: Readonly<Record<string, string | undefined>>, projectRoot = process.cwd()): Promise<string> {
  const candidate = env['E2E_AGENT_BROWSER_EXECUTABLE'];
  if (candidate === undefined || candidate.length === 0) {
    try { return await resolveInstalledRuntime(projectRoot); }
    catch { throw new EngineError('INVALID_STATE', 'Install a verified matching Web runtime bundle or set E2E_AGENT_BROWSER_EXECUTABLE to a trusted native build', { retryable: false }); }
  }
  if (!path.isAbsolute(candidate)) throw invalidExecutable();
  try {
    const executable = await realpath(candidate);
    if (!(await stat(executable)).isFile()) throw invalidExecutable();
    await access(executable, constants.X_OK);
    return executable;
  } catch { throw invalidExecutable(); }
}

function invalidExecutable(): EngineError {
  // Paths may contain private project information; never echo them into tool errors.
  return new EngineError('INVALID_STATE', 'E2E_AGENT_BROWSER_EXECUTABLE must name an absolute executable file', { retryable: false });
}
