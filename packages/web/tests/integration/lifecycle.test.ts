import { withLifecycleOpenCancelDiagnostics } from '../helpers/lifecycle-open-cancel-diagnostics.ts';
import { IsolatedScopeCreation } from '../helpers/isolated-scope-creation.ts';
import { beginCaseCleanupCapture } from '../helpers/case-cleanup-capture.ts';
import { LifecycleAttemptDiagnostic } from '../helpers/lifecycle-attempt-diagnostic.ts';
import { SyntheticNativeObserver } from '../helpers/synthetic-native-outcomes.ts';
/**
 * The native engine's lifecycle through the public contract: one shared
 * browser per engine, one context per attempt, and honest idempotent
 * teardown. No runner involved - the hooks are driven directly, the way the
 * attempt executor drives them.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  VideoFile,
  VideoSegment,
  EngineCleanupContext,
  EngineFixtureContext,
  EngineHandle,
  LocatorExpression,
  OperationContext,
  SemanticNode,
} from 'e2e/engine';
import { EngineError } from 'e2e/engine';
import { web, type Browser } from '../../src/index.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { NativeClient } from '../../src/native/client.ts';
import { nativeBrowser } from '../helpers/native-browser.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { decodePng } from '../helpers/png.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
import { beginSyntheticCase, type SyntheticCommand, type SyntheticCaseId, type SyntheticEvidence, type SyntheticOutcome, type SyntheticPhase } from '../helpers/synthetic-evidence.ts';

/** Synchronous boundary facts only; never wrap or repeat a browser operation. */
class LifecycleEvidence {
  readonly evidence: SyntheticEvidence;
  readonly outcome: SyntheticOutcome = { setup: 'not-started', body: 'not-started', cleanup: 'not-started' };
  currentPhase: SyntheticPhase = 'init';
  private active: { section: keyof SyntheticOutcome; phase: SyntheticPhase } | undefined;

  observer: SyntheticNativeObserver;
  private restore = () => {};
  constructor(caseId: SyntheticCaseId) {
    this.evidence = beginSyntheticCase(caseId);
    this.observer = new SyntheticNativeObserver(this.evidence, () => this.currentPhase);
    if (caseId !== 'P27') {
      try {
        const connect = NativeClient.connect;
        const spy = vi.spyOn(NativeClient, 'connect').mockImplementation((...args) => this.observer.connection(connect(...args)));
        this.restore = () => spy.mockRestore();
      } catch { this.evidence.invalidate(); }
    }
  }
  select<T>(ordinal: number, command: SyntheticCommand, body: () => T): T { return this.observer.select(ordinal, command, body); }
  assert<T>(ordinal: number, body: () => T): T { return this.observer.assert(ordinal, body); }
  phase(section: keyof SyntheticOutcome, phase: SyntheticPhase): void {
    this.returned();
    this.currentPhase = phase;
    this.outcome[section] = 'incomplete';
    this.active = { section, phase };
    this.evidence.record({ kind: 'phase', section, phase, state: 'enter' });
  }
  returned(): void {
    // Enter facts plus explicit section/matcher outcomes replace redundant automatic phase passes.
    this.active = undefined;
  }
  passed(section: keyof SyntheticOutcome): void { this.returned(); this.outcome[section] = 'passed'; this.evidence.record({ kind: 'phase', section, phase: this.currentPhase, state: 'passed' }); }
  failed(section: keyof SyntheticOutcome, cause?: unknown): void {
    if (cause !== undefined) this.observer.failure(section, cause);
    if (this.active !== undefined) this.evidence.record({ kind: 'phase', ...this.active, state: 'failed' });
    this.active = undefined;
    this.outcome[section] = 'failed';
  }
  finish(): void { this.observer.close(); try { this.restore(); } catch { this.evidence.invalidate(); } this.evidence.finish(this.outcome); }
}

/** The segments as files: a local recording never links, so a link here is a failure. */
function videoFiles(segments: readonly VideoSegment[]): VideoFile[] {
  return segments.map((segment) => {
    if (!('path' in segment)) throw new Error(`expected a video file, got a link to ${segment.url}`);
    return segment;
  });
}

function cleanup(signal = new AbortController().signal): EngineCleanupContext {
  return { signal, timeoutMs: 30_000 };
}

function operation(attemptId: string, signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs: 30_000, runId: 'run-pool', attemptId, origin: 'test' };
}

function attempt(attemptId: string, artifactsDir: string) {
  return { attemptId, artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace };
}

function byRole(role: string): LocatorExpression {
  return { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: role, exact: true } } };
}

/** Depth-first walk of one observation tree. */
function* walk(node: SemanticNode): Generator<SemanticNode> {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

/**
 * Decodes a recording inside the page and reads its last frame: the frame's
 * size, how much of it is the grey a screencast pads a smaller frame with,
 * and how much of it is content.
 */
async function lastFrame(
  browser: Browser,
  webm: Buffer,
): Promise<{ width: number; height: number; padded: number; inked: number }> {
  return browser.evaluate(async (bytes) => {
    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/webm' }));
    await new Promise<void>((resolve, reject) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error('the recording did not decode')), { once: true });
    });
    await video.play();
    await new Promise<void>((resolve) => {
      video.addEventListener('ended', () => resolve(), { once: true });
      setTimeout(resolve, 5_000);
    });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(video, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let padded = 0;
    let inked = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      if (r === g && g === b && r > 120 && r < 136) padded += 1;
      else if (r < 200 || g < 200 || b < 200) inked += 1;
    }
    const total = data.length / 4;
    return { width: canvas.width, height: canvas.height, padded: padded / total, inked: inked / total };
  }, [...webm]);
}

const fixtures = new WeakMap<EngineHandle, { attemptId: string; browser: Browser }>();

/** Build the public browser fixture for the current attempt without exposing a backend handle. */
function fixtureOf(engine: EngineHandle, attemptId: string): Browser {
  const existing = fixtures.get(engine);
  if (existing?.attemptId === attemptId) return existing.browser;
  const browser = engine.fixtures!['browser']!({
    operation: () => operation(attemptId),
    expectable: (target: object) => target,
    fixture: (_name: string, target: object) => target,
  } as unknown as EngineFixtureContext) as Browser;
  fixtures.set(engine, { attemptId, browser });
  return browser;
}

/** Install a synthetic document through trusted evaluation, including its inline scripts. */
async function replaceDocument(browser: Browser, html: string): Promise<void> {
  await browser.evaluate((content) => {
    document.open();
    document.write(content);
    document.close();
    return null;
  }, html);
}

/** Keep this segment painting for a bounded interval; decoding its final frame proves capture. */
async function paintSegment(browser: Browser): Promise<void> {
  await browser.evaluate(async () => {
    const marker = document.createElement('div');
    marker.setAttribute('aria-hidden', 'true');
    marker.style.cssText = 'position:fixed;bottom:0;right:0;width:4px;height:4px;pointer-events:none;z-index:2147483647';
    document.body.append(marker);
    const started = performance.now();
    let frame = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('The recording fixture did not paint within 5 seconds')), 5_000);
        const paint = () => {
          marker.style.backgroundColor = frame++ % 2 === 0 ? '#000' : '#f00';
          if (performance.now() - started >= 1_000) { clearTimeout(timeout); resolve(); }
          else requestAnimationFrame(paint);
        };
        requestAnimationFrame(paint);
      });
    } finally { marker.remove(); }
    return null;
  });
}

/** Runs one attempt on a booted engine and always tears it down. */
async function withAttempt(
  engine: EngineHandle,
  app: FixtureApp,
  artifactsDir: string,
  attemptId: string,
  body: () => Promise<void>,
  evidence?: LifecycleEvidence,
  diagnostic?: LifecycleAttemptDiagnostic,
  captureEnv?: NodeJS.ProcessEnv,
): Promise<void> {
  evidence?.phase('setup', 'init');
  diagnostic?.enter('init');
  try { await boot(engine, app, captureEnv); diagnostic?.passed(); }
  catch (cause) { diagnostic?.failed(cause); evidence?.failed('setup', cause); evidence?.finish(); throw cause; }
  let started = false;
  try {
    evidence?.phase('setup', 'start');
    diagnostic?.enter('start');
    await engine.startAttempt!(attempt(attemptId, artifactsDir));
    evidence?.passed('setup');
    diagnostic?.passed();
    started = true;
    diagnostic?.enter('body');
    await body();
    diagnostic?.passed();
    evidence?.passed('body');
  } catch (cause) {
    diagnostic?.failed(cause);
    evidence?.failed(started ? 'body' : 'setup', cause);
    throw cause;
  } finally {
    // Preserve the original sequential finally, including its masking behavior.
    try {
      evidence?.phase('cleanup', 'end');
      diagnostic?.enter('end');
      await engine.endAttempt!(cleanup());
      diagnostic?.passed();
      evidence?.phase('cleanup', 'dispose');
      diagnostic?.enter('dispose');
      await engine.dispose!(cleanup());
      diagnostic?.passed();
      evidence?.passed('cleanup');
    // eslint-disable-next-line no-unsafe-finally -- Preserve the original cleanup exception precedence.
    } catch (cause) { diagnostic?.failed(cause); evidence?.failed('cleanup', cause); throw cause; }
    finally { evidence?.finish(); }
  }
}

async function boot(engine: EngineHandle, app: FixtureApp, captureEnv?: NodeJS.ProcessEnv): Promise<void> {
  await engine.init!({
    runId: 'run-pool',
    targetName: 'web',
    projectRoot: process.cwd(),
    app: { site: new URL(app.url).hostname },
    env: captureEnv ?? process.env,
    headed: false,
    workerSlot: 0,
    log: () => undefined,
    signal: new AbortController().signal,
  });
}

async function openAttempt(
  engine: EngineHandle,
  app: FixtureApp,
  artifactsDir: string,
  attemptId: string,
  evidence?: LifecycleEvidence,
): Promise<string> {
  evidence?.phase('body', 'start');
  await engine.startAttempt!({ attemptId, artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
  evidence?.phase('body', 'navigate');
  await engine.session!.open!(`${app.url}/`, operation(attemptId));
  evidence?.phase('body', 'locate');
  const nodes = await engine.locate!(
    { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } },
    operation(attemptId),
  );
  evidence?.phase('body', 'assertion');
  return nodes[0]?.name ?? '';
}

describe('web engine lifecycle', () => {
  let app: FixtureApp;
  let artifactsDir: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-pool-'));
  });

  afterAll(async () => {
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('declares the full deterministic tier plus the browser fixture', () => {
    const engine = web();
    expect([...engine.capabilities].toSorted()).toEqual([
      'actions',
      'artifacts',
      'browser',
      'keyboard',
      'location',
      'observation',
      'pointer',
      'state',
    ]);
    expect(engine.name).toBe('web');
  });

  it('serves consecutive attempts from one browser and survives an attempt close', async () => {
    const engine = web();
    let failurePhase: 'init' | 'a1-open' | 'a1-observe' | 'a1-end' | 'a2-open' | 'a2-end' | 'dispose' = 'init';
    let failed = false;
    let failure: unknown;
    try {
      await boot(engine, app);
      failurePhase = 'a1-open';
      expect(await openAttempt(engine, app, artifactsDir, 'a1')).toBe('Home');
      failurePhase = 'a1-observe';
      expect((await engine.observe!(operation('a1'))).location).toBe(`${app.url}/`);
      failurePhase = 'a1-end';
      await engine.endAttempt!(cleanup());
      // The next attempt reuses the pooled browser process, not a new launch.
      failurePhase = 'a2-open';
      expect(await openAttempt(engine, app, artifactsDir, 'a2')).toBe('Home');
      failurePhase = 'a2-end';
      await engine.endAttempt!(cleanup());
    } catch (cause) {
      console.error('LIFECYCLE_BODY_FAILURE', JSON.stringify({ phase: failurePhase, code: cause instanceof EngineError ? cause.code : 'unknown' }));
      failed = true; failure = cause;
    } finally {
      failurePhase = 'dispose';
      try { await engine.dispose!(cleanup()); }
      catch (cause) {
        console.error('LIFECYCLE_CLEANUP_FAILURE', JSON.stringify({ phase: failurePhase, code: cause instanceof EngineError ? cause.code : 'unknown' }));
        if (!failed) { failed = true; failure = cause; }
      }
    }
    if (failed) throw failure;
  });

  it('relaunches after dispose and stays idempotent', async () => {
    const engine = web();
    await boot(engine, app);
    await openAttempt(engine, app, artifactsDir, 'b1');
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
    await engine.dispose!(cleanup());

    await boot(engine, app);
    try {
      expect(await openAttempt(engine, app, artifactsDir, 'b2')).toBe('Home');
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  });

  describe('on one shared browser, a fresh attempt per test', () => {
    const engine = web();
    let priorAttemptRetired = true;

    /** Runs one attempt only after its predecessor's actual end has returned. */
    async function inAttempt(attemptId: string, body: () => Promise<void>, dir = artifactsDir, evidence?: LifecycleEvidence, endContext: () => EngineCleanupContext = cleanup): Promise<void> {
      evidence?.phase('setup', 'start');
      try {
        if (!priorAttemptRetired) throw new Error('The shared engine still has an unfinished or failed attempt retirement');
        priorAttemptRetired = false;
        await engine.startAttempt!(attempt(attemptId, dir));
      }
      catch (cause) { evidence?.failed('setup', cause); evidence?.finish(); throw cause; }
      evidence?.passed('setup');
      try {
        await body();
        evidence?.passed('body');
      } catch (cause) { evidence?.failed('body', cause); throw cause; }
      finally {
        try {
          evidence?.phase('cleanup', 'end');
          await engine.endAttempt!(endContext());
          // A hard Vitest timeout does not cancel its async body. Keep later
          // bodies fenced until this exact end succeeds; failure never reopens it.
          priorAttemptRetired = true;
          evidence?.passed('cleanup');
        // eslint-disable-next-line no-unsafe-finally -- Preserve the original cleanup exception precedence.
        } catch (cause) { evidence?.failed('cleanup', cause); throw cause; }
        finally { evidence?.finish(); }
      }
    }

    beforeAll(async () => {
      await boot(engine, app);
    });

    afterAll(async () => {
      await engine.dispose!(cleanup());
    });

    it('observes a semantic tree and locates by display value in one round trip', async () => {
      await inAttempt('d1', async () => {
        await engine.session!.open!(`${app.url}/form`, operation('d1'));

        const snapshot = await engine.observe!(operation('d1'));
        expect(snapshot.root.ref.id).toMatch(/^@e[1-9][0-9]*$/);
        expect(snapshot.root.role).toBe('document');
        expect(snapshot.root.children?.length ?? 0).toBeGreaterThan(0);
        expect(snapshot.location).toBe(`${app.url}/form`);
        expect(snapshot.viewport).toEqual({ width: 1280, height: 720 });

        // displayValue is filtered from the values the batch read returned:
        // two inputs hold "alpha", one holds "beta".
        const alphas = await engine.locate!(
          { kind: 'query', query: { kind: 'displayValue', value: { kind: 'string', value: 'alpha', exact: true } } },
          operation('d1'),
        );
        expect(alphas.map((node) => node.value)).toEqual(['alpha', 'alpha']);
        const betas = await engine.locate!(
          { kind: 'query', query: { kind: 'displayValue', value: { kind: 'string', value: 'beta', exact: true } } },
          operation('d1'),
        );
        expect(betas).toHaveLength(1);
        // A single-match ref performs against the strict locator.
        await engine.perform!(betas[0]!.ref, { kind: 'fill', value: 'gamma', sensitive: false }, operation('d1'));
        const gammas = await engine.locate!(
          { kind: 'query', query: { kind: 'displayValue', value: { kind: 'string', value: 'gamma', exact: true } } },
          operation('d1'),
        );
        expect(gammas.map((node) => node.name)).toEqual(['Second']);
      });
    });

    it('reports pressed and heading level, queries by them, and performs pointer actions on nodes and at points', async () => {
      await inAttempt('pointer1', async () => {
        const op = () => operation('pointer1');
        await engine.session!.open!(`${app.url}/pointer`, op());

        const snapshot = await engine.observe!(op());
        const nodes = [...walk(snapshot.root)];
        const heading = nodes.find((node) => node.role === 'heading');
        expect(heading).toMatchObject({ name: 'Pointer', level: 2 });
        expect(nodes.find((node) => node.name === 'Mute')?.states).toMatchObject({ pressed: false });
        expect(nodes.filter((node) => node.role !== 'heading').every((node) => node.level === undefined)).toBe(true);

        const heading2: LocatorExpression = {
          kind: 'query',
          query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true }, level: 2 },
        };
        const heading1: LocatorExpression = {
          kind: 'query',
          query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true }, level: 1 },
        };
        expect((await engine.locate!(heading2, op())).map((node) => node.name)).toEqual(['Pointer']);
        expect(await engine.locate!(heading1, op())).toEqual([]);

        const pressed = (value: boolean): LocatorExpression => ({
          kind: 'query',
          query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true }, states: { pressed: value } },
        });
        expect(await engine.locate!(pressed(true), op())).toEqual([]);
        const [mute] = await engine.locate!(pressed(false), op());
        await engine.perform!(mute!.ref, { kind: 'tap' }, op());
        expect((await engine.locate!(pressed(true), op())).map((node) => node.name)).toEqual(['Mute']);

        const [menuTarget] = await engine.locate!({ kind: 'selector', selector: '#menu-target' }, op());
        await engine.perform!(menuTarget!.ref, { kind: 'secondaryTap' }, op());
        const [afterMenu] = await engine.locate!({ kind: 'selector', selector: '#menu-target' }, op());
        expect(afterMenu?.text).toBe('context menu');

        // Every pointer kind at a bare point, read back from the page's event log.
        expect(engine.pointerActions).toEqual(['tap', 'doubleTap', 'secondaryTap', 'longPress', 'hover', 'dragTo', 'swipe', 'swipeTo']);
        await engine.performAt!({ x: 150, y: 350 }, { kind: 'tap' }, op());
        await engine.performAt!({ x: 160, y: 360 }, { kind: 'doubleTap' }, op());
        await engine.performAt!({ x: 170, y: 370 }, { kind: 'secondaryTap' }, op());
        await engine.performAt!({ x: 180, y: 380 }, { kind: 'longPress', durationMs: 120 }, op());
        await engine.performAt!({ x: 190, y: 390 }, { kind: 'hover' }, op());
        await engine.performAt!({ x: 200, y: 400 }, { kind: 'dragTo', target: { x: 300, y: 450 } }, op());
        await engine.performAt!({ x: 210, y: 410 }, { kind: 'swipe', direction: 'down' }, op());
        // A fractional path lands on whole pixels: the browser would truncate it a pixel early.
        await engine.performAt!({ x: 220.6, y: 420.4 }, { kind: 'swipeTo', target: { x: 320.5, y: 460.5 } }, op());
        const [log] = await engine.locate!({ kind: 'selector', selector: '#log' }, op());
        const lines = (log?.text ?? '').split('\n').filter((line) => line !== '');
        expect(lines).toContain('click:150,350');
        expect(lines.filter((line) => line.startsWith('dblclick:'))).toEqual(['dblclick:160,360']);
        expect(lines).toContain('contextmenu:170,370');
        expect(lines).toContain('mousedown:180,380');
        expect(lines).toContain('mouseup:180,380');
        expect(lines).toContain('mousedown:200,400');
        expect(lines).toContain('mouseup:300,450');
        expect(lines.some((line) => line.startsWith('wheel:210,410:') && Number(line.split(':')[2]) > 0)).toBe(true);
        expect(lines).toContain('mousedown:221,420');
        expect(lines).toContain('mouseup:321,461');
      });
    });

    it.each([
      { name: 'inside', width: 400, height: 300, x: 80, y: 70, aimX: 80, aimY: 70 },
      { name: 'overflow descendant', width: 100, height: 100, x: 120, y: 50, aimX: 120, aimY: 50 },
      { name: 'outside', width: 400, height: 300, x: 500, y: 350, aimX: 200, aimY: 150 },
      { name: 'covered', width: 400, height: 300, x: 80, y: 70, aimX: 200, aimY: 150 },
      { name: 'iframe', width: 100, height: 100, x: 80, y: 70, aimX: 50, aimY: 50 },
    ])('keeps native node wheel aiming compatible in a real renderer ($name)', async ({ name, width, height, x, y, aimX, aimY }) => {
      await inAttempt(`wheel-${name}`, async () => {
        const op = () => operation(`wheel-${name}`);
        await engine.session!.open!(`${app.url}/`, op());
        const browser = nativeBrowser(engine, op, app.url);
        const userAgent = await browser.evaluate(() => navigator.userAgent);
        console.info('LOCAL_POINTER_NATIVE_VERSION', /Chrome\/(\d+(?:\.\d+){3})/.exec(userAgent)?.[1] ?? 'unknown');
        const page = `<!doctype html><html><body style="margin:0;width:1000px;height:800px">
          <div id="wheel-parent" style="position:absolute;left:0;top:0;width:${width}px;height:${height}px;overflow:visible">
            <div style="position:absolute;left:0;top:0;width:${name === 'overflow descendant' ? 150 : width}px;height:${height}px;background:#eee">wheel target</div>
          </div>
          ${name === 'covered' ? '<div style="position:absolute;left:60px;top:50px;width:40px;height:40px;background:#999">cover</div>' : ''}
          <script>
            window.wheelEvents=[];
            document.addEventListener('mousemove', event => wheelEvents.push({type:'move',x:event.clientX,y:event.clientY}));
            document.addEventListener('wheel', event => {wheelEvents.push({type:'wheel',x:event.clientX,y:event.clientY,dy:event.deltaY});event.preventDefault()}, {passive:false});
          </script></body></html>`;
        await replaceDocument(browser, name === 'iframe'
          ? `<!doctype html><body style="margin:0"><iframe id="wheel-frame" style="position:absolute;left:20px;top:30px;width:200px;height:200px;border:0" srcdoc="${page.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe></body>`
          : page);
        if (name === 'iframe') {
          await expect.poll(() => browser.evaluate(() => document.querySelector('iframe')?.contentDocument?.querySelector('#wheel-parent') != null)).toBe(true);
        }
        const target: LocatorExpression = name === 'iframe'
          ? { kind: 'frame', selector: '#wheel-frame', source: { kind: 'selector', selector: '#wheel-parent' } }
          : { kind: 'selector', selector: '#wheel-parent' };
        const [node] = await engine.locate!(target, op());
        expect(node).toBeDefined();
        await engine.performAt!({ x, y }, { kind: 'hover' }, op());
        await browser.evaluate((framed) => {
          const win = framed ? document.querySelector('iframe')!.contentWindow! : window;
          (win as unknown as { wheelEvents: unknown[] }).wheelEvents = [];
          return null;
        }, name === 'iframe');
        await engine.perform!(node!.ref, { kind: 'swipe', direction: 'down' }, op());
        const events = await browser.evaluate((framed) => {
          const win = framed ? document.querySelector('iframe')!.contentWindow! : window;
          return Array.from((win as unknown as { wheelEvents: { type: string; x: number; y: number; dy?: number }[] }).wheelEvents,
            event => ({ ...event }));
        }, name === 'iframe');
        expect(events.filter(event => event.type === 'wheel')).toEqual([{ type: 'wheel', x: aimX, y: aimY, dy: height / 2 }]);
        expect(events.filter(event => event.type === 'move')).toEqual(name === 'inside' || name === 'overflow descendant'
          ? [] : [{ type: 'move', x: aimX, y: aimY }]);
      });
    });

    it('keeps tree attributes bounded while node reads expose every attribute', async () => {
      await inAttempt('attributes1', async () => {
        await engine.session!.open!(`${app.url}/`, operation('attributes1'));

        const snapshot = await engine.observe!(operation('attributes1'));
        const treeNodes = [...walk(snapshot.root)];
        expect(treeNodes.some((node) => node.attributes?.class === 'card active')).toBe(false);
        expect(treeNodes.some((node) => node.attributes?.readonly !== undefined)).toBe(false);
        expect(treeNodes.some((node) => node.attributes?.['data-extra'] !== undefined)).toBe(false);

        const [card] = await engine.locate!(
          { kind: 'selector', selector: '#class-card' },
          operation('attributes1'),
        );
        expect(card?.attributes).toMatchObject({
          class: 'card active',
          'data-extra': 'node-only',
        });
        expect(card?.attributes?.readonly).toBeUndefined();
        const [readonly] = await engine.locate!(
          { kind: 'selector', selector: '#readonly' },
          operation('attributes1'),
        );
        expect(readonly?.attributes?.readonly).toBe('');
      });
    });

    it('selects positionally among display-value matches and keeps composition honest', async () => {
      const shared: LocatorExpression = {
        kind: 'query',
        query: { kind: 'displayValue', value: { kind: 'string', value: 'shared', exact: true } },
      };
      const names = (nodes: readonly SemanticNode[]) => nodes.map((node) => node.name);
      await inAttempt('dv1', async () => {
        await engine.session!.open!(`${app.url}/values`, operation('dv1'));

        // Positions are relative to the value-filtered matches, not to every
        // form control on the page: "Other" sits between none of them.
        expect(names(await engine.locate!(shared, operation('dv1')))).toEqual(['First', 'Second', 'Third']);
        expect(names(await engine.locate!({ kind: 'index', source: shared, index: 'first' }, operation('dv1')))).toEqual(['First']);
        expect(names(await engine.locate!({ kind: 'index', source: shared, index: 1 }, operation('dv1')))).toEqual(['Second']);
        expect(names(await engine.locate!({ kind: 'index', source: shared, index: 'last' }, operation('dv1')))).toEqual(['Third']);
        expect(await engine.locate!({ kind: 'index', source: shared, index: 3 }, operation('dv1'))).toEqual([]);

        // Positions chain innermost first: first() of last() is still the last match.
        const firstOfLast = await engine.locate!(
          { kind: 'index', source: { kind: 'index', source: shared, index: 'last' }, index: 'first' },
          operation('dv1'),
        );
        expect(names(firstOfLast)).toEqual(['Third']);

        // filter({ hasText }) composes as a per-element Playwright filter ahead of
        // the value predicate. Inputs have no text content; the textarea's is its
        // initial content, exactly as for any other query.
        const withText = await engine.locate!(
          { kind: 'filter', source: shared, hasText: { kind: 'string', value: 'shared', exact: false } },
          operation('dv1'),
        );
        expect(names(withText)).toEqual(['Third']);
        expect(
          await engine.locate!(
            { kind: 'filter', source: shared, hasText: { kind: 'string', value: 'nowhere', exact: false } },
            operation('dv1'),
          ),
        ).toEqual([]);

        // A filter after a position is checked on the selected element alone:
        // the last match is the textarea, whose text content is "shared"; the
        // first is an input with no text content at all.
        const lastWithText = await engine.locate!(
          {
            kind: 'filter',
            source: { kind: 'index', source: shared, index: 'last' },
            hasText: { kind: 'string', value: 'shared', exact: false },
          },
          operation('dv1'),
        );
        expect(names(lastWithText)).toEqual(['Third']);
        expect(
          await engine.locate!(
            {
              kind: 'filter',
              source: { kind: 'index', source: shared, index: 'first' },
              hasText: { kind: 'string', value: 'shared', exact: false },
            },
            operation('dv1'),
          ),
        ).toEqual([]);
        // ... and `has` on a positional match too; a form control has no
        // descendant nodes, so nothing survives.
        expect(
          await engine.locate!(
            { kind: 'filter', source: { kind: 'index', source: shared, index: 'last' }, has: byRole('textbox') },
            operation('dv1'),
          ),
        ).toEqual([]);

        // The ref a positional match hands back acts on that element alone.
        const [last] = await engine.locate!({ kind: 'index', source: shared, index: 'last' }, operation('dv1'));
        await engine.perform!(last!.ref, { kind: 'fill', value: 'edited', sensitive: false }, operation('dv1'));
        expect(names(await engine.locate!(shared, operation('dv1')))).toEqual(['First', 'Second']);
        const edited: LocatorExpression = {
          kind: 'query',
          query: { kind: 'displayValue', value: { kind: 'string', value: 'edited', exact: true } },
        };
        expect(names(await engine.locate!(edited, operation('dv1')))).toEqual(['Third']);

        // What still needs the value predicate inside Playwright's chain stays
        // unsupported, and says which compositions those are.
        const child: LocatorExpression = {
          kind: 'query',
          query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true } },
          scope: shared,
        };
        await expect(engine.locate!(child, operation('dv1'))).rejects.toMatchObject({
          code: 'UNSUPPORTED_CAPABILITY',
          message: 'displayValue queries cannot scope child queries, serve as a has-filter, or form a union in this engine',
          retryable: false,
        });
        await expect(
          engine.locate!({ kind: 'filter', source: byRole('main'), has: shared }, operation('dv1')),
        ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
      });
    });

    it('excludes hidden twins from a visible query, for every query kind and under an index', async () => {
      const evidence = new LifecycleEvidence('P24');
      const query = (
        kind: 'text' | 'label' | 'placeholder' | 'displayValue' | 'testId' | 'role',
        value: string,
        visible: boolean,
      ): LocatorExpression => ({
        kind: 'query',
        query: { kind, value: { kind: 'string', value, exact: true }, ...(visible ? { visible: true } : {}) },
      });
      await inAttempt('v1', async () => {
        evidence.phase('body', 'open');
        await engine.session!.open!(`${app.url}/twins`, operation('v1'));
        evidence.phase('body', 'locate');

        const twins: Array<[Parameters<typeof query>[0], string]> = [
          ['text', 'No memories yet'],
          ['label', 'Memory search'],
          ['placeholder', 'Search memory...'],
          ['displayValue', 'alpha'],
          ['testId', 'memory-empty'],
        ];
        for (const [kind, value] of twins) {
          const all = await engine.locate!(query(kind, value, false), operation('v1'));
          expect(all.map((node) => node.states?.hidden === true), `${kind} without visible`).toEqual([true, false]);
          const shown = await engine.locate!(query(kind, value, true), operation('v1'));
          expect(shown, `${kind} with visible`).toHaveLength(1);
          expect(shown[0]?.states?.hidden).toBeUndefined();
          expect(shown[0]?.rect?.width ?? 0).toBeGreaterThan(0);
        }

        // A role query already skips display:none; visible leaves it alone: the twin's shown
        // button, the labeled button, and the insert button below, never the hidden twin.
        expect(await engine.locate!(query('role', 'button', true), operation('v1'))).toHaveLength(3);

        // A required-field marker is aria-hidden: the label names the field without it.
        const required = await engine.locate!(query('label', 'Display name', false), operation('v1'));
        expect(required).toHaveLength(1);
        expect(required[0]?.name).toBe('Display name');
        // Hidden text between visible fragments is skipped too, and CSS-hidden text stays out.
        const infix = await engine.locate!(query('label', 'Team name', false), operation('v1'));
        expect(infix.map((node) => node.name)).toEqual(['Team name']);
        const mixed = await engine.locate!(query('label', 'Mixed', false), operation('v1'));
        expect(mixed.map((node) => node.name)).toEqual(['Mixed']);
        // Any associated label matches, as getByLabel promises: an overridden one and a second one.
        expect(await engine.locate!(query('label', 'Visible label', false), operation('v1'))).toHaveLength(1);
        expect(await engine.locate!(query('label', 'Second label', false), operation('v1'))).toHaveLength(1);
        expect(await engine.locate!(query('label', 'First label', false), operation('v1'))).toHaveLength(1);
        // Every labelable element carries its labels: a button and a meter too, not only text fields.
        const labeledButton = await engine.locate!(query('label', 'Run the check', false), operation('v1'));
        expect(labeledButton.map((node) => node.role)).toEqual(['button']);
        expect(await engine.locate!(query('label', 'Score', false), operation('v1'))).toHaveLength(1);
        // The marker is still on the screen a person reads: the label's own text keeps it.
        expect(await engine.locate!(query('text', 'Display name*', false), operation('v1'))).toHaveLength(1);

        // A predicate-filtered match is pinned to its element: a field inserted ahead of it
        // between locate and perform shifts every candidate index, and the fill still lands on
        // the field that matched.
        const displayName = (await engine.locate!(query('label', 'Display name', false), operation('v1')))[0]!;
        const insert = (await engine.locate!(query('role', 'button', false), operation('v1'))).find(
          (node) => node.name === 'Insert a field',
        )!;
        await engine.perform!(insert.ref, { kind: 'tap' }, operation('v1'));
        await engine.perform!(displayName.ref, { kind: 'fill', value: 'pinned', sensitive: false }, operation('v1'));
        const after = await engine.locate!(query('label', 'Display name', false), operation('v1'));
        expect(after.map((node) => node.value)).toEqual(['pinned']);
        const inserted = await engine.locate!(query('label', 'Inserted', false), operation('v1'));
        expect(inserted.map((node) => node.value ?? '')).toEqual(['']);

        // A visibility: hidden twin is hidden; an aria-hidden node still paints, so it is visible.
        expect(await engine.locate!(query('text', 'Decorative twin', false), operation('v1'))).toHaveLength(2);
        const decorative = await engine.locate!(query('text', 'Decorative twin', true), operation('v1'));
        expect(decorative.map((node) => node.states?.hidden)).toEqual([undefined]);
        const spinner = await engine.locate!(query('text', 'Decorative spinner', true), operation('v1'));
        expect(spinner.map((node) => [node.attributes?.['aria-hidden'], node.states?.hidden])).toEqual([['true', undefined]]);

        // Under an index the predicate runs before nth: first() is the first shown node, not the first node.
        const firstAny = await engine.locate!(
          { kind: 'index', source: query('text', 'No memories yet', false), index: 'first' },
          operation('v1'),
        );
        expect(firstAny.map((node) => node.states?.hidden)).toEqual([true]);
        const firstShown = await engine.locate!(
          { kind: 'index', source: query('text', 'No memories yet', true), index: 'first' },
          operation('v1'),
        );
        expect(firstShown).toHaveLength(1);
        expect(firstShown[0]?.states?.hidden).toBeUndefined();

        // The surviving ref acts on the shown element.
        const [search] = await engine.locate!(query('placeholder', 'Search memory...', true), operation('v1'));
        await engine.perform!(search!.ref, { kind: 'fill', value: 'launch', sensitive: false }, operation('v1'));
        const filled = await engine.locate!(query('displayValue', 'launch', false), operation('v1'));
        expect(filled.map((node) => node.states?.hidden)).toEqual([undefined]);
      }, artifactsDir, evidence);
    });

    it('applies visible before an index, filter, or scope, so a hidden twin is never selected', async () => {
      const evidence = new LifecycleEvidence('P25');
      const text = (value: string, visible: boolean): Extract<LocatorExpression, { kind: 'query' }> => ({
        kind: 'query',
        query: { kind: 'text', value: { kind: 'string', value, exact: true }, ...(visible ? { visible: true } : {}) },
      });
      const hidden = (nodes: readonly SemanticNode[]) => nodes.map((node) => node.states?.hidden);
      await inAttempt('v2', async () => {
        evidence.phase('body', 'open');
        await engine.session!.open!(`${app.url}/twins`, operation('v2'));
        evidence.phase('body', 'locate');
        const locate = (expression: LocatorExpression) => engine.locate!(expression, operation('v2'));

        // The hidden paragraph comes first in document order.
        expect(hidden(await locate({ kind: 'index', source: text('Decorative twin', false), index: 'first' }))).toEqual([true]);
        expect(hidden(await locate({ kind: 'index', source: text('Decorative twin', true), index: 'first' }))).toEqual([undefined]);
        expect(hidden(await locate({ kind: 'index', source: text('Decorative twin', true), index: 0 }))).toEqual([undefined]);
        expect(await locate({ kind: 'index', source: text('Decorative twin', true), index: 1 })).toEqual([]);
        expect(hidden(await locate({ kind: 'index', source: text('Decorative twin', true), index: 'last' }))).toEqual([undefined]);

        // The reader's own state narrows inside the chain, so a twin only Playwright calls visible is never first.
        const contents = await locate({ kind: 'index', source: text('Contents twin', true), index: 'first' });
        expect(contents.map((node) => [node.attributes?.['id'], node.states?.hidden])).toEqual([['contents-shown', undefined]]);
        expect(hidden(await locate({ kind: 'index', source: text('Contents twin', false), index: 'first' }))).toEqual([true]);

        // A filter over a visible query never retains the hidden twin.
        const decorative = { kind: 'string', value: 'Decorative', exact: false } as const;
        expect(await locate({ kind: 'filter', source: text('Decorative twin', false), hasText: decorative })).toHaveLength(2);
        const filtered = await locate({ kind: 'filter', source: text('Decorative twin', true), hasText: decorative });
        expect(hidden(filtered)).toEqual([undefined]);

        // As a has-filter, only the shown twin's ancestor qualifies: the body holds both, so it still matches,
        // while a section that holds neither does not.
        const body: LocatorExpression = { kind: 'selector', selector: 'body' };
        expect(await locate({ kind: 'filter', source: body, has: text('Decorative twin', true) })).toHaveLength(1);
        expect(await locate({ kind: 'filter', source: { kind: 'selector', selector: '#live' }, has: text('Decorative twin', true) })).toEqual([]);

        // As a scope, a visible test-id query drops the hidden panel before the child query runs.
        const panel = (visible: boolean): LocatorExpression => ({
          kind: 'query',
          query: { kind: 'testId', value: { kind: 'string', value: 'memory-panel', exact: true }, ...(visible ? { visible: true } : {}) },
        });
        expect(hidden(await locate({ ...text('Open', false), scope: panel(false) }))).toEqual([undefined, undefined]);
        const scoped = await locate({ ...text('Open', false), scope: panel(true) });
        expect(scoped).toHaveLength(1);
        // Both children are visible, one overriding its panel's visibility; the exclusion came from the scope.
        const panels = await locate(panel(true));
        expect(hidden(panels)).toEqual([undefined]);
        await engine.perform!(scoped[0]!.ref, { kind: 'tap' }, operation('v2'));
      }, artifactsDir, evidence);
    });

    it('takes a display-value position among shown matches when the query is visible', async () => {
      const alpha = (visible: boolean): LocatorExpression => ({
        kind: 'query',
        query: { kind: 'displayValue', value: { kind: 'string', value: 'alpha', exact: true }, ...(visible ? { visible: true } : {}) },
      });
      const hidden = (nodes: readonly SemanticNode[]) => nodes.map((node) => node.states?.hidden);
      await inAttempt('dv2', async () => {
        await engine.session!.open!(`${app.url}/twins`, operation('dv2'));
        const locate = (expression: LocatorExpression) => engine.locate!(expression, operation('dv2'));

        // The display:none control comes first in document order, so without
        // visible the first position is the hidden twin.
        expect(hidden(await locate({ kind: 'index', source: alpha(false), index: 'first' }))).toEqual([true]);
        expect(hidden(await locate({ kind: 'index', source: alpha(false), index: 1 }))).toEqual([undefined]);

        // With visible, hidden candidates leave before the value predicate and
        // its positional steps run, so every position is among shown controls.
        expect(hidden(await locate({ kind: 'index', source: alpha(true), index: 'first' }))).toEqual([undefined]);
        expect(hidden(await locate({ kind: 'index', source: alpha(true), index: 0 }))).toEqual([undefined]);
        expect(hidden(await locate({ kind: 'index', source: alpha(true), index: 'last' }))).toEqual([undefined]);
        expect(await locate({ kind: 'index', source: alpha(true), index: 1 })).toEqual([]);

        // A filter after the position runs on the shown element alone.
        const filtered = await locate({
          kind: 'filter',
          source: { kind: 'index', source: alpha(true), index: 'first' },
          hasText: { kind: 'string', value: 'nothing here', exact: false },
        });
        expect(filtered).toEqual([]);

        // The positional ref acts on the shown control, and the hidden twin keeps its value.
        const [first] = await locate({ kind: 'index', source: alpha(true), index: 'first' });
        await engine.perform!(first!.ref, { kind: 'fill', value: 'launch', sensitive: false }, operation('dv2'));
        expect(hidden(await locate(alpha(false)))).toEqual([true]);
        expect(
          hidden(await locate({ kind: 'query', query: { kind: 'displayValue', value: { kind: 'string', value: 'launch', exact: true } } })),
        ).toEqual([undefined]);
      });
    });

    it('keeps a node id across observations while its element lives, and reports it stale once it is gone', async () => {
      await inAttempt('o1', async () => {
        await engine.session!.open!(`${app.url}/form`, operation('o1'));
        const first = await engine.observe!(operation('o1'));
        const textbox = [...walk(first.root)].find((node) => node.role === 'textbox');
        expect(textbox).toBeDefined();
        await engine.perform!(textbox!.ref, { kind: 'fill', value: 'fresh', sensitive: false }, operation('o1'));

        // The id is stamped on the element: a second look names the same
        // textbox by the same id, and the earlier ref still acts on it.
        const second = await engine.observe!(operation('o1'));
        const again = [...walk(second.root)].find((node) => node.role === 'textbox');
        expect(again!.ref.id).toBe(textbox!.ref.id);
        await engine.perform!(textbox!.ref, { kind: 'fill', value: 'late', sensitive: false }, operation('o1'));

        // A new document has none of the old elements: the id is gone with it.
        await engine.session!.open!(`${app.url}/`, operation('o1'));
        const third = await engine.observe!(operation('o1'));
        expect([...walk(third.root)].some((node) => node.ref.id === textbox!.ref.id)).toBe(false);
        await expect(
          engine.perform!(textbox!.ref, { kind: 'fill', value: 'gone', sensitive: false }, operation('o1')),
        ).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
      });
    });

    it('reports a located ref stale once a second element matches it, and acts on neither', async () => {
      await inAttempt('amb1', async () => {
        await engine.session!.open!(`${app.url}/`, operation('amb1'));
        const browser = fixtureOf(engine, 'amb1');
        await replaceDocument(browser, '<script>window.taps = 0</script><button onclick="taps++">Go</button>');
        const [go] = await engine.locate!(byRole('button'), operation('amb1'));
        await browser.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<button onclick="taps++">Go</button>'); return null; });

        await expect(engine.perform!(go!.ref, { kind: 'tap' }, operation('amb1'))).rejects.toMatchObject({
          code: 'NODE_STALE',
          retryable: true,
        });
        expect(await browser.evaluate(() => (window as unknown as { taps: number }).taps)).toBe(0);
      });
    });

    it('reports a drag whose drop target turns ambiguous after the press as possibly committed', async () => {
      const evidence = new LifecycleEvidence('P26');
      await inAttempt('amb2', async () => {
        evidence.phase('body', 'navigate');
        await engine.session!.open!(`${app.url}/`, operation('amb2'));
        const browser = fixtureOf(engine, 'amb2');
        await replaceDocument(browser, `
          <script>window.downs = 0</script>
          <button onmousedown="downs++; document.body.insertAdjacentHTML('beforeend', '<div role=region>Drop</div>')">Card</button>
          <div role="region">Drop</div>`);
        evidence.phase('body', 'initial-locate');
        const cards = await engine.locate!(byRole('button'), operation('amb2'));
        const zones = await engine.locate!(byRole('region'), operation('amb2'));
        // Retain the existing results before either .ref is accessed. No new query or renderer read.
        evidence.evidence.observe(() => ({
          kind: 'drag-acquisition', sourcePresent: cards.length > 0, targetPresent: zones.length > 0,
          sourceUnique: cards.length === 1, targetUnique: zones.length === 1,
          sourceCount: cards.length, targetCount: zones.length,
        }));
        const [card] = cards;
        const [zone] = zones;

        evidence.phase('body', 'perform');
        await expect(
          engine.perform!(card!.ref, { kind: 'dragTo', target: zone!.ref }, operation('amb2')),
        ).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
        evidence.phase('body', 'assertion');
        expect(await browser.evaluate(() => (window as unknown as { downs: number }).downs)).toBe(1);
      }, artifactsDir, evidence);
    });

    it('mints native document ids and keeps a separate viewport ref across navigation for swipes', async () => {
      await inAttempt('r1', async () => {
        await engine.session!.open!(`${app.url}/form`, operation('r1'));
        const first = await engine.observe!(operation('r1'));
        expect(first.root.ref.id).toMatch(/^@e[1-9][0-9]*$/);
        expect(first.viewportRef?.id).toMatch(/^@e[1-9][0-9]*$/);
        expect(first.viewportRef?.id).not.toBe(first.root.ref.id);
        expect(first.root.name).toBe('Fixture Form');
        // Document and element ids come from the same native identity registry.
        expect([...walk(first.root)].every((node) => /^@e[1-9][0-9]*$/.test(node.ref.id))).toBe(true);

        // A new document gets new ids while the viewport target survives navigation.
        await engine.session!.open!(`${app.url}/`, operation('r1'));
        const second = await engine.observe!(operation('r1'));
        expect(second.root.ref.id).toMatch(/^@e[1-9][0-9]*$/);
        expect(second.root.ref.id).not.toBe(first.root.ref.id);
        expect(second.viewportRef).toEqual(first.viewportRef);
        expect(second.root.name).toBe('Fixture Home');
        expect(second.location).toBe(`${app.url}/`);

        // The viewport swipe uses its own ref from the earlier observation, never the document ref.
        const browser = fixtureOf(engine, 'r1');
        await replaceDocument(browser, '<div style="height: 5000px">tall</div>');
        await engine.perform!(first.viewportRef!, { kind: 'swipe', direction: 'down' }, operation('r1'));
        await expect.poll(() => browser.evaluate(() => window.scrollY)).toBeGreaterThan(0);
        expect(await browser.evaluate(() => window.scrollY)).toBe(360);
        await engine.perform!(first.viewportRef!, { kind: 'swipe', direction: 'up', momentum: 'fast' }, operation('r1'));
        await expect.poll(() => browser.evaluate(() => window.scrollY)).toBe(0);
      });
    });

    it('refuses to swipe a node with no box even when its child is under aim', async () => {
      const evidence = new LifecycleEvidence('P27');
      const observer = evidence.observer = new SyntheticNativeObserver(evidence.evidence, () => evidence.currentPhase);
      const caseDeadline = performance.now() + 30_000;
      const settleReserveMs = 10_000;
      const swipeBudgetMs = 1_000;
      const boundedOperation = (attemptId: string, maximumMs = 5_000): OperationContext => {
        const timeoutMs = Math.min(maximumMs, caseDeadline - performance.now() - settleReserveMs);
        if (timeoutMs <= 0) throw new Error('No operation budget remains before required attempt retirement');
        return { ...operation(attemptId), timeoutMs };
      };
      const boundedCleanup = (): EngineCleanupContext => ({ ...cleanup(), timeoutMs: 5_000 });
      const performed: { timeoutMs: number; result: ReturnType<NativeClient['request']> }[] = [];
      const request = NativeClient.prototype.request;
      const spy = vi.spyOn(NativeClient.prototype, 'request').mockImplementation(function (this: NativeClient, ...args) {
        if ((args[0] !== 'browser.perform' && args[0] !== 'scope.end') || args[2].attemptId !== 'dc2') return request.apply(this, args);
        const timeoutMs = args[2].timeoutMs;
        const result = request.apply(this, args);
        observer.observePromise(args[0], evidence.currentPhase, result);
        if (args[0] === 'browser.perform') performed.push({ timeoutMs, result });
        return result;
      });
      try {
        await inAttempt('dc2', async () => {
          evidence.phase('body', 'navigate');
          await engine.session!.open!(`${app.url}/`, boundedOperation('dc2'));
          // Use the real fixture graph for setup/readback, not fixtureOf's
          // fabricated EngineFixtureContext. The retained-ref action stays exact.
          const browser = nativeBrowser(engine, () => boundedOperation('dc2'), app.url);
          evidence.phase('body', 'document');
          await replaceDocument(browser, `
            <body style="margin: 0"><ul aria-label="Feed" style="display: contents"><li style="display: block; height: 400px">Item</li></ul>
            <div style="height:4000px"></div><script>
              window.noBoxEvents = { input: 0, scroll: 0 };
              for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchmove', 'touchend', 'wheel', 'keydown', 'keyup', 'input']) {
                addEventListener(type, () => noBoxEvents.input++, true);
              }
              addEventListener('scroll', () => noBoxEvents.scroll++, true);
            </script></body>`);
          evidence.phase('body', 'locate');
          const [feed] = await engine.locate!(byRole('list'), boundedOperation('dc2'));
          evidence.phase('body', 'perform');
          // The actionability wait must fit inside the unchanged 30s case,
          // leaving time for native settlement, end, and a fresh attempt.
          await evidence.assert(0, () => expect(
            evidence.select(0, 'browser.perform', () => engine.perform!(feed!.ref, { kind: 'swipe', direction: 'down' }, boundedOperation('dc2', swipeBudgetMs))),
          ).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' }));
          evidence.phase('body', 'assertion');
          expect(performed).toHaveLength(1);
          expect(performed[0]!.timeoutMs).toBeGreaterThan(0);
          expect(performed[0]!.timeoutMs).toBeLessThanOrEqual(swipeBudgetMs);
          expect(await performed[0]!.result).toMatchObject({
            ok: false, error: { code: 'not-actionable' }, effects: 'not-dispatched', scopeState: 'usable',
          });
          expect(await browser.evaluate(() => ({
            ...(window as unknown as { noBoxEvents: { input: number; scroll: number } }).noBoxEvents,
            x: scrollX, y: scrollY,
          }))).toEqual({ input: 0, scroll: 0, x: 0, y: 0 });
        }, artifactsDir, evidence, boundedCleanup);
        // This body is unreachable if the original attempt's end rejected or
        // is still pending. Do not hide a retirement failure by starting anew.
        await inAttempt('dc2-next', async () => {
          await engine.session!.open!(`${app.url}/`, boundedOperation('dc2-next'));
          const headings = await engine.locate!(byRole('heading'), boundedOperation('dc2-next'));
          expect(headings[0]?.name).toBe('Home');
        }, artifactsDir, undefined, boundedCleanup);
      } finally { spy.mockRestore(); }
    });

    it('walks through a display:contents element to the fields it lays out', async () => {
      const evidence = new LifecycleEvidence('P28');
      await inAttempt('dc1', async () => {
        evidence.phase('body', 'navigate');
        await engine.session!.open!(`${app.url}/contents`, operation('dc1'));
        evidence.phase('body', 'observe');
        const snapshot = await engine.observe!(operation('dc1'));
        evidence.phase('body', 'assertion');
        const fields = [...walk(snapshot.root)].filter((node) => node.role === 'textbox').map((node) => node.name);
        expect(fields).toEqual(['Email', 'First name']);
      }, artifactsDir, evidence);
    });

    it('masks a password inside a closed shadow root in artifact screenshots', async () => {
      const evidence = new LifecycleEvidence('P29');
      const shotDir = mkdtempSync(path.join(tmpdir(), 'e2e-shot-'));
      try {
        await inAttempt('cm1', async () => {
          evidence.phase('body', 'navigate');
          await engine.session!.open!(`${app.url}/closed-login`, operation('cm1'));
          evidence.phase('body', 'observe');
          const snapshot = await engine.observe!(operation('cm1'));
          evidence.phase('body', 'assertion');
          const nodes = [...walk(snapshot.root)];
          const user = nodes.find((node) => node.role === 'textbox' && node.name === 'User');
          const password = nodes.find((node) => node.states?.secure === true);
          expect(user?.rect).toBeDefined();
          expect(password?.rect).toBeDefined();
          evidence.phase('body', 'perform');
          await engine.perform!(password!.ref, { kind: 'fill', value: 'hunter2', sensitive: true }, operation('cm1'));

          evidence.phase('body', 'screenshot');
          const relative = await engine.artifacts!.screenshot('closed', operation('cm1'));
          evidence.phase('body', 'assertion');
          const image = decodePng(new Uint8Array(readFileSync(path.join(shotDir, relative))));
          const centre = (rect: NonNullable<SemanticNode['rect']>) =>
            [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)] as const;
          const [px, py] = centre(password!.rect!);
          const [ux, uy] = centre(user!.rect!);
          expect(image.pixelAt(px, py).slice(0, 3)).toEqual([0, 0, 0]);
          expect(image.pixelAt(ux, uy).slice(0, 3)).toEqual([255, 255, 255]);
        }, shotDir, evidence);
      } finally {
        rmSync(shotDir, { recursive: true, force: true });
      }
    });

    it('masks a password inside an iframe in artifact screenshots and observed pixels', async () => {
      const evidence = new LifecycleEvidence('P30');
      const shotDir = mkdtempSync(path.join(tmpdir(), 'e2e-shot-'));
      const field = 'position:absolute;left:20px;width:160px;height:40px;border:0;padding:0;background:#f00;color:#f00';
      const frame = `<body style="margin:0"><input type="password" value="hunter2" style="${field};top:20px"><input value="plain" style="${field};top:100px"></body>`;
      try {
        await inAttempt('fm1', async () => {
          evidence.phase('body', 'navigate');
          await engine.session!.open!(`${app.url}/`, operation('fm1'));
          const browser = fixtureOf(engine, 'fm1');
          evidence.phase('body', 'document');
          await replaceDocument(browser,
            `<body style="margin:0"><iframe srcdoc='${frame}' style="position:absolute;left:0;top:0;width:400px;height:200px;border:0"></iframe></body>`,
          );
          evidence.phase('body', 'readiness');
          await expect.poll(() => browser.evaluate(() =>
            document.querySelector('iframe')?.contentDocument?.querySelector('input[type=password]') != null
            && document.querySelector('iframe')?.contentDocument?.readyState === 'complete',
          )).toBe(true);

          evidence.phase('body', 'screenshot');
          const relative = await engine.artifacts!.screenshot('framed', operation('fm1'));
          evidence.phase('body', 'assertion');
          const shot = decodePng(new Uint8Array(readFileSync(path.join(shotDir, relative))));
          expect(shot.pixelAt(100, 40).slice(0, 3)).toEqual([0, 0, 0]);
          expect(shot.pixelAt(100, 120).slice(0, 3)).toEqual([255, 0, 0]);

          evidence.phase('body', 'observe');
          const observed = await engine.observe!(operation('fm1'), { pixels: true });
          evidence.phase('body', 'assertion');
          expect(observed.maskedRegionCount).toBeGreaterThanOrEqual(1);
          const pixels = decodePng(observed.pixels!.data);
          expect(pixels.pixelAt(100, 40).slice(0, 3)).toEqual([0, 0, 0]);
          expect(pixels.pixelAt(100, 120).slice(0, 3)).toEqual([255, 0, 0]);
        }, shotDir, evidence);
      } finally {
        rmSync(shotDir, { recursive: true, force: true });
      }
    });
  });

  it('reports an unopened page as INVALID_STATE, never as a missing node', async () => {
    const engine = web();
    try {
      await boot(engine, app);
      await engine.startAttempt!({ attemptId: 'c1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
      await expect(engine.observe!(operation('c1'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  });

  it('refuses a second startAttempt while one is running and keeps the first intact', async () => {
    const engine = web();
    await withAttempt(engine, app, artifactsDir, 'e1', async () => {
      await expect(engine.startAttempt!(attempt('e2', artifactsDir))).rejects.toMatchObject({
        code: 'INVALID_STATE',
        retryable: false,
      });
      await engine.session!.open!(`${app.url}/`, operation('e1'));
      expect((await engine.observe!(operation('e1'))).location).toBe(`${app.url}/`);
    });
  });

  it('treats endAttempt before startAttempt and dispose on a cold engine as no-ops', async () => {
    const cold = web();
    await expect(cold.endAttempt!(cleanup())).resolves.toBeUndefined();
    await expect(cold.dispose!(cleanup())).resolves.toBeUndefined();

    const engine = web();
    try {
      await boot(engine, app);
      await expect(engine.endAttempt!(cleanup())).resolves.toBeUndefined();
      expect(await openAttempt(engine, app, artifactsDir, 'f1')).toBe('Home');
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  });

  it('stops waiting on cleanup once its budget is aborted, and recovers on the next attempt', async () => {
    const evidence = new LifecycleEvidence('P31');
    const engine = web();
    let booted = false;
    try {
      evidence.phase('setup', 'init');
      await boot(engine, app);
      evidence.passed('setup');
      booted = true;
      expect(await openAttempt(engine, app, artifactsDir, 'g1', evidence)).toBe('Home');
      evidence.phase('body', 'abort');
      const exhausted = new AbortController();
      exhausted.abort();
      evidence.phase('body', 'end');
      await evidence.assert(0, () => expect(evidence.select(0, 'scope.end', () => engine.endAttempt!({ signal: exhausted.signal, timeoutMs: 0 }))).resolves.toBeUndefined());
      evidence.phase('body', 'start');
      const next = await evidence.select(1, 'scope.interop.adopt', () => openAttempt(engine, app, artifactsDir, 'g2', evidence));
      evidence.assert(1, () => expect(next).toBe('Home'));
      evidence.passed('body');
    } catch (cause) { evidence.failed(booted ? 'body' : 'setup', cause); throw cause; }
    finally {
      try {
        evidence.phase('cleanup', 'end');
        await engine.endAttempt!(cleanup());
        evidence.phase('cleanup', 'dispose');
        await engine.dispose!(cleanup());
        evidence.passed('cleanup');
      // eslint-disable-next-line no-unsafe-finally -- Preserve the original cleanup exception precedence.
      } catch (cause) { evidence.failed('cleanup', cause); throw cause; }
      finally { evidence.finish(); }
    }
  });

  it('cancels an in-flight native operation when its signal aborts', async () => withLifecycleOpenCancelDiagnostics(async captureEnv => {
    const evidence = new LifecycleEvidence('P32');
    const engine = web();
    await withAttempt(engine, app, artifactsDir, 'h1', async () => {
      const controller = new AbortController();
      const started = Date.now();
      evidence.phase('body', 'navigate');
      const pending = evidence.select(0, 'page.navigate', () => engine.session!.open!(`${app.url}/slow`, operation('h1', controller.signal)));
      setTimeout(() => {
        evidence.evidence.record({ kind: 'phase', section: 'body', phase: 'abort', state: 'enter' });
        controller.abort();
        evidence.evidence.record({ kind: 'phase', section: 'body', phase: 'abort', state: 'passed' });
      }, 100);
      await evidence.assert(0, () => expect(pending).rejects.toMatchObject({ code: 'CANCELLED' }));
      evidence.phase('body', 'assertion');
      expect(Date.now() - started).toBeLessThan(3_000);
    }, evidence, undefined, captureEnv);
  }, true));

  it('round-trips persisted state through capture and restore, and reset drops it', async () => {
    const evidence = new LifecycleEvidence('P33');
    const engine = web();
    await withAttempt(engine, app, artifactsDir, 's1', async () => {
      const token = async (selected = false): Promise<string> => {
        evidence.phase('body', 'locate');
        const [heading] = await (selected ? evidence.select(4, 'browser.query', () => engine.locate!(byRole('heading'), operation('s1'))) : engine.locate!(byRole('heading'), operation('s1')));
        evidence.phase('body', 'assertion');
        return heading?.name ?? '';
      };
      evidence.phase('body', 'navigate');
      await engine.session!.open!(`${app.url}/state?set=abc`, operation('s1'));
      expect(await token()).toBe('abc');
      evidence.phase('body', 'state-capture');
      const state = await engine.state!.capture(operation('s1'));
      evidence.phase('body', 'assertion');
      expect(state.format).toBe('agent-browser-storage-state');
      expect(state.version).toBe(1);

      evidence.phase('body', 'state-reset');
      await engine.session!.reset!(operation('s1'));
      evidence.phase('body', 'navigate');
      await engine.session!.open!(`${app.url}/state`, operation('s1'));
      expect(await token()).toBe('none');

      evidence.phase('body', 'state-restore');
      await engine.state!.restore(state, operation('s1'));
      evidence.phase('body', 'navigate');
      await engine.session!.open!(`${app.url}/state`, operation('s1'));
      expect(await token()).toBe('abc');

      // A restart keeps the persisted state and shows nothing until the harness reopens the app.
      evidence.phase('body', 'restart');
      await evidence.select(0, 'scope.restart', () => engine.session!.restart!(operation('s1')));
      evidence.phase('body', 'url');
      const blankUrl = await evidence.select(1, 'page.url', () => fixtureOf(engine, 's1').url());
      evidence.assert(1, () => expect(blankUrl).toBe('about:blank'));
      evidence.phase('body', 'observe');
      const blank = await evidence.select(2, 'browser.observe', () => engine.observe!(operation('s1')));
      evidence.assert(2, () => expect(blank.location).toBe('about:blank'));
      evidence.phase('body', 'navigate');
      await evidence.select(3, 'page.navigate', () => engine.session!.open!(`${app.url}/state`, operation('s1')));
      const restoredToken = await token(true);
      evidence.assert(4, () => expect(restoredToken).toBe('abc'));

      evidence.phase('body', 'assertion');
      await evidence.assert(5, () => expect(
        evidence.select(5, 'state.restore', () => engine.state!.restore({ format: 'playwright-storage-state', version: 1, data: '/etc/passwd' }, operation('s1'))),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' }));
    }, evidence);
  });

  it('follows the window under viewport: null, reports the measured size, and swipes by it', async () => {
    const engine = web({ viewport: null });
    const creation = new IsolatedScopeCreation();
    const command = EngineChannel.prototype.command;
    const spy = vi.spyOn(EngineChannel.prototype, 'command').mockImplementation(function (this: EngineChannel, name, args, context, transition) {
      return creation.observe(name, args, command.call(this, name, args, context, transition));
    });
    try {
      await withAttempt(engine, app, artifactsDir, 'w1', async () => {
        await engine.session!.open!(`${app.url}/form`, operation('w1'));
        const browser = fixtureOf(engine, 'w1');
        creation.assertOne({ viewport: null });
        const measured = await browser.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        expect(measured.width).toBeGreaterThan(0);
        const snapshot = await engine.observe!(operation('w1'), { pixels: true });
        creation.assertScope(snapshot.identityScope);
        expect(snapshot.viewport).toEqual(measured);
        expect(snapshot.pixels).toBeDefined();

        await replaceDocument(browser, '<div style="height: 5000px">tall</div>');
        expect(snapshot.viewportRef).toBeDefined();
        await engine.perform!(snapshot.viewportRef!, { kind: 'swipe', direction: 'down' }, operation('w1'));
        await expect.poll(() => browser.evaluate(() => window.scrollY)).toBeGreaterThan(0);
        expect(await browser.evaluate(() => window.scrollY)).toBe(Math.round(measured.height / 2));
      });
    } finally { spy.mockRestore(); }
  });

  it('reports the configured test-id attribute as testId, on observed and located nodes alike', async () => {
    const engine = web({ testIdAttribute: 'data-qa' });
    const byTestId = (value: string): LocatorExpression => ({
      kind: 'query',
      query: { kind: 'testId', value: { kind: 'string', value, exact: true } },
    });
    await withAttempt(engine, app, artifactsDir, 'tid1', async () => {
      await engine.session!.open!(`${app.url}/`, operation('tid1'));
      await replaceDocument(fixtureOf(engine, 'tid1'),
        '<button data-qa="go">Go</button><button data-testid="stop">Stop</button>',
      );
      const observed = [...walk((await engine.observe!(operation('tid1'))).root)];
      const go = observed.find((node) => node.name === 'Go');
      const stop = observed.find((node) => node.name === 'Stop');
      expect(go?.testId).toBe('go');
      expect(stop?.testId).toBeUndefined();
      // The tree carries the id as a field, not as an attribute.
      expect(go?.attributes?.['data-qa']).toBeUndefined();

      const located = await engine.locate!(byTestId('go'), operation('tid1'));
      expect(located.map((node) => node.testId)).toEqual(['go']);
      expect(await engine.locate!(byTestId('stop'), operation('tid1'))).toEqual([]);
    });
  });

  it('records a video per page at the viewport size: a restart and a state reset each continue in a new segment', async () => {
    const evidence = new LifecycleEvidence('P34');
    const engine = web();
    const videoDir = mkdtempSync(path.join(tmpdir(), 'e2e-video-'));
    const nodesOf = (snapshot: { root: SemanticNode }) => [...walk(snapshot.root)];
    try {
      await withAttempt(engine, app, videoDir, 'v1', async () => {
        evidence.phase('body', 'navigate');
        await engine.session!.open!(`${app.url}/form`, operation('v1'));
        const browser = fixtureOf(engine, 'v1');
        evidence.phase('body', 'video-start');
        await engine.artifacts!.startVideo!(operation('v1'));
        evidence.phase('body', 'observe');
        const initialDocument = (await engine.observe!(operation('v1'))).root.ref;
        evidence.phase('body', 'viewport');
        const viewport = await browser.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        // Observations, actions, and captures run as they would without a recording.
        evidence.phase('body', 'observe');
        const observed = nodesOf(await engine.observe!(operation('v1'), { pixels: true }));
        const textbox = observed.find((node) => node.role === 'textbox' && node.name === 'First');
        evidence.phase('body', 'perform');
        await engine.perform!(textbox!.ref, { kind: 'fill', value: 'recorded', sensitive: false }, operation('v1'));
        evidence.phase('body', 'screenshot');
        await engine.artifacts!.screenshot('shot', operation('v1'));
        evidence.phase('body', 'readiness');
        await paintSegment(browser);
        // A restart closes the page and opens another, blank until the harness
        // reopens the app: the recording continues in a second segment.
        evidence.phase('body', 'restart');
        await evidence.select(0, 'scope.restart', () => engine.session!.restart!(operation('v1')));
        evidence.phase('body', 'observe');
        expect((await engine.observe!(operation('v1'))).root.ref.id).not.toBe(initialDocument.id);
        evidence.phase('body', 'evaluate');
        expect(await fixtureOf(engine, 'v1').url()).toBe('about:blank');
        evidence.phase('body', 'navigate');
        await engine.session!.open!(`${app.url}/form`, operation('v1'));
        evidence.phase('body', 'readiness');
        await paintSegment(browser);
        // A state reset recreates the context; the recording continues in a third.
        evidence.phase('body', 'state-reset');
        await engine.session!.reset!(operation('v1'));
        evidence.phase('body', 'evaluate');
        expect(await fixtureOf(engine, 'v1').url()).toBe('about:blank');
        evidence.phase('body', 'navigate');
        await engine.session!.open!(`${app.url}/`, operation('v1'));
        evidence.phase('body', 'readiness');
        await paintSegment(browser);
        evidence.phase('body', 'video-stop');
        const segments = videoFiles(await engine.artifacts!.stopVideo!(operation('v1')));
        evidence.phase('body', 'assertion');
        expect(segments.map((segment) => segment.path)).toEqual([
          'video/video.webm',
          'video/video-part2.webm',
          'video/video-part3.webm',
        ]);
        const viewer = fixtureOf(engine, 'v1');
        for (const segment of segments) {
          const absolute = path.join(videoDir, segment.path);
          expect(existsSync(absolute), segment.path).toBe(true);
          expect(statSync(absolute).size).toBeGreaterThan(0);
          // Every WebM file opens with the EBML magic.
          expect(readFileSync(absolute).subarray(0, 4).toString('hex')).toBe('1a45dfa3');
          expect(Number.isNaN(Date.parse(segment.startedAt))).toBe(false);
          // Every segment shows the page at the attempt's viewport size: no
          // grey padding from a screencast another client sized smaller, and
          // some ink, so the page painted into it.
          evidence.phase('body', 'video-decode');
          const frame = await lastFrame(viewer, readFileSync(absolute));
          evidence.phase('body', 'assertion');
          expect({ width: frame.width, height: frame.height }, segment.path).toEqual(viewport);
          expect(frame.padded, `${segment.path} padded`).toBeLessThan(0.01);
          expect(frame.inked, `${segment.path} inked`).toBeGreaterThan(0.0005);
        }
      }, evidence);
    } finally {
      rmSync(videoDir, { recursive: true, force: true });
    }
  });

  it('records a video started mid-attempt at the viewport size, each time it starts', async () => {
    const engine = web();
    const videoDir = mkdtempSync(path.join(tmpdir(), 'e2e-video-'));
    try {
      await withAttempt(engine, app, videoDir, 'v3', async () => {
        // A host that records on demand, after the page is open.
        await engine.session!.open!(`${app.url}/`, operation('v3'));
        const viewer = fixtureOf(engine, 'v3');
        const viewport = await viewer.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const segments: VideoFile[] = [];
        for (const url of [`${app.url}/form`, `${app.url}/`]) {
          await engine.artifacts!.startVideo!(operation('v3'));
          await engine.session!.open!(url, operation('v3'));
          await paintSegment(viewer);
          segments.push(...videoFiles(await engine.artifacts!.stopVideo!(operation('v3'))));
        }
        expect(segments.map((segment) => segment.path)).toEqual(['video/video.webm', 'video/video-part2.webm']);
        for (const segment of segments) {
          const frame = await lastFrame(viewer, readFileSync(path.join(videoDir, segment.path)));
          expect({ width: frame.width, height: frame.height }, segment.path).toEqual(viewport);
          expect(frame.padded, `${segment.path} padded`).toBeLessThan(0.01);
          expect(frame.inked, `${segment.path} inked`).toBeGreaterThan(0.0005);
        }
      });
    } finally {
      rmSync(videoDir, { recursive: true, force: true });
    }
  });

  it('rejects a video that cannot start and leaves the session working', async (test) => {
    const diagnostic = new LifecycleAttemptDiagnostic();
    const engine = web();
    const videoDir = mkdtempSync(path.join(tmpdir(), 'e2e-video-'));
    const caseCapture = beginCaseCleanupCapture('video-refusal', test.task.meta as Record<string, unknown>);
    try {
      await withAttempt(engine, app, videoDir, 'v4', async () => {
        diagnostic.enter('open-first');
        await engine.session!.open!(`${app.url}/`, operation('v4'));
        const browser = fixtureOf(engine, 'v4');
        const command = EngineChannel.prototype.command;
        const spy = vi.spyOn(EngineChannel.prototype, 'command').mockImplementation(function (this: EngineChannel, name, args, context, transition) {
          if (name === 'recording.start') return Promise.reject(new Error('screencast unavailable'));
          return command.call(this, name, args, context, transition);
        });
        try {
          diagnostic.enter('reject-recording');
          await expect(engine.artifacts!.startVideo!(operation('v4'))).rejects.toThrow('screencast unavailable');
        } finally {
          spy.mockRestore();
        }
        diagnostic.enter('open-after');
        await engine.session!.open!(`${app.url}/form`, operation('v4'));
        diagnostic.enter('readback');
        expect(await browser.url()).toBe(`${app.url}/form`);
      }, undefined, diagnostic);
    } finally {
      try {
        try {
          (test.task.meta as Record<string, unknown>)['videoAttemptDiagnostic'] = diagnostic.snapshot();
          console.error('VIDEO_ATTEMPT_DIAGNOSTIC', JSON.stringify(diagnostic.snapshot()));
        } catch { /* Diagnostics cannot replace a body or cleanup failure. */ }
        rmSync(videoDir, { recursive: true, force: true });
      } finally { caseCapture.finish(); }
    }
  });

  it('opens the attempt page when the video starts', async () => {
    const engine = web();
    const videoDir = mkdtempSync(path.join(tmpdir(), 'e2e-video-'));
    try {
      await withAttempt(engine, app, videoDir, 'v2', async () => {
        await engine.artifacts!.startVideo!(operation('v2'));
        // The page exists before any navigation: the recording owns its screencast.
        expect(await fixtureOf(engine, 'v2').url()).toBe('about:blank');
        await engine.session!.open!(`${app.url}/`, operation('v2'));
        const segments = videoFiles(await engine.artifacts!.stopVideo!(operation('v2')));
        expect(segments.map((segment) => segment.path)).toEqual(['video/video.webm']);
        expect(statSync(path.join(videoDir, 'video/video.webm')).size).toBeGreaterThan(0);
      });
    } finally {
      rmSync(videoDir, { recursive: true, force: true });
    }
  });

  it('masks secure fields in artifact screenshots and restarts the counter per attempt', async () => {
    const engine = web();
    const shotDir = mkdtempSync(path.join(tmpdir(), 'e2e-shot-'));
    try {
      await boot(engine, app);
      await engine.startAttempt!(attempt('m1', shotDir));
      await engine.session!.open!(`${app.url}/login`, operation('m1'));
      expect(await engine.artifacts!.screenshot('first', operation('m1'))).toBe('screenshots/001-first.png');
      await engine.endAttempt!(cleanup());

      await engine.startAttempt!(attempt('m2', shotDir));
      await engine.session!.open!(`${app.url}/login`, operation('m2'));
      const nodes = await engine.locate!(byRole('textbox'), operation('m2'));
      const user = nodes.find((node) => node.name === 'User');
      expect(user?.rect).toBeDefined();
      const [password] = await engine.locate!({ kind: 'selector', selector: 'input[type=password]' }, operation('m2'));
      expect(password?.rect).toBeDefined();
      await engine.perform!(password!.ref, { kind: 'fill', value: 'hunter2', sensitive: true }, operation('m2'));

      const relative = await engine.artifacts!.screenshot('login', operation('m2'));
      expect(relative).toBe('screenshots/001-login.png');
      const image = decodePng(new Uint8Array(readFileSync(path.join(shotDir, relative))));
      const centre = (rect: NonNullable<SemanticNode['rect']>) =>
        [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)] as const;
      const [px, py] = centre(password!.rect!);
      const [ux, uy] = centre(user!.rect!);
      // The password field is covered by the opaque mask; the plain field is not.
      expect(image.pixelAt(px, py).slice(0, 3)).toEqual([0, 0, 0]);
      expect(image.pixelAt(ux, uy).slice(0, 3)).toEqual([255, 255, 255]);
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
      rmSync(shotDir, { recursive: true, force: true });
    }
  });
});
