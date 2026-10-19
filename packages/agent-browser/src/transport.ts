/** The pinned public CLI is the only agent-browser protocol this adapter uses. */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { EngineError, type EngineErrorCode, type OperationContext } from 'e2e/engine';

/** The reviewed CLI build enforces exact node identity and immutable attachment scope. */
export const AGENT_BROWSER_VERSION = '0.39.1-e2e.4';
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const PRE_DISPATCH_REF_COMMANDS = new Set(['click', 'dblclick', 'fill', 'type', 'focus', 'hover', 'check', 'uncheck', 'select', 'upload']);
// The public CLI applies Darwin's sun_path[104] limit on every Unix platform.
// Include its stream metadata and longer sidecars, not just the main socket.
const MAX_SOCKET_PATH_BYTES = 103;
const SESSION_SUFFIXES = ['.sock', '.stream', '.pid', '.version', '.config', '.port', '.trust.json', '.target', '.log', '.engine', '.provider', '.extensions'];

function pathsFit(directory: string, session: string): boolean {
  return process.platform === 'win32' || SESSION_SUFFIXES.every(suffix =>
    Buffer.byteLength(join(directory, `${session}${suffix}`), 'utf8') <= MAX_SOCKET_PATH_BYTES);
}

/** Resolve aliases (notably Darwin /tmp) and reject replaceable ancestry. */
function temporaryRoot(candidate: string): string {
  if (!isAbsolute(candidate)) throw new Error('Invalid temporary root');
  const root = realpathSync(candidate);
  if (process.platform === 'win32') return root;
  const uid = process.geteuid?.();
  if (uid === undefined) throw new Error('Cannot verify temporary root ownership');
  for (let path = root; ; path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== uid)
      || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) {
      throw new Error('Unsafe temporary root');
    }
    if (dirname(path) === path) return root;
  }
}

/** Each fallback is another independently owned directory, never a shared session. */
function sessionDirectory(session: string): string {
  const candidates = process.platform === 'win32' ? [tmpdir()] : [tmpdir(), '/tmp'];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    let directory: string | undefined;
    try {
      const root = temporaryRoot(candidate);
      if (seen.has(root)) continue;
      seen.add(root);
      // mkdtemp appends six random characters. Check before creation and again
      // on the actual path, so neither UTF-16 length nor an alias can hide bytes.
      if (!pathsFit(join(root, 'e2e-ab-XXXXXX'), session)) continue;
      directory = mkdtempSync(join(root, 'e2e-ab-'));
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || realpathSync(directory) !== directory || !pathsFit(directory, session)
        || (process.platform !== 'win32' && (stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700))) {
        throw new Error('Unsafe session directory');
      }
      writeFileSync(join(directory, 'config.json'), '{}', { mode: 0o600, flag: 'wx' });
      return directory;
    } catch {
      if (directory !== undefined) {
        try { rmSync(directory, { recursive: true, force: true }); } catch {
          throw failure('ENGINE_FAILURE', 'Could not remove incomplete isolated agent-browser configuration');
        }
      }
    }
  }
  throw failure('ENGINE_FAILURE', 'Could not create a private agent-browser session directory with safe socket paths');
}

/** CLI launch settings; executablePath is Chromium, executable is the CLI. */
export interface CliTransportOptions {
  readonly executable?: string;
  readonly executablePath?: string;
  readonly browser?: 'chrome' | 'chromium';
  readonly cdp?: string;
  /** Pin initial attachment to an exact target in the required browser context. */
  readonly cdpTarget?: string;
  /** An opaque context ID, or null for the browser's default context. */
  readonly cdpContext?: string | null;
  readonly headed?: boolean;
  /** A readable prefix, never an existing session to attach to. */
  readonly session?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface Reservation {
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly release: () => void;
}

/** No foreign output, argv, executable path, or AbortSignal reason enters errors. */
function failure(code: EngineErrorCode, message: string): EngineError {
  return new EngineError(code, message, { retryable: false });
}

/** Only reviewed, closed pre-input codes can leave a session usable after failure. */
function preDispatchError(value: unknown): EngineError | undefined {
  if (typeof value !== 'object' || value === null || !('success' in value) || value.success !== false
    || !('code' in value)) return undefined;
  const data = 'data' in value ? value.data : 'result' in value ? value.result : undefined;
  if (typeof data !== 'object' || data === null || !('dispatched' in data) || data.dispatched !== false) return undefined;
  switch (value.code) {
    case 'node_stale': return new EngineError('NODE_STALE', 'The observed node detached before input was dispatched', { retryable: true });
    case 'not_actionable': return failure('NOT_ACTIONABLE', 'The target cannot accept this action; no input was dispatched');
    case 'unsupported_capability': return failure('UNSUPPORTED_CAPABILITY', 'This action is unsupported for the target; no input was dispatched');
    default: return undefined;
  }
}

/** Nonzero CLI exits can still carry a validated pre-input error envelope. */
function preDispatchResponse(output: string): EngineError | undefined {
  let value: unknown;
  try { value = JSON.parse(output); } catch { return undefined; }
  if (!Array.isArray(value)) return preDispatchError(value);
  if (!value.every((entry: unknown) => preDispatchError(entry) !== undefined
    || (typeof entry === 'object' && entry !== null && 'success' in entry && entry.success === true && 'result' in entry))) return undefined;
  return value.map(preDispatchError).find((error) => error !== undefined);
}

/** Prefer the installed package's public bin, without invoking npx or a shell. */
function installedExecutable(): string {
  try {
    return createRequire(import.meta.url).resolve('agent-browser/bin/agent-browser.js');
  } catch {
    return 'agent-browser';
  }
}

/** Global flags are dangerous as values before the reviewed build's literal-data marker. */
const GLOBAL_FLAGS = new Set([
  '--help', '-h', '--version', '-V', '--json', '--headed', '--webgpu', '--no-webmcp',
  '--debug', '--ignore-https-errors', '--allow-file-access', '--hide-scrollbars',
  '--auto-connect', '--pin-tab', '--no-pin-tab', '--no-ca-cert', '--use-system-ca',
  '--annotate', '--content-boundaries', '--confirm-interactive', '--no-auto-dialog',
  '-v', '--verbose', '-q', '--quiet', '--offline', '--quick', '--fix', '--session',
  '--restore', '--restore-save', '--restore-check-url', '--restore-check-text',
  '--restore-check-fn', '--namespace', '--headers', '--executable-path', '--cdp', '--cdp-target', '--cdp-context',
  '--extension', '--init-script', '--enable', '--profile', '--state', '--proxy',
  '--proxy-bypass', '--args', '--user-agent', '-p', '--provider', '--device',
  '--session-name', '--color-scheme', '--download-path', '--max-output',
  '--allowed-domains', '--action-policy', '--confirm-actions', '--config', '--engine',
  '--input-mode', '--screenshot-dir', '--screenshot-quality', '--screenshot-format',
  '--idle-timeout', '--ca-cert', '--model',
]);

/** Only reviewed command-parser branches implement literal tail arguments. */
function literalShape(args: readonly string[], marker: number): boolean {
  switch (args[0]) {
    case 'fill': return marker === 2 && args.length === 4;
    case 'eval': return marker === 1 && args.length === 3;
    case 'keyboard': return marker === 2 && args.length === 4 && ['type', 'inserttext', 'insertText'].includes(args[1] ?? '');
    case 'select': return marker === 3 && args.length >= 5 && ['--value', '--label', '--index'].includes(args[2] ?? '');
    case 'type': {
      if (marker < 2 || args.length !== marker + 2) return false;
      const seen = new Set<string>();
      for (let index = 2; index < marker; index++) {
        const flag = args[index]!;
        if (seen.has(flag)) return false;
        seen.add(flag);
        if (flag === '--clear') continue;
        if (flag === '--delay' && index + 1 < marker && /^\d+$/.test(args[index + 1]!)) { index++; continue; }
        return false;
      }
      return true;
    }
    default: return false;
  }
}

/** Refuse parser ambiguities instead of letting a value change session or policy. */
function validateArguments(args: readonly string[]): void {
  if (args.length === 0 || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw failure('INVALID_STATE', 'agent-browser requires valid command arguments');
  }
  const marker = args.indexOf('--');
  if (marker !== -1 && !literalShape(args, marker)) {
    throw failure('UNSUPPORTED_CAPABILITY', 'This command does not support a literal-data marker in this position');
  }
  if ((marker === -1 ? args : args.slice(0, marker)).some((arg) => GLOBAL_FLAGS.has(arg.split('=', 1)[0] ?? ''))) {
    throw failure('UNSUPPORTED_CAPABILITY', 'agent-browser cannot safely pass a value that its CLI interprets as a global option');
  }
  if (['close', 'quit', 'exit', 'session', 'install', 'connect', 'mcp', 'chat', 'dashboard'].includes(args[0] ?? '')) {
    throw failure('UNSUPPORTED_CAPABILITY', 'This command is outside the isolated agent-browser session transport');
  }
  if (args[0] === 'batch' && args.slice(1).some((arg) => arg !== '--bail' && !/^(?:get|is|snapshot)(?:\s|$)/.test(arg))) {
    throw failure('UNSUPPORTED_CAPABILITY', 'Only observation commands may be batched by the agent-browser transport');
  }
}

/** Scope IDs are opaque; never reinterpret whitespace or a flag as an identifier. */
function scopeValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\s\p{Cc}]/u.test(value) && !value.startsWith('--');
}

function scopeFlags(options: CliTransportOptions): readonly string[] {
  if (options.cdpTarget === undefined && options.cdpContext === undefined) return [];
  if (!scopeValue(options.cdp) || !scopeValue(options.cdpTarget)
    || (options.cdpContext !== null && (!scopeValue(options.cdpContext) || options.cdpContext === 'default'))) {
    throw failure('INVALID_STATE', 'CDP scope requires an endpoint, an exact target, and a context ID or explicit null default context');
  }
  return ['--cdp-target', options.cdpTarget, '--cdp-context', options.cdpContext ?? 'default'];
}

/** Bound an entire operation, including its first version check, by one budget. */
function remaining(context: OperationContext, startedAt: number, signal = context.signal): OperationContext {
  return { ...context, signal, timeoutMs: context.timeoutMs - (performance.now() - startedAt) };
}

/** Stop only the CLI process group. Its separately spawned daemon is not cancelled. */
function stopClient(child: ChildProcess): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    // An exited client is already stopped. This never certifies daemon cleanup.
  }
}

/**
 * Each instance owns a unique CLI session and socket directory. Commands are
 * never queued: a wait occupying the daemon cannot deadlock an action behind a
 * JavaScript mutex. Callers implement waits as short reads with polling.
 */
export class CliTransport {
  readonly session: string;
  private readonly executable: string;
  private readonly directory: string;
  private readonly flags: readonly string[];
  private readonly scoped: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private reservation: Reservation | undefined;
  private verified = false;
  private sessionStarted = false;
  private uncertain = false;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(options: CliTransportOptions = {}) {
    if (options.browser !== undefined && options.browser !== 'chrome' && options.browser !== 'chromium') {
      throw failure('UNSUPPORTED_CAPABILITY', 'The agent-browser engine supports Chromium only');
    }
    const scope = scopeFlags(options);
    this.scoped = scope.length !== 0;
    this.session = `${(options.session ?? 'e2e').replaceAll(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24)}-${randomUUID()}`;
    this.executable = options.executable ?? installedExecutable();
    this.directory = sessionDirectory(this.session);
    this.flags = [
      '--config', join(this.directory, 'config.json'), '--session', this.session,
      '--json', '--engine', 'chrome', '--no-webmcp', '--no-auto-dialog', '--input-mode', 'instant',
      ...(options.executablePath === undefined ? [] : ['--executable-path', options.executablePath]),
      ...(options.cdp === undefined ? [] : ['--cdp', options.cdp]),
      ...scope,
      ...(options.headed === true ? ['--headed'] : []),
    ];
    // Ambient connection/profile/restore/plugin settings can escape the attempt.
    this.env = Object.fromEntries(Object.entries(options.env ?? process.env)
      .filter(([key]) => !key.toUpperCase().startsWith('AGENT_BROWSER_')));
    this.env.AGENT_BROWSER_SOCKET_DIR = this.directory;
    this.env.NO_COLOR = '1';
  }

  /** An unanswered request leaves the daemon unsafe to reuse, even for reads. */
  get poisoned(): boolean { return this.uncertain; }

  /** Validate the exact public CLI version, once per transport. */
  async version(context: OperationContext): Promise<string> {
    const reservation = this.reserve();
    try {
      await this.ensureVersion({ ...context, signal: AbortSignal.any([context.signal, reservation.controller.signal]) });
      return AGENT_BROWSER_VERSION;
    } finally {
      this.release(reservation);
    }
  }

  /** Return the public JSON envelope's data; consumers validate command-specific data. */
  async run<T = unknown>(
    args: readonly string[],
    context: OperationContext,
    options: { readonly mutating?: boolean; readonly sensitive?: boolean } = {},
  ): Promise<T> {
    validateArguments(args);
    const reservation = this.reserve();
    const startedAt = performance.now();
    const signal = AbortSignal.any([context.signal, reservation.controller.signal]);
    try {
      await this.ensureVersion(remaining(context, startedAt, signal));
      const allowPreflight = options.mutating !== true || PRE_DISPATCH_REF_COMMANDS.has(args[0] ?? '');
      const output = await this.execute([...this.flags, ...args], remaining(context, startedAt, signal), options.mutating === true, true, allowPreflight);
      // All errors are sanitized, whether or not the caller marks the input sensitive.
      const count = args[0] === 'batch' ? args.slice(1).filter((arg) => arg !== '--bail').length : undefined;
      return this.data(output, options.mutating === true, count, allowPreflight) as T;
    } finally {
      this.release(reservation);
    }
  }

  /**
   * Cancel local callers, then ask the public CLI to close this exact session.
   * Only an explicit closed:true acknowledgement permits deleting its files.
   * Scoped close keeps its immutable binding and gets the full cleanup budget.
   * It cannot use the public cross-session close --all fallback. A failed close
   * retains its files and remains retryable with a fresh cleanup budget.
   */
  async close(context: OperationContext): Promise<void> {
    if (this.closed) return;
    if (this.closing !== undefined) return this.closing;
    const pending = this.closeSession(context);
    this.closing = pending;
    try {
      await pending;
    } finally {
      this.closing = undefined;
    }
  }

  /** Reserve synchronously, so simultaneous callers fail rather than queue. */
  private reserve(): Reservation {
    if (this.closed || this.closing !== undefined || this.uncertain) {
      throw failure('INVALID_STATE', 'The agent-browser session is closed, closing, or uncertain; create a new session');
    }
    if (this.reservation !== undefined) {
      throw failure('UNSUPPORTED_CAPABILITY', 'Concurrent commands on one agent-browser session are unsupported; poll waits with separate reads');
    }
    const controller = new AbortController();
    let release = (): void => {};
    const done = new Promise<void>((resolve) => { release = resolve; });
    const reservation = { controller, done, release };
    this.reservation = reservation;
    return reservation;
  }

  /** Release only the request that acquired the slot. */
  private release(reservation: Reservation): void {
    if (this.reservation === reservation) this.reservation = undefined;
    reservation.release();
  }

  /** Version is plain text even with --json in agent-browser 0.39.1. */
  private async ensureVersion(context: OperationContext): Promise<void> {
    if (context.signal.aborted) throw failure('CANCELLED', 'agent-browser command cancelled before dispatch');
    if (Number.isNaN(context.timeoutMs) || context.timeoutMs <= 0) {
      throw failure('OPERATION_TIMEOUT', 'agent-browser command timed out before dispatch');
    }
    if (this.verified) return;
    const output = await this.execute([...this.flags, '--version'], context, false, false);
    if (output.trim() !== `agent-browser ${AGENT_BROWSER_VERSION}`) {
      throw failure('ENGINE_FAILURE', `agent-browser ${AGENT_BROWSER_VERSION} is required; configure the reviewed exact-ref CLI build`);
    }
    this.verified = true;
  }

  /** Keep configuration after an unacknowledged close so another cleanup can retry. */
  private async closeSession(context: OperationContext): Promise<void> {
    const startedAt = performance.now();
    const reservation = this.reservation;
    if (reservation !== undefined) {
      reservation.controller.abort();
      await reservation.done;
    }
    if (this.sessionStarted) {
      try {
        const budget = remaining(context, startedAt);
        const output = await this.execute([...this.flags, 'close'], this.scoped ? budget
          : { ...budget, timeoutMs: Math.min(1_000, budget.timeoutMs / 2) }, false, true);
        const data = this.data(output, false);
        if (typeof data !== 'object' || data === null || !('closed' in data) || data.closed !== true) {
          throw failure('ENGINE_FAILURE', 'agent-browser did not acknowledge session closure');
        }
      } catch (error) {
        this.uncertain = true;
        // The reviewed native CLI rejects scoped close --all. Removing scope
        // would violate the daemon's immutable binding, so never broaden it to
        // rescue cleanup. A failed scoped close is not proof that work stopped.
        if (this.scoped) throw error;
        // --all only sees this instance's private socket directory. Its public
        // implementation can reap unreachable daemons; no other session is targeted.
        const output = await this.execute([...this.flags, 'close', '--all'], remaining(context, startedAt), false, true);
        const data = this.data(output, false);
        if (typeof data !== 'object' || data === null || !('closed' in data) || !('sessions' in data)
          || !Number.isInteger(data.closed) || !Array.isArray(data.sessions)
          || data.closed !== data.sessions.length || data.sessions.length > 1 || data.sessions.some((session: unknown) => session !== this.session)
          || ('failed' in data && (!Array.isArray(data.failed) || data.failed.length !== 0))) {
          throw failure('ENGINE_FAILURE', 'agent-browser did not acknowledge session cleanup; its daemon may still be running');
        }
      }
    }
    try {
      rmSync(this.directory, { recursive: true, force: true });
    } catch {
      throw failure('ENGINE_FAILURE', 'Could not remove isolated agent-browser session files');
    }
    this.closed = true;
  }

  /** Validate the envelope without trusting provider messages or error causes. */
  private data(output: string, mutating: boolean, batchCount?: number, allowPreflight = false): unknown {
    let envelope: unknown;
    try { envelope = JSON.parse(output); } catch {
      throw this.unanswered(mutating, 'agent-browser returned an invalid JSON response');
    }
    const preflight = allowPreflight ? preDispatchError(envelope) : undefined;
    if (preflight) throw preflight;
    if (batchCount !== undefined) {
      if (!Array.isArray(envelope) || envelope.length !== batchCount) {
        throw this.unanswered(mutating, 'agent-browser returned an incomplete batch response');
      }
      return envelope.map((entry: unknown) => {
        const constituent = allowPreflight ? preDispatchError(entry) : undefined;
        if (constituent) throw constituent;
        if (typeof entry !== 'object' || entry === null || !('success' in entry) || entry.success !== true || !('result' in entry)) {
          throw this.unanswered(mutating, 'agent-browser did not complete every observation in the batch');
        }
        return entry.result;
      });
    }
    if (typeof envelope !== 'object' || envelope === null || !('success' in envelope) || typeof envelope.success !== 'boolean') {
      throw this.unanswered(mutating, 'agent-browser returned an invalid response envelope');
    }
    if (!envelope.success) {
      throw this.unanswered(mutating, 'agent-browser could not complete the command');
    }
    if (!('data' in envelope)) throw this.unanswered(mutating, 'agent-browser returned a response without data');
    return envelope.data;
  }

  /** An abandoned daemon request is never evidence that its effects stopped. */
  private unanswered(mutating: boolean, message: string, code: EngineErrorCode = 'ENGINE_FAILURE'): EngineError {
    this.uncertain = true;
    if (mutating) {
      return failure('ACTION_MAY_HAVE_COMMITTED', 'agent-browser did not confirm completion; the action may have committed and must not be retried. Close this session and verify the outcome');
    }
    return failure(code, `${message}; its daemon request may still be running. Close this session before continuing`);
  }

  /** Spawn argv directly, drain stderr without retaining it, and enforce the budget. */
  private execute(args: readonly string[], context: OperationContext, mutating: boolean, sessionCommand: boolean, allowPreflight = false): Promise<string> {
    if (context.signal.aborted) return Promise.reject(failure('CANCELLED', 'agent-browser command cancelled before dispatch'));
    if (Number.isNaN(context.timeoutMs) || context.timeoutMs <= 0) {
      return Promise.reject(failure('OPERATION_TIMEOUT', 'agent-browser command timed out before dispatch'));
    }
    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess;
      let settled = false;
      let output = '';
      let bytes = 0;
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: EngineError): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        context.signal.removeEventListener('abort', abort);
        if (error === undefined) resolve(output);
        else reject(error);
      };
      const abandon = (code: EngineErrorCode, message: string): void => {
        if (settled) return;
        stopClient(child);
        finish(sessionCommand ? this.unanswered(mutating, message, code) : failure(code, message));
      };
      const abort = (): void => abandon('CANCELLED', 'agent-browser command cancelled');
      try {
        const isScript = /\.(?:c|m)?js$/i.test(this.executable);
        child = spawn(isScript ? process.execPath : this.executable, isScript ? [this.executable, ...args] : [...args], {
          shell: false,
          detached: process.platform !== 'win32',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: this.env,
        });
      } catch {
        finish(failure('ENGINE_FAILURE', 'Could not start the agent-browser CLI'));
        return;
      }
      if (sessionCommand && child.pid !== undefined) this.sessionStarted = true;
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) abandon('ENGINE_FAILURE', 'agent-browser response exceeded the output limit');
        else output += chunk;
      });
      child.stderr?.resume();
      child.once('error', () => finish(failure('ENGINE_FAILURE', 'Could not start the agent-browser CLI')));
      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          const preflight = allowPreflight ? preDispatchResponse(output) : undefined;
          if (preflight) { finish(preflight); return; }
          // A process exit can follow dispatched input; its stderr is not a safe diagnostic.
          finish(sessionCommand ? this.unanswered(mutating, 'agent-browser CLI exited without confirming completion') : failure('ENGINE_FAILURE', 'agent-browser CLI version check failed'));
        } else finish();
      });
      context.signal.addEventListener('abort', abort, { once: true });
      if (Number.isFinite(context.timeoutMs)) timer = setTimeout(() => abandon('OPERATION_TIMEOUT', 'agent-browser command timed out'), Math.min(context.timeoutMs, 2_147_483_647));
      if (context.signal.aborted) abort();
    });
  }
}
