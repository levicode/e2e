/** Typed engine hooks share the Browser fixture's one native client. */
import { createHash } from 'node:crypto';
import { EngineError, type JsonValue, type OperationContext } from 'e2e/engine';
import type { BrowserCommandMap } from './browser-contract.ts';
import { resultError } from './browser-channel.ts';
import { decodeBrowserResult } from './browser-decode.ts';
import { decodeEngineResult } from './engine-decode.ts';
import type { EngineCommandMap, NativeBlob } from './engine-contract.ts';
import type { NativeClient } from './client.ts';
import { queryDiagnostic } from './query-diagnostic.ts';

/** No retries, backend implementation, or alternative process transport. */
export class EngineChannel {
  constructor(private readonly client: NativeClient, private readonly captureScope: (scope: string) => () => boolean = () => () => true) {}

  async command<K extends keyof EngineCommandMap>(name: K, args: EngineCommandMap[K]['args'], operation: OperationContext, callbackTransition?: number): Promise<EngineCommandMap[K]['result']> {
    const scope = (args as { identityScope?: string }).identityScope;
    const owns = scope === undefined ? () => true : this.captureScope(scope);
    this.assertOwner(owns);
    // Capture only a bounded diagnostic fact before awaiting native authority.
    // Later caller mutation cannot change the classification of this request.
    const diagnostic = name === 'browser.query' || name === 'fixture.query'
      ? queryDiagnostic((args as EngineCommandMap['browser.query']['args']).expression) : undefined;
    // The closed command map contains only structured JSON values.
    const result = await this.client.request(name, { ...args } as Readonly<Record<string, JsonValue>>, operation, callbackTransition);
    // Validated uncertainty survives owner retirement; it never authorizes publication.
    if (!result.ok && result.effects === 'unknown') throw resultError(result);
    try { this.assertOwner(owns); } catch (cause) {
      // A completed transition cannot leave a publication barrier pending after its owner retires.
      if (callbackTransition !== undefined) this.client.invalidate();
      throw cause;
    }
    if (!result.ok) {
      const action = name === 'browser.perform' ? (args as EngineCommandMap['browser.perform']['args']).action.kind : undefined;
      throw resultError(result, action === 'check' || action === 'uncheck' ? action : undefined, diagnostic);
    }
    try { return decodeEngineResult(name, result.data); }
    catch { throw this.client.invalidate(); }
  }

  /** Read exact bytes, verify the final digest, and retire the scoped handle once. */
  async readBlob(blob: NativeBlob, expectedScope: string, operation: OperationContext): Promise<Buffer> {
    const owns = this.captureScope(expectedScope); this.assertOwner(owns);
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
      const chunks: Buffer[] = [];
      const hash = createHash('sha256');
      let offset = 0;
      for (;;) {
        if (operation.signal.aborted) throw new EngineError('CANCELLED', 'Native artifact transfer was cancelled', { retryable: false });
        if (performance.now() >= endsAt) throw new EngineError('OPERATION_TIMEOUT', 'Native artifact transfer exceeded its deadline', { retryable: false });
        const maxBytes = 262144;
        const chunk = await this.command('blob.read', { identityScope: expectedScope, handle: blob.handle, offset, maxBytes }, remaining());
        const bytes = Buffer.from(chunk.base64, 'base64');
        if (bytes.length > maxBytes || chunk.nextOffset !== offset + bytes.length || chunk.nextOffset > blob.size || (!chunk.eof && bytes.length === 0)) throw this.client.invalidate();
        chunks.push(bytes); hash.update(bytes); offset = chunk.nextOffset;
        if (chunk.eof) {
          if (offset !== blob.size || hash.digest('hex') !== blob.sha256) throw this.client.invalidate();
          return Buffer.concat(chunks, offset);
        }
      }
    } catch (cause) { failed = true; throw cause; }
    finally { await this.releaseBlob(blob.handle, operation, failed, expectedScope, owns); }
  }

  /** File uploads are borrowed; successful state replacement consumes its old-scope upload. */
  async withUpload<T>(bytes: Uint8Array, operation: OperationContext, work: (handle: string, remaining: OperationContext) => Promise<T>, expectedScope: string, ownership: 'borrowed' | 'consume-on-success' = 'borrowed'): Promise<T> {
    const owns = this.captureScope(expectedScope); this.assertOwner(owns);
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
