import { describe, expect, it } from 'vitest';
import type { RedactedNode } from '../../src/agent/observation.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { redacted } from '../helpers/redacted.ts';
import { containerKey, describeAction } from '../../src/agent/actions.ts';
import { describePosition, relocateDescriptor } from '../../src/cache/relocate.ts';

const identity = (text: string): string => text;

/** A two-row table: identical "Delete" buttons told apart only by their row. */
function table(): { nodes: Map<string, RedactedNode>; parents: Map<string, string> } {
  const nodes = new Map<string, RedactedNode>();
  const parents = new Map<string, string>();
  const add = (id: string, node: Omit<SemanticNode, 'ref'>, parent?: string): SemanticNode => {
    const full: SemanticNode = { ref: { id, revision: 'r' }, ...node };
    nodes.set(id, redacted(full));
    if (parent !== undefined) parents.set(id, parent);
    return full;
  };
  const c1 = add('c1', { role: 'cell', text: 'Budget draft' }, 'r1');
  const d1 = add('d1', { role: 'button', name: 'Delete' }, 'r1');
  add('r1', { role: 'row', children: [c1, d1] }, 't');
  const c2 = add('c2', { role: 'cell', text: 'Vendor list' }, 'r2');
  const d2 = add('d2', { role: 'button', name: 'Delete' }, 'r2');
  add('r2', { role: 'row', children: [c2, d2] }, 't');
  add('t', { role: 'table', name: 'Documents' });
  return { nodes, parents };
}

describe('container keys', () => {
  it('names the row a control sits in by the row\'s first text', () => {
    const { nodes, parents } = table();
    expect(containerKey('d1', nodes, parents)).toBe('Budget draft');
    expect(containerKey('d2', nodes, parents)).toBe('Vendor list');
    // The cell itself is the row's key: nothing to add.
    expect(containerKey('c1', nodes, parents)).toBeUndefined();
  });

  it('records the key with the action and reads it back in the prose', () => {
    const { nodes } = table();
    const described = describeAction({ name: 'tap', node: nodes.get('d1')!, within: 'Budget draft' }, { redact: identity, redactCut: identity });
    expect(described.target?.within).toBe('Budget draft');
    expect(described.summary).toBe('tap button "Delete" in "Budget draft"');
  });

  it('relocates a same-named control by its row instead of diverging as ambiguous', () => {
    const { nodes, parents } = table();
    void parents;
    expect(relocateDescriptor({ role: 'button', name: 'Delete', within: 'Vendor list' }, nodes)).toEqual({ kind: 'found', id: 'd2' });
    expect(relocateDescriptor({ role: 'button', name: 'Delete' }, nodes)).toMatchObject({ kind: 'failed', failure: 'target-ambiguous' });
    // The row is gone: not found, never the other row's button.
    expect(relocateDescriptor({ role: 'button', name: 'Delete', within: 'Offsite plan' }, nodes)).toEqual({ kind: 'failed', failure: 'target-not-found' });
  });

  it('keys an icon button by its row\'s own label when the row has no other text, and finds it after the rows reorder', () => {
    // `<li>Alpha <button><svg/></button></li>`: the list item is named from its content, the button by nothing.
    const list = (order: readonly string[]) => {
      const nodes = new Map<string, RedactedNode>();
      const parents = new Map<string, string>();
      for (const label of order) {
        const button: SemanticNode = { ref: { id: `b-${label}`, revision: 'r' }, role: 'button' };
        nodes.set(`li-${label}`, redacted({ ref: { id: `li-${label}`, revision: 'r' }, role: 'listitem', name: label, children: [button] }));
        nodes.set(button.ref.id, redacted(button));
        parents.set(button.ref.id, `li-${label}`);
      }
      return { nodes, parents };
    };
    const recorded = list(['Alpha', 'Beta']);
    const within = containerKey('b-Alpha', recorded.nodes, recorded.parents);
    expect(within).toBe('Alpha');
    const position = describePosition(recorded.nodes.get('b-Alpha')!, within, recorded.nodes);
    expect(position).toEqual({ index: 0, of: 1 });
    const live = list(['Beta', 'Alpha']);
    expect(relocateDescriptor({ role: 'button', within: within!, position: position! }, live.nodes)).toEqual({ kind: 'found', id: 'b-Alpha' });
  });

  it('does not key a row of a windowed list by whichever twin row is rendered first', () => {
    // An Android FlatList: an unnamed group of group rows, the rendered window moving with the scroll.
    const list = (first: number) => {
      const nodes = new Map<string, RedactedNode>();
      const parents = new Map<string, string>();
      const rows: SemanticNode[] = [];
      for (let n = first; n < first + 12; n += 1) {
        const label = `Row ${String(n).padStart(4, '0')}`;
        const text: SemanticNode = { ref: { id: `t-${String(n)}`, revision: 'r' }, role: 'text', text: label };
        const row: SemanticNode = { ref: { id: `row-${String(n)}`, revision: 'r' }, role: 'group', name: label, testId: `row-${String(n)}`, children: [text] };
        nodes.set(text.ref.id, redacted(text));
        nodes.set(row.ref.id, redacted(row));
        parents.set(text.ref.id, row.ref.id);
        parents.set(row.ref.id, 'list');
        rows.push(row);
      }
      nodes.set('list', redacted({ ref: { id: 'list', revision: 'r' }, role: 'group', children: rows }));
      return { nodes, parents };
    };
    const recorded = list(500);
    expect(containerKey('row-512', recorded.nodes, recorded.parents)).toBeUndefined();
    expect(containerKey('t-512', recorded.nodes, recorded.parents)).toBeUndefined();
    // A control inside a row is still keyed by its row.
    expect(containerKey('d1', table().nodes, table().parents)).toBe('Budget draft');
    const live = list(501);
    expect(relocateDescriptor({ role: 'group', name: 'Row 0512', testId: 'row-512' }, live.nodes)).toEqual({ kind: 'found', id: 'row-512' });
  });

  it('keys a chip\'s remove icon by the chip\'s label when the chip holds one text and one control', () => {
    // The page renders 91 identical remove icons; only the chip each sits in
    // tells them apart. Chrome may flatten the chip's own element, so the label
    // and the icon arrive as the same container's children.
    const clickable: NonNullable<SemanticNode['states']> & { readonly clickable: boolean } = { clickable: true };
    const chip = (label: string, iconId: string) => {
      const nodes = new Map<string, RedactedNode>();
      const parents = new Map<string, string>();
      const text: SemanticNode = { ref: { id: `${iconId}-label`, revision: 'r' }, text: label };
      const close: SemanticNode = { ref: { id: iconId, revision: 'r' }, states: clickable, attributes: { class: 'ivu-icon ivu-icon-ios-close' } };
      const container: SemanticNode = { ref: { id: `${iconId}-chip`, revision: 'r' }, children: [text, close] };
      for (const item of [container, text, close]) nodes.set(item.ref.id, redacted(item));
      parents.set(iconId, `${iconId}-chip`);
      parents.set(`${iconId}-label`, `${iconId}-chip`);
      return { nodes, parents };
    };
    const first = chip('TAG-42', 'x');
    expect(containerKey('x', first.nodes, first.parents)).toBe('TAG-42');
    expect(describeAction({ name: 'tap', node: first.nodes.get('x')!, within: 'TAG-42' }, { redact: identity, redactCut: identity }).summary).toBe(
      'tap node "ivu-icon ivu-icon-ios-close" in "TAG-42"',
    );

    // Two unnamed controls beside one text, or two texts, name neither: the
    // container is a list, and its text is not the control's place.
    const crowded = new Map<string, RedactedNode>();
    const crowdedParents = new Map<string, string>();
    const container: SemanticNode = {
      ref: { id: 'c', revision: 'r' },
      children: [
        { ref: { id: 't', revision: 'r' }, text: 'TAG-42' },
        { ref: { id: 'i1', revision: 'r' }, states: clickable, attributes: { class: 'icon close' } },
        { ref: { id: 'i2', revision: 'r' }, states: clickable, attributes: { class: 'icon close' } },
      ],
    };
    for (const item of [container, ...(container.children ?? [])]) crowded.set(item.ref.id, redacted(item));
    crowdedParents.set('i1', 'c');
    crowdedParents.set('i2', 'c');
    expect(containerKey('i1', crowded, crowdedParents)).toBeUndefined();

    // The text may name a second control beside the icon (a card's "Save"
    // button), so it is not the icon's place either.
    const mixed = new Map<string, RedactedNode>();
    const mixedParents = new Map<string, string>();
    const card: SemanticNode = {
      ref: { id: 'card', revision: 'r' },
      children: [
        { ref: { id: 'save', revision: 'r' }, role: 'button', name: 'Save' },
        { ref: { id: 'x', revision: 'r' }, states: clickable, attributes: { class: 'icon close' } },
      ],
    };
    for (const item of [card, ...(card.children ?? [])]) mixed.set(item.ref.id, redacted(item));
    mixedParents.set('x', 'card');
    mixedParents.set('save', 'card');
    expect(containerKey('x', mixed, mixedParents)).toBeUndefined();
  });

  it('keys a control by its nearest container only, so rows with no text of their own share no outer label', () => {
    const nodes = new Map<string, RedactedNode>();
    const parents = new Map<string, string>();
    const button: SemanticNode = { ref: { id: 'b', revision: 'r' }, role: 'button' };
    const group: SemanticNode = { ref: { id: 'g', revision: 'r' }, role: 'group', children: [button] };
    const title: SemanticNode = { ref: { id: 't', revision: 'r' }, text: 'Shipping address' };
    nodes.set('r', redacted({ ref: { id: 'r', revision: 'r' }, role: 'region', children: [title, group] }));
    for (const node of [title, group, button]) nodes.set(node.ref.id, redacted(node));
    parents.set('b', 'g');
    parents.set('g', 'r');
    parents.set('t', 'r');
    expect(containerKey('b', nodes, parents)).toBeUndefined();

    // A row whose first text is the link itself names it already: the list around it says nothing more.
    const link: SemanticNode = { ref: { id: 'l', revision: 'r' }, role: 'link', name: 'Beta' };
    nodes.set('l', redacted(link));
    nodes.set('li', redacted({ ref: { id: 'li', revision: 'r' }, role: 'listitem', name: 'Beta', children: [link] }));
    parents.set('l', 'li');
    parents.set('li', 'r');
    expect(containerKey('l', nodes, parents)).toBeUndefined();
  });
});
