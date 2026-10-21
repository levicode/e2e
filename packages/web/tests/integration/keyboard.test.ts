/** Held keyboard input through the actual browser fixture and native DOM events. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EngineFixtureContext } from 'e2e/engine';
import { NativeSurface } from '../../src/native-surface.ts';
import { createBrowserFixture, type Browser } from '../../src/browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
describe('held keyboard input', () => {
  const surface = new NativeSurface({});
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-held-keys-'));
  const signal = new AbortController().signal;
  let browser: Browser;
  beforeAll(async () => {
    await surface.init({ runId: 'held', targetName: 'web', projectRoot, app: {}, env: process.env, headed: false, workerSlot: 0, signal, log: () => undefined });
  });
  beforeEach(async () => {
    await surface.startAttempt({ attemptId: 'held', artifactsDir: projectRoot, signal, resolveSecret: noSecrets, ...ignoreTrace });
    // These cases test an opened page, not the separate lazy-activation refusal contract.
    await surface.open('about:blank', { signal, timeoutMs: 5_000, runId: 'held', attemptId: 'held', origin: 'test' });
    browser = createBrowserFixture(surface.fixtureSurface(), {
      app: { resolveUrl: (url: string) => url },
      operation: (timeoutMs = 5000) => ({ signal, timeoutMs, runId: 'held', attemptId: 'held', origin: 'test' }),
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
    } as unknown as EngineFixtureContext);
    await browser.evaluate(() => {
      document.body.innerHTML = '<h1 id="events"></h1>';
      for (const type of ['keydown', 'keyup']) document.addEventListener(type, event => {
        if (!(event instanceof KeyboardEvent)) return;
        const output = document.querySelector('#events');
        if (output !== null) output.textContent += `${event.type}|${event.key}|${event.shiftKey}|${event.repeat};`;
      });
      return null;
    });
  });
  afterEach(async () => { await surface.endAttempt({ signal, timeoutMs: 5000 }); });
  afterAll(async () => {
    await surface.dispose({ signal, timeoutMs: 5000 });
    rmSync(projectRoot, { recursive: true, force: true });
  });
  it('keeps a modifier held across another key and releases it for later input', async () => {
    await browser.keyboard.down('Shift');
    await browser.keyboard.press('KeyB');
    await browser.keyboard.up('Shift');
    await browser.keyboard.press('KeyB');
    const events = await browser.evaluate(() => document.querySelector('#events')?.textContent ?? '');
    expect(events).toContain('keydown|B|true|false;');
    expect(events).toContain('keyup|Shift|false|false;');
    expect(events).toContain('keydown|b|false|false;');
  });
  it('marks a second down as repeat and a later release ends the held sequence', async () => {
    await browser.keyboard.down('a');
    await browser.keyboard.down('a');
    await browser.keyboard.up('a');
    await browser.keyboard.down('a');
    await browser.keyboard.up('a');
    const events = await browser.evaluate(() => document.querySelector('#events')?.textContent ?? '');
    expect(events).toBe('keydown|a|false|false;keydown|a|false|true;keyup|a|false|false;keydown|a|false|false;keyup|a|false|false;');
  });
});
