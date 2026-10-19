import { randomUUID } from 'node:crypto';
import { EngineError, type OperationContext } from 'e2e/engine';
import type { CdpConnection } from './cdp.ts';
import { beforeDispatch, bounded } from './budget.ts';

interface Remote { objectId?: string; value?: unknown }
interface Response { result: Remote; exceptionDetails?: unknown }
interface DomNode { backendNodeId: number; nodeName: string; frameId?: string; shadowRootType?: string; shadowRoots?: DomNode[] }
interface FrameTree { frame: { id: string }; childFrames?: FrameTree[] }
interface FocusObject { objectId: string; session: string }
export interface TextFocusOptions {
  readonly cdp: () => Pick<CdpConnection, 'send'>;
  readonly session: () => string;
  readonly frameSession?: (frameId: string, context: OperationContext) => Promise<string>;
}

const noFocus = (): EngineError => new EngineError('NOT_ACTIONABLE', 'No editable control has keyboard focus', { retryable: false });
const CHECK_FOCUS = 'function() { return this.isConnected === true && this.nodeType === 1 && this.getRootNode().activeElement === this; }';
const CHECK_EDITABLE = `function() {
  if (!this.isConnected || this.nodeType !== 1 || this.getRootNode().activeElement !== this) return false;
  if (this.matches(':disabled') || this.readOnly) return false;
  for (let current = this; current; current = current.parentElement || current.getRootNode().host) if (current.inert) return false;
  return this.isContentEditable || this.tagName === 'TEXTAREA' || (this.tagName === 'INPUT' && !['button','submit','reset','checkbox','radio','file','hidden','image','range','color'].includes(this.type));
}`;

/** Reads only the active focus chain, never a different editable field in another frame. */
export async function assertTextFocus(options: TextFocusOptions, context: OperationContext): Promise<void> {
  context = bounded(context);
  beforeDispatch(context);
  const connection = options.cdp();
  const group = `e2e-focus-${randomUUID()}`;
  const sessions = new Set<string>();
  const chain: FocusObject[] = [];
  const seen = new Set<string>();
  const mainSession = options.session();
  const { frameTree } = await connection.send<{ frameTree: FrameTree }>('Page.getFrameTree', {}, context, mainSession);
  const parents = new Map<string, string>();
  const visit = (tree: FrameTree): void => {
    for (const child of tree.childFrames ?? []) { parents.set(child.frame.id, tree.frame.id); visit(child); }
  };
  visit(frameTree);
  const world = async (frameId: string, parentSession: string): Promise<{ session: string; contextId: number }> => {
    let session = parentSession;
    let result: { executionContextId: number };
    try { result = await connection.send('Page.createIsolatedWorld', { frameId, worldName: 'e2e-agent-browser-focus' }, context, session); }
    catch (error) {
      beforeDispatch(context);
      if (frameId === frameTree.frame.id || !options.frameSession) throw error;
      session = await options.frameSession(frameId, context);
      const remote = await connection.send<{ frameTree: FrameTree }>('Page.getFrameTree', {}, context, session);
      if (remote.frameTree.frame.id !== frameId) throw noFocus();
      result = await connection.send('Page.createIsolatedWorld', { frameId, worldName: 'e2e-agent-browser-focus' }, context, session);
    }
    sessions.add(session);
    return { session, contextId: result.executionContextId };
  };
  const call = async (object: FocusObject, source: string, byValue: boolean): Promise<Remote> => {
    const response = await connection.send<Response>('Runtime.callFunctionOn', {
      objectId: object.objectId, functionDeclaration: source, returnByValue: byValue, objectGroup: group,
    }, context, object.session);
    if (response.exceptionDetails) throw noFocus();
    return response.result;
  };
  const active = async (realm: { session: string; contextId: number }): Promise<FocusObject> => {
    const response = await connection.send<Response>('Runtime.evaluate', {
      expression: 'document.activeElement', contextId: realm.contextId, objectGroup: group,
    }, context, realm.session);
    if (response.exceptionDetails || !response.result.objectId) throw noFocus();
    return { objectId: response.result.objectId, session: realm.session };
  };
  try {
    let frameId = frameTree.frame.id;
    let realm = await world(frameId, mainSession);
    let focused = await active(realm);
    for (;;) {
      if ((await call(focused, CHECK_FOCUS, true)).value !== true) throw noFocus();
      const { node } = await connection.send<{ node: DomNode }>('DOM.describeNode', { objectId: focused.objectId, depth: 1, pierce: true }, context, focused.session);
      const identity = `${focused.session}:${node.backendNodeId}`;
      if (seen.has(identity)) throw noFocus();
      seen.add(identity); chain.push(focused);
      const shadow = node.shadowRoots?.find((root) => root.shadowRootType === 'open' || root.shadowRootType === 'closed');
      if (shadow) {
        const resolved = await connection.send<{ object: Remote }>('DOM.resolveNode', {
          backendNodeId: shadow.backendNodeId, executionContextId: realm.contextId, objectGroup: group,
        }, context, focused.session);
        if (!resolved.object.objectId) throw noFocus();
        const inner = await call({ objectId: resolved.object.objectId, session: focused.session }, 'function() { return this.activeElement; }', false);
        if (inner.objectId) { focused = { objectId: inner.objectId, session: focused.session }; continue; }
      }
      if (node.nodeName === 'IFRAME' || node.nodeName === 'FRAME') {
        if (!node.frameId || parents.get(node.frameId) !== frameId) throw noFocus();
        const owner = await connection.send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: node.frameId }, context, focused.session);
        if (owner.backendNodeId !== node.backendNodeId) throw noFocus();
        frameId = node.frameId;
        realm = await world(frameId, focused.session);
        focused = await active(realm);
        continue;
      }
      if ((await call(focused, CHECK_EDITABLE, true)).value !== true) throw noFocus();
      // Reject focus changes or removed ancestors during the multi-command read.
      for (const ancestor of chain) if ((await call(ancestor, CHECK_FOCUS, true)).value !== true) throw noFocus();
      return;
    }
  } finally {
    await Promise.all([...sessions].map((session) => connection.send('Runtime.releaseObjectGroup', { objectGroup: group }, context, session).catch(() => undefined)));
  }
}
