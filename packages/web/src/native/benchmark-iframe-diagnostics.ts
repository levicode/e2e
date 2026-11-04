/** Exact benchmark-case observation only. No execution, retry, or cleanup authority. */
import { constants, closeSync, fstatSync, lstatSync, openSync, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { NativeResult } from './protocol.ts';
const CASE = 'iframe-form-iframe-form-the-code-read-from-d99d69d8e6ab5f0e';
const processes = new WeakMap<object, number>();
const owners = new WeakMap<object, { id: string; attempt: number; rows: number; pid: number }>();
const commands = new Set(['browser.perform', 'browser.trace', 'browser.observe', 'fixture.query', 'fixture.read-fields', 'scope.end']);
const codes = new Set(['cleanup-failed', 'stale-reference', 'scope-unavailable', 'stale-scope', 'cancelled', 'deadline-exceeded', 'browser-failure', 'frame-not-found', 'invalid-frame']);
function directory(): string | undefined {
  if (process.env['E2E_BENCHMARK_IFRAME_CAPTURE'] !== '1') return;
  const workspace = process.env['GITHUB_WORKSPACE'];
  if (workspace === undefined || !path.isAbsolute(workspace)) return;
  const root = path.join(workspace, 'evidence/benchmark-iframe');
  try { const st = lstatSync(root); if (realpathSync(root) !== root || !st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o700 || st.uid !== process.getuid?.()) return; } catch { return; }
  return root;
}
function emit(client: object, fields: Record<string, string | number | boolean>): void {
  try {
    const root = directory(); const owner = owners.get(client);
    if (root === undefined || owner === undefined || owner.rows >= 128) return;
    const row = { v: 1, case: 'iframe-correct-code', proxyPid: owner.pid, attempt: owner.attempt, record: owner.rows++, ...fields };
    const file = path.join(root, `client-${owner.pid}-attempt-${owner.attempt}.jsonl`);
    const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const st = fstatSync(fd); if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || st.size > 65536) return; writeSync(fd, JSON.stringify(row) + '\n'); } finally { closeSync(fd); }
  } catch { /* Capture failure never changes a business result. */ }
}
export function bindBenchmarkIframeProcess(client: object, pid: number | undefined): void {
  if (directory() !== undefined && Number.isSafeInteger(pid) && pid! > 0) processes.set(client, pid!);
}
export function beginBenchmarkIframeAttempt(client: object | undefined, attemptId: string, artifactsDir: string): void {
  if (client === undefined) return;
  owners.delete(client);
  try {
    const root = directory(); const pid = processes.get(client); const workspace = process.env['GITHUB_WORKSPACE'];
    if (root === undefined || pid === undefined || workspace === undefined) return;
    const parent = path.join(workspace, 'apps/web-benchmark/.e2e/results', CASE);
    const relative = path.relative(parent, artifactsDir);
    if (!/^attempt-[12]$/.test(relative) || path.join(parent, relative) !== artifactsDir) return;
    const attempt = Number(relative.slice(8));
    const fd = openSync(path.join(root, `client-${pid}-attempt-${attempt}.jsonl`), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); closeSync(fd);
    owners.set(client, { id: attemptId, attempt, pid, rows: 0 }); emit(client, { kind: 'start' });
  } catch { /* An unavailable exact binding stays absent. */ }
}
export function observeBenchmarkIframeResult(client: object, attemptId: string, command: unknown, result: NativeResult): void {
  const owner = owners.get(client);
  if (owner?.id !== attemptId || typeof command !== 'string' || !commands.has(command)) return;
  emit(client, { kind: 'result', command, generation: result.generation, operationSeq: result.operationSeq, ok: result.ok, effects: result.effects, scopeState: result.scopeState,
    code: result.ok ? 'none' : codes.has(result.error?.code ?? '') ? result.error!.code : 'unknown' });
}
export function observeBenchmarkIframeTerminal(client: object, code: string): void {
  emit(client, { kind: 'terminal-error', code: codes.has(code) ? code : 'unknown' });
}
