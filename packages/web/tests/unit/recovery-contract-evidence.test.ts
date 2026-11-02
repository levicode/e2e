import { PassThrough, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NativeClient } from '../../src/native/client.ts';
import { retainP07Contract } from '../helpers/recovery-contract-evidence.ts';
import { observeNativeTerminalClose, terminalCloseEvidence } from '../helpers/native-terminal-close-observer.ts';
const sources = ['../integration/cdp-recovery.test.ts', './recovery-contract-evidence.ts', './native-terminal-close-observer.ts', './synthetic-native-outcomes.ts', './synthetic-evidence.ts', '../../src/native/client.ts'];
const identity = () => ({ sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), worktreeDirty: false, nativeBinarySha256: 'c'.repeat(64), sources: sources.map(file => ({ file, sha256: 'd'.repeat(64) })) });
const contract = () => ({ schemaVersion: 1, caseId: 'P07', invalid: false, facts: [], terminalCleanup: terminalCloseEvidence() });
const outcome = { setup: 'passed', body: 'passed', cleanup: 'failed' };
it.each(['closed', 'native-error'] as const)('prints the actual NativeClient terminal observer on %s without replacing its Promise/error', async fault => {
  const evidence = contract(); const output = new PassThrough(); const requests: Record<string, unknown>[] = [];
  const input = new Writable({ write(chunk: Buffer, _encoding, done) { requests.push(JSON.parse(chunk.toString()) as Record<string, unknown>); done(); } });
  const context = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'test', attemptId: 'test', origin: 'test' as const };
  const send = (value: unknown) => output.write(JSON.stringify(value) + '\n');
  const connecting = NativeClient.connect({ readable: output, writable: input, dispose() { input.destroy(); output.destroy(); } }, ['terminal.close/1'], context, () => {});
  send({ type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1', sessionId: 'test', generation: 1, capabilities: ['terminal.close/1'], limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
  const client = await connecting; const restore = observeNativeTerminalClose(client, evidence.terminalCleanup);
  const closing = client.close(context); expect(client.close(context)).toBe(closing);
  const settled = closing.then(() => undefined, cause => cause);
  if (fault === 'closed') send({ type: 'closed', id: requests.at(-1)!['id'], generation: 1, scopeState: 'closed' });
  else send({ type: 'error', id: requests.at(-1)!['id'], error: { code: 'cleanup-failed' }, scopeState: 'quarantined' });
  const original = await settled; restore();
  const lines: string[] = []; retainP07Contract(evidence, { ...outcome, cleanup: fault === 'closed' ? 'passed' : 'failed' }, line => lines.push(line), identity);
  const parsed = JSON.parse(lines[0]!.slice('P07_RECOVERY_CONTRACT '.length));
  expect(parsed).toMatchObject({ invalid: false, nativeOrigin: 'unknown', contract: { caseId: 'P07', terminalCleanup: { exchanges: 1, pending: 0, validatedClosed: fault === 'closed' ? 1 : 0, settled: fault === 'closed' ? 'fulfilled' : 'rejected' } } });
  if (fault === 'native-error') expect(original).toMatchObject({ code: 'ENGINE_FAILURE' }); else expect(original).toBeUndefined();
  expect(requests.filter(value => value['type'] === 'close')).toHaveLength(1);
});
it.each(['contract-extra', 'outcome-extra', 'identity-extra', 'getter', 'toJSON', 'wrong-case', 'bad-phase', 'bad-count', 'source-mismatch'] as const)('retains explicit invalidity without leaking %s', kind => {
  const value: unknown = contract(); let result: unknown = outcome; let id: unknown = identity();
  if (kind === 'contract-extra') Object.assign(value!, { secret: 'CANARY' });
  if (kind === 'outcome-extra') result = { ...outcome, secret: 'CANARY' };
  if (kind === 'identity-extra') id = { ...identity(), secret: 'CANARY' };
  if (kind === 'getter') Object.defineProperty(value, 'facts', { enumerable: true, get() { throw new Error('CANARY'); } });
  if (kind === 'toJSON') Object.assign(value!, { toJSON: () => 'CANARY' });
  if (kind === 'wrong-case') Object.assign(value!, { caseId: 'P08' });
  if (kind === 'bad-phase') result = { ...outcome, body: 'CANARY' };
  if (kind === 'bad-count') Object.assign((value as ReturnType<typeof contract>).terminalCleanup, { exchanges: -1 });
  if (kind === 'source-mismatch') id = { ...identity(), sources: [{ file: 'CANARY', sha256: 'd'.repeat(64) }] };
  const lines: string[] = []; expect(() => retainP07Contract(value, result, line => lines.push(line), () => id)).not.toThrow();
  expect(lines).toHaveLength(1); expect(lines[0]).not.toContain('CANARY'); expect(JSON.parse(lines[0]!.slice('P07_RECOVERY_CONTRACT '.length)).invalid).toBe(true);
});
it('unavailable identity and failing output never replace business failure', () => {
  const emit = vi.fn(() => { throw new Error('output unavailable'); });
  expect(() => retainP07Contract(contract(), outcome, emit, () => { throw new Error('identity unavailable'); })).not.toThrow();
  expect(emit).toHaveBeenCalledOnce();
});
it('actually retains P07 before the original afterEach failure throw', () => {
  const source = readFileSync(new URL('../integration/cdp-recovery.test.ts', import.meta.url), 'utf8');
  expect(source).toContain("if (contract?.caseId === 'P07') retainP07Contract(contract, diagnostic?.outcome);\n    if (failures.length > 0) throw new AggregateError(failures, 'Recovery fixture cleanup failed');");
});
it('default identity records actual local source hashes without claiming a native binary exists', () => {
  const lines: string[] = []; retainP07Contract(contract(), outcome, line => lines.push(line));
  const result = JSON.parse(lines[0]!.slice('P07_RECOVERY_CONTRACT '.length));
  expect(result.identity.sourceCommit).toMatch(/^[a-f0-9]{40}$/); expect(result.identity.sources).toHaveLength(6);
});
