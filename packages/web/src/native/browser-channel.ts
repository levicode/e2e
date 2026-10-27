/** Typed, validated command/event facade over the single native transport. */
import { EngineError, TestError, type EngineErrorCode, type JsonValue, type LocatorActionKind, type OperationContext } from 'e2e/engine';
import type { BrowserCommandMap, BrowserDecision, BrowserEventMap } from './browser-contract.ts';
import { decodeBrowserEvent, decodeBrowserResult, snapshotCorrelationArgs, validateBrowserDecision } from './browser-decode.ts';
import type { NativeClient } from './client.ts';
import type { NativeEvent, NativeResult } from './protocol.ts';
import type { FrameQueryDiagnostic, QueryDiagnostic } from './query-diagnostic.ts';
import { withConnectionBudget } from '../operation-budget.ts';

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

  async command<K extends keyof BrowserCommandMap>(name: K, args: BrowserCommandMap[K]['args'], operation: OperationContext, beforePagePublication?: () => void): Promise<BrowserCommandMap[K]['result']> {
    if (name === 'download.unsubscribe' || name === 'download.release') {
      this.assertScope();
      // A cancelled read still owns its native request until result and cancel ACK.
      // Join only those proofs under this cleanup's existing budget, not recovery.
      return withConnectionBudget(operation, 'download resource cleanup', async remaining => {
        for (;;) {
          const settling = this.client.cancelledSettlement(this.scope);
          if (settling === undefined) break;
          await settling;
        }
        return this.dispatchCommand(name, args, { ...operation, ...remaining() });
      });
    }
    return this.dispatchCommand(name, args, operation, beforePagePublication);
  }

  private async dispatchCommand<K extends keyof BrowserCommandMap>(name: K, args: BrowserCommandMap[K]['args'], operation: OperationContext, beforePagePublication?: () => void): Promise<BrowserCommandMap[K]['result']> {
    this.assertScope();
    const correlation = name === 'fixture.correlate' ? { args: snapshotCorrelationArgs(args), identityScope: this.scope } : undefined;
    let settling = this.client.cancelledSettlement(this.scope);
    if (settling !== undefined) {
      const endsAt = performance.now() + operation.timeoutMs;
      do {
        await withConnectionBudget({ signal: operation.signal, timeoutMs: endsAt - performance.now() }, 'native operation readiness', () => settling!);
        this.assertScope();
        settling = this.client.cancelledSettlement(this.scope);
      } while (settling !== undefined);
      operation = { ...operation, timeoutMs: endsAt - performance.now() };
    }
    // Every command argument is a typed JSON object; no opaque browser object is admitted.
    const result = await this.client.request(name, { ...(correlation?.args ?? args), identityScope: this.scope } as Readonly<Record<string, JsonValue>>, operation);
    if (name === 'download.release' && !result.ok && process.env['E2E_DOWNLOAD_RELEASE_DIAGNOSTIC'] === '1') process.stderr.write(`DOWNLOAD_RELEASE_DIAGNOSTIC ${JSON.stringify({ phase: 'native-result', code: result.error?.code, effects: result.effects, scopeState: result.scopeState })}\n`);
    if ((name === 'download.release' || name === 'download.unsubscribe') && !result.ok
      && result.error?.code === 'scope-unavailable' && result.effects === 'not-dispatched' && result.scopeState === 'usable') {
      // Native scope replacement closes admission before publishing its owner. Its
      // receipt must retire this exact channel before it can own this cleanup.
      const retirement = this.client.scopeReplacementRetirement(this.scope);
      if (retirement !== undefined && await retirement && this.retired) return decodeBrowserResult(name, null);
    }
    // A page-creating continuation owns its captured attempt across this exact
    // result. Preserve real failure evidence before local publication checks;
    // on success let that owner detect retirement before the disposed channel.
    // No other command acquires this continuation or changes its scope guard.
    if (name === 'page.navigate' && beforePagePublication !== undefined) {
      if (!result.ok) throw resultError(result);
      beforePagePublication();
    }
    // Validated uncertainty survives scope retirement; it never authorizes publication.
    if (!result.ok && result.effects === 'unknown') throw resultError(result);
    this.assertScope();
    if (!result.ok) throw resultError(result);
    try { return decodeBrowserResult(name, result.data, correlation ?? { identityScope: this.scope }); }
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
    const notRevoked = this.client.callbackRevocationGuard();
    let failed = false;
    try {
      // All subscribers see this same immutable event identity and may share its body capture.
      const settled = await Promise.allSettled([...this.listeners.get(name) ?? []].map(callback => Promise.resolve().then(() => callback(event))));
      const failure = settled.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    } catch (cause) { failed = true; throw cause; } finally {
      if (name === 'network.response' || name === 'download.started') {
        const handle = (event as BrowserEventMap['network.response'] | BrowserEventMap['download.started']).handle;
        await this.release(name === 'network.response' ? 'network.body.release' : 'download.release', handle, failed, notRevoked);
      }
    }
  }

  dispose(): void { this.retired = true; this.listeners.clear(); }

  private async release(name: 'network.body.release' | 'download.release', handle: string, failed: boolean, notRevoked: () => boolean): Promise<void> {
    // Lifecycle retirement owns outstanding native leases; a late JS callback
    // must neither release into nor invalidate the replacement scope.
    if (this.retired || !notRevoked()) return;
    try { await this.command(name, { handle }, this.context.operation()); }
    catch (cause) {
      if (name === 'download.release' && process.env['E2E_DOWNLOAD_RELEASE_DIAGNOSTIC'] === '1') process.stderr.write(`DOWNLOAD_RELEASE_DIAGNOSTIC ${JSON.stringify({ phase: 'adapter-failure', code: cause instanceof EngineError || cause instanceof TestError ? cause.code : 'unclassified' })}\n`);
      // A release admitted while live may settle after disposal or scope replacement.
      // Its post-await scope check must not invalidate the shared replacement client.
      if (this.retired || !notRevoked() || this.context.identityScope() !== this.scope) return;
      const failure = this.client.invalidate();
      if (!failed) throw failure;
    }
  }

  private assertScope(): void {
    if (this.retired || this.context.identityScope() !== this.scope) throw new EngineError('INVALID_STATE', 'The native browser scope has retired', { retryable: false });
  }
}

/** Request-local scalar facts only; never retain a fill value or renderer text. */
export interface NativeActionErrorContext {
  readonly kind: LocatorActionKind;
  readonly sensitive: boolean;
}

function sensitiveActionSuffix(action?: NativeActionErrorContext): string {
  return action?.kind === 'fill' && action.sensitive ? ' (fill value [redacted])' : '';
}

/** Static protocol codes only. Never infer retryability from raw backend messages. */
const cleanRejections = new WeakSet<EngineError | TestError>();
const usableFailures = new WeakSet<EngineError | TestError>();
/** Publication may finish a proven page-creation prefix; this grants no replay or native ownership authority. */
export function isNativeUsableFailure(cause: unknown): boolean { return (cause instanceof EngineError || cause instanceof TestError) && usableFailures.has(cause); }
/** Internal lifecycle evidence, never inferred from a public error string or caller-supplied code. */
export function isNativeNotDispatched(cause: unknown): boolean { return (cause instanceof EngineError || cause instanceof TestError) && cleanRejections.has(cause); }
export function resultError(result: NativeResult, checkedAction?: 'check' | 'uncheck', queryDiagnostic?: QueryDiagnostic, frameDiagnostic?: FrameQueryDiagnostic, actionContext?: NativeActionErrorContext): EngineError | TestError {
  const failure = classifyResultError(result, checkedAction, queryDiagnostic, frameDiagnostic, actionContext);
  if (result.effects === 'not-dispatched' && result.scopeState === 'usable') cleanRejections.add(failure);
  if (result.effects !== 'unknown' && result.scopeState === 'usable') usableFailures.add(failure);
  return failure;
}
function classifyResultError(result: NativeResult, checkedAction?: 'check' | 'uncheck', queryDiagnostic?: QueryDiagnostic, frameDiagnostic?: FrameQueryDiagnostic, actionContext?: NativeActionErrorContext): EngineError | TestError {
  const suffix = sensitiveActionSuffix(actionContext);
  if (result.effects === 'unknown') {
    // Unknown includes scroll/focus/preparation. It is not proof that an Input
    // command was dispatched, and formatting never authorizes a replay.
    const message = actionContext === undefined ? 'The native browser action outcome is unknown'
      : `${actionContext.kind} outcome is unknown; the action may have committed`;
    return new EngineError('ACTION_MAY_HAVE_COMMITTED', `${message}${suffix}`, { retryable: false });
  }
  const reason = result.error?.code;
  // The native receipt certifies only an acknowledged hover/scroll prefix and
  // zero button presses. Completed is not rollback; relocation must use the
  // core's fresh observation/descriptor path, never replay the old exact ref.
  if (!result.ok && reason === 'tap-target-replaced-before-press'
    && result.effects === 'completed' && result.scopeState === 'usable' && actionContext?.kind === 'tap') {
    return new EngineError('NODE_STALE', 'The exact tap target was replaced after hover and before its button press', { retryable: true });
  }
  if (!result.ok && result.effects === 'not-dispatched' && result.scopeState === 'usable' && frameDiagnostic !== undefined
    && result.error?.frameSelection?.index === frameDiagnostic.index && result.error.frameSelection.count === frameDiagnostic.count) {
    if (reason === 'frame-not-found') return new EngineError('FRAME_NOT_FOUND', `no frame matches ${frameDiagnostic.selector}`, { retryable: true });
    if (reason === 'frame-ambiguous') return new EngineError('FRAME_AMBIGUOUS', `${frameDiagnostic.count} frames match ${frameDiagnostic.selector}`, { retryable: false });
  }
  // Only a settled clean refusal carries public policy semantics. A policy
  // label cannot hide completed effects or make a dirty scope reusable.
  if (reason === 'invalid-locator' && result.effects === 'not-dispatched' && result.scopeState === 'usable') return new TestError('INVALID_LOCATOR', 'The web selector is invalid. Check selector syntax and capture placement: a selector that captures with * (*css=article >> text=Hello) is not supported before the last part; use filter({ has }) instead', { retryable: false });
  if (reason === 'policy-denied' && result.effects === 'not-dispatched' && result.scopeState === 'usable') return new TestError('POLICY_DENIED', 'The native browser operation was denied by policy', { retryable: false });
  if (!result.ok && reason === 'unsupported-capability' && result.effects === 'not-dispatched' && result.scopeState === 'usable' && queryDiagnostic === 'display-value-composition') {
    return new EngineError('UNSUPPORTED_CAPABILITY', 'displayValue queries cannot scope child queries, serve as a has-filter, or form a union in this engine', { retryable: false });
  }
  // Only these closed, clean, pre-input refusals preserve keyboard semantics.
  // Never infer fill support from generic actionability or uncertain effects.
  if (!result.ok && result.effects === 'not-dispatched' && result.scopeState === 'usable') {
    if (reason === 'fill-unsupported-target' && actionContext?.kind === 'fill') {
      return new EngineError('NOT_ACTIONABLE', `The target is not an input, textarea, or contenteditable element${suffix}`, { retryable: false });
    }
    if (reason === 'no-editable-focus') {
      return new EngineError('NOT_ACTIONABLE', 'nothing that takes keystrokes has focus: the typed text would reach no field. Tap the field first, or type into a listed input by id.', { retryable: false });
    }
  }
  if (reason === 'intercepted-pointer') {
    const message = actionContext === undefined ? 'Another element intercepts pointer events'
      : `${actionContext.kind} did not become actionable: another element intercepts pointer events`;
    return new EngineError('NOT_ACTIONABLE', `${message}${suffix}`, { retryable: false });
  }
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
    'fill-unsupported-target': 'NOT_ACTIONABLE', 'no-editable-focus': 'NOT_ACTIONABLE',
    'tap-target-replaced-before-press': 'NOT_ACTIONABLE',
    'deadline-exceeded': 'OPERATION_TIMEOUT', cancelled: 'CANCELLED',
    'unsupported-capability': 'UNSUPPORTED_CAPABILITY', 'unsupported-command': 'UNSUPPORTED_CAPABILITY',
    'stale-scope': 'INVALID_STATE', 'stale-generation': 'INVALID_STATE', 'scope-unavailable': 'INVALID_STATE',
  };
  const code = codes[result.error?.code ?? ''] ?? 'ENGINE_FAILURE';
  const message = code === 'NOT_ACTIONABLE' && actionContext !== undefined
    ? `${actionContext.kind} did not become actionable`
    : `The native browser operation failed (${result.error?.code ?? 'browser-failure'})`;
  return new EngineError(code, `${message}${suffix}`, { retryable: code === 'NODE_STALE' && result.effects === 'not-dispatched' });
}
