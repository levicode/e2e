/** Actual production client/channel/Browser fixture over a synthetic native wire peer. */
import { PassThrough, Writable } from 'node:stream';
import { vi } from 'vitest';
import type { EngineFixtureContext, OperationContext } from 'e2e/engine';
import { createBrowserFixture } from '../../src/browser.ts';
import type { DialogHandler } from '../../src/dialog-types.ts';
import { ErrorLatch } from '../../src/runtime-support.ts';
import { NativeClient } from '../../src/native/client.ts';
import { BrowserChannel } from '../../src/native/browser-channel.ts';
import type { NativeWebSurface } from '../../src/native/browser-contract.ts';

export function nativeDialog(message = 'are you sure?') {
  const accept = vi.fn(async (_text?: string): Promise<void> => undefined);
  const dismiss = vi.fn(async (): Promise<void> => undefined);
  return { dialog: { kind: 'confirm', message, accept, dismiss, uncertain: false }, accept, dismiss };
}
type DialogInput = ReturnType<typeof nativeDialog>['dialog'];
export async function dialogPeer(latch = new ErrorLatch()) {
  const output = new PassThrough(); const requests: Record<string, unknown>[] = [];
  const dialogs = new Map<string, DialogInput>();
  const completions = new Map<string, () => void>();
  const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' });
  const send = (message: unknown) => output.write(JSON.stringify(message) + '\n');
  const input = new Writable({ write(chunk: Buffer, _encoding, done) {
    const frame = JSON.parse(chunk.toString()) as Record<string, unknown>; requests.push(frame);
    if (frame['type'] === 'hello') queueMicrotask(() => send({ type: 'ready', id: frame['id'], protocol: 'agent-browser-session/1', sessionId: 'dialog-peer', generation: 1, capabilities: [], limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' }));
    else if (frame['type'] === 'close') send({ type: 'closed', id: frame['id'], generation: 1, scopeState: 'closed' });
    else if (frame['type'] === 'request') send({ type: 'result', id: frame['id'], generation: 1, operationSeq: frame['operationSeq'], ok: true, data: null, effects: 'completed', scopeState: 'usable' });
    else if (frame['type'] === 'decision') {
      const dialog = dialogs.get(String(frame['token']))!;
      const decision = frame['decision'] as { accept: boolean; promptText?: string };
      if (dialog.uncertain) { output.end(); done(); return; }
      const answer = decision.accept ? dialog.accept(decision.promptText) : dialog.dismiss();
      void answer.then(() => true, () => false).then(accepted => send({ type: 'control-result', id: frame['id'], generation: 1, accepted, ...(accepted ? {} : { error: { code: 'browser-failure' } }), scopeState: 'usable' }));
    }
    done();
  } });
  let channel: BrowserChannel;
  const client = await NativeClient.connect({ readable: output, writable: input, dispose: () => { input.destroy(); output.destroy(); } }, [], operation(), async event => {
    try { await channel.dispatch(event); } finally { completions.get(event.decision!.token)?.(); }
  });
  channel = new BrowserChannel(client, { identityScope: () => 'scope', operation });
  const surface: NativeWebSurface = {
    identityScope: 'scope', latch, latchCallbackFailure: (_scope, error) => latch.latch(error),
    routeRegistryVersion: () => 0, allocateRouteRegistryVersion: () => 1,
    invalidate: () => channel.invalidate(), command: (name, args, context) => channel.command(name, args, context),
    decide: (token, decision, context) => channel.decide(token, decision, context), subscribe: (name, callback) => channel.subscribe(name, callback),
    projectPath: file => file, siteHeaders: () => undefined, artifactPath: () => { throw new Error('No artifacts in dialog peer'); },
  };
  const context = { operation, signal: operation().signal, timeouts: { action: 1000, test: 5000, assertion: 1000 }, fixture: (_name: string, value: object) => value, expectable: (value: object) => value, app: { resolveUrl: (url: string) => url } } as unknown as EngineFixtureContext;
  const browser = createBrowserFixture(surface, context); let sequence = 0;
  return {
    add: (handler: DialogHandler) => browser.onDialog(handler), throwPending: () => latch.throwPending(), requests,
    dispatch(dialog: DialogInput): Promise<void> {
      const token = `dialog-${++sequence}`; dialogs.set(token, dialog);
      const done = new Promise<void>(resolve => completions.set(token, resolve));
      send({ type: 'event', generation: 1, sequence, event: 'dialog.opened', payload: { identityScope: 'scope', type: dialog.kind, message: dialog.message }, decision: { token, timeoutMs: 1000 } });
      return done;
    },
    async close() { channel.dispose(); try { await client.close(operation()); } finally { input.destroy(); output.destroy(); } },
  };
}
