/** Real native/DOM positive control and separate Chrome-comparator sensitivity controls. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { compareWithChrome, crossCheck, type Disagreement } from '../crosscheck/crosscheck.ts';
import { nativeDocument } from '../helpers/native-browser.ts';
import { observedNodes } from '../helpers/native-correlation.ts';
import { startNativeOracle, type NativeOracle } from '../helpers/native-oracle.ts';

const HTML = `<!doctype html><html lang="en"><body>
  <dl id="exercise-states" aria-label="Exercise states">
    <dt>Exercise</dt>
    <dd><button id="exercise-button" aria-pressed="true">Toggle exercise</button></dd>
  </dl>
</body></html>`;
const STRUCTURAL = new Set(['document', 'text', 'generic', 'none', 'presentation']);
let fixture: NativeOracle | undefined;

beforeEach(async () => {
  fixture = await startNativeOracle('crosscheck-policy');
  await nativeDocument(fixture.browser, HTML);
});
afterEach(async () => { await fixture?.close(); fixture = undefined; });

/** Read a real protected ref and the AX node for the same unique fixture element. */
async function chromePair(selector: string) {
  const current = fixture!;
  const snapshot = await current.engine.observe!({ ...current.operation(), origin: 'agent' });
  const matches = await current.engine.locate!({ kind: 'selector', selector }, current.operation(), { purpose: 'fixture' });
  expect(matches).toHaveLength(1);
  const correlated = await current.correlate([matches[0]!.ref], observedNodes(snapshot.root));
  const node = correlated[0];
  expect(node).toBeDefined();
  expect(node).not.toBeNull();
  const cdp = await current.oracle.context().newCDPSession(current.oracle);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('Accessibility.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    const { node: element } = await cdp.send('DOM.describeNode', { nodeId });
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: element.backendNodeId, fetchRelatives: false });
    const ax = nodes.find(candidate => candidate.backendDOMNodeId === element.backendNodeId);
    expect(ax).toBeDefined();
    return { node: node!, ax: ax! };
  } finally {
    await cdp.detach();
  }
}

describe('cross-check Chrome-only role policy', () => {
  it('compares the real DescriptionList and its button subtree with Chrome before omitting the invalid Playwright role query', async () => {
    const snapshot = await fixture!.engine.observe!({ ...fixture!.operation(), origin: 'agent' });
    const nodes = observedNodes(snapshot.root);
    const list = nodes.find(node => node.role === 'DescriptionList' && node.name === 'Exercise states');
    expect(list).toBeDefined();
    expect(observedNodes(list!).find(node => node.role === 'button')).toMatchObject({
      name: 'Toggle exercise', states: { pressed: true },
    });
    const result = await crossCheck(fixture!);
    expect(result.compared).toBe(nodes.filter(node => node.role !== undefined && !STRUCTURAL.has(node.role)).length);
    expect(result.compared).toBeGreaterThanOrEqual(2);
    expect(result.disagreements).toEqual([]);
  });

  for (const [selector, role, name] of [
    ['#exercise-states', 'DescriptionList', 'Exercise states'],
    ['#exercise-button', 'button', 'Toggle exercise'],
  ] as const) {
    for (const field of ['role', 'name', 'disabled'] as const) {
      it(`Chrome comparator reports a changed protected ${field} for ${role} without replacing native RPC output`, async () => {
        const { node, ax } = await chromePair(selector);
        expect(node).toMatchObject({ role, name });
        const facts = { inChildFrame: false, inClosedShadow: false, editingHost: false, svgRoot: false, fileInput: false };
        const control: Disagreement[] = [];
        compareWithChrome(node, ax, facts, control);
        expect(control).toEqual([]);
        const changed: SemanticNode = field === 'role'
          ? { ...node, role: role === 'button' ? 'DescriptionList' : 'button' }
          : field === 'name'
            ? { ...node, name: 'Changed protected name' }
            : { ...node, states: { ...node.states, disabled: true } };
        const differences: Disagreement[] = [];
        compareWithChrome(changed, ax, facts, differences);
        expect(differences.some(difference => difference.oracle === 'chrome' && difference.field === field)).toBe(true);
      });
    }
  }
});
