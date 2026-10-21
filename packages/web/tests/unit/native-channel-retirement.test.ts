import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { BrowserChannel } from '../../src/native/browser-channel.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { NativeProtocolPeer, type PeerOutcome } from '../helpers/native-protocol-peer.ts';

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'retirement-run', attemptId: 'retirement-attempt', origin: 'test' });
const unknown: PeerOutcome = { error: 'deadline-exceeded', effects: 'unknown', scopeState: 'quarantined' };
const bytes = Buffer.from('synthetic upload');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const uploadOutcome = (command: string): PeerOutcome => {
  if (command === 'blob.create') return { data: { handle: 'upload', size: bytes.length, sha256, maxChunkBytes: 262144 } };
  if (command === 'blob.write') return { data: { nextOffset: bytes.length } };
  if (command === 'blob.seal') return { data: { handle: 'upload', size: bytes.length, sha256 } };
  return { data: null };
};

/** Delay one real framed response until its captured JS owner has retired. */
async function opened(delayedCommand: string) {
  let arrive!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; });
  let respond!: (outcome: PeerOutcome) => void;
  const response = new Promise<PeerOutcome>(resolve => { respond = resolve; });
  const peer = new NativeProtocolPeer([], command => {
    if (command.command === delayedCommand) { arrive(); return response; }
    return uploadOutcome(command.command);
  });
  const dispose = vi.spyOn(peer, 'dispose');
  const client = await peer.connect(operation(), () => {});
  let scope = 'scope';
  let epoch = 0;
  const engine = new EngineChannel(client, expectedScope => {
    const captured = epoch;
    return () => epoch === captured && scope === expectedScope;
  });
  const browser = new BrowserChannel(client, { identityScope: () => scope, operation });
  const retire = (kind: 'owner' | 'scope') => {
    if (kind === 'scope') scope = 'replacement';
    else { epoch++; browser.dispose(); }
  };
  return { peer, client, engine, browser, dispose, arrived, respond, retire };
}

async function expectQuarantined(fixture: Awaited<ReturnType<typeof opened>>, commands: readonly string[]) {
  expect(fixture.dispose).toHaveBeenCalledOnce();
  const frames = fixture.peer.frames.length;
  await expect(fixture.client.request('synthetic.probe', {}, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
  await expect(fixture.client.close(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  expect(fixture.peer.frames).toHaveLength(frames);
  expect(fixture.peer.requests.map(request => request.command)).toEqual(commands);
}

describe.each(['owner', 'scope'] as const)('native outcomes after %s retirement', retirement => {
  it.each(['engine', 'browser'] as const)('preserves validated Unknown from a delayed %s action without another write', async channel => {
    const command = channel === 'engine' ? 'browser.perform' : 'page.reload';
    const fixture = await opened(command);
    const published = vi.fn();
    const pending = (channel === 'engine'
      ? fixture.engine.command('browser.perform', { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind: 'tap' } }, operation())
      : fixture.browser.command('page.reload', {}, operation())).then(published);
    await fixture.arrived;
    fixture.retire(retirement);
    fixture.respond(unknown);
    await expect(pending).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(published).not.toHaveBeenCalled();
    await expectQuarantined(fixture, [command]);
  });

  it.each(['scope.reset', 'scope.end'] as const)('preserves delayed Unknown from %s with a callback transition', async command => {
    const fixture = await opened(command);
    const published = vi.fn();
    const pending = fixture.engine.command(command, { identityScope: 'scope' }, operation(), fixture.client.callbackCheckpoint()).then(published);
    await fixture.arrived;
    fixture.retire(retirement);
    fixture.respond(unknown);
    await expect(pending).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(published).not.toHaveBeenCalled();
    await expectQuarantined(fixture, [command]);
  });

  it.each(['blob.create', 'blob.write', 'blob.seal'] as const)('preserves delayed Unknown from %s without continuing or cleaning up a retired upload', async command => {
    const fixture = await opened(command);
    const consume = vi.fn();
    const pending = fixture.engine.withUpload(bytes, operation(), consume, 'scope');
    await fixture.arrived;
    fixture.retire(retirement);
    fixture.respond(unknown);
    await expect(pending).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(consume).not.toHaveBeenCalled();
    const commands = ['blob.create', 'blob.write', 'blob.seal'];
    await expectQuarantined(fixture, commands.slice(0, commands.indexOf(command) + 1));
  });

  it.each([
    ['success', { data: null }],
    ['known rejection', { error: 'not-actionable', effects: 'not-dispatched' }],
    ['known completed failure', { error: 'not-actionable', effects: 'completed' }],
  ] satisfies [string, PeerOutcome][])('still rejects stale %s before engine/browser publication', async (_name, outcome) => {
    for (const channel of ['engine', 'browser'] as const) {
      const command = channel === 'engine' ? 'browser.perform' : 'page.reload';
      const fixture = await opened(command);
      const published = vi.fn();
      const pending = (channel === 'engine'
        ? fixture.engine.command('browser.perform', { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind: 'tap' } }, operation())
        : fixture.browser.command('page.reload', {}, operation())).then(published);
      await fixture.arrived;
      fixture.retire(retirement);
      fixture.respond(outcome);
      await expect(pending).rejects.toMatchObject({ code: channel === 'engine' ? 'CANCELLED' : 'INVALID_STATE', retryable: false });
      expect(published).not.toHaveBeenCalled();
      expect(fixture.peer.requests.map(request => request.command)).toEqual([command]);
      expect(fixture.dispose).not.toHaveBeenCalled();
      await expect(fixture.client.request('synthetic.probe', {}, operation())).resolves.toMatchObject({ ok: true });
      await fixture.client.close(operation());
    }
  });

  it.each(['scope.reset', 'scope.end'] as const)('still rejects stale known %s outcomes and closes its publication barrier', async command => {
    for (const outcome of [
      { data: command === 'scope.reset' ? { identityScope: 'replacement' } : null },
      { error: 'not-actionable', effects: 'not-dispatched' },
      { error: 'not-actionable', effects: 'completed' },
    ] satisfies PeerOutcome[]) {
      const fixture = await opened(command);
      const published = vi.fn();
      const pending = fixture.engine.command(command, { identityScope: 'scope' }, operation(), fixture.client.callbackCheckpoint()).then(published);
      await fixture.arrived;
      fixture.retire(retirement);
      fixture.respond(outcome);
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
      expect(published).not.toHaveBeenCalled();
      await expectQuarantined(fixture, [command]);
    }
  });

  it.each(['blob.create', 'blob.write', 'blob.seal'] as const)('still refuses stale known %s outcomes without upload publication or cleanup', async command => {
    for (const outcome of [
      uploadOutcome(command),
      { error: 'not-actionable', effects: 'not-dispatched' },
      { error: 'not-actionable', effects: 'completed' },
    ] satisfies PeerOutcome[]) {
      const fixture = await opened(command);
      const consume = vi.fn();
      const pending = fixture.engine.withUpload(bytes, operation(), consume, 'scope');
      await fixture.arrived;
      fixture.retire(retirement);
      fixture.respond(outcome);
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
      expect(consume).not.toHaveBeenCalled();
      const commands = ['blob.create', 'blob.write', 'blob.seal'];
      expect(fixture.peer.requests.map(request => request.command)).toEqual(commands.slice(0, commands.indexOf(command) + 1));
      expect(fixture.dispose).not.toHaveBeenCalled();
      await expect(fixture.client.request('synthetic.probe', {}, operation())).resolves.toMatchObject({ ok: true });
      await fixture.client.close(operation());
    }
  });

  it.each(['engine', 'browser', 'upload'] as const)('rejects a malformed Unknown envelope before %s can classify it', async channel => {
    const command = channel === 'engine' ? 'browser.perform' : channel === 'browser' ? 'page.reload' : 'blob.create';
    const fixture = await opened(command);
    const published = vi.fn();
    const pending = (channel === 'engine'
      ? fixture.engine.command('browser.perform', { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind: 'tap' } }, operation())
      : channel === 'browser' ? fixture.browser.command('page.reload', {}, operation())
        : fixture.engine.withUpload(bytes, operation(), published, 'scope')).then(published);
    await fixture.arrived;
    fixture.retire(retirement);
    fixture.respond({ error: 'deadline-exceeded', effects: 'unknown', scopeState: 'usable' });
    await expect(pending).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    expect(published).not.toHaveBeenCalled();
    await expectQuarantined(fixture, [command]);
  });
});
