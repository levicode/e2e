/** Fail-closed, source-masked viewport capture, independent of agent-browser's semantic snapshot. */
import { randomUUID } from 'node:crypto';
import { EngineError, TestError, type ObservationPixels, type OperationContext } from 'e2e/engine';
import type { CdpConnection } from './cdp.ts';
import { releaseStateProbeTarget, type StateProbeTargets } from './state.ts';

interface FrameTree { frame: { id: string }; childFrames?: FrameTree[] }
interface DomNode {
  nodeType?: number; nodeName?: string; frameId?: string; shadowRootType?: string; backendNodeId?: number;
  children?: DomNode[]; shadowRoots?: DomNode[]; contentDocument?: DomNode;
}
interface Evaluation<T> { result: { value?: T }; exceptionDetails?: unknown }
export interface PixelCapture {
  readonly pixels: ObservationPixels;
  readonly maskedRegionCount: number;
  readonly maskingProven: true;
}
const denied = (): TestError => new TestError('POLICY_DENIED', 'Screenshot masking could not be proven for every frame and editable field');
function frameIds(tree: FrameTree): string[] { return [tree.frame.id, ...(tree.childFrames ?? []).flatMap(frameIds)]; }

interface ClosedShadow { frameId: string; backendNodeId: number }
/** Every child document must be available. Closed roots require explicit CDP resolution before masking. */
export function verifyMaskableDom(root: DomNode, expectedFrames: readonly string[], resolveClosed = false): readonly ClosedShadow[] {
  const documents = new Set<string>();
  const closed: ClosedShadow[] = [];
  const visit = (node: DomNode, parentFrame: string): void => {
    const frame = node.nodeType === 9 ? node.frameId ?? parentFrame : parentFrame;
    if (node.shadowRootType === 'closed') {
      if (!resolveClosed || !node.backendNodeId) throw denied();
      closed.push({ frameId: frame, backendNodeId: node.backendNodeId });
    }
    if (node.nodeType === 9) documents.add(frame);
    if (node.contentDocument) visit(node.contentDocument, node.frameId ?? frame);
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) visit(child, frame);
  };
  if (!expectedFrames[0] || root.nodeType !== 9) throw denied();
  visit(root, expectedFrames[0]);
  if (expectedFrames.some((id) => !documents.has(id))) throw denied();
  return closed;
}

/** PNG bytes, not viewport options, are authoritative for coordinate dimensions. */
export function readPngSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.byteLength < 33) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return null;
  const width = view.getUint32(16); const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

// All editable controls are covered, deliberately a superset of the password-only semantic flag.
// Each frame owns its masks, so frame transforms and scrolling use the browser's own compositor.
const INSTALL_MASKS = `(key) => {
  if (globalThis[key]) throw new Error('mask state already exists');
  const roots = [];
  const closed = new Map((globalThis[key + '_closed'] ?? []).map(root => [root.host, root]));
  const collect = root => {
    roots.push(root);
    for (const node of root.querySelectorAll('*')) { const nested = node.shadowRoot ?? closed.get(node); if (nested) collect(nested); }
  };
  collect(document);
  const selector = 'input,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"],[data-sensitive],[data-private]';
  const masks = [], styles = [], animations = [], svgs = [];
  const state = { masks, styles, animations, svgs, closed, controls: [], roots, selector, count: 0 };
  globalThis[key] = state;
  // Read each shadow root separately: Document.getAnimations does not enumerate its descendants.
  // Save state before the pause stylesheet changes CSS play-state.
  for (const animation of new Set(roots.flatMap(root => root.getAnimations()))) {
    const saved = { animation, playState: animation.playState, playbackRate: animation.playbackRate };
    animations.push(saved); const time = animation.currentTime;
    animation.pause(); animation.playbackRate = 0; if (typeof time === 'number') animation.currentTime = time;
  }
  // Freeze compositor-driven animation as well as JS. New CSS animations stay paused.
  for (const root of roots) {
    const style = document.createElement('style');
    style.textContent = '*,:before,:after{animation-play-state:paused!important;transition-property:none!important;caret-color:transparent!important}';
    (root === document ? document.documentElement : root).append(style); styles.push(style);
    if (!style.sheet || style.sheet.cssRules.length !== 1) throw new Error('animation pause stylesheet was blocked');
    for (const svg of root.querySelectorAll('svg')) if (typeof svg.pauseAnimations === 'function' && !svg.animationsPaused()) { svg.pauseAnimations(); svgs.push(svg); }
  }
  const controls = roots.flatMap(root => Array.from(root.querySelectorAll(selector)));
  state.controls = controls; state.count = controls.length;
  const rects = node => Array.from(node.getClientRects()).filter(r => r.width > 0 && r.height > 0).map(r => [r.left, r.top, r.width, r.height]);
  state.rects = rects;
  for (const node of controls) for (const rect of rects(node)) {
    const mask = document.createElement('div');
    if (typeof mask.showPopover !== 'function') throw new Error('top-layer masks unavailable');
    mask.setAttribute('popover', 'manual');
    mask.setAttribute('aria-hidden', 'true');
    mask.style.cssText = 'all:initial!important;position:fixed!important;display:block!important;box-sizing:border-box!important;margin:0!important;padding:0!important;border:0!important;outline:0!important;background:rgb(0,0,0)!important;opacity:1!important;visibility:visible!important;pointer-events:none!important;transform:none!important;filter:none!important;clip-path:none!important;mix-blend-mode:normal!important;z-index:2147483647!important;';
    mask.style.setProperty('left', rect[0] + 'px', 'important');
    mask.style.setProperty('top', rect[1] + 'px', 'important');
    mask.style.setProperty('width', rect[2] + 'px', 'important');
    mask.style.setProperty('height', rect[3] + 'px', 'important');
    document.documentElement.append(mask); mask.showPopover();
    masks.push({ mask, node, rect });
  }
  return state.count;
}`;
const VERIFY_MASKS = `(key) => {
  const state = globalThis[key]; if (!state) return false;
  const roots = []; const collect = root => { roots.push(root); for (const node of root.querySelectorAll('*')) { const nested = node.shadowRoot ?? state.closed.get(node); if (nested) collect(nested); } }; collect(document);
  const controls = roots.flatMap(root => Array.from(root.querySelectorAll(state.selector)));
  if (controls.length !== state.controls.length || controls.some((node, i) => node !== state.controls[i])) return false;
  if (roots.length !== state.roots.length || roots.some((node, i) => node !== state.roots[i])) return false;
  for (const root of roots) for (const animation of root.getAnimations()) {
    if (!state.animations.some(saved => saved.animation === animation) || animation.playbackRate !== 0) return false;
  }
  let index = 0;
  for (const node of controls) for (const rect of state.rects(node)) {
    const saved = state.masks[index++]; if (!saved || saved.node !== node || rect.some((n, i) => Math.abs(n - saved.rect[i]) > 0.01)) return false;
    const mask = saved.mask; if (!mask.isConnected || !mask.matches(':popover-open')) return false;
    const style = getComputedStyle(mask); const box = mask.getBoundingClientRect();
    if (style.backgroundColor !== 'rgb(0, 0, 0)' || style.opacity !== '1' || style.visibility !== 'visible' || style.display === 'none' || style.filter !== 'none' || style.transform !== 'none' || style.mixBlendMode !== 'normal') return false;
    if ([box.left, box.top, box.width, box.height].some((n, i) => Math.abs(n - rect[i]) > 0.01)) return false;
    // A newer top-layer element must not cover the black mask.
    const x = Math.max(0, Math.min(innerWidth - 1, box.left + box.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, box.top + box.height / 2));
    if (box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight) {
      mask.style.setProperty('pointer-events', 'auto', 'important');
      const covering = document.elementFromPoint(x, y);
      mask.style.setProperty('pointer-events', 'none', 'important');
      if (covering !== mask && !state.masks.some(entry => entry.mask === covering)) return false;
    }
  }
  return index === state.masks.length;
}`;
const REMOVE_MASKS = `(key) => {
  delete globalThis[key + '_closed'];
  const state = globalThis[key]; if (!state) return true;
  for (const entry of state.masks) entry.mask.remove();
  for (const style of state.styles) style.remove();
  for (const saved of state.animations) { saved.animation.playbackRate = saved.playbackRate; if (saved.playState === 'running') saved.animation.play(); else if (saved.playState === 'finished') saved.animation.finish(); }
  for (const svg of state.svgs) svg.unpauseAnimations();
  delete globalThis[key]; return true;
}`;

async function evaluate<T>(cdp: CdpConnection, session: string, contextId: number, expression: string, context: OperationContext): Promise<T> {
  const result = await cdp.send<Evaluation<T>>('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }, context, session);
  if (result.exceptionDetails || result.result.value === undefined) throw denied();
  return result.result.value;
}

interface FrameSession {
  session: string;
  treeFrames: readonly string[];
  documents: readonly string[];
  owners: readonly FrameOwner[];
  closedRoots: readonly ClosedShadow[];
}
interface FrameOwner {
  parentFrameId: string;
  frameId: string;
  backendNodeId: number;
  localDocument: boolean;
}
/** Page.getFrameTree omits remote children; the owning DOM node is the ownership proof. */
function frameOwners(root: DomNode, mainFrame: string): FrameOwner[] {
  const found: FrameOwner[] = [];
  const visit = (node: DomNode, parentFrame: string, parentIsDocument = false): void => {
    const frame = node.nodeType === 9 ? node.frameId ?? parentFrame : parentFrame;
    const name = node.nodeName?.toUpperCase() ?? '';
    const ownerElement = ['IFRAME', 'FRAME', 'FENCEDFRAME'].includes(name);
    // Chromium also puts the containing frame's id on the document element.
    // Only that exact direct-child marker is non-owning; all other frame ids
    // still require a separately inspected child document.
    const documentElement = node.nodeType === 1 && parentIsDocument && node.frameId !== undefined;
    if (documentElement && (node.frameId !== frame || ownerElement || ['OBJECT', 'EMBED', 'PORTAL'].includes(name) || node.contentDocument !== undefined)) throw denied();
    const isOwner = node.nodeType !== 9 && !documentElement && (node.frameId !== undefined || node.contentDocument !== undefined || ownerElement);
    if (isOwner) {
      if (!node.frameId || node.frameId === frame || !Number.isSafeInteger(node.backendNodeId) || node.backendNodeId! <= 0 || found.some(owner => owner.frameId === node.frameId)) throw denied();
      if (node.contentDocument && (node.contentDocument.nodeType !== 9 || (node.contentDocument.frameId !== undefined && node.contentDocument.frameId !== node.frameId))) throw denied();
      found.push({ parentFrameId: frame, frameId: node.frameId, backendNodeId: node.backendNodeId!, localDocument: node.contentDocument !== undefined });
    }
    if (node.contentDocument) visit(node.contentDocument, node.frameId ?? frame);
    for (const child of node.children ?? []) visit(child, frame, node.nodeType === 9);
    for (const shadow of node.shadowRoots ?? []) visit(shadow, frame);
  };
  visit(root, mainFrame);
  return found;
}
function documentFrames(root: DomNode, mainFrame: string): string[] {
  const found: string[] = [];
  const visit = (node: DomNode, parent: string): void => {
    const frame = node.nodeType === 9 ? node.frameId ?? parent : parent;
    if (node.nodeType === 9) found.push(frame);
    if (node.contentDocument) visit(node.contentDocument, node.frameId ?? frame);
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) visit(child, frame);
  };
  visit(root, mainFrame); return found;
}

/**
 * Freeze hides WebContents without changing the selected tab. Activating that already-selected
 * tab can therefore be a no-op. A round trip through an owned blank probe forces WasShown;
 * never activate another application's existing tab or leave focus emulation enabled.
 */
async function restoreVisiblePage(cdp: CdpConnection, targetId: string, session: string, contextId: number, context: OperationContext, probes?: StateProbeTargets): Promise<void> {
  const end = Date.now() + context.timeoutMs;
  const current = (): OperationContext => ({ ...context, timeoutMs: Math.max(0, end - Date.now()) });
  const visible = (): Promise<boolean> => evaluate<boolean>(cdp, session, contextId, 'document.visibilityState === "visible"', current());
  await cdp.send('Page.bringToFront', {}, current(), session);
  if (await visible()) return;
  let probe: string;
  if (probes) probe = await probes.create(current());
  else {
    const target = (await cdp.listTargets(current())).find(item => item.targetId === targetId);
    if (!target) throw denied();
    // Chrome can expose an opaque id for the default context. Only ids returned by
    // getBrowserContexts are accepted as explicit creation scopes; default means omitted.
    const { browserContextIds } = await cdp.send<{ browserContextIds: string[] }>('Target.getBrowserContexts', {}, current());
    if (!Array.isArray(browserContextIds)) throw denied();
    const browserContextId = target.browserContextId && browserContextIds.includes(target.browserContextId) ? target.browserContextId : undefined;
    probe = (await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: true, ...(browserContextId ? { browserContextId } : {}) }, current())).targetId;
  }
  if (!probe || probe === targetId) throw denied();
  let reactivated = false;
  try {
    await cdp.send('Target.activateTarget', { targetId: probe }, current());
    await cdp.send('Target.activateTarget', { targetId }, current()); reactivated = true;
    while (!await visible()) {
      if (Date.now() >= end) throw denied();
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(10, Math.max(0, end - Date.now()))));
    }
  } finally {
    const cleanup = { ...context, signal: new AbortController().signal, timeoutMs: 2_000 };
    try { if (!reactivated) await cdp.send('Target.activateTarget', { targetId }, cleanup); }
    finally {
      await releaseStateProbeTarget(cdp, probe, cleanup, probes);
    }
  }
}

/** The caller must also enforce the attempt's persistent post-secret-fill pixel taint. */
export async function captureMaskedPixels(cdp: CdpConnection, targetId: string, context: OperationContext, probes?: StateProbeTargets): Promise<PixelCapture> {
  const ends = Date.now() + Math.min(context.timeoutMs, 10_000);
  const current = (): OperationContext => ({ ...context, timeoutMs: Math.max(0, ends - Date.now()) });
  const session = await cdp.attachTarget(targetId, current());
  const key = `__e2e_masks_${randomUUID().replaceAll('-', '')}`;
  const installed: { contextId: number; session: string }[] = [];
  const sessions: FrameSession[] = [];
  const attached = new Set([session]);
  let freezeAttempted = false;
  let restoreVisibility = false;
  let mainContextId: number | undefined;
  let cleanupFailed = false;
  let output: PixelCapture | undefined;
  let failure: unknown;
  try {
    const expected = new Set<string>();
    const covered = new Set<string>();
    const ownership = new Map<string, FrameOwner & { session: string }>();
    const readSession = async (sessionId: string, expectedRoot?: string): Promise<void> => {
      await cdp.send('DOM.enable', {}, current(), sessionId);
      const { frameTree } = await cdp.send<{ frameTree: FrameTree }>('Page.getFrameTree', {}, current(), sessionId);
      if (expectedRoot && frameTree.frame.id !== expectedRoot) throw denied();
      const treeFrames = frameIds(frameTree); for (const id of treeFrames) expected.add(id);
      const { root } = await cdp.send<{ root: DomNode }>('DOM.getDocument', { depth: -1, pierce: true }, current(), sessionId);
      const documents = documentFrames(root, frameTree.frame.id);
      const owners = frameOwners(root, frameTree.frame.id);
      if (documents[0] !== frameTree.frame.id || new Set(documents).size !== documents.length) throw denied();
      for (const owner of owners) {
        if (!documents.includes(owner.parentFrameId) || ownership.has(owner.frameId)) throw denied();
        ownership.set(owner.frameId, { ...owner, session: sessionId }); expected.add(owner.frameId);
      }
      if (documents.some((id) => !expected.has(id) || covered.has(id))) throw denied();
      if (documents.slice(1).some(id => !owners.some(owner => owner.frameId === id && owner.localDocument))) throw denied();
      const closedRoots = verifyMaskableDom(root, documents, true);
      for (const id of documents) covered.add(id);
      sessions.push({ session: sessionId, treeFrames, documents, owners, closedRoots });
    };
    await readSession(session);
    // OOPIF documents are absent from the parent's DOM. Resolve only frame targets
    // proved to belong to this page's tree, then inspect those independent renderers.
    while ([...expected].some((id) => !covered.has(id))) {
      const missing = [...expected].filter((id) => !covered.has(id));
      const targets = await cdp.listTargets(current());
      let advanced = false;
      for (const frameId of missing) {
        if (covered.has(frameId)) continue;
        const owner = ownership.get(frameId);
        if (!owner || owner.localDocument || !covered.has(owner.parentFrameId) || !sessions.some(item => item.session === owner.session)) throw denied();
        if (!targets.some((target) => target.type === 'iframe' && target.targetId === frameId)) continue;
        const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: frameId, flatten: true }, current());
        attached.add(sessionId); await readSession(sessionId, frameId); advanced = true;
      }
      if (!advanced) throw denied();
    }
    let count = 0;
    for (const frameSession of sessions) for (const frameId of frameSession.documents) {
      const frameSessionId = frameSession.session;
      const { executionContextId } = await cdp.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
        frameId, worldName: key, grantUniveralAccess: false,
      }, current(), frameSessionId);
      installed.push({ contextId: executionContextId, session: frameSessionId });
      if (frameSessionId === session && frameId === frameSession.documents[0]) {
        const visible = await evaluate<boolean>(cdp, frameSessionId, executionContextId, 'document.visibilityState === "visible"', current());
        if (typeof visible !== 'boolean') throw denied(); restoreVisibility = visible; mainContextId = executionContextId;
      }
      for (const shadow of frameSession.closedRoots.filter((entry) => entry.frameId === frameId)) {
        const { object } = await cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', {
          backendNodeId: shadow.backendNodeId, executionContextId, objectGroup: key,
        }, current(), frameSessionId);
        if (!object.objectId) throw denied();
        const result = await cdp.send<Evaluation<boolean>>('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: 'function(key) { (globalThis[key + "_closed"] ??= []).push(this); return true; }',
          arguments: [{ value: key }], returnByValue: true,
        }, current(), frameSessionId);
        if (result.exceptionDetails || result.result.value !== true) throw denied();
      }
      const added = await evaluate<number>(cdp, frameSessionId, executionContextId, `(${INSTALL_MASKS})(${JSON.stringify(key)})`, current());
      if (!Number.isSafeInteger(added) || added < 0) throw denied(); count += added;
    }
    freezeAttempted = true;
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }, current(), session);
    const verifyAll = async (): Promise<void> => {
      for (const frameSession of sessions) {
        const { root } = await cdp.send<{ root: DomNode }>('DOM.getDocument', { depth: -1, pierce: true }, current(), frameSession.session);
        if (JSON.stringify(frameOwners(root, frameSession.documents[0]!)) !== JSON.stringify(frameSession.owners)) throw denied();
        if (JSON.stringify(verifyMaskableDom(root, frameSession.documents, true)) !== JSON.stringify(frameSession.closedRoots)) throw denied();
        if (JSON.stringify(documentFrames(root, frameSession.documents[0]!)) !== JSON.stringify(frameSession.documents)) throw denied();
        const { frameTree } = await cdp.send<{ frameTree: FrameTree }>('Page.getFrameTree', {}, current(), frameSession.session);
        if (JSON.stringify(frameIds(frameTree)) !== JSON.stringify(frameSession.treeFrames)) throw denied();
      }
      for (const item of installed) if (!await evaluate<boolean>(cdp, item.session, item.contextId, `(${VERIFY_MASKS})(${JSON.stringify(key)})`, current())) throw denied();
    };
    await verifyAll();
    const { cssVisualViewport } = await cdp.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number; pageX: number; pageY: number; scale: number } }>('Page.getLayoutMetrics', {}, current(), session);
    const viewport = cssVisualViewport;
    if (!viewport || !Number.isFinite(viewport.clientWidth) || !Number.isFinite(viewport.clientHeight) || viewport.clientWidth <= 0 || viewport.clientHeight <= 0 || viewport.scale !== 1) throw denied();
    const capture = await cdp.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
      clip: { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight, scale: 1 },
    }, current(), session);
    await verifyAll();
    const data = new Uint8Array(Buffer.from(capture.data, 'base64')); const size = readPngSize(data);
    if (!size || Math.abs(size.width / viewport.clientWidth - size.height / viewport.clientHeight) > 0.01) throw denied();
    output = { pixels: { data, mediaType: 'image/png', ...size, scale: size.width / viewport.clientWidth }, maskedRegionCount: count, maskingProven: true };
  } catch (error) {
    failure = error instanceof EngineError && (error.code === 'CANCELLED' || error.code === 'OPERATION_TIMEOUT') ? error : denied();
  } finally {
    // Cleanup is intentionally independent of an expired/cancelled observation budget.
    const cleanup = { ...context, signal: new AbortController().signal, timeoutMs: 2_000 };
    await Promise.all(installed.map(async (item) => {
      try { await evaluate(cdp, item.session, item.contextId, `(${REMOVE_MASKS})(${JSON.stringify(key)})`, cleanup); } catch { cleanupFailed = true; }
    }));
    await Promise.all([...attached].map(async (sessionId) => { try { await cdp.send('Runtime.releaseObjectGroup', { objectGroup: key }, cleanup, sessionId); } catch { cleanupFailed = true; } }));
    if (freezeAttempted) {
      try { await cdp.send('Page.setWebLifecycleState', { state: 'active' }, cleanup, session); } catch { cleanupFailed = true; }
      // Chromium's freeze also hides WebContents; 'active' alone does not show it again.
      if (restoreVisibility && mainContextId !== undefined) try { await restoreVisiblePage(cdp, targetId, session, mainContextId, cleanup, probes); } catch { cleanupFailed = true; }
    }
    // Each attachment above belongs only to this capture, never the engine's network handlers.
    await Promise.all([...attached].map(async (sessionId) => { try { await cdp.send('Target.detachFromTarget', { sessionId }, cleanup); } catch { cleanupFailed = true; } }));
  }
  if (cleanupFailed) throw denied();
  if (failure) throw failure;
  if (!output) throw denied();
  return output;
}
