/** Fail-closed, source-masked viewport capture, independent of agent-browser's semantic snapshot. */
import { randomUUID } from 'node:crypto';
import { EngineError, TestError, type ObservationPixels, type OperationContext } from 'e2e/engine';
import type { CdpConnection } from './cdp.ts';
import { releaseStateProbeTarget, type StateProbeTargets } from './state.ts';
import { verifyPngMaskProof } from './png-mask-proof.ts';

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
type PngFailureReason = Extract<ReturnType<typeof verifyPngMaskProof>, { ok: false }>['reason'];
type OwnerFailure = 'unsupported-owner-type' | 'unsupported-owner-document' | 'transformed-owner' | 'owner-viewport-mismatch';
type PixelPhase = OwnerFailure | `geometry-before-${OwnerFailure}` | `geometry-after-${OwnerFailure}` | 'operation' | 'inventory-main' | 'inventory-remote' | 'inventory-stability' | 'world' | 'closed-shadow' | 'mask-install' | 'freeze'
  | 'verify-before-owners' | 'verify-before-shadows' | 'verify-before-documents' | 'verify-before-trees' | 'verify-before-masks'
  | 'verify-after-owners' | 'verify-after-shadows' | 'verify-after-documents' | 'verify-after-trees' | 'verify-after-masks'
  | 'paint' | 'geometry-before' | 'geometry-after' | `pixel-proof-${PngFailureReason}` | 'pixel-proof' | 'viewport' | 'capture' | 'png' | 'cleanup-masks' | 'cleanup-objects' | 'cleanup-active' | 'cleanup-visible' | 'cleanup-tasks' | 'cleanup-detach';
const denied = (phase: PixelPhase = 'operation'): TestError => new TestError('POLICY_DENIED', `Screenshot masking could not be proven for every frame and editable field (${phase})`);
class InventoryNotReady extends Error {}
class OwnerProofFailure extends Error {
  readonly reason: OwnerFailure;
  constructor(reason: OwnerFailure) { super(reason); this.reason = reason; }
}
// One allowlist governs inventory and the function executed on each resolved owner.
const SUPPORTED_DOCUMENT_OWNERS = ['IFRAME', 'FRAME', 'OBJECT'] as const;
type DocumentOwnerKind = typeof SUPPORTED_DOCUMENT_OWNERS[number];
const DOCUMENT_OWNER_ELEMENTS = new Set<string>([...SUPPORTED_DOCUMENT_OWNERS, 'FENCEDFRAME', 'EMBED', 'PORTAL']);
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
    // Pad beyond the sensitive rectangle so every intersecting screenshot pixel is
    // opaque black, including fractional CSS coordinates and device-scale edges.
    const maskRect = [Math.floor(rect[0]) - 2, Math.floor(rect[1]) - 2, Math.ceil(rect[0] + rect[2]) - Math.floor(rect[0]) + 4, Math.ceil(rect[1] + rect[3]) - Math.floor(rect[1]) + 4];
    mask.style.setProperty('left', maskRect[0] + 'px', 'important');
    mask.style.setProperty('top', maskRect[1] + 'px', 'important');
    mask.style.setProperty('width', maskRect[2] + 'px', 'important');
    mask.style.setProperty('height', maskRect[3] + 'px', 'important');
    document.documentElement.append(mask); mask.showPopover();
    masks.push({ mask, node, rect, maskRect });
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
    if ([box.left, box.top, box.width, box.height].some((n, i) => Math.abs(n - saved.maskRect[i]) > 0.01)) return false;
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
const MASK_GEOMETRY = `(key) => {
  const state = globalThis[key]; if (!state) return null;
  const viewport = globalThis.visualViewport;
  if (viewport && (viewport.scale !== 1 || viewport.offsetLeft !== 0 || viewport.offsetTop !== 0)) return null;
  // Cover the verification tolerance too; never narrow proof to a center sample.
  return { contentType: document.contentType, width: innerWidth, height: innerHeight, rectangles: state.masks.map(entry => ({ x: entry.rect[0] - 0.02, y: entry.rect[1] - 0.02, width: entry.rect[2] + 0.04, height: entry.rect[3] + 0.04 })) };
}`;
// A frame's content viewport is translated into its parent's viewport. More complex
// transforms require a separately proven projection; never guess screen coordinates.
const FRAME_GEOMETRY = `function() {
  if (!this.isConnected) return null;
  if (!${JSON.stringify(SUPPORTED_DOCUMENT_OWNERS)}.includes(this.tagName)) return { reason: 'unsupported-owner-type' };
  for (let node = this; node; node = node.parentElement ?? node.getRootNode().host) {
    const style = getComputedStyle(node);
    if (style.transform !== 'none' || style.perspective !== 'none' || style.rotate !== 'none' || style.scale !== 'none' || style.translate !== 'none' || Number(style.zoom) !== 1) return { reason: 'transformed-owner' };
  }
  const box = this.getBoundingClientRect(); const style = getComputedStyle(this);
  const left = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
  const top = parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
  const right = parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight);
  const bottom = parseFloat(style.borderBottomWidth) + parseFloat(style.paddingBottom);
  return { x: box.left + left, y: box.top + top, width: box.width - left - right, height: box.height - top - bottom };
}`;
interface MaskRectangle { x: number; y: number; width: number; height: number }
interface MaskGeometry { contentType: string; width: number; height: number; rectangles: MaskRectangle[] }
function validRectangle(value: MaskRectangle): boolean {
  return value !== null && typeof value === 'object' && [value.x, value.y, value.width, value.height].every(Number.isFinite) && value.width > 0 && value.height > 0;
}
function clipRectangle(rect: MaskRectangle, width: number, height: number): MaskRectangle | undefined {
  const x = Math.max(0, rect.x); const y = Math.max(0, rect.y);
  const right = Math.min(width, rect.x + rect.width); const bottom = Math.min(height, rect.y + rect.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}

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
  kind: DocumentOwnerKind;
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
    const ownerElement = DOCUMENT_OWNER_ELEMENTS.has(name);
    // Chromium also puts the containing frame's id on the document element.
    // Only that exact direct-child marker is non-owning; all other frame ids
    // still require a separately inspected child document.
    const documentElement = node.nodeType === 1 && parentIsDocument && node.frameId !== undefined;
    if (documentElement && (node.frameId !== frame || ownerElement || node.contentDocument !== undefined)) throw denied();
    const isOwner = node.nodeType !== 9 && !documentElement && (node.frameId !== undefined || node.contentDocument !== undefined || ownerElement);
    if (isOwner) {
      if (!(SUPPORTED_DOCUMENT_OWNERS as readonly string[]).includes(name)) throw new OwnerProofFailure('unsupported-owner-type');
      if (name === 'OBJECT' && !node.frameId) throw new OwnerProofFailure('unsupported-owner-document');
      if (!node.frameId || node.frameId === frame || !Number.isSafeInteger(node.backendNodeId) || node.backendNodeId! <= 0 || found.some(owner => owner.frameId === node.frameId)) throw denied();
      if (node.contentDocument && (node.contentDocument.nodeType !== 9 || (node.contentDocument.frameId !== undefined && node.contentDocument.frameId !== node.frameId))) throw denied();
      found.push({ kind: name as DocumentOwnerKind, parentFrameId: frame, frameId: node.frameId, backendNodeId: node.backendNodeId!, localDocument: node.contentDocument !== undefined });
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
  const installed: { contextId: number; session: string; frameId: string }[] = [];
  const sessions: FrameSession[] = [];
  const attached = new Set([session]);
  let freezeAttempted = false;
  let restoreVisibility = false;
  let mainContextId: number | undefined;
  let cleanupFailure: PixelPhase | undefined;
  let phase: PixelPhase = 'inventory-main';
  let output: PixelCapture | undefined;
  let failure: unknown;
  try {
    const expected = new Set<string>();
    const covered = new Set<string>();
    const ownership = new Map<string, FrameOwner & { session: string }>();
    const frameSessions = new Map<string, string>();
    const enabled = new Set<string>();
    const readSession = async (sessionId: string, expectedRoot?: string): Promise<void> => {
      if (!enabled.has(sessionId)) { await cdp.send('DOM.enable', {}, current(), sessionId); enabled.add(sessionId); }
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
    const inventoryMatches = async (frameSession: FrameSession, stage: 'inventory-stability' | 'verify-before' | 'verify-after'): Promise<boolean> => {
      phase = stage === 'inventory-stability' ? stage : `${stage}-owners`;
      const { root } = await cdp.send<{ root: DomNode }>('DOM.getDocument', { depth: -1, pierce: true }, current(), frameSession.session);
      if (JSON.stringify(frameOwners(root, frameSession.documents[0]!)) !== JSON.stringify(frameSession.owners)) return false;
      phase = stage === 'inventory-stability' ? stage : `${stage}-shadows`;
      if (JSON.stringify(verifyMaskableDom(root, frameSession.documents, true)) !== JSON.stringify(frameSession.closedRoots)) return false;
      phase = stage === 'inventory-stability' ? stage : `${stage}-documents`;
      if (JSON.stringify(documentFrames(root, frameSession.documents[0]!)) !== JSON.stringify(frameSession.documents)) return false;
      phase = stage === 'inventory-stability' ? stage : `${stage}-trees`;
      const { frameTree } = await cdp.send<{ frameTree: FrameTree }>('Page.getFrameTree', {}, current(), frameSession.session);
      return JSON.stringify(frameIds(frameTree)) === JSON.stringify(frameSession.treeFrames);
    };
    // Remote targets and DOM owners arrive through independent protocol streams. Establish
    // a stable complete inventory before any mask or lifecycle mutation. A failed masked
    // proof is never retried, and no bytes from such a proof can escape.
    const inventoryEnd = Math.min(ends, Date.now() + 2_000);
    while (true) {
      expected.clear(); covered.clear(); ownership.clear(); sessions.length = 0;
      try {
        phase = 'inventory-main'; await readSession(session);
        // OOPIF documents are absent from the parent's DOM. Resolve only exact DOM owners.
        while ([...expected].some((id) => !covered.has(id))) {
          phase = 'inventory-remote';
          const missing = [...expected].filter((id) => !covered.has(id));
          const targets = await cdp.listTargets(current());
          let advanced = false;
          for (const frameId of missing) {
            if (covered.has(frameId)) continue;
            const owner = ownership.get(frameId);
            if (!owner || owner.localDocument || !covered.has(owner.parentFrameId) || !sessions.some(item => item.session === owner.session)) throw denied();
            if (!targets.some((target) => target.type === 'iframe' && target.targetId === frameId)) continue;
            let childSession = frameSessions.get(frameId);
            if (!childSession) {
              childSession = (await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: frameId, flatten: true }, current())).sessionId;
              frameSessions.set(frameId, childSession); attached.add(childSession);
            }
            await readSession(childSession, frameId); advanced = true;
          }
          if (!advanced) throw new InventoryNotReady();
        }
        for (const frameSession of sessions) if (!await inventoryMatches(frameSession, 'inventory-stability')) throw new InventoryNotReady();
        break;
      } catch (error) {
        if (!(error instanceof InventoryNotReady) || Date.now() >= inventoryEnd) throw error;
        if (context.signal.aborted) throw new EngineError('CANCELLED', 'Screenshot masking cancelled', { retryable: false });
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(20, Math.max(0, inventoryEnd - Date.now()))));
      }
    }
    let count = 0;
    for (const frameSession of sessions) for (const frameId of frameSession.documents) {
      const frameSessionId = frameSession.session; phase = 'world';
      const { executionContextId } = await cdp.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
        frameId, worldName: key, grantUniveralAccess: false,
      }, current(), frameSessionId);
      installed.push({ contextId: executionContextId, session: frameSessionId, frameId });
      if (frameSessionId === session && frameId === frameSession.documents[0]) {
        const visible = await evaluate<boolean>(cdp, frameSessionId, executionContextId, 'document.visibilityState === "visible"', current());
        if (typeof visible !== 'boolean') throw denied(); restoreVisibility = visible; mainContextId = executionContextId;
      }
      if (ownership.get(frameId)?.kind === 'OBJECT' && !await evaluate<boolean>(cdp, frameSessionId, executionContextId, `document.contentType === 'text/html'`, current())) throw new OwnerProofFailure('unsupported-owner-document');
      phase = 'closed-shadow';
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
      phase = 'mask-install';
      const added = await evaluate<number>(cdp, frameSessionId, executionContextId, `(${INSTALL_MASKS})(${JSON.stringify(key)})`, current());
      if (!Number.isSafeInteger(added) || added < 0) throw denied(); count += added;
    }
    phase = 'paint';
    // DOM/layout acknowledgement does not mean the compositor has painted the new
    // overlays. Give every inspected renderer a complete frame before hiding it.
    await Promise.all(installed.map(async item => {
      if (await evaluate<boolean>(cdp, item.session, item.contextId, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))', current()) !== true) throw denied();
    }));
    const collectGeometry = async (): Promise<{ frames: [string, MaskGeometry][]; offsets: [string, MaskRectangle][]; rectangles: MaskRectangle[] }> => {
      const frames = new Map<string, MaskGeometry>(); const offsets = new Map<string, MaskRectangle>();
      for (const item of installed) {
        const geometry = await evaluate<MaskGeometry>(cdp, item.session, item.contextId, `(${MASK_GEOMETRY})(${JSON.stringify(key)})`, current());
        if (!geometry || !Number.isFinite(geometry.width) || !Number.isFinite(geometry.height) || geometry.width <= 0 || geometry.height <= 0 || !Array.isArray(geometry.rectangles) || !geometry.rectangles.every(validRectangle)) throw denied();
        frames.set(item.frameId, geometry);
      }
      for (const [frameId, owner] of ownership) {
        const parent = installed.find(item => item.frameId === owner.parentFrameId && item.session === owner.session);
        const child = frames.get(frameId); if (!parent || !child) throw denied();
        // A plugin, PDF, image or SVG is not the proven HTML browsing-context geometry.
        if (owner.kind === 'OBJECT' && child.contentType !== 'text/html') throw new OwnerProofFailure('unsupported-owner-document');
        const { object } = await cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: owner.backendNodeId, executionContextId: parent.contextId, objectGroup: key }, current(), parent.session);
        if (!object.objectId) throw denied();
        const answer = await cdp.send<Evaluation<MaskRectangle | { reason: OwnerFailure }>>('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: FRAME_GEOMETRY, returnByValue: true }, current(), parent.session);
        const rectangle = answer.result.value;
        if (answer.exceptionDetails || !rectangle) throw denied();
        if ('reason' in rectangle) {
          if (rectangle.reason === 'unsupported-owner-type' || rectangle.reason === 'transformed-owner') throw new OwnerProofFailure(rectangle.reason);
          throw denied();
        }
        if (!validRectangle(rectangle)) throw denied();
        if (rectangle.width !== child.width || rectangle.height !== child.height) throw new OwnerProofFailure('owner-viewport-mismatch');
        offsets.set(frameId, rectangle);
      }
      const mainFrame = sessions[0]!.documents[0]!; const rectangles: MaskRectangle[] = [];
      for (const [frameId, geometry] of frames) for (const rectangle of geometry.rectangles) {
        let visible = clipRectangle(rectangle, geometry.width, geometry.height); let frame = frameId; const visited = new Set<string>();
        while (visible && frame !== mainFrame) {
          if (visited.has(frame)) throw denied(); visited.add(frame);
          const offset = offsets.get(frame); const owner = ownership.get(frame); if (!offset || !owner) throw denied();
          const parent = frames.get(owner.parentFrameId); if (!parent) throw denied();
          visible = clipRectangle({ ...visible, x: visible.x + offset.x, y: visible.y + offset.y }, parent.width, parent.height); frame = owner.parentFrameId;
        }
        if (visible) rectangles.push(visible);
      }
      return { frames: [...frames], offsets: [...offsets], rectangles };
    };
    freezeAttempted = true; phase = 'freeze';
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }, current(), session);
    const verifyAll = async (stage: 'verify-before' | 'verify-after'): Promise<void> => {
      for (const frameSession of sessions) if (!await inventoryMatches(frameSession, stage)) throw denied();
      phase = `${stage}-masks`;
      for (const item of installed) if (!await evaluate<boolean>(cdp, item.session, item.contextId, `(${VERIFY_MASKS})(${JSON.stringify(key)})`, current())) throw denied();
    };
    await verifyAll('verify-before'); phase = 'geometry-before';
    const geometry = await collectGeometry(); phase = 'viewport';
    const { cssVisualViewport } = await cdp.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number; pageX: number; pageY: number; scale: number } }>('Page.getLayoutMetrics', {}, current(), session);
    const viewport = cssVisualViewport;
    if (!viewport || !Number.isFinite(viewport.clientWidth) || !Number.isFinite(viewport.clientHeight) || viewport.clientWidth <= 0 || viewport.clientHeight <= 0 || viewport.scale !== 1) throw denied();
    phase = 'capture';
    const capture = await cdp.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
      clip: { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight, scale: 1 },
    }, current(), session);
    await verifyAll('verify-after'); phase = 'geometry-after';
    if (JSON.stringify(await collectGeometry()) !== JSON.stringify(geometry)) throw denied();
    phase = 'png';
    const data = new Uint8Array(Buffer.from(capture.data, 'base64')); const size = readPngSize(data);
    if (!size || size.width * viewport.clientHeight !== size.height * viewport.clientWidth) throw denied();
    phase = 'pixel-proof';
    const scale = size.width / viewport.clientWidth;
    const rectangles = geometry.rectangles.map(rectangle => ({ x: rectangle.x * scale, y: rectangle.y * scale, width: rectangle.width * scale, height: rectangle.height * scale }));
    const proof = verifyPngMaskProof(data, { expectedWidth: size.width, expectedHeight: size.height, rectangles });
    if (!proof.ok) { phase = `pixel-proof-${proof.reason}`; throw denied(); }
    output = { pixels: { data, mediaType: 'image/png', ...size, scale: size.width / viewport.clientWidth }, maskedRegionCount: count, maskingProven: true };
  } catch (error) {
    if (error instanceof OwnerProofFailure) phase = phase === 'geometry-before' || phase === 'geometry-after' ? `${phase}-${error.reason}` : error.reason;
    failure = error instanceof EngineError && (error.code === 'CANCELLED' || error.code === 'OPERATION_TIMEOUT') ? error : denied(phase);
  } finally {
    // Cleanup is intentionally independent of an expired/cancelled observation budget.
    const cleanup = { ...context, signal: new AbortController().signal, timeoutMs: 2_000 };
    await Promise.all(installed.map(async (item) => {
      try { await evaluate(cdp, item.session, item.contextId, `(${REMOVE_MASKS})(${JSON.stringify(key)})`, cleanup); } catch { cleanupFailure ??= 'cleanup-masks'; }
    }));
    await Promise.all([...attached].map(async (sessionId) => { try { await cdp.send('Runtime.releaseObjectGroup', { objectGroup: key }, cleanup, sessionId); } catch { cleanupFailure ??= 'cleanup-objects'; } }));
    if (freezeAttempted) {
      try { await cdp.send('Page.setWebLifecycleState', { state: 'active' }, cleanup, session); } catch { cleanupFailure ??= 'cleanup-active'; }
      // Chromium's freeze also hides WebContents; 'active' alone does not show it again.
      if (restoreVisibility && mainContextId !== undefined) try { await restoreVisiblePage(cdp, targetId, session, mainContextId, cleanup, probes); } catch { cleanupFailure ??= 'cleanup-visible'; }
      // Debugger evaluation and visibility reads run even while ordinary page tasks are
      // frozen. A timer acknowledgement proves each inspected renderer resumed its task
      // queues before the caller can issue its next navigation. No application data is read.
      await Promise.all(installed.map(async item => {
        try {
          if (await evaluate<boolean>(cdp, item.session, item.contextId, 'new Promise(resolve => setTimeout(() => resolve(true), 0))', cleanup) !== true) cleanupFailure ??= 'cleanup-tasks';
        } catch { cleanupFailure ??= 'cleanup-tasks'; }
      }));
    }
    // Each attachment above belongs only to this capture, never the engine's network handlers.
    await Promise.all([...attached].map(async (sessionId) => { try { await cdp.send('Target.detachFromTarget', { sessionId }, cleanup); } catch { cleanupFailure ??= 'cleanup-detach'; } }));
  }
  if (cleanupFailure) throw denied(cleanupFailure);
  if (failure) throw failure;
  if (!output) throw denied();
  return output;
}
