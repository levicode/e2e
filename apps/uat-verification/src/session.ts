/**
 * The reusable UAT login state.
 *
 * The first run scans a QR code once on a headed browser and saves every cookie
 * that browser holds plus the app origin's `localStorage`; later runs restore
 * both and verify the app still answers as a signed-in user. The file lives
 * outside the checkout, in a 0700 directory with 0600 permissions, because the
 * values are live credentials — it is never committed, printed, or attached to
 * a report. A missing, unreadable, foreign-origin, or fully expired file fails
 * with `UAT_SESSION_EXPIRED` and the exact re-login command, never a silent
 * redirect to the login page.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Cookie } from '@e2e-dev/web';
import { entryOrigin, type UatSettings } from './settings.ts';

const SESSION_VERSION = 1;
const MAX_COOKIES = 512;
const MAX_STORAGE_ENTRIES = 256;
const MAX_VALUE_LENGTH = 16_384;

/** A cookie as the browser reported it: a domain-scoped cookie, never a URL one. */
export interface StoredCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires?: number;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
}

/** One saved login state, tied to the origin it was captured on. */
export interface UatSession {
  readonly version: 1;
  readonly savedAt: string;
  readonly entryOrigin: string;
  readonly cookies: readonly StoredCookie[];
  readonly localStorage: Readonly<Record<string, string>>;
}

/** Reads the saved session, failing with the re-login instructions when it is unusable. */
export function readUatSession(settings: UatSettings): UatSession {
  return readSessionFile(settings, settings.sessionFile);
}

/** Reads one session file, failing with the re-login instructions when it is unusable. */
export function readSessionFile(settings: UatSettings, file: string): UatSession {
  if (!existsSync(file)) throw sessionExpired(settings, `no saved session exists at ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw sessionExpired(settings, `${file} is not readable JSON (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  const session = validateSession(parsed);
  if (session === undefined) throw sessionExpired(settings, `${file} is not a saved UAT session`);
  if (session.entryOrigin !== entryOrigin(settings)) {
    throw sessionExpired(settings, `${file} was saved for a different app origin`);
  }
  if (liveCookies(session.cookies).length === 0) throw sessionExpired(settings, `${file} holds no live cookie`);
  return session;
}

/** Saves a login state, creating its directory 0700 and the file 0600. */
export function writeSessionFile(file: string, session: UatSession): void {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** The cookies a run can restore: malformed entries and past-expiry cookies are left out. */
export function liveCookies(cookies: readonly StoredCookie[]): Cookie[] {
  const now = Math.floor(Date.now() / 1000);
  return cookies
    .filter(cookie => cookie.name !== '' && cookie.value !== '' && cookie.domain !== '')
    .filter(cookie => cookie.expires === undefined || cookie.expires <= 0 || cookie.expires > now)
    .map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      ...(cookie.expires === undefined || cookie.expires <= 0 ? {} : { expires: cookie.expires }),
      ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
      ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
      ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
    }));
}

/** Keeps the browser-reported cookies that can be restored later; url-form cookies carry no domain to restore by. */
export function toStoredCookies(cookies: readonly Cookie[]): StoredCookie[] {
  const stored: StoredCookie[] = [];
  for (const cookie of cookies) {
    if (cookie.domain === undefined || cookie.domain === '' || cookie.value === '') continue;
    stored.push({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path ?? '/',
      ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
      ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
      ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
      ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
    });
  }
  return stored;
}

/** The init-script argument that writes a saved origin's `localStorage` before the app runs. */
export function localStorageRestore(settings: UatSettings, session: UatSession): { origin: string; entries: Readonly<Record<string, string>> } | undefined {
  const entries = session.localStorage;
  return Object.keys(entries).length === 0 ? undefined : { origin: entryOrigin(settings), entries };
}

/** The message a missing or expired session reports, naming the command that fixes it. */
export function sessionExpired(settings: UatSettings, reason: string): Error {
  return new Error(
    `UAT_SESSION_EXPIRED: ${reason}. Sign in again: pnpm --filter @e2e-dev/uat-verification login — the headed browser shows the QR code; scan it once, then re-run verify.`,
  );
}

function validateSession(value: unknown): UatSession | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record['version'] !== SESSION_VERSION) return undefined;
  if (typeof record['savedAt'] !== 'string' || typeof record['entryOrigin'] !== 'string') return undefined;
  const cookies = validateCookies(record['cookies']);
  const localStorage = validateStorage(record['localStorage']);
  if (cookies === undefined || localStorage === undefined) return undefined;
  return { version: 1, savedAt: record['savedAt'], entryOrigin: record['entryOrigin'], cookies, localStorage };
}

function validateCookies(value: unknown): StoredCookie[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_COOKIES) return undefined;
  const cookies: StoredCookie[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const name = bounded(record['name']);
    const cookieValue = bounded(record['value'], true);
    const domain = bounded(record['domain']);
    const cookiePath = bounded(record['path']);
    if (name === undefined || cookieValue === undefined || domain === undefined || cookiePath === undefined) continue;
    const expires = record['expires'];
    const sameSite = record['sameSite'];
    cookies.push({
      name,
      value: cookieValue,
      domain,
      path: cookiePath,
      ...(typeof expires === 'number' && Number.isFinite(expires) ? { expires } : {}),
      ...(typeof record['httpOnly'] === 'boolean' ? { httpOnly: record['httpOnly'] } : {}),
      ...(typeof record['secure'] === 'boolean' ? { secure: record['secure'] } : {}),
      ...(sameSite === 'Strict' || sameSite === 'Lax' || sameSite === 'None' ? { sameSite } : {}),
    });
  }
  return cookies;
}

function validateStorage(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_STORAGE_ENTRIES) return undefined;
  const storage: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > MAX_VALUE_LENGTH || typeof entry !== 'string' || entry.length > MAX_VALUE_LENGTH) continue;
    storage[key] = entry;
  }
  return storage;
}

function bounded(value: unknown, allowEmpty = false): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) return undefined;
  return allowEmpty || value !== '' ? value : undefined;
}
