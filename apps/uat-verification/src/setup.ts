/**
 * The setup stage's own entry open: open the app, verify the home route, and
 * retry only connection-class failures.
 *
 * A 5xx gateway page, a reset connection, or a navigation that timed out is
 * retried — nothing the run cares about has happened yet, so a second attempt
 * can succeed. A login redirect, an unusable session file, or any other
 * failure is not retried: a retry cannot fix it, and retrying would hide a
 * real session problem behind noise. The attempts are returned, and written to
 * the file the report reads, so a retry is visible rather than silent.
 *
 * The business steps keep `retries: 0`; this budget exists only here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appUnreachable, isUnreachableStatus, waitForHome, type HomeProbe } from './app-location.ts';
import type { UatSettings } from './settings.ts';

/** At most two retries, each waiting longer than the one before. */
export const SETUP_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

/** One attempt's navigation budget, so a hung gateway leaves room for its retries. */
const OPEN_TIMEOUT_MS = 25_000;

/** How long one attempt waits for the app's home route before deciding it did not arrive. */
const HOME_TIMEOUT_MS = 20_000;

/** The e2e codes that say the navigation itself failed: a reset connection, or no answer in the budget. */
const CONNECTION_FAILURE_CODES: ReadonlySet<string> = new Set(['ACTION_MAY_HAVE_COMMITTED', 'OPERATION_TIMEOUT']);

/** What one setup attempt opened and how it ended. */
export interface SetupAttempt {
  readonly attempt: number;
  readonly startedAt: string;
  readonly durationMs: number;
  /** The document's HTTP status when one was read; 0 when the navigation got no response. */
  readonly status?: number;
  readonly outcome: 'passed' | 'unreachable' | 'session-expired' | 'failed';
}

/** The setup's bounded retry, as the report shows it. */
export interface SetupRecord {
  readonly schemaVersion: 1;
  readonly retryDelaysMs: readonly number[];
  readonly attempts: readonly SetupAttempt[];
  readonly outcome: SetupAttempt['outcome'];
}

/** The setup's entry open over the app/browser fixtures: navigation is bounded per attempt. */
export interface SetupTarget extends HomeProbe {
  open(url: string, timeoutMs: number): Promise<void>;
}

export interface SetupOpenOptions {
  /** The retry waits; the production default is `SETUP_RETRY_DELAYS_MS`, a test may shrink it. */
  readonly retryDelaysMs?: readonly number[];
  readonly openTimeoutMs?: number;
  readonly homeTimeoutMs?: number;
  /** The file the report reads the attempts back from; nothing is written without it. */
  readonly attemptsFile?: string;
}

export interface SetupOpenResult {
  readonly url: string;
  readonly attempts: readonly SetupAttempt[];
}

/**
 * Opens the entry and waits for home, retrying connection-class failures a
 * bounded number of times. Throws `UAT_APP_UNREACHABLE` when the retries are
 * spent, and the original failure for anything a retry cannot fix.
 */
export async function openEntryForSetup(target: SetupTarget, settings: UatSettings, options: SetupOpenOptions = {}): Promise<SetupOpenResult> {
  const delays = options.retryDelaysMs ?? SETUP_RETRY_DELAYS_MS;
  const openTimeoutMs = options.openTimeoutMs ?? OPEN_TIMEOUT_MS;
  const homeTimeoutMs = options.homeTimeoutMs ?? HOME_TIMEOUT_MS;
  const attempts: SetupAttempt[] = [];
  let last: { status: number | undefined; elapsedMs: number } | undefined;

  for (let index = 0; index <= delays.length; index += 1) {
    const delay = index === 0 ? 0 : delays[index - 1] ?? 0;
    if (delay > 0) await sleep(delay);
    const startedAt = new Date().toISOString();
    const started = Date.now();
    let status: number | undefined;
    try {
      await target.open(settings.entryUrl, openTimeoutMs);
      status = await target.navigationStatus();
      if (isUnreachableStatus(status)) {
        throw appUnreachable(settings, { status, elapsedMs: Date.now() - started });
      }
      const url = await waitForHome(target, settings, { foreignOrigin: 'expired', timeoutMs: homeTimeoutMs });
      attempts.push(attempt(index, startedAt, started, status, 'passed'));
      writeWhenNamed(options.attemptsFile, { schemaVersion: 1, retryDelaysMs: delays, attempts, outcome: 'passed' });
      return { url, attempts };
    } catch (cause) {
      const error = asError(cause);
      const observed = status ?? await observedStatus(target);
      const outcome = classifySetupFailure(error, observed);
      attempts.push(attempt(index, startedAt, started, observed, outcome));
      if (outcome !== 'unreachable') {
        writeWhenNamed(options.attemptsFile, { schemaVersion: 1, retryDelaysMs: delays, attempts, outcome });
        throw error;
      }
      last = { status: observed, elapsedMs: Date.now() - started };
    }
  }

  const schedule = retrySchedule(attempts, delays);
  const failure = appUnreachable(settings, { status: last?.status, elapsedMs: last?.elapsedMs ?? 0, note: schedule });
  writeWhenNamed(options.attemptsFile, { schemaVersion: 1, retryDelaysMs: delays, attempts, outcome: 'unreachable' });
  throw failure;
}

/** Writes the attempts record the report reads; a missing path leaves the run without one. */
export function writeSetupRecord(file: string, record: SetupRecord): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/** Reads back the setup record; an absent or malformed file simply means the report has no retry section. */
export function readSetupRecord(file: string): SetupRecord | undefined {
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  return validateSetupRecord(parsed);
}

/**
 * What a failed attempt was: a gateway/connection failure a retry may fix, a
 * session problem it cannot, or some other failure the setup must not hide.
 */
export function classifySetupFailure(error: Error, status: number | undefined): SetupAttempt['outcome'] {
  if (error.message.includes('UAT_APP_UNREACHABLE')) return 'unreachable';
  if (error.message.includes('UAT_SESSION_EXPIRED')) return 'session-expired';
  return isUnreachableStatus(status) && isConnectionFailure(error) ? 'unreachable' : 'failed';
}

/** The sentence appended to the final failure: how many attempts ran and how far apart. */
export function retrySchedule(attempts: readonly SetupAttempt[], delays: readonly number[]): string {
  const count = `; gave up after ${attempts.length} setup attempt${attempts.length === 1 ? '' : 's'}`;
  const answers = attempts.map(entry => (entry.status === undefined || entry.status === 0 ? 'no response' : `HTTP ${entry.status}`)).join(', ');
  if (delays.length === 0) return `${count} (${answers}) with no retry`;
  const waits = delays.map(delay => `${delay} ms`).join(' and ');
  return `${count} (${answers}), separated by waits of ${waits}`;
}

function attempt(
  index: number,
  startedAt: string,
  started: number,
  status: number | undefined,
  outcome: SetupAttempt['outcome'],
): SetupAttempt {
  return {
    attempt: index + 1,
    startedAt,
    durationMs: Date.now() - started,
    ...(status === undefined ? {} : { status }),
    outcome,
  };
}

/** True when the error or any cause carries a code that names a failed navigation. */
function isConnectionFailure(error: Error): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && CONNECTION_FAILURE_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function observedStatus(target: SetupTarget): Promise<number | undefined> {
  try {
    return await target.navigationStatus();
  } catch {
    return undefined;
  }
}

function writeWhenNamed(file: string | undefined, record: SetupRecord): void {
  if (file !== undefined) writeSetupRecord(file, record);
}

function validateSetupRecord(value: unknown): SetupRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] !== 1) return undefined;
  if (!Array.isArray(record['retryDelaysMs']) || record['retryDelaysMs'].some(delay => typeof delay !== 'number' || delay < 0)) return undefined;
  if (!Array.isArray(record['attempts'])) return undefined;
  const attempts: SetupAttempt[] = [];
  for (const entry of record['attempts']) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const item = entry as Record<string, unknown>;
    if (typeof item['attempt'] !== 'number' || typeof item['startedAt'] !== 'string' || typeof item['durationMs'] !== 'number') return undefined;
    const outcome = item['outcome'];
    if (outcome !== 'passed' && outcome !== 'unreachable' && outcome !== 'session-expired' && outcome !== 'failed') return undefined;
    const status = item['status'];
    if (status !== undefined && typeof status !== 'number') return undefined;
    attempts.push({ attempt: item['attempt'], startedAt: item['startedAt'], durationMs: item['durationMs'], ...(status === undefined ? {} : { status }), outcome });
  }
  const outcome = record['outcome'];
  if (outcome !== 'passed' && outcome !== 'unreachable' && outcome !== 'session-expired' && outcome !== 'failed') return undefined;
  return { schemaVersion: 1, retryDelaysMs: record['retryDelaysMs'] as number[], attempts, outcome };
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
