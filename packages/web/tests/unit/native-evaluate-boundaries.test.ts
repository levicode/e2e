/**
 * Evaluate's infrastructure boundary over real NativeClient frames. These are
 * protocol faults, not evidence that a Chromium page or context was closed.
 * Page-code exceptions, values, and syntax still run in integration/evaluate.
 */
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { EngineFixtureContext, OperationContext } from 'e2e/engine';
import { createBrowserFixture } from '../../src/browser.ts';
import { BrowserChannel } from '../../src/native/browser-channel.ts';
import type { NativeWebSurface } from '../../src/native/browser-contract.ts';
import { NativeClient } from '../../src/native/client.ts';
import { ErrorLatch } from '../../src/runtime-support.ts';

/** Connect the public fixture through the native decoder without launching a browser. */
async function transport() {
  const output = new PassThrough();
  const requests: Record<string, unknown>[] = [];
  const input = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      requests.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
      callback();
    },
  });
  const destroy = () => { input.destroy(); output.destroy(); };
  const send = (message: unknown) => { output.write(`${JSON.stringify(message)}\n`); };
  const signal = new AbortController().signal;
  const operation = (timeoutMs = 1_000): OperationContext => ({ signal, timeoutMs, runId: 'evaluate-transport', attemptId: 'synthetic', origin: 'test' });
  const connecting = NativeClient.connect({ readable: output, writable: input, dispose: destroy }, ['browser.evaluate/1'], operation(), () => undefined);
  send({
    type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1', sessionId: 'synthetic-evaluate', generation: 1,
    capabilities: ['browser.evaluate/1'], scopeState: 'usable',
    limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 },
  });
  const client = await connecting;
  const channel = new BrowserChannel(client, { identityScope: () => 'synthetic-scope', operation });
  const surface: NativeWebSurface = {
    latch: new ErrorLatch(), identityScope: 'synthetic-scope',
    latchCallbackFailure: (scope, error) => { if (scope === surface.identityScope) surface.latch.latch(error); },
    routeRegistryVersion: () => 0,
    allocateRouteRegistryVersion: () => { throw new Error('This transport fixture does not register routes'); },
    invalidate: () => client.invalidate(),
    command: (name, args, context) => channel.command(name, args, context),
    subscribe: (name, callback) => channel.subscribe(name, callback),
    decide: (token, decision, context) => channel.decide(token, decision, context),
    projectPath: () => { throw new Error('This transport fixture does not read files'); },
    siteHeaders: () => undefined,
    artifactPath: () => { throw new Error('This transport fixture does not write artifacts'); },
  };
  const browser = createBrowserFixture(surface, {
    operation,
    fixture: (_name: string, target: object) => target,
    expectable: (target: object) => target,
  } as unknown as EngineFixtureContext);
  const failure = (code: 'browser-failure' | 'deadline-exceeded', scopeState: 'usable' | 'quarantined' = 'usable', effects: 'not-dispatched' | 'unknown' = 'not-dispatched') => {
    const request = requests.at(-1)!;
    expect(request['command']).toBe('page.evaluate');
    send({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: false,
      error: { code }, effects, scopeState });
  };
  return { browser, output, requests, failure, destroy };
}

describe('native evaluate infrastructure fault classification', () => {
  // These replace the two old message-based Playwright rejection injections.
  it.each(['target closed', 'execution context destroyed'])('keeps native browser-failure for %s out of EVALUATE_FAILED', async () => {
    const fixture = await transport();
    try {
      const pending = fixture.browser.evaluate('() => 1');
      fixture.failure('browser-failure');
      await expect(pending).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
      expect(fixture.requests.filter(request => request['command'] === 'page.evaluate')).toHaveLength(1);
    } finally { fixture.destroy(); }
  });

  it('keeps an acknowledged native evaluation deadline as OPERATION_TIMEOUT', async () => {
    const fixture = await transport();
    try {
      const pending = fixture.browser.evaluate('() => 1');
      fixture.failure('deadline-exceeded');
      await expect(pending).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
    } finally { fixture.destroy(); }
  });

  it('preserves an unknown committed evaluation outcome instead of reclassifying it as a page exception', async () => {
    const fixture = await transport();
    try {
      const pending = fixture.browser.evaluate('async () => { document.title = "changed"; await new Promise(() => {}); }');
      fixture.failure('browser-failure', 'quarantined', 'unknown');
      await expect(pending).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
      await expect(fixture.browser.evaluate('() => 1')).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
      expect(fixture.requests.filter(request => request['command'] === 'page.evaluate')).toHaveLength(1);
    } finally { fixture.destroy(); }
  });

  // Target closure and browser-host loss run in integration/evaluate with an independent host injector.
  // These not-dispatched protocol cases do not claim isolated context.close conformance.
  it('keeps a quarantined native page-loss result during evaluation as infrastructure', async () => {
    const fixture = await transport();
    try {
      const pending = fixture.browser.evaluate('async () => { await new Promise(() => {}); }');
      fixture.failure('browser-failure', 'quarantined');
      await expect(pending).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
      await expect(fixture.browser.evaluate('() => 1')).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
      expect(fixture.requests.filter(request => request['command'] === 'page.evaluate')).toHaveLength(1);
    } finally { fixture.destroy(); }
  });

  it('keeps native context-connection loss during evaluation as infrastructure', async () => {
    const fixture = await transport();
    try {
      const pending = fixture.browser.evaluate('async () => { await new Promise(() => {}); }');
      expect(fixture.requests.at(-1)!['command']).toBe('page.evaluate');
      fixture.output.end();
      await expect(pending).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
      await expect(fixture.browser.evaluate('() => 1')).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
      expect(fixture.requests.filter(request => request['command'] === 'page.evaluate')).toHaveLength(1);
    } finally { fixture.destroy(); }
  });
});
