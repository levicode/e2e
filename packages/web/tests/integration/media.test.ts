/**
 * Media emulation in a real browser: `web({ colorScheme, reducedMotion })`
 * and `browser.emulateMedia` reach the page's own `@media` rules, not only
 * `matchMedia`, from the first paint of every page the attempt opens, through
 * `app.restart()` and `app.clearState()`. Driven through the engine hooks and
 * the `browser` fixture, as the attempt executor drives them.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EngineCleanupContext, EngineFixtureContext, EngineHandle, OperationContext } from 'e2e/engine';
import { web, type Browser, type WebMedia, type WebOptions } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
import { beginSyntheticCase, type SyntheticCaseId, type SyntheticCommand, type SyntheticEvidence, type SyntheticOutcome, type SyntheticPhase } from '../helpers/synthetic-evidence.ts';

import { NativeClient } from '../../src/native/client.ts';
import { SyntheticNativeObserver } from '../helpers/synthetic-native-outcomes.ts';

/** Synchronous facts preserve the original operation and sequential shutdown. */
class MediaEvidence {
  readonly evidence: SyntheticEvidence;
  readonly observer: SyntheticNativeObserver;
  private restore = () => {};
  constructor(id: SyntheticCaseId = 'P35') {
    this.evidence = beginSyntheticCase(id);
    this.observer = new SyntheticNativeObserver(this.evidence, () => this.currentPhase);
    try {
      const connect = NativeClient.connect;
      const spy = vi.spyOn(NativeClient, 'connect').mockImplementation((...args) => this.observer.connection(connect(...args)));
      this.restore = () => spy.mockRestore();
    } catch { this.evidence.invalidate(); }
  }
  select<T>(ordinal: number, command: SyntheticCommand, body: () => T): T { return this.observer.select(ordinal, command, body); }
  assert<T>(ordinal: number, body: () => T): T { return this.observer.assert(ordinal, body); }
  readonly outcome: SyntheticOutcome = { setup: 'not-started', body: 'not-started', cleanup: 'not-started' };
  currentPhase: SyntheticPhase = 'init';
  private active: { section: keyof SyntheticOutcome; phase: SyntheticPhase } | undefined;

  phase(section: keyof SyntheticOutcome, phase: SyntheticPhase): void {
    this.returned();
    this.currentPhase = phase;
    this.outcome[section] = 'incomplete';
    this.active = { section, phase };
    this.evidence.record({ kind: 'phase', section, phase, state: 'enter' });
  }
  returned(): void {
    if (this.active !== undefined) this.evidence.record({ kind: 'phase', ...this.active, state: 'passed' });
    this.active = undefined;
  }
  passed(section: keyof SyntheticOutcome): void { this.returned(); this.outcome[section] = 'passed'; }
  failed(section: keyof SyntheticOutcome, cause?: unknown): void {
    if (cause !== undefined) this.observer.failure(section, cause);
    if (this.active !== undefined) this.evidence.record({ kind: 'phase', ...this.active, state: 'failed' });
    this.active = undefined;
    this.outcome[section] = 'failed';
  }
  finish(): void { this.observer.close(); try { this.restore(); } catch { this.evidence.invalidate(); } this.evidence.finish(this.outcome); }
}

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-media', attemptId: 'm1', origin: 'test' };
}

/** What the media page shows: its paragraph's computed style, what `matchMedia` reports now, and what its head script read before first paint. */
interface MediaReading {
  readonly color: string;
  readonly transition: string;
  readonly dark: boolean;
  readonly reduce: boolean;
  readonly atLoad: { readonly dark: boolean; readonly reduce: boolean };
}

const LIGHT = 'rgb(0, 0, 0)';
const DARK = 'rgb(255, 255, 255)';

describe('media emulation', () => {
  let app: FixtureApp;
  let artifactsDir: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-media-'));
  });

  afterAll(async () => {
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /** Boots one engine into a running attempt, before the first navigation. */
  async function boot(options: WebOptions, evidence?: MediaEvidence): Promise<EngineHandle> {
    const engine = web(options);
    try {
      evidence?.phase('setup', 'init');
      await engine.init!({
        runId: 'run-media', targetName: 'web', projectRoot: process.cwd(),
        app: { site: new URL(app.url).hostname }, env: process.env, headed: false,
        workerSlot: 0, log: () => undefined, signal: new AbortController().signal,
      });
      evidence?.phase('setup', 'start');
      await engine.startAttempt!({ attemptId: 'm1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
      evidence?.passed('setup');
      return engine;
    } catch (cause) { evidence?.failed('setup', cause); evidence?.finish(); throw cause; }
  }

  async function shutdown(engine: EngineHandle, evidence?: MediaEvidence): Promise<void> {
    try {
      evidence?.phase('cleanup', 'end');
      await engine.endAttempt!(cleanup());
      evidence?.phase('cleanup', 'dispose');
      await engine.dispose!(cleanup());
      evidence?.passed('cleanup');
    } catch (cause) { evidence?.failed('cleanup', cause); throw cause; }
    finally { evidence?.finish(); }
  }

  const fixtures = new WeakMap<EngineHandle, Browser>();

  /** The engine's `browser` fixture, with the harness parts it reaches stubbed. */
  function fixtureOf(engine: EngineHandle): Browser {
    const existing = fixtures.get(engine);
    if (existing !== undefined) return existing;
    const browser = engine.fixtures!['browser']!({
      operation,
      app: { resolveUrl: (url: string) => new URL(url, app.url).href },
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
      attachArtifact: () => undefined,
    } as unknown as EngineFixtureContext) as Browser;
    fixtures.set(engine, browser);
    return browser;
  }

  async function openMedia(engine: EngineHandle, evidence?: MediaEvidence, ordinal = 0): Promise<MediaReading> {
    evidence?.phase('body', 'navigate');
    const open = () => engine.session!.open!(`${app.url}/media`, operation());
    await (evidence ? evidence.select(ordinal, 'page.navigate', open) : open());
    evidence?.phase('body', 'media-read');
    return evidence ? evidence.select(ordinal + 1, 'page.evaluate', () => read(engine)) : read(engine);
  }

  function read(engine: EngineHandle): Promise<MediaReading> {
    return fixtureOf(engine).evaluate(() => {
      const style = getComputedStyle(document.querySelector('p')!);
      return {
        color: style.color,
        transition: style.transitionDuration,
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
        reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
        atLoad: (window as unknown as { atLoad: MediaReading['atLoad'] }).atLoad,
      };
    });
  }

  /** The reading of a page that loaded with `media` in force. */
  function loadedWith(media: { dark: boolean; reduce: boolean }): MediaReading {
    return { color: media.dark ? DARK : LIGHT, transition: media.reduce ? '0s' : '0.3s', ...media, atLoad: media };
  }

  it('loads every page with the configured media, after a restart and a context reset too', async () => {
    const evidence = new MediaEvidence('P45');
    const engine = await boot({ colorScheme: 'dark', reducedMotion: 'reduce' }, evidence);
    const expected = loadedWith({ dark: true, reduce: true });
    try {
      const initial = await openMedia(engine, evidence, 0);
      evidence.assert(1, () => expect(initial).toEqual(expected));
      evidence.phase('body', 'restart');
      await evidence.select(2, 'scope.restart', () => engine.session!.restart!(operation()));
      const restarted = await openMedia(engine, evidence, 3);
      evidence.assert(4, () => expect(restarted).toEqual(expected));
      evidence.phase('body', 'state-reset');
      await evidence.select(5, 'scope.reset', () => engine.session!.reset!(operation()));
      const reset = await openMedia(engine, evidence, 6);
      evidence.assert(7, () => expect(reset).toEqual(expected));
      evidence.passed('body');
    } catch (cause) { evidence.failed('body', cause); throw cause; } finally {
      await shutdown(engine, evidence);
    }
  });

  it('leaves the browser\'s own media when none is configured', async () => {
    const engine = await boot({});
    try {
      expect(await openMedia(engine)).toEqual(loadedWith({ dark: false, reduce: false }));
    } finally {
      await shutdown(engine);
    }
  });

  it('emulates media set before the first navigation from first paint, and holds a change for the rest of the attempt', async () => {
    const evidence = new MediaEvidence();
    const engine = await boot({ colorScheme: 'dark' }, evidence);
    let browser: Browser;
    try {
      evidence.phase('setup', 'fixture-create');
      browser = fixtureOf(engine);
      evidence.passed('setup');
    } catch (cause) { evidence.failed('setup', cause); evidence.finish(); throw cause; }
    try {
      evidence.phase('body', 'media-configure');
      await browser.emulateMedia({ reducedMotion: 'reduce' });
      const initial = await openMedia(engine, evidence, 0);
      evidence.assert(1, () => expect(initial).toEqual(loadedWith({ dark: true, reduce: true })));
      // A change applies to the open page at once; a feature left out keeps its value.
      evidence.phase('body', 'media-configure');
      await browser.emulateMedia({ colorScheme: 'light' });
      evidence.phase('body', 'media-read');
      const changed = await evidence.select(2, 'page.evaluate', () => read(engine));
      evidence.assert(2, () => expect(changed).toEqual({ ...loadedWith({ dark: false, reduce: true }), atLoad: { dark: true, reduce: true } }));
      const expected = loadedWith({ dark: false, reduce: true });
      evidence.phase('body', 'restart');
      await evidence.select(3, 'scope.restart', () => engine.session!.restart!(operation()));
      const restarted = await openMedia(engine, evidence, 4);
      evidence.assert(5, () => expect(restarted).toEqual(expected));
      evidence.phase('body', 'state-reset');
      await evidence.select(6, 'scope.reset', () => engine.session!.reset!(operation()));
      const reset = await openMedia(engine, evidence, 7);
      evidence.assert(8, () => expect(reset).toEqual(expected));
      evidence.phase('body', 'media-configure');
      await browser.emulateMedia({ colorScheme: 'no-preference', reducedMotion: 'no-preference' });
      evidence.phase('body', 'media-read');
      const final = await evidence.select(9, 'page.evaluate', () => read(engine));
      evidence.assert(9, () => expect(final).toMatchObject({ color: LIGHT, transition: '0.3s', dark: false, reduce: false }));
      evidence.passed('body');
    } catch (cause) { evidence.failed('body', cause); throw cause; }
    finally {
      await shutdown(engine, evidence);
    }
  });

  it('gives a tab the app opens itself a test\'s change as it appears and later', async () => {
    const engine = await boot({ colorScheme: 'dark' });
    try {
      await fixtureOf(engine).emulateMedia({ colorScheme: 'light' });
      expect(await openMedia(engine)).toEqual(loadedWith({ dark: false, reduce: false }));
      const browser = fixtureOf(engine);
      await browser.evaluate(() => {
        (window as unknown as { mediaPopup: Window | null }).mediaPopup = window.open('/media');
        return null;
      });
      await expect.poll(() => browser.evaluate(() => {
        const popup = (window as unknown as { mediaPopup: Window | null }).mediaPopup;
        return popup !== null && popup.location.pathname === '/media' && popup.document.readyState === 'complete';
      })).toBe(true);
      const now = () => browser.evaluate(() => {
        const popup = (window as unknown as { mediaPopup: Window }).mediaPopup;
        return {
          dark: popup.matchMedia('(prefers-color-scheme: dark)').matches,
          reduce: popup.matchMedia('(prefers-reduced-motion: reduce)').matches,
        };
      });
      expect(await now()).toEqual({ dark: false, reduce: false });
      await fixtureOf(engine).emulateMedia({ reducedMotion: 'reduce' });
      expect(await now()).toEqual({ dark: false, reduce: true });
      expect(await read(engine)).toMatchObject({ dark: false, reduce: true });
    } finally {
      await shutdown(engine);
    }
  });

  it('refuses a feature it does not emulate and a value outside the ones it takes, changing nothing', async () => {
    const engine = await boot({ colorScheme: 'dark' });
    const browser = fixtureOf(engine);
    const refused = (message: string) => expect.objectContaining({ code: 'INVALID_ARGUMENT', message });
    try {
      await expect(browser.emulateMedia({ colorScheme: 'sepia' } as unknown as WebMedia)).rejects.toThrow(
        refused('browser.emulateMedia({ colorScheme }) must be "light", "dark", or "no-preference", got "sepia"'),
      );
      await expect(browser.emulateMedia({ forcedColors: 'active' } as unknown as WebMedia)).rejects.toThrow(
        refused('browser.emulateMedia options has no key "forcedColors"; it takes colorScheme, reducedMotion'),
      );
      await expect(browser.emulateMedia(undefined as unknown as WebMedia)).rejects.toThrow(
        refused('browser.emulateMedia takes { colorScheme?, reducedMotion? }'),
      );
      expect(await openMedia(engine)).toEqual(loadedWith({ dark: true, reduce: false }));
    } finally {
      await shutdown(engine);
    }
  });
});
