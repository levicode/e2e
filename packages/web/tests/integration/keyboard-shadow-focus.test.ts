/** Focused typing validates the actual control inside open and closed shadow roots. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startNativeFixture, type NativeFixture } from '../helpers/native-fixture.ts';

let fixture: NativeFixture | undefined;
const operation = () => ({ ...fixture!.operation(), timeoutMs: 5_000 });

beforeAll(async () => { fixture = await startNativeFixture('keyboard-shadow'); });
beforeEach(async () => { await fixture!.browser.goto('about:blank'); });
afterAll(async () => { await fixture?.close(); });

/** Create nested real shadow roots and record only events delivered to their focused leaf. */
async function focusShadow(shadowMode: ShadowRootMode, markup: string): Promise<void> {
  await fixture!.browser.evaluate(({ mode, html }) => {
    document.body.innerHTML = '<div id="outer"></div>';
    const outer = document.getElementById('outer')!.attachShadow({ mode });
    outer.innerHTML = '<div id="inner"></div>';
    const inner = outer.getElementById('inner')!.attachShadow({ mode });
    inner.innerHTML = html;
    const field = inner.querySelector<HTMLElement>('input,button,[tabindex]')!;
    field.focus();
    field.addEventListener('keydown', () => { document.body.dataset.keys = String(Number(document.body.dataset.keys ?? 0) + 1); });
    field.addEventListener('input', () => { document.body.dataset.value = (field as HTMLInputElement).value; });
    return null;
  }, { mode: shadowMode, html: markup });
}

describe.each(['open', 'closed'] as const)('%s shadow focus', (mode) => {
  it.each(['<button>Stop</button>', '<input readonly value="kept">'])('refuses a noneditable focused leaf: %s', async (html) => {
    await focusShadow(mode, html);
    await expect(fixture!.engine.keyboard!.type('lost', { replace: true }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(await fixture!.browser.evaluate(() => document.body.getAttribute('data-keys'))).toBeNull();
    expect(await fixture!.browser.evaluate(() => document.body.getAttribute('data-value'))).toBeNull();
  });

  it('types into a nested editable leaf', async () => {
    await focusShadow(mode, '<input value="before">');
    await fixture!.engine.keyboard!.type('after', { replace: true }, operation());
    expect(await fixture!.browser.evaluate(() => document.body.getAttribute('data-value'))).toBe('after');
  });

  it('retains focused custom widgets that opt into keystrokes', async () => {
    await focusShadow(mode, '<div tabindex="0">Custom widget</div>');
    await fixture!.engine.keyboard!.type('a', { replace: false }, operation());
    expect(await fixture!.browser.evaluate(() => document.body.getAttribute('data-keys'))).toBe('1');
  });
});

it('does not mistake the iframe host for an editable control when its button has focus', async () => {
  await fixture!.browser.evaluate(async () => {
    const frame = document.createElement('iframe');
    const loaded = new Promise<void>((resolve) => { frame.addEventListener('load', () => resolve(), { once: true }); });
    frame.srcdoc = '<button id="stop">Stop</button>';
    document.body.append(frame);
    await loaded;
    frame.contentDocument!.getElementById('stop')!.focus();
    return null;
  });
  await expect(fixture!.engine.keyboard!.type('lost', { replace: false }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
});
