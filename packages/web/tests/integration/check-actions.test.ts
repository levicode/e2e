/**
 * `check` and `uncheck` against a real page, through both kinds of target the
 * engine acts on: a deterministic locator and an exact native ref from an agent
 * observation. A control the app replaces or navigates away from once it is
 * picked took the click, so the action is done; a control the click never
 * reached stays a stale node, one that commits its state after a timer is
 * waited for, and one the click never changes fails at the deadline.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LocatorAction, NodeRef } from 'e2e/engine';
import { nativeDocument } from '../helpers/native-browser.ts';
import { observedNodes } from '../helpers/native-correlation.ts';
import { startNativeFixture, type NativeFixture } from '../helpers/native-fixture.ts';

let fixture: NativeFixture | undefined;
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      request.url === '/'
        ? '<label><input type="radio" name="plan" id="pro" onchange="location.href = \'/next\'">Pro</label>'
        : '<p>Next page</p>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => { fixture = await startNativeFixture('check-actions'); });
afterEach(async () => {
  const current = fixture; fixture = undefined;
  await current?.close();
});

const KINDS = ['locator', 'element'] as const;

type TestTarget = { readonly kind: 'locator'; readonly selector: string } | { readonly kind: 'element'; readonly ref: NodeRef };
const operation = () => ({ ...fixture!.operation(), timeoutMs: 2_000 });

/** Resolve a deterministic selector without replacing a missing protected observation. */
async function locatedRef(selector: string): Promise<NodeRef> {
  const matches = await fixture!.engine.locate!({ kind: 'selector', selector }, operation(), { purpose: 'fixture' });
  expect(matches).toHaveLength(1);
  return matches[0]!.ref;
}

/** The two acquisition paths: resolve a locator at dispatch, or pin an observed native element now. */
async function targetOf(kind: (typeof KINDS)[number], selector: string): Promise<TestTarget> {
  if (kind === 'locator') return { kind, selector };
  const ref = await locatedRef(selector);
  const snapshot = await fixture!.engine.observe!({ ...operation(), origin: 'agent' });
  const [observed] = await fixture!.correlate([ref], observedNodes(snapshot.root), operation());
  expect(observed).not.toBeNull();
  expect(observed).toBeDefined();
  return { kind, ref: observed!.ref };
}

/** Native errors are already classified by the public engine; never reconstruct legacy errors. */
async function perform(target: TestTarget, action: LocatorAction): Promise<Error | undefined> {
  try {
    const ref = target.kind === 'locator' ? await locatedRef(target.selector) : target.ref;
    await fixture!.engine.perform!(ref, action, operation());
    return undefined;
  } catch (cause) {
    if (cause instanceof Error) return cause;
    throw cause;
  }
}

/** Clicks the page saw, counted in the page. */
function clicks(): Promise<number> {
  return fixture!.browser.evaluate(() => (window as unknown as { clicks: number }).clicks);
}

const COUNT_CLICKS = '<script>window.clicks = 0; document.addEventListener("click", () => window.clicks++, true)</script>';

describe.each(KINDS)('through the %s target', (kind) => {
  it('checks a radio the app replaces with its selected view', async () => {
    await nativeDocument(fixture!.browser, `
      <div id="plan"><label><input type="radio" name="plan" id="pro"
        onchange="document.getElementById('plan').innerHTML = '<p>Pro selected</p>'">Pro</label></div>`);
    expect(await perform(await targetOf(kind, '#pro'), { kind: 'check' })).toBeUndefined();
    expect(await fixture!.browser.evaluate(() => document.querySelector('#plan')!.textContent)).toBe('Pro selected');
  });

  it('leaves what replaced the control to the next read, even an unchecked copy', async () => {
    await nativeDocument(fixture!.browser, `
      <div id="terms"><label><input type="checkbox" id="box"
        onchange="document.getElementById('terms').innerHTML = '<label><input type=checkbox id=box>Agree</label>'">Agree</label></div>`);
    expect(await perform(await targetOf(kind, '#box'), { kind: 'check' })).toBeUndefined();
    expect(await fixture!.browser.evaluate(() => document.querySelector<HTMLInputElement>('#box')!.checked)).toBe(false);
  });

  it('checks a radio that navigates on change', async () => {
    await fixture!.browser.goto(`${origin}/`);
    expect(await perform(await targetOf(kind, '#pro'), { kind: 'check' })).toBeUndefined();
    await fixture!.browser.waitForURL(`${origin}/next`);
  });

  it('checks and unchecks a checkbox, and clicks nothing already in the wanted state', async () => {
    await nativeDocument(fixture!.browser, `${COUNT_CLICKS}<label><input type="checkbox" id="box">Notify</label>`);
    const target = await targetOf(kind, '#box');
    expect(await perform(target, { kind: 'check' })).toBeUndefined();
    expect(await perform(target, { kind: 'check' })).toBeUndefined();
    expect(await fixture!.browser.evaluate(() => document.querySelector<HTMLInputElement>('#box')!.checked)).toBe(true);
    expect(await perform(target, { kind: 'uncheck' })).toBeUndefined();
    expect(await fixture!.browser.evaluate(() => document.querySelector<HTMLInputElement>('#box')!.checked)).toBe(false);
    expect(await clicks()).toBe(2);
  });

  it('checks an ARIA checkbox', async () => {
    await nativeDocument(fixture!.browser, `
      <div role="checkbox" id="box" aria-checked="false" tabindex="0"
        onclick="this.setAttribute('aria-checked', String(this.getAttribute('aria-checked') !== 'true'))">Notify</div>`);
    expect(await perform(await targetOf(kind, '#box'), { kind: 'check' })).toBeUndefined();
    expect(await fixture!.browser.evaluate(() => document.querySelector('#box')!.getAttribute('aria-checked'))).toBe('true');
  });

  it('waits for a controlled checkbox that commits its state after a timer', async () => {
    await nativeDocument(fixture!.browser, `
      <label><input type="checkbox" id="box"
        onclick="const box = this; const next = box.checked; event.preventDefault();
          setTimeout(() => { box.checked = next; }, 300)">Notify</label>`);
    expect(await perform(await targetOf(kind, '#box'), { kind: 'check' })).toBeUndefined();
    expect(await fixture!.browser.evaluate(() => document.querySelector<HTMLInputElement>('#box')!.checked)).toBe(true);
  });

  it('waits for a switch whose aria-checked flips after a timer', async () => {
    await nativeDocument(fixture!.browser, `
      <button role="switch" id="toggle" aria-checked="true"
        onclick="setTimeout(() => this.setAttribute('aria-checked', String(this.getAttribute('aria-checked') !== 'true')), 300)">Wi-Fi</button>`);
    expect(await perform(await targetOf(kind, '#toggle'), { kind: 'uncheck' })).toBeUndefined();
    expect(await fixture!.browser.evaluate(() => document.querySelector('#toggle')!.getAttribute('aria-checked'))).toBe('false');
  });

  it('fails a rejected click on a control a later re-render replaces', async () => {
    await nativeDocument(fixture!.browser, `
      <div id="terms"><label><input type="checkbox" id="box" onclick="event.preventDefault();
        setTimeout(() => { document.getElementById('terms').innerHTML = '<label><input type=checkbox id=box>Agree</label>'; }, 300)">Agree</label></div>`);
    expect(await perform(await targetOf(kind, '#box'), { kind: 'check' })).toMatchObject({
      code: 'NOT_ACTIONABLE',
      message: 'check clicked the control but its checked state did not change before the control was replaced',
    });
  });

  it('fails a click that left the control as it was', async () => {
    await nativeDocument(fixture!.browser, '<label><input type="checkbox" id="box" onclick="event.preventDefault()">Locked</label>');
    expect(await perform(await targetOf(kind, '#box'), { kind: 'check' })).toMatchObject({
      code: 'NOT_ACTIONABLE',
      message: 'check clicked the control but its checked state did not change',
    });
  });

  it('refuses to uncheck a radio without clicking it', async () => {
    await nativeDocument(fixture!.browser, `${COUNT_CLICKS}<label><input type="radio" name="plan" id="pro" checked>Pro</label>`);
    expect(await perform(await targetOf(kind, '#pro'), { kind: 'uncheck' })).toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(await clicks()).toBe(0);
  });

  it('refuses a control that cannot be checked', async () => {
    await nativeDocument(fixture!.browser, '<button id="go">Go</button>');
    expect(await perform(await targetOf(kind, '#go'), { kind: 'check' })).toMatchObject({ code: 'NOT_ACTIONABLE' });
  });
});

describe('a control gone before the click', () => {
  it('stays a retryable stale node: nothing was dispatched', async () => {
    await nativeDocument(fixture!.browser, '<label><input type="checkbox" id="box">Notify</label>');
    const target = await targetOf('element', '#box');
    await fixture!.browser.evaluate(() => { document.getElementById('box')!.remove(); return null; });
    expect(await perform(target, { kind: 'check' })).toMatchObject({ code: 'NODE_STALE', retryable: true });
  });
});
