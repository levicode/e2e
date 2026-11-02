import { PassThrough, Writable } from 'node:stream';
import { NativeClient } from '../../src/native/client.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindBenchmarkIframeProcess, beginBenchmarkIframeAttempt, observeBenchmarkIframeResult, observeBenchmarkIframeTerminal } from '../../src/native/benchmark-iframe-diagnostics.ts';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'iframe-closed-')); roots.push(root);
  const capture = path.join(root, 'evidence/benchmark-iframe'); mkdirSync(capture, { recursive: true, mode: 0o700 });
  vi.stubEnv('GITHUB_WORKSPACE', root); vi.stubEnv('E2E_BENCHMARK_IFRAME_CAPTURE', '1');
  const artifacts = path.join(root, 'apps/web-benchmark/.e2e/results/iframe-form-iframe-form-the-code-read-from-d99d69d8e6ab5f0e/attempt-1');
  return { capture, artifacts };
}
const result = { type: 'result' as const, id: 'SECRET', generation: 1, operationSeq: 7, ok: false, error: { code: 'cleanup-failed' }, effects: 'unknown' as const, scopeState: 'quarantined' as const, data: { secret: 'SECRET' } };
it('joins only exact client and attempt receipts without payload or identifiers', () => {
  const { capture, artifacts } = setup(); const client = {}; bindBenchmarkIframeProcess(client, 123);
  beginBenchmarkIframeAttempt(client, 'SECRET', artifacts);
  observeBenchmarkIframeResult(client, 'wrong', 'browser.trace', result);
  observeBenchmarkIframeResult({}, 'SECRET', 'browser.trace', result);
  observeBenchmarkIframeResult(client, 'SECRET', 'page.navigate', result);
  observeBenchmarkIframeResult(client, 'SECRET', 'browser.trace', result);
  observeBenchmarkIframeTerminal(client, 'cleanup-failed');
  const rows = readFileSync(path.join(capture, readdirSync(capture)[0]!), 'utf8');
  expect(rows).not.toContain('SECRET'); expect(rows.trim().split('\n')).toHaveLength(3);
  expect(JSON.parse(rows.trim().split('\n')[1]!)).toMatchObject({ kind: 'result', command: 'browser.trace', operationSeq: 7, code: 'cleanup-failed', attempt: 1 });
});
it('does not borrow worker binding for another case or later attempt', () => {
  const { capture, artifacts } = setup(); const client = {}; bindBenchmarkIframeProcess(client, 123);
  beginBenchmarkIframeAttempt(client, 'one', artifacts.replace('d99d69d8e6ab5f0e', 'wrong'));
  observeBenchmarkIframeTerminal(client, 'cleanup-failed'); expect(readdirSync(capture)).toEqual([]);
  beginBenchmarkIframeAttempt(client, 'one', artifacts);
  beginBenchmarkIframeAttempt(client, 'other', '/some/other/test');
  observeBenchmarkIframeTerminal(client, 'cleanup-failed');
  expect(readFileSync(path.join(capture, readdirSync(capture)[0]!), 'utf8').trim().split('\n')).toHaveLength(1);
});
it('stays disabled without opt-in and caps output without leaking unknown code', () => {
  const { capture, artifacts } = setup(); const client = {};
  vi.stubEnv('E2E_BENCHMARK_IFRAME_CAPTURE', '0'); bindBenchmarkIframeProcess(client, 123); beginBenchmarkIframeAttempt(client, 'one', artifacts); expect(readdirSync(capture)).toEqual([]);
  vi.stubEnv('E2E_BENCHMARK_IFRAME_CAPTURE', '1'); bindBenchmarkIframeProcess(client, 123); beginBenchmarkIframeAttempt(client, 'one', artifacts);
  for (let i = 0; i < 200; i++) observeBenchmarkIframeTerminal(client, 'SECRET');
  const rows = readFileSync(path.join(capture, readdirSync(capture)[0]!), 'utf8'); expect(rows).not.toContain('SECRET'); expect(rows.trim().split('\n')).toHaveLength(128);
});

it('captures validated real NativeClient receipt and terminal refusal on the exact bound owner', async () => {
  const { capture, artifacts } = setup(); const output = new PassThrough(); const requests: Record<string, unknown>[] = [];
  const input = new Writable({ write(chunk: Buffer, _encoding, done) { requests.push(JSON.parse(chunk.toString()) as Record<string, unknown>); done(); } });
  const operation = { attemptId: 'owned', runId: 'run', origin: 'test' as const, signal: new AbortController().signal, timeoutMs: 1000 };
  const send = (row: unknown) => output.write(JSON.stringify(row) + '\n');
  const connecting = NativeClient.connect({ readable: output, writable: input, dispose() { input.destroy(); output.destroy(); } }, ['terminal.close/1'], operation, () => {});
  send({ type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1', sessionId: 'synthetic', generation: 1, capabilities: ['terminal.close/1'], limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
  const client = await connecting; bindBenchmarkIframeProcess(client, 123); beginBenchmarkIframeAttempt(client, 'owned', artifacts);
  const action = client.request('browser.trace', { identityScope: 'SECRET' }, operation); const request = requests.at(-1)!;
  send({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: false, error: { code: 'cleanup-failed' }, effects: 'unknown', scopeState: 'quarantined' });
  await expect(action).resolves.toMatchObject({ ok: false, scopeState: 'quarantined' });
  const closing = client.close(operation); const rejected = expect(closing).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  send({ type: 'error', error: { code: 'cleanup-failed' }, scopeState: 'quarantined' }); await rejected;
  const text = readFileSync(path.join(capture, readdirSync(capture)[0]!), 'utf8'); expect(text).not.toContain('SECRET');
  expect(text.trim().split('\n').map(line => JSON.parse(line).kind)).toEqual(['start', 'result', 'terminal-error']);
});
