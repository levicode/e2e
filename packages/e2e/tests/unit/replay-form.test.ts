import { describe, expect, it } from 'vitest';
import { adjacentFormOpening, localFormTransition, localFormOpening } from '../../src/agent/replay-form.ts';
import type { SemanticScreen } from '../../src/agent/replay.ts';
import type { ActionTrace } from '../../src/cache/trace.ts';
import { redactedNodes } from '../helpers/redacted.ts';

const startRadio = { text: 'First' };
const nextRadio = { text: 'Second' };
const submit = { role: 'button', name: 'Continue' };
const field = { role: 'textbox', name: 'Amount' };
const flow: ActionTrace = {
  executor: { name: 'test' }, summary: 'form validation',
  actions: [{ name: 'hover', target: startRadio, summary: '' }, { name: 'tap', target: startRadio, summary: '' },
    { name: 'tap', target: nextRadio, summary: '' }, { name: 'tap', target: submit, summary: '' }],
  endAnchors: [field], goneAnchors: [{ ...field, value: '20' }],
};

function screen(firstChecked = false, value = '20', hovered = false): SemanticScreen {
  const owner = 'same form';
  const rect = { x: 1, y: 1, width: 12, height: 10 };
  const ref = (id: string) => ({ id, revision: 'fresh' });
  return { kind: 'semantic', identityScope: 'scope', path: '/edit', viewport: { width: 800, height: 600 },
    nodes: redactedNodes([{ ...startRadio, rect, ref: ref('r1') }, { ...nextRadio, rect, ref: ref('r2') },
      { ...submit, rect, ref: ref('b') }, { ...field, rect, value, ref: ref('f') }]),
    replayControls: {
      r1: { owner, target: 'first', kind: 'radio', checked: firstChecked, hovered },
      r2: { owner, target: 'second', kind: 'radio', checked: !firstChecked, hovered: false },
      b: { owner, target: 'submit', kind: 'button' }, f: { owner, target: 'amount', kind: 'field' },
    } };
}

describe('local replay effect evidence', () => {
  it('reuses an adjacent form sample only after fresh, globally unique target and page evidence', () => {
    const previous = screen();
    const trace: ActionTrace = { ...flow, startPath: '/edit', actions: [{ name: 'tap', target: submit, summary: '' }] };
    const probe = adjacentFormOpening(previous, trace, Date.now())!;
    const live: SemanticScreen = { ...screen(), replayControls: Object.fromEntries(
      Object.entries(previous.replayControls!).map(([id, control]) => [id, { ...control, stable: true }]),
    ) };
    expect(probe(live)).toBe('ready');
    expect(probe(previous)).toBeUndefined();
    expect(probe({ ...live, path: '/different' })).toBeUndefined();
    expect(probe({ ...live, nodes: screen(false, '').nodes })).toBeUndefined();
    const freshRefs = new Map([...live.nodes].map(([id, n]) => [id, { ...n, ref: { id, revision: 'new' } }]));
    expect(probe({ ...live, nodes: freshRefs })).toBe('ready');
    expect(probe({ ...live, replayControls: { ...live.replayControls, b: {
      ...live.replayControls!.b!, owner: 'another document', stable: true,
    } } })).toBeUndefined();
    const twin = redactedNodes([{ ...submit, ref: { id: 'twin', revision: 'new' } }]);
    expect(probe({ ...live, nodes: new Map([...live.nodes, ...twin]) })).toBeUndefined();
    const moved = { ...live.nodes.get('b')!, rect: { x: 10, y: 2, width: 12, height: 10 } };
    expect(probe({ ...live, nodes: new Map([...live.nodes, ['b', moved]]) })).toBeUndefined();
    expect(adjacentFormOpening(previous, { ...trace, actions: [{ name: 'tap', summary: '',
      target: { ...submit, position: { index: 0, of: 2 } } }] }, Date.now())).toBeUndefined();
    expect(adjacentFormOpening(previous, trace, Date.now() - 10_000)).toBeUndefined();
  });

  it('admits a first hover only after a complete two-sample form and the recorded starting value', () => {
    const match = localFormOpening({ ...flow, startPath: '/edit' })!;
    const sample = screen();
    const stable = { ...sample, replayControls: Object.fromEntries(
      Object.entries(sample.replayControls!).map(([id, c]) => [id, { ...c, stable: true }]),
    ) };
    expect(match(sample)).toBeUndefined();
    expect(match(stable)).toBe('ready');
    expect(match({ ...stable, path: '/another' })).toBeUndefined();
    expect(match({ ...stable, nodes: screen(false, 'wrong').nodes })).toBeUndefined();
    expect(match({ ...stable, replayControls: { ...stable.replayControls, b: sample.replayControls!.b! } })).toBeUndefined();
  });

  it('requires the actual hovered receiver and a mutually exclusive selection on fresh samples', () => {
    const before = screen();
    const hover = localFormTransition(flow, 0, before, 'r1', before)!;
    expect(hover(before)).toBeUndefined();
    expect(hover(screen(false, '20', true))).toBe('ready');
    const switched = localFormTransition(flow, 1, before, 'r1', before)!;
    expect(switched(before)).toBeUndefined();
    expect(switched(screen(true, ''))).toBe('ready');
    expect(switched({ ...screen(true, ''), path: '/other' })).toBeUndefined();
    expect(switched({ ...screen(true, ''), identityScope: 'other' })).toBeUndefined();
    const live = screen(true, '');
    expect(switched({ ...live, replayControls: { ...live.replayControls, r1: {
      kind: 'radio', target: 'remounted', owner: 'same form', checked: true, hovered: false,
    } } })).toBeUndefined();
  });

  it('only settles a final button after its same-form field reached the recorded clear condition', () => {
    const start = screen(), before = screen(true, '');
    const checked = localFormTransition(flow, 2, before, 'r2', start)!;
    expect(checked(screen(false, '20'))).toBeUndefined();
    expect(checked(screen(true, ''))).toBeUndefined();
    expect(checked(screen(false, ''))).toEqual({ stableTarget: 'amount' });
    const live = screen(false, '');
    const stable = { ...live, replayControls: Object.fromEntries(
      Object.entries(live.replayControls!).map(([id, control]) => [id, { ...control, stable: true }]),
    ) };
    expect(checked(stable)).toBe('ready');
    expect(checked({ ...stable, replayControls: { ...stable.replayControls, b: live.replayControls!.b! } }))
      .toEqual({ stableTarget: 'amount' });
    expect(checked({ ...live, replayControls: { ...live.replayControls, f: {
      kind: 'field', owner: 'same form', target: 'remounted field',
    } } })).toEqual({ stableTarget: 'remounted field' });
    expect(checked({ ...live, replayControls: { ...live.replayControls, f: {
      kind: 'field', owner: 'other form', target: 'amount',
    } } })).toBeUndefined();
    expect(localFormTransition({ ...flow, goneAnchors: [] }, 2, before, 'r2', start)).toBeUndefined();
  });

  it('requires a unique, actionable target in the complete current inventory', () => {
    const before = screen(), live = screen(false, '', true);
    const ready = localFormTransition(flow, 0, before, 'r1', before)!;
    const extra = redactedNodes([{ ...startRadio, ref: { id: 'twin', revision: 'fresh' } }]);
    expect(ready({ ...live, nodes: new Map([...live.nodes, ...extra]) })).toBeUndefined();
    expect(ready({ ...live, replayControls: {} })).toBeUndefined();
    const hidden = { ...live.nodes.get('r1')!, states: { hidden: true } };
    expect(ready({ ...live, nodes: new Map([...live.nodes, ['r1', hidden]]) })).toBeUndefined();
  });
});
