/**
 * The exit-code contract `verify` presents to a person and to the fixed
 * runner. `2` is reserved for the private settings and the saved session; the
 * e2e CLI also uses `2` for a CLI, config, or agent-policy error, so a run
 * that ends with that code is reported as a run failure instead.
 */

/** verify's own preflight failure: the private settings or the saved session are unusable. */
export const UAT_UNUSABLE_EXIT = 2;

/** Maps a finished e2e CLI run to verify's exit code. */
export function verifyExitCode(runExitCode: number, sessionExpired: boolean): number {
  if (sessionExpired) return UAT_UNUSABLE_EXIT;
  return runExitCode === UAT_UNUSABLE_EXIT ? 3 : runExitCode;
}
