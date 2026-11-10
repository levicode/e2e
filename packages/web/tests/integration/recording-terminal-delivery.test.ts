/**
 * Real Chrome terminal-recording delivery: a stop that fails, a lost later
 * segment, and a blocked local part still leave every independently verified
 * earlier part immutable and playable on disk.
 *
 * Only the fault is injected (the encoder's private output file, or a foreign
 * path occupying a public part). The recording, its transfer, and its final
 * files come from the production native recorder and screencast.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineFixtureContext, EngineHandle, OperationContext, VideoFile, VideoSegment } from 'e2e/engine';
import { web, type Browser } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

function cleanup(signal = new AbortController().signal): { signal: AbortSignal; timeoutMs: number } {
  return { signal, timeoutMs: 30_000 };
}

function operation(attemptId: string): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-recording-delivery', attemptId, origin: 'test' };
}

function attempt(attemptId: string, artifactsDir: string) {
  return { attemptId, artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace };
}

const fixtures = new WeakMap<EngineHandle, { attemptId: string; browser: Browser }>();

/** Build the public browser fixture for the current attempt without a backend handle. */
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

/** Keep the page painting long enough that a decodable frame must exist. */
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

interface Playback {
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly frames: number;
}

/** Decode a recorded part in the browser that produced it: dimensions, playable span, decoded frames. */
async function playback(browser: Browser, bytes: Buffer): Promise<Playback> {
  return browser.evaluate(async (data) => {
    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: 'video/webm' }));
    await new Promise<void>((resolve, reject) => {
      video.addEventListener('loadedmetadata', () => { resolve(); }, { once: true });
      video.addEventListener('error', () => { reject(new Error('the recording did not decode')); }, { once: true });
    });
    const width = video.videoWidth;
    const height = video.videoHeight;
    let presented = 0;
    const count = () => { presented += 1; if (!video.ended) video.requestVideoFrameCallback(count); };
    video.requestVideoFrameCallback(count);
    await video.play();
    await new Promise<void>((resolve) => {
      video.addEventListener('ended', () => { resolve(); }, { once: true });
      setTimeout(resolve, 10_000);
    });
    const quality = (video as HTMLVideoElement & { getVideoPlaybackQuality?: () => { totalVideoFrames?: number } }).getVideoPlaybackQuality?.();
    return {
      width,
      height,
      duration: video.currentTime,
      frames: Math.max(presented, quality?.totalVideoFrames ?? 0),
    };
  }, [...bytes]);
}

function digest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** The production recorder's private output for one segment, under this attempt's TMPDIR. */
async function privateOutput(root: string, name: string): Promise<string> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('agent-browser-action-')) continue;
      const candidate = path.join(root, entry.name, name);
      // FFmpeg creates its output when it starts and buffers the container
      // while recording, so existence (not a positive size) proves the open.
      if (existsSync(candidate)) return candidate;
    }
    if (performance.now() > deadline) {
      const seen = readdirSync(root, { recursive: true, encoding: 'utf8' })
        .filter(entry => entry.includes('agent-browser-action-')).slice(0, 8).join(', ');
      throw new Error(`The native recorder never produced ${name}; saw: ${seen}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function videoFile(segment: VideoSegment): VideoFile {
  if (!('path' in segment)) throw new Error(`expected a video file, got a link to ${segment.url}`);
  return segment;
}

describe('real Chrome terminal recording delivery', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('keeps the first real part when the second capture is lost, and re-fetches it without a second stop', async () => {
    const engine = web();
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-recording-lost-'));
    const nativeTmp = mkdtempSync(path.join(tmpdir(), 'e2e-recording-native-'));
    try {
      await engine.init!({
        runId: 'run-recording-delivery', targetName: 'web', projectRoot: process.cwd(),
        app: { site: new URL(app.url).hostname }, env: { ...process.env, TMPDIR: nativeTmp },
        headed: false, workerSlot: 0, log: () => undefined, signal: new AbortController().signal,
      });
      await engine.startAttempt!(attempt('lost-second', artifactsDir));
      await engine.session!.open!(`${app.url}/`, operation('lost-second'));
      await engine.artifacts!.startVideo!(operation('lost-second'));
      await paintSegment(fixtureOf(engine, 'lost-second'));
      // A restart finalizes the first real segment and opens a second capture.
      await engine.session!.restart!(operation('lost-second'));
      await engine.session!.open!(`${app.url}/form`, operation('lost-second'));
      await paintSegment(fixtureOf(engine, 'lost-second'));
      // The second segment's encoder output disappears before the public stop
      // reads it; the first finalized segment is unaffected.
      rmSync(await privateOutput(nativeTmp, 'video-part2.webm'));
      const failed = await engine.artifacts!.stopVideo!(operation('lost-second')).catch((cause: unknown) => cause);
      expect(failed).toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining('video-part2.webm') });
      const first = path.join(artifactsDir, 'video/video.webm');
      expect(existsSync(first)).toBe(true);
      expect(existsSync(path.join(artifactsDir, 'video/video-part2.webm'))).toBe(false);
      const before = digest(first);
      const decoded = await playback(fixtureOf(engine, 'lost-second'), readFileSync(first));
      expect(decoded.width).toBeGreaterThan(0);
      expect(decoded.height).toBeGreaterThan(0);
      expect(decoded.duration).toBeGreaterThan(0);
      expect(decoded.frames).toBeGreaterThan(0);
      // The same stopped batch is re-fetched without another native stop.
      const saved = (await engine.artifacts!.stopVideo!(operation('lost-second'))).map(videoFile);
      expect(saved.map(segment => segment.path)).toEqual(['video/video.webm']);
      expect(digest(first)).toBe(before);
      await engine.endAttempt!(cleanup());
      expect(digest(first)).toBe(before);
    } finally {
      await engine.dispose!(cleanup()).catch(() => {});
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(nativeTmp, { recursive: true, force: true });
    }
  }, 120_000);

  it('keeps the already-written first part usable when a later part’s local write fails, then publishes it on retry', async () => {
    const engine = web();
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-recording-partial-'));
    try {
      await engine.init!({
        runId: 'run-recording-delivery', targetName: 'web', projectRoot: process.cwd(),
        app: { site: new URL(app.url).hostname }, env: process.env,
        headed: false, workerSlot: 0, log: () => undefined, signal: new AbortController().signal,
      });
      await engine.startAttempt!(attempt('partial-write', artifactsDir));
      await engine.session!.open!(`${app.url}/`, operation('partial-write'));
      await engine.artifacts!.startVideo!(operation('partial-write'));
      await paintSegment(fixtureOf(engine, 'partial-write'));
      await engine.session!.restart!(operation('partial-write'));
      await engine.session!.open!(`${app.url}/form`, operation('partial-write'));
      await paintSegment(fixtureOf(engine, 'partial-write'));
      // A foreign directory occupies the second public part: the first part is
      // written and published; the second write is refused, never adopted.
      const blocked = path.join(artifactsDir, 'video/video-part2.webm');
      mkdirSync(path.dirname(blocked), { recursive: true });
      mkdirSync(blocked);
      const failed = await engine.artifacts!.stopVideo!(operation('partial-write')).catch((cause: unknown) => cause);
      expect(failed).toMatchObject({ code: 'ENGINE_FAILURE' });
      const first = path.join(artifactsDir, 'video/video.webm');
      expect(existsSync(first)).toBe(true);
      expect(statSync(blocked).isDirectory()).toBe(true);
      const before = digest(first);
      const decoded = await playback(fixtureOf(engine, 'partial-write'), readFileSync(first));
      expect(decoded.duration).toBeGreaterThan(0);
      expect(decoded.frames).toBeGreaterThan(0);
      // Retrying the batch never rewrites the first part or adopts the foreign path.
      const again = await engine.artifacts!.stopVideo!(operation('partial-write')).catch((cause: unknown) => cause);
      expect(again).toMatchObject({ code: 'ENGINE_FAILURE' });
      expect(digest(first)).toBe(before);
      rmSync(blocked, { recursive: true, force: true });
      const saved = (await engine.artifacts!.stopVideo!(operation('partial-write'))).map(videoFile);
      expect(saved.map(segment => segment.path)).toEqual(['video/video.webm', 'video/video-part2.webm']);
      expect(digest(first)).toBe(before);
      for (const segment of saved) {
        const file = path.join(artifactsDir, segment.path);
        const part = await playback(fixtureOf(engine, 'partial-write'), readFileSync(file));
        expect(part.duration).toBeGreaterThan(0);
        expect(part.frames).toBeGreaterThan(0);
      }
      await engine.endAttempt!(cleanup());
    } finally {
      await engine.dispose!(cleanup()).catch(() => {});
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  }, 120_000);
});
