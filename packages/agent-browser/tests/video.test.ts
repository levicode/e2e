import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ProviderVideo, VideoRecorder, validateVideoOptions } from '../src/video.ts';
import type { LeaseRecording } from '../src/provider.ts';
import { mockScreencast, operation } from './video-mock.ts';
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function fakeEncoder(root: string, mode = 'normal'): Promise<string> {
  const executable = path.join(root, 'encoder');
  await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs';\nlet size=0;process.stdin.on('data',data=>{size+=data.length});process.stdin.on('end',()=>{${mode === 'fail' ? 'process.exit(2)' : mode === 'hang' ? "setInterval(()=>{},1000)" : "fs.writeFileSync(process.argv.at(-1),JSON.stringify({size,args:process.argv.slice(2)}))"}});\n`, { mode: 0o700 });
  return executable;
}

test('video options reject invalid encoder configuration before any process starts', () => {
  for (const size of [{ width: 0, height: 1 }, { width: 1.5, height: 1 }, { width: 16385, height: 1 }]) assert.throws(() => validateVideoOptions({ size }), /dimensions/);
  for (const quality of [-1, 101, NaN, 1.2]) assert.throws(() => validateVideoOptions({ quality }), /quality/);
  for (const ffmpegPath of ['', ' ', 'ffmpeg\0x']) assert.throws(() => validateVideoOptions({ ffmpegPath }), /path/);
  assert.doesNotThrow(() => validateVideoOptions({ quality: 0, size: { width: 1, height: 1 } }));
});

test('video uses actual CDP frames, acks immediately, repeats idle time and closes owned sessions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-unit-')); const mock = mockScreencast();
  const recorder = new VideoRecorder({ artifactsDir: root, ffmpegPath: await fakeEncoder(root) });
  try {
    await recorder.arm(mock.cdp, 'first', operation()); await delay(150);
    await recorder.pageClosing(operation());
    assert.equal(recorder.isArmed, true);
    await recorder.pageOpened(mock.cdp, 'second', operation()); await delay(90);
    const segments = await recorder.stop(operation()); assert.equal(segments.length, 2);
    assert.equal(recorder.isArmed, false); assert.equal(mock.listenerCount(), 0);
    assert.equal(mock.calls.filter(call => call.method === 'Page.startScreencast').length, 2);
    assert.equal(mock.calls.filter(call => call.method === 'Page.stopScreencast').length, 2);
    assert.equal(mock.calls.filter(call => call.method === 'Target.detachFromTarget').length, 2);
    assert.equal(mock.calls.filter(call => call.method === 'Page.screencastFrameAck').length, 2);
    for (const segment of segments) {
      assert.ok('path' in segment); assert.match(segment.path, /^video\/video-[\da-f-]+\.webm$/);
      const encoded = JSON.parse(await readFile(path.join(root, segment.path), 'utf8'));
      assert.ok(encoded.size >= 8); assert.ok(encoded.args.includes('libvpx'));
      assert.equal(Number.isNaN(Date.parse(segment.startedAt)), false);
    }
    assert.deepEqual(await recorder.stop(operation()), []);
    assert.equal((await readdir(path.join(root, 'video'))).every(name => name.endsWith('.webm')), true);
  } finally { await recorder.abandon(operation()); await rm(root, { recursive: true, force: true }); }
});

test('video finalizes a disconnected source and resumes only on the next owned page', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-unit-')); const mock = mockScreencast();
  const recorder = new VideoRecorder({ artifactsDir: root, ffmpegPath: await fakeEncoder(root) });
  try {
    await recorder.arm(mock.cdp, 'first', operation()); await delay(50); mock.disconnect();
    await recorder.pageOpened(mock.cdp, 'second', operation()); await delay(50);
    assert.equal((await recorder.stop(operation())).length, 2); assert.equal(mock.listenerCount(), 0);
    assert.equal(mock.calls.filter(call => call.method === 'Page.stopScreencast').length, 1);
  } finally { await recorder.abandon(operation()); await rm(root, { recursive: true, force: true }); }
});

test('video encoder failures discard partial output without exposing encoder diagnostics', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-unit-')); const mock = mockScreencast();
  const recorder = new VideoRecorder({ artifactsDir: root, ffmpegPath: await fakeEncoder(root, 'fail') });
  try {
    await recorder.arm(mock.cdp, 'first', operation()); await delay(30);
    await assert.rejects(recorder.stop(operation()), /segment could not be finalized/);
    assert.deepEqual(await readdir(path.join(root, 'video')), []); assert.equal(mock.listenerCount(), 0);
  } finally { await recorder.abandon(operation()); await rm(root, { recursive: true, force: true }); }
});

test('video missing encoder is explicit and cleans up its own CDP attachment', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-unit-')); const mock = mockScreencast();
  const recorder = new VideoRecorder({ artifactsDir: root, ffmpegPath: path.join(root, 'missing') });
  try {
    await assert.rejects(recorder.arm(mock.cdp, 'first', operation()), /ffmpeg executable/);
    assert.equal(recorder.isArmed, false); assert.equal(mock.listenerCount(), 0);
    assert.equal(mock.calls.filter(call => call.method === 'Target.detachFromTarget').length, 1);
  } finally { await recorder.abandon(operation()); await rm(root, { recursive: true, force: true }); }
});

test('video encoder timeout terminates its process and leaves no orphan artifact', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-unit-')); const mock = mockScreencast();
  const recorder = new VideoRecorder({ artifactsDir: root, ffmpegPath: await fakeEncoder(root, 'hang') });
  try {
    await recorder.arm(mock.cdp, 'first', operation()); await delay(30);
    await assert.rejects(recorder.stop({ ...operation(), timeoutMs: 150 }), /segment could not be finalized/);
    assert.deepEqual(await readdir(path.join(root, 'video')), []); assert.equal(mock.listenerCount(), 0);
  } finally { await recorder.abandon(operation()); await rm(root, { recursive: true, force: true }); }
});


function recording(stop: LeaseRecording['recording']['stop']): LeaseRecording {
  return { provider: 'private-provider', leaseId: 'private-lease', recording: { startedAt: '2026-01-01T00:00:00Z', stop } };
}

test('provider video spans page changes and validates one hosted segment without ffmpeg', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-provider-')); const mock = mockScreencast(); let starts = 0; let stops = 0;
  const video = new ProviderVideo(async () => { starts++; return recording(async () => { stops++; return { url: 'https://video.example.test/play/one', mediaType: 'text/html' }; }); }, root);
  try {
    await video.arm(mock.cdp, 'first', operation()); await video.arm(mock.cdp, 'first', operation());
    await video.pageClosing(operation()); await video.pageOpened(mock.cdp, 'second', operation());
    assert.deepEqual(await video.stop(operation()), [{ url: 'https://video.example.test/play/one', mediaType: 'text/html', startedAt: '2026-01-01T00:00:00.000Z' }]);
    assert.equal(starts, 1); assert.equal(stops, 1); assert.equal(mock.calls.length, 0);
    assert.deepEqual(await video.stop(operation()), []);
  } finally { await video.abandon(operation()); await rm(root, { recursive: true, force: true }); }
});

test('provider late starts are stopped with a fresh signal after the caller times out', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-provider-')); const mock = mockScreencast(); let stops = 0;
  let release!: (value: LeaseRecording) => void;
  const video = new ProviderVideo(() => new Promise(resolve => { release = resolve; }), root);
  try {
    await assert.rejects(video.arm(mock.cdp, 'first', { ...operation(), timeoutMs: 20 }), error => error instanceof Error && 'code' in error && error.code === 'OPERATION_TIMEOUT');
    release(recording(async context => { assert.equal(context.signal.aborted, false); stops++; return { url: 'https://video.example.test/late', mediaType: 'text/html' }; }));
    await delay(20); assert.equal(stops, 1); assert.equal(video.isArmed, false); assert.deepEqual(await video.stop(operation()), []);
  } finally { await video.abandon(operation()); await rm(root, { recursive: true, force: true }); }
});

test('provider timed-out stops retain the same in-flight stop instead of repeating a mutation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-provider-')); const mock = mockScreencast(); let stops = 0;
  let complete!: () => void; const finished = new Promise<void>(resolve => { complete = resolve; });
  const video = new ProviderVideo(async () => recording(async () => { stops++; await finished; return { url: 'https://video.example.test/one', mediaType: 'text/html' }; }), root);
  try {
    await video.arm(mock.cdp, 'first', operation());
    await assert.rejects(video.stop({ ...operation(), timeoutMs: 20 }), error => error instanceof Error && 'code' in error && error.code === 'OPERATION_TIMEOUT');
    const resumed = video.stop(operation()); complete(); assert.equal((await resumed).length, 1); assert.equal(stops, 1);
  } finally { complete(); await video.abandon(operation()); await rm(root, { recursive: true, force: true }); }
});

test('provider failures never reflect private diagnostics or malformed artifact paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-provider-')); const mock = mockScreencast();
  const video = new ProviderVideo(async () => recording(async () => ({ file: '../../private-secret' })), root);
  try {
    await video.arm(mock.cdp, 'first', operation());
    await assert.rejects(video.stop(operation()), error => error instanceof Error && !/private|secret|lease/.test(error.message));
  } finally { await video.abandon(operation()).catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
