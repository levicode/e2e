/** All-target app diagnostics, delivered only to the harness's redacting sinks. */
import type { AppLogEntry, EngineAttemptContext, OperationContext } from 'e2e/engine';
import type { CdpConnection } from './cdp.ts';
import type { NetworkHub } from './network.ts';

export interface DiagnosticsOptions {
  /** The exact target currently selected by agent-browser, if one has been selected. */
  activeTarget(): string | undefined;
  /** Avoids duplicating navigations that the harness already records as an explicit action. */
  ownNavigation?(url: string): boolean;
  /** Retains visited origins for state capture even after a popup or frame closes. */
  onOrigin?(origin: string): void;
}

type RequestInfo = { method: string; url: string };
type DiagnosticsSink = Pick<EngineAttemptContext, 'appLog' | 'navigation' | 'signal'>;

/** Narrows protocol data without executing a remote getter or fetching object properties. */
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Removes embedded credentials and query/fragment tokens from a diagnostic URL. */
function diagnosticUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return `${url.origin}${url.pathname}`;
  } catch { return undefined; }
}

/** Formats only explicit protocol primitives; object previews and handles never enter the app log. */
function argument(value: unknown): string {
  const remote = object(value);
  if (!remote) return '[unavailable]';
  if (remote.type === 'undefined') return 'undefined';
  if (remote.type === 'object' && remote.subtype === 'null') return 'null';
  if (remote.type === 'string' && typeof remote.value === 'string') return remote.value;
  if (remote.type === 'boolean' && typeof remote.value === 'boolean') return String(remote.value);
  if (remote.type === 'number' && typeof remote.value === 'number') return String(remote.value);
  if (typeof remote.unserializableValue === 'string'
    && /^(?:NaN|Infinity|-Infinity|-0|-?\d+n)$/.test(remote.unserializableValue)) return remote.unserializableValue;
  if (remote.type === 'object' && remote.subtype === 'error' && typeof remote.description === 'string') return remote.description;
  if (remote.type === 'function') return '[Function]';
  if (remote.type === 'object') return remote.subtype === 'array' ? '[Array]' : '[Object]';
  return '[unavailable]';
}

/** Keeps browser diagnostic reasons closed, avoiding arbitrary payloads inside error-shaped fields. */
function networkFailure(value: unknown): string {
  return typeof value === 'string' && /^net::ERR_[A-Z0-9_]+$/.test(value) ? value : 'request failed';
}

/** Installs logs and navigation reports on every existing and future page/OOPIF before it resumes. */
export async function installDiagnostics(
  connection: CdpConnection,
  hub: NetworkHub,
  sink: DiagnosticsSink,
  configuration: DiagnosticsOptions,
  context: OperationContext,
): Promise<() => void> {
  const initial = await connection.listTargets(context);
  const initialTargets = new Set(initial.map((target) => target.targetId));
  const installed = new Set<string>();
  const unsubscribers: (() => void)[] = [];
  const requests = new Map<string, RequestInfo>();
  let closed = false;
  const report = (entry: AppLogEntry): void => {
    if (closed || sink.signal.aborted) return;
    // Do not truncate or transform message values before the harness redacts complete secrets.
    try { sink.appLog(entry); } catch { /* A diagnostics sink cannot fail the page's work. */ }
  };
  const navigated = (line: string): void => {
    if (closed || sink.signal.aborted) return;
    try { sink.navigation(line); } catch { /* A diagnostics sink cannot fail the page's work. */ }
  };
  const origin = (value: unknown): void => {
    const url = diagnosticUrl(value);
    if (!url || closed || sink.signal.aborted) return;
    try { configuration.onOrigin?.(new URL(url).origin); } catch { /* An optional observer cannot break diagnostics. */ }
  };
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    requests.clear();
    installed.clear();
  };
  unsubscribers.push(connection.onClose(cleanup));
  sink.signal.addEventListener('abort', cleanup, { once: true });
  unsubscribers.push(() => sink.signal.removeEventListener('abort', cleanup));
  try {
    await hub.registerSessionInitializer(async (sessionId, targetId, operation) => {
      if (closed || installed.has(sessionId)) return;
      installed.add(sessionId);
      origin(initial.find((target) => target.targetId === targetId)?.url);
      const kind = hub.sessions().find((entry) => entry.sessionId === sessionId)?.type;
      if (kind === 'page' && !initialTargets.has(targetId)) navigated('the app opened a new tab');
      const key = (id: unknown) => typeof id === 'string' ? `${sessionId}:${id}` : undefined;
      unsubscribers.push(
        connection.on('Runtime.consoleAPICalled', (event) => {
          const level: AppLogEntry['level'] | undefined = event.type === 'error' || event.type === 'assert' ? 'error'
            : event.type === 'warning' ? 'warning'
              : event.type === 'log' || event.type === 'info' ? 'info' : undefined;
          if (level === undefined) return;
          const text = Array.isArray(event.args) ? event.args.map(argument).join(' ') : '[unavailable console arguments]';
          if (!text.startsWith('Failed to load resource:')) report({ source: 'console', level, text });
        }, sessionId),
        connection.on('Runtime.executionContextCreated', (event) => { origin(object(event.context)?.origin); }, sessionId),
        connection.on('Runtime.exceptionThrown', (event) => {
          const details = object(event.exceptionDetails);
          const exception = object(details?.exception);
          const text = typeof exception?.description === 'string' ? exception.description
            : typeof details?.text === 'string' ? details.text : 'Uncaught page JavaScript exception';
          report({ source: 'error', level: 'error', text });
        }, sessionId),
        connection.on('Network.requestWillBeSent', (event) => {
          const id = key(event.requestId);
          const request = object(event.request);
          const url = diagnosticUrl(request?.url);
          if (!id || !url) return;
          const method = typeof request?.method === 'string' && /^[A-Z]+$/.test(request.method) ? request.method : 'HTTP';
          requests.set(id, { method, url });
        }, sessionId),
        connection.on('Network.responseReceived', (event) => {
          const response = object(event.response);
          const status = response?.status;
          if (typeof status !== 'number' || !Number.isInteger(status) || status < 400) return;
          const id = key(event.requestId);
          const request = id === undefined ? undefined : requests.get(id);
          const url = diagnosticUrl(response?.url) ?? request?.url;
          if (!url || (status === 404 && new URL(url).pathname === '/favicon.ico')) return;
          report({ source: 'network', level: status >= 500 ? 'error' : 'warning', text: `${request?.method ?? 'HTTP'} ${url} ${status}` });
        }, sessionId),
        connection.on('Network.loadingFailed', (event) => {
          const id = key(event.requestId);
          const request = id === undefined ? undefined : requests.get(id);
          if (id !== undefined) requests.delete(id);
          if (event.canceled === true || event.errorText === 'net::ERR_ABORTED') return;
          report({ source: 'network', level: 'error', text: `${request ? `${request.method} ${request.url} ` : ''}${networkFailure(event.errorText)}` });
        }, sessionId),
        connection.on('Network.loadingFinished', (event) => {
          const id = key(event.requestId);
          if (id !== undefined) requests.delete(id);
        }, sessionId),
        connection.on('Page.frameNavigated', (event) => {
          const frame = object(event.frame);
          origin(frame?.url);
          const url = diagnosticUrl(frame?.url);
          if (!url) return;
          if (kind === 'iframe' || typeof frame?.parentId === 'string') { navigated(`frame loaded ${url}`); return; }
          if (targetId === configuration.activeTarget()) {
            if (typeof frame?.url !== 'string' || !configuration.ownNavigation?.(frame.url)) navigated(`navigated to ${url}`);
          } else navigated(`the new tab navigated to ${url}`);
        }, sessionId),
        connection.on('Page.navigatedWithinDocument', (event) => {
          origin(event.url);
          const url = diagnosticUrl(event.url);
          if (!url) return;
          if (targetId === configuration.activeTarget()) {
            if (typeof event.url !== 'string' || !configuration.ownNavigation?.(event.url)) navigated(`navigated to ${url}`);
          } else if (kind === 'iframe') navigated(`frame loaded ${url}`);
          else navigated(`the new tab navigated to ${url}`);
        }, sessionId),
      );
      await Promise.all([
        connection.send('Runtime.enable', {}, operation, sessionId),
        connection.send('Network.enable', {}, operation, sessionId),
        connection.send('Page.enable', {}, operation, sessionId),
      ]);
    }, context);
    if (sink.signal.aborted) cleanup();
    return cleanup;
  } catch (error) { cleanup(); throw error; }
}
