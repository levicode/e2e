/** Opt-in fixture-local native capture; no global env or acceptance changes. */
import { accessSync, constants, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { RunOptions } from './run-project.ts';

export function popupEvalDiagnosticOptions(projectDir: string, appUrl: string, optIn: 'E2E_POPUP_EVAL_CAPTURE' | 'E2E_REPLACED_FIELD_CAPTURE' = 'E2E_POPUP_EVAL_CAPTURE'): Partial<RunOptions> {
  if (process.env[optIn] !== '1') return {};
  const wrapper = process.env['E2E_POPUP_EVAL_WRAPPER'];
  const native = process.env['E2E_AGENT_BROWSER_EXECUTABLE'];
  for (const executable of [wrapper, native]) {
    if (executable === undefined || !path.isAbsolute(executable)) throw new Error('Popup capture requires absolute verified executable paths');
    const info = lstatSync(executable);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Popup capture requires regular executable files');
    accessSync(executable, constants.X_OK);
  }
  if (wrapper === native) throw new Error('Popup capture wrapper must differ from native executable');
  const output = path.join(projectDir, '.e2e', 'native-trace');
  mkdirSync(output, { recursive: true });
  if (!lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink()) throw new Error('Popup capture requires an owned directory');
  return { env: { ...process.env, CI: '', APP_URL: appUrl,
    E2E_AGENT_BROWSER_EXECUTABLE: wrapper,
    E2E_DIAGNOSTIC_NATIVE_EXECUTABLE: native,
    E2E_DIAGNOSTIC_DIR: output } };
}
