/** Full public consumers, not direct backend mocks: every case runs through the built Web engine. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const CASES = [
  'navigation history reload and browser expectations preserve document readiness',
  'evaluate supports JSON arguments async functions and string expressions',
  'cookies retain context scope and start isolated in every attempt',
  'init scripts and partial media updates cover frames and new tabs',
  'viewport and keyboard preserve actual input and key events',
  'pointer primitives preserve coordinates buttons and wheel events',
  'frame locators and class assertions use the shared public query contract',
  'large fulfill and continued request bodies use verified native storage',
] as const;

const syntheticEvidenceModule = new URL('../../../web/tests/helpers/synthetic-evidence.ts', import.meta.url).href;

const SUITE = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { beginSyntheticCase } from ${JSON.stringify(syntheticEvidenceModule)};

test('${CASES[0]}', { timeout: 12_000 }, async ({ browser }) => {
  await browser.goto('/a', { waitUntil: 'domcontentloaded' });
  await expect(browser).toHaveTitle('Fixture /a');
  await browser.goto('/b', { waitUntil: 'load' });
  expect(await browser.title()).toBe('Fixture /b');
  await browser.back();
  await browser.waitForURL('/a');
  expect(await browser.title()).toBe('Fixture /a');
  await browser.forward();
  await expect(browser).toHaveURL(/\\/b$/);
  await browser.reload();
  expect(await browser.evaluate(() => document.readyState)).toBe('complete');
  expect(await browser.evaluate(() => Number(sessionStorage.getItem('loads')))).toBeGreaterThanOrEqual(2);
});

test('${CASES[1]}', async ({ browser }) => {
  await browser.goto('/a');
  expect(await browser.evaluate(async value => ({ ...value, answer: await Promise.resolve(42) }), { empty: null, list: ['雪', false, 0] })).toEqual({ empty: null, list: ['雪', false, 0], answer: 42 });
  expect(await browser.evaluate('({ nested: [1, 2, 3] })')).toEqual({ nested: [1, 2, 3] });
  expect(await browser.evaluate('(value) => value + 1', 4)).toBe(5);
});

test('${CASES[2]}', async ({ browser }) => {
  await browser.goto('/a');
  expect((await browser.cookies()).some(cookie => cookie.name === 'native-fixture')).toBe(false);
  await browser.setCookies([{ name: 'native-fixture', value: 'synthetic', url: '/', httpOnly: true, sameSite: 'Lax' }]);
  const cookie = (await browser.cookies()).find(cookie => cookie.name === 'native-fixture');
  expect(cookie?.value).toBe('synthetic');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
  expect(await browser.evaluate(() => document.cookie.includes('native-fixture'))).toBe(false);
  expect(await browser.evaluate(() => fetch('/cookie').then(response => response.text()))).toContain('native-fixture=synthetic');
});

test('${CASES[3]}', { timeout: 12_000 }, async ({ browser }) => {
  await browser.addInitScript(value => { globalThis.fixtureInit = value; }, { marker: 'synthetic' });
  await browser.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await browser.emulateMedia({ colorScheme: 'light' });
  await browser.goto('/a');
  expect(await browser.evaluate(() => ({ marker: globalThis.fixtureAtFirstScript, light: matchMedia('(prefers-color-scheme: light)').matches, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches }))).toEqual({ marker: 'synthetic', light: true, reduce: true });
  expect(await browser.frameLocator('iframe').locator('body').getAttribute('data-init')).toBe('synthetic');
  const popup = await browser.evaluate(() => new Promise(resolve => {
    const child = window.open('/popup');
    if (!child) throw new Error('Synthetic popup was not created');
    const timer = setInterval(() => {
      if (child.fixtureAtFirstScript !== 'synthetic') return;
      clearInterval(timer);
      resolve({ marker: child.fixtureAtFirstScript, light: child.matchMedia('(prefers-color-scheme: light)').matches, reduce: child.matchMedia('(prefers-reduced-motion: reduce)').matches });
      child.close();
    }, 10);
  }));
  expect(popup).toEqual({ marker: 'synthetic', light: true, reduce: true });
  expect(await browser.url()).toMatch(/\\/a$/);
});

test('${CASES[4]}', async ({ browser }) => {
  await browser.goto('/a');
  await browser.setViewport({ width: 900, height: 600 });
  expect(await browser.evaluate(() => [innerWidth, innerHeight])).toEqual([900, 600]);
  await browser.locator('#input').tap();
  await browser.keyboard.type('ab');
  await browser.keyboard.down('Shift');
  await browser.keyboard.press('ArrowLeft');
  await browser.keyboard.up('Shift');
  expect(await browser.evaluate(() => { const input = document.querySelector('#input'); return [input.selectionStart, input.selectionEnd]; })).toEqual([1, 2]);
  expect(await browser.evaluate(() => document.querySelector('#input').value)).toBe('ab');
  const keys = await browser.evaluate(() => globalThis.fixtureKeys);
  expect(keys).toContain('keydown:a');
  expect(keys).toContain('keyup:a');
  expect(keys).toContain('keydown:Shift');
  expect(keys).toContain('keyup:Shift');
});

test('${CASES[5]}', async ({ browser }) => {
  const evidence = beginSyntheticCase('C01');
  let phase = 'navigate';
  let body = 'incomplete';
  try {
    evidence.record({ kind: 'phase', section: 'body', phase, state: 'enter' });
    await browser.goto('/a');
    evidence.record({ kind: 'phase', section: 'body', phase, state: 'passed' });
    phase = 'dispatch'; evidence.record({ kind: 'phase', section: 'body', phase, state: 'enter' });
    await browser.mouse.move(30, 130);
    await browser.mouse.down();
    await browser.mouse.up();
    await browser.mouse.wheel(0, 40);
    phase = 'sample';
    const events = await browser.evaluate(() => globalThis.fixturePointer);
    // Emit completion facts after the original sample; do not insert synchronous I/O between wheel and read.
    evidence.record({ kind: 'phase', section: 'body', phase: 'dispatch', state: 'passed' });
    evidence.observe(() => ({ kind: 'wheel-sample', phase: 'original-sample', sampleOrdinal: 0,
      downCount: events.filter(value => value.startsWith('down:')).length,
      upCount: events.filter(value => value.startsWith('up:')).length,
      wheelCount: events.filter(value => value.startsWith('wheel:')).length,
      expectedDeltaSeen: events.includes('wheel:40'), nativePublicResultObserved: false, cdpAckObserved: null }));
    evidence.record({ kind: 'phase', section: 'body', phase, state: 'passed' });
    phase = 'assertion';
    expect(events).toContain('down:30:130:1');
    expect(events).toContain('up:30:130:0');
    expect(events).toContain('wheel:40');
    body = 'passed';
  } catch (cause) {
    body = 'failed'; evidence.record({ kind: 'phase', section: 'body', phase, state: 'failed' }); throw cause;
  } finally {
    // The runner owns fixture teardown after this callback: its result is not observed here.
    evidence.finish({ setup: 'passed', body, cleanup: 'not-started' });
  }
});

test('${CASES[6]}', async ({ browser }) => {
  const evidence = beginSyntheticCase('C02');
  let phase = 'navigate';
  let body = 'incomplete';
  try {
    evidence.record({ kind: 'phase', section: 'body', phase, state: 'enter' });
    await browser.goto('/a');
    evidence.record({ kind: 'phase', section: 'body', phase, state: 'passed' });
    phase = 'locate';
    const frame = browser.frameLocator('iframe');
    expect(await frame.getByRole('button', { name: 'Inside frame' }).textContent()).toBe('Inside frame');
    // One extra renderer await can change scheduling. These static centers do not prove the native action point.
    try {
      const hit = await browser.evaluate(() => {
        const owner = document.querySelector('iframe');
        const child = owner?.contentDocument;
        const button = child?.getElementById('frame-button');
        const input = child?.getElementById('input');
        if (!owner || !child || !button) return { available: false, leafHitInput: null, leafHitButton: null, ancestorHitOwner: null, clickSeen: null };
        const box = button.getBoundingClientRect();
        const x = box.x + box.width / 2; const y = box.y + box.height / 2;
        const leaf = child.elementFromPoint(x, y);
        const ownerBox = owner.getBoundingClientRect();
        const ancestor = document.elementFromPoint(ownerBox.x + owner.clientLeft + x, ownerBox.y + owner.clientTop + y);
        return { available: true, leafHitInput: input != null && leaf === input, leafHitButton: leaf === button,
          ancestorHitOwner: ancestor === owner, clickSeen: button.getAttribute('data-clicked') === 'yes' };
      });
      evidence.observe(() => ({ kind: 'frame-hit', phase: 'pre-tap', ...hit, nativePointProven: false, nativeDispatchCount: null }));
    } catch {
      evidence.invalidate();
      evidence.record({ kind: 'frame-hit', phase: 'pre-tap', available: false, leafHitInput: null, leafHitButton: null,
        ancestorHitOwner: null, clickSeen: null, nativePointProven: false, nativeDispatchCount: null });
    }
    phase = 'dispatch'; evidence.record({ kind: 'phase', section: 'body', phase, state: 'enter' });
    await frame.locator('#frame-button').tap();
    evidence.record({ kind: 'phase', section: 'body', phase, state: 'passed' });
    phase = 'assertion';
    expect(await frame.locator('#frame-button').getAttribute('data-clicked')).toBe('yes');
    await expect(browser).toHaveClass(browser.locator('#input'), /fixture-input/);
    await expect(browser).not.toHaveClass(browser.locator('#input'), 'missing');
    body = 'passed';
  } catch (cause) {
    body = 'failed'; evidence.record({ kind: 'phase', section: 'body', phase, state: 'failed' }); throw cause;
  } finally {
    evidence.finish({ setup: 'passed', body, cleanup: 'not-started' });
  }
});

test('${CASES[7]}', { timeout: 15_000 }, async ({ browser }) => {
  await browser.goto('/a');
  const body = 'x'.repeat(1_500_000);
  await browser.route(/(?<=\\/)api\\/large(?:\\?.*)?$/u, route => route.fulfill({ body, contentType: 'text/plain' }));
  expect(await browser.evaluate(() => fetch('/api/large').then(response => response.text()).then(text => text.length))).toBe(body.length);
  await browser.unroute(/(?<=\\/)api\\/large(?:\\?.*)?$/u);
  await browser.route('**/echo', route => route.continue({ method: 'POST', postData: body }));
  expect(await browser.evaluate(() => fetch('/echo', { method: 'POST', body: 'original' }).then(response => response.json()))).toEqual({ length: body.length, first: 'x', last: 'x' });
});
`;

function document(path: string): string {
  return `<!doctype html><title>Fixture ${path}</title><script>
  globalThis.fixtureAtFirstScript = globalThis.fixtureInit?.marker ?? '';
  globalThis.fixtureKeys = []; globalThis.fixturePointer = [];
  sessionStorage.setItem('loads', String(Number(sessionStorage.getItem('loads') ?? 0) + 1));
  addEventListener('keydown', event => fixtureKeys.push('keydown:' + event.key));
  addEventListener('keyup', event => fixtureKeys.push('keyup:' + event.key));
  addEventListener('mousedown', event => fixturePointer.push('down:' + event.clientX + ':' + event.clientY + ':' + event.buttons));
  addEventListener('mouseup', event => fixturePointer.push('up:' + event.clientX + ':' + event.clientY + ':' + event.buttons));
  addEventListener('wheel', event => fixturePointer.push('wheel:' + event.deltaY));
  </script><body data-init=""><input id="input" class="fixture-input" style="position:absolute;left:10px;top:10px"><button id="frame-button" onclick="this.dataset.clicked='yes'">Inside frame</button>${path === '/a' ? '<iframe src="/frame" style="position:absolute;left:400px;top:100px"></iframe>' : ''}<script>document.body.dataset.init = globalThis.fixtureAtFirstScript;</script>`;
}

describe('public native Web primitive contract', () => {
  let server: Server | undefined;
  let project: FixtureProject | undefined;
  let outcome: RunOutcome;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/cookie') { response.end(request.headers.cookie ?? ''); return; }
      if (request.url === '/echo') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        request.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ length: body.length, first: body[0], last: body.at(-1) }));
        });
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(document(request.url ?? '/'));
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ({ outcome, project } = await runProject({ 'tests/native-primitives.e2e.ts': SUITE }, { appUrl: origin, config: { workers: 1 } }));
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  });

  it.each(CASES)('%s', title => {
    const result = resultByTitle(outcome, title);
    expect(result.status, JSON.stringify({ errors: outcome.report.run.errors, attempts: result.attempts })).toBe('passed');
  });
});
