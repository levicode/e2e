/** Built-package acceptance: an HTML OBJECT screenshot and compact refs reach the actual model request. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { expect, type ModelInstance } from 'e2e';
import { openHost } from 'e2e/runner';
import { agentBrowser, type Browser } from '../dist/index.js';

interface Part { type: string; text?: string; output?: { value?: unknown }; }
interface Request { prompt: Array<{ role: string; content: string | Part[] }>; }

/** Collects PNG image bytes from provider request parts, not runner artifacts. */
function pngParts(value: unknown): Uint8Array[] {
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return [];
  const item = value as Record<string, unknown>;
  if (item.mediaType === 'image/png') {
    const data = item.data ?? item.image;
    if (data instanceof Uint8Array) return [data];
    if (typeof data === 'string') return [Buffer.from(data, 'base64')];
    if (data && typeof data === 'object' && 'data' in data && typeof data.data === 'string') return [Buffer.from(data.data, 'base64')];
  }
  return Object.values(item).flatMap(pngParts);
}

/** Decodes one RGB pixel independently of the production masking proof. */
function pixelAt(png: Uint8Array, x: number, y: number): number[] {
  const bytes = Buffer.from(png);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes[24], 8);
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  assert.ok(x >= 0 && x < width && y >= 0 && y < height);
  const channels = bytes[25] === 6 ? 4 : 3;
  assert.ok(bytes[25] === 2 || bytes[25] === 6);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)); const stride = width * channels;
  let previous = Buffer.alloc(stride);
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c; const aa = Math.abs(p - a); const bb = Math.abs(p - b); const cc = Math.abs(p - c);
    return aa <= bb && aa <= cc ? a : bb <= cc ? b : c;
  };
  for (let yy = 0; yy <= y; yy++) {
    const row = Buffer.alloc(stride); const base = yy * (stride + 1); const filter = raw[base];
    assert.ok(filter !== undefined && filter <= 4);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels]! : 0; const up = previous[i]!; const upperLeft = i >= channels ? previous[i - channels]! : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      row[i] = (raw[base + 1 + i]! + predictor) & 255;
    }
    previous = row;
  }
  return [...previous.subarray(x * channels, x * channels + 3)];
}

test('HTML OBJECT masked PNG reaches model request and compact alias returns to the real action', { timeout: 180_000 }, async () => {
  assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'A verified native executable is required');
  let clicks = 0;
  const server = createServer((request, response) => {
    if (request.url === '/commit') { clicks++; response.end('ok'); return; }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/child') {
      response.end('<!doctype html><style>html,body{margin:0;background:white}input{position:absolute;left:10px;top:10px;width:160px;height:36px}</style><input type="password" value="fixture-secret">');
    } else {
      response.end('<!doctype html><style>html,body{margin:0;background:white}object{position:absolute;left:40px;top:40px;width:240px;height:100px;border:0;padding:0}button{position:absolute;left:40px;top:180px}</style><object type="text/html" data="/child"></object><button onclick="this.textContent=\'Committed\';navigator.sendBeacon(\'/commit\')">Commit fixture</button>');
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const cwd = await mkdtemp(path.join(tmpdir(), 'e2e-model-boundary-'));
  let calls = 0; let sentAlias = ''; let providerImageCount = 0;
  const model = {
    specificationVersion: 'v4', provider: 'fixture', modelId: 'object-compact-boundary', supportedUrls: {},
    async doGenerate(request: Request) {
      calls++;
      const text = request.prompt.flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.flatMap(part => part.text !== undefined ? [part.text] : part.output?.value === undefined ? [] : [JSON.stringify(part.output.value)])).join('\n');
      assert.doesNotMatch(text, /agent-browser:[0-9a-f]{8}-/i, 'Full engine identities must not reach model text');
      let toolName: string; let input: object;
      if (calls === 1) { toolName = 'screenshot'; input = {}; }
      else if (calls === 2) {
        const images = pngParts(request.prompt);
        assert.ok(images.length > 0, 'The real next model request must contain a PNG, not only a screenshot caption');
        providerImageCount += images.length;
        const png = images.at(-1)!; const scale = Buffer.from(png).readUInt32BE(16) / 640;
        assert.deepEqual(pixelAt(png, Math.floor(100 * scale), Math.floor(70 * scale)), [0, 0, 0], 'The OBJECT password is black in the bytes delivered to the model');
        assert.deepEqual(pixelAt(png, Math.floor(600 * scale), Math.floor(20 * scale)), [255, 255, 255], 'Unrelated screenshot pixels remain useful');
        const lines = text.replaceAll('\\n', '\n').replaceAll('\\"', '"').split('\n');
        const line = lines.findLast(value => value.includes('button "Commit fixture"'));
        assert.ok(line, 'The button must be present in the actual model request');
        sentAlias = /#(n[0-9a-z]+)\b/.exec(line)?.[1] ?? '';
        assert.ok(sentAlias && sentAlias.length < 12, 'The model must receive a compact core reference');
        toolName = 'tap'; input = { target: sentAlias };
      } else {
        assert.equal(calls, 3, 'A screenshot, one action, and one conclusion suffice');
        assert.match(text, /Committed/);
        toolName = 'complete_step'; input = { status: 'passed', summary: 'Committed the fixture after inspecting a masked OBJECT screenshot' };
      }
      return { content: [{ type: 'tool-call', toolCallId: `fixture_${calls}`, toolName, input: JSON.stringify(input) }], finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } }, warnings: [] };
    },
    async doStream(): Promise<never> { throw new Error('This fixture uses non-streaming requests'); },
  } as ModelInstance;
  let host: Awaited<ReturnType<typeof openHost<{ browser: Browser }>>> | undefined;
  try {
    host = await openHost<{ browser: Browser }>({ cwd, env: { ...process.env, E2E_TELEMETRY_DISABLED: '1' }, config: {
    projectId: 'object-model-boundary', targets: [{ name: 'fixture', platform: 'web', app: { url: `http://127.0.0.1:${address.port}` }, engine: agentBrowser({ executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE!, executablePath: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', args: process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [], viewport: { width: 640, height: 480 } }) }],
    agents: { default: { model } }, workers: 1, retries: 0, timeout: 120_000, launchTimeout: 60_000, actionTimeout: 30_000, cache: 'off', video: 'off', trace: 'on',
  } });
    const session = await host.openSession({ name: 'object image and compact model references' });
    try {
      await session.fixtures.app.open('/');
      assert.equal(await session.fixtures.browser.evaluate('new Promise(resolve => { const owner=document.querySelector("object"); const ready=()=>!!owner.contentDocument?.querySelector("input"); if(ready())resolve(true);else owner.addEventListener("load",()=>resolve(ready()),{once:true}); })'), true);
      await session.fixtures.agent.act('Inspect a screenshot, then commit the fixture once');
      await expect(session.fixtures.screen.getByRole('button', { name: 'Committed', exact: true })).toBeVisible();
      assert.equal(calls, 3); assert.ok(providerImageCount > 0); assert.ok(sentAlias);
      assert.equal(await session.fixtures.browser.evaluate('document.querySelector("object").contentDocument.querySelectorAll("[popover]").length'), 0);
      await session.close();
      const report = session.report(); assert.ok(report); assert.equal(report.run.status, 'passed');
      const step = report.run.results.flatMap(result => result.attempts.flatMap(attempt => attempt.steps)).find(value => value.api === 'agent.act');
      assert.equal(step?.visionInput, true); assert.equal(step?.metrics?.modelCalls, 3); assert.ok((step?.metrics?.pixelBytes ?? 0) > 0);
      assert.equal(clicks, 1);
    } finally { await session.close(); }
  } finally { await host?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(cwd, { recursive: true, force: true }); }
});
