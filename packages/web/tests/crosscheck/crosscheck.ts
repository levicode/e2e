/**
 * Differential check of the engine's semantic tree against two oracles on
 * the same live page: Chrome's own accessibility tree over CDP, and
 * Playwright's `getByRole` resolution. Protected observation refs are joined
 * to temporary DOM markers by native acquisition correlation, then looked up
 * in both oracles. Interactive Chrome nodes absent from observation count
 * as missing even if a fixture query can find them.
 *
 * The result is a list of disagreements keyed without node ids, so a list
 * can be committed as the expected state of a page and diffed on the next
 * run (`expectations.ts`).
 */

import { randomUUID } from 'node:crypto';
import type { CDPSession, Page } from 'playwright-core';
import type { LocatorExpression, SemanticNode } from 'e2e/engine';
import type { NativeOracle } from '../helpers/native-oracle.ts';

/** One field on which the engine and an oracle read a node differently. */
export interface Disagreement {
  readonly oracle: 'chrome' | 'playwright' | 'axe';
  /** `role`, `name`, a state name, `level`, `missing` (Chrome has the node, the engine does not), or `unknown` (the other way). */
  readonly field: string;
  readonly ours: string;
  readonly theirs: string;
  /** `role "name"` as the engine reads it, or as Chrome does for a node the engine left out. */
  readonly node: string;
}

export interface CrossCheckResult {
  /** Engine nodes compared against at least one oracle; zero means the page checked nothing. */
  readonly compared: number;
  readonly disagreements: readonly Disagreement[];
}

/** Engine roles never compared: structure and text the tree keeps for the model, with no ARIA counterpart. */
const STRUCTURAL_ROLES = new Set(['document', 'text', 'generic', 'none', 'presentation']);

/** The vocabulary spells a few ARIA roles its own way. */
const ARIA_ROLE: Readonly<Record<string, string>> = { image: 'img' };

/*
 * Deliberate differences. Each is a choice the tree makes for the model, kept
 * here with its reason rather than repeated per page in `expected.txt`, so
 * the file lists only what nobody has decided yet.
 */

/**
 * Roles the tree names from content where accname, Chrome, and Playwright
 * leave them unnamed:
 * a list row or a status message is read by what it says.
 */
const ENGINE_NAMED_ROLES = new Set(['listitem', 'status', 'alert']);

/**
 * Roles accname or HTML-AAM names (a row from content, a figure by its
 * figcaption) where Chrome's tree leaves the name empty. Playwright agrees
 * with the engine on these.
 */
const CHROME_UNNAMED_ROLES = new Set(['row', 'figure']);

/**
 * Chrome's own role names where the vocabulary uses ARIA's, or where ARIA
 * has none: a date or colour input reads as `textbox` to the engine and to
 * Playwright.
 */
const CHROME_ROLES: Readonly<Record<string, readonly string[]>> = {
  image: ['image'],
  iframe: ['Iframe'],
  textbox: ['textbox', 'Date', 'DateTime', 'InputTime', 'ColorWell'],
};

/** Engine roles Chrome may ignore: a row group keeps a table's controls in their section. */
const CHROME_IGNORES = new Set(['rowgroup']);

/**
 * Engine roles with no Chrome counterpart: `box` is a visible empty element
 * the tree lists so a drag or a click has something to aim at.
 */
const ENGINE_ONLY_ROLES = new Set(['box']);

/**
 * An unnamed inline svg: Chrome's tree ignores it or leaves it out, while
 * Playwright reads it as `img` and its aria snapshot lists it. The tree
 * lists it as Playwright does, so an icon-only control a person sees reaches
 * the model even when nothing names it.
 */
function isUnnamedSvg(node: SemanticNode, facts: ElementFacts): boolean {
  return facts.svgRoot && node.role === 'image' && (node.name ?? '') === '';
}

/** Engine roles ARIA does not define, so `getByRole` cannot be asked for them. */
const NON_ARIA_ROLES = new Set(['box', 'iframe']);

/** Chrome roles the engine is expected to report whenever Chrome exposes them. */
const INTERACTIVE_CHROME_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'option',
  'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
]);

/**
 * Icon-font glyphs, private-use code points, which the tree drops from a
 * name and the engine's role locator tolerates. Removed
 * from Chrome's name before it is compared, and allowed around the words of
 * the name `getByRole` is asked for.
 */
const ICON_GLYPHS = /\p{Co}/gu;

/** A name as `getByRole` is asked for it: exact, with icon-font glyphs allowed wherever it has a space or begins or ends. */
function glyphTolerant(name: string): RegExp {
  const words = normalize(name).split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  return new RegExp(`^[\\s\\p{Co}]*${words.join('[\\s\\p{Co}]+')}[\\s\\p{Co}]*$`, 'u');
}

/** The ARIA states compared, as Chrome's AX property names. */
const STATES = ['checked', 'disabled', 'expanded', 'selected', 'pressed'] as const;

/** Temporary oracle identity, never model metadata or a guessed native ref. */
const MARKER = 'data-e2e-crosscheck';

function flatten(node: SemanticNode, out: SemanticNode[] = []): SemanticNode[] {
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function describe(role: string, name: string): string {
  return `${role} ${JSON.stringify(name)}`;
}

interface OracleNode {
  readonly nodeType: number;
  readonly backendNodeId: number;
  readonly attributes?: readonly string[];
  readonly children?: readonly OracleNode[];
  readonly shadowRoots?: readonly OracleNode[];
  readonly shadowRootType?: string;
  readonly frameId?: string;
  readonly contentDocument?: OracleNode;
}

interface TaggedElement {
  readonly token: string;
  readonly frameId: string;
  readonly cdp: CDPSession;
  readonly objectId: string;
  readonly previous: string | null;
  facts?: ElementFacts;
}

/** Instrument only the owned oracle, after protected capture, and restore every marker afterwards. */
async function tagOracleElements(page: Page) {
  const group = `e2e-crosscheck-${randomUUID()}`;
  const sessions: CDPSession[] = [];
  const elements: TaggedElement[] = [];
  const edges = new Map<string, { parent: string; selector: string }>();
  const restore = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const element of elements.toReversed()) {
      try {
        const result = await element.cdp.send('Runtime.callFunctionOn', {
          objectId: element.objectId,
          functionDeclaration: 'function(attribute, previous) { if (previous === null) this.removeAttribute(attribute); else this.setAttribute(attribute, previous); }',
          arguments: [{ value: MARKER }, { value: element.previous }], returnByValue: true,
        });
        if (result.exceptionDetails !== undefined) throw new Error('Oracle marker restoration failed');
      } catch (cause) { failures.push(cause); }
    }
    for (const cdp of sessions) {
      try { await cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }); } catch (cause) { failures.push(cause); }
      try { await cdp.detach(); } catch (cause) { failures.push(cause); }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Crosscheck oracle cleanup failed');
  };
  try {
    const main = await page.context().newCDPSession(page);
    sessions.push(main);
    const mainFrameId = (await main.send('Page.getFrameTree')).frameTree.frame.id;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try { sessions.push(await page.context().newCDPSession(frame)); }
      catch (cause) {
        // Pinned Playwright reports this only for a frame already in its parent's CDP session.
        if (!(cause instanceof Error) || !cause.message.includes("This frame does not have a separate CDP session, it is a part of the parent frame's session")) throw cause;
      }
    }
    const visited = new Set<string>();
    const walk = async (cdp: CDPSession, node: OracleNode, frameId: string): Promise<void> => {
      if (node.shadowRootType === 'user-agent') return;
      const key = `${frameId}:${node.backendNodeId}`;
      if (visited.has(key)) return;
      visited.add(key);
      if (node.nodeType === 1) {
        const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId, objectGroup: group });
        if (object.objectId === undefined) throw new Error('Oracle could not resolve an element');
        const attributeIndex = node.attributes?.findIndex((attribute, index) => index % 2 === 0 && attribute === MARKER) ?? -1;
        const previous = attributeIndex < 0 ? null : node.attributes![attributeIndex + 1]!;
        const token = `${group}-${elements.length}`;
        const element: TaggedElement = { token, frameId, cdp, objectId: object.objectId, previous };
        elements.push(element);
        const read = await cdp.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: `function(attribute, token) {
            this.setAttribute(attribute, token);
            const root = this.getRootNode();
            const view = this.ownerDocument.defaultView;
            return {
              inChildFrame: view !== null && view !== view.top,
              inClosedShadow: root instanceof ShadowRoot && root.mode === 'closed',
              editingHost: this instanceof HTMLElement && this.isContentEditable,
              svgRoot: this instanceof SVGSVGElement,
            };
          }`,
          arguments: [{ value: MARKER }, { value: token }], returnByValue: true,
        });
        if (read.exceptionDetails !== undefined || read.result.value === undefined) throw new Error('Oracle could not read element facts');
        element.facts = read.result.value as ElementFacts;
        if (node.frameId !== undefined && node.frameId !== frameId) edges.set(node.frameId, { parent: frameId, selector: `[${MARKER}=${JSON.stringify(token)}]` });
      }
      for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) await walk(cdp, child, frameId);
      if (node.contentDocument !== undefined) {
        if (node.frameId === undefined) throw new Error('Oracle frame owner has no frame identity');
        await walk(cdp, node.contentDocument, node.frameId);
      }
    };
    for (const cdp of sessions) {
      const frameId = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      await walk(cdp, root, frameId);
    }
    const paths = new Map<string, readonly string[]>([[mainFrameId, []]]);
    const pathFor = (frameId: string, visiting = new Set<string>()): readonly string[] => {
      const known = paths.get(frameId);
      if (known !== undefined) return known;
      const edge = edges.get(frameId);
      if (edge === undefined || visiting.has(frameId)) throw new Error('Oracle cannot prove the child frame chain');
      visiting.add(frameId);
      const path = [...pathFor(edge.parent, visiting), edge.selector];
      paths.set(frameId, path);
      return path;
    };
    for (const element of elements) pathFor(element.frameId);
    return { elements, paths, restore };
  } catch (cause) {
    try { await restore(); }
    catch (cleanupError) { throw new AggregateError([cause, cleanupError], 'Oracle setup and cleanup failed', { cause: cleanupError }); }
    throw cause;
  }
}

/** Join exact marker/ref identities without borrowing any fixture-query semantics for the model. */
async function captureTagged(fixture: NativeOracle) {
  const snapshot = await fixture.engine.observe!({ ...fixture.operation(), origin: 'agent', timeoutMs: 30_000 });
  const nodes = flatten(snapshot.root);
  const tagged = await tagOracleElements(fixture.oracle);
  try {
    const byToken = new Map(tagged.elements.map(element => [element.token, element]));
    const facts = new Map<string, ElementFacts>();
    const markers = new Map<string, string>();
    const ids = new Map<string, string>();
    for (const [frameId, path] of tagged.paths) {
      const expression = path.reduceRight<LocatorExpression>((source, selector) => ({ kind: 'frame', selector, source }), { kind: 'selector', selector: `[${MARKER}]` });
      // Explicit fixture reads preserve attributes; protected observation does not.
      // Only the marker and exact ref participate in this join, never query metadata.
      const matches = await fixture.engine.locate!(expression, { ...fixture.operation(), timeoutMs: 30_000 }, { purpose: 'fixture' });
      const correlated = await fixture.correlate(matches.map(match => match.ref), nodes, { ...fixture.operation(), timeoutMs: 30_000 });
      for (const [index, match] of matches.entries()) {
        const token = match.attributes?.[MARKER];
        const element = token === undefined ? undefined : byToken.get(token);
        if (element === undefined || element.frameId !== frameId || element.facts === undefined) throw new Error('Fixture query did not identify an exact oracle element');
        const observed = correlated[index];
        if (observed === null) continue;
        if (observed === undefined) throw new Error('Crosscheck identity correlation omitted a result');
        if (markers.has(observed.ref.id) || ids.has(token!)) throw new Error('Crosscheck identity join is not one-to-one');
        facts.set(observed.ref.id, element.facts);
        markers.set(observed.ref.id, token!);
        ids.set(token!, observed.ref.id);
      }
    }
    for (const node of nodes) {
      if (node.role !== undefined && !STRUCTURAL_ROLES.has(node.role) && !facts.has(node.ref.id)) throw new Error(`No exact DOM identity for observed ref ${node.ref.id}`);
    }
    return { nodes, facts, markers, ids, restore: tagged.restore };
  } catch (cause) {
    try { await tagged.restore(); }
    catch (cleanupError) { throw new AggregateError([cause, cleanupError], 'Crosscheck identity join and cleanup failed', { cause: cleanupError }); }
    throw cause;
  }
}

/** Where an element sits, for the policies above and the oracles' reach. */
interface ElementFacts {
  /** Neither oracle reads a child frame from the top page. */
  readonly inChildFrame: boolean;
  /** Playwright cannot pierce a closed root; the native engine can read it. */
  readonly inClosedShadow: boolean;
  /** An editor's host, which the tree reads as the `textbox` it is. Chrome calls it `generic`. */
  readonly editingHost: boolean;
  /** An inline `<svg>`, which Chrome ignores unless something names it. */
  readonly svgRoot: boolean;
}

/** The fields of CDP's `Accessibility.AXNode` the check reads. */
interface AXNode {
  readonly ignored: boolean;
  readonly role?: { readonly value?: unknown };
  readonly name?: { readonly value?: unknown };
  readonly properties?: readonly { readonly name: string; readonly value: { readonly value?: unknown } }[];
  readonly backendDOMNodeId?: number;
}

/** Chrome's AX node for every tagged element, and the AX nodes whose element carries no tag. */
async function chromeTree(page: Page, ids: ReadonlyMap<string, string>): Promise<{ byId: Map<string, AXNode>; untagged: AXNode[] }> {
  const cdp = await page.context().newCDPSession(page);
  const group = `e2e-crosscheck-ax-${randomUUID()}`;
  try {
    await cdp.send('DOM.enable');
    await cdp.send('Accessibility.enable');
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const byId = new Map<string, AXNode>();
    const untagged: AXNode[] = [];
    for (const node of nodes as readonly AXNode[]) {
      if (node.backendDOMNodeId === undefined) continue;
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId, objectGroup: group });
      if (object.objectId === undefined) continue;
      const { result } = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        // A node inside a form control's own shadow tree (a date input's
        // day field) is the browser's, not the page's: reported as tagged
        // with no id so it never counts as missing.
        functionDeclaration: `function () {
          let node = this;
          while (node !== null && !(node instanceof ShadowRoot)) node = node.parentNode;
          if (node !== null && node.host.matches('input, select, textarea, video, audio')) return '';
          return this.nodeType === 1 ? this.getAttribute(${JSON.stringify(MARKER)}) : null;
        }`,
        returnByValue: true,
      });
      if (result.value === '') continue;
      const id = typeof result.value === 'string' ? ids.get(result.value) : undefined;
      if (id === undefined) untagged.push(node);
      else byId.set(id, node);
    }
    return { byId, untagged };
  } finally {
    try { await cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }); }
    finally { await cdp.detach(); }
  }
}

function property(node: AXNode, name: string): unknown {
  return node.properties?.find((entry) => entry.name === name)?.value.value;
}

/** A state as a comparable string: Chrome reports `true`, `false`, `mixed`, or leaves it out for `false`. */
function chromeState(node: AXNode, state: (typeof STATES)[number]): string {
  const value = property(node, state);
  return value === undefined ? 'false' : String(value);
}

function compareWithChrome(node: SemanticNode, ax: AXNode, facts: ElementFacts, into: Disagreement[]): void {
  const role = node.role!;
  const ours = node.name ?? '';
  const label = describe(role, ours);
  const chromeRole = String(ax.role?.value ?? '');
  if (ENGINE_ONLY_ROLES.has(role) || (role === 'textbox' && facts.editingHost)) return;
  if (ax.ignored) {
    if (!CHROME_IGNORES.has(role)) into.push({ oracle: 'chrome', field: 'role', ours: role, theirs: `ignored (${chromeRole})`, node: label });
    return;
  }
  const accepted = CHROME_ROLES[role] ?? [role];
  if (!accepted.includes(chromeRole)) into.push({ oracle: 'chrome', field: 'role', ours: role, theirs: chromeRole, node: label });
  const theirs = normalize(String(ax.name?.value ?? '').replace(ICON_GLYPHS, ' '));
  const cut = ours.length >= 250 && theirs.startsWith(ours.slice(0, 200));
  const unnamedByChrome = theirs === '' && (ENGINE_NAMED_ROLES.has(role) || CHROME_UNNAMED_ROLES.has(role));
  if (normalize(ours) !== theirs && !cut && !unnamedByChrome) into.push({ oracle: 'chrome', field: 'name', ours, theirs, node: label });
  for (const state of STATES) {
    const chrome = chromeState(ax, state);
    const engine = String(node.states?.[state] === true);
    // The engine has no `mixed`; a mixed control reads as not checked.
    if ((chrome === 'mixed' ? 'false' : chrome) !== engine) into.push({ oracle: 'chrome', field: state, ours: engine, theirs: chrome, node: label });
  }
  const level = property(ax, 'level');
  if (role === 'heading' && level !== undefined && Number(level) !== node.level) {
    into.push({ oracle: 'chrome', field: 'level', ours: String(node.level), theirs: String(level), node: label });
  }
}

/** Whether `getByRole(role, { name, exact })` finds the engine's element among its matches. */
async function compareWithPlaywright(page: Page, node: SemanticNode, marker: string, into: Disagreement[]): Promise<void> {
  const name = node.name ?? '';
  const role = ARIA_ROLE[node.role!] ?? node.role!;
  const label = describe(node.role!, name);
  try {
    const found = await page
      // `includeHidden` also changes how Playwright computes names, so it is
      // set only for a node the tree itself reports hidden.
      .getByRole(role as Parameters<Page['getByRole']>[0], { name: glyphTolerant(name), includeHidden: node.states?.hidden === true })
      .evaluateAll((elements, [attribute, id]) => elements.some((element) => element.getAttribute(attribute!) === id), [MARKER, marker]);
    if (!found) into.push({ oracle: 'playwright', field: 'getByRole', ours: 'match', theirs: 'no match', node: label });
  } catch (error) {
    into.push({ oracle: 'playwright', field: 'getByRole', ours: 'match', theirs: `error: ${(error as Error).message.split('\n')[0]}`, node: label });
  }
}

/** Cross-check the protected snapshot and restore the oracle's temporary markers even on failure. */
export async function crossCheck(fixture: NativeOracle): Promise<CrossCheckResult> {
  const page = fixture.oracle;
  const { nodes, facts, markers, ids, restore } = await captureTagged(fixture);
  try {
    const chrome = await chromeTree(page, ids);
    const disagreements: Disagreement[] = [];
    let compared = 0;
    for (const node of nodes) {
      const fact = facts.get(node.ref.id);
      if (node.role === undefined || STRUCTURAL_ROLES.has(node.role) || fact === undefined || fact.inChildFrame) continue;
      if (isUnnamedSvg(node, fact)) continue;
      compared += 1;
      const ax = chrome.byId.get(node.ref.id);
      if (ax === undefined) disagreements.push({ oracle: 'chrome', field: 'unknown', ours: node.role, theirs: 'no AX node', node: describe(node.role, node.name ?? '') });
      else compareWithChrome(node, ax, fact, disagreements);
      const playwrightReads = !fact.inClosedShadow && !ENGINE_NAMED_ROLES.has(node.role) && !NON_ARIA_ROLES.has(node.role) &&
        !(node.role === 'textbox' && fact.editingHost);
      if (node.name !== undefined && node.name !== '' && playwrightReads) await compareWithPlaywright(page, node, markers.get(node.ref.id)!, disagreements);
    }
    for (const ax of chrome.untagged) {
      const role = String(ax.role?.value ?? '');
      if (ax.ignored || !INTERACTIVE_CHROME_ROLES.has(role)) continue;
      disagreements.push({ oracle: 'chrome', field: 'missing', ours: 'no node', theirs: role, node: describe(role, normalize(String(ax.name?.value ?? ''))) });
    }
    return { compared, disagreements };
  } finally {
    await restore();
  }
}
