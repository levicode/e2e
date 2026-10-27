/** Isolated source-pinned controls: identical pointer calls, samples and bounded event witness on both backends. */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser as PlaywrightBrowser } from 'playwright-core';
import type { EngineCleanupContext, OperationContext } from 'e2e/engine';
import { web } from '../../src/index.ts';
import { closeRemoteChrome, launchRemoteChrome } from '../helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { pointerEvents, primitiveFixtureDocument, waitForPointerWheel } from '../helpers/public-primitive-fixture.ts';
import { nativeBrowser } from '../helpers/native-browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
import { beginSyntheticCase, type SyntheticEvidence, type SyntheticOutcome, type SyntheticPhase } from '../helpers/synthetic-evidence.ts';

/** Record only closed facts about the already returned array; a missing record never proves no event. */
function sample(evidence: SyntheticEvidence, events: unknown, ordinal: 0 | 1 | 2, nativePublicResultObserved: boolean): void {
  evidence.observe(() => {
    const valid = Array.isArray(events) && events.every(value => typeof value === 'string');
    if (!valid) evidence.invalidate();
    return { kind: 'wheel-sample', phase: ordinal === 0 ? 'original-sample' : ordinal === 1 ? 'post-result-sample' : 'delivery-witness', sampleOrdinal: ordinal,
      downCount: valid ? events.filter(value => value.startsWith('down:')).length : null,
      upCount: valid ? events.filter(value => value.startsWith('up:')).length : null,
      wheelCount: valid ? events.filter(value => value.startsWith('wheel:')).length : null,
      expectedDeltaSeen: valid ? events.includes('wheel:40') : null, nativePublicResultObserved, cdpAckObserved: null };
  });
}

/** Independent bounded budgets, matching the existing public fixture helper's lifetime. */
function operation(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'events-control', attemptId: 'a', origin: 'test' };
}

/** Cleanup remains owned by each fresh control, not a shared browser or previous case. */
function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

describe('isolated synthetic event controls', () => {
  let server: Server;
  let url: string;
  let app: FixtureApp;
  beforeAll(async () => {
    app = await startFixtureApp();
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(primitiveFixtureDocument(request.url ?? '/'));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await app.close();
  });

  it('observes popup opening through pinned Playwright on a fresh host', async () => {
    const evidence = beginSyntheticCase('P05PW');
    const outcome: SyntheticOutcome = { setup: 'incomplete', body: 'not-started', cleanup: 'not-started' };
    let section: 'setup' | 'body' | 'cleanup' = 'setup';
    let phase: SyntheticPhase = 'host';
    let control: PlaywrightBrowser | undefined;
    evidence.record({ kind: 'phase', section, phase, state: 'enter' });
    try {
      const remote = await launchRemoteChrome();
      evidence.record({ kind: 'phase', section, phase, state: 'passed' });
      try {
        phase = 'start'; evidence.record({ kind: 'phase', section, phase, state: 'enter' });
        control = await chromium.connectOverCDP(remote.endpoint);
        const page = control.contexts()[0]!.pages()[0]!;
        evidence.record({ kind: 'phase', section, phase, state: 'passed' });
        // Same-origin navigation is a setup public call, NOT included in the one tested popup call.
        phase = 'navigate'; evidence.record({ kind: 'phase', section, phase, state: 'enter' });
        await page.goto(`${app.url}/login`);
        evidence.record({ kind: 'phase', section, phase, state: 'passed' });
        outcome.setup = 'passed'; section = 'body'; outcome.body = 'incomplete'; phase = 'popup-open';
        evidence.record({ kind: 'phase', section, phase, state: 'enter' });
        // Pinned public Playwright evaluate, not private CDP flags. Any backend difference has multiple possible causes.
        const opened = await page.evaluate(() => {
          (window as unknown as { recoveryPopup: Window | null }).recoveryPopup = window.open('/');
          const popup = (window as unknown as { recoveryPopup: Window | null }).recoveryPopup;
          let readFailed = false;
          const read = (getter: () => boolean): boolean | null => { try { return getter(); } catch { readFailed = true; return null; } };
          return { present: popup !== null, closed: read(() => popup!.closed),
            activationActive: read(() => navigator.userActivation.isActive), activationEver: read(() => navigator.userActivation.hasBeenActive), readState: readFailed ? 'failed' as const : 'ok' as const };
        });
        evidence.observe(() => ({ kind: 'popup-readiness', phase: 'open-return', sampleOrdinal: 0,
          ...opened, pathMatches: null, complete: null, predicate: null }));
        evidence.record({ kind: 'phase', section, phase, state: 'passed' });
        outcome.body = 'passed';
      } catch (cause) {
        outcome[section] = 'failed'; evidence.record({ kind: 'phase', section, phase, state: 'failed' }); throw cause;
      } finally {
        section = 'cleanup'; outcome.cleanup = 'incomplete'; phase = 'browser-close';
        try {
          evidence.record({ kind: 'phase', section, phase, state: 'enter' });
          await control?.close(); evidence.record({ kind: 'phase', section, phase, state: 'passed' });
        } catch (cause) {
          // eslint-disable-next-line no-unsafe-finally -- Preserve the original cleanup exception precedence.
          outcome.cleanup = 'failed'; evidence.record({ kind: 'phase', section, phase, state: 'failed' }); throw cause;
        } finally {
          phase = 'close-host'; evidence.record({ kind: 'phase', section, phase, state: 'enter' });
          try {
            await closeRemoteChrome(remote); evidence.record({ kind: 'phase', section, phase, state: 'passed' });
          } catch (cause) {
            // eslint-disable-next-line no-unsafe-finally -- Preserve the original cleanup exception precedence.
            outcome.cleanup = 'failed'; evidence.record({ kind: 'phase', section, phase, state: 'failed' }); throw cause;
          }
        }
        outcome.cleanup = 'passed';
      }
    } catch (cause) {
      // Preserve the previously recorded body/setup failure when owned cleanup succeeded.
      if (outcome[section] !== 'passed' && outcome[section] !== 'failed') {
        outcome[section] = 'failed'; evidence.record({ kind: 'phase', section, phase, state: 'failed' });
      }
      throw cause;
    } finally { evidence.finish(outcome); }
  }, 60_000);

  it('observes native wheel delivery at the immediate and one subsequent sample', async () => {
    const evidence = beginSyntheticCase('C01N');
    const outcome: SyntheticOutcome = { setup: 'incomplete', body: 'not-started', cleanup: 'not-started' };
    let section: 'setup' | 'body' | 'cleanup' = 'setup';
    let phase: SyntheticPhase = 'init';
    const artifactsDir = mkdtempSync(nodePath.join(tmpdir(), 'e2e-events-control-'));
    const engine = web({ viewport: { width: 1280, height: 720 } });
    try {
      evidence.record({ kind: 'phase', section, phase, state: 'enter' });
      await engine.init!({ runId: 'events-control', targetName: 'web', projectRoot: process.cwd(), app: { site: '127.0.0.1' },
        env: process.env, headed: false, workerSlot: 0, signal: operation().signal, log: () => undefined });
      evidence.record({ kind: 'phase', section, phase, state: 'passed' });
      phase = 'start'; evidence.record({ kind: 'phase', section, phase, state: 'enter' });
      await engine.startAttempt!({ attemptId: 'a', artifactsDir, signal: operation().signal, resolveSecret: noSecrets, ...ignoreTrace });
      evidence.record({ kind: 'phase', section, phase, state: 'passed' });
      const browser = nativeBrowser(engine, operation, url);
      outcome.setup = 'passed'; section = 'body'; outcome.body = 'incomplete'; phase = 'navigate';
      evidence.record({ kind: 'phase', section, phase, state: 'enter' });
      await browser.goto('/a');
      evidence.record({ kind: 'phase', section, phase, state: 'passed' });
      phase = 'dispatch'; evidence.record({ kind: 'phase', section, phase, state: 'enter' });
      await browser.mouse.move(30, 130);
      await browser.mouse.down();
      await browser.mouse.up();
      await browser.mouse.wheel(0, 40);
      phase = 'sample';
      const immediate = await browser.evaluate(pointerEvents);
      // Keep wheel and first read adjacent, including no synchronous evidence I/O.
      evidence.record({ kind: 'phase', section, phase: 'dispatch', state: 'passed' });
      sample(evidence, immediate, 0, false);
      // Preserve the two diagnostic samples; neither alone is a delivery contract.
      const subsequent = await browser.evaluate(pointerEvents);
      sample(evidence, subsequent, 1, false);
      evidence.record({ kind: 'phase', section, phase, state: 'passed' });
      phase = 'witness'; evidence.record({ kind: 'phase', section, phase, state: 'enter' });
      const events = await browser.evaluate(waitForPointerWheel, 1_000);
      sample(evidence, events, 2, false);
      evidence.record({ kind: 'phase', section, phase, state: 'passed' });
      phase = 'assertion';
      expect(events).toContain('down:30:130:1');
      expect(events).toContain('up:30:130:0');
      expect(events).toEqual(['down:30:130:1', 'up:30:130:0', 'wheel:40']);
      outcome.body = 'passed';
    } catch (cause) {
      outcome[section] = 'failed'; evidence.record({ kind: 'phase', section, phase, state: 'failed' }); throw cause;
    } finally {
      section = 'cleanup'; outcome.cleanup = 'incomplete'; phase = 'end';
      try {
        try {
          evidence.record({ kind: 'phase', section, phase, state: 'enter' });
          await engine.endAttempt!(cleanup()); evidence.record({ kind: 'phase', section, phase, state: 'passed' });
        } catch (cause) {
          // eslint-disable-next-line no-unsafe-finally -- Preserve the original cleanup exception precedence.
          outcome.cleanup = 'failed'; evidence.record({ kind: 'phase', section, phase, state: 'failed' }); throw cause;
        } finally {
          phase = 'dispose'; evidence.record({ kind: 'phase', section, phase, state: 'enter' });
          try {
            await engine.dispose!(cleanup()); evidence.record({ kind: 'phase', section, phase, state: 'passed' });
            rmSync(artifactsDir, { recursive: true, force: true });
          } catch (cause) {
            // eslint-disable-next-line no-unsafe-finally -- Preserve the original cleanup exception precedence.
            outcome.cleanup = 'failed'; evidence.record({ kind: 'phase', section, phase, state: 'failed' }); throw cause;
          }
        }
        outcome.cleanup = 'passed';
      } catch (cause) {
        // eslint-disable-next-line no-unsafe-finally -- Preserve the original cleanup exception precedence.
        outcome.cleanup = 'failed'; throw cause;
      } finally { evidence.finish(outcome); }
    }
  }, 60_000);

  it('observes pinned Playwright wheel delivery at the immediate and one subsequent sample', async () => {
    const evidence = beginSyntheticCase('C01PW');
    const outcome: SyntheticOutcome = { setup: 'incomplete', body: 'not-started', cleanup: 'not-started' };
    let section: 'setup' | 'body' | 'cleanup' = 'setup';
    let phase: SyntheticPhase = 'host';
    let host: PlaywrightBrowser | undefined;
    try {
      evidence.record({ kind: 'phase', section, phase, state: 'enter' });
      host = await chromium.launch({ headless: true });
      const context = await host.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await context.newPage();
      evidence.record({ kind: 'phase', section, phase, state: 'passed' });
      outcome.setup = 'passed'; section = 'body'; outcome.body = 'incomplete'; phase = 'navigate';
      evidence.record({ kind: 'phase', section, phase, state: 'enter' });
      await page.goto(`${url}/a`);
      evidence.record({ kind: 'phase', section, phase, state: 'passed' });
      phase = 'dispatch'; evidence.record({ kind: 'phase', section, phase, state: 'enter' });
      await page.mouse.move(30, 130);
      await page.mouse.down();
      await page.mouse.up();
      await page.mouse.wheel(0, 40);
      phase = 'sample';
      const immediate = await page.evaluate(pointerEvents);
      // Keep wheel and first read adjacent, including no synchronous evidence I/O.
      evidence.record({ kind: 'phase', section, phase: 'dispatch', state: 'passed' });
      sample(evidence, immediate, 0, false);
      const subsequent = await page.evaluate(pointerEvents);
      sample(evidence, subsequent, 1, false);
      evidence.record({ kind: 'phase', section, phase, state: 'passed' });
      phase = 'witness'; evidence.record({ kind: 'phase', section, phase, state: 'enter' });
      const events = await page.evaluate(waitForPointerWheel, 1_000);
      sample(evidence, events, 2, false);
      evidence.record({ kind: 'phase', section, phase, state: 'passed' });
      phase = 'assertion';
      expect(events).toContain('down:30:130:1');
      expect(events).toContain('up:30:130:0');
      expect(events).toEqual(['down:30:130:1', 'up:30:130:0', 'wheel:40']);
      outcome.body = 'passed';
    } catch (cause) {
      outcome[section] = 'failed'; evidence.record({ kind: 'phase', section, phase, state: 'failed' }); throw cause;
    } finally {
      section = 'cleanup'; outcome.cleanup = 'incomplete'; phase = 'browser-close';
      try {
        evidence.record({ kind: 'phase', section, phase, state: 'enter' });
        await host?.close(); evidence.record({ kind: 'phase', section, phase, state: 'passed' });
        outcome.cleanup = 'passed';
      } catch (cause) {
        // eslint-disable-next-line no-unsafe-finally -- Preserve the original cleanup exception precedence.
        outcome.cleanup = 'failed'; evidence.record({ kind: 'phase', section, phase, state: 'failed' }); throw cause;
      } finally { evidence.finish(outcome); }
    }
  }, 60_000);
});
