import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { type EngineHandle, type VideoSegment } from 'e2e/engine';
import { agentBrowser, type BrowserProvider } from '../dist/index.js';
import { CdpConnection } from '../src/cdp.ts';
import { launchChromium } from '../src/launch.ts';
import { VideoRecorder } from '../src/video.ts';
import { mockScreencast, operation } from './video-mock.ts';
const execute = promisify(execFile);
const encoder = process.env.E2E_FFMPEG_EXECUTABLE ?? 'ffmpeg';
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function jpeg(color: string): Promise<Buffer> {
  const result = await execute(encoder, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x100`, '-frames:v', '1', '-c:v', 'mjpeg', '-threads', '1', '-f', 'image2pipe', 'pipe:1'], { encoding: 'buffer', timeout: 10_000 });
  return result.stdout;
}
async function verifyVideo(root: string, segment: VideoSegment, minimumDuration: number, expectColorChange: boolean): Promise<void> {
  assert.ok('path' in segment);
  const absolute = path.join(root, segment.path); const bytes = await readFile(absolute);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]); // Actual WebM/EBML, not merely an extension.
  const decoded = await execute(encoder, ['-hide_banner', '-i', absolute, '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', timeout: 15_000, maxBuffer: 1024 * 1024 });
  const duration = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(decoded.stderr.toString()); assert.ok(duration);
  assert.ok(Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) >= minimumDuration);
  assert.ok(decoded.stdout.length >= Math.floor(minimumDuration * 25) * 3);
  if (expectColorChange) {
    const colors = new Set<string>(); for (let i = 0; i < decoded.stdout.length; i += 3) colors.add(decoded.stdout.subarray(i, i + 3).toString('hex'));
    assert.ok(colors.size > 1, 'WebM must contain distinct actual source frames');
  }
}

test('real ffmpeg encodes changing CDP frames and keeps idle wall-clock duration', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-encoder-'));
  const recorder = new VideoRecorder({ artifactsDir: root, ffmpegPath: encoder, env: process.env, size: { width: 161, height: 101 } });
  try {
    const red = await jpeg('red'); const blue = await jpeg('blue'); const mock = mockScreencast(red);
    await recorder.arm(mock.cdp, 'first', operation()); await delay(350); mock.frame(blue); await delay(450);
    const segments = await recorder.stop(operation()); assert.equal(segments.length, 1);
    await verifyVideo(root, segments[0]!, 0.75, true);
    assert.equal((await readdir(path.join(root, 'video'))).length, 1); assert.equal(mock.listenerCount(), 0);
  } finally { await recorder.abandon(operation()); await rm(root, { recursive: true, force: true }); }
});

test('real Chromium screencast produces playable WebM segments across active page changes', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-browser-'));
  const browser = await launchChromium({ executable: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', args: process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [], env: process.env }, operation());
  const cdp = await CdpConnection.connect(browser.endpoint, operation());
  const recorder = new VideoRecorder({ artifactsDir: root, ffmpegPath: encoder, env: process.env, size: { width: 160, height: 100 } });
  try {
    const first = (await cdp.listTargets(operation())).find(target => target.type === 'page')!;
    const session = await cdp.attachTarget(first.targetId, operation());
    await cdp.send('Page.bringToFront', {}, operation(), session);
    await cdp.send('Runtime.evaluate', { expression: `document.documentElement.style.background='red'` }, operation(), session);
    await recorder.arm(cdp, first.targetId, operation()); await delay(400);
    await cdp.send('Runtime.evaluate', { expression: `document.documentElement.style.background='blue'` }, operation(), session); await delay(450);
    await recorder.pageClosing(operation());
    const second = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' }, operation());
    const secondSession = await cdp.attachTarget(second.targetId, operation());
    await cdp.send('Page.bringToFront', {}, operation(), secondSession);
    await cdp.send('Runtime.evaluate', { expression: `document.documentElement.style.background='green'` }, operation(), secondSession);
    await recorder.pageOpened(cdp, second.targetId, operation()); await delay(500);
    const segments = await recorder.stop(operation()); assert.equal(segments.length, 2);
    await verifyVideo(root, segments[0]!, 0.75, true); await verifyVideo(root, segments[1]!, 0.45, false);
    assert.equal((await readdir(path.join(root, 'video'))).every(name => name.endsWith('.webm')), true);
  } finally { await recorder.abandon(operation()); cdp.close(); await browser.close(); await rm(root, { recursive: true, force: true }); }
});


async function closeEngine(engine: EngineHandle): Promise<void> {
  try { await engine.endAttempt!({ signal: operation().signal, timeoutMs: 15_000 }); }
  finally { await engine.dispose!({ signal: operation().signal, timeoutMs: 15_000 }); }
}

test('public engine artifacts stay playable across navigation, reset and state replacement', { timeout: 150_000 }, async () => {
  assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'The exact-ref binary must be supplied by CI');
  const root = await mkdtemp(path.join(tmpdir(), 'video-public-'));
  const server = createServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end(`<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:${request.url === '/blue' ? 'blue' : request.url === '/green' ? 'green' : 'red'}}</style>`); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`;
  const engine = agentBrowser({ executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE, executablePath: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', args: process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [], viewport: { width: 320, height: 200 }, screencast: { ffmpegPath: encoder, size: { width: 161, height: 101 } } });
  try {
    await engine.init!({ runId: 'test', targetName: 'video', projectRoot: root, app: { site: '127.0.0.1' }, env: process.env, headed: false, workerSlot: 0, signal: operation().signal, log: () => undefined });
    await engine.startAttempt!({ attemptId: 'test', artifactsDir: root, signal: operation().signal, resolveSecret: async () => { throw new Error('No secrets in video fixture'); }, appLog: () => undefined, navigation: () => undefined, environment: () => undefined });
    await engine.session!.open!(`${origin}/red`, operation());
    await engine.artifacts!.startVideo!(operation()); await delay(350);
    await engine.session!.open!(`${origin}/blue`, operation()); await delay(350);
    const state = await engine.state!.capture(operation());
    await engine.session!.reset!(operation()); await engine.session!.open!(`${origin}/green`, operation()); await delay(350);
    await engine.state!.restore(state, operation()); await engine.session!.open!(`${origin}/red`, operation()); await delay(350);
    const segments = await engine.artifacts!.stopVideo!(operation()); assert.equal(segments.length, 3);
    await verifyVideo(root, segments[0]!, 0.65, true);
    for (const segment of segments.slice(1)) await verifyVideo(root, segment, 0.3, false);
    const first = segments[0]!; assert.ok('path' in first);
    const decoded = await execute(encoder, ['-hide_banner', '-i', path.join(root, first.path), '-f', 'null', '-'], { encoding: 'utf8', timeout: 15_000 });
    assert.match(decoded.stderr, /161x101/, 'Odd-sized requested output dimensions must be preserved');
    assert.deepEqual(await engine.artifacts!.stopVideo!(operation()), []);
  } finally { try { await closeEngine(engine); } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } }
});

test('public hosted-provider recording is preferred without ffmpeg and survives context reset', { timeout: 100_000 }, async () => {
  assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'The exact-ref binary must be supplied by CI');
  const root = await mkdtemp(path.join(tmpdir(), 'video-hosted-'));
  let owned: Awaited<ReturnType<typeof launchChromium>> | undefined; let starts = 0; let stops = 0; let releases = 0;
  const provider: BrowserProvider = {
    name: 'synthetic-video-provider', scope: 'attempt',
    acquire: async request => {
      owned = await launchChromium({ executable: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', args: process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [], env: request.env }, { ...operation(), signal: request.signal });
      return { id: 'owned-test-browser', cdpEndpoint: owned.endpoint };
    },
    release: async () => { releases++; await owned?.close(); },
    record: async () => { starts++; return { startedAt: new Date().toISOString(), stop: async () => { stops++; return { url: 'https://video.example.test/owned-test-browser', mediaType: 'text/html' }; } }; },
  };
  const engine = agentBrowser({ executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE, browser: provider, screencast: { ffmpegPath: path.join(root, 'deliberately-missing-encoder') } });
  const prepare = { runId: 'test', targetName: 'video', projectRoot: root, app: {}, env: process.env, headed: false, slots: 1, signal: operation().signal, log: () => undefined };
  try {
    const prepared = await engine.prepare!(prepare);
    await engine.init!({ ...prepare, env: { ...process.env, ...prepared?.env }, workerSlot: 0 });
    await engine.startAttempt!({ attemptId: 'test', artifactsDir: root, signal: operation().signal, resolveSecret: async () => { throw new Error('No secrets in video fixture'); }, appLog: () => undefined, navigation: () => undefined, environment: () => undefined });
    await engine.artifacts!.startVideo!(operation()); await engine.session!.reset!(operation());
    const segments = await engine.artifacts!.stopVideo!(operation()); assert.equal(segments.length, 1); assert.ok('url' in segments[0]!);
    assert.equal(starts, 1); assert.equal(stops, 1);
  } finally {
    try { await closeEngine(engine); } finally {
      try { await engine.finish!({ ...prepare, timeoutMs: 15_000 }); } finally { await owned?.close(); await rm(root, { recursive: true, force: true }); }
    }
  }
  assert.equal(releases, 1);
});
