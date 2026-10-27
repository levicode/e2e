/** Real native/Chrome terminal-close gate with a controlled PUBLIC close waiter.
 * The injected wait tests retained custody, not naturally occurring PW latency. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Browser } from 'playwright-core';
import { web, surfaceOf } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded test-only bound`)), ms); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
it.each(['before-dispose', 'after-dispose'] as const)('terminal close joins phase-one custody and a departed PW waiter %s', async phase => {
  const engine = web();
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'interop-peer-close-'));
  const lifetime = new AbortController();
  const expiry = setTimeout(() => lifetime.abort(), 40000);
  const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 30000 });
  const entered = deferred(); const disconnected = deferred();
  let raw: Browser | undefined; let pid: number | undefined;
  let stopping: Promise<void> | undefined; let pendingClose: Promise<void> | undefined;
  let restore: (() => void) | undefined; let failure: unknown; let cleanupPassed = false;
  const evidence: Record<string, unknown> = { schemaVersion: 1, phase, runtime: 'not-run', cleanup: 'not-run', injectedPublicWait: true };
  try {
    await engine.init!({ runId: 'interop-peer-close', targetName: 'web', projectRoot: process.cwd(), app: {}, env: process.env, headed: false, workerSlot: 0, signal: lifetime.signal, log: () => {} });
    await engine.startAttempt!({ attemptId: 'one', artifactsDir, signal: lifetime.signal, resolveSecret: noSecrets, ...ignoreTrace });
    const context = surfaceOf(engine)!.context(); raw = context.browser() ?? undefined;
    if (raw === undefined) throw new Error('missing actual browser');
    raw.on('disconnected', disconnected.resolve);
    let closeEvents = 0; context.on('close', () => { closeEvents++; });
    const probe = await raw.newBrowserCDPSession();
    try {
      const browsers = (await probe.send('SystemInfo.getProcessInfo')).processInfo.filter(item => item.type === 'browser');
      expect(browsers).toHaveLength(1); pid = browsers[0]!.id;
    } finally { await probe.detach(); }
    const original = context.close.bind(context);
    const intercepted = vi.spyOn(context, 'close').mockImplementation(() => {
      pendingClose = (async () => {
        if (phase === 'after-dispose') await original();
        entered.resolve(); await disconnected.promise;
      })();
      return pendingClose;
    });
    restore = () => intercepted.mockRestore();
    const departing = new AbortController();
    stopping = engine.endAttempt!({ signal: departing.signal, timeoutMs: 15000 });
    void stopping.catch(() => {});
    await bounded(entered.promise, 15000, 'actual phase-one ACK');
    expect(raw.isConnected()).toBe(true);
    expect(closeEvents).toBe(phase === 'after-dispose' ? 1 : 0);
    departing.abort(); await bounded(stopping, 5000, 'departed cleanup waiter');
    // No new ordinary RPC allowance; dispose joins the existing Close authority.
    await bounded(engine.dispose!(cleanup()), 30000, 'actual native/PW terminal receipt');
    await bounded(pendingClose!, 1000, 'original public waiter settlement');
    expect(raw.isConnected()).toBe(false); expect(closeEvents).toBe(1);
    evidence['runtime'] = 'passed'; evidence['closeEvents'] = closeEvents;
  } catch (cause) { failure = cause; evidence['runtime'] = 'failed'; }
  finally {
    clearTimeout(expiry); lifetime.abort();
    try {
      await bounded(engine.dispose!(cleanup()), 30000, 'final owned cleanup');
      if (raw !== undefined) expect(raw.isConnected()).toBe(false);
      if (stopping !== undefined) await bounded(stopping.catch(() => {}), 1000, 'stop receipt');
      if (pendingClose !== undefined) await bounded(pendingClose, 1000, 'PW receipt');
      if (pid !== undefined) {
        const until = Date.now() + 5000; let alive = true;
        while (alive && Date.now() < until) {
          try { process.kill(pid, 0); await new Promise(done => setTimeout(done, 20)); }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause; alive = false; }
        }
        expect(alive).toBe(false);
      }
      evidence['cleanup'] = 'passed'; cleanupPassed = true;
    } catch (cause) { failure ??= cause; evidence['cleanup'] = 'failed'; }
    restore?.();
    const directory = process.env['E2E_INTEROP_EVIDENCE_DIR'];
    if (directory !== undefined) { mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, `peer-terminal-${phase}.json`), JSON.stringify(evidence, null, 2)); }
    if (cleanupPassed) rmSync(artifactsDir, { recursive: true, force: true });
  }
  if (failure !== undefined) throw failure;
}, 90000);
