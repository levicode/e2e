import { constants, openSync, closeSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

type CaseId = 'p01' | 'video-refusal';
type State = 'disabled' | 'ready' | 'unavailable' | 'environment-conflict';
/** Test-process-local capture only: no retries, browser controls, or success authority. */
export function beginCaseCleanupCapture(caseId: CaseId, meta: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): { finish(): void } {
  const directory = env['E2E_CASE_CLEANUP_DIAGNOSTIC_DIR'];
  const previous = env['AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE'];
  const file = `${caseId}.cleanup.jsonl`;
  let state: State = directory === undefined ? 'disabled' : 'unavailable';
  let ownedPath: string | undefined;
  let restored = false;
  let finished = false;
  const publish = () => { try { meta['caseCleanupCapture'] = { schemaVersion: 1, caseId, file, state, restored }; } catch { /* No diagnostic authority. */ } };
  if (directory !== undefined) {
    try {
      if (!isAbsolute(directory) || realpathSync(directory) !== resolve(directory) || !lstatSync(directory).isDirectory()) throw new Error('Invalid capture directory');
      const target = join(directory, file);
      const fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
      env['AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE'] = target;
      ownedPath = target;
      state = 'ready';
    } catch { /* Leave inherited configuration untouched; readiness remains unavailable. */ }
  }
  publish();
  return { finish() {
    if (finished) return;
    finished = true;
    if (ownedPath !== undefined) {
      if (env['AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE'] === ownedPath) {
        if (previous === undefined) delete env['AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE'];
        else env['AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE'] = previous;
        restored = true;
      } else state = 'environment-conflict';
    }
    publish();
  } };
}
