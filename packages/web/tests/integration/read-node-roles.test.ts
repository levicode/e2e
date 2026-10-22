/** The real reader maps explicit ARIA roles, implicit HTML semantics, and contenteditable hosts onto the vocabulary. */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { projectionDiagnostics } from '../helpers/projection-diagnostics.ts';
import { nativeDocument } from '../helpers/native-browser.ts';
import { startNativeOracle, type NativeOracle } from '../helpers/native-oracle.ts';
import { beginSyntheticCase, type SyntheticOutcome } from '../helpers/synthetic-evidence.ts';
import { recordCanvasOracle } from '../helpers/canvas-oracle.ts';
import { pairCanvasNative, type CanvasNativePair } from '../helpers/canvas-oracle-provenance.ts';

// The source hash binds every diagnostic ordinal below to its exact fixture mapping.
const projection = projectionDiagnostics(readFileSync(new URL(import.meta.url), 'utf8'));

let fixture: NativeOracle | undefined;

beforeAll(async () => { fixture = await startNativeOracle('read-node-roles'); });
afterAll(async () => { await fixture?.close(); });

/** One observation of the page through the same capture the engine uses. */
async function capture() {
  const snapshot = await fixture!.engine.observe!({ ...fixture!.operation(), origin: 'agent' });
  return { tree: snapshot.root };
}

function flatten(node: SemanticNode, out: SemanticNode[] = []): SemanticNode[] {
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

/** Roles by test id, for a page whose every element of interest carries one. */
async function rolesByTestId(): Promise<Map<string, SemanticNode>> {
  const { tree } = await capture();
  return new Map(flatten(tree).filter((node) => node.testId !== undefined).map((node) => [node.testId!, node]));
}

/** Only static fixture expectations define ordinals; observed IDs and strings never leave this function. */
function nodeProjection(
  group: Parameters<typeof projection>[0],
  nodes: ReadonlyMap<string, SemanticNode>,
  expected: readonly { testId: string; included?: boolean; role?: string | undefined; name?: string | undefined; value?: string | undefined }[],
  exactCount = true,
): string {
  return projection(group, {
    observedCount: nodes.size,
    ...(exactCount ? { expectedCount: expected.filter(item => item.included !== false).length } : {}),
  }, expected.map((item, ordinal) => {
    const node = nodes.get(item.testId);
    return {
      ordinal, missing: node === undefined,
      ...(Object.hasOwn(item, 'role') ? { roleMatches: node?.role === item.role } : {}),
      ...(Object.hasOwn(item, 'name') ? { nameMatches: node?.name === item.name } : {}),
      ...(Object.hasOwn(item, 'value') ? { valueMatches: node?.value === item.value } : {}),
      nameMissing: node?.name === undefined, valueMissing: node?.value === undefined,
      ...(typeof node?.name === 'string' ? { nameLength: node.name.length } : {}),
      ...(typeof node?.value === 'string' ? { valueLength: node.value.length } : {}),
    };
  }));
}

/** Fill the same exact element whose native identity the reader returned. */
async function fill(testId: string, value: string): Promise<void> {
  const nodes = await fixture!.engine.locate!({ kind: 'selector', selector: `[data-testid="${testId}"]` }, fixture!.operation());
  expect(nodes).toHaveLength(1);
  await fixture!.engine.perform!(nodes[0]!.ref, { kind: 'fill', value, sensitive: false }, fixture!.operation());
}

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * An empty block lays out to no height and is hidden, to the reader as to
 * Playwright; the role fixtures below are about roles, so their empty
 * elements get a box.
 */
const EMPTY_BOXES = '[data-testid]:empty { min-width: 1px; min-height: 1px }';

describe('role mapping', () => {
  it('uses the first recognized role token and falls back to native semantics', async () => {
    await nativeDocument(fixture!.browser, `
      <button role="unknown button" data-testid="fallback">Save</button>
      <button role="unknown widget" data-testid="native">Submit</button>
      <a href="/next" role="unknown button link" data-testid="first">Continue</a>
      <div role="unknown img" aria-label="Chart" data-testid="image" style="width:10px;height:10px"></div>
      <div role="unknown\u00a0button" aria-label="Not a role" data-testid="nbsp" style="width:10px;height:10px"></div>
      <table role="unknown grid"><tr><td data-testid="grid-cell">Cell</td></tr></table>
    `);
    const nodes = await rolesByTestId();
    expect(nodes.get('fallback')).toMatchObject({ role: 'button', name: 'Save' });
    expect(nodes.get('native')).toMatchObject({ role: 'button', name: 'Submit' });
    expect(nodes.get('first')).toMatchObject({ role: 'button', name: 'Continue' });
    expect(nodes.get('image')).toMatchObject({ role: 'image', name: 'Chart' });
    expect(nodes.get('grid-cell')).toMatchObject({ role: 'gridcell', name: 'Cell' });
    expect(nodes.has('nbsp')).toBe(true);
    expect(nodes.get('nbsp')?.role).toBeUndefined();
    expect(await fixture!.oracle.getByRole('button').allTextContents()).toEqual(['Save', 'Submit', 'Continue']);
    expect(await fixture!.oracle.getByRole('gridcell').allTextContents()).toEqual(['Cell']);
  });

  it.each(['open', 'closed'] as const)('scopes nested shadow landmarks to their outer article (%s)', async (mode) => {
    await nativeDocument(fixture!.browser, '<article><div id="card"></div></article><div id="page"></div>');
    await fixture!.browser.evaluate((shadowMode) => {
      const card = document.querySelector('#card')!.attachShadow({ mode: shadowMode });
      card.innerHTML = '<div id="nested"></div>';
      card.querySelector('#nested')!.attachShadow({ mode: shadowMode }).innerHTML =
        '<header aria-label="Card" data-testid="card-header">Card</header><footer aria-label="Card footer" data-testid="card-footer">Foot</footer>';
      document.querySelector('#page')!.attachShadow({ mode: shadowMode }).innerHTML =
        '<header aria-label="Page" data-testid="page-header">Page</header><footer aria-label="Page footer" data-testid="page-footer">Legal</footer>';
      return null;
    }, mode);
    const nodes = await rolesByTestId();
    expect(nodes.get('card-header')).toBeDefined();
    expect(nodes.get('card-footer')).toBeDefined();
    expect(nodes.get('card-header')?.role).toBeUndefined();
    expect(nodes.get('card-footer')?.role).toBeUndefined();
    expect(nodes.get('page-header')?.role).toBe('banner');
    expect(nodes.get('page-footer')?.role).toBe('contentinfo');
    if (mode === 'open') {
      expect(await fixture!.oracle.getByRole('banner').count()).toBe(1);
      expect(await fixture!.oracle.getByRole('contentinfo').count()).toBe(1);
    }
  });

  it('reports ARIA img as image, alongside the img element', async () => {
    await nativeDocument(fixture!.browser, `
      <style>${EMPTY_BOXES}</style>
      <img src="${PIXEL}" alt="Logo" data-testid="picture">
      <div role="img" aria-label="Chart" data-testid="drawn"></div>
      <svg role="img" aria-label="Icon" width="10" height="10" data-testid="vector"></svg>
      <img src="${PIXEL}" alt="">
    `);
    const nodes = await rolesByTestId();
    expect(nodes.get('picture')).toMatchObject({ role: 'image', name: 'Logo' });
    expect(nodes.get('drawn')).toMatchObject({ role: 'image', name: 'Chart' });
    expect(nodes.get('vector')).toMatchObject({ role: 'image', name: 'Icon' });
    // An empty alt marks decoration: the element is not an image and, with nothing else to say, not a node.
    const { tree } = await capture();
    expect(flatten(tree).filter((node) => node.role === 'image').map((node) => node.name)).toEqual(['Logo', 'Chart', 'Icon']);
    expect(flatten(tree).some((node) => node.role === 'presentation')).toBe(false);
  });

  it('infers row headers from data-cell neighbors and respects explicit scopes', async () => {
    await nativeDocument(fixture!.browser, `
      <table><tr><th data-testid="row">Item</th><td>Value</td></tr></table>
      <table><tr><td>Value</td><th data-testid="last-row">Item</th></tr></table>
      <table><tr><th data-testid="column">Item</th><th>Value</th></tr></table>
      <table><tr><th scope="col" data-testid="scoped-column">Item</th><td>Value</td></tr></table>
      <table><tr><th scope="row" data-testid="scoped-row">Item</th><th>Value</th></tr></table>
      <table><tr><th data-testid="empty-data">Item</th><td></td></tr></table>
      <table><tr><th data-testid="child-data">Item</th><td><input aria-label="Value"></td></tr></table>
      <table><tr><th data-testid="single">Item</th></tr></table>
      <table><tr><th data-testid="single-column">Item</th></tr><tr><td>Value</td></tr></table>
    `);
    const nodes = await rolesByTestId();
    const expected = {
      row: 'rowheader', 'last-row': 'rowheader', column: 'columnheader',
      'scoped-column': 'columnheader', 'scoped-row': 'rowheader', 'empty-data': 'columnheader',
      'child-data': 'rowheader', single: undefined, 'single-column': 'columnheader',
    };
    expect(Object.fromEntries([...nodes].map(([id, node]) => [id, node.role])),
      nodeProjection('headers', nodes, Object.entries(expected).map(([testId, role]) => ({ testId, role })))).toEqual(expected);
    expect(await fixture!.oracle.getByRole('rowheader').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid'))))
      .toEqual(['row', 'last-row', 'scoped-row', 'child-data']);
  });

  it('reports an inline svg as an image, named by its title child, as Playwright does', async () => {
    await nativeDocument(fixture!.browser, `
      <input aria-label="Message">
      <div class="send-btn"><svg viewBox="0 0 24 24" width="24" height="24" data-testid="bare"><path d="M2 3 L22 12 L2 21 Z"/></svg></div>
      <svg width="10" height="10" data-testid="titled"><title>Close</title></svg>
      <svg width="10" height="10" aria-label="Labelled" data-testid="labelled"><title>Ignored</title></svg>
      <svg width="10" height="10" aria-hidden="true" data-testid="decorative"></svg>
      <svg width="10" height="10" role="presentation"><title>Decor</title></svg>
      <a href="/home" data-testid="home"><svg width="10" height="10" role="none"><title>Home</title></svg></a>
    `);
    const nodes = await rolesByTestId();
    expect(nodes.get('bare')).toMatchObject({ role: 'image' });
    expect(nodes.get('bare')?.name).toBeUndefined();
    expect(nodes.get('titled')).toMatchObject({ role: 'image', name: 'Close' });
    expect(nodes.get('labelled')).toMatchObject({ role: 'image', name: 'Labelled' });
    expect(nodes.has('decorative')).toBe(false);
    expect(nodes.get('home'), nodeProjection('inline-svg', nodes, [
      { testId: 'bare', role: 'image', name: undefined },
      { testId: 'titled', role: 'image', name: 'Close' },
      { testId: 'labelled', role: 'image', name: 'Labelled' },
      { testId: 'decorative', included: false },
      { testId: 'home', role: 'link', name: 'Home' },
    ])).toMatchObject({ role: 'link', name: 'Home' });
    const { tree } = await capture();
    expect(flatten(tree).filter((node) => node.role === 'presentation' || node.role === 'none')).toEqual([]);
    expect(await fixture!.oracle.getByRole('img').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid'))))
      .toEqual(['bare', 'titled', 'labelled']);
    expect(await fixture!.oracle.getByRole('img', { name: 'Close', exact: true }).getAttribute('data-testid')).toBe('titled');
  });

  it('passes the composite widget roles through from role attributes and names their items from content', async () => {
    await nativeDocument(fixture!.browser, `
      <style>${EMPTY_BOXES}</style>
      <div role="tablist" aria-label="Filter" data-testid="tablist">
        <button role="tab" aria-selected="true" data-testid="tab">All</button>
      </div>
      <div role="tabpanel" aria-label="All items" data-testid="tabpanel"></div>
      <div role="toolbar" aria-label="Formatting" data-testid="toolbar">
        <button aria-pressed="true">Bold</button>
      </div>
      <div role="menubar" data-testid="menubar">
        <div role="menuitem" data-testid="menuitem">File</div>
      </div>
      <div role="menu" aria-label="View" data-testid="menu">
        <div role="menuitemcheckbox" aria-checked="true" data-testid="check">Show grid</div>
        <div role="menuitemradio" aria-checked="false" data-testid="radio">Compact</div>
      </div>
      <div role="tree" aria-label="Files" data-testid="tree">
        <div role="treeitem" aria-expanded="false" data-testid="treeitem">src</div>
      </div>
      <div role="grid" aria-label="Sheet" data-testid="grid">
        <div role="rowgroup" data-testid="rowgroup">
          <div role="row" data-testid="row">
            <div role="rowheader" data-testid="rowheader">1</div>
            <div role="gridcell" data-testid="gridcell">A1</div>
          </div>
        </div>
      </div>
      <div role="radiogroup" aria-label="Plan" data-testid="radiogroup"></div>
      <div role="tooltip" data-testid="tooltip">Saves the draft</div>
      <div role="separator" data-testid="separator"></div>
      <div role="progressbar" aria-label="Upload" aria-valuenow="40" data-testid="progressbar"></div>
      <div role="spinbutton" aria-label="Quantity" aria-valuenow="2" data-testid="spinbutton"></div>
      <div role="meter" aria-label="Disk" aria-valuenow="50" data-testid="meter"></div>
    `);
    const nodes = await rolesByTestId();
    const roles = Object.fromEntries([...nodes].map(([testId, node]) => [testId, node.role]));
    expect(roles).toEqual({
      tablist: 'tablist',
      tab: 'tab',
      tabpanel: 'tabpanel',
      toolbar: 'toolbar',
      menubar: 'menubar',
      menuitem: 'menuitem',
      menu: 'menu',
      check: 'menuitemcheckbox',
      radio: 'menuitemradio',
      tree: 'tree',
      treeitem: 'treeitem',
      grid: 'grid',
      rowgroup: 'rowgroup',
      row: 'row',
      rowheader: 'rowheader',
      gridcell: 'gridcell',
      radiogroup: 'radiogroup',
      tooltip: 'tooltip',
      separator: 'separator',
      progressbar: 'progressbar',
      spinbutton: 'spinbutton',
      meter: 'meter',
    });
    expect(nodes.get('check')).toMatchObject({ name: 'Show grid', states: { checked: true } });
    expect(nodes.get('radio')).toMatchObject({ name: 'Compact', states: { checked: false } });
    expect(nodes.get('treeitem')).toMatchObject({ name: 'src', states: { expanded: false } });
    expect(nodes.get('tooltip')?.name).toBe('Saves the draft');
  });

  it('derives the vocabulary roles from HTML semantics the way HTML-AAM does', async () => {
    await nativeDocument(fixture!.browser, `
      <style>${EMPTY_BOXES}</style>
      <header data-testid="page-header">Site</header>
      <nav data-testid="nav"></nav>
      <main data-testid="main">
        <article data-testid="article"><header data-testid="article-header">Post</header></article>
        <section aria-label="Pricing" data-testid="named-section"></section>
        <section data-testid="plain-section">Unnamed</section>
        <form aria-label="Sign in" data-testid="named-form"><input aria-label="User"></form>
        <form data-testid="plain-form"><input aria-label="Query"></form>
        <fieldset data-testid="fieldset"><legend>Notifications</legend></fieldset>
        <details data-testid="details"><summary>More</summary>Body</details>
        <figure data-testid="figure"><figcaption>Figure one</figcaption></figure>
        <hr data-testid="rule">
        <menu data-testid="menu"><li data-testid="menu-item">Cut</li></menu>
        <progress value="3" max="10" aria-label="Upload" data-testid="progress"></progress>
        <meter value="0.5" aria-label="Disk" data-testid="meter"></meter>
        <input type="number" aria-label="Quantity" value="2" data-testid="number">
        <table data-testid="table">
          <caption>Scores</caption>
          <thead data-testid="thead"><tr><th data-testid="col">Name</th></tr></thead>
          <tbody data-testid="tbody"><tr><th scope="row" data-testid="rowhead">Ada</th><td data-testid="cell">1</td></tr></tbody>
        </table>
        <address data-testid="address">Somewhere</address>
      </main>
      <aside data-testid="aside">Related</aside>
      <footer data-testid="page-footer">Legal</footer>
    `);
    const nodes = await rolesByTestId();
    const roles = Object.fromEntries([...nodes].map(([testId, node]) => [testId, node.role]));
    const expected = {
      'page-header': 'banner',
      nav: 'navigation',
      main: 'main',
      article: 'article',
      'article-header': undefined,
      'named-section': 'region',
      'plain-section': undefined,
      'named-form': 'form',
      'plain-form': undefined,
      fieldset: 'group',
      details: 'group',
      figure: 'figure',
      rule: 'separator',
      menu: 'list',
      'menu-item': 'listitem',
      progress: 'progressbar',
      meter: 'meter',
      number: 'spinbutton',
      table: 'table',
      thead: 'rowgroup',
      col: 'columnheader',
      tbody: 'rowgroup',
      rowhead: 'rowheader',
      cell: 'cell',
      address: 'group',
      aside: 'complementary',
      'page-footer': 'contentinfo',
    };
    expect(roles, nodeProjection('vocabulary', nodes, Object.entries(expected).map(([testId, role]) => ({ testId, role })))).toEqual(expected);
    expect(nodes.get('number')).toMatchObject({ name: 'Quantity', value: '2' });
    expect(nodes.get('progress')?.name).toBe('Upload');
    // A legend, a figcaption, and a caption name their parent, so the node the reader
    // reports carries the name the role selector matched on.
    expect(nodes.get('fieldset')?.name).toBe('Notifications');
    expect(nodes.get('figure')?.name).toBe('Figure one');
    expect(nodes.get('table')?.name).toBe('Scores');
    expect(nodes.get('details')?.name).toBeUndefined();
  });
});

describe('contenteditable editing hosts', () => {
  it('reports the host as a textbox named by aria-label, aria-placeholder, or the editor placeholder, with its document as the value', async () => {
    await nativeDocument(fixture!.browser, `
      <div contenteditable aria-label="Notes" data-testid="labelled"><p data-testid="block">Hello</p><p>World</p></div>
      <div contenteditable aria-placeholder="Write here" data-testid="aria-placeholder"><p><br></p></div>
      <div contenteditable class="tiptap ProseMirror" tabindex="0" data-testid="tiptap">
        <p class="is-empty is-editor-empty" data-placeholder="Write something"><br></p>
      </div>
      <div contenteditable class="ql-editor ql-blank" data-placeholder="Compose a message" data-testid="quill"><p><br></p></div>
      <div contenteditable role="textbox" aria-label="Message" data-testid="explicit"><p>Hi</p></div>
      <div contenteditable data-testid="bare"><p>Bare</p></div>
      <div contenteditable aria-label="Outer" data-testid="outer">
        <p>Text</p>
        <span contenteditable="false" data-testid="island">Chip<div contenteditable aria-label="Nested" data-testid="nested"><p>Inner</p></div></span>
      </div>
    `);
    const nodes = await rolesByTestId();
    const diagnostic = nodeProjection('editing-hosts', nodes, [
      { testId: 'labelled', role: 'textbox', name: 'Notes', value: 'Hello\n\nWorld' },
      { testId: 'block', role: undefined },
      { testId: 'aria-placeholder', role: 'textbox', name: 'Write here', value: '' },
      { testId: 'tiptap', role: 'textbox', name: 'Write something', value: '' },
      { testId: 'quill', role: 'textbox', name: 'Compose a message', value: '' },
      { testId: 'explicit', role: 'textbox', name: 'Message', value: 'Hi' },
      { testId: 'bare', role: 'textbox', name: undefined, value: 'Bare' },
      { testId: 'outer', role: 'textbox', name: 'Outer' },
      { testId: 'island', role: undefined },
      { testId: 'nested', role: 'textbox', name: 'Nested', value: 'Inner' },
    ], false); // The block/island role assertions allow absence, so there is no exact node-count expectation.
    expect(nodes.get('labelled'), diagnostic).toMatchObject({ role: 'textbox', name: 'Notes', value: 'Hello\n\nWorld' });
    // Only the host is the control: a block inside it is content, not a second textbox.
    expect(nodes.get('block')?.role, diagnostic).toBeUndefined();
    expect(nodes.get('aria-placeholder'), diagnostic).toMatchObject({ role: 'textbox', name: 'Write here', value: '' });
    expect(nodes.get('tiptap'), diagnostic).toMatchObject({ role: 'textbox', name: 'Write something' });
    expect(nodes.get('quill'), diagnostic).toMatchObject({ role: 'textbox', name: 'Compose a message' });
    expect(nodes.get('explicit'), diagnostic).toMatchObject({ role: 'textbox', name: 'Message', value: 'Hi' });
    expect(nodes.get('bare'), diagnostic).toMatchObject({ role: 'textbox', value: 'Bare' });
    expect(nodes.get('bare')?.name, diagnostic).toBeUndefined();
    expect(nodes.get('outer'), diagnostic).toMatchObject({ role: 'textbox', name: 'Outer' });
    expect(nodes.get('island')?.role, diagnostic).toBeUndefined();
    expect(nodes.get('nested'), diagnostic).toMatchObject({ role: 'textbox', name: 'Nested', value: 'Inner' });
    // Playwright's role selector knows a textbox only through an explicit role; where it has a rule, the two agree.
    expect(await fixture!.oracle.getByRole('textbox', { name: 'Message' }).getAttribute('data-testid')).toBe('explicit');
  });

  it('keeps the whitespace an editor renders as its value, and reads an empty editor as an empty value', async () => {
    await nativeDocument(fixture!.browser, `
      <div contenteditable style="white-space: pre-wrap" aria-label="Code" data-testid="pre">  keep spaces  </div>
      <div contenteditable style="white-space: pre-wrap" aria-label="Lines" data-testid="lines"><p>line1</p><p>  line2</p></div>
      <div contenteditable aria-label="Prose" data-testid="prose">  collapsed   text  </div>
      <div contenteditable style="white-space: pre-wrap" aria-label="Spaces" data-testid="spaces">   </div>
      <div contenteditable aria-label="Empty" data-testid="empty"><p><br></p></div>
      <div contenteditable style="white-space: pre-wrap" aria-label="Empty pre" data-testid="empty-pre"><p><br></p></div>
      <div contenteditable aria-label="Blank" data-testid="blank"></div>
      <div contenteditable style="white-space: pre-wrap" aria-label="Slate" data-testid="slate"><div><span>﻿<br></span></div></div>
      <div contenteditable style="white-space: pre-wrap" aria-label="Slate lines" data-testid="slate-lines"><div><span>hi</span></div><div><span>﻿<br></span></div></div>
      <input aria-label="Field" value="  keep spaces  " data-testid="field">
    `);
    const nodes = await rolesByTestId();
    expect(nodes.get('pre')?.value).toBe('  keep spaces  ');
    expect(nodes.get('lines')?.value).toBe('line1\n\n  line2');
    // Under white-space: normal the browser renders no leading or trailing space, so none is read.
    expect(nodes.get('prose')?.value).toBe('collapsed text');
    expect(nodes.get('spaces')?.value).toBe('   ');
    expect(nodes.get('empty')?.value).toBe('');
    expect(nodes.get('empty-pre')?.value).toBe('');
    expect(nodes.get('blank')?.value).toBe('');
    expect(nodes.get('slate')?.value).toBe('');
    expect(nodes.get('slate-lines')?.value).toBe('hi\n\n');
    expect(nodes.get('field')?.value).toBe('  keep spaces  ');
  });

  it('makes an editing host a textbox whatever role its tag carries, and leaves a native control its own', async () => {
    await nativeDocument(fixture!.browser, `
      <article contenteditable data-testid="article"><p>Post</p></article>
      <h2 contenteditable data-testid="heading">Title</h2>
      <ul><li contenteditable data-testid="item">Item</li></ul>
      <section contenteditable aria-label="Notes" data-testid="section"></section>
      <button contenteditable data-testid="button">Save</button>
      <a href="#" contenteditable data-testid="link">Home</a>
      <select contenteditable data-testid="select"><option>a</option></select>
      <img contenteditable alt="Pic" src="${PIXEL}" data-testid="image">
    `);
    const nodes = await rolesByTestId();
    const roles = Object.fromEntries([...nodes].map(([testId, node]) => [testId, node.role]));
    expect(roles).toEqual({
      article: 'textbox',
      heading: 'textbox',
      item: 'textbox',
      section: 'textbox',
      button: 'button',
      link: 'link',
      select: 'combobox',
      image: 'image',
    });
    expect(nodes.get('article')).toMatchObject({ value: 'Post' });
    expect(nodes.get('section')).toMatchObject({ name: 'Notes', value: '' });
  });

  // One immutable source-bound fixture pairs the original native snapshot with the optional P42O companion.
  const embeddedSurfaceHtml = `
      <canvas contenteditable tabindex="0" width="120" height="60" data-testid="canvas"></canvas>
      <svg contenteditable width="20" height="20" data-testid="svg"></svg>
      <iframe contenteditable srcdoc="<p>Framed</p>" data-testid="frame"></iframe>
      <div contenteditable data-testid="host"><canvas width="20" height="20"></canvas><p>Caption</p></div>
    `;
  let embeddedNativePair: CanvasNativePair | undefined;

  it('never makes a drawn or embedded surface a textbox, whatever its contenteditable says', async () => {
    const evidence = beginSyntheticCase('P42');
    const outcome: SyntheticOutcome = { setup: 'failed', body: 'not-started', cleanup: 'not-started' };
    let bodyPhase: 'initial-observe' | 'assertion' = 'initial-observe';
    try {
      embeddedNativePair = undefined;
      evidence.record({ kind: 'phase', section: 'setup', phase: 'navigate', state: 'enter' });
      await nativeDocument(fixture!.browser, embeddedSurfaceHtml);
      await fixture!.oracle.frames()[1]?.waitForLoadState('domcontentloaded');
      outcome.setup = 'passed';
      evidence.record({ kind: 'phase', section: 'setup', phase: 'navigate', state: 'passed' });
      outcome.body = 'failed';
      evidence.record({ kind: 'phase', section: 'body', phase: bodyPhase, state: 'enter' });
      const { tree } = await capture();
      evidence.record({ kind: 'phase', section: 'body', phase: bodyPhase, state: 'passed' });
      // In-memory closed facts only; no additional reads and no oracle await before the original assertion.
      if (evidence.available) {
        try { embeddedNativePair = pairCanvasNative(new Map(flatten(tree).filter(node => node.testId !== undefined).map(node => [node.testId!, node])), embeddedSurfaceHtml); }
        catch { evidence.invalidate(); }
      }
      bodyPhase = 'assertion';
      evidence.record({ kind: 'phase', section: 'body', phase: bodyPhase, state: 'enter' });
      const roles = Object.fromEntries(flatten(tree).filter((node) => node.testId !== undefined).map((node) => [node.testId, node.role]));
      // A canvas, with no role, name, or text, is not a node at all; an svg has the image role, so it is listed.
      expect(roles, nodeProjection('embedded-surfaces',
        new Map(flatten(tree).filter(node => node.testId !== undefined).map(node => [node.testId!, node])), [
          { testId: 'canvas', included: false },
          { testId: 'svg', role: 'image' },
          { testId: 'frame', role: 'iframe' },
          { testId: 'host', role: 'textbox' },
        ])).toEqual({ svg: 'image', frame: 'iframe', host: 'textbox' });
      outcome.body = 'passed';
    } finally {
      if (outcome.body !== 'not-started') evidence.record({ kind: 'phase', section: 'body', phase: bodyPhase, state: outcome.body === 'passed' ? 'passed' : 'failed' });
      evidence.finish(outcome);
    }
  });

  it('P42O: records an isolated source-equivalent embedded-surface oracle', async () => {
    const evidence = beginSyntheticCase('P42O');
    let outcome: SyntheticOutcome = { setup: 'not-started', body: 'not-started', cleanup: 'not-started' };
    try { outcome = await recordCanvasOracle(evidence, embeddedNativePair, fixture?.oracle, embeddedSurfaceHtml); }
    catch { evidence.invalidate(); }
    finally { embeddedNativePair = undefined; evidence.finish(outcome); }
  });

  it('drops a name taken from a block placeholder once the editor has content, and keeps one from the host', async () => {
    await nativeDocument(fixture!.browser, `
      <div contenteditable class="tiptap ProseMirror" data-testid="tiptap">
        <p class="is-empty is-editor-empty" data-placeholder="Write something"><br></p>
      </div>
      <div contenteditable class="ql-editor ql-blank" data-placeholder="Compose a message" data-testid="quill"><p><br></p></div>
      <div contenteditable aria-placeholder="Write here" data-testid="aria-placeholder"><p><br></p></div>
      <span id="notes-label">Notes</span>
      <div contenteditable aria-labelledby="notes-label" data-testid="labelled">
        <p class="is-empty is-editor-empty" data-placeholder="Write something"><br></p>
      </div>
    `);
    const before = await rolesByTestId();
    const beforeDiagnostic = nodeProjection('editor-before', before, [
      { testId: 'tiptap', role: 'textbox', name: 'Write something', value: '' },
      { testId: 'quill', role: 'textbox', name: 'Compose a message', value: '' },
      { testId: 'aria-placeholder', role: 'textbox', name: 'Write here', value: '' },
      { testId: 'labelled', role: 'textbox', name: 'Notes', value: '' },
    ]);
    expect(before.get('tiptap'), beforeDiagnostic).toMatchObject({ role: 'textbox', name: 'Write something', value: '' });
    expect(before.get('quill'), beforeDiagnostic).toMatchObject({ role: 'textbox', name: 'Compose a message', value: '' });
    expect(before.get('aria-placeholder'), beforeDiagnostic).toMatchObject({ role: 'textbox', name: 'Write here', value: '' });
    expect(before.get('labelled'), beforeDiagnostic).toMatchObject({ role: 'textbox', name: 'Notes', value: '' });

    for (const testId of ['tiptap', 'quill', 'aria-placeholder', 'labelled']) {
      await fill(testId, 'Hello');
    }
    // TipTap's Placeholder extension paints the hint as a decoration on the
    // empty block and removes it, class and attribute, once the block has text.
    await fixture!.browser.evaluate(() => {
      for (const block of document.querySelectorAll('.tiptap [data-placeholder]')) {
        block.removeAttribute('data-placeholder');
        block.classList.remove('is-empty', 'is-editor-empty');
      }
      return null;
    });
    const after = await rolesByTestId();
    const afterDiagnostic = nodeProjection('editor-after', after, [
      { testId: 'tiptap', role: 'textbox', name: undefined, value: 'Hello' },
      { testId: 'quill', role: 'textbox', name: 'Compose a message', value: 'Hello' },
      { testId: 'aria-placeholder', role: 'textbox', name: 'Write here', value: 'Hello' },
      { testId: 'labelled', role: 'textbox', name: 'Notes', value: 'Hello' },
    ]);
    expect(after.get('tiptap'), afterDiagnostic).toMatchObject({ role: 'textbox', value: 'Hello' });
    expect(after.get('tiptap')?.name, afterDiagnostic).toBeUndefined();
    expect(after.get('quill'), afterDiagnostic).toMatchObject({ role: 'textbox', name: 'Compose a message', value: 'Hello' });
    expect(after.get('aria-placeholder'), afterDiagnostic).toMatchObject({ role: 'textbox', name: 'Write here', value: 'Hello' });
    expect(after.get('labelled'), afterDiagnostic).toMatchObject({ role: 'textbox', name: 'Notes', value: 'Hello' });
  });

  it('follows the document as it is edited and focused, as a textarea value does', async () => {
    await nativeDocument(fixture!.browser, `
      <div contenteditable aria-label="Notes" data-testid="editor"><p><br></p></div>
      <textarea aria-label="Plain" data-testid="plain"></textarea>
    `);
    await fill('plain', 'Typed');
    await fill('editor', 'Typed');
    const nodes = await rolesByTestId();
    expect(nodes.get('editor')).toMatchObject({ role: 'textbox', name: 'Notes', value: 'Typed', states: { focused: true } });
    expect(nodes.get('plain')).toMatchObject({ role: 'textbox', name: 'Plain', value: 'Typed' });
    expect(nodes.get('plain')?.states?.focused).toBeUndefined();
  });
});
