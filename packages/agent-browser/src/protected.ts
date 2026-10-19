/** Protected preview credentials and browser-wide settings, installed before document scripts run. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ConfigurationError, EngineError, isSecret, rejectUnknownKeys, sameSite,
  type OperationContext, type ResolveSecretOptions, type Secret,
} from 'e2e/engine';
import type { CdpConnection } from './cdp.ts';

export interface BasicAuth {
  readonly username: string;
  readonly password: string | Secret;
  /** Defaults to the configured app site. any-origin explicitly restores the old engine's broader policy. */
  readonly scope?: 'app-site' | 'any-origin';
}
export type InitScript = string | { readonly path: string } | (() => unknown);
export interface ProtectedOptions {
  readonly headers?: Readonly<Record<string, string | Secret>>;
  readonly basicAuth?: BasicAuth;
  readonly userAgent?: string;
  readonly locale?: string;
  readonly timezoneId?: string;
  readonly initScripts?: readonly InitScript[];
  readonly colorScheme?: 'light' | 'dark' | 'no-preference';
  readonly reducedMotion?: 'reduce' | 'no-preference';
}
export interface AuthChallenge {
  readonly source: string;
  readonly origin: string;
  readonly scheme: string;
  readonly realm: string;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// oxlint-disable-next-line no-control-regex -- HTTP field injection is precisely what this rejects.
const FIELD_CONTROL = /[\u0000-\u0008\u000A-\u001F\u007F]/;

/** Config errors never repeat names, values, credentials, or JavaScript source. */
function invalid(message: string): never { throw new ConfigurationError('INVALID_CONFIG', message); }

/** A plain option bag excludes arrays, inherited fields, and class instances. */
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Validate before launch; dynamic Secret header values are checked again after resolution. */
export function validateProtectedOptions(options: ProtectedOptions): void {
  if (options.headers !== undefined) {
    if (!plain(options.headers)) invalid('agentBrowser headers must be a plain object');
    const names = new Set<string>();
    for (const [name, value] of Object.entries(options.headers)) {
      if (!HEADER_NAME.test(name)) invalid('agentBrowser headers contain an invalid field name');
      if (names.has(name.toLowerCase())) invalid('agentBrowser headers contain duplicate case-insensitive names');
      names.add(name.toLowerCase());
      if (typeof value !== 'string' && !isSecret(value)) invalid('agentBrowser header values must be strings or declared secrets');
      if (typeof value === 'string' && FIELD_CONTROL.test(value)) invalid('agentBrowser headers contain an invalid control character');
    }
  }
  if (options.basicAuth !== undefined) {
    if (!plain(options.basicAuth)) invalid('agentBrowser basicAuth must be an object');
    rejectUnknownKeys('agentBrowser basicAuth', options.basicAuth, ['username', 'password', 'scope']);
    const { username, password, scope } = options.basicAuth;
    if (typeof username !== 'string' || username === '' || username.includes(':') || FIELD_CONTROL.test(username)) invalid('agentBrowser basicAuth requires a nonempty username without colon or control characters');
    if (typeof password !== 'string' && !isSecret(password)) invalid('agentBrowser basicAuth requires a password string or declared secret');
    if (scope !== undefined && scope !== 'app-site' && scope !== 'any-origin') invalid('agentBrowser basicAuth scope must be app-site or any-origin');
  }
  if (options.userAgent !== undefined) {
    if (typeof options.userAgent !== 'string' || options.userAgent === '' || FIELD_CONTROL.test(options.userAgent)) invalid('agentBrowser userAgent must be a nonempty HTTP field value');
    if (Object.keys(options.headers ?? {}).some((name) => name.toLowerCase() === 'user-agent')) invalid('agentBrowser userAgent conflicts with a configured User-Agent header');
  }
  if (options.locale !== undefined) {
    try {
      if (typeof options.locale !== 'string' || options.locale === '') invalid('agentBrowser locale must be a concrete BCP 47 language tag');
      const language = new Intl.Locale(options.locale).language;
      if (language === undefined || language === 'und') invalid('agentBrowser locale must be a concrete BCP 47 language tag');
    } catch { invalid('agentBrowser locale must be a concrete BCP 47 language tag'); }
    if (Object.keys(options.headers ?? {}).some((name) => name.toLowerCase() === 'accept-language')) invalid('agentBrowser locale conflicts with a configured Accept-Language header');
  }
  if (options.timezoneId !== undefined) {
    try {
      if (typeof options.timezoneId !== 'string' || options.timezoneId === '' || /^[+-]/.test(options.timezoneId)) invalid('agentBrowser timezoneId must be an IANA time zone');
      const resolved = new Intl.DateTimeFormat('en-US', { timeZone: options.timezoneId }).resolvedOptions().timeZone;
      if (resolved !== options.timezoneId && resolved.toLowerCase() === options.timezoneId.toLowerCase()) invalid('agentBrowser timezoneId has unsupported casing');
    } catch { invalid('agentBrowser timezoneId must be an IANA time zone'); }
  }
  if (options.colorScheme !== undefined && !['light', 'dark', 'no-preference'].includes(options.colorScheme)) invalid('agentBrowser colorScheme is invalid');
  if (options.reducedMotion !== undefined && !['reduce', 'no-preference'].includes(options.reducedMotion)) invalid('agentBrowser reducedMotion is invalid');
  if (options.initScripts !== undefined) {
    if (!Array.isArray(options.initScripts)) invalid('agentBrowser initScripts must be an array');
    for (const script of options.initScripts) {
      if (typeof script === 'string' || typeof script === 'function') continue;
      if (!plain(script) || Object.keys(script).length !== 1 || typeof script.path !== 'string' || script.path === '') invalid('agentBrowser initScripts entries must be source, functions, or { path }');
    }
  }
}

/** Manifest declarations let the runner authorize every Secret before an attempt resolves it. */
export function protectedSecrets(options: ProtectedOptions): readonly Secret[] {
  const candidates: unknown[] = [...Object.values(options.headers ?? {}), options.basicAuth?.password];
  return [...new Set(candidates.filter(isSecret))];
}

/** Every encoded representation a Basic challenge can expose must join the secret ledger. */
function derivedBasic(username: string, password: string): readonly string[] {
  const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  const unpadded = encoded.replace(/={1,2}$/, '');
  return [...new Set([encoded, unpadded, `Basic ${encoded}`, `Basic ${unpadded}`])];
}

/** A function serialized as an expression, including ordinary/async method shorthand. */
function sourceOf(fn: () => unknown): string {
  const source = fn.toString().trim();
  for (const candidate of [source, `function ${source}`, ...(source.startsWith('async ') ? [`async function ${source.slice(6)}`] : [])]) {
    try { const parsed = new Function(`return (${candidate}\n);`); void parsed; return candidate; } catch { /* Try shorthand. */ }
  }
  return invalid('agentBrowser init-script function cannot be serialized');
}

/** Resolve configured files under projectRoot and never expose a failed path or its contents. */
async function scriptSource(script: InitScript, projectRoot: string): Promise<string> {
  if (typeof script === 'string') return script;
  if (typeof script === 'function') return `(() => { const __name = (target, value) => Object.defineProperty(target, 'name', { value, configurable: true }); (${sourceOf(script)}\n)(); })();`;
  try { return await readFile(path.resolve(projectRoot, script.path), 'utf8'); }
  catch { return invalid('An agentBrowser init-script file could not be read'); }
}

/** Per-attempt values stay memory-only and are never copied into CLI flags or session files. */
export class ProtectedContext {
  readonly configuredHeaderNames: readonly string[];
  private readonly options: ProtectedOptions;
  private readonly site: string | undefined;
  private headers: Readonly<Record<string, string>> = Object.freeze({});
  private auth: Readonly<{ username: string; password: string }> | undefined;
  private sources: readonly string[] = [];
  private prepared = false;

  constructor(options: ProtectedOptions, site?: string) {
    validateProtectedOptions(options);
    if (site === undefined && Object.keys(options.headers ?? {}).length > 0) invalid('agentBrowser protected headers require an app site');
    if (site === undefined && options.basicAuth !== undefined && options.basicAuth.scope !== 'any-origin') invalid('agentBrowser basicAuth requires an app site unless any-origin scope is explicit');
    this.site = site;
    this.options = {
      ...options,
      ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
      ...(options.basicAuth === undefined ? {} : { basicAuth: { ...options.basicAuth } }),
      ...(options.initScripts === undefined ? {} : { initScripts: options.initScripts.map((script) => typeof script === 'object' ? { ...script } : script) }),
    };
    this.configuredHeaderNames = Object.freeze(Object.keys(options.headers ?? {}).map((name) => name.toLowerCase()));
  }

  /** Resolve declared secrets once, registering Basic-derived strings before any network request. */
  async prepare(projectRoot: string, resolveSecret: (secret: Secret, options?: ResolveSecretOptions) => Promise<string>): Promise<void> {
    const headers: Record<string, string> = Object.create(null);
    for (const [name, configured] of Object.entries(this.options.headers ?? {})) {
      const value = typeof configured === 'string' ? configured : await resolveSecret(configured);
      if (typeof value !== 'string' || FIELD_CONTROL.test(value)) invalid('A resolved agentBrowser header contains an invalid HTTP field value');
      headers[name.toLowerCase()] = value;
    }
    const configured = this.options.basicAuth;
    if (configured !== undefined) {
      const password = typeof configured.password === 'string' ? configured.password
        : await resolveSecret(configured.password, { derived: (value) => derivedBasic(configured.username, value) });
      if (typeof password !== 'string') invalid('The resolved agentBrowser password must be a string');
      this.auth = Object.freeze({ username: configured.username, password });
    }
    this.sources = await Promise.all((this.options.initScripts ?? []).map((script) => scriptSource(script, projectRoot)));
    this.headers = Object.freeze(headers);
    this.prepared = true;
  }

  /** Header protection follows the public app-site rule, including subdomains and subresources. */
  siteHeaders(url: string): Readonly<Record<string, string>> | undefined {
    this.requirePrepared();
    if (this.site === undefined || this.configuredHeaderNames.length === 0 || !this.httpUrl(url) || !sameSite(url, this.site)) return undefined;
    return this.headers;
  }

  /** A credential-free predicate lets interception remove cached Authorization on off-scope requests. */
  credentialAllowed(url: string): boolean {
    if (!this.prepared || this.auth === undefined || !this.httpUrl(url)) return false;
    return this.options.basicAuth?.scope === 'any-origin' || (this.site !== undefined && sameSite(url, this.site));
  }

  /** Pre-resolved lookup; the network companion separately validates the actual challenge. */
  authorization(url: string): Readonly<{ username: string; password: string }> | undefined {
    this.requirePrepared();
    return this.credentialAllowed(url) ? this.auth : undefined;
  }

  /** Answer only server Basic challenges at the request's actual origin, never proxy challenges. */
  credentials(url: string, challenge: AuthChallenge): Readonly<{ username: string; password: string }> | undefined {
    this.requirePrepared();
    if (!this.credentialAllowed(url) || challenge.source.toLowerCase() !== 'server' || challenge.scheme.toLowerCase() !== 'basic') return undefined;
    try { if (new URL(challenge.origin).origin !== new URL(url).origin) return undefined; } catch { return undefined; }
    return this.auth;
  }

  /** Install language, time zone, media, and configured scripts before the hub resumes a renderer. */
  async configureSession(connection: CdpConnection, sessionId: string, operation: OperationContext): Promise<void> {
    this.requirePrepared();
    const endsAt = Date.now() + operation.timeoutMs;
    const budget = () => ({ ...operation, timeoutMs: Math.max(0, endsAt - Date.now()) });
    const send = (method: string, params: Record<string, unknown>) => connection.send(method, params, budget(), sessionId);
    if (this.options.userAgent !== undefined || this.options.locale !== undefined) {
      const userAgent = this.options.userAgent ?? (await connection.send<{ userAgent: string }>('Browser.getVersion', {}, budget())).userAgent;
      if (typeof userAgent !== 'string' || userAgent === '') throw new EngineError('ENGINE_FAILURE', 'Chromium did not provide a default user agent', { retryable: false });
      await send('Network.setUserAgentOverride', { userAgent, ...(this.options.locale === undefined ? {} : { acceptLanguage: this.options.locale }) });
    }
    if (this.options.locale !== undefined) await send('Emulation.setLocaleOverride', { locale: this.options.locale });
    if (this.options.timezoneId !== undefined) await send('Emulation.setTimezoneOverride', { timezoneId: this.options.timezoneId });
    const features = [
      ...(this.options.colorScheme === undefined ? [] : [{ name: 'prefers-color-scheme', value: this.options.colorScheme }]),
      ...(this.options.reducedMotion === undefined ? [] : [{ name: 'prefers-reduced-motion', value: this.options.reducedMotion }]),
    ];
    if (features.length > 0) await send('Emulation.setEmulatedMedia', { features });
    if (this.sources.length > 0) {
      await send('Page.enable', {});
      for (const source of this.sources) await send('Page.addScriptToEvaluateOnNewDocument', { source });
    }
  }

  /** A missing prepare is an integration error, never silent loss of protected settings. */
  private requirePrepared(): void {
    if (!this.prepared) throw new EngineError('INVALID_STATE', 'Protected browser configuration has not been prepared', { retryable: false });
  }

  /** Network-only scope excludes about:, data:, file:, and malformed destinations. */
  private httpUrl(value: string): boolean {
    try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
  }
}
