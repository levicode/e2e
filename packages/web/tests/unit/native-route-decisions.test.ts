/** Public web() route choices over real NativeClient frames, not simulated browser semantics. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { NativeClient } from '../../src/native/client.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { web } from '../../src/index.ts';
import { nativeBrowser } from '../helpers/native-browser.ts';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'native-route-claim-')); roots.push(root);
  await writeFile(path.join(root, 'fixture.txt'), 'synthetic route file');
  const controller = new AbortController();
  const operation = (timeoutMs = 1_000): OperationContext => ({ signal: controller.signal, timeoutMs, runId: 'route-claim', attemptId: 'synthetic', origin: 'test' });
  const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 1_000 });
  const frames: Record<string, unknown>[] = [];
  const output = new PassThrough();
  const send = (message: unknown) => queueMicrotask(() => output.write(JSON.stringify(message) + '\n'));
  let hold: string | undefined;
  let held: (() => void) | undefined;
  let fail: string | undefined;
  let rejectDecision = false;
  let sequence = 0;
  let blob: Record<string, unknown> = {};
  let eventDone: Promise<void> = Promise.resolve();
  let finishEvent: (() => void) | undefined;
  vi.mocked(connectNativeProcess).mockReset().mockImplementation(async (options, context, onEvent) => {
    const input = new Writable({ write(chunk: Buffer, _encoding, done) {
      const frame = JSON.parse(chunk.toString()) as Record<string, unknown>; frames.push(frame);
      const command = frame['command']; const args = frame['args'] as Record<string, unknown>;
      let response: unknown;
      if (frame['type'] === 'hello') response = { type: 'ready', id: frame['id'], protocol: 'agent-browser-session/1', sessionId: 'route-claim-peer', generation: 1, capabilities: options.capabilities, limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' };
      else if (frame['type'] === 'close') response = { type: 'closed', id: frame['id'], generation: 1, scopeState: 'closed' };
      else if (frame['type'] === 'cancel') {
        const original = frames.find(item => item['type'] === 'request' && item['operationSeq'] === frame['operationSeq'])!;
        send({ type: 'result', id: original['id'], generation: 1, operationSeq: original['operationSeq'], ok: false, error: { code: 'cancelled' }, effects: 'not-dispatched', scopeState: 'usable' });
        response = { type: 'control-result', id: frame['id'], generation: 1, accepted: true, scopeState: 'usable' };
      }
      else if (frame['type'] === 'decision') {
        response = { type: 'control-result', id: frame['id'], generation: 1, accepted: !rejectDecision, ...(rejectDecision ? { error: { code: 'invalid-arguments' } } : {}), scopeState: 'usable' };
        rejectDecision = false;
      }
      else {
        let data: unknown = null;
        if (command === 'scope.open') data = { identityScope: 'scope-1', recoveryIdentity: { browser: 'browser-1', context: 'context-1', page: 'page-1' } };
        else if (command === 'blob.create') { blob = { handle: 'route-body', size: args['size'], sha256: args['sha256'] }; data = { ...blob, maxChunkBytes: 65536 }; }
        else if (command === 'blob.write') data = { nextOffset: Number(args['offset']) + Buffer.from(String(args['base64']), 'base64').length };
        else if (command === 'blob.seal') data = blob;
        else if (command === 'blob.release') data = { released: true };
        else if (command === 'page.title') data = { title: 'Synthetic title' };
        response = { type: 'result', id: frame['id'], generation: 1, operationSeq: frame['operationSeq'], ...(command === fail ? { ok: false, error: { code: 'browser-failure' }, effects: 'not-dispatched' } : { ok: true, data, effects: 'completed' }), scopeState: 'usable' };
      }
      if (hold === (command ?? frame['type'])) held = () => send(response); else send(response);
      done();
    } });
    return NativeClient.connect({ readable: output, writable: input, dispose: () => { input.destroy(); output.destroy(); } }, options.capabilities, context, async event => { try { await onEvent(event); } finally { finishEvent?.(); } });
  });
  const engine = web({});
  await engine.init!({ runId: 'route-claim', targetName: 'web', projectRoot: root, app: {}, env: {}, headed: false, workerSlot: 0, signal: controller.signal, log: () => {} });
  await engine.startAttempt!({ attemptId: 'synthetic', signal: controller.signal, artifactsDir: root, resolveSecret: async () => '', appLog: () => {}, navigation: () => {}, environment: () => {} });
  const browser = nativeBrowser(engine, operation, 'http://localhost/');
  return {
    browser, frames, controller,
    hold: (command: string) => { hold = command; },
    fail: (command: string) => { fail = command; },
    rejectDecision: () => { rejectDecision = true; },
    release: () => { hold = undefined; held?.(); held = undefined; },
    request: async (timeoutMs = 1_000) => {
      const registry = frames.findLast(frame => frame['command'] === 'network.routes.replace')!['args'] as Record<string, unknown>;
      eventDone = new Promise(resolve => { finishEvent = resolve; });
      send({ type: 'event', generation: 1, sequence: ++sequence, event: 'network.request', payload: { identityScope: 'scope-1', version: registry['version'], registrationIds: registry['registrationIds'], request: { url: 'http://localhost/data', method: 'GET', headers: {} } }, decision: { token: 'route-token', timeoutMs } });
      await turn();
    },
    done: () => eventDone,
    settle: () => engine.settleAttempt!(cleanup()),
    close: async () => { try { await engine.endAttempt!(cleanup()); } finally { await engine.dispose!(cleanup()); } },
  };
}

const decisions = (f: Awaited<ReturnType<typeof fixture>>) => f.frames.filter(frame => frame['type'] === 'decision').map(frame => frame['decision']);

describe('public native route decision lifetime', () => {
  it('keeps an unawaited file fulfillment alive through read and decision acknowledgment', async () => {
    const f = await fixture();
    try {
      f.hold('decision');
      await f.browser.route('**/data', route => { void route.fulfill({ path: 'fixture.txt' }); });
      await f.request();
      await vi.waitFor(() => expect(decisions(f)).toHaveLength(1));
      expect(decisions(f)).toEqual([{ kind: 'fulfill', status: 200, headers: [{ name: 'content-type', value: 'text/plain' }], bodyBase64: Buffer.from('synthetic route file').toString('base64') }]);
      let complete = false; void f.done().then(() => { complete = true; }); await turn();
      expect(complete).toBe(false);
      f.release(); await f.done(); await expect(f.settle()).resolves.toBeUndefined();
    } finally { f.release(); await f.close(); }
  });

  it('reserves file fulfillment before a second call and preserves the original duplicate wording', async () => {
    const f = await fixture();
    try {
      await f.browser.route('**/data', async route => {
        void route.fulfill({ path: 'fixture.txt' });
        await route.fulfill({ body: 'must not win' });
      });
      await f.request(); await f.done();
      await expect(f.settle()).rejects.toMatchObject({ code: 'ACTION_FAILED', message: 'route handler already decided; fulfill called twice' });
      expect(decisions(f)).toEqual([expect.objectContaining({ kind: 'fulfill', bodyBase64: Buffer.from('synthetic route file').toString('base64') })]);
    } finally { await f.close(); }
  });

  it.each(['fulfill', 'continue'] as const)('keeps unawaited large %s bodies alive through blob upload', async kind => {
    const f = await fixture();
    try {
      f.hold('blob.create');
      await f.browser.route('**/data', route => { void (kind === 'fulfill' ? route.fulfill({ body: 'x'.repeat(300000) }) : route.continue({ postData: 'x'.repeat(300000) })); });
      await f.request();
      expect(f.frames.some(frame => frame['command'] === 'blob.create')).toBe(true);
      expect(decisions(f)).toEqual([]);
      f.release(); await f.done(); await expect(f.settle()).resolves.toBeUndefined();
      expect(decisions(f)).toEqual([kind === 'fulfill' ? expect.objectContaining({ kind, bodyHandle: 'route-body' }) : { kind, overrides: { bodyHandle: 'route-body' } }]);
      expect(f.frames.filter(frame => frame['command'] === 'blob.write')).toHaveLength(5);
      expect(f.frames.filter(frame => frame['command'] === 'blob.release')).toHaveLength(0);
    } finally { f.release(); await f.close(); }
  });

  it('waits for a selected choice when the handler throws, without competing abort', async () => {
    const f = await fixture(); const primary = new Error('synthetic handler failure');
    try {
      f.hold('decision');
      await f.browser.route('**/data', route => { void route.fulfill({ path: 'fixture.txt' }); throw primary; });
      await f.request(); await vi.waitFor(() => expect(decisions(f)).toHaveLength(1));
      let complete = false; void f.done().then(() => { complete = true; }); await turn(); expect(complete).toBe(false);
      f.release(); await f.done(); await expect(f.settle()).rejects.toBe(primary);
      expect(decisions(f)).toEqual([expect.objectContaining({ kind: 'fulfill' })]);
    } finally { f.release(); await f.close(); }
  });

  it('releases a failed unawaited upload and aborts before submission, preserving its original failure', async () => {
    const f = await fixture();
    try {
      f.fail('blob.seal');
      await f.browser.route('**/data', route => { void route.fulfill({ body: 'x'.repeat(300000) }); });
      await f.request(); await f.done();
      await expect(f.settle()).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
      expect(f.frames.filter(frame => frame['command'] === 'blob.release')).toHaveLength(1);
      expect(decisions(f)).toEqual([{ kind: 'abort' }]);
    } finally { await f.close(); }
  });

  it('observes an unawaited file read failure and aborts without replacing its original error', async () => {
    const f = await fixture(); const primary = new Error('synthetic file read failure');
    try {
      vi.mocked(readFile).mockRejectedValueOnce(primary);
      await f.browser.route('**/data', route => { void route.fulfill({ path: 'fixture.txt' }); });
      await f.request(); await f.done(); await expect(f.settle()).rejects.toBe(primary);
      expect(decisions(f)).toEqual([{ kind: 'abort' }]);
    } finally { await f.close(); }
  });

  it('uses the original callback budget for every upload frame after a delayed handler', async () => {
    const f = await fixture();
    try {
      f.hold('blob.create');
      await f.browser.route('**/data', async route => {
        await new Promise(resolve => setTimeout(resolve, 40));
        void route.fulfill({ body: 'x'.repeat(300000) });
      });
      await f.request(500);
      await vi.waitFor(() => expect(f.frames.some(frame => frame['command'] === 'blob.create')).toBe(true));
      const create = f.frames.find(frame => frame['command'] === 'blob.create')!;
      expect(Number(create['timeoutMs'])).toBeLessThanOrEqual(470);
      await new Promise(resolve => setTimeout(resolve, 40));
      f.release(); await f.done(); await expect(f.settle()).resolves.toBeUndefined();
      const upload = f.frames.filter(frame => String(frame['command']).startsWith('blob.'));
      expect(upload.every(frame => frame['callbackToken'] === 'route-token')).toBe(true);
      expect(upload.slice(1).every(frame => Number(frame['timeoutMs']) < Number(create['timeoutMs']))).toBe(true);
    } finally { f.release(); await f.close(); }
  });

  it('does not extend the original deadline while the selected upload is still pending', async () => {
    const f = await fixture();
    try {
      f.hold('blob.create');
      await f.browser.route('**/data', route => { void route.fulfill({ body: 'x'.repeat(300000) }); });
      await f.request(60); await f.done();
      await expect(f.settle()).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
      expect(f.frames.filter(frame => frame['command'] === 'blob.create')).toHaveLength(1);
      expect(f.frames.some(frame => frame['command'] === 'blob.write')).toBe(false);
      expect(decisions(f)).toEqual([]);
    } finally { await f.close().catch(() => undefined); }
  });

  it('does not dispatch after a delayed file read resolves beyond the original deadline', async () => {
    const f = await fixture(); let finishRead!: (bytes: Buffer<ArrayBuffer>) => void;
    const reading = new Promise<Buffer<ArrayBuffer>>(resolve => { finishRead = resolve; });
    try {
      vi.mocked(readFile).mockReturnValueOnce(reading);
      await f.browser.route('**/data', route => { void route.fulfill({ path: 'fixture.txt' }); });
      await f.request(60); await f.done();
      await expect(f.settle()).rejects.toMatchObject({ code: 'ACTION_FAILED', message: 'route handler exceeded its decision deadline' });
      finishRead(Buffer.from('synthetic route file')); await turn();
      expect(decisions(f)).toEqual([]);
      expect(f.frames.some(frame => String(frame['command']).startsWith('blob.'))).toBe(false);
    } finally { finishRead(Buffer.from('synthetic route file')); await f.close().catch(() => undefined); }
  });

  it('preserves cancellation while an unawaited selected upload settles, without replay or competing abort', async () => {
    const f = await fixture();
    try {
      f.hold('blob.create');
      await f.browser.route('**/data', route => { void route.continue({ postData: 'x'.repeat(300000) }); });
      await f.request(); f.controller.abort(); await f.done(); await turn();
      await expect(f.settle()).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(f.frames.filter(frame => frame['type'] === 'cancel')).toHaveLength(1);
      expect(f.frames.filter(frame => frame['command'] === 'blob.create')).toHaveLength(1);
      expect(f.frames.some(frame => frame['command'] === 'blob.write')).toBe(false);
      expect(decisions(f)).toEqual([]);
    } finally { await f.close().catch(() => undefined); }
  });

  it.each([false, true])('aborts only after an explicit decision rejection, releasing a staged body when large=%s', async large => {
    const f = await fixture();
    try {
      f.rejectDecision();
      await f.browser.route('**/data', route => { void route.fulfill({ body: large ? 'x'.repeat(300000) : 'small' }); });
      await f.request(); await f.done();
      await expect(f.settle()).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: 'The native browser rejected an expired or invalid decision' });
      expect(decisions(f)).toEqual([expect.objectContaining({ kind: 'fulfill' }), { kind: 'abort' }]);
      expect(f.frames.filter(frame => frame['command'] === 'blob.release')).toHaveLength(large ? 1 : 0);
    } finally { await f.close(); }
  });

  it('never aborts or replays a submitted choice when its acknowledgment remains uncertain', async () => {
    const f = await fixture();
    try {
      f.hold('decision');
      await f.browser.route('**/data', route => { void route.fulfill({ body: 'synthetic response' }); });
      await f.request(60); await f.done();
      await expect(f.settle()).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
      expect(decisions(f)).toEqual([expect.objectContaining({ kind: 'fulfill' })]);
    } finally { await f.close().catch(() => undefined); }
  });

  it('validates before reserving a choice, so a handled invalid option can still abort', async () => {
    const f = await fixture();
    try {
      await f.browser.route('**/data', async route => {
        await expect(route.fulfill({ status: 999 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
        await route.abort();
      });
      await f.request(); await f.done(); await expect(f.settle()).resolves.toBeUndefined();
      expect(decisions(f)).toEqual([{ kind: 'abort' }]);
    } finally { await f.close(); }
  });
});
