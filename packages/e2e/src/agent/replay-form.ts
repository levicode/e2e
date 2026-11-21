import { createHash } from 'node:crypto';
import { relocateDescriptor } from '../cache/relocate.ts';
import type { ActionTrace, TraceTargetDescriptor } from '../cache/trace.ts';
import type { ReplayControlEvidence } from '../engine/index.ts';
import type { SemanticScreen } from './replay.ts';
import { HELD_STILL_MS } from './settle-policy.ts';

/** A predicate on a complete, freshly protected screen. It never returns an action reference. */
export type LocalFormResult = 'ready' | { readonly stableTarget: string } | undefined;
export type LocalFormCheck = ((screen: SemanticScreen) => LocalFormResult) & { readonly sampleControls?: true; readonly opening?: true; readonly handoff?: true };

/** Relocates on the whole current tree before inspecting the signed control facts. */
function uniqueControl(screen: SemanticScreen, descriptor: TraceTargetDescriptor) {
  if (screen.replayControls === undefined || descriptor.position !== undefined) return undefined;
  const match = relocateDescriptor(descriptor, screen.nodes);
  if (match.kind !== 'found') return undefined;
  const node = screen.nodes.get(match.id);
  const control = screen.replayControls[match.id];
  if (!node || !control || node.states?.hidden || node.states?.secure || node.states?.disabled ||
      !node.rect || node.rect.width <= 0 || node.rect.height <= 0) return undefined;
  return { node, control };
}

/** Compares a receiver only within its original document and form. */
function sameReceiver(a: ReplayControlEvidence, b: ReplayControlEvidence): boolean {
  return a.kind === b.kind && a.owner === b.owner && a.target === b.target;
}

/** Equality only, across two complete protected captures. Reference revisions
 * are per-capture. The native form tokens bind the actual control and loader. */
function formScreenDigest(screen: SemanticScreen): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([screen.identityScope, screen.path, screen.viewport]));
  for (const [id, node] of screen.nodes) {
    const { ref, children, ...facts } = node;
    const control = screen.replayControls?.[id];
    const state = control?.kind === 'radio' ? [control.checked, control.hovered] : undefined;
    hash.update(JSON.stringify([id, ref.id, children?.map(child => child.ref.id), facts,
      control && [control.kind, control.owner, control.target, state]]));
  }
  return hash.digest('hex');
}

/** A project evaluation may have changed the page. Require both a full
 * comparison and a fresh protected pair of samples on the unique receiver. */
export function adjacentFormOpening(previous: SemanticScreen, trace: ActionTrace, capturedAt: number): LocalFormCheck | undefined {
  const withinWindow = () => {
    const age = Date.now() - capturedAt;
    return age >= 0 && age <= HELD_STILL_MS;
  };
  const first = trace.actions[0];
  if (!withinWindow() || !previous.identityScope || !trace.startPath || trace.startPath !== previous.path ||
      first?.name !== 'tap' || first.modifiers?.length || first.target.position !== undefined) return undefined;
  const prior = uniqueControl(previous, first.target)?.control;
  if (!prior) return undefined;
  const digest = formScreenDigest(previous);
  const check: LocalFormCheck = current => {
    if (!withinWindow() || current.identityScope !== previous.identityScope || current.path !== previous.path) return undefined;
    const fresh = uniqueControl(current, first.target)?.control;
    if (!fresh?.stable || !sameReceiver(prior, fresh)) return undefined;
    return formScreenDigest(current) === digest ? 'ready' : undefined;
  };
  return Object.assign(check, { opening: true as const, sampleControls: true as const, handoff: true as const });
}

/** Only a single recorded nonempty textbox can establish which field was cleared. */
function changedField(trace: ActionTrace) {
  const fields = trace.goneAnchors?.filter(anchor => anchor.role === 'textbox' && anchor.value);
  return fields?.length === 1 ? fields[0] : undefined;
}

/** Re-find the retained field even when a radio switch mounted a new input in the same form. */
function recordedFieldClear(trace: ActionTrace, start: SemanticScreen | undefined, owner: string) {
  const gone = changedField(trace);
  if (!start || !gone || gone.position !== undefined) return undefined;
  const old = uniqueControl(start, gone);
  if (!old || old.node.value !== gone.value || old.control.owner !== owner || old.control.kind !== 'field') return undefined;
  const retained = trace.endAnchors?.find(anchor => {
    if (anchor.role !== 'textbox' || (anchor.value !== undefined && anchor.value !== '')) return false;
    const field = uniqueControl(start, anchor);
    return field !== undefined && sameReceiver(old.control, field.control);
  });
  if (!retained) return undefined;
  return (screen: SemanticScreen) => {
    const live = uniqueControl(screen, retained);
    return live?.control.kind === 'field' && live.control.owner === owner && live.node.value === '' ? live.control : undefined;
  };
}

/** A first hover can start after two protected samples agree on every recorded control of this form. */
export function localFormOpening(trace: ActionTrace): LocalFormCheck | undefined {
  const [hover, next] = trace.actions;
  if (hover?.name !== 'hover' || next?.name !== 'tap' || !trace.startPath ||
      !trace.actions.every(action => (action.name === 'tap' || action.name === 'hover') &&
        !action.modifiers?.length && action.target.position === undefined)) return undefined;
  const field = changedField(trace);
  if (!field) return undefined;
  const match: LocalFormCheck = screen => {
    if (!screen.identityScope || screen.path !== trace.startPath) return undefined;
    const receiver = uniqueControl(screen, hover.target)?.control;
    const following = uniqueControl(screen, next.target)?.control;
    const priorValue = uniqueControl(screen, field);
    if (receiver?.kind !== 'radio' || receiver.checked || !following || !sameReceiver(receiver, following) ||
        priorValue?.control.kind !== 'field' || !priorValue.control.stable ||
        priorValue.control.owner !== receiver.owner || priorValue.node.value !== field.value) return undefined;
    let otherSelected = false;
    let button = false;
    for (const action of trace.actions) {
      if (action.name !== 'hover' && action.name !== 'tap') return undefined;
      const candidate = uniqueControl(screen, action.target)?.control;
      if (!candidate?.stable || candidate.owner !== receiver.owner) return undefined;
      if (candidate.kind === 'radio' && candidate.checked) otherSelected = true;
      if (candidate.kind === 'button') button = true;
    }
    return otherSelected && button ? 'ready' : undefined;
  };
  return Object.assign(match, { sampleControls: true as const, opening: true as const });
}

/**
 * Local effects with live native evidence: hover then tap the same label,
 * switch between mutually exclusive radios, or validate a cleared field.
 * Labels and buttons are always relocated through the ordinary global policy.
 */
export function localFormTransition(
  trace: ActionTrace, index: number, before: SemanticScreen, actedId: string, start?: SemanticScreen,
): LocalFormCheck | undefined {
  const previous = trace.actions[index];
  const next = trace.actions[index + 1];
  if (!before.replayControls || before.identityScope === undefined || before.path === undefined ||
      (previous?.name !== 'hover' && previous?.name !== 'tap') || next?.name !== 'tap' ||
      previous.modifiers?.length || next.modifiers?.length) return undefined;
  const prior = uniqueControl(before, previous.target);
  const after = uniqueControl(before, next.target);
  if (!prior || prior.node.ref.id !== actedId || prior.control.kind !== 'radio' || !after ||
      prior.control.owner !== after.control.owner) return undefined;
  const radio = prior.control;
  const other = after.control;
  const hovering = previous.name === 'hover';
  let cleared: ReturnType<typeof recordedFieldClear>;
  if (hovering) {
    if (!sameReceiver(radio, other)) return undefined;
  } else if (radio.checked) return undefined;
  else if (other.kind === 'radio') {
    if (!other.checked || sameReceiver(radio, other)) return undefined;
  } else {
    if (other.kind !== 'button' || index + 2 !== trace.actions.length ||
        before.identityScope !== start?.identityScope || before.path !== start.path) return undefined;
    cleared = recordedFieldClear(trace, start, radio.owner);
    if (!cleared) return undefined;
  }
  const check: LocalFormCheck = screen => {
    if (screen.identityScope !== before.identityScope || screen.path !== before.path ||
        screen.viewport.width !== before.viewport.width || screen.viewport.height !== before.viewport.height) return undefined;
    const previousNow = uniqueControl(screen, previous.target)?.control;
    const nextNow = uniqueControl(screen, next.target)?.control;
    if (previousNow?.kind !== 'radio' || !nextNow || !sameReceiver(radio, previousNow) ||
        !sameReceiver(other, nextNow)) return undefined;
    if (hovering) return previousNow.hovered && previousNow.checked === radio.checked ? 'ready' : undefined;
    if (!previousNow.checked) return undefined;
    if (nextNow.kind === 'radio') return !nextNow.checked ? 'ready' : undefined;
    const field = cleared?.(screen);
    if (!field) return undefined;
    return field.stable && previousNow.stable && nextNow.stable ? 'ready' : { stableTarget: field.target };
  };
  return cleared === undefined ? check : Object.assign(check, { sampleControls: true as const });
}
