/**
 * Where this loop keeps everything that must never enter the repository.
 *
 * A run needs two private values the project cannot carry: the UAT entry URL
 * and the account ID to query. Both are read from a fixed file outside the
 * checkout (`~/.config/e2e-uat/config.json`, mode 0600) or from the matching
 * environment variables, which override it. The session the login step saves
 * sits beside it, and rendered reports go under the user's state directory.
 * Every error message names the missing value without echoing a value.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** One private UAT setting, with defaults that do not name a real host. */
export interface UatSettings {
  /** The app entry the scenario opens, e.g. `http://<uat-host>/<app>/`. */
  readonly entryUrl: string;
  /** The SSO login page that shows the QR code; required by the login step only. */
  readonly loginUrl: string | undefined;
  /** The read-only account ID the fixed scenario queries. */
  readonly accountId: string | undefined;
  /** The trailing part of the home location the setup waits for. */
  readonly homeHash: string;
  /** Where the scanned-in session is persisted. */
  readonly sessionFile: string;
}

export interface LoadUatSettingsOptions {
  /** The fixed scenario needs the account ID; the login step does not. */
  readonly requireAccountId: boolean;
}

/** The fixed private-settings file, `UAT_CONFIG_FILE` for a different one. */
export function uatConfigFile(): string {
  return process.env['UAT_CONFIG_FILE'] ?? path.join(homedir(), '.config', 'e2e-uat', 'config.json');
}

/** The fixed directory rendered reports go to, outside the checkout. */
export function uatReportsDirectory(): string {
  return process.env['UAT_REPORTS_DIR'] ?? path.join(homedir(), '.local', 'state', 'e2e-uat', 'reports');
}

/** The default session path, `UAT_SESSION_FILE` for a different one. */
function uatSessionFile(file: string | undefined): string {
  return process.env['UAT_SESSION_FILE'] ?? file ?? path.join(homedir(), '.config', 'e2e-uat', 'session.json');
}

/** Reads and validates the private UAT settings, or fails naming what is missing. */
export function loadUatSettings(options: LoadUatSettingsOptions = { requireAccountId: false }): UatSettings {
  const file = uatConfigFile();
  const stored = readStoredSettings(file);
  const entryUrl = value('UAT_ENTRY_URL') ?? stored['entryUrl'];
  if (entryUrl === undefined || entryUrl === '') throw new Error(`UAT_CONFIG_MISSING: set UAT_ENTRY_URL or write entryUrl to ${file}`);
  assertHttpUrl(entryUrl, 'entryUrl');
  const loginUrl = value('UAT_LOGIN_URL') ?? stored['loginUrl'];
  if (loginUrl !== undefined) assertHttpUrl(loginUrl, 'loginUrl');
  const accountId = value('UAT_ACCOUNT_ID') ?? stored['accountId'];
  if (options.requireAccountId && (accountId === undefined || accountId === '')) {
    throw new Error(`UAT_CONFIG_MISSING: set UAT_ACCOUNT_ID or write accountId to ${file}`);
  }
  const homeHash = value('UAT_HOME_HASH') ?? stored['homeHash'] ?? '#/home';
  return {
    entryUrl: normalizeEntry(entryUrl),
    loginUrl: loginUrl === undefined ? undefined : loginUrl,
    accountId: accountId === '' ? undefined : accountId,
    homeHash,
    sessionFile: uatSessionFile(stored['sessionFile']),
  };
}

function value(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

function readStoredSettings(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(`UAT_CONFIG_INVALID: ${file} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`, { cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`UAT_CONFIG_INVALID: ${file} must hold a JSON object`);
  const stored: Record<string, string> = {};
  for (const key of ['entryUrl', 'loginUrl', 'accountId', 'homeHash', 'sessionFile'] as const) {
    const candidate = (parsed as Record<string, unknown>)[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'string') throw new Error(`UAT_CONFIG_INVALID: ${file} field "${key}" must be a string`);
    stored[key] = candidate;
  }
  return stored;
}

function assertHttpUrl(candidate: string, name: string): void {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`UAT_CONFIG_INVALID: ${name} is not an absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`UAT_CONFIG_INVALID: ${name} must be http or https`);
}

/** A URL a browser navigates to; the fragment belongs to the app, not the URL rule. */
function normalizeEntry(candidate: string): string {
  const url = new URL(candidate);
  if (url.pathname === '') url.pathname = '/';
  return url.toString();
}

/** The origin the app lives on, which a login redirect leaves. */
export function entryOrigin(settings: UatSettings): string {
  return new URL(settings.entryUrl).origin;
}
