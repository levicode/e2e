/** Public protected-pixel acceptance. These are real web() calls, not a mocked capture producer. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { web } from '../../src/index.ts';
import { nativeBrowser, nativeDocument } from '../helpers/native-browser.ts';
import { decodePng } from '../helpers/png.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

async function fixture() {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'native-capture-contract-'));
  const engine = web({ viewport: { width: 640, height: 480 } });
  const operation = { signal: new AbortController().signal, timeoutMs: 15000, runId: 'capture', attemptId: 'capture', origin: 'test' as const };
  const close = async () => {
    try { await engine.dispose!({ signal: new AbortController().signal, timeoutMs: 30000 }); }
    finally { rmSync(artifactsDir, { recursive: true, force: true }); }
  };
  try {
    await engine.init!({ runId: 'capture', targetName: 'web', projectRoot: process.cwd(), app: {}, env: process.env, headed: false, workerSlot: 0, signal: operation.signal, log: () => undefined });
    await engine.startAttempt!({ attemptId: 'capture', artifactsDir, signal: operation.signal, resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!('about:blank', operation);
    return { engine, operation, artifactsDir, browser: nativeBrowser(engine, () => operation), close };
  } catch (cause) {
    try { await close(); } catch (cleanup) { throw new AggregateError([cause, cleanup], 'Capture fixture startup cleanup failed', { cause: cleanup }); }
    throw cause;
  }
}
const field = 'position:absolute;left:20px;width:160px;height:40px;border:0;padding:0;background:#f00;color:#f00';
const content = `<body style="margin:0;background:blue"><input data-testid="password" aria-label="Password" type="password" value="synthetic-private-value" style="${field};top:20px"><input aria-label="Public" value="plain" style="${field};top:100px"></body>`;

it('masks iframe password pixels in both observations and artifacts without blanking public pixels', async () => {
  const f = await fixture();
  try {
    await nativeDocument(f.browser, `<body style="margin:0"><iframe srcdoc='${content}' style="position:absolute;left:0;top:0;width:400px;height:240px;border:0"></iframe></body>`);
    await expect.poll(() => f.browser.evaluate(() => document.querySelector('iframe')?.contentDocument?.readyState === 'complete')).toBe(true);
    const observation = await f.engine.observe!(f.operation, { pixels: true });
    expect(observation.maskedRegionCount).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(observation.root)).not.toContain('synthetic-private-value');
    const pixels = decodePng(observation.pixels!.data);
    expect({ width: observation.pixels!.width, height: observation.pixels!.height }).toEqual({ width: pixels.width, height: pixels.height });
    expect(pixels.width).toBe(640); expect(pixels.height).toBe(480);
    expect(pixels.pixelAt(100, 40).slice(0, 3)).toEqual([0, 0, 0]);
    expect(pixels.pixelAt(100, 120).slice(0, 3)).toEqual([255, 0, 0]);
    await f.browser.evaluate(() => { document.querySelector('iframe')!.contentDocument!.body.style.background = '#00ff00'; return null; });
    const relative = await f.engine.artifacts!.screenshot('fresh-protected', f.operation);
    const artifact = decodePng(new Uint8Array(readFileSync(path.join(f.artifactsDir, relative))));
    expect({ width: artifact.width, height: artifact.height }).toEqual({ width: 640, height: 480 });
    expect(artifact.pixelAt(100, 40).slice(0, 3)).toEqual([0, 0, 0]);
    expect(artifact.pixelAt(100, 120).slice(0, 3)).toEqual([255, 0, 0]);
    expect(artifact.pixelAt(300, 180).slice(0, 3)).toEqual([0, 255, 0]);
    expect(await f.browser.evaluate(() => document.querySelector('iframe')!.contentDocument!.querySelector<HTMLInputElement>('input')!.value === 'synthetic-private-value')).toBe(true);
  } finally { await f.close(); }
});

it('protects closed-shadow password pixels and restores the live field after capture', async () => {
  const f = await fixture();
  try {
    await nativeDocument(f.browser, '<body style="margin:0;background:blue"><div id="host"></div></body>');
    await f.browser.evaluate((html) => { document.querySelector('#host')!.attachShadow({ mode: 'closed' }).innerHTML = html; return null; }, content);
    const observation = await f.engine.observe!(f.operation, { pixels: true });
    expect(observation.maskedRegionCount).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(observation.root)).not.toContain('synthetic-private-value');
    const relative = await f.engine.artifacts!.screenshot('closed-shadow', f.operation);
    for (const bytes of [observation.pixels!.data, new Uint8Array(readFileSync(path.join(f.artifactsDir, relative)))]) {
      const pixels = decodePng(bytes);
      expect(pixels.pixelAt(100, 40).slice(0, 3)).toEqual([0, 0, 0]);
      expect(pixels.pixelAt(100, 120).slice(0, 3)).toEqual([255, 0, 0]);
    }
    const [password] = await f.engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'password', exact: true } } }, f.operation);
    expect(password?.states?.secure).toBe(true);
    await f.engine.perform!(password!.ref, { kind: 'fill', value: 'replacement-synthetic', sensitive: true }, f.operation);
  } finally { await f.close(); }
});
