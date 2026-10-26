/** Repeated public observations retain the latest exact ref, not old metadata. */
import { expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { startNativeFixture } from '../helpers/native-fixture.ts';
import { nativeDocument } from '../helpers/native-browser.ts';
import { observedNodes } from '../helpers/native-correlation.ts';

// Native's actual-producer companion observes the same fixture three times,
// collects all six metadata WeakRefs, verifies released remote handles, and
// clicks the latest exact ref. This public bridge must not fake those internals.
it('collects captured metadata while published element references stay actionable', async () => {
  const fixture = await startNativeFixture('public-observation-metadata-contract');
  try {
    await nativeDocument(fixture.browser, '<button onclick="this.textContent = \'Clicked\'">Click me</button>');
    let latest: SemanticNode | undefined;
    const counts: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const snapshot = await fixture.engine.observe!(fixture.operation());
      const nodes = observedNodes(snapshot.root);
      counts.push(nodes.length);
      expect(snapshot.truncated).toBe(false);
      const buttons = nodes.filter(node => node.role === 'button');
      expect(buttons).toHaveLength(1);
      expect(buttons[0]!.name).toBe('Click me');
      latest = buttons[0];
    }
    expect(counts).toEqual([2, 2, 2]);
    expect(latest).toBeDefined();
    // No intervening query/re-observation may manufacture a replacement ref.
    await fixture.engine.perform!(latest!.ref, { kind: 'tap' }, fixture.operation());
    expect(await fixture.browser.evaluate(() => document.querySelector('button')!.textContent)).toBe('Clicked');
  } finally { await fixture.close(); }
});
