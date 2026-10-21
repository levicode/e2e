/**
 * A `frameLocator` chain resolves each frame inside the one before it: the
 * inner selector is looked up in the outer frame's document, never in the
 * page. The page's DOM geometry supplies an independent box oracle. A
 * located node's box is in the top-level viewport, as the contract asks.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocatorExpression } from 'e2e/engine';
import { web, type Browser } from '../../src/index.ts';
import { nativeBrowser, nativeDocument } from '../helpers/native-browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** Escapes HTML for a double-quoted attribute value, so a document can carry a nested `srcdoc`. */
function attribute(html: string): string {
  return html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Wraps `source` in `frame` scopes, outermost first, as a `browser.frameLocator` chain does. */
function withinFrames(selectors: readonly string[], source: LocatorExpression): LocatorExpression {
  return selectors.reduceRight<LocatorExpression>(
    (inner, selector) => ({ kind: 'frame', selector, source: inner }),
    source,
  );
}

const TWIN_FRAME = '<iframe class="twin" title="twin" srcdoc="<p>twin</p>"></iframe>';
const DEEP_DOCUMENT = '<button>Deep button</button>';
const INNER_DOCUMENT =
  '<button onclick="this.textContent = \'Inner clicked\'">Inner button</button>' +
  `<iframe id="deep" title="deep" srcdoc="${attribute(DEEP_DOCUMENT)}"></iframe>`;
const OUTER_DOCUMENT =
  `<h2>Outer</h2><iframe id="inner" title="inner" style="border:7px solid;padding:5px" srcdoc="${attribute(INNER_DOCUMENT)}"></iframe>` +
  TWIN_FRAME +
  TWIN_FRAME;
const HOST_DOCUMENT =
  '<h1>Host</h1><iframe id="aside" title="aside" srcdoc="<p>aside</p>"></iframe>' +
  TWIN_FRAME +
  `<iframe id="outer" title="outer" srcdoc="${attribute(OUTER_DOCUMENT)}"></iframe>`;

/** A role query for the one button named `name`. */
function buttonNamed(name: string): LocatorExpression {
  return {
    kind: 'query',
    query: {
      kind: 'role',
      value: { kind: 'string', value: 'button', exact: true },
      name: { kind: 'string', value: name, exact: true },
    },
  };
}

const INNER_BUTTON = buttonNamed('Inner button');
const DEEP_BUTTON = buttonNamed('Deep button');

describe('nested frame locators', () => {
  const engine = web({});
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-nested-frames-'));
  const signal = new AbortController().signal;
  const operation = { signal, timeoutMs: 5_000, runId: 'frames', attemptId: 'attempt', origin: 'test' as const };
  const cleanup = { signal, timeoutMs: 30_000 };
  let browser: Browser;

  beforeAll(async () => {
    await engine.init!({ runId: 'frames', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: process.env, headed: false, workerSlot: 0, signal, log: () => undefined });
    await engine.startAttempt!({ attemptId: 'attempt', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!('about:blank', operation);
    browser = nativeBrowser(engine, () => operation);
    await nativeDocument(browser, HOST_DOCUMENT);
    await expect.poll(() => browser.evaluate(() => {
      const outer = document.querySelector<HTMLIFrameElement>('#outer')?.contentDocument;
      const inner = outer?.querySelector<HTMLIFrameElement>('#inner')?.contentDocument;
      const deep = inner?.querySelector<HTMLIFrameElement>('#deep')?.contentDocument;
      return deep?.querySelector('button')?.textContent ?? null;
    })).toBe('Deep button');
  });

  afterAll(async () => {
    await engine.endAttempt!(cleanup);
    await engine.dispose!(cleanup);
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('resolves a two-level chain and taps inside the innermost frame', async () => {
    const matches = await engine.locate!(withinFrames(['#outer', '#inner'], INNER_BUTTON), operation);
    expect(matches.map((node) => node.name)).toEqual(['Inner button']);
    await engine.perform!(matches[0]!.ref, { kind: 'tap' }, operation);
    expect(await browser.evaluate(() => document.querySelector<HTMLIFrameElement>('#outer')!.contentDocument!
      .querySelector<HTMLIFrameElement>('#inner')!.contentDocument!.querySelector('button')!.textContent)).toBe('Inner clicked');
  });

  it('reports a located node\'s box in the top-level viewport, past each frame\'s border and padding', async () => {
    // The inner document's one button, whatever an earlier test renamed it to.
    const button: LocatorExpression = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } };
    const [node] = await engine.locate!(withinFrames(['#outer', '#inner'], button), operation);
    // DOM rectangles and computed frame insets are independent of the native query projection.
    const expected = await browser.evaluate(() => {
      const outer = document.querySelector<HTMLIFrameElement>('#outer')!;
      const inner = outer.contentDocument!.querySelector<HTMLIFrameElement>('#inner')!;
      const element = inner.contentDocument!.querySelector('button')!;
      const bounds = element.getBoundingClientRect();
      const inset = (frame: HTMLIFrameElement) => {
        const rect = frame.getBoundingClientRect();
        const style = frame.ownerDocument.defaultView!.getComputedStyle(frame);
        return { x: rect.x + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
          y: rect.y + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop) };
      };
      const outside = inset(outer);
      const inside = inset(inner);
      return { x: outside.x + inside.x + bounds.x, y: outside.y + inside.y + bounds.y, width: bounds.width, height: bounds.height };
    });
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(node!.rect![key]).toBeCloseTo(expected[key], 3);
  });

  it('resolves a three-level chain, counting the last frame inside the second', async () => {
    const matches = await engine.locate!(withinFrames(['#outer', '#inner', '#deep'], DEEP_BUTTON), operation);
    expect(matches.map((node) => node.name)).toEqual(['Deep button']);
    await expect(engine.locate!(withinFrames(['#outer', '#deep'], DEEP_BUTTON), operation)).rejects.toMatchObject({
      code: 'FRAME_NOT_FOUND',
      message: 'no frame matches #deep',
    });
  });

  it('names the inner selector when the outer frame holds no such frame, even though the page does', async () => {
    await expect(engine.locate!(withinFrames(['#outer', '#aside'], INNER_BUTTON), operation)).rejects.toMatchObject({
      code: 'FRAME_NOT_FOUND',
      message: 'no frame matches #aside',
      retryable: true,
    });
  });

  it('reports two matching frames inside the outer document as ambiguous, though the page holds one', async () => {
    expect(await browser.evaluate(() => document.querySelectorAll('.twin').length)).toBe(1);
    await expect(engine.locate!(withinFrames(['#outer', '.twin'], INNER_BUTTON), operation)).rejects.toMatchObject({
      code: 'FRAME_AMBIGUOUS',
      message: '2 frames match .twin',
      retryable: false,
    });
  });
});
