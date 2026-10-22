/**
 * The reader's `hidden` state, which `isVisible()`, `toBeVisible()`, and
 * `toBeHidden()` read, agrees with Playwright's own visibility on the cases
 * a rect count alone gets wrong: a hidden SVG, a zero-size box, closed
 * `<details>` content, an empty `display: contents` element, skipped
 * `content-visibility` content, and an `aria-hidden` node that still paints.
 * The tree walk keeps `aria-hidden` subtrees out while it walks into a
 * `visibility: hidden` one a child shows again.
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser as OracleBrowser, type Page as OraclePage } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { projectionDiagnostics } from '../helpers/projection-diagnostics.ts';
import { nativeDocument } from '../helpers/native-browser.ts';
import { startNativeFixture, type NativeFixture } from '../helpers/native-fixture.ts';

// The source hash binds every diagnostic ordinal below to its exact fixture mapping.
const projection = projectionDiagnostics(readFileSync(new URL(import.meta.url), 'utf8'));

let remote: RemoteChrome | undefined;
let fixture: NativeFixture | undefined;
let oracle: OracleBrowser | undefined;
let oraclePage: OraclePage;

beforeAll(async () => {
  remote = await launchRemoteChrome();
  const endpoint = remote.endpoint;
  fixture = await startNativeFixture('visibility', { connect: { cdpEndpoint: () => endpoint } });
  const marker = randomUUID();
  await fixture.browser.evaluate((value) => {
    (window as unknown as { visibilityWitness: string }).visibilityWitness = value;
    return null;
  }, marker);
  // Temporary migration oracle only. All setup, node reads, and observations use the native engine.
  oracle = await chromium.connectOverCDP(endpoint);
  const matches: OraclePage[] = [];
  for (const page of oracle.contexts().flatMap(context => context.pages())) {
    const value = await page.evaluate(() => (window as unknown as { visibilityWitness?: string }).visibilityWitness);
    if (value === marker) matches.push(page);
  }
  expect(matches).toHaveLength(1);
  oraclePage = matches[0]!;
});

afterAll(async () => {
  const failures: unknown[] = [];
  for (const close of [() => fixture?.close(), () => oracle?.close(), () => remote === undefined ? undefined : closeRemoteChrome(remote)]) {
    try { await close(); } catch (cause) { failures.push(cause); }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Visibility fixture cleanup failed');
});

/** Trusted fixture reads retain hidden elements; they never supply the model tree. */
async function readNode(selector: string): Promise<SemanticNode> {
  const nodes = await fixture!.engine.locate!(
    { kind: 'selector', selector }, fixture!.operation(), { purpose: 'fixture' },
  );
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

/** The reader's hidden state beside the independent oracle for the same element. */
async function hiddenOf(selector: string): Promise<{ reader: boolean; playwright: boolean }> {
  const node = await readNode(selector);
  return { reader: node.states?.hidden ?? false, playwright: await oraclePage.locator(selector).isHidden() };
}

/** Both frame fixtures have a button, so initial about:blank is not mistaken for loaded srcdoc. */
async function waitForFrameDocuments(): Promise<void> {
  await expect.poll(() => fixture!.browser.evaluate(() => {
    const frames = [...document.querySelectorAll('iframe')];
    return frames.length > 0 && frames.every(frame =>
      frame.contentDocument?.readyState === 'complete' && frame.contentDocument.body.querySelector('button') !== null,
    );
  }), { timeout: 10_000 }).toBe(true);
}

const PAGE = `
  <svg id="svg-hidden" width="40" height="40" style="visibility:hidden"><rect width="40" height="40"></rect></svg>
  <svg id="svg-shown" width="40" height="40" role="img" aria-label="Logo"><rect width="40" height="40"></rect></svg>
  <div id="zero" style="width:0;height:0;overflow:hidden"><button>Clipped</button></div>
  <div id="sized" style="width:40px;height:40px;overflow:hidden"><button>Shown</button></div>
  <details id="closed"><summary>More</summary><button id="in-closed">Inside closed</button></details>
  <details id="open" open><summary>More</summary><button id="in-open">Inside open</button></details>
  <details><summary>Outer</summary><details id="nested" open><summary>Inner</summary><button id="in-nested">Nested</button></details></details>
  <div id="contents-empty" style="display:contents"></div>
  <div id="contents-hidden-child" style="display:contents"><span style="display:none">gone</span></div>
  <div id="contents-painted" style="display:contents"><button>Painted</button></div>
  <div id="contents-text" style="display:contents">bare text</div>
  <div id="contents-hidden-element" style="display:contents;visibility:hidden"><span>hidden span</span></div>
  <div id="contents-shown-child" style="display:contents;visibility:hidden"><span style="visibility:visible">shown span</span></div>
  <div id="spinner" aria-hidden="true" style="width:40px;height:40px;background:#888">spinning</div>
  <div aria-hidden="true"><button id="under-aria-hidden">Decorative</button></div>
  <div id="skipping" style="content-visibility:hidden;width:50px;height:50px"><button id="skipped">Skipped</button></div>
  <skip-host id="skipping-host" style="content-visibility:hidden;display:block;width:50px;height:50px"><button id="skipped-slotted">Slotted</button></skip-host>
  <div id="vis-parent" style="visibility:hidden"><button id="vis-child" style="visibility:visible">Shown child</button></div>
  <script>
    customElements.define('skip-host', class extends HTMLElement {
      connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<div><slot></slot></div>'; }
    });
  </script>
`;

describe('visibility agrees with Playwright', () => {
  beforeAll(async () => {
    await nativeDocument(fixture!.browser, PAGE);
  });

  it.each([
    ['an SVG with visibility: hidden', '#svg-hidden', true],
    ['a shown SVG', '#svg-shown', false],
    ['a zero-size box with clipped content', '#zero', true],
    ['the button clipped inside a zero-size box, which keeps a box of its own', '#zero button', false],
    ['a sized box', '#sized', false],
    ['a button inside closed details', '#in-closed', true],
    ['the summary of closed details', '#closed summary', false],
    ['a button inside open details', '#in-open', false],
    ['open details nested in the body of closed details', '#nested', true],
    ['the summary of details nested in closed details', '#nested summary', true],
    ['a button inside open details nested in closed details', '#in-nested', true],
    ['an empty display: contents element', '#contents-empty', true],
    ['a display: contents element whose only child is hidden', '#contents-hidden-child', true],
    ['a display: contents element with a painted child', '#contents-painted', false],
    ['a display: contents element with bare text', '#contents-text', false],
    ['a hidden display: contents element whose child inherits it', '#contents-hidden-element', true],
    ['a hidden display: contents element whose child is visible again', '#contents-shown-child', false],
    ['an aria-hidden spinner that paints', '#spinner', false],
    ['a button under an aria-hidden container', '#under-aria-hidden', false],
    ['a content-visibility: hidden element, which keeps its box', '#skipping', false],
    ['a button content-visibility: hidden skips', '#skipped', true],
    ['a button slotted under a content-visibility: hidden host', '#skipped-slotted', true],
    ['a visibility: hidden parent', '#vis-parent', true],
    ['a child that sets visibility: visible under a hidden parent', '#vis-child', false],
  ])('%s', async (_case, selector, hidden) => {
    expect(await hiddenOf(selector)).toEqual({ reader: hidden, playwright: hidden });
  });
});

describe('visibility where Playwright reads a range box alone', () => {
  it('hides text under a display: contents element whose visibility is hidden, which Playwright calls visible', async () => {
    await nativeDocument(fixture!.browser, '<div id="contents-hidden-text" style="display:contents;visibility:hidden">Invisible text</div>');
    expect(await hiddenOf('#contents-hidden-text')).toEqual({ reader: true, playwright: false });
  });
});

describe('the bounding box', () => {
  /** The reader's rect for one element next to Playwright's `boundingBox()`. */
  async function boxOf(selector: string) {
    const node = await readNode(selector);
    return { reader: node.rect ?? null, playwright: await oraclePage.locator(selector).boundingBox() };
  }

  it.each([
    ['display: none', '<div id="box" style="display:none">gone</div>', null],
    ['under a display: none ancestor', '<div style="display:none"><span id="box">gone</span></div>', null],
    ['an empty display: contents element', '<div id="box" style="display:contents"></div>', null],
    ['display: contents around text', '<div id="box" style="display:contents">text</div>', null],
    ['visibility: hidden, which keeps its box', '<div id="box" style="visibility:hidden;width:30px;height:20px"></div>', { width: 30, height: 20 }],
    ['a zero-size box', '<div id="box" style="width:0;height:0"></div>', { width: 0, height: 0 }],
  ])('%s', async (_case, html, size) => {
    await nativeDocument(fixture!.browser, `<body style="margin:0">${html}</body>`);
    const { reader, playwright } = await boxOf('#box');
    expect(reader).toEqual(playwright);
    expect(reader === null ? null : { width: reader.width, height: reader.height }).toEqual(size);
  });
});

function flatten(node: SemanticNode, out: SemanticNode[] = []): SemanticNode[] {
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

/** Model-visible nodes come only from the protected public observation, frames included. */
async function captureTree(): Promise<SemanticNode[]> {
  const { root } = await fixture!.engine.observe!({ ...fixture!.operation(), origin: 'agent' });
  return flatten(root);
}

describe('the tree walk through a box with no size', () => {
  it('lists the fixed controls under a zero-height page and wrapper, and neither the wrapper nor the root as hidden', async () => {
    await nativeDocument(fixture!.browser, `
      <nav aria-label="Floating" data-testid="wrapper">
        <button style="position:fixed;left:0;top:0;width:100px;height:30px">Reset</button>
      </nav>
    `);
    const nodes = await captureTree();
    expect(nodes[0]!.states?.hidden).toBeUndefined();
    expect(nodes.find((node) => node.role === 'button')?.name).toBe('Reset');
    expect(nodes.find((node) => node.testId === 'wrapper')).toBeUndefined();
  });

  it('lists neither the document of a frame with no box nor the options of a select with none', async () => {
    await nativeDocument(fixture!.browser, `
      <iframe style="width:0;height:0;border:0" srcdoc="<button>Pay</button>"></iframe>
      <iframe style="width:200px;height:100px" srcdoc="<button>Shown pay</button>"></iframe>
      <select aria-label="Folded" style="width:0;height:0;padding:0;border:0"><option>plain</option><option>warm</option></select>
      <select aria-label="Shown"><option>cool</option></select>
    `);
    await waitForFrameDocuments();
    const nodes = await captureTree();
    const buttons = nodes.filter((node) => node.role === 'button').map((node) => node.name);
    const options = nodes.filter((node) => node.role === 'option').map((node) => node.name);
    // Fixed fixture order, independent of the observed order or page-provided IDs.
    const diagnostic = projection('select-visibility', {
      observedCount: nodes.filter(node => ['button', 'option', 'combobox'].includes(node.role ?? '')).length,
      expectedCount: 3,
    }, [
      ['button', 'Pay'], ['button', 'Shown pay'],
      ['option', 'plain'], ['option', 'warm'], ['option', 'cool'],
      ['combobox', 'Folded'], ['combobox', 'Shown'],
    ].map(([role, name], ordinal) => {
      const matches = nodes.filter(node => node.name === name);
      return { ordinal, missing: matches.length === 0, presentCount: matches.length,
        roleMatches: matches.length === 1 && matches[0]!.role === role };
    }));
    expect(buttons).toEqual(['Shown pay']);
    expect(options, diagnostic).toEqual(['cool']);
    expect(nodes.filter((node) => node.role === 'combobox').map((node) => node.name), diagnostic).toEqual(['Shown']);
  });
});

describe('a frame\'s document', () => {
  it('places its boxes past the frame\'s border and padding, where Playwright measures them', async () => {
    await nativeDocument(fixture!.browser, '<iframe style="margin:13px;border:7px solid;padding:5px;width:200px;height:100px" srcdoc="<button>Framed</button>"></iframe>');
    await waitForFrameDocuments();
    const node = (await captureTree()).find((candidate) => candidate.name === 'Framed')!;
    const expected = (await oraclePage.frameLocator('iframe').getByRole('button').boundingBox())!;
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(node.rect![key]).toBeCloseTo(expected[key], 3);
  });
});

describe('an inert subtree', () => {
  it('leaves the tree, as Chrome drops it, while Playwright still calls it visible', async () => {
    await nativeDocument(fixture!.browser, `
      <main inert><h2>Behind the drawer</h2><button id="inert-save">Save</button></main>
      <button>Close drawer</button>
    `);
    const names = (await captureTree()).map((node) => node.name).filter((name) => name !== undefined);
    expect(names).toContain('Close drawer');
    expect(names).not.toContain('Save');
    expect(names).not.toContain('Behind the drawer');
    expect(await hiddenOf('#inert-save')).toEqual({ reader: false, playwright: false });
  });

  it('lists nothing under an inert document root, and nothing slotted into an inert slot of a closed root', async () => {
    await nativeDocument(fixture!.browser, '<!doctype html><html inert><body><button>Whole page</button></body></html>');
    expect((await captureTree()).filter((node) => node.role === 'button')).toEqual([]);
    await nativeDocument(fixture!.browser, `
      <inert-slot><button>Slotted</button></inert-slot>
      <button>Outside</button>
      <script>
        customElements.define('inert-slot', class extends HTMLElement {
          connectedCallback() { this.attachShadow({ mode: 'closed' }).innerHTML = '<div inert><slot></slot></div>'; }
        });
      </script>
    `);
    const buttons = (await captureTree()).filter((node) => node.role === 'button').map((node) => node.name);
    expect(buttons).toEqual(['Outside']);
  });
});

describe('the tree walk through hidden content', () => {
  it('walks into a visibility: hidden subtree for a child that shows again, and stops at aria-hidden and skipped content', async () => {
    await nativeDocument(fixture!.browser, `
      <div style="visibility:hidden"><button>Hidden parent</button><div><button style="visibility:visible">Shown child</button></div></div>
      <div aria-hidden="true"><button>Decorative</button></div>
      <div style="content-visibility:hidden;width:50px;height:50px" data-testid="skipping">Skipped text<button>Skipped</button></div>
      <div style="display:contents;visibility:hidden"><button>Contents hidden</button></div>
    `);
    const nodes = await captureTree();
    const buttons = nodes.filter((node) => node.role === 'button');
    expect(buttons.map((node) => [node.name, node.states?.hidden])).toEqual([['Shown child', undefined]]);
    const skipping = nodes.find((node) => node.testId === 'skipping');
    expect(skipping?.states?.hidden).toBeUndefined();
    // The container keeps its box and paints none of its text, which innerText reads empty too.
    expect(skipping?.text).toBe('');
    expect(await fixture!.browser.evaluate(() => document.querySelector<HTMLElement>('[data-testid=skipping]')!.innerText)).toBe('');
  });
});
