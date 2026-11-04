/** Exact crosscheck joins include author closed roots without changing CSS semantics. */
import { expect, it } from 'vitest';
import type { LocatorExpression, SemanticNode } from 'e2e/engine';
import { captureTagged, CROSSCHECK_MARKER } from '../crosscheck/crosscheck.ts';
import { nativeDocument } from '../helpers/native-browser.ts';
import { observedNodes } from '../helpers/native-correlation.ts';
import { startNativeOracle } from '../helpers/native-oracle.ts';

const semantics = (nodes: readonly SemanticNode[]) => nodes.map(({ role, name, states }) => ({ role, name, states }));

it('joins closed-root markers to protected refs without borrowing fixture semantics or piercing them with CSS', async () => {
  const fixture = await startNativeOracle('crosscheck-identity');
  try {
    // Preserve the title-only SVG baseline; the labelled link supplies the explicit Home control.
    await nativeDocument(fixture.browser, `<div id="host"></div>
      <a href="/home" data-testid="author-link"><svg width="10" height="10" role="none"><title>Home</title></svg></a>
      <a href="/labelled-home" aria-label="Home" data-testid="author-labelled-link">Home</a>`);
    await fixture.browser.evaluate(() => {
      const open = document.querySelector('#host')!.attachShadow({ mode: 'open' });
      const wrapper = document.createElement('div');
      open.append(wrapper);
      const closed = wrapper.attachShadow({ mode: 'closed' });
      for (const root of [open, closed]) {
        const button = document.createElement('button');
        button.textContent = 'Join witness'; button.disabled = true; button.setAttribute('aria-pressed', 'true');
        button.setAttribute('data-testid', root === open ? 'author-open [] " value' : 'author-closed [] " value');
        root.append(button);
      }
      return null;
    });
    const before = observedNodes((await fixture.engine.observe!({ ...fixture.operation(), origin: 'agent' })).root);
    expect(before.filter(node => node.role === 'link')).toHaveLength(2);
    const labelled = await fixture.engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'author-labelled-link', exact: true } } }, fixture.operation(), { purpose: 'fixture' });
    expect(labelled).toHaveLength(1);
    const [protectedLabelled] = await fixture.correlate(labelled.map(node => node.ref), before);
    expect(protectedLabelled).toMatchObject({ role: 'link', name: 'Home' });
    const captured = await captureTagged(fixture);
    try {
      expect(semantics(captured.nodes)).toEqual(semantics(before));
      const buttons = captured.nodes.filter(node => node.role === 'button');
      expect(buttons).toHaveLength(2);
      for (const button of buttons) expect(button).toMatchObject({ name: 'Join witness', states: { disabled: true, pressed: true } });
      const protectedButton = buttons.find(node => captured.facts.get(node.ref.id)?.inClosedShadow);
      expect(protectedButton).toBeDefined();
      const marker = captured.markers.get(protectedButton!.ref.id);
      expect(marker).toBeDefined();
      const expression: LocatorExpression = { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: marker!, exact: true } } };
      const located = await fixture.engine.locate!(expression, fixture.operation(), { purpose: 'fixture' });
      expect(located).toHaveLength(1);
      const correlated = await fixture.correlate(located.map(node => node.ref), captured.nodes);
      expect(correlated[0]).toBe(protectedButton);
      expect(correlated[0]).not.toBe(located[0]);
      expect(correlated[0]).toMatchObject({ ref: protectedButton!.ref, role: 'button', name: 'Join witness', states: { disabled: true, pressed: true } });
      expect(await fixture.correlate(located.map(node => node.ref), captured.nodes.filter(node => node !== protectedButton))).toEqual([null]);
      expect(await fixture.engine.locate!({ kind: 'selector', selector: `[${CROSSCHECK_MARKER}=${JSON.stringify(marker)}]` }, fixture.operation(), { purpose: 'fixture' })).toEqual([]);
    } finally { await captured.restore(); }
    const after = observedNodes((await fixture.engine.observe!({ ...fixture.operation(), origin: 'agent' })).root);
    expect(semantics(after)).toEqual(semantics(before));
    expect(await fixture.browser.evaluate(() => [document.querySelector('a')!.getAttribute('data-testid'), document.querySelector('a > svg')!.getAttribute('data-testid'), document.querySelector('a[aria-label]')!.getAttribute('data-testid')]))
      .toEqual(['author-link', null, 'author-labelled-link']);
    for (const value of ['author-open [] " value', 'author-closed [] " value']) {
      const restored = await fixture.engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value, exact: true } } }, fixture.operation(), { purpose: 'fixture' });
      expect(restored).toHaveLength(1);
      expect(restored[0]!.attributes?.['data-testid']).toBe(value);
    }
    expect(await fixture.engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'regexp', source: '^e2e-crosscheck-', flags: '' } } }, fixture.operation(), { purpose: 'fixture' })).toEqual([]);
  } finally { await fixture.close(); }
});
