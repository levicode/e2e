import { randomUUID } from 'node:crypto';
import {
  EngineError,
  OBSERVED_NAME_LIMIT,
  OBSERVED_TEXT_LIMIT,
  resolveExpression,
  type EngineSnapshot,
  type LocatorExpression,
  type NodeRef,
  type OperationContext,
  type SemanticNode,
} from 'e2e/engine';

interface SnapshotTransport {
  run<T>(args: readonly string[], context: OperationContext, options?: { mutating?: boolean; sensitive?: boolean }): Promise<T>;
}

/** Authoritative identity exported by the maintained public CLI contract. */
export interface SnapshotRef {
  readonly role: string;
  readonly name: string;
  readonly backendNodeId?: number | null;
  readonly frameId?: string | null;
}

/** Exact-ref metadata from the same pinned Chromium target. */
export type SnapshotMetadataReader = (
  refs: Readonly<Record<string, SnapshotRef>>,
  context: OperationContext,
) => Promise<Readonly<Record<string, Omit<SemanticNode, 'ref' | 'children'>>>>;

interface RawSnapshot {
  readonly snapshot: string;
  readonly refs: Readonly<Record<string, SnapshotRef>>;
  readonly origin?: string;
  readonly complete?: boolean;
}

type MutableNode = { -readonly [K in keyof SemanticNode]: SemanticNode[K] } & { children: MutableNode[] };
interface ParsedTree {
  readonly roots: MutableNode[];
  readonly refs: Map<string, MutableNode>;
  readonly parents: Map<MutableNode, MutableNode>;
  readonly incomplete: boolean;
}
interface SurfaceInfo {
  readonly width: number;
  readonly height: number;
  readonly frames: boolean;
  readonly location: string;
}

const ROOT_ID = 'agent-browser:root';
const REF_ID = /^e\d+$/;
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
const BOOLEAN_ATTRIBUTES = ['aria-checked', 'aria-selected', 'aria-expanded', 'aria-pressed'] as const;
const ATTRIBUTES = [
  'id', 'type', 'autocomplete', 'placeholder', 'name', 'href', 'role', 'class',
  'contenteditable', 'readonly', 'required', 'aria-label', 'aria-description',
  'aria-checked', 'aria-selected', 'aria-expanded', 'aria-pressed',
] as const;

/**
 * Projects agent-browser's public snapshot without deciding which of its refs
 * matter. In particular, no name, role, viewport, or pointer-cursor filter runs
 * here. DOM metadata is read through public commands addressed to those refs.
 */
export class SnapshotAdapter {
  private readonly transport: SnapshotTransport;
  private readonly testIdAttribute: string;
  private readonly readMetadata: SnapshotMetadataReader | undefined;
  private readonly snapshotArgs: ((context: OperationContext) => Promise<readonly string[]>) | undefined;
  private readonly preserveRefs: boolean;
  private readonly identity = `agent-browser:${randomUUID()}`;
  private generation = 0;
  private nodes = new Map<string, SemanticNode>();
  private selectors = new Map<string, string>();
  private lastSnapshot: EngineSnapshot | undefined;
  private readonly located = new Map<string, string>();

  constructor(transport: SnapshotTransport, options: { readonly testIdAttribute?: string; readonly readMetadata?: SnapshotMetadataReader; readonly snapshotArgs?: (context: OperationContext) => Promise<readonly string[]>; readonly preserveRefs?: boolean } = {}) {
    this.transport = transport;
    this.readMetadata = options.readMetadata;
    this.snapshotArgs = options.snapshotArgs;
    this.preserveRefs = options.preserveRefs ?? false;
    this.testIdAttribute = options.testIdAttribute ?? 'data-testid';
    if (!/^[a-zA-Z_][a-zA-Z0-9_.:-]*$/.test(this.testIdAttribute)) {
      throw new EngineError('INVALID_STATE', 'The test-id attribute must be an HTML attribute name', { retryable: false });
    }
  }

  /** Invalidates every element ref; the viewport root deliberately survives. */
  invalidate(): void {
    this.lastSnapshot = undefined;
    this.nodes.clear();
    this.selectors.clear();
    this.located.clear();
  }

  /** The stable root remains addressable after navigation or an earlier observation. */
  isRoot(ref: NodeRef): boolean {
    return ref.id === ROOT_ID;
  }

  /** The harness owns revisions; unique engine-owned IDs carry exact native identity. */
  resolve(ref: NodeRef): string {
    if (this.isRoot(ref)) return 'html';
    const located = this.located.get(ref.id);
    if (located !== undefined) return located;
    if (!this.nodes.has(ref.id)) throw stale();
    const selector = this.selectors.get(ref.id);
    if (selector === undefined) {
      throw new EngineError('NOT_ACTIONABLE', 'This snapshot text node has no public element reference', { retryable: false });
    }
    return selector;
  }

  /** Validates the exact native node without resetting imported public refs. */
  async verify(ref: NodeRef, context: OperationContext): Promise<void> {
    if (this.isRoot(ref)) return;
    const selector = this.resolve(ref);
    // The maintained CLI checks connectedness on every @ref resolution and
    // never falls back by role/name. Snapshot would erase imported refs.
    await this.transport.run(['get', 'attr', selector, 'id'], context, { sensitive: true });
  }

  /** Last completed sanitized observation for tracing only; never refreshes or rebinds refs. */
  traceSnapshot(): EngineSnapshot | undefined {
    return this.lastSnapshot;
  }

  /** Captures full default output and enriches exact refs through public reads. */
  async observe(context: OperationContext): Promise<EngineSnapshot> {
    context = boundedContext(context);
    this.lastSnapshot = undefined;
    this.nodes.clear();
    this.selectors.clear();
    const revision = `${this.identity}:${this.preserveRefs ? 'trace:' : ''}${++this.generation}`;
    const raw = await this.snapshot(context);
    const parsed = parseSnapshot(raw, revision);
    const surface = await this.surface(context);
    if (this.readMetadata === undefined) await this.enrich(parsed, context);
    else {
      const metadata = await this.readMetadata(raw.refs, context);
      for (const [nativeRef, node] of parsed.refs) {
        const exact = metadata[nativeRef];
        if (exact === undefined) throw stale();
        const attributes = { ...node.attributes, ...exact.attributes };
        Object.assign(node, exact, { ref: node.ref, children: node.children, attributes });
        if (node.states?.secure === true) {
          delete node.value;
          delete node.selection;
          delete node.text;
        }
      }
    }
    scrubSecureSubtrees(parsed.roots);
    for (const node of flatten(parsed.roots)) {
      const mutable = node as MutableNode;
      if (mutable.name !== undefined) mutable.name = mutable.name.slice(0, OBSERVED_NAME_LIMIT);
      if (mutable.text !== undefined) mutable.text = mutable.text.slice(0, OBSERVED_TEXT_LIMIT);
      if (mutable.selection !== undefined) mutable.selection = mutable.selection.slice(0, OBSERVED_TEXT_LIMIT);
    }
    const root: SemanticNode = {
      ref: { id: ROOT_ID, revision }, role: 'document',
      rect: { x: 0, y: 0, width: surface.width, height: surface.height },
      children: parsed.roots,
    };
    this.nodes = new Map(flatten([root]).map((node) => [node.ref.id, node]));
    this.selectors = new Map([...parsed.refs].map(([id, node]) => [node.ref.id, `@${id}`]));
    const result: EngineSnapshot = {
      root, viewport: { width: surface.width, height: surface.height },
      location: raw.origin ?? surface.location,
      // The maintained CLI attests recursive capture only after every eligible
      // frame and cursor augmentation succeeds. Older payloads stay conservative.
      truncated: parsed.incomplete || raw.complete === false || (surface.frames && raw.complete !== true) || (this.readMetadata !== undefined && Object.values(raw.refs).some(ref => typeof ref.backendNodeId !== 'number')),
    };
    this.lastSnapshot = result;
    return result;
  }

  /** Located refs survive subsequent resolves (including a drag destination). */
  adopt(entries: readonly { readonly nativeRef: string; readonly node: Omit<SemanticNode, 'ref'> }[]): readonly SemanticNode[] {
    this.lastSnapshot = undefined;
    const revision = `${this.identity}:${this.preserveRefs ? 'trace:' : ''}located:${++this.generation}`;
    const result = entries.map(({ nativeRef, node }) => {
      if (!REF_ID.test(nativeRef)) throw malformed();
      const projected: MutableNode = { ...node, ref: { id: `${revision}:${nativeRef}`, revision }, children: [] };
      if (projected.states?.secure === true) { delete projected.value; delete projected.selection; delete projected.text; }
      this.located.set(projected.ref.id, `@${nativeRef}`);
      return projected;
    });
    // Match the harness's bounded located-ref retention. Evicted refs fail stale.
    while (this.located.size > 2048) this.located.delete(this.located.keys().next().value!);
    return result;
  }

  /** Resolves the public AST, with exact snapshot-bound CSS targets when possible. */
  async locate(expression: LocatorExpression, context: OperationContext): Promise<readonly SemanticNode[]> {
    context = boundedContext(context);
    const requested = selectorExpressions(expression);
    const targets = new Map<string, Set<string>>();
    for (const selector of requested) {
      const paths = await this.selectorPaths(selector, context);
      const ids = new Set<string>();
      for (const path of paths) {
        const raw = await this.snapshot(context, path);
        const parsed = parseSnapshot(raw, 'selector-probe');
        const first = parsed.roots[0];
        // A descendant ref is never substituted for an unreferenced target.
        const id = first?.ref.id.split(':').at(-1);
        if (id === undefined || !REF_ID.test(id) || !Object.hasOwn(raw.refs, id)) {
          this.invalidate();
          throw new EngineError('UNSUPPORTED_CAPABILITY', 'The CSS target has no agent-browser element ref; it cannot be bound safely', { retryable: false });
        }
        ids.add(id);
      }
      targets.set(selector, ids);
    }
    const snapshot = await this.observe(context);
    for (const ids of targets.values()) {
      if ([...ids].some((id) => ![...this.selectors.values()].includes(`@${id}`))) throw stale();
    }
    // Unscoped DOM queries do not descend into a different document.
    const roots = snapshot.root.children?.map(withoutFrameChildren) ?? [];
    return resolveExpression(expression, roots, {
      selector: (selector, candidates) => {
        const ids = targets.get(selector);
        return candidates.filter((node) => ids?.has(this.selectors.get(node.ref.id)?.slice(1) ?? ''));
      },
    });
  }

  private async snapshot(context: OperationContext, selector?: string): Promise<RawSnapshot> {
    const args = ['snapshot', '--exact-refs', ...(this.preserveRefs || this.located.size > 0 ? ['--preserve-refs'] : []), ...(await this.snapshotArgs?.(context) ?? []), ...(selector === undefined ? [] : ['--selector', selector])];
    const raw = await this.transport.run<unknown>(args, context, { sensitive: true });
    if (!isRecord(raw) || raw['exactRefs'] !== true || typeof raw['snapshot'] !== 'string' || !isRecord(raw['refs'])) throw malformed();
    const refs: Record<string, SnapshotRef> = {};
    for (const [ref, value] of Object.entries(raw['refs'])) {
      if (!REF_ID.test(ref) || !isRecord(value) || typeof value['role'] !== 'string' || typeof value['name'] !== 'string') throw malformed();
      const backendNodeId = value['backendNodeId'];
      const frameId = value['frameId'];
      if (backendNodeId !== undefined && backendNodeId !== null && !finite(backendNodeId)) throw malformed();
      if (frameId !== undefined && frameId !== null && typeof frameId !== 'string') throw malformed();
      refs[ref] = { role: value['role'], name: value['name'], ...(backendNodeId === undefined ? {} : { backendNodeId }), ...(frameId === undefined ? {} : { frameId }) };
    }
    if (raw['complete'] !== undefined && typeof raw['complete'] !== 'boolean') throw malformed();
    return { snapshot: raw['snapshot'], refs, ...(typeof raw['origin'] === 'string' ? { origin: raw['origin'] } : {}), ...(typeof raw['complete'] === 'boolean' ? { complete: raw['complete'] } : {}) };
  }

  private async surface(context: OperationContext): Promise<SurfaceInfo> {
    const value = await this.transport.run<{ result?: unknown }>(['eval', `(() => ({width:innerWidth,height:innerHeight,frames:document.querySelector('iframe,frame')!==null,location:location.href}))()`], context, { sensitive: true });
    const result = value.result;
    if (!isRecord(result) || !finite(result['width']) || !finite(result['height']) || typeof result['frames'] !== 'boolean' || typeof result['location'] !== 'string') throw malformed();
    return { width: result['width'], height: result['height'], frames: result['frames'], location: result['location'] };
  }

  private async selectorPaths(selector: string, context: OperationContext): Promise<readonly string[]> {
    // The expression is data inside JSON, never interpolated as program text.
    // Positional paths live for this read only; they are not replay selectors.
    const script = `(() => { const selector = ${JSON.stringify(selector)}; const nodes = Array.from(document.querySelectorAll(selector)); return nodes.map(element => { const parts = []; for (let node = element; node; node = node.parentElement) { const parent = node.parentElement; const nth = parent ? Array.from(parent.children).indexOf(node) + 1 : 1; parts.unshift(node.localName + ':nth-child(' + nth + ')'); } return parts.join(' > '); }); })()`;
    const data = await this.transport.run<{ result?: unknown }>(['eval', script], context, { sensitive: true });
    if (!Array.isArray(data.result) || !data.result.every((value) => typeof value === 'string')) throw malformed();
    return data.result as string[];
  }

  private async enrich(parsed: ParsedTree, context: OperationContext): Promise<void> {
    const attributes = [...new Set([...ATTRIBUTES, this.testIdAttribute])];
    const entries = [...parsed.refs];
    const commands = entries.flatMap(([id]) => [
      ...attributes.map((attribute) => `get attr @${id} ${attribute}`),
      `is visible @${id}`, `is enabled @${id}`, `get box @${id}`,
    ]);
    const values = await this.batch(commands, context);
    const stride = attributes.length + 3;
    const fields: [string, MutableNode][] = [];
    for (const [position, [id, node]] of entries.entries()) {
      const attrs: Record<string, string> = {};
      for (const [offset, attribute] of attributes.entries()) {
        const result = values[position * stride + offset];
        if (!isRecord(result) || !(result['value'] === null || typeof result['value'] === 'string')) throw malformed();
        if (typeof result['value'] === 'string') attrs[attribute] = result['value'];
      }
      const visible = values[position * stride + attributes.length];
      const enabled = values[position * stride + attributes.length + 1];
      const box = values[position * stride + attributes.length + 2];
      if (!isRecord(visible) || typeof visible['visible'] !== 'boolean' || !isRecord(enabled) || typeof enabled['enabled'] !== 'boolean') throw malformed();
      const purpose = inputPurpose(attrs, node.role);
      const secure = purpose === 'password';
      node.attributes = { ...node.attributes, ...attrs };
      const testId = attrs[this.testIdAttribute];
      if (testId !== undefined) node.testId = testId;
      node.inputPurpose = purpose;
      const states = { ...node.states, hidden: !visible['visible'], disabled: !enabled['enabled'], secure };
      for (const attribute of BOOLEAN_ATTRIBUTES) {
        const state = attribute.slice(5) as 'checked' | 'selected' | 'expanded' | 'pressed';
        if (attrs[attribute] === 'true' || attrs[attribute] === 'false') states[state] = attrs[attribute] === 'true';
      }
      node.states = states;
      const frames = frameAncestors(node, parsed.parents);
      if (frames.length === 0 && isRect(box)) node.rect = box;
      const anchor = attrs['id'] ? `[id=${JSON.stringify(attrs['id'])}]`
        : attrs[this.testIdAttribute] ? `[${this.testIdAttribute}=${JSON.stringify(attrs[this.testIdAttribute])}]` : undefined;
      if (anchor !== undefined && frames.length === 0) node.selector = anchor;
      if (secure) {
        delete node.value;
        delete node.selection;
        delete node.text;
        for (const descendant of flatten(node.children)) {
          const mutable = descendant as MutableNode;
          delete mutable.name;
          delete mutable.text;
          delete mutable.value;
          delete mutable.selection;
        }
      } else if (FIELD_ROLES.has(node.role ?? '')) {
        fields.push([id, node]);
      }
    }
    const fieldValues = await this.batch(fields.map(([id]) => `get value @${id}`), context);
    for (const [position, [, node]] of fields.entries()) {
      const result = fieldValues[position];
      if (!isRecord(result) || typeof result['value'] !== 'string') throw malformed();
      node.value = result['value'];
    }
    // Anchors must name exactly one element before they are safe to replay.
    // This also supplies focused/selection metadata without pretending eval
    // can resolve @refs. Binding came from get-attribute on the exact ref.
    const anchored = entries.filter(([, node]) => node.selector !== undefined);
    if (anchored.length > 0) {
      const script = `(() => { const selectors = ${JSON.stringify(anchored.map(([, node]) => node.selector))}; return selectors.map(selector => { const nodes = document.querySelectorAll(selector); if (nodes.length !== 1) return null; const node = nodes[0]; const secure = node.type === 'password' || /(?:^|\\s)(?:current-password|new-password)(?:\\s|$)/i.test(node.getAttribute('autocomplete') || ''); const focused = document.activeElement === node; let selection; if (focused && !secure && typeof node.value === 'string' && typeof node.selectionStart === 'number' && typeof node.selectionEnd === 'number' && node.selectionEnd > node.selectionStart) selection = node.value.slice(node.selectionStart,node.selectionEnd); return {focused,secure,...(selection === undefined ? {} : {selection})}; }); })()`;
      const data = await this.transport.run<{ result?: unknown }>(['eval', script], context, { sensitive: true });
      if (!Array.isArray(data.result) || data.result.length !== anchored.length) throw malformed();
      for (const [position, [, node]] of anchored.entries()) {
        const result: unknown = data.result[position];
        if (result === null) { delete node.selector; continue; }
        if (!isRecord(result) || typeof result['focused'] !== 'boolean' || typeof result['secure'] !== 'boolean') throw malformed();
        node.states = { ...node.states, focused: result['focused'], secure: node.states?.secure === true || result['secure'] };
        if (node.states.secure) { delete node.value; delete node.selection; delete node.text; }
        else if (typeof result['selection'] === 'string') node.selection = result['selection'].slice(0, OBSERVED_TEXT_LIMIT);
      }
    }
  }

  private async batch(commands: readonly string[], context: OperationContext): Promise<readonly unknown[]> {
    if (commands.length === 0) return [];
    const results: unknown[] = [];
    // Keep command lines below conservative platform argv limits. The cap is
    // on transport chunks, never on nodes in the observation.
    for (let offset = 0; offset < commands.length; offset += 128) {
      const chunk = commands.slice(offset, offset + 128);
      const data = await this.transport.run<unknown>(['batch', '--bail', ...chunk], context, { sensitive: true });
      if (!Array.isArray(data) || data.length !== chunk.length) throw malformed();
      results.push(...data);
    }
    return results;
  }
}

/** Parses only structural syntax; raw value suffixes never enter a semantic node. */
function parseSnapshot(raw: RawSnapshot, revision: string): ParsedTree {
  const roots: MutableNode[] = [];
  const refs = new Map<string, MutableNode>();
  const parents = new Map<MutableNode, MutableNode>();
  const stack: { indent: number; node: MutableNode }[] = [];
  let synthetic = 0;
  let incomplete = false;
  for (const line of raw.snapshot.split('\n')) {
    if (line.trim() === '' || line.trim() === '(empty page)' || line.trim() === '(no interactive elements)') continue;
    const match = /^(\s*)- ([^\s[\]":]+)(?: ("(?:\\.|[^"\\])*"))?(.*)$/.exec(line);
    if (!match) { incomplete = true; continue; }
    const indent = match[1]!.length;
    const role = match[2]!;
    const remainder = match[4]!;
    const ref = /(?:\[|,\s*)ref=(e\d+)(?=,|\])/.exec(remainder)?.[1];
    const authoritative = ref === undefined ? undefined : raw.refs[ref];
    if (ref !== undefined && authoritative === undefined) throw malformed();
    let name: string | undefined;
    if (authoritative !== undefined) name = authoritative.name;
    else if (match[3] !== undefined) {
      try {
        const parsedName: unknown = JSON.parse(match[3]);
        if (typeof parsedName !== 'string') throw malformed();
        name = parsedName;
      } catch { throw malformed(); }
    }
    const node: MutableNode = {
      ref: { id: `${revision}:${ref ?? `text:${++synthetic}`}`, revision },
      role: normalizeRole(authoritative?.role ?? role), children: [],
      ...(name === undefined ? {} : { name: name.slice(0, OBSERVED_NAME_LIMIT) }),
      ...((role === 'StaticText' || role === 'text') && name !== undefined ? { text: name.slice(0, OBSERVED_TEXT_LIMIT) } : {}),
    };
    const interaction = /\b(clickable|focusable|editable) \[([^\]]*)\]/.exec(remainder);
    if (interaction !== null) node.attributes = { 'agent-browser:interaction': interaction[1]!, 'agent-browser:hints': interaction[2]! };
    const attrs = remainder.split(': ')[0] ?? '';
    const states: NonNullable<SemanticNode['states']> = {
      ...(/(?:\[|,\s*)disabled(?:,|\])/.test(attrs) ? { disabled: true } : {}),
      ...(/(?:\[|,\s*)selected(?:,|\])/.test(attrs) ? { selected: true } : {}),
      ...(/(?:\[|,\s*)checked=(true|false)(?:,|\])/.test(attrs) ? { checked: /checked=true/.test(attrs) } : {}),
      ...(/(?:\[|,\s*)expanded=(true|false)(?:,|\])/.test(attrs) ? { expanded: /expanded=true/.test(attrs) } : {}),
    };
    node.states = states;
    const level = /(?:\[|,\s*)level=(\d+)(?:,|\])/.exec(attrs)?.[1];
    if (level !== undefined) node.level = Number(level);
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1)?.node;
    if (parent === undefined) roots.push(node);
    else { parent.children.push(node); parents.set(node, parent); }
    stack.push({ indent, node });
    if (ref !== undefined) {
      if (refs.has(ref)) throw malformed();
      refs.set(ref, node);
    }
  }
  // The refs object is authoritative even when upstream's renderer omitted a
  // ref-bearing node. Keeping it is critical for unnamed pointer/font icons.
  for (const [id, rawNode] of Object.entries(raw.refs)) {
    if (refs.has(id)) continue;
    const node: MutableNode = { ref: { id: `${revision}:${id}`, revision }, role: normalizeRole(rawNode.role), name: rawNode.name.slice(0, OBSERVED_NAME_LIMIT), children: [] };
    roots.push(node);
    refs.set(id, node);
  }
  return { roots, refs, parents, incomplete };
}

/** Rejects frame scopes instead of silently running them in the main document. */
function selectorExpressions(expression: LocatorExpression): readonly string[] {
  switch (expression.kind) {
    case 'frame': throw new EngineError('UNSUPPORTED_CAPABILITY', 'agent-browser frame-scoped locators are not implemented', { retryable: false });
    case 'selector': return [expression.selector];
    case 'query': return expression.scope === undefined ? [] : selectorExpressions(expression.scope);
    case 'index': return selectorExpressions(expression.source);
    case 'filter': return [...selectorExpressions(expression.source), ...(expression.has === undefined ? [] : selectorExpressions(expression.has))];
  }
}

/** Preserves the frame element while excluding its separate document from a query. */
function withoutFrameChildren(node: SemanticNode): SemanticNode {
  return { ...node, children: node.role === 'iframe' ? [] : node.children?.map(withoutFrameChildren) ?? [] };
}

/** Returns every node in preorder without a viewport/name filter. */
function flatten(roots: readonly SemanticNode[]): SemanticNode[] {
  return roots.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

/** Finds enclosing frame elements for geometry and replay safety. */
function frameAncestors(node: MutableNode, parents: ReadonlyMap<MutableNode, MutableNode>): MutableNode[] {
  const frames: MutableNode[] = [];
  for (let parent = parents.get(node); parent !== undefined; parent = parents.get(parent)) {
    if (parent.role === 'iframe') frames.unshift(parent);
  }
  return frames;
}

/** Uses only explicit field semantics when authorizing a future secret fill. */
function inputPurpose(attrs: Readonly<Record<string, string>>, role: string | undefined): NonNullable<SemanticNode['inputPurpose']> {
  const tokens = (attrs['autocomplete'] ?? '').toLowerCase().split(/\s+/);
  if (attrs['type']?.toLowerCase() === 'password' || tokens.includes('current-password') || tokens.includes('new-password')) return 'password';
  if (tokens.includes('one-time-code')) return 'one-time-code';
  if (tokens.includes('username')) return 'username';
  return FIELD_ROLES.has(role ?? '') || attrs['contenteditable'] === 'true' ? 'generic-secret' : 'none';
}

/** Normalizes Chrome's two platform spelling differences, leaving other roles intact. */
function normalizeRole(role: string): string {
  if (role === 'StaticText' || role === 'InlineTextBox') return 'text';
  if (role === 'Iframe') return 'iframe';
  return role;
}

/** Restricts bridge data to JSON records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accepts finite CSS pixel coordinates only. */
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Checks a public bounding-box response before exposing it. */
function isRect(value: unknown): value is NonNullable<SemanticNode['rect']> {
  return isRecord(value) && finite(value['x']) && finite(value['y']) && finite(value['width']) && finite(value['height']);
}

/** Sanitized failures never include page text, command output, or selectors. */
function malformed(): EngineError {
  return new EngineError('ENGINE_FAILURE', 'agent-browser returned an invalid observation payload', { retryable: false });
}

/** A stale read may be re-resolved, but no action has been issued here. */
function stale(): EngineError {
  return new EngineError('NODE_STALE', 'The element reference is no longer current', { retryable: true });
}

/** All subprocesses of one observation share the original operation budget. */
function boundedContext(context: OperationContext): OperationContext {
  const timeoutMs = context.timeoutMs;
  const started = performance.now();
  return { ...context, get timeoutMs() { return Math.max(0, timeoutMs - (performance.now() - started)); } };
}

/** Retains refs inside secure controls while omitting their text payloads. */
function scrubSecureSubtrees(roots: readonly MutableNode[], inherited = false): void {
  for (const node of roots) {
    if (inherited) { delete node.name; delete node.text; delete node.value; delete node.selection; }
    const secure = inherited || node.states?.secure === true;
    if (secure) {
      delete node.text;
      delete node.value;
      delete node.selection;
      if (node.attributes !== undefined && Object.hasOwn(node.attributes, 'value')) {
        const attributes = { ...node.attributes };
        delete attributes['value'];
        node.attributes = attributes;
      }
    }
    scrubSecureSubtrees(node.children, secure);
  }
}
