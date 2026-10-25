// Temporary real-launch controls. No synthetic protocol or app.log injection.
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AppLogEntry, EngineFixtureContext } from 'e2e/engine';
import { createBrowserFixture } from '__E2E_SOURCE_ROOT__/packages/web/src/browser.ts';
import { NativeSurface } from '__E2E_SOURCE_ROOT__/packages/web/src/native-surface.ts';
import { ignoreTrace, noSecrets } from '__E2E_SOURCE_ROOT__/packages/web/tests/helpers/secrets.ts';

const id = process.env['NETWORK_PROBE_CONTROL'];
if (id !== 'LAUNCHER_READY' && id !== 'HTTP_POSITIVE') throw new Error('Closed diagnostic control required');
const title = id === 'LAUNCHER_READY' ? 'observes the exact selector in a real launch daemon' : 'projects one ordinary real HTTP500 fetch to the adapter';
it(title, async () => {
  const directory = process.env['STARTUP_EVENT_EVIDENCE_DIRECTORY'];
  if (!directory) throw new Error('Missing evidence directory');
  const st = lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) throw new Error('Unowned evidence directory');
  const entries: AppLogEntry[] = [], http: string[] = [], routes: Array<{ path: string; method: string }> = [], violations: string[] = [];
  const cleanupFacts = { end: 'not-started', dispose: 'not-started', server: 'not-started' };
  let origin = '', firstError: unknown;
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    if (request.headers.host !== origin.slice(7) || !['/', '/favicon.ico', '/probe-network'].includes(path)) {
      violations.push('non-fixture-request'); response.writeHead(403); response.end(); return;
    }
    http.push(path);
    response.writeHead(path === '/probe-network' ? 500 : path === '/favicon.ico' ? 204 : 200, { 'content-type': path === '/' ? 'text/html' : 'text/plain', 'cache-control': 'no-store' });
    response.end(path === '/' ? '<!doctype html><title>Network probe control</title>' : path === '/favicon.ico' ? undefined : 'closed synthetic response');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const selectedUrl = `${origin}/probe-network`;
  const selector = createHash('sha256').update(selectedUrl).digest('hex');
  const surface = new NativeSurface({}), projectRoot = mkdtempSync(join(tmpdir(), 'network-control-'));
  const signal = new AbortController().signal, cleanup = () => ({ signal, timeoutMs: 30_000 });
  try {
    await surface.init({ runId: 'network-probe-control', targetName: 'web', projectRoot, app: { site: '127.0.0.1' }, env: { ...process.env, AGENT_BROWSER_NETWORK_PROBE_SHA256: selector }, headed: false, workerSlot: 0, signal, log: () => undefined });
    await surface.startAttempt({ attemptId: 'network-control', artifactsDir: projectRoot, signal, resolveSecret: noSecrets, ...ignoreTrace, appLog: entry => entries.push(entry) });
    const browser = createBrowserFixture(surface.fixtureSurface(), {
      operation: (timeoutMs = 30_000) => ({ signal, timeoutMs, runId: 'network-probe-control', attemptId: 'network-control', origin: 'test' }),
      app: { site: '127.0.0.1', resolveUrl: (target: string) => new URL(target, origin).href },
      timeouts: { test: 30_000, assertion: 5_000 }, expectable: (target: object) => target, fixture: (_name: string, target: object) => target,
    } as unknown as EngineFixtureContext);
    await browser.route('**/*', route => {
      const url = new URL(route.request.url);
      if (url.origin !== origin || url.search || !['/', '/favicon.ico', '/probe-network'].includes(url.pathname)) { violations.push('non-fixture-route'); return route.abort(); }
      routes.push({ path: url.pathname, method: route.request.method }); return route.continue();
    });
    await browser.goto('/');
    if (id === 'HTTP_POSITIVE') {
      expect(await browser.evaluate(async () => (await fetch('/probe-network')).status)).toBe(500);
      await expect.poll(() => entries.filter(entry => entry.source === 'network' && entry.text === `GET ${selectedUrl} 500 Internal Server Error`).length, { timeout: 5_000 }).toBe(1);
      expect(http.filter(path => path === '/probe-network')).toHaveLength(1);
      expect(routes.filter(hit => hit.path === '/probe-network')).toEqual([{ path: '/probe-network', method: 'GET' }]);
    }
    expect(violations).toEqual([]);
  } catch (error) { firstError = error; }
  finally {
    try { await surface.endAttempt(cleanup()); cleanupFacts.end = 'passed'; } catch (error) { cleanupFacts.end = 'failed'; firstError ??= error; }
    try { await surface.dispose(cleanup()); cleanupFacts.dispose = 'passed'; } catch (error) { cleanupFacts.dispose = 'failed'; firstError ??= error; }
    server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); cleanupFacts.server = 'passed'; } catch (error) { cleanupFacts.server = 'failed'; firstError ??= error; }
    writeFileSync(join(directory, 'startup-events.json'), JSON.stringify({ schemaVersion: 1, id, origin, selectedUrl, selector, entries, http, routes, violations, cleanup: cleanupFacts, error: firstError instanceof Error ? { name: firstError.name, message: firstError.message } : null }) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (firstError !== undefined) throw firstError;
});
