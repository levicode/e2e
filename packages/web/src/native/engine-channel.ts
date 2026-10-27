/** Typed engine hooks share the Browser fixture's one native client. */
import { createHash } from 'node:crypto';
import { connectionCancellation, connectionDeadline, withConnectionBudget } from '../operation-budget.ts';
import { EngineError, TestError, LOCATOR_ACTION_KINDS, type JsonValue, type OperationContext } from 'e2e/engine';
import type { BrowserCommandMap } from './browser-contract.ts';
import { resultError, type NativeActionErrorContext } from './browser-channel.ts';
import { decodeBrowserResult } from './browser-decode.ts';
import { decodeEngineResult } from './engine-decode.ts';
import { QUERY_UNION_CAPABILITY } from './capabilities.ts';
import type { EngineCommandMap, NativeBlob, NativeTraceImage } from './engine-contract.ts';
import type { NativeClient } from './client.ts';
import { frameQuerySnapshot, queryDiagnostic, queryUsesUnion, type FrameQueryDiagnostic } from './query-diagnostic.ts';

function captureActionErrorContext(action: EngineCommandMap['browser.perform']['args']['action'] | undefined): NativeActionErrorContext | undefined {
  const requestedKind = action?.kind;
  const kind = LOCATOR_ACTION_KINDS.find(candidate => candidate === requestedKind);
  return kind === undefined ? undefined : { kind, sensitive: action?.kind === 'fill' && action.sensitive === true };
}

interface BlobReadObserver {
  readonly accepted?: () => void;
  readonly complete: (bytes: Buffer) => void;
  readonly fail: (cause: unknown) => void;
}

/** Explicit custody for a received immutable batch until reads or exact-owner cleanup take it. */
export interface BlobBatchCustody {
  readonly pendingHandles: readonly string[];
  read(blob: NativeBlob, operation: OperationContext, observer: BlobReadObserver): Promise<Buffer>;
  retire(operation: OperationContext): Promise<void>;
}

const unavailableBlobReads = new WeakSet<EngineError | TestError>();
/** Only an exact, clean blob-read refusal proves optional transfer unavailability. */
export function isUnavailableBlobRead(cause: unknown): boolean {
  return (cause instanceof EngineError || cause instanceof TestError) && unavailableBlobReads.has(cause);
}

/** No retries, backend implementation, or alternative process transport. */
export class EngineChannel {
  constructor(private readonly client: NativeClient, private readonly captureScope: (scope: string) => () => boolean = () => () => true) {}

  command(name: 'capture.screenshot', args: EngineCommandMap['capture.screenshot']['args'] & { readonly purpose: 'trace' }, operation: OperationContext, callbackTransition?: number): Promise<NativeTraceImage>;
  command<K extends keyof EngineCommandMap>(name: K, args: EngineCommandMap[K]['args'], operation: OperationContext, callbackTransition?: number): Promise<EngineCommandMap[K]['result']>;
  async command<K extends keyof EngineCommandMap>(name: K, args: EngineCommandMap[K]['args'], operation: OperationContext, callbackTransition?: number): Promise<EngineCommandMap[K]['result']> {
    args = { ...args }; // Freeze dispatch purpose before asynchronous native work.
    // Capture only closed action facts before awaiting native authority. Caller
    // mutation cannot change the failure's verb or remove its sensitive marker.
    const actionContext = captureActionErrorContext(name === 'browser.perform' ? (args as EngineCommandMap['browser.perform']['args']).action : undefined);
    const actionKind = actionContext?.kind;
    const scope = (args as { identityScope?: string }).identityScope;
    const owns = scope === undefined ? () => true : this.captureScope(scope);
    this.assertOwner(owns);
    if ((name === 'browser.query' || name === 'fixture.query' || name === 'fixture.read-fields')
      && !this.client.negotiation().capabilities.includes(QUERY_UNION_CAPABILITY)) {
      const union = queryUsesUnion((args as EngineCommandMap['browser.query']['args']).expression);
      if (union === undefined) throw new EngineError('ENGINE_FAILURE', 'The native query feature check could not inspect the bounded expression', { retryable: false });
      if (union) {
        throw new EngineError('UNSUPPORTED_CAPABILITY', `Locator unions require ${QUERY_UNION_CAPABILITY}; update the native agent-browser runtime`, { retryable: false });
      }
    }
    // Capture only a bounded diagnostic fact before awaiting native authority.
    // Later caller mutation cannot change the classification of this request.
    const diagnostic = name === 'browser.query' || name === 'fixture.query' || name === 'fixture.read-fields'
      ? queryDiagnostic((args as EngineCommandMap['browser.query']['args']).expression) : undefined;
    const frames = name === 'browser.query' || name === 'fixture.query' || name === 'fixture.read-fields'
      ? frameQuerySnapshot((args as EngineCommandMap['browser.query']['args']).expression) : undefined;
    // Readiness is not recovery or a retry. Join only cancelled work already
    // owned by this scope, without bounding the dispatched result/Unknown proof.
    let settling = scope === undefined || this.client.recoveryScope() !== undefined ? undefined : this.client.cancelledSettlement(scope);
    if (settling !== undefined) {
      const endsAt = performance.now() + operation.timeoutMs;
      do {
        await withConnectionBudget({ signal: operation.signal, timeoutMs: endsAt - performance.now() }, 'native operation readiness', () => settling!);
        this.assertOwner(owns);
        settling = this.client.cancelledSettlement(scope!);
      } while (settling !== undefined);
      operation = { ...operation, timeoutMs: endsAt - performance.now() };
    }
    // The closed command map contains only structured JSON values.
    const result = await this.client.request(name, { ...args } as Readonly<Record<string, JsonValue>>, operation, callbackTransition);
    // Validated uncertainty survives owner retirement; it never authorizes publication.
    if (!result.ok && result.effects === 'unknown') throw resultError(result, undefined, undefined, undefined, actionContext);
    // A settled keyboard refusal carries no input prefix. Preserve that exact
    // native evidence so the surface can classify a completed local reset.
    if (!result.ok && name === 'browser.keyboard.type' && result.effects === 'not-dispatched' && result.scopeState === 'usable') throw resultError(result);
    try { this.assertOwner(owns); } catch (cause) {
      // A completed transition cannot leave a publication barrier pending after its owner retires.
      if (callbackTransition !== undefined) this.client.invalidate();
      throw cause;
    }
    // These read-only producers may complete temporary source protection before
    // refusing pixels. Preserve the policy reason, but never claim no dispatch
    // or grant replay authority for the completed prefix.
    if (!result.ok && (name === 'browser.observe' || name === 'capture.screenshot')
      && result.error?.code === 'policy-denied' && result.effects === 'completed' && result.scopeState === 'usable') {
      throw new TestError('POLICY_DENIED', 'The native protected read was denied by policy after restoration', { retryable: false });
    }
    if (!result.ok) {
      let frameDiagnostic: FrameQueryDiagnostic | undefined;
      if (result.error?.code === 'frame-not-found' || result.error?.code === 'frame-ambiguous') {
        const facts = result.error.frameSelection;
        const selector = facts === undefined ? undefined : frames?.[facts.index];
        // Contradictory request context is a broken contract, never a guessed selector.
        if (facts === undefined || selector === undefined) throw this.client.invalidate();
        frameDiagnostic = { selector, index: facts.index, count: facts.count };
      }
      const cause = resultError(result, actionKind === 'check' || actionKind === 'uncheck' ? actionKind : undefined, diagnostic, frameDiagnostic, actionContext);
      if (name === 'blob.read' && result.effects === 'not-dispatched' && result.scopeState === 'usable'
        && (result.error?.code === 'deadline-exceeded' || result.error?.code === 'capacity-exceeded')) unavailableBlobReads.add(cause);
      throw cause;
    }
    try { return decodeEngineResult(name, result.data, args); }
    catch { throw this.client.invalidate(); }
  }

  /** Capture all handles before the first read; never acquire a replacement scope for cleanup. */
  retainBlobBatch(blobs: readonly NativeBlob[], expectedScope: string): BlobBatchCustody {
    const captured = this.captureScope(expectedScope); const notRevoked = this.client.recoveryRevocationGuard();
    const owns = () => captured() && notRevoked(); this.assertOwner(owns);
    const pending = new Map<string, NativeBlob>();
    for (const blob of blobs) {
      if (blob.identityScope !== expectedScope || pending.has(blob.handle)) throw this.client.invalidate();
      pending.set(blob.handle, blob);
    }
    let retirement: Promise<void> | undefined;
    return {
      get pendingHandles() { return [...pending.keys()]; },
      read: (blob, operation, observer) => {
        this.assertOwner(owns);
        if (retirement !== undefined || pending.get(blob.handle) !== blob) throw new EngineError('INVALID_STATE', 'Native blob batch ownership has retired', { retryable: false });
        return this.readBlob(blob, expectedScope, operation, owns, { ...observer,
          accepted: () => { pending.delete(blob.handle); observer.accepted?.(); },
        });
      },
      retire: operation => retirement ??= (async () => {
        const endsAt = performance.now() + operation.timeoutMs;
        for (const handle of pending.keys()) {
          // A changed scope/client is not authority to release into its replacement.
          // The enclosing attempt retains this batch until native retirement is proven.
          if (!owns()) return;
          if (operation.signal.aborted) throw connectionCancellation('Native blob batch cleanup was cancelled');
          const timeoutMs = endsAt - performance.now();
          if (timeoutMs <= 0) throw connectionDeadline('Native blob batch cleanup exceeded its original budget');
          const result = await this.client.request('blob.release', { identityScope: expectedScope, handle }, { ...operation, timeoutMs });
          this.assertOwner(owns);
          if (!result.ok) throw resultError(result);
          try { decodeBrowserResult('blob.release', result.data); } catch { throw this.client.invalidate(); }
          pending.delete(handle);
        }
      })(),
    };
  }

  /** Verify exact bytes before notifying optional waiters; the returned promise also owns handle retirement. */
  async readBlob(blob: NativeBlob, expectedScope: string, operation: OperationContext, pageOwner?: () => boolean, observer?: BlobReadObserver): Promise<Buffer> {
    const capturedScope = this.captureScope(expectedScope);
    const capturedOwner = () => capturedScope() && (pageOwner?.() ?? true);
    const notRevoked = this.client.recoveryRevocationGuard();
    const owns = () => notRevoked() && capturedOwner(); this.assertOwner(owns);
    if (blob.identityScope !== expectedScope) throw this.client.invalidate();
    operation = { ...operation }; // Snapshot the parent's remaining monotonic budget once.
    const endsAt = performance.now() + operation.timeoutMs;
    const remaining = (): OperationContext => {
      const timeoutMs = endsAt - performance.now();
      if (timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', 'Native transfer exhausted its deadline before dispatch', { retryable: false });
      return { ...operation, timeoutMs };
    };
    let failed = false;
    try {
      // From this point, the existing read/finally owner must retire the handle.
      observer?.accepted?.();
      const chunks: Buffer[] = [];
      const hash = createHash('sha256');
      let offset = 0;
      for (;;) {
        if (operation.signal.aborted) throw new EngineError('CANCELLED', 'Native artifact transfer was cancelled', { retryable: false });
        if (performance.now() >= endsAt) throw new EngineError('OPERATION_TIMEOUT', 'Native artifact transfer exceeded its deadline', { retryable: false });
        const maxBytes = 262144;
        this.assertOwner(owns);
        const chunk = await this.command('blob.read', { identityScope: expectedScope, handle: blob.handle, offset, maxBytes }, remaining());
        this.assertOwner(owns);
        const bytes = Buffer.from(chunk.base64, 'base64');
        if (bytes.length > maxBytes || chunk.nextOffset !== offset + bytes.length || chunk.nextOffset > blob.size || (!chunk.eof && bytes.length === 0)) throw this.client.invalidate();
        chunks.push(bytes); hash.update(bytes); offset = chunk.nextOffset;
        if (chunk.eof) {
          if (offset !== blob.size || hash.digest('hex') !== blob.sha256) throw this.client.invalidate();
          const data = Buffer.concat(chunks, offset);
          observer?.complete(data);
          return data;
        }
      }
    } catch (cause) { failed = true; observer?.fail(cause); throw cause; }
    finally { await this.releaseBlob(blob.handle, operation, failed, expectedScope, owns); }
  }

  /** File uploads are borrowed; successful state replacement consumes its old-scope upload. */
  async withUpload<T>(bytes: Uint8Array, operation: OperationContext, work: (handle: string, remaining: OperationContext) => Promise<T>, expectedScope: string, ownership: 'borrowed' | 'consume-on-success' = 'borrowed'): Promise<T> {
    const capturedOwner = this.captureScope(expectedScope);
    const notRevoked = this.client.recoveryRevocationGuard();
    const owns = () => notRevoked() && capturedOwner(); this.assertOwner(owns);
    operation = { ...operation }; // Snapshot the parent's remaining monotonic budget once.
    const endsAt = performance.now() + operation.timeoutMs;
    const remaining = (): OperationContext => {
      const timeoutMs = endsAt - performance.now();
      if (timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', 'Native transfer exhausted its deadline before dispatch', { retryable: false });
      return { ...operation, timeoutMs };
    };
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const created = await this.browserCommand('blob.create', { size: bytes.length, sha256 }, remaining(), expectedScope);
    let failed = false;
    let transferred = false;
    try {
      if (created.size !== bytes.length || created.sha256 !== sha256 || created.maxChunkBytes <= 0 || created.maxChunkBytes > 262144) throw this.client.invalidate();
      for (let offset = 0; offset < bytes.length;) {
        if (operation.signal.aborted) throw new EngineError('CANCELLED', 'Native upload was cancelled', { retryable: false });
        if (performance.now() >= endsAt) throw new EngineError('OPERATION_TIMEOUT', 'Native upload exceeded its deadline', { retryable: false });
        const chunk = bytes.subarray(offset, offset + created.maxChunkBytes);
        const written = await this.browserCommand('blob.write', { handle: created.handle, offset, base64: Buffer.from(chunk).toString('base64') }, remaining(), expectedScope);
        if (written.nextOffset !== offset + chunk.length) throw this.client.invalidate();
        offset = written.nextOffset;
      }
      const sealed = await this.browserCommand('blob.seal', { handle: created.handle }, remaining(), expectedScope);
      if (sealed.handle !== created.handle || sealed.size !== bytes.length || sealed.sha256 !== sha256) throw this.client.invalidate();
      const result = await work(created.handle, remaining());
      transferred = ownership === 'consume-on-success';
      return result;
    } catch (cause) { failed = true; throw cause; }
    finally { if (!transferred) await this.releaseBlob(created.handle, operation, failed, expectedScope, owns); }
  }

  private async browserCommand<K extends keyof BrowserCommandMap>(name: K, args: BrowserCommandMap[K]['args'], operation: OperationContext, expectedScope: string): Promise<BrowserCommandMap[K]['result']> {
    const owns = this.captureScope(expectedScope); this.assertOwner(owns);
    const result = await this.client.request(name, { ...args, identityScope: expectedScope } as Readonly<Record<string, JsonValue>>, operation);
    // NativeClient has already quarantined a validated unknown outcome.
    if (!result.ok && result.effects === 'unknown') throw resultError(result);
    this.assertOwner(owns);
    if (!result.ok) throw resultError(result);
    try { return decodeBrowserResult(name, result.data); } catch { throw this.client.invalidate(); }
  }

  private assertOwner(owns: () => boolean): void {
    if (!owns()) throw new EngineError('CANCELLED', 'Native transfer belongs to a retired scope', { retryable: false });
  }

  private async releaseBlob(handle: string, operation: OperationContext, failed: boolean, expectedScope: string, owns: () => boolean): Promise<void> {
    // Scope retirement owns old handles. Never release or invalidate a replacement client/scope.
    if (!owns()) { if (!failed) this.assertOwner(owns); return; }
    const cleanup = { ...operation, signal: AbortSignal.timeout(1000), timeoutMs: 1000 };
    try {
      const result = await this.client.request('blob.release', { handle, identityScope: expectedScope }, cleanup);
      if (!owns()) { if (!failed) this.assertOwner(owns); return; }
      if (!result.ok) throw resultError(result);
      decodeBrowserResult('blob.release', result.data);
    } catch {
      if (!owns()) { if (!failed) this.assertOwner(owns); return; }
      const cause = this.client.invalidate(); if (!failed) throw cause;
    }
  }
}
