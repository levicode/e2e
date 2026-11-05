/**
 * The raw-selector differential's committed state.
 *
 * `baseline.json` is what the replaced Playwright entry returned for every
 * selector in `cases.ts` on `fixture.ts`: the ordered match set, or the error
 * Playwright raised. It is recorded from the real engine, not written by hand,
 * and re-checked live on every run so a Playwright, Chromium or fixture change
 * cannot silently move the reference.
 *
 * `expected.txt` is one line per disagreement between the current native entry
 * and that baseline, each with the reason it is kept. A run fails on a
 * disagreement the file does not list and on a listed one that no longer
 * happens, so a fix removes its line and a regression adds one, both in
 * review. `E2E_RAW_PARITY_UPDATE=1` rewrites both files from the run, keeping
 * every surviving reason and marking new lines `TODO`, which fails until
 * someone writes the reason.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/** One selector under differential test, grouped by the issue family it covers. */
export interface RawLocatorCase {
  /** Issue family: 30 raw text, 31 raw role, 32 extended CSS, 33 internal/capture. */
  readonly family: '30' | '31' | '32' | '33';
  /** The authored selector, passed to both the original and the current entry. */
  readonly selector: string;
  /** Why this selector is in the matrix. */
  readonly intent: string;
}

/** What one entry returned: its ordered match set, or the error it refused with. */
export interface Outcome {
  readonly ids: readonly string[];
  readonly error: string | null;
}

export interface BaselineCase extends RawLocatorCase, Outcome {}

export interface Baseline {
  readonly schemaVersion: 1;
  readonly oracle: {
    readonly playwright: string;
    readonly chromium: string;
    /** The revision whose public entry is the reference, and where it delegated. */
    readonly originalRevision: string;
    readonly originalEntry: string;
  };
  readonly fixtureSha256: string;
  readonly cases: readonly BaselineCase[];
}

export const TODO_REASON = 'TODO: say why this difference is kept, or fix it';

const SEPARATOR = ' | ';

/** The sha256 of the exact fixture text both entries read. */
export function fixtureSha256(html: string): string {
  return createHash('sha256').update(html, 'utf8').digest('hex');
}

/** Playwright's own error prefix names the read that threw, not the selector. */
export function normalizeOracleError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^[a-zA-Z.]+: /, '')
    .replace(/^Error: /, '')
    .replaceAll('\n', ' ')
    .replaceAll(SEPARATOR, ' / ');
}

/** A whitespace-free summary used inside a committed expectation key. */
export function summarize(outcome: Outcome): string {
  if (outcome.error !== null) return `error ${outcome.error}`;
  return `count ${outcome.ids.length} [${outcome.ids.join(',')}]`;
}

/** Two outcomes agree when they found the same ordered matches or both refused. */
export function sameOutcome(left: Outcome, right: Outcome): boolean {
  return (left.error === null) === (right.error === null) && left.ids.join('\u0000') === right.ids.join('\u0000');
}

/** The line of one disagreement without its reason; equal keys are the same disagreement. */
export function keyOf(testCase: RawLocatorCase, ours: Outcome, theirs: Outcome): string {
  return [testCase.family, testCase.selector, `ours ${summarize(ours)}`, `theirs ${summarize(theirs)}`].join(SEPARATOR);
}

/** Every listed key with its reason; comment and blank lines are skipped. */
export function readExpectations(file: string): Map<string, string> {
  const expected = new Map<string, string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const cut = line.lastIndexOf(SEPARATOR);
    expected.set(line.slice(0, cut), line.slice(cut + SEPARATOR.length));
  }
  return expected;
}

/** Keys the file does not list, and listed family keys that no longer happen. */
export function diffExpectations(
  expected: ReadonlyMap<string, string>,
  seen: ReadonlySet<string>,
  families: ReadonlySet<string>,
): { unexpected: string[]; stale: string[] } {
  const familyOf = (key: string) => key.slice(0, key.indexOf(SEPARATOR));
  return {
    unexpected: [...seen].filter((key) => !expected.has(key)).toSorted(),
    stale: [...expected.keys()].filter((key) => families.has(familyOf(key)) && !seen.has(key)).toSorted(),
  };
}

/** Rewrites the file: keys of families that did not run stay, the rest follow the run. */
export function writeExpectations(
  file: string,
  header: string,
  expected: ReadonlyMap<string, string>,
  seen: ReadonlySet<string>,
  families: ReadonlySet<string>,
): void {
  const familyOf = (key: string) => key.slice(0, key.indexOf(SEPARATOR));
  const lines = new Map<string, string>();
  for (const [key, reason] of expected) if (!families.has(familyOf(key))) lines.set(key, reason);
  for (const key of seen) lines.set(key, expected.get(key) ?? TODO_REASON);
  const body = [...lines].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, reason]) => `${key}${SEPARATOR}${reason}`);
  writeFileSync(file, `${header}\n${body.join('\n')}\n`);
}
