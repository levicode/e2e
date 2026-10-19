/** Unredacted artifact video, matching the web engine's explicitly incomplete video-redaction policy. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { EngineError, stopProviderRecording, type OperationContext, type VideoFile, type VideoSegment } from 'e2e/engine';
import type { CdpConnection } from './cdp.ts';
import type { LeaseRecording } from './provider.ts';

export interface ScreencastOptions {
  /** An explicitly installed ffmpeg executable. No package download or shell execution occurs. */
  readonly ffmpegPath?: string;
  readonly size?: { readonly width: number; readonly height: number };
  /** CDP JPEG source quality, 0–100. The WebM output uses a real-time VP8 encoder. */
  readonly quality?: number;
}
export interface VideoOptions extends ScreencastOptions {
  readonly artifactsDir: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}
interface Frame { data: string; sessionId: number }
interface Segment {
  cdp: CdpConnection; targetId: string; session: string;
  process: ChildProcessWithoutNullStreams; exited: Promise<number | null>;
  relative: string; absolute: string; startedAt: string; startedMs: number; endedMs?: number;
  latest?: Buffer; emitted: number; firstFrame: Promise<void>; receivedFrame(): void;
  pumping?: Promise<void>; timer?: ReturnType<typeof setInterval>;
  off: (() => void)[]; failure: boolean; closing: boolean; disconnected: boolean;
  operation: OperationContext; lifetime: AbortController;
}
const FPS = 25;
const failure = (message: string): EngineError => new EngineError('ENGINE_FAILURE', message, { retryable: false });
export function validateVideoOptions(options: ScreencastOptions): void {
  if (options.ffmpegPath !== undefined && (typeof options.ffmpegPath !== 'string' || !options.ffmpegPath.trim() || options.ffmpegPath.includes('\0'))) throw failure('Video ffmpeg path must be a nonempty executable path');
  if (options.quality !== undefined && (!Number.isInteger(options.quality) || options.quality < 0 || options.quality > 100)) throw failure('Video quality must be an integer from 0 to 100');
  if (options.size && (![options.size.width, options.size.height].every(value => Number.isInteger(value) && value > 0 && value <= 16384))) throw failure('Video dimensions must be positive integers at most 16384');
}
function remaining(context: OperationContext): () => OperationContext {
  const end = Date.now() + context.timeoutMs;
  return () => ({ ...context, timeoutMs: Math.max(0, end - Date.now()) });
}
function bounded<T>(work: Promise<T>, context: OperationContext): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => { cleanup(); reject(new EngineError('CANCELLED', 'Video operation cancelled', { retryable: false })); };
    const timer = setTimeout(() => { cleanup(); reject(new EngineError('OPERATION_TIMEOUT', 'Video operation timed out', { retryable: false })); }, Math.max(0, context.timeoutMs));
    const cleanup = (): void => { clearTimeout(timer); context.signal.removeEventListener('abort', aborted); };
    context.signal.addEventListener('abort', aborted, { once: true });
    work.then(value => { cleanup(); resolve(value); }, () => { cleanup(); reject(failure('Video operation failed')); });
    if (context.signal.aborted) aborted();
  });
}

/**
 * True repaint-driven CDP screencast, encoded to a WebM file. These bytes are artifacts,
 * never observation pixels or model evidence. Inputs/passwords are NOT masked here.
 * A fixed-rate encoder repeats the newest frame during idle periods so step timestamps
 * retain their wall-clock positions; no intermediate JPEG files are written.
 */
export interface AttemptVideo {
  readonly isArmed: boolean;
  arm(cdp: CdpConnection, targetId: string, context: OperationContext): Promise<void>;
  pageOpened(cdp: CdpConnection, targetId: string, context: OperationContext): Promise<void>;
  pageClosing(context: OperationContext): Promise<void>;
  stop(context: OperationContext): Promise<readonly VideoSegment[]>;
  abandon(context: OperationContext): Promise<void>;
}
export class VideoRecorder implements AttemptVideo {
  readonly #options: VideoOptions;
  #armed = false;
  #current: Segment | undefined;
  #finished: VideoFile[] = [];
  #lost = false;
  #queue: Promise<void> = Promise.resolve();
  constructor(options: VideoOptions) {
    validateVideoOptions(options);
    if (typeof options.artifactsDir !== 'string' || !options.artifactsDir.trim()) throw failure('Video artifacts directory is required');
    this.#options = options;
  }
  get isArmed(): boolean { return this.#armed; }
  arm(cdp: CdpConnection, targetId: string, context: OperationContext): Promise<void> {
    return this.#serialize(async () => {
      this.#armed = true;
      try { if (!this.#current) await this.#begin(cdp, targetId, context); } catch (error) { this.#armed = false; throw error; }
    });
  }
  pageOpened(cdp: CdpConnection, targetId: string, context: OperationContext): Promise<void> {
    return this.#serialize(async () => {
      if (!this.#armed || (this.#current?.cdp === cdp && this.#current.targetId === targetId)) return;
      await this.#end(context); await this.#begin(cdp, targetId, context);
    });
  }
  pageClosing(context: OperationContext): Promise<void> { return this.#serialize(() => this.#end(context)); }
  stop(context: OperationContext): Promise<readonly VideoSegment[]> {
    return this.#serialize(async () => {
      this.#armed = false; await this.#end(context);
      if (this.#lost) { this.#lost = false; throw failure('A video segment could not be finalized'); }
      return this.#finished.splice(0);
    });
  }
  abandon(context: OperationContext): Promise<void> {
    return this.#serialize(async () => {
      this.#armed = false; await this.#end(context);
      const files = this.#finished.splice(0); this.#lost = false;
      await Promise.all(files.map(file => rm(path.join(this.#options.artifactsDir, file.path), { force: true })));
    });
  }
  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work); this.#queue = next.then(() => undefined, () => undefined); return next;
  }
  async #begin(cdp: CdpConnection, targetId: string, context: OperationContext): Promise<void> {
    const current = remaining(context);
    const session = await cdp.attachTarget(targetId, current());
    let child: ChildProcessWithoutNullStreams | undefined;
    let segment: Segment | undefined;
    const relative = path.posix.join('video', `video-${randomUUID()}.webm`);
    const absolute = path.join(this.#options.artifactsDir, relative);
    try {
      await cdp.send('Page.enable', {}, current(), session);
      let size = this.#options.size;
      if (!size) {
        const { cssLayoutViewport } = await cdp.send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, current(), session);
        size = { width: Math.round(cssLayoutViewport.clientWidth), height: Math.round(cssLayoutViewport.clientHeight) };
      }
      if (![size.width, size.height].every(value => Number.isInteger(value) && value > 0 && value <= 16384)) throw failure('Video viewport dimensions are invalid');
      await mkdir(path.dirname(absolute), { recursive: true });
      // argv is fixed and paths are passed as arguments, never interpolated into a shell.
      child = spawn(this.#options.ffmpegPath ?? 'ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'mjpeg',
        '-framerate', String(FPS), '-i', 'pipe:0', '-an', '-c:v', 'libvpx', '-deadline', 'realtime',
        '-cpu-used', '8', '-b:v', '1M', '-pix_fmt', 'yuv420p',
        '-vf', `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,format=rgb24,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p`,
        '-r', String(FPS), '-y', absolute,
      ], { stdio: 'pipe', windowsHide: true, ...(this.#options.env ? { env: { ...this.#options.env } } : {}) });
      // Encoder diagnostics may contain filesystem or input details; never return or log them.
      child.stdout.resume(); child.stderr.resume();
      const process = child;
      const exited = new Promise<number | null>(resolve => { process.once('close', code => resolve(code)); });
      await bounded(new Promise<void>((resolve, reject) => { process.once('spawn', resolve); process.once('error', reject); }), current());
      let receivedFrame = (): void => undefined;
      const firstFrame = new Promise<void>(resolve => { receivedFrame = resolve; });
      const lifetime = new AbortController();
      segment = {
        cdp, targetId, session, process, exited, relative, absolute,
        startedAt: new Date().toISOString(), startedMs: Date.now(), emitted: 0,
        firstFrame, receivedFrame, off: [], failure: false, closing: false, disconnected: false,
        operation: { ...context, signal: lifetime.signal, timeoutMs: 5_000 }, lifetime,
      };
      const recording = segment;
      process.stdin.on('error', () => { recording.failure = true; });
      process.on('error', () => { recording.failure = true; });
      process.on('exit', () => { if (!recording.closing) recording.failure = true; });
      const sourceClosed = (): void => {
        if (recording.closing || this.#current !== recording) return;
        recording.disconnected = true; recording.endedMs = Date.now(); clearInterval(recording.timer);
        void this.pageClosing({ ...context, signal: new AbortController().signal, timeoutMs: 5_000 }).catch(() => { this.#lost = true; });
      };
      recording.off.push(cdp.onClose(sourceClosed));
      recording.off.push(cdp.on<{ sessionId: string }>('Target.detachedFromTarget', event => { if (event.sessionId === session) sourceClosed(); }));
      recording.off.push(cdp.on<Frame>('Page.screencastFrame', frame => {
        // Ack immediately; encoder backpressure must not deadlock the browser renderer.
        void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }, recording.operation, session).catch(() => { if (!recording.closing && !recording.disconnected) recording.failure = true; });
        if (recording.closing || recording.failure) return;
        if (typeof frame.data !== 'string' || frame.data.length > 32 * 1024 * 1024) { recording.failure = true; return; }
        const jpeg = Buffer.from(frame.data, 'base64');
        if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) { recording.failure = true; return; }
        recording.latest = jpeg; recording.receivedFrame(); this.#schedulePump(recording);
      }, session));
      this.#current = recording;
      await cdp.send('Page.startScreencast', {
        format: 'jpeg', quality: this.#options.quality ?? 80, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1,
      }, current(), session);
      recording.timer = setInterval(() => this.#schedulePump(recording), 1000 / FPS);
    } catch (error) {
      if (segment) {
        segment.closing = true; for (const off of segment.off) off(); segment.lifetime.abort(); clearInterval(segment.timer);
        if (this.#current === segment) this.#current = undefined;
      }
      if (child) await this.#terminate(child);
      await cdp.send('Target.detachFromTarget', { sessionId: session }, { ...context, signal: new AbortController().signal, timeoutMs: 2_000 }).catch(() => undefined);
      await rm(absolute, { force: true }).catch(() => undefined);
      if (error instanceof EngineError && (error.code === 'CANCELLED' || error.code === 'OPERATION_TIMEOUT')) throw error;
      throw failure('Video could not start; a working ffmpeg executable with VP8 support is required');
    }
  }
  #schedulePump(segment: Segment): void {
    if (segment.closing || segment.failure || segment.pumping || !segment.latest) return;
    segment.pumping = this.#pump(segment, segment.operation).catch(() => { segment.failure = true; clearInterval(segment.timer); }).finally(() => { delete segment.pumping; });
  }
  async #pump(segment: Segment, context: OperationContext): Promise<void> {
    if (!segment.latest || segment.failure) return;
    const current = remaining(context);
    const target = Math.max(1, Math.ceil(((segment.endedMs ?? Date.now()) - segment.startedMs) * FPS / 1000));
    while (segment.emitted < target) {
      const frame = segment.latest;
      await bounded(new Promise<void>((resolve, reject) => { segment.process.stdin.write(frame, error => { if (error) reject(error); else resolve(); }); }), current());
      segment.emitted++;
    }
  }
  async #end(context: OperationContext): Promise<void> {
    const segment = this.#current; if (!segment) return;
    this.#current = undefined;
    const current = remaining(context);
    try {
      if (!segment.latest && !segment.disconnected) {
        await bounded(Promise.race([segment.firstFrame, new Promise<void>(resolve => { const timer = setTimeout(resolve, Math.min(1_000, current().timeoutMs)); timer.unref(); })]), current());
      }
      segment.endedMs ??= Date.now(); segment.closing = true; clearInterval(segment.timer);
      if (!segment.disconnected) await segment.cdp.send('Page.stopScreencast', {}, current(), segment.session);
      for (const off of segment.off.splice(0)) off();
      if (segment.pumping) await bounded(segment.pumping, current());
      await this.#pump(segment, current());
      segment.process.stdin.end();
      const exitCode = await bounded(segment.exited, current());
      if (segment.failure || (segment.latest && exitCode !== 0)) throw failure('Video encoder did not finalize');
      if (segment.latest && (await stat(segment.absolute)).size > 0) this.#finished.push({ path: segment.relative, startedAt: segment.startedAt });
      else await rm(segment.absolute, { force: true });
    } catch {
      this.#lost = true; segment.closing = true; clearInterval(segment.timer);
      await this.#terminate(segment.process);
      await rm(segment.absolute, { force: true }).catch(() => undefined);
    } finally {
      for (const off of segment.off.splice(0)) off(); segment.lifetime.abort();
      if (!segment.disconnected) await segment.cdp.send('Target.detachFromTarget', { sessionId: segment.session }, { ...context, signal: new AbortController().signal, timeoutMs: 2_000 }).catch(() => { this.#lost = true; });
    }
  }
  async #terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.destroy();
    const done = new Promise<void>(resolve => { child.once('close', () => resolve()); });
    child.kill('SIGTERM'); const kill = setTimeout(() => { child.kill('SIGKILL'); }, 500);
    await Promise.race([done, new Promise<void>(resolve => { setTimeout(resolve, 1_500).unref(); })]); clearTimeout(kill);
  }
}


/** One native hosted-service recording spans every page/context in its owned browser lease. */
export class ProviderVideo implements AttemptVideo {
  readonly #record: (signal: AbortSignal) => Promise<LeaseRecording>;
  readonly #artifactsDir: string;
  #started: LeaseRecording | undefined;
  #starting: Promise<void> | undefined;
  #startController: AbortController | undefined;
  #stopping: Promise<readonly VideoSegment[]> | undefined;
  constructor(record: (signal: AbortSignal) => Promise<LeaseRecording>, artifactsDir: string) { this.#record = record; this.#artifactsDir = artifactsDir; }
  get isArmed(): boolean { return this.#started !== undefined || this.#starting !== undefined; }
  arm(_cdp: CdpConnection, _targetId: string, context: OperationContext): Promise<void> {
    if (this.#started) return Promise.resolve();
    if (this.#starting) return bounded(this.#starting, context);
    const controller = new AbortController(); this.#startController = controller;
    const signal = AbortSignal.any([controller.signal, context.signal]);
    const raw = Promise.resolve().then(() => this.#record(signal)).then(async recording => {
      if (signal.aborted) {
        await this.#lateStop(recording); return undefined;
      }
      return recording;
    });
    const starting = bounded(raw, { ...context, signal }).then(async recording => {
      if (!recording) throw new EngineError('CANCELLED', 'Video operation cancelled', { retryable: false });
      if (signal.aborted) { await this.#lateStop(recording); throw new EngineError('CANCELLED', 'Video operation cancelled', { retryable: false }); }
      this.#started = recording;
    }).catch(error => { controller.abort(); throw error; }).finally(() => {
      if (this.#starting === starting) { this.#starting = undefined; this.#startController = undefined; }
    });
    this.#starting = starting; return starting;
  }
  async pageOpened(_cdp: CdpConnection, _targetId: string, _context: OperationContext): Promise<void> {}
  async pageClosing(_context: OperationContext): Promise<void> {}
  async stop(context: OperationContext): Promise<readonly VideoSegment[]> {
    this.#startController?.abort();
    if (this.#starting) await this.#starting.catch(() => undefined);
    const started = this.#started; if (!started) return [];
    if (!this.#stopping) {
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      const stopping = this.#stopLease(started, signal).then(segment => {
        if (this.#started === started) this.#started = undefined;
        return [segment];
      }).finally(() => { if (this.#stopping === stopping) this.#stopping = undefined; });
      this.#stopping = stopping;
      try { return await bounded(stopping, context); } catch (error) { controller.abort(); throw error; }
    }
    return bounded(this.#stopping, context);
  }
  async abandon(context: OperationContext): Promise<void> { await this.stop(context); }
  async #stopLease(started: LeaseRecording, signal: AbortSignal): Promise<VideoSegment> {
    try {
      return await stopProviderRecording(started.recording, { artifactsDir: this.#artifactsDir, provider: 'browser provider', leaseId: 'current', signal });
    } catch { throw failure('Browser provider recording could not be finalized'); }
  }
  async #lateStop(started: LeaseRecording): Promise<void> {
    const controller = new AbortController();
    try { await bounded(this.#stopLease(started, controller.signal), { signal: controller.signal, timeoutMs: 10_000, runId: '', attemptId: '', origin: 'test' }); } catch { /* Late cleanup is best effort; never expose provider diagnostics. */ }
    finally { controller.abort(); }
  }
}
