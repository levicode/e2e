/** Deterministic location supplements, never a replacement for agent-browser's default snapshot. */
import { EngineError, OBSERVED_NAME_LIMIT, OBSERVED_TEXT_LIMIT, type LocatorExpression, type OperationContext, type SemanticNode } from 'e2e/engine';
import { readSemanticsFunction } from './in-page/read-semantics.ts';
import { SECURE_FIELD_SELECTOR, type RawNodeData } from './read-node.ts';
import type { CdpConnection } from './cdp.ts';
import type { CliTransport } from './transport.ts';
import type { SnapshotAdapter, SnapshotRef } from './observation.ts';

type Remote = { objectId?: string; value?: unknown; subtype?: string };
type NodeData = { nodeId?: number; backendNodeId: number; nodeName?: string; frameId?: string; children?: NodeData[]; shadowRoots?: NodeData[]; contentDocument?: NodeData };
type FrameTree = { frame: { id: string; parentId?: string; url?: string; loaderId?: string }; childFrames?: FrameTree[] };
type Geometry = { x: number; y: number; scaleX: number; scaleY: number };
type World = { session: string; contextId: number; frameId: string; framePath: readonly string[]; geometry: Geometry | null };
type Scope = { context: OperationContext; root: string; parents: Map<string, string>; frames: Map<string, FrameTree['frame']>; sessions: Map<string, string>; worlds: Map<string, World> };
type Enriched = RawNodeData & { selector?: string; baseURI?: string; frameGeometry?: Geometry | null; frameSelector?: string };
const SECURE = SECURE_FIELD_SELECTOR;
const stale = () => new EngineError('NODE_STALE', 'The exact DOM node is no longer connected', { retryable: true });

/** A structural anchor is independent from a changing name and never invents DOM identity. */
const ANCHOR = `el => {
  const esc = CSS.escape;
  const closed = globalThis[Symbol.for('e2e.closedShadowRoots')];
  const allRoots = [document];
  for (let i=0;i<allRoots.length;i++) for (const node of allRoots[i].querySelectorAll('*')) {
    const root=node.shadowRoot || closed?.get(node); if(root)allRoots.push(root);
  }
  const unique = selector => allRoots.reduce((n,root)=>n+root.querySelectorAll(selector).length,0)===1;
  const own = node => {
    if (node.id && unique('#' + esc(node.id))) return '#' + esc(node.id);
    const id = node.getAttribute(TEST_ID);
    if (id !== null) { const selector = '[' + esc(TEST_ID) + '=' + JSON.stringify(id) + ']'; if (unique(selector)) return selector; }
    return undefined;
  };
  const parts = []; let current = el;
  while (current && current.nodeType === 1) {
    const named = own(current); if (named) return [named, ...parts].join(' > ');
    const parent = current.parentElement; if (!parent) return undefined;
    parts.unshift(current.localName + ':nth-child(' + (Array.from(parent.children).indexOf(current) + 1) + ')'); current = parent;
  }
}`;

/** Parent-frame content origin; translate/scale are supported, rotated/skewed boxes are withheld. */
const FRAME_GEOMETRY = `el => {
  for(let node=el;node;node=node.parentElement){const transform=getComputedStyle(node).transform;if(transform!=='none'){const matrix=new DOMMatrixReadOnly(transform);if(!matrix.is2D || matrix.b!==0 || matrix.c!==0 || matrix.a<=0 || matrix.d<=0)return null;}}
  const r=el.getBoundingClientRect(); const scaleX=el.offsetWidth?r.width/el.offsetWidth:1; const scaleY=el.offsetHeight?r.height/el.offsetHeight:1;
  return {x:r.x+el.clientLeft*scaleX,y:r.y+el.clientTop*scaleY,scaleX,scaleY};
}`;

/** Moves document boundaries outside their narrowing wrappers without changing match order. */
function normalizeFrames(expression: LocatorExpression): LocatorExpression {
  const inside = (source: LocatorExpression, wrap: (value: LocatorExpression) => LocatorExpression): LocatorExpression =>
    source.kind === 'frame' ? { ...source, source: inside(source.source, wrap) } : wrap(source);
  switch (expression.kind) {
    case 'frame': return { ...expression, source: normalizeFrames(expression.source) };
    case 'index': return inside(normalizeFrames(expression.source), source => ({ ...expression, source }));
    case 'filter': {
      if (expression.has && hasFrame(expression.has)) throw new EngineError('UNSUPPORTED_CAPABILITY', 'A has filter cannot cross a document boundary', { retryable: false });
      return inside(normalizeFrames(expression.source), source => ({ ...expression, source }));
    }
    case 'query': return expression.scope ? inside(normalizeFrames(expression.scope), scope => ({ ...expression, scope })) : expression;
    case 'selector': return expression;
  }
}

/** Detects a forbidden cross-document `has` composition, including nested wrappers. */
function hasFrame(expression: LocatorExpression): boolean {
  switch (expression.kind) {
    case 'frame': return true;
    case 'query': return expression.scope ? hasFrame(expression.scope) : false;
    case 'filter': return hasFrame(expression.source) || (expression.has ? hasFrame(expression.has) : false);
    case 'index': return hasFrame(expression.source);
    case 'selector': return false;
  }
}

/** One shrinking budget covers all CDP reads and public ref registrations. */
function boundedContext(context: OperationContext): OperationContext {
  const budget = context.timeoutMs; const started = performance.now();
  return { ...context, get timeoutMs() { return Math.max(0, budget - (performance.now() - started)); } };
}

/** Validate opaque protocol data without letting page exception text enter errors. */
function enriched(value: unknown): Enriched {
  if (!value || typeof value !== 'object' || !('states' in value) || !value.states || typeof value.states !== 'object' ||
      !('attributes' in value) || !value.attributes || typeof value.attributes !== 'object' || !('inputPurpose' in value)) {
    throw new EngineError('ENGINE_FAILURE', 'The semantic reader returned an invalid node', { retryable: false });
  }
  return value as Enriched;
}

/** Source executes atomically in the isolated realm; selected nodes and reads stay paired. */
function querySource(expression: LocatorExpression, testId: string): string {
  return `(() => {
    const TEST_ID = ${JSON.stringify(testId)};
    const read = (${readSemanticsFunction.toString()});
    const anchor = (${ANCHOR});
    const roots = globalThis[Symbol.for('e2e.closedShadowRoots')];
    const shadow = el => el.shadowRoot || roots?.get(el);
    const children = root => { const out = []; for (const el of root.children || []) { out.push(el); out.push(...children(el)); } const sr = root.nodeType === 1 ? shadow(root) : null; if (sr) out.push(...children(sr)); return out; };
    const parent = el => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
    const within = (el, scope) => { for (let p = parent(el); p; p = parent(p)) if (p === scope) return true; return false; };
    const normalize = value => String(value ?? '').replace(/\\s+/gu, ' ').trim();
    const match = (value, pattern) => { const actual = normalize(value); if (pattern.kind === 'regexp') return new RegExp(pattern.source, pattern.flags).test(actual); const expected = normalize(pattern.value); return pattern.exact ? actual === expected : actual.toLowerCase().includes(expected.toLowerCase()); };
    const reads = new Map();
    const data = el => { let value = reads.get(el); if (!value) { value = read(el, { testIdAttribute: TEST_ID, secureFieldSelector: ${JSON.stringify(SECURE)}, mode: {kind:'node'} }); value.selector = anchor(el); value.baseURI=el.baseURI; reads.set(el, value); } return value; };
    const select = (selector, candidates, scope) => {
      if (selector.startsWith('xpath=') || selector.startsWith('//') || selector.startsWith('..') || selector.startsWith('/')) {
        const source = selector.startsWith('xpath=') ? selector.slice(6) : selector;
        const result = document.evaluate(source, scope, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); const found = new Set();
        for (let i=0;i<result.snapshotLength;i++) found.add(result.snapshotItem(i)); return candidates.filter(el=>found.has(el));
      }
      const css = selector.startsWith('css=') ? selector.slice(4) : selector;
      const found = new Set(); const rootsToSearch=[scope];
      for(let i=0;i<rootsToSearch.length;i++) {
        const root=rootsToSearch[i]; for(const el of root.querySelectorAll(css))found.add(el);
        for(const el of root.querySelectorAll('*')){const sr=shadow(el);if(sr)rootsToSearch.push(sr);}
        if(root.nodeType===1){const sr=shadow(root);if(sr)rootsToSearch.push(sr);}
      }
      return candidates.filter(el=>found.has(el));
    };
    const find = (expr, candidates, scope) => {
      switch (expr.kind) {
        case 'selector': return select(expr.selector,candidates,scope);
        case 'index': { const values=find(expr.source,candidates,scope); const i=expr.index==='first'?0:expr.index==='last'?values.length-1:expr.index; return values[i]?[values[i]]:[]; }
        case 'filter': return find(expr.source,candidates,scope).filter(el=>{
          const pool=candidates.filter(child=>within(child,el));
          if(expr.hasText && ![el,...pool].some(child=>{const d=data(child);return [d.name,d.text,d.value].some(v=>v!==null && match(v,expr.hasText));}))return false;
          return !expr.has || find(expr.has,pool,el).length>0;
        });
        case 'query': {
          const scopes=expr.scope?find(expr.scope,candidates,scope):null;
          const pool=scopes?candidates.filter(el=>scopes.some(p=>within(el,p))):candidates;
          const q=expr.query;
          const found=pool.filter(el=>{const d=data(el); if(q.visible && d.states.hidden)return false;
            switch(q.kind){
              case 'role': return !d.states.hidden && match(d.role,q.value) && (!q.name || match(d.name,q.name)) && (q.level===undefined || d.level===q.level) && Object.entries(q.states||{}).every(([k,v])=>(d.states[k]??false)===v);
              case 'label': return el.matches('button,input:not([type="hidden" i]),textarea,select,meter,output,progress,[aria-label],[aria-labelledby]') && (d.labels||[]).some(v=>match(v,q.value));
              case 'text': return d.text!==null && match(d.text,q.value);
              case 'placeholder': return typeof d.attributes.placeholder==='string' && match(d.attributes.placeholder,q.value);
              case 'displayValue': return el.matches('input:not([type="checkbox" i]):not([type="radio" i]),textarea,select') && d.value!==null && match(d.value,q.value);
              case 'testId': return d.testId!==null && match(d.testId,q.value);
            } return false;
          });
          return q.kind==='text'?found.filter(el=>!found.some(child=>within(child,el))):found;
        }
        default: throw new Error('unsupported nested frame expression');
      }
    };
    return find(${JSON.stringify(expression)},children(document),document).map(element=>({element,data:data(element)}));
  })()`;
}

export class LocatorCompanion {
  readonly #cdp: () => Pick<CdpConnection, 'send'>;
  readonly #session: () => string;
  readonly #transport: () => Pick<CliTransport, 'run'>;
  readonly #testId: string;
  readonly #allowFrameUrl: ((url: string) => boolean) | undefined;
  readonly #frameSession: (frameId: string, context: OperationContext) => Promise<string>;
  #nextGroup = 0;
  constructor(options: { cdp: () => Pick<CdpConnection, 'send'>; session: () => string; transport: () => Pick<CliTransport, 'run'>; testIdAttribute?: string; allowFrameUrl?: (url: string) => boolean; frameSession: (frameId: string, context: OperationContext) => Promise<string> }) {
    this.#cdp = options.cdp; this.#session = options.session; this.#transport = options.transport; this.#testId = options.testIdAttribute ?? 'data-testid'; this.#frameSession = options.frameSession; this.#allowFrameUrl = options.allowFrameUrl;
  }

  /** Public snapshot scope includes only exact document loaders approved for model observation. */
  async snapshotArgs(context: OperationContext): Promise<readonly string[]> {
    if (!this.#allowFrameUrl) return [];
    const scope = await this.#scope(context);
    const allowed: Record<string, string> = {};
    const decisions = new Map<string, boolean>();
    const permitted = (id: string): boolean => {
      const previous = decisions.get(id); if (previous !== undefined) return previous;
      const frame = scope.frames.get(id); if (!frame) return false;
      const parent = scope.parents.get(id);
      const inherited = parent ? permitted(parent) : false;
      const url = frame.url ?? '';
      const result = /^about:(blank|srcdoc)(?:[?#]|$)/.test(url) ? inherited : this.#allowFrameUrl!(url);
      decisions.set(id, result);
      return result;
    };
    for (const [id, frame] of scope.frames) if (permitted(id) && frame.loaderId) allowed[id] = frame.loaderId;
    return ['--allowed-frame-documents', JSON.stringify(allowed)];
  }

  async #scope(context: OperationContext): Promise<Scope> {
    context = boundedContext(context);
    const parents = new Map<string, string>();
    const frames = new Map<string, FrameTree['frame']>();
    const sessions = new Map<string, string>();
    const pending: { frameId: string; parentId: string }[] = [];
    const visited = new Set<string>();
    let root = '';
    const bindParent = (id: string, parent: string): void => {
      if (id === parent || (parents.has(id) && parents.get(id) !== parent)) throw new EngineError('FRAME_NOT_FOUND', 'The document ownership changed during capture', { retryable: true });
      parents.set(id, parent);
    };
    const read = async (session: string, expected?: { frameId: string; parentId: string }): Promise<void> => {
      const { frameTree } = await this.#cdp().send<{ frameTree: FrameTree }>('Page.getFrameTree', {}, context, session);
      if (expected && (frameTree.frame.id !== expected.frameId || (frameTree.frame.parentId !== undefined && frameTree.frame.parentId !== expected.parentId))) {
        throw new EngineError('FRAME_NOT_FOUND', 'The nested document session does not match its owner', { retryable: true });
      }
      root ||= frameTree.frame.id;
      const visit = (tree: FrameTree, parent?: string): void => {
        if (parent) bindParent(tree.frame.id, parent);
        frames.set(tree.frame.id, tree.frame);
        for (const child of tree.childFrames ?? []) visit(child, tree.frame.id);
      };
      visit(frameTree, expected?.parentId);
      sessions.set(frameTree.frame.id, session);
      // Chromium's Page.getFrameTree omits RemoteFrame children. DOM frame
      // owners provide the exact boundary; read each proven OOPIF's own tree.
      const { root: document } = await this.#cdp().send<{ root: NodeData }>('DOM.getDocument', { depth: -1, pierce: true }, context, session);
      const owners = (node: NodeData, owner: string): void => {
        const isFrame = node.nodeName?.toLowerCase() === 'iframe' || node.nodeName?.toLowerCase() === 'frame';
        if (isFrame && node.frameId) {
          bindParent(node.frameId, owner);
          if (node.contentDocument) owners(node.contentDocument, node.frameId);
          else if (!frames.has(node.frameId)) pending.push({ frameId: node.frameId, parentId: owner });
        }
        for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) owners(child, owner);
      };
      owners(document, frameTree.frame.id);
    };
    await read(this.#session());
    for (let index = 0; index < pending.length; index += 1) {
      const frame = pending[index]!;
      if (visited.has(frame.frameId) || frames.has(frame.frameId)) continue;
      visited.add(frame.frameId);
      const session = await this.#frameSession(frame.frameId, context);
      await read(session, frame);
    }
    return { context, root, parents, frames, sessions, worlds: new Map() };
  }

  async #world(frameId: string | undefined, scope: Scope): Promise<World> {
    frameId ??= scope.root;
    const existing = scope.worlds.get(frameId); if (existing) return existing;
    const { context } = scope;
    const parentId = scope.parents.get(frameId);
    if (frameId !== scope.root && !parentId) throw new EngineError('FRAME_NOT_FOUND', 'The nested document is not in the active page', { retryable: true });
    const parent = parentId ? await this.#world(parentId, scope) : undefined;
    let session = scope.sessions.get(frameId) ?? parent?.session ?? this.#session();
    let world: { executionContextId: number };
    try { world = await this.#cdp().send('Page.createIsolatedWorld', { frameId, worldName: 'e2e-agent-browser-locators' }, context, session); }
    catch (error) {
      if (context.signal.aborted || context.timeoutMs <= 0 || frameId === scope.root) throw error;
      session = await this.#frameSession(frameId, context);
      world = await this.#cdp().send('Page.createIsolatedWorld', { frameId, worldName: 'e2e-agent-browser-locators' }, context, session);
    }
    const result: World = { session, contextId: world.executionContextId, frameId, framePath: [], geometry: { x: 0, y: 0, scaleX: 1, scaleY: 1 } };
    await this.#closedRoots(result, context);
    if (parent) {
      const owner = await this.#cdp().send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId }, context, parent.session);
      const raw = await this.#describe(owner.backendNodeId, parent, context);
      if (!raw.frameSelector) throw new EngineError('FRAME_NOT_FOUND', 'The nested document owner is unavailable', { retryable: true });
      result.framePath = [...parent.framePath, raw.frameSelector];
      const outer = parent.geometry; const inner = raw.frameGeometry;
      result.geometry = outer && inner ? { x: outer.x + inner.x * outer.scaleX, y: outer.y + inner.y * outer.scaleY, scaleX: outer.scaleX * inner.scaleX, scaleY: outer.scaleY * inner.scaleY } : null;
    }
    scope.worlds.set(frameId, result);
    return result;
  }

  async #closedRoots(world: World, context: OperationContext): Promise<void> {
    const { root } = await this.#cdp().send<{ root: NodeData }>('DOM.getDocument', { depth: -1, pierce: true }, context, world.session);
    const group = `e2e-closed-roots-${++this.#nextGroup}`;
    const visit = async (node: NodeData): Promise<void> => {
      for (const shadow of node.shadowRoots ?? []) {
        try {
          const host = await this.#cdp().send<{ object: Remote }>('DOM.resolveNode', { backendNodeId: node.backendNodeId, executionContextId: world.contextId, objectGroup: group }, context, world.session);
          const inner = await this.#cdp().send<{ object: Remote }>('DOM.resolveNode', { backendNodeId: shadow.backendNodeId, executionContextId: world.contextId, objectGroup: group }, context, world.session);
          if (host.object.objectId && inner.object.objectId) {
            await this.#cdp().send('Runtime.callFunctionOn', { objectId: host.object.objectId, functionDeclaration: "function(root) { if(this.ownerDocument!==document)return; const key=Symbol.for('e2e.closedShadowRoots'); const map=globalThis[key]??(globalThis[key]=new WeakMap()); map.set(this,root); }", arguments: [{ objectId: inner.object.objectId }] }, context, world.session);
          }
        } catch (error) { if (context.signal.aborted || context.timeoutMs <= 0) throw error; /* another document's realm */ }
      }
      for (const child of [...node.children ?? [], ...node.shadowRoots ?? [], ...node.contentDocument ? [node.contentDocument] : []]) await visit(child);
    };
    try { await visit(root); }
    finally { await this.#cdp().send('Runtime.releaseObjectGroup', { objectGroup: group }, context, world.session).catch(() => undefined); }
  }

  async #describe(backend: number, world: World, context: OperationContext): Promise<Enriched> {
    const { object } = await this.#cdp().send<{ object: Remote }>('DOM.resolveNode', { backendNodeId: backend, executionContextId: world.contextId }, context, world.session);
    if (!object.objectId) throw stale();
    try {
      const result = await this.#cdp().send<{ result: Remote; exceptionDetails?: unknown }>('Runtime.callFunctionOn', {
        objectId: object.objectId, functionDeclaration: `function() {
          if(!this.isConnected || this.nodeType!==1 || this.ownerDocument!==document)return null;
          const TEST_ID=${JSON.stringify(this.#testId)};
          const data=(${readSemanticsFunction.toString()})(this,{testIdAttribute:TEST_ID,secureFieldSelector:${JSON.stringify(SECURE)},mode:{kind:'node'}});
          data.selector=(${ANCHOR})(this); data.baseURI=this.baseURI;
          if(this.matches('iframe,frame')) {
            data.frameGeometry=(${FRAME_GEOMETRY})(this);
            data.frameSelector=data.selector;
            if(!data.frameSelector){const parts=[];for(let el=this;el;el=el.parentElement){const parent=el.parentElement;parts.unshift(el.localName+(parent?':nth-child('+(Array.from(parent.children).indexOf(el)+1)+')':''));}const selector=parts.join(' > ');if(document.querySelector(selector)===this)data.frameSelector=selector;}
          }
          return data;
        }`, returnByValue: true,
      }, context, world.session);
      if (result.exceptionDetails || !result.result.value) throw stale();
      return enriched(result.result.value);
    } finally { await this.#cdp().send('Runtime.releaseObject', { objectId: object.objectId }, context, world.session).catch(() => undefined); }
  }

  #project(raw: Enriched, observed: boolean, world: World): Omit<SemanticNode, 'ref' | 'children'> {
    const states: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(raw.states)) if (typeof value === 'boolean') states[key] = value;
    const cut = (value: string, limit: number) => observed ? value.slice(0, limit) : value;
    const attributes: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.attributes)) {
      if (raw.states.secure && ['value', 'aria-valuenow', 'aria-valuetext'].includes(key)) continue;
      if (observed && !['type', 'autocomplete', 'href', 'role', 'placeholder'].includes(key) && !key.startsWith('aria-')) continue;
      if (observed && key === 'href') {
        try { const url = new URL(value, raw.baseURI); attributes[key] = url.origin + url.pathname; } catch { /* malformed URLs are not model input */ }
      } else attributes[key] = value;
    }
    const geometry = world.geometry;
    const rect = raw.rect && geometry ? { x: geometry.x + raw.rect.x * geometry.scaleX, y: geometry.y + raw.rect.y * geometry.scaleY, width: raw.rect.width * geometry.scaleX, height: raw.rect.height * geometry.scaleY } : undefined;
    const checkable = ['checkbox', 'radio'].includes(raw.attributes.type?.toLowerCase() ?? '');
    return {
      ...(raw.role ? { role: raw.role } : {}), ...(raw.name !== null ? { name: cut(raw.name, OBSERVED_NAME_LIMIT) } : {}),
      ...(!raw.states.secure && raw.text !== null ? { text: cut(raw.text, OBSERVED_TEXT_LIMIT) } : {}),
      ...(!raw.states.secure && (!observed || !checkable) && raw.value !== null ? { value: raw.value } : {}),
      ...(!raw.states.secure && raw.selection !== null ? { selection: cut(raw.selection, OBSERVED_TEXT_LIMIT) } : {}),
      ...(raw.testId !== null ? { testId: raw.testId } : {}), inputPurpose: raw.inputPurpose, states,
      ...(raw.level !== null ? { level: raw.level } : {}), attributes,
      ...(rect ? { rect } : {}), ...(raw.selector ? { selector: raw.selector } : {}),
      ...(world.framePath.length ? { framePath: world.framePath } : {}),
    };
  }

  async readMetadata(refs: Readonly<Record<string, SnapshotRef>>, context: OperationContext): Promise<Readonly<Record<string, Omit<SemanticNode, 'ref' | 'children'>>>> {
    const scope = await this.#scope(context);
    const metadata: Record<string, Omit<SemanticNode, 'ref' | 'children'>> = {};
    for (const [id, ref] of Object.entries(refs)) {
      // AX-only entries have no DOM identity. Preserve the ref without inventing a mapping.
      if (typeof ref.backendNodeId !== 'number') { metadata[id] = { role: ref.role, name: ref.name.slice(0, OBSERVED_NAME_LIMIT) }; continue; }
      const world = await this.#world(ref.frameId ?? undefined, scope);
      const raw = await this.#describe(ref.backendNodeId, world, scope.context);
      // Agent-browser owns role/name and includes its unnamed cursor-driven controls.
      metadata[id] = { ...this.#project(raw, true, world), role: ref.role, name: ref.name.slice(0, OBSERVED_NAME_LIMIT) };
    }
    return metadata;
  }

  async #query(expression: LocatorExpression, world: World, context: OperationContext): Promise<{ backend: number; data: Enriched; frameId?: string }[]> {
    const group = `e2e-query-${++this.#nextGroup}`;
    try {
      const result = await this.#cdp().send<{ result: Remote; exceptionDetails?: unknown }>('Runtime.evaluate', { expression: querySource(expression, this.#testId), contextId: world.contextId, returnByValue: false, objectGroup: group }, context, world.session);
      if (result.exceptionDetails || !result.result.objectId) throw new EngineError('ENGINE_FAILURE', 'Locator expression could not be evaluated', { retryable: false });
      const objectId = result.result.objectId;
      const { result: data } = await this.#cdp().send<{ result: Remote }>('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(){return this.map(x=>x.data)}', returnByValue: true }, context, world.session);
      if (!Array.isArray(data.value)) throw new EngineError('ENGINE_FAILURE', 'The locator reader returned invalid metadata', { retryable: false });
      const values: Enriched[] = data.value.map(enriched);
      const properties = await this.#cdp().send<{ result: { name: string; value?: Remote }[] }>('Runtime.getProperties', { objectId, ownProperties: true }, context, world.session);
      const found: { backend: number; data: Enriched; frameId?: string }[] = [];
      for (const property of properties.result.filter((item) => /^\d+$/.test(item.name))) {
        if (!property.value?.objectId) throw stale();
        const { result: element } = await this.#cdp().send<{ result: Remote }>('Runtime.callFunctionOn', { objectId: property.value.objectId, functionDeclaration: 'function(){return this.element}', returnByValue: false, objectGroup: group }, context, world.session);
        if (!element.objectId) throw stale();
        const { node } = await this.#cdp().send<{ node: NodeData }>('DOM.describeNode', { objectId: element.objectId }, context, world.session);
        const raw = values[Number(property.name)]; if (!raw) throw stale();
        found.push({ backend: node.backendNodeId, data: raw, ...(node.frameId ? { frameId: node.frameId } : {}) });
      }
      return found;
    } finally { await this.#cdp().send('Runtime.releaseObjectGroup', { objectGroup: group }, context, world.session).catch(() => undefined); }
  }

  async locate(expression: LocatorExpression, context: OperationContext, adapter: SnapshotAdapter): Promise<readonly SemanticNode[]> {
    expression = normalizeFrames(expression);
    const scope = await this.#scope(context);
    let world = await this.#world(undefined, scope);
    while (expression.kind === 'frame') {
      const matched = await this.#query({ kind: 'selector', selector: expression.selector }, world, scope.context);
      if (matched.length === 0) throw new EngineError('FRAME_NOT_FOUND', 'The nested document was not found', { retryable: true });
      if (matched.length > 1) throw new EngineError('FRAME_AMBIGUOUS', 'More than one nested document matches', { retryable: false });
      const frame = matched[0]!;
      if (!frame.frameId) throw new EngineError('FRAME_NOT_FOUND', 'The matched node has no nested document', { retryable: true });
      const path = [...world.framePath, expression.selector];
      world = await this.#world(frame.frameId, scope); world.framePath = path; expression = expression.source;
    }
    const matched = await this.#query(expression, world, scope.context);
    const entries: { nativeRef: string; node: Omit<SemanticNode, 'ref'> }[] = [];
    for (const match of matched) {
      const result = await this.#transport().run<{ ref: string }>(['ref', String(match.backend), '--frame', world.frameId], scope.context);
      entries.push({ nativeRef: result.ref.replace(/^@/, ''), node: this.#project(match.data, false, world) });
    }
    return adapter.adopt(entries);
  }
}
