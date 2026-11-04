/** Exact public naming fixtures through the real native query/observation bridge.
 * Additive gates: the corresponding legacy cases stay until these execute. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startNativeFixture, type NativeFixture } from '../helpers/native-fixture.ts';
import { nativeDocument } from '../helpers/native-browser.ts';
import { observedNodes } from '../helpers/native-correlation.ts';

let fixture: NativeFixture | undefined;
let fixtureNumber = 0;
beforeEach(async () => { fixture = await startNativeFixture(`public-native-names-${++fixtureNumber}`); });
afterEach(async () => { const owned = fixture; fixture = undefined; await owned?.close(); });
function current(): NativeFixture {
  if (fixture === undefined) throw new Error('Native naming fixture was not started');
  return fixture;
}
async function located(role: string, name: string) {
  return current().engine.locate!({ kind: 'query', query: {
    kind: 'role', value: { kind: 'string', value: role, exact: true },
    name: { kind: 'string', value: name, exact: true },
  } }, current().operation());
}
async function locatedTestId(role: string, name: string): Promise<string | null> {
  const nodes = await located(role, name);
  expect(nodes).toHaveLength(1);
  return nodes[0]!.testId ?? null;
}
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7';

describe('native public accessible naming', () => {
  // Original public obligation read-node-names:1; fixture and expected names retained.
  it('names text controls by placeholder in HTML-AAM order and carries the attribute', async () => {
    await nativeDocument(current().browser, `
      <input type="search" placeholder="Search products" data-testid="search">
      <textarea placeholder="Leave a note" data-testid="note"></textarea>
      <label for="email">Email</label><input id="email" type="email" placeholder="you@example.test">
      <input type="text" title="Promo code" placeholder="Enter code" data-testid="promo">
      <input type="text" aria-placeholder="Amount" data-testid="amount">
      <input type="checkbox" placeholder="Not a text control" data-testid="check">
    `);
    const { root: tree, truncated } = await current().engine.observe!(current().operation());
    const byTestId = new Map(observedNodes(tree).map((node) => [node.testId, node]));
    const email = observedNodes(tree).find((node) => node.name === 'Email');

    expect(byTestId.get('search')).toMatchObject({ role: 'searchbox', name: 'Search products' });
    expect(byTestId.get('search')?.attributes?.['placeholder']).toBe('Search products');
    expect(byTestId.get('note')).toMatchObject({ role: 'textbox', name: 'Leave a note' });
    // A label wins over the placeholder; the placeholder still rides along as an attribute.
    expect(email).toMatchObject({ role: 'textbox', name: 'Email' });
    expect(email?.attributes?.['placeholder']).toBe('you@example.test');
    // The title comes before the placeholder, the aria-placeholder after it.
    expect(byTestId.get('promo')?.name).toBe('Promo code');
    expect(byTestId.get('amount')?.name).toBe('Amount');
    // Only text-like controls are placeholder-named; absence is not proof.
    expect(byTestId.get('check')).toMatchObject({ role: 'checkbox' });
    expect(byTestId.get('check')?.name).toBeUndefined();
    expect(truncated).toBe(false);
  });

  // Original public obligation read-node-names:6; fixture and expected names retained.
  it('names a control from its descendants the way the role selector does: aria-label, alt, content, then title', async () => {
    await nativeDocument(current().browser, `
      <button data-testid="img"><img src="${PIXEL}" alt="Search"></button>
      <button data-testid="svg"><svg aria-label="Close" width="10" height="10"></svg></button>
      <button data-testid="nested"><span><img src="${PIXEL}" alt="Deep"></span></button>
      <button data-testid="labelled-span"><span aria-label="Inner"><b>Bold</b></span></button>
      <button data-testid="mixed"><img src="${PIXEL}" alt="Search">Go</button>
      <button data-testid="blocks"><div>A</div><div>B</div></button>
      <button data-testid="titled"><span title="Settings"></span></button>
      <button data-testid="text-over-title"><span title="Tip">Visible</span></button>
      <button data-testid="hidden"><img src="${PIXEL}" alt="Hidden" style="display:none"><span aria-hidden="true">x</span><img src="${PIXEL}" alt="Kept"></button>
      <a href="#" data-testid="link"><img src="${PIXEL}" alt="Home"></a>
      <input type="image" src="${PIXEL}" alt="Go" data-testid="image-input">
    `);
    const { root: tree } = await current().engine.observe!(current().operation());
    const byTestId = new Map(observedNodes(tree).map((node) => [node.testId, node]));
    const cases: readonly [testId: string, role: 'button' | 'link', name: string][] = [
      ['img', 'button', 'Search'],
      ['svg', 'button', 'Close'],
      ['nested', 'button', 'Deep'],
      ['labelled-span', 'button', 'Inner'],
      ['mixed', 'button', 'SearchGo'],
      ['blocks', 'button', 'A B'],
      ['titled', 'button', 'Settings'],
      ['text-over-title', 'button', 'Visible'],
      ['hidden', 'button', 'Kept'],
      ['link', 'link', 'Home'],
      ['image-input', 'button', 'Go'],
    ];
    for (const [testId, role, name] of cases) {
      expect(byTestId.get(testId), testId).toMatchObject({ role, name });
      expect(await locatedTestId(role, name), name).toBe(testId);
    }
  });

  // Original public obligation read-node-names:7; fixture and expected names retained.
  it('reads an embedded control by its value, as the role selector does', async () => {
    await nativeDocument(current().browser, `
      <button data-testid="textbox">Flash the screen <input value="3"> times</button>
      <button data-testid="search">Find <input type="search" value="q"> now</button>
      <button data-testid="textarea">Note <textarea>hi</textarea> end</button>
      <button data-testid="aria-label-ignored">Name <input aria-label="ignored" value="v"> end</button>
      <button data-testid="select">Pick <select><option>A</option><option selected>B</option></select> now</button>
      <div role="button" data-testid="no-selection">Choose <select><option>A</option><option>B</option></select> now</div>
      <div role="button" data-testid="multiple">Pick <select multiple><option selected>A</option><option selected>B</option></select> now</div>
      <div role="button" data-testid="aria-listbox">Pick <div role="listbox"><div role="option" aria-selected="true">X</div><div role="option">Y</div></div> now</div>
      <div role="button" data-testid="datalist">Find <input list="choices" value="dv"><datalist id="choices"><option>o</option></datalist> now</div>
      <button data-testid="range">Vol <input type="range" min="0" max="10" value="4"> end</button>
      <button data-testid="valuetext">Bass <input type="range" aria-valuetext="four" min="0" max="10" value="4"> end</button>
      <div role="button" data-testid="no-value-attribute">Volume <input type="range" min="0" max="10"> end</div>
      <div role="button" data-testid="spinbutton">Count <input type="number" value="7"> end</div>
      <div role="button" data-testid="progress">Load <progress value="30" max="100"></progress> end</div>
      <div role="button" data-testid="checkbox">Agree <input type="checkbox"> end</div>
      <div role="button" data-testid="hidden-control">Gain <input value="zz" style="display:none"> end</div>
      <div role="button" data-testid="aria-hidden-control">Level <input value="zz" aria-hidden="true"> end</div>
      <span id="count">Count <input value="2"> rows</span><button aria-labelledby="count" data-testid="referenced">z</button>
      <label for="qty">Qty <input value="5"> items</label><input id="qty" data-testid="label-for">
      <label>Inside <input value="9" data-testid="own-label"></label>
    `);
    const { root: tree } = await current().engine.observe!(current().operation());
    const byTestId = new Map(observedNodes(tree).map((node) => [node.testId, node]));
    const cases: readonly [testId: string, role: 'button' | 'textbox', name: string][] = [
      ['textbox', 'button', 'Flash the screen 3 times'],
      ['search', 'button', 'Find q now'],
      ['textarea', 'button', 'Note hi end'],
      // An embedded control's value comes before its aria-label.
      ['aria-label-ignored', 'button', 'Name v end'],
      ['select', 'button', 'Pick B now'],
      ['no-selection', 'button', 'Choose A now'],
      ['multiple', 'button', 'Pick A B now'],
      ['aria-listbox', 'button', 'Pick X now'],
      ['datalist', 'button', 'Find dv now'],
      ['range', 'button', 'Vol 4 end'],
      ['valuetext', 'button', 'Bass four end'],
      ['no-value-attribute', 'button', 'Volume end'],
      ['spinbutton', 'button', 'Count 7 end'],
      ['progress', 'button', 'Load 30 end'],
      ['checkbox', 'button', 'Agree end'],
      ['hidden-control', 'button', 'Gain end'],
      ['aria-hidden-control', 'button', 'Level end'],
      ['referenced', 'button', 'Count 2 rows'],
      ['label-for', 'textbox', 'Qty 5 items'],
      // A control inside its own label is the name's subject, never part of it.
      ['own-label', 'textbox', 'Inside'],
    ];
    for (const [testId, role, name] of cases) {
      expect(byTestId.get(testId), testId).toMatchObject({ role, name });
      expect(await locatedTestId(role, name), name).toBe(testId);
    }
  });

  // Original public obligation read-node-names:9; fixture and expected names retained.
  it('reads aria-labelledby before aria-label, and either before a label element', async () => {
    await nativeDocument(current().browser, `
      <span id="heading">Shipping address</span>
      <input aria-labelledby="heading" aria-label="Address" data-testid="referenced">
      <label for="named">Label text</label><input id="named" aria-label="Aria text" data-testid="labelled">
      <span id="first">First</span><span id="second"><img src="${PIXEL}" alt="Pic"></span>
      <button aria-labelledby="first second" data-testid="two-references">x</button>
    `);
    const { root: tree } = await current().engine.observe!(current().operation());
    const byTestId = new Map(observedNodes(tree).map((node) => [node.testId, node]));
    expect(byTestId.get('referenced')).toMatchObject({ role: 'textbox', name: 'Shipping address' });
    expect(byTestId.get('labelled')).toMatchObject({ role: 'textbox', name: 'Aria text' });
    expect(byTestId.get('two-references')).toMatchObject({ role: 'button', name: 'First Pic' });
    expect(await locatedTestId('textbox', 'Shipping address')).toBe('referenced');
    expect(await locatedTestId('textbox', 'Aria text')).toBe('labelled');
    expect(await locatedTestId('button', 'First Pic')).toBe('two-references');
    expect(await located('textbox', 'Address')).toEqual([]);
  });

  // Original public obligation read-node-names:10; fixture and expected names retained.
  it('reads a referenced target whole when it is hidden, by its own aria-label, and drops hidden parts of a shown one', async () => {
    await nativeDocument(current().browser, `
      <button aria-labelledby="l1" aria-label="Delete" data-testid="hidden-reference"><span id="l1" hidden>Delete account</span></button>
      <button aria-labelledby="l2" aria-label="Delete" data-testid="aria-hidden-reference"><span id="l2" aria-hidden="true">Remove account</span></button>
      <button aria-labelledby="l3" data-testid="nested-hidden-reference">x</button>
      <div hidden><span id="l3">Deep <i style="display:none">gone</i>label</span></div>
      <button aria-labelledby="l4" data-testid="shown-reference">x</button>
      <span id="l4">Shown <i style="display:none">gone</i></span>
      <button aria-labelledby="l5" data-testid="labelled-reference">x</button>
      <span id="l5" aria-label="Own label">Text</span>
      <button aria-labelledby="l6" data-testid="aria-hidden-ancestor-reference">x</button>
      <div aria-hidden="true"><span id="l6">Label <i style="display:none">gone</i></span></div>
    `);
    const { root: tree } = await current().engine.observe!(current().operation());
    const byTestId = new Map(observedNodes(tree).map((node) => [node.testId, node]));
    const cases: readonly [testId: string, name: string][] = [
      ['hidden-reference', 'Delete account'],
      ['aria-hidden-reference', 'Remove account'],
      ['nested-hidden-reference', 'Deep gone label'],
      ['shown-reference', 'Shown'],
      ['labelled-reference', 'Own label'],
      // An aria-hidden ancestor hides the target as its own attribute would, so it is read whole.
      ['aria-hidden-ancestor-reference', 'Label gone'],
    ];
    for (const [testId, name] of cases) {
      expect(byTestId.get(testId), testId).toMatchObject({ role: 'button', name });
      expect(await locatedTestId('button', name), name).toBe(testId);
    }
  });

  // Original public obligation read-node-names:11; fixture and expected names retained.
  it('resolves an aria-labelledby id in the element\'s own shadow tree, not the document', async () => {
    await nativeDocument(current().browser, `
      <span id="l">Outside</span>
      <x-host></x-host>
      <script>
        const root = document.querySelector('x-host').attachShadow({ mode: 'open' });
        root.innerHTML = '<span id="l">Inside</span><button aria-labelledby="l" data-testid="inside">x</button>';
      </script>
    `);
    const { root: tree } = await current().engine.observe!(current().operation());
    const byTestId = new Map(observedNodes(tree).map((node) => [node.testId, node]));
    expect(byTestId.get('inside')).toMatchObject({ role: 'button', name: 'Inside' });
    expect(await locatedTestId('button', 'Inside')).toBe('inside');
  });

  // Original public obligation read-node-names:12; fixture and expected names retained.
  it('follows a descendant reference in a name from content, once per element and never from inside another', async () => {
    await nativeDocument(current().browser, `
      <button data-testid="svg-reference"><svg aria-labelledby="t1" width="10" height="10"><title id="t1">Close</title></svg>Icon</button>
      <button data-testid="block-svg-reference"><svg aria-labelledby="t2" style="display:block" width="10" height="10"><title id="t2">Close</title></svg>Icon</button>
      <button data-testid="svg-title"><svg width="10" height="10"><title>Svg title</title></svg></button>
      <button data-testid="two-references"><span aria-labelledby="p1 p2"></span></button>
      <span id="p1">One</span><span id="p2">Two</span>
      <button data-testid="hidden-target"><span aria-labelledby="p3"></span></button>
      <span id="p3" hidden>Hidden target</span>
      <button data-testid="cycle"><span id="c1" aria-labelledby="c2">A</span><span id="c2" aria-labelledby="c1">B</span></button>
      <button id="ancestor" data-testid="ancestor-reference"><span aria-labelledby="ancestor">A</span>B</button>
      <button id="me" aria-labelledby="me" data-testid="self-reference">Self</button>
      <button aria-labelledby="r1" data-testid="nested-reference">x</button>
      <span id="r1"><span aria-labelledby="r2">Ref text</span></span><span id="r2">Nested</span>
    `);
    const { root: tree } = await current().engine.observe!(current().operation());
    const byTestId = new Map(observedNodes(tree).map((node) => [node.testId, node]));
    const cases: readonly [testId: string, name: string][] = [
      ['svg-reference', 'CloseIcon'],
      ['block-svg-reference', 'Close Icon'],
      ['svg-title', 'Svg title'],
      ['two-references', 'One Two'],
      ['hidden-target', 'Hidden target'],
      ['cycle', 'B'],
      ['ancestor-reference', 'AB'],
      ['self-reference', 'Self'],
      ['nested-reference', 'Ref text'],
    ];
    for (const [testId, name] of cases) {
      expect(byTestId.get(testId), testId).toMatchObject({ role: 'button', name });
      expect(await locatedTestId('button', name), name).toBe(testId);
    }
  });

  // Original public obligation read-node-names:13; fixture and expected names retained.
  it('names every role accname allows from content, a shadow tree included, and a reset input by its value or default', async () => {
    // Native CDP inventories author closed roots without an application hook.
    await nativeDocument(current().browser, `
      <div role="checkbox" aria-checked="false" data-testid="checkbox">Remember me</div>
      <span role="radio" aria-checked="true" data-testid="radio">Monthly</span>
      <div role="switch" aria-checked="false" data-testid="switch">Dark mode</div>
      <table>
        <tr><th data-testid="columnheader">Price</th><th scope="row" data-testid="rowheader">Ada</th><td data-testid="cell">42</td></tr>
      </table>
      <div role="grid"><div role="row" data-testid="row"><div role="gridcell" data-testid="gridcell">A1</div></div></div>
      <x-button role="button" tabindex="0" data-testid="custom-button"><span slot="icon">*</span></x-button>
      <x-label role="button" tabindex="0" data-testid="slotted-button">Slotted</x-label>
      <x-action role="button" tabindex="0" data-testid="closed-slotted-button">Save</x-action>
      <input type="reset" value="Clear" data-testid="reset-value">
      <input type="reset" data-testid="reset-default">
      <input type="submit" data-testid="submit-default">
      <button data-testid="plain">Plain</button>
      <input type="submit" value="Send" data-testid="submit-value">
      <script>
        document.querySelector('x-button').attachShadow({ mode: 'open' }).innerHTML = '<slot name="icon"></slot><span>Custom</span>';
        document.querySelector('x-label').attachShadow({ mode: 'open' }).innerHTML = '<b>[</b><slot></slot><b>]</b>';
        document.querySelector('x-action').attachShadow({ mode: 'closed' }).innerHTML = '<b>[</b><slot></slot><b>]</b>';
      </script>
    `);
    const { root: tree } = await current().engine.observe!(current().operation());
    const byTestId = new Map(observedNodes(tree).map((node) => [node.testId, node]));
    const cases: readonly [testId: string, role: string, name: string][] = [
      ['checkbox', 'checkbox', 'Remember me'],
      ['radio', 'radio', 'Monthly'],
      ['switch', 'switch', 'Dark mode'],
      ['columnheader', 'columnheader', 'Price'],
      ['rowheader', 'rowheader', 'Ada'],
      ['cell', 'cell', '42'],
      ['row', 'row', 'A1'],
      ['gridcell', 'gridcell', 'A1'],
      ['custom-button', 'button', '* Custom'],
      ['slotted-button', 'button', '[ Slotted ]'],
      ['reset-value', 'button', 'Clear'],
      ['reset-default', 'button', 'Reset'],
      ['submit-default', 'button', 'Submit'],
      ['plain', 'button', 'Plain'],
      ['submit-value', 'button', 'Send'],
    ];
    for (const [testId, role, name] of cases) {
      expect(byTestId.get(testId), testId).toMatchObject({ role, name });
      expect(await locatedTestId(role, name), name).toBe(testId);
    }
    // Slotted closed-root content is read once, at the slot. Unlike the old
    // Playwright query, the public native query can verify this same name.
    expect(byTestId.get('closed-slotted-button')).toMatchObject({ role: 'button', name: '[ Save ]' });
    expect(await locatedTestId('button', '[ Save ]')).toBe('closed-slotted-button');
  });
});
