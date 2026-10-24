/** State proof through the public engine, with an independent app-server readback. */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { web } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const APP = `<!doctype html><link rel="icon" href="data:,"><script>
(async () => {
  const phase = new URL(location.href).searchParams.get('phase');
  const first = { cookie: document.cookie, local: localStorage.getItem('native-fixture') };
  try {
    if (phase === 'seed') { document.cookie = 'native-fixture=synthetic; Path=/; SameSite=Lax'; localStorage.setItem('native-fixture', 'stored'); }
    let created = false;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('native-roundtrip', phase === 'seed' ? 3 : undefined);
      request.onupgradeneeded = () => { created = true; const store = request.result.createObjectStore('records', { keyPath: 'id' }); store.createIndex('byLabel', 'label', { unique: true }); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    if (phase === 'seed') {
      const record = { id: 'main', label: 'persisted', typed: new Uint16Array([1, 65535]), blob: new Blob(['fixture-payload'], { type: 'text/plain' }) }; record.self = record;
      await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(record); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    }
    const store = db.transaction('records').objectStore('records');
    const value = await new Promise((resolve, reject) => { const request = store.index('byLabel').get('persisted'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const report = { phase, first, created, version: db.version, indexes: Array.from(store.indexNames), record: value ? { cycle: value.self === value, typedKind: value.typed.constructor.name, typed: Array.from(value.typed), blob: await value.blob.text(), blobType: value.blob.type } : null };
    db.close();
    await fetch('/report', { method: 'POST', body: JSON.stringify(report) });
  } catch (error) { await fetch('/report', { method: 'POST', body: JSON.stringify({ phase, error: String(error) }) }); }
})();
</script>`;

it('restores cookies, local storage and structured IndexedDB before the first app script without bootstrap requests', async () => {
  const binary = process.env['E2E_AGENT_BROWSER_EXECUTABLE'];
  if (!binary) throw new Error('Native state acceptance requires E2E_AGENT_BROWSER_EXECUTABLE; it cannot silently skip');
  const nativeEnv = {
    E2E_AGENT_BROWSER_EXECUTABLE: binary,
    CI: process.env['CI'],
    HOME: process.env['HOME'],
    PATH: process.env['PATH'],
    TMPDIR: process.env['TMPDIR'],
    TMP: process.env['TMP'],
    TEMP: process.env['TEMP'],
    AGENT_BROWSER_SOCKET_DIR: process.env['AGENT_BROWSER_SOCKET_DIR'],
  };
  const reports = new Map<string, unknown>();
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '/');
    if (request.url === '/report') {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        const report = JSON.parse(body) as { phase: string };
        reports.set(report.phase, report);
        response.end('recorded');
      });
    } else { response.writeHead(200, { 'content-type': 'text/html' }); response.end(APP); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const artifactsDir = mkdtempSync(join(tmpdir(), 'native-state-'));
  const engine = web();
  const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 10_000, runId: 'state-contract', attemptId: 'state', origin: 'test' });
  const readback = async (phase: string): Promise<unknown> => {
    await expect.poll(() => reports.has(phase), { timeout: 5_000 }).toBe(true);
    return reports.get(phase);
  };
  try {
    await engine.init!({ runId: 'state-contract', targetName: 'web', projectRoot: process.cwd(), app: { site: '127.0.0.1' }, env: nativeEnv, headed: false, workerSlot: 0, log: () => undefined, signal: new AbortController().signal });
    await engine.startAttempt!({ attemptId: 'state', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!(`${origin}/?phase=seed`, operation());
    expect(await readback('seed')).not.toHaveProperty('error');
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(engine.state!.capture({ ...operation(), signal: cancelled.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    const state = await engine.state!.capture(operation());
    await engine.session!.reset!(operation());
    await engine.session!.open!(`${origin}/?phase=empty`, operation());
    expect(await readback('empty')).toMatchObject({ first: { cookie: '', local: null }, record: null });
    const beforeRestore = [...requests];
    await engine.state!.restore(state, operation());
    expect(requests, 'state bootstrap must not navigate or call the application server').toEqual(beforeRestore);
    await engine.session!.open!(`${origin}/?phase=restored`, operation());
    expect(await readback('restored')).toEqual({ phase: 'restored', first: { cookie: 'native-fixture=synthetic', local: 'stored' }, created: false, version: 3, indexes: ['byLabel'], record: { cycle: true, typedKind: 'Uint16Array', typed: [1, 65535], blob: 'fixture-payload', blobType: 'text/plain' } });
  } finally {
    try { await engine.endAttempt!({ signal: new AbortController().signal, timeoutMs: 10_000 }); }
    finally {
      try { await engine.dispose!({ signal: new AbortController().signal, timeoutMs: 10_000 }); }
      finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    }
  }
});
