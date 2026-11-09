/** The external dependency a local native video recording resolves from PATH. */
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/**
 * An actionable message when `ffmpeg` is not on the worker's PATH, else
 * undefined.
 *
 * The native recorder starts `ffmpeg` from PATH and reports only a generic
 * `browser-failure` over the session protocol, so a missing optional dependency
 * reads like a browser fault. Probing the same PATH before the recording is
 * dispatched keeps the cause and its fix next to the error. A missing PATH
 * leaves the native check authoritative instead of guessing.
 */
export function missingRecordingDependency(env: Readonly<Record<string, string | undefined>>, cwd: string): string | undefined {
  const value = env['PATH'];
  if (value === undefined) return undefined;
  const directories = value.split(path.delimiter).map(directory => directory === '' ? cwd : directory);
  if (directories.some(directory => executable(path.join(directory, 'ffmpeg')))) return undefined;
  return 'Video recording requires FFmpeg, and no `ffmpeg` executable is on PATH. Install it (macOS: `brew install ffmpeg`; Debian/Ubuntu: `sudo apt-get install ffmpeg`) and rerun. Recording is the only Web feature that needs FFmpeg.';
}

function executable(file: string): boolean {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}
