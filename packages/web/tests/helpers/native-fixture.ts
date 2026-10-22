/** A real public engine and its typed Browser fixture for synthetic-page tests. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EngineHandle, OperationContext } from 'e2e/engine';
import type { TargetSession } from '../../../e2e/dist/engine/surface.js';
import { web, type Browser, type WebOptions } from '../../src/index.ts';
import { nativeBrowserGraph } from './native-browser.ts';
import type { CorrelateObserved } from './native-correlation.ts';
import { ignoreTrace, noSecrets } from './secrets.ts';

export interface NativeFixture {
  readonly engine: EngineHandle;
  readonly browser: Browser;
  /** Read-only acquisition identity join through the same attempt-bound fixture channel. */
  readonly correlate: CorrelateObserved;
  /** The same real session used by Browser, for retained-reference tests without locator retries. */
  readonly session: TargetSession;
  readonly operation: () => OperationContext;
  readonly close: () => Promise<void>;
}

/** Start the native engine without bypassing its executable or capability checks. */
export async function startNativeFixture(name: string, options: WebOptions = {}): Promise<NativeFixture> {
  const engine = web(options);
  const artifactsDir = mkdtempSync(path.join(tmpdir(), `e2e-${name}-`));
  const operation = (): OperationContext => ({
    signal: new AbortController().signal, timeoutMs: 10_000,
    runId: `run-${name}`, attemptId: `${name}-1`, origin: 'test',
  });
  const close = async (): Promise<void> => {
    try { await engine.dispose!({ signal: new AbortController().signal, timeoutMs: 30_000 }); }
    finally { rmSync(artifactsDir, { recursive: true, force: true }); }
  };
  try {
    await engine.init!({
      runId: `run-${name}`, targetName: 'web', projectRoot: process.cwd(),
      app: {}, env: process.env, headed: false, workerSlot: 0,
      signal: new AbortController().signal, log: () => undefined,
    });
    await engine.startAttempt!({
      attemptId: `${name}-1`, artifactsDir, signal: new AbortController().signal,
      resolveSecret: noSecrets, ...ignoreTrace,
    });
    await engine.session!.open!('about:blank', operation());
    return { engine, ...nativeBrowserGraph(engine, operation), operation, close };
  } catch (cause) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([cause, cleanupError], 'Native fixture startup and cleanup failed', { cause: cleanupError }); }
    throw cause;
  }
}
