/**
 * Where this loop keeps everything that must never enter the repository.
 *
 * A run needs private values the project cannot carry: the UAT entry URL, the
 * account ID to query, and the label the writable path adds and removes. They
 * are read from a fixed file outside the checkout (`~/.config/e2e-uat/config.json`,
 * mode 0600) or from the matching environment variables, which override it.
 * The session the login step saves sits beside it, and rendered reports go under
 * the user's state directory. Every error message names the missing value
 * without echoing a value.
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
  /** The label the writable model path adds to and removes from that account. */
  readonly labelId: string | undefined;
  /** The label's visible name as the app renders it; the model instruction names it. */
  readonly labelName: string | undefined;
  /** The trailing part of the home location the setup waits for. */
  readonly homeHash: string;
  /** Where the scanned-in session is persisted. */
  readonly sessionFile: string;
  /** Machine-local browser settings for the private environment, e.g. a proxy bypass. */
  readonly env: Readonly<Record<string, string>>;
  /** Extra Chromium launch args, such as the exact SPKI hashes of an internal CA. */
  readonly chromiumArgs?: readonly string[];
  /** The Chromium binary to launch; default the engine's installed browser. */
  readonly chromeExecutable?: string;
}

export interface LoadUatSettingsOptions {
  /** The fixed scenario needs the account ID; the login step does not. */
  readonly requireAccountId: boolean;
  /** The writable model path needs the label to add and remove; the read-only one does not. */
  readonly requireLabel?: boolean;
}

/** The fixed private-settings file, `UAT_CONFIG_FILE` for a different one. */
export function uatConfigFile(): string {
  return process.env['UAT_CONFIG_FILE'] ?? path.join(homedir(), '.config', 'e2e-uat', 'config.json');
}

/**
 * The private CA file the engine launch trusts, when one is configured.
 * `UAT_CA_CERT` overrides the fixed path; a named file that does not exist is
 * a setup error, while an absent default just means there is no private CA.
 */
export function uatCaCertFile(): string | undefined {
  const configured = process.env['UAT_CA_CERT'];
  if (configured !== undefined && ['none', 'off'].includes(configured.trim().toLowerCase())) return undefined;
  const explicit = configured !== undefined && configured.trim() !== '';
  const file = explicit ? configured.trim() : path.join(homedir(), '.config', 'e2e-uat', 'internal-ca.pem');
  if (existsSync(file)) return file;
  if (explicit) throw new Error(`UAT_CA_CERT_MISSING: ${file} does not exist`);
  return undefined;
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
  const { values: stored, env, chromiumArgs, chromeExecutable } = readStoredSettings(file);
  const entryUrl = value('UAT_ENTRY_URL') ?? stored['entryUrl'];
  if (entryUrl === undefined || entryUrl === '') throw new Error(`UAT_CONFIG_MISSING: set UAT_ENTRY_URL or write entryUrl to ${file}`);
  assertHttpUrl(entryUrl, 'entryUrl');
  const loginUrl = value('UAT_LOGIN_URL') ?? stored['loginUrl'];
  if (loginUrl !== undefined) assertHttpUrl(loginUrl, 'loginUrl');
  const accountId = value('UAT_ACCOUNT_ID') ?? stored['accountId'];
  if (options.requireAccountId && (accountId === undefined || accountId === '')) {
    throw new Error(`UAT_CONFIG_MISSING: set UAT_ACCOUNT_ID or write accountId to ${file}`);
  }
  const labelId = value('UAT_LABEL_ID') ?? stored['labelId'];
  const labelName = value('UAT_LABEL_NAME') ?? stored['labelName'];
  if (options.requireLabel === true && (labelId === undefined || labelId === '' || labelName === undefined || labelName === '')) {
    throw new Error(`UAT_CONFIG_MISSING: set UAT_LABEL_ID and UAT_LABEL_NAME, or write labelId and labelName to ${file}`);
  }
  const homeHash = value('UAT_HOME_HASH') ?? stored['homeHash'] ?? '#/home';
  return {
    entryUrl: normalizeEntry(entryUrl),
    loginUrl: loginUrl === undefined ? undefined : loginUrl,
    accountId: accountId === '' ? undefined : accountId,
    labelId: labelId === '' ? undefined : labelId,
    labelName: labelName === '' ? undefined : labelName,
    homeHash,
    sessionFile: uatSessionFile(stored['sessionFile']),
    env,
    ...(chromiumArgs === undefined ? {} : { chromiumArgs }),
    ...(chromeExecutable === undefined ? {} : { chromeExecutable }),
  };
}

function value(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

interface StoredSettings {
  readonly values: Record<string, string>;
  readonly env: Record<string, string>;
  readonly chromiumArgs?: readonly string[];
  readonly chromeExecutable?: string;
}

function readStoredSettings(file: string): StoredSettings {
  if (!existsSync(file)) return { values: {}, env: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(`UAT_CONFIG_INVALID: ${file} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`, { cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`UAT_CONFIG_INVALID: ${file} must hold a JSON object`);
  const stored: Record<string, string> = {};
  for (const key of ['entryUrl', 'loginUrl', 'accountId', 'labelId', 'labelName', 'homeHash', 'sessionFile'] as const) {
    const candidate = (parsed as Record<string, unknown>)[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'string') throw new Error(`UAT_CONFIG_INVALID: ${file} field "${key}" must be a string`);
    stored[key] = candidate;
  }
  const chromiumArgs = chromiumArguments(file, (parsed as Record<string, unknown>)['chromiumArgs']);
  const chromeExecutable = optionalString(file, 'chromeExecutable', (parsed as Record<string, unknown>)['chromeExecutable']);
  const environment: Record<string, string> = {};
  const env = (parsed as Record<string, unknown>)['env'];
  if (env !== undefined) {
    if (env === null || typeof env !== 'object' || Array.isArray(env)) throw new Error(`UAT_CONFIG_INVALID: ${file} field "env" must be an object of strings`);
    for (const [key, entry] of Object.entries(env)) {
      if (typeof entry !== 'string') throw new Error(`UAT_CONFIG_INVALID: ${file} field "env.${key}" must be a string`);
      environment[key] = entry;
    }
  }
  return { values: stored, env: environment, ...(chromiumArgs === undefined ? {} : { chromiumArgs }), ...(chromeExecutable === undefined ? {} : { chromeExecutable }) };
}

function chromiumArguments(file: string, candidate: unknown): readonly string[] | undefined {
  if (candidate === undefined) return undefined;
  if (!Array.isArray(candidate) || candidate.some(entry => typeof entry !== 'string' || entry === '')) {
    throw new Error(`UAT_CONFIG_INVALID: ${file} field "chromiumArgs" must be an array of nonempty strings`);
  }
  return candidate as string[];
}

function optionalString(file: string, key: string, candidate: unknown): string | undefined {
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'string' || candidate === '') throw new Error(`UAT_CONFIG_INVALID: ${file} field "${key}" must be a nonempty string`);
  return candidate;
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

/** A URL a browser navigates to; a target URL refuses a fragment, so the SPA route stays a runtime location. */
function normalizeEntry(candidate: string): string {
  const url = new URL(candidate);
  if (url.pathname === '') url.pathname = '/';
  url.hash = '';
  return url.toString();
}

/** The origin the app lives on, which a login redirect leaves. */
export function entryOrigin(settings: UatSettings): string {
  return new URL(settings.entryUrl).origin;
}
