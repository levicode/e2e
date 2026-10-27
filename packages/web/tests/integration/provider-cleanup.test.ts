/** Local provider revocation must not depend on successful recorder/native cleanup. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { EngineHandle, OperationContext } from 'e2e/engine';
import { web, type BrowserLease, type BrowserProvider } from '../../src/index.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 10_000 });
const operation = (): OperationContext => ({ ...cleanup(), runId: 'provider-cleanup', attemptId: 'a1', origin: 'test' });

it.each([false, true])('revokes a real local provider lease after recorder failure, preserving the primary error (release failure: %s)', async failRelease => {
  const artifactsDir = await mkdtemp(path.join(tmpdir(), 'e2e-provider-cleanup-'));
  let chrome: RemoteChrome | undefined;
  let engine: EngineHandle | undefined;
  let env: Readonly<Record<string, string | undefined>> = process.env;
  const released: BrowserLease[] = [];
  const primary = new Error('local provider recorder cannot finalize');
  let lease: BrowserLease | undefined;
  const provider: BrowserProvider = {
    name: 'local-cleanup-fixture', scope: 'attempt',
    async acquire() {
      chrome = await launchRemoteChrome();
      lease = { id: 'local-owned-chrome', cdpEndpoint: chrome.endpoint };
      return lease;
    },
    async release(granted) {
      released.push(granted);
      await closeRemoteChrome(chrome!);
      if (failRelease) throw new Error('local provider release receipt failed');
    },
    async record() {
      return { startedAt: new Date().toISOString(), async stop() { throw primary; } };
    },
  };
  const init = () => ({ runId: 'provider-cleanup', targetName: 'web', projectRoot: process.cwd(), app: {}, env, headed: false, workerSlot: 0, signal: new AbortController().signal, log: () => undefined });
  try {
    engine = web({ browser: provider });
    const prepared = await engine.prepare!({ ...init(), slots: 1 });
    env = { ...env, ...prepared?.env };
    await engine.init!(init());
    await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    await engine.artifacts!.startVideo!(operation());
    const failure = await engine.endAttempt!(cleanup()).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', cause: primary });
    expect(released).toHaveLength(1);
    expect(released[0]).toBe(lease);
    expect(chrome!.proc.exitCode !== null || chrome!.proc.signalCode !== null).toBe(true);
    await expect(engine.startAttempt!({ attemptId: 'must-not-reuse', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(engine.dispose!(cleanup())).rejects.toBe(failure);
    expect(released).toHaveLength(1);
  } finally {
    await engine?.dispose!(cleanup()).catch(() => undefined);
    await engine?.finish!({ ...init(), ...cleanup() });
    if (chrome !== undefined) await closeRemoteChrome(chrome);
    await rm(artifactsDir, { recursive: true, force: true });
  }
});
