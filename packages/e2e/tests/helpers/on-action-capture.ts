/** Case-local native producer witness; never changes the original test result. */
import { constants, openSync, closeSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
export function onActionCaptureEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | undefined {
  const directory = env['E2E_ON_ACTION_CAPTURE_DIR'];
  if (directory === undefined) return undefined;
  try {
    if (env['AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE'] !== undefined || env['E2E_POPUP_EVAL_CAPTURE'] === '1') return undefined;
    if (!path.isAbsolute(directory) || realpathSync(directory) !== directory) return undefined;
    for (let at = directory;; at = path.dirname(at)) {
      if (lstatSync(at).isSymbolicLink()) return undefined;
      if (at === path.dirname(at)) break;
    }
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700) return undefined;
    const file = path.join(directory, 'on-action-delayed.cleanup.jsonl');
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    return { ...env, AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE: file };
  } catch { return undefined; }
}
