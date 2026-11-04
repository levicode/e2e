/** Public native completeness, frame omission, and safe label contracts. */
import { describe, expect, it } from 'vitest';
import { startNativeFixture } from '../helpers/native-fixture.ts';
import { nativeDocument } from '../helpers/native-browser.ts';
import { observedNodes } from '../helpers/native-correlation.ts';

// The actual native producer owns configurable node budgets. Its executed
// companions preserve exact whole22/cut5 and child-budget3 assertions. The Web
// API exposes the resulting tree/truncated flag, not a per-observe budget knob.
describe('native observation frame and completeness contracts', () => {
  it('publishes the complete twenty-control tree without truncation', async () => {
    const fixture = await startNativeFixture('public-observation-whole-twenty');
    try {
      const buttons = Array.from({ length: 20 }, (_, index) => `<button>Button ${String(index)}</button>`).join('');
      await nativeDocument(fixture.browser, `<main>${buttons}</main>`);
      const snapshot = await fixture.engine.observe!(fixture.operation());
      const nodes = observedNodes(snapshot.root);
      expect(snapshot.truncated).toBe(false);
      expect(nodes).toHaveLength(22);
      expect(nodes.filter(node => node.role === 'button').map(node => node.name))
        .toEqual(Array.from({ length: 20 }, (_, index) => `Button ${String(index)}`));
    } finally { await fixture.close(); }
  });

  it('includes a loaded blank-site child frame in a complete observation', async () => {
    const fixture = await startNativeFixture('public-observation-child-frame');
    try {
      await nativeDocument(fixture.browser, '<button>One</button><iframe srcdoc="<button>Inside</button>"></iframe>');
      const loaded = await fixture.engine.locate!({ kind: 'frame', selector: 'iframe', source: {
        kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true },
          name: { kind: 'string', value: 'Inside', exact: true } },
      } }, fixture.operation());
      expect(loaded.map(node => node.name)).toEqual(['Inside']);
      const snapshot = await fixture.engine.observe!(fixture.operation());
      const nodes = observedNodes(snapshot.root);
      expect(snapshot.truncated).toBe(false);
      expect(nodes).toHaveLength(5);
      expect(nodes.filter(node => node.role === 'button').map(node => node.name)).toEqual(['One', 'Inside']);
    } finally { await fixture.close(); }
  });

  it('omits a positively loaded data child by default site policy without calling that truncation', async () => {
    const fixture = await startNativeFixture('public-observation-data-child');
    try {
      await nativeDocument(fixture.browser, '<button>One</button><iframe src="data:text/html,<button>Ad</button>"></iframe>');
      // Explicit user-directed frame queries are not restricted by observation
      // omission policy, and this proves loading succeeded before exclusion.
      const loaded = await fixture.engine.locate!({ kind: 'frame', selector: 'iframe', source: {
        kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true },
          name: { kind: 'string', value: 'Ad', exact: true } },
      } }, fixture.operation());
      expect(loaded.map(node => node.name)).toEqual(['Ad']);
      const snapshot = await fixture.engine.observe!(fixture.operation());
      expect(snapshot.truncated).toBe(false);
      expect(observedNodes(snapshot.root)).toHaveLength(3);
      expect(observedNodes(snapshot.root).filter(node => node.role === 'button').map(node => node.name)).toEqual(['One']);
    } finally { await fixture.close(); }
  });

  it('includes depth four but reports a loaded onsite depth-five frame as truncation', async () => {
    const fixture = await startNativeFixture('public-observation-depth-boundary');
    try {
      for (const depth of [4, 5]) {
        await nativeDocument(fixture.browser, '<button>Top</button>');
        await fixture.browser.evaluate(async (levels) => {
          let doc = document;
          for (let level = 0; level < levels; level += 1) {
            const iframe = doc.createElement('iframe');
            iframe.srcdoc = `<button>Level ${String(level + 1)}</button>`;
            const loaded = new Promise<void>(resolve => iframe.addEventListener('load', () => resolve(), { once: true }));
            doc.body.appendChild(iframe); await loaded; doc = iframe.contentDocument!;
          }
          return null;
        }, depth);
        const snapshot = await fixture.engine.observe!(fixture.operation());
        const nodes = observedNodes(snapshot.root);
        expect(snapshot.truncated).toBe(depth === 5);
        expect(nodes).toHaveLength(depth === 4 ? 14 : 15);
        expect(nodes.filter(node => node.role === 'button').map(node => node.name))
          .toEqual(['Top', 'Level 1', 'Level 2', 'Level 3', 'Level 4']);
        expect(JSON.stringify(snapshot.root)).not.toContain('Level 5');
      }
    } finally { await fixture.close(); }
  });
});

describe('native public label contract', () => {
  // The actual producer GC/label receipts are separate from this public adapter
  // contract: no old page-realm reader or fabricated metadata handle is used.
  it('keeps an embedded control\'s value out of label text and a secure field\'s value out of every name', async () => {
    const fixture = await startNativeFixture('public-label-password-contract');
    try {
      await nativeDocument(fixture.browser, `
        <label for="qty">Qty <input value="5"> items</label><input id="qty" data-testid="label-for">
        <button data-testid="secure">Unlock <input type="password" value="hunter2"> now</button>
        <label for="pin">PIN <input type="password" value="hunter2"> field</label><input id="pin" data-testid="secure-label">
      `);
      // Public label matching excludes the embedded value even though the
      // accessible name of #qty legitimately includes it (Qty 5 items).
      const label = await fixture.engine.locate!({ kind: 'query', query: { kind: 'label',
        value: { kind: 'string', value: 'Qty items', exact: true },
      } }, fixture.operation());
      expect(label.map(node => node.testId)).toEqual(['label-for']);
      expect(await fixture.engine.locate!({ kind: 'query', query: { kind: 'label',
        value: { kind: 'string', value: 'Qty 5 items', exact: true },
      } }, fixture.operation())).toEqual([]);
      const reads = [];
      for (const testId of ['label-for', 'secure', 'secure-label']) {
        const found = await fixture.engine.locate!({ kind: 'query', query: {
          kind: 'testId', value: { kind: 'string', value: testId, exact: true },
        } }, fixture.operation());
        expect(found).toHaveLength(1);
        reads.push(found[0]!);
      }
      const byTestId = new Map(reads.map(node => [node.testId, node]));
      expect(byTestId.get('secure')?.name).toBe('Unlock now');
      expect(byTestId.get('secure-label')?.name).toBe('PIN field');
      expect(JSON.stringify(reads)).not.toContain('hunter2');
      const snapshot = await fixture.engine.observe!(fixture.operation());
      const observed = new Map(observedNodes(snapshot.root).map(node => [node.testId, node]));
      expect(observed.get('secure')?.name).toBe('Unlock now');
      expect(observed.get('secure-label')?.name).toBe('PIN field');
      expect(JSON.stringify(snapshot.root)).not.toContain('hunter2');
      expect(snapshot.truncated).toBe(false);
    } finally { await fixture.close(); }
  });
});
