/** Typed, validated command/event facade over the single native transport. */
import { EngineError, type EngineErrorCode, type JsonValue, type OperationContext } from 'e2e/engine';
import type { BrowserCommandMap, BrowserDecision, BrowserEventMap } from './browser-contract.ts';
import { decodeBrowserEvent, decodeBrowserResult, snapshotCorrelationArgs, validateBrowserDecision } from './browser-decode.ts';
import type { NativeClient } from './client.ts';
import type { NativeEvent, NativeResult } from './protocol.ts';

/** The lifecycle surface supplies current attempt identity and bounded cleanup context. */
export interface BrowserChannelContext {
  identityScope(): string;
  operation(): OperationContext;
}

type EventCallback = (event: BrowserEventMap[keyof BrowserEventMap]) => void | Promise<void>;
const EVENTS = new Set<string>(['network.request', 'registry-released', 'network.response', 'dialog.opened', 'download.started']);

/** No browser-specific protocol, handles, or retry policy are implemented here. */
export class BrowserChannel {
  private readonly listeners = new Map<keyof BrowserEventMap, Set<EventCallback>>();
  private readonly scope: string;
  private retired = false;

  constructor(private readonly client: NativeClient, private readonly context: BrowserChannelContext) {
    this.scope = context.identityScope();
  }

  invalidate(): EngineError { return this.client.invalidate(); }

  get identityScope(): string { this.assertScope(); return this.scope; }

  async command<K extends keyof BrowserCommandMap>(name: K, args: BrowserCommandMap[K]['args'], operation: OperationContext): Promise<BrowserCommandMap[K]['result']> {
    this.assertScope();
    const correlation = name === 'fixture.correlate' ? { args: snapshotCorrelationArgs(args), identityScope: this.scope } : undefined;
    // Every command argument is a typed JSON object; no opaque browser object is admitted.
    const result = await this.client.request(name, { ...(correlation?.args ?? args), identityScope: this.scope } as Readonly<Record<string, JsonValue>>, operation);
    // Validated uncertainty survives scope retirement; it never authorizes publication.
    if (!result.ok && result.effects === 'unknown') throw resultError(result);
    this.assertScope();
    if (!result.ok) throw resultError(result);
    try { return decodeBrowserResult(name, result.data, correlation); }
    catch { throw this.client.invalidate(); }
  }

  async decide(token: string, decision: BrowserDecision, operation: OperationContext): Promise<void> {
    this.assertScope();
    validateBrowserDecision(decision);
    await this.client.decide(token, decision as Readonly<Record<string, JsonValue>>, operation);
    this.assertScope();
  }

  subscribe<K extends keyof BrowserEventMap>(name: K, callback: (event: BrowserEventMap[K]) => void | Promise<void>): () => void {
    this.assertScope();
    let listeners = this.listeners.get(name);
    if (listeners === undefined) { listeners = new Set(); this.listeners.set(name, listeners); }
    // Name-indexed registration preserves the correlation erased by the heterogeneous map.
    const listener = callback as EventCallback;
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  /** Called directly from NativeClient.onEvent, preserving its callback-token context. */
  async dispatch(envelope: NativeEvent): Promise<void> {
    this.assertScope();
    if (!EVENTS.has(envelope.event)) return; // Other negotiated capabilities belong to the lifecycle surface.
    const name = envelope.event as keyof BrowserEventMap;
    let event: BrowserEventMap[keyof BrowserEventMap];
    try {
      if ((name === 'network.request' || name === 'dialog.opened') && envelope.decision === undefined) throw this.client.invalidate();
      const payload = envelope.decision === undefined ? envelope.payload : {
        ...(envelope.payload as Readonly<Record<string, JsonValue>>),
        token: envelope.decision.token, timeoutMs: envelope.decision.timeoutMs,
      };
      event = decodeBrowserEvent(name, payload);
    } catch { throw this.client.invalidate(); }
    // A queued retired event cannot acquire/release handles in the replacement scope.
    // Native scope teardown owns retirement of these resources before transition ACK.
    if (event.identityScope !== this.scope) return;
    let failed = false;
    try {
      // All subscribers see this same immutable event identity and may share its body capture.
      const settled = await Promise.allSettled([...this.listeners.get(name) ?? []].map(callback => Promise.resolve().then(() => callback(event))));
      const failure = settled.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    } catch (cause) { failed = true; throw cause; } finally {
      if (name === 'network.response' || name === 'download.started') {
        const handle = (event as BrowserEventMap['network.response'] | BrowserEventMap['download.started']).handle;
        await this.release(name === 'network.response' ? 'network.body.release' : 'download.release', handle, failed);
      }
    }
  }

  dispose(): void { this.retired = true; this.listeners.clear(); }

  private async release(name: 'network.body.release' | 'download.release', handle: string, failed: boolean): Promise<void> {
    // Lifecycle retirement owns outstanding native leases; a late JS callback
    // must neither release into nor invalidate the replacement scope.
    if (this.retired) return;
    try { await this.command(name, { handle }, this.context.operation()); }
    catch {
      // A release admitted while live may settle after disposal or scope replacement.
      // Its post-await scope check must not invalidate the shared replacement client.
      if (this.retired || this.context.identityScope() !== this.scope) return;
      const failure = this.client.invalidate();
      if (!failed) throw failure;
    }
  }

  private assertScope(): void {
    if (this.retired || this.context.identityScope() !== this.scope) throw new EngineError('INVALID_STATE', 'The native browser scope has retired', { retryable: false });
  }
}

/** Static protocol codes only. Never infer retryability from raw backend messages. */
const cleanRejections = new WeakSet<EngineError>();
/** Internal lifecycle evidence, never inferred from a public error string or caller-supplied code. */
export function isNativeNotDispatched(cause: unknown): boolean { return cause instanceof EngineError && cleanRejections.has(cause); }
export function resultError(result: NativeResult, checkedAction?: 'check' | 'uncheck'): EngineError {
  const failure = classifyResultError(result, checkedAction);
  if (result.effects === 'not-dispatched' && result.scopeState === 'usable') cleanRejections.add(failure);
  return failure;
}
function classifyResultError(result: NativeResult, checkedAction?: 'check' | 'uncheck'): EngineError {
  if (result.effects === 'unknown') return new EngineError('ACTION_MAY_HAVE_COMMITTED', 'The native browser action outcome is unknown', { retryable: false });
  const reason = result.error?.code;
  if (reason === 'intercepted-pointer') return new EngineError('NOT_ACTIONABLE', 'Another element intercepts pointer events', { retryable: false });
  if (reason === 'checked-state-unchanged' || reason === 'checked-control-replaced') {
    const verb = checkedAction ?? 'The checked-state action';
    const detail = reason === 'checked-control-replaced' ? ' before the control was replaced' : '';
    return new EngineError('NOT_ACTIONABLE', `${verb} clicked the control but its checked state did not change${detail}`, { retryable: false });
  }
  const bodyFailures: Readonly<Record<string, string>> = {
    'content-length-mismatch': 'net::ERR_CONTENT_LENGTH_MISMATCH',
    'redirect-body-unavailable': 'Response body is unavailable for redirect responses',
  };
  const bodyFailure = bodyFailures[result.error?.code ?? ''];
  if (bodyFailure !== undefined) return new EngineError('ENGINE_FAILURE', bodyFailure, { retryable: false });
  const codes: Readonly<Record<string, EngineErrorCode>> = {
    'stale-reference': 'NODE_STALE', 'not-actionable': 'NOT_ACTIONABLE',
    'deadline-exceeded': 'OPERATION_TIMEOUT', cancelled: 'CANCELLED',
    'unsupported-capability': 'UNSUPPORTED_CAPABILITY', 'unsupported-command': 'UNSUPPORTED_CAPABILITY',
    'stale-scope': 'INVALID_STATE', 'stale-generation': 'INVALID_STATE', 'scope-unavailable': 'INVALID_STATE',
  };
  const code = codes[result.error?.code ?? ''] ?? 'ENGINE_FAILURE';
  return new EngineError(code, `The native browser operation failed (${result.error?.code ?? 'browser-failure'})`, { retryable: code === 'NODE_STALE' && result.effects === 'not-dispatched' });
}
