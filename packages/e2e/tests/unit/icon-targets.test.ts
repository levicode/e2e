/** An icon-only control: the page's own identifiers identify a target no role, name, or text can. */

import { describe, expect, it } from 'vitest';
import { describeAction, describeTarget } from '../../src/agent/actions.ts';
import { describePosition, isRelocatableDescriptor, relocateDescriptor } from '../../src/cache/relocate.ts';
import { TraceRecorder } from '../../src/cache/recorder.ts';
import { expandTrace, templateTrace } from '../../src/cache/template.ts';
import { buildTraceEntry, readTraceEntry, type TraceTargetDescriptor } from '../../src/cache/trace.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import type { RedactedNode } from '../../src/agent/observation.ts';
import { redacted, redactedNodes } from '../helpers/redacted.ts';

const NO_REDACT = { redact: (text: string) => text, redactCut: (text: string) => text };

/** The engine state the web engine reports for an unnamed action target. */
function clickable(): NonNullable<SemanticNode['states']> & { readonly clickable: boolean } {
  return { clickable: true };
}

/** An icon-only control: no role, name, or text, with whatever the page attributes it by. */
function icon(id: string, attributes: Record<string, string>): SemanticNode {
  return { ref: { id, revision: 'r' }, states: clickable(), attributes };
}

/** An unnamed action target the page gives no attribute at all. */
function bare(id: string): SemanticNode {
  return { ref: { id, revision: 'r' }, states: clickable() };
}

function screen(...list: SemanticNode[]): ReadonlyMap<string, RedactedNode> {
  return redactedNodes(list);
}

function tapTrace(node: RedactedNode) {
  const recorder = new TraceRecorder(NO_REDACT);
  recorder.record({ name: 'tap', node });
  const trace = recorder.finalize({
    executor: { name: 'test' },
    recordedFor: { testId: 't', targetId: 'web', instructionDigest: 'c'.repeat(64) },
    summary: 'added a tag',
  });
  expect(trace).toBeDefined();
  return { recorder, trace: trace! };
}

describe('an icon-only control', () => {
  it('records the page id it is told apart by, and falls back to its class when the page gives no id', () => {
    const withId = describeTarget(redacted(icon('i1', { id: 'tag-add', class: 'icon icon-add' })));
    expect(withId).toEqual({ domId: 'tag-add' });
    const classOnly = describeTarget(redacted(icon('i2', { class: 'icon icon-add' })));
    expect(classOnly).toEqual({ domClass: 'icon icon-add' });
  });

  it('leaves a named control alone, and an unnamed one that is not an action target', () => {
    expect(describeTarget(redacted({ ref: { id: 'b', revision: 'r' }, role: 'button', name: 'Add', attributes: { class: 'icon add', id: 'add' } }))).toEqual({
      role: 'button',
      name: 'Add',
    });
    // A form field can carry a class too; only an anonymous *action target* is
    // identified by the page's attributes, so its position-based recording is
    // unchanged.
    const field = redacted({ ref: { id: 'f', revision: 'r' }, role: 'textbox', attributes: { class: 'field' } });
    expect(describeTarget(field)).toEqual({ role: 'textbox' });
    expect(isRelocatableDescriptor(describeTarget(field)!)).toBe(false);
  });

  it('reads as a target in the action prose instead of "the screen"', () => {
    const { summary } = describeAction({ name: 'tap', node: redacted(icon('i1', { id: 'tag-add' })) }, NO_REDACT);
    expect(summary).toBe('tap node "tag-add"');
  });

  it('relocates by that identifier in a fresh observation, and never to a named control', () => {
    const live = screen(icon('n1', { id: 'tag-add' }), icon('n2', { id: 'tag-close' }));
    expect(relocateDescriptor({ domId: 'tag-add' } as TraceTargetDescriptor, live)).toEqual({ kind: 'found', id: 'n1' });
    expect(relocateDescriptor({ domId: 'tag-gone' } as TraceTargetDescriptor, live)).toEqual({ kind: 'failed', failure: 'target-not-found' });
    // A named "Add" button with the same icon class is another control.
    const named = screen({ ref: { id: 'n3', revision: 'r' }, role: 'button', name: 'Add', attributes: { class: 'icon add' } });
    expect(relocateDescriptor({ domClass: 'icon add' } as TraceTargetDescriptor, named)).toEqual({ kind: 'failed', failure: 'target-not-found' });
  });

  it('records its place among icons the same class describes, so twins resolve as they did', () => {
    const twins = screen(
      icon('n1', { class: 'icon icon-add' }),
      icon('n2', { class: 'icon icon-add' }),
      icon('n3', { id: 'tag-close' }),
    );
    const position = describePosition(twins.get('n2')!, undefined, twins);
    expect(position).toEqual({ index: 1, of: 2 });
    const recorded: TraceTargetDescriptor = { domClass: 'icon icon-add', position: position! };
    const found = relocateDescriptor(recorded, screen(icon('n4', { class: 'icon icon-add' }), icon('n5', { class: 'icon icon-add' })));
    expect(found).toEqual({ kind: 'found', id: 'n5' });
    // A lone match is still the class's only control, as for any named target
    // with a recorded position.
    expect(relocateDescriptor(recorded, screen(icon('n4', { class: 'icon icon-add' }), icon('n6', { id: 'tag-close' })))).toEqual({
      kind: 'found',
      id: 'n4',
    });
  });

  it('keeps the identifier through the trace round-trip and templates a value spelled inside it', () => {
    const { trace } = tapTrace(redacted(icon('i1', { id: 'tag-add' })));
    const entry = readTraceEntry(JSON.parse(JSON.stringify(buildTraceEntry(trace))));
    expect(entry?.payload.actions[0]).toMatchObject({ name: 'tap', target: { domId: 'tag-add' } });

    const templated = templateTrace({ ...trace, actions: [{ name: 'tap', summary: 'tap node "tag-E2E 42"', target: { domId: 'tag-E2E 42' } }] }, [
      { pointer: '/name', value: 'E2E 42' },
    ]);
    expect(templated?.actions[0]).toMatchObject({ target: { domId: 'tag-{{param:/name}}' } });
    expect(expandTrace(templated!, [{ pointer: '/name', value: 'E2E 43' }])?.actions[0]).toMatchObject({ target: { domId: 'tag-E2E 43' } });
  });

  it('writes a whole recording for it, and reports no defect', () => {
    const { recorder, trace } = tapTrace(redacted(icon('i1', { id: 'tag-add' })));
    expect(trace.truncated).toBeUndefined();
    expect(recorder.defects).toEqual([]);
  });

  it('still poisons a target the page identifies by nothing, naming the action it cannot re-find', () => {
    const { recorder, trace } = tapTrace(redacted(bare('i1')));
    expect(trace.truncated).toBe(true);
    expect(trace.actions[0]).toMatchObject({ target: { role: 'unknown' } });
    expect(recorder.defects).toEqual([{ kind: 'target', action: 1 }]);
  });
});

describe('a recording that cannot replay', () => {
  const textbox = (): RedactedNode => redacted({ ref: { id: 't', revision: 'r' }, role: 'textbox', name: 'Search' });

  it('names the action whose input it could not store whole', () => {
    const recorder = new TraceRecorder({ redact: (text) => (text === 'hunter2' ? '[secret]' : text), redactCut: (text) => text });
    recorder.record({ name: 'tap', node: redacted(icon('i1', { id: 'tag-add' })) });
    recorder.record({ name: 'type', node: textbox(), value: 'hunter2' });
    const trace = recorder.finalize({
      executor: { name: 'test' },
      recordedFor: { testId: 't', targetId: 'web', instructionDigest: 'c'.repeat(64) },
      summary: 'searched',
    });
    expect(trace?.truncated).toBe(true);
    expect(trace?.actions[1]).toMatchObject({ name: 'type', value: '[secret]' });
    expect(recorder.defects).toEqual([{ kind: 'input', action: 2 }]);
  });

  it('marks a location it could not keep, and counts the actions dropped past the cap instead of numbering them', () => {
    const recorder = new TraceRecorder({ redact: (text) => text.replace('[secret]', '[redacted]'), redactCut: (text) => text, maxActions: 2 });
    recorder.record({ name: 'tap', node: redacted(icon('a', { id: 'a' })) });
    recorder.record({ name: 'tap', node: redacted(icon('b', { id: 'b' })) });
    recorder.record({ name: 'tap', node: redacted(icon('c', { id: 'c' })) });
    const trace = recorder.finalize({
      executor: { name: 'test' },
      recordedFor: { testId: 't', targetId: 'web', instructionDigest: 'c'.repeat(64) },
      summary: 'clicks',
      startPath: '/x?token=[secret]',
    });
    expect(trace?.truncated).toBe(true);
    expect(trace?.actions).toHaveLength(2);
    expect(recorder.defects).toEqual([
      { kind: 'location', which: 'start' },
      { kind: 'overflow', dropped: 1 },
    ]);
  });
});
