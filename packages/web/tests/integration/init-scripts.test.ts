/**
 * Init scripts: the configured `initScripts` and `browser.addInitScript` run
 * in every document before its own scripts, in order, in new tabs and
 * frames, and again on each context the attempt replaces. Each page here
 * records, from its first inline script, the trail the init scripts left.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secrets } from 'e2e';
import type { EngineCleanupContext, EngineFixtureContext, OperationContext } from 'e2e/engine';
import { createBrowserFixture, type Browser } from '../../src/browser.ts';
import { NativeSurface } from '../../src/native-surface.ts';
import type { WebOptions } from '../../src/web-options.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
import { beginSyntheticCase, type SyntheticOutcome, type SyntheticPhase } from '../helpers/synthetic-evidence.ts';

declare global {
  interface Window {
    trail?: string[];
    seenAtBoot?: string[];
  }
}

const BOOT = `<script>
  window.seenAtBoot = [...(window.trail ?? [])];
  window.addEventListener('load', () => {
    window.opener?.postMessage({ kind: 'init-script-boot', trail: window.seenAtBoot }, location.origin);
  });
</script>`;
const PAGES: Record<string, string> = {
  '/': `<!doctype html><html><head>${BOOT}</head><body><h1>Home</h1></body></html>`,
  '/framed': `<!doctype html><html><head>${BOOT}</head><body><iframe src="/"></iframe></body></html>`,
};

const signal = new AbortController().signal;
const cleanup = (): EngineCleanupContext => ({ signal, timeoutMs: 30_000 });
const operation = (): OperationContext => ({ signal, timeoutMs: 30_000, runId: 'init-scripts', attemptId: 'a', origin: 'test' });

describe('init scripts', () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-init-scripts-'));
  let server: Server;
  let url: string;

  beforeAll(async () => {
    writeFileSync(path.join(projectRoot, 'from-file.js'), "(window.trail ??= []).push('file');\n");
    server = createServer((request, response) => {
      const body = PAGES[request.url ?? ''];
      response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html' });
      response.end(body ?? 'not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Boots one worker of a surface with `options` and runs `body` in one attempt with its `browser` fixture. */
  async function attempt(options: WebOptions, body: (browser: Browser, surface: NativeSurface) => Promise<void>): Promise<void> {
    const surface = new NativeSurface(options);
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-init-scripts-artifacts-'));
    try {
      await surface.init({ runId: 'init-scripts', targetName: 'web', projectRoot, app: { site: '127.0.0.1' },
        env: process.env, headed: false, workerSlot: 0, signal, log: () => undefined });
      await surface.startAttempt({ attemptId: 'a', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
      const browser = createBrowserFixture(surface.fixtureSurface(), {
        operation,
        app: { resolveUrl: (target: string) => new URL(target, url).href },
        timeouts: { test: 30_000, assertion: 5_000 },
        expectable: (target: object) => target,
        fixture: (_name: string, target: object) => target,
      } as unknown as EngineFixtureContext);
      await body(browser, surface);
    } finally {
      await surface.endAttempt(cleanup()).catch(() => undefined);
      await surface.dispose(cleanup());
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  }

  const seenAtBoot = (browser: Browser) => browser.evaluate(() => window.seenAtBoot ?? null);

  it('runs the configured scripts in order before the page, in frames, new tabs, and replaced contexts', async () => {
    const evidence = beginSyntheticCase('P22');
    /** Boots one worker of a surface with `options` and runs `body` in one attempt with its `browser` fixture. */
    async function diagnosedAttempt(options: WebOptions, body: (browser: Browser, surface: NativeSurface) => Promise<void>): Promise<void> {
      const outcome: SyntheticOutcome = { setup: 'incomplete', body: 'not-started', cleanup: 'not-started' };
      let phase: SyntheticPhase = 'init';
      let section: 'setup' | 'body' | 'cleanup' = 'setup';
      const surface = new NativeSurface(options);
      const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-init-scripts-artifacts-'));
      try {
        evidence.record({ kind: 'phase', section, phase, state: 'enter' });
        await surface.init({ runId: 'init-scripts', targetName: 'web', projectRoot, app: { site: '127.0.0.1' },
          env: process.env, headed: false, workerSlot: 0, signal, log: () => undefined });
        evidence.record({ kind: 'phase', section, phase, state: 'passed' }); phase = 'start';
        evidence.record({ kind: 'phase', section, phase, state: 'enter' });
        await surface.startAttempt({ attemptId: 'a', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
        evidence.record({ kind: 'phase', section, phase, state: 'passed' });
        const browser = createBrowserFixture(surface.fixtureSurface(), {
          operation,
          app: { resolveUrl: (target: string) => new URL(target, url).href },
          timeouts: { test: 30_000, assertion: 5_000 },
          expectable: (target: object) => target,
          fixture: (_name: string, target: object) => target,
        } as unknown as EngineFixtureContext);
        outcome.setup = 'passed'; outcome.body = 'incomplete'; section = 'body'; phase = 'action';
        evidence.record({ kind: 'phase', section, phase, state: 'enter' });
        await body(browser, surface);
        outcome.body = 'passed'; evidence.record({ kind: 'phase', section, phase, state: 'passed' });
      } catch (cause) {
        outcome[section] = 'failed'; evidence.record({ kind: 'phase', section, phase, state: 'failed' });
        throw cause;
      } finally {
        section = 'cleanup'; outcome.cleanup = 'incomplete'; phase = 'end';
        try {
          evidence.record({ kind: 'phase', section, phase, state: 'enter' });
          let endFailed = false;
          await surface.endAttempt(cleanup()).catch(() => {
            endFailed = true; evidence.record({ kind: 'phase', section, phase, state: 'failed' });
          });
          if (!endFailed) evidence.record({ kind: 'phase', section, phase, state: 'passed' });
          phase = 'dispose'; evidence.record({ kind: 'phase', section, phase, state: 'enter' });
          await surface.dispose(cleanup());
          evidence.record({ kind: 'phase', section, phase, state: 'passed' });
          rmSync(artifactsDir, { recursive: true, force: true });
          outcome.cleanup = endFailed ? 'failed' : 'passed';
        } catch (cause) {
          outcome.cleanup = 'failed'; evidence.record({ kind: 'phase', section, phase, state: 'failed' });
          // eslint-disable-next-line no-unsafe-finally -- Preserve the original cleanup exception precedence.
          throw cause;
        } finally { evidence.finish(outcome); }
      }
    }

    /** Stage ordinals identify fixture samples, never native document/session tenure. */
    const recordTrail = (phase: 'main' | 'frame' | 'popup' | 'reset', fixtureLifecycleOrdinal: 0 | 1 | 2 | 3, trail: unknown): void => {
      for (const scriptOrdinal of [0, 1, 2, 3] as const) evidence.observe(() => {
        const expected = ['source', 'file', 'function', 'method'];
        const valid = Array.isArray(trail) && trail.every(item => typeof item === 'string' && expected.includes(item));
        if (!valid) evidence.invalidate();
        return { kind: 'script-boot', phase, fixtureLifecycleOrdinal, scriptOrdinal,
          executionCount: valid ? trail.filter(item => item === expected[scriptOrdinal]).length : null,
          exactOrder: valid ? trail.length === expected.length && trail.every((item, index) => item === expected[index]) : null };
      });
    };
    const initScripts: WebOptions['initScripts'] = [
      "(window.trail ??= []).push('source');",
      { path: 'from-file.js' },
      () => { (window.trail ??= []).push('function'); },
      { method() { (window.trail ??= []).push('method'); } }.method,
    ];
    await diagnosedAttempt({ initScripts }, async (browser, surface) => {
      const expected = ['source', 'file', 'function', 'method'];
      evidence.record({ kind: 'phase', section: 'body', phase: 'navigate', state: 'enter' });
      await browser.goto('/framed');
      evidence.record({ kind: 'phase', section: 'body', phase: 'navigate', state: 'passed' });
      const mainTrail = await seenAtBoot(browser); recordTrail('main', 0, mainTrail);
      expect(mainTrail).toEqual(expected);
      let frameTrail: unknown = null;
      // The extra local continuation changes scheduling, not the original renderer request or poll timeout.
      try {
        await expect.poll(() => browser.evaluate(() =>
          document.querySelector('iframe')?.contentWindow?.seenAtBoot ?? null,
        ).then(value => { frameTrail = value; return value; })).toEqual(expected);
      } finally { recordTrail('frame', 1, frameTrail); }

      evidence.record({ kind: 'phase', section: 'body', phase: 'popup', state: 'enter' });
      const tabTrail = await browser.evaluate((target) => new Promise<string[]>((resolve, reject) => {
        let tab: Window | null = null;
        const loaded = (event: MessageEvent) => {
          if (event.origin !== location.origin || event.source !== tab) return;
          const data = event.data as { kind?: unknown; trail?: unknown } | null;
          if (data?.kind !== 'init-script-boot' || !Array.isArray(data.trail) || !data.trail.every(item => typeof item === 'string')) return;
          window.removeEventListener('message', loaded);
          resolve(data.trail);
        };
        window.addEventListener('message', loaded);
        tab = window.open(target);
        if (tab === null) {
          window.removeEventListener('message', loaded);
          reject(new Error('The init-script fixture popup did not open'));
        }
      }), `${url}/`);
      evidence.record({ kind: 'phase', section: 'body', phase: 'popup', state: 'passed' });
      recordTrail('popup', 2, tabTrail);
      expect(tabTrail).toEqual(expected);

      evidence.record({ kind: 'phase', section: 'body', phase: 'reset', state: 'enter' });
      await surface.reset(operation());
      evidence.record({ kind: 'phase', section: 'body', phase: 'reset', state: 'passed' });
      await browser.goto('/');
      const resetTrail = await seenAtBoot(browser); recordTrail('reset', 3, resetTrail);
      expect(resetTrail).toEqual(expected);
    });
  });

  it('adds a test script after the configured ones, from the next document on, for the rest of the attempt', async () => {
    await attempt({ initScripts: ["(window.trail ??= []).push('config');"] }, async (browser, surface) => {
      await browser.goto('/');
      await browser.addInitScript((wallet) => { (window.trail ??= []).push(`wallet:${wallet.address}`); }, { address: '0xabc' });
      expect(await seenAtBoot(browser)).toEqual(['config']);
      await browser.reload();
      expect(await seenAtBoot(browser)).toEqual(['config', 'wallet:0xabc']);

      const arg = JSON.parse('{"__proto__":{"own":true}}') as { __proto__: { own: boolean } };
      await browser.addInitScript((value) => {
        (window.trail ??= []).push(`own __proto__:${String(Object.hasOwn(value, '__proto__'))}`);
      }, arg);
      await browser.addInitScript({ path: 'from-file.js' });
      await surface.reset(operation());
      await browser.goto('/');
      expect(await seenAtBoot(browser)).toEqual(['config', 'wallet:0xabc', 'own __proto__:true', 'file']);
    });
    await attempt({}, async (browser) => {
      await browser.goto('/');
      expect(await seenAtBoot(browser)).toEqual([]);
    });
  });

  it('refuses a script it cannot run, and a secret argument', async () => {
    await attempt({}, async (browser) => {
      const add = browser.addInitScript as (...args: unknown[]) => Promise<void>;
      await expect(add('window.x = 1', 3)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/only with a function/) });
      await expect(add({ path: 'missing.js' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/missing\.js \(ENOENT\)/) });
      await expect(add({ content: 'x' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/takes only path, got content/) });
      await expect(add(42)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(add(() => undefined, secrets.get('key'))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    });
  });

  it('fails the run, and a worker, with INVALID_CONFIG when a configured file cannot be read', async () => {
    const surface = new NativeSurface({ initScripts: [{ path: 'nope.js' }] });
    await expect(surface.prepare({ runId: 'init-scripts', targetName: 'web', projectRoot, app: {}, slots: 1, env: process.env,
      signal, headed: false, log: () => undefined })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(/nope\.js \(ENOENT\)/) });
    await expect(surface.init({ runId: 'init-scripts', targetName: 'web', projectRoot, app: {}, env: process.env, headed: false,
      workerSlot: 0, signal, log: () => undefined })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringMatching(/web\(\{ initScripts \}\)\[0\] path cannot be read: .*nope\.js \(ENOENT\)/),
    });
    await surface.dispose(cleanup());
  });
});
