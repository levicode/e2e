/** Frozen Web control-value semantics through the real native daemon and public adapter. */
import { expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { redactNode } from '../../../e2e/dist/agent/observation.js';
import { deltaMismatch } from '../../../e2e/dist/cache/anchors.js';
import { SecretLedger } from '../../../e2e/dist/internal/redact.js';
import { nativeDocument } from '../helpers/native-browser.ts';
import { observedNodes } from '../helpers/native-correlation.ts';
import { startNativeFixture } from '../helpers/native-fixture.ts';

/** Absence must fail before a missing node could masquerade as an omitted value. */
function byTestId(nodes: readonly SemanticNode[], id: string): SemanticNode {
  const matches = nodes.filter(node => node.testId === id);
  expect(matches, `Expected one actual native node for ${id}`).toHaveLength(1);
  return matches[0]!;
}

it('keeps output and button values absent in native observations, queries, and old cache anchors', async () => {
  const fixture = await startNativeFixture('control-values-output');
  try {
    await nativeDocument(fixture.browser, `
      <output data-testid="marker" aria-label="Marker" style="display:block">saved</output>
      <button data-testid="save" value="submit-token">Save</button>
      <input data-testid="entry" aria-label="Entry" value="typed">
    `);
    const captured = await fixture.engine.observe!(fixture.operation(), { pixels: false });
    const nodes = observedNodes(captured.root);
    const output = byTestId(nodes, 'marker');
    // This is the first semantic assertion: exact native 0f545c3 incorrectly
    // reports value="saved" here. No ID grammar or geometry oracle is involved.
    expect(output.value, 'I04: output text must not be projected as an input value').toBeUndefined();
    expect(output).toMatchObject({ role: 'status', name: 'Marker', text: 'saved' });
    expect(byTestId(nodes, 'save').value).toBeUndefined();
    expect(byTestId(nodes, 'entry').value).toBe('typed');
    expect(captured.truncated).toBe(false);
    expect(captured.pixels).toBeUndefined();

    const located = await fixture.engine.locate!({ kind: 'selector', selector: '[data-testid]' }, fixture.operation());
    expect(byTestId(located, 'marker')).toMatchObject({ text: 'saved' });
    expect(byTestId(located, 'marker').value).toBeUndefined();
    expect(byTestId(located, 'save').value).toBeUndefined();
    expect(byTestId(located, 'entry').value).toBe('typed');
    expect(await fixture.browser.locator('[data-testid="marker"]').textContent()).toBe('saved');
    expect(await fixture.browser.locator('[data-testid="entry"]').inputValue()).toBe('typed');

    // The unchanged cache predicate consumes the actual captured tree, through
    // production redaction. No synthesized nodes, value deletion, or fake feed.
    const ledger = new SecretLedger();
    const protectedNodes = new Map(nodes.map(node => [node.ref.id, redactNode(node, ledger)]));
    expect(deltaMismatch({ endAnchors: [{ role: 'status', name: 'Marker', text: 'saved' }] }, protectedNodes, new Map())).toBeUndefined();
    const inputAnchor = { role: 'textbox', name: 'Entry', testId: 'entry', value: 'typed' };
    expect(deltaMismatch({ endAnchors: [inputAnchor] }, protectedNodes, new Map())).toBeUndefined();
    expect(deltaMismatch({ endAnchors: [{ ...inputAnchor, value: 'another-run' }] }, protectedNodes, new Map())?.missing).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

it('preserves empty and nonempty control values with distinct observation and exact-query tokens', async () => {
  const fixture = await startNativeFixture('control-values-native');
  try {
    await nativeDocument(fixture.browser, `
      <input data-testid="input-empty" aria-label="Empty input" value="">
      <input data-testid="input-full" aria-label="Full input" value="  typed  ">
      <textarea data-testid="textarea-empty" aria-label="Empty note"></textarea>
      <textarea data-testid="textarea-full" aria-label="Full note">  note\nnext  </textarea>
      <select data-testid="select-empty" aria-label="Empty choice"><option data-testid="option-empty" value="">Empty</option></select>
      <select data-testid="select-full" aria-label="Full choice"><option data-testid="option-full" value="internal-choice-token" selected>Choice</option></select>
      <input type="checkbox" data-testid="checkbox" aria-label="Check" value="internal-check-token" checked aria-checked="false">
      <input type="radio" data-testid="radio" aria-label="Radio" value="" aria-checked="true">
      <div contenteditable="true" role="textbox" data-testid="editor-empty" aria-label="Empty editor"><p><br></p></div>
      <div contenteditable="true" role="textbox" data-testid="editor-full" aria-label="Full editor" style="white-space:pre-wrap">  edit\nnext  </div>
    `);
    const captured = await fixture.engine.observe!(fixture.operation(), { pixels: false });
    const observed = observedNodes(captured.root);
    const located = await fixture.engine.locate!({ kind: 'selector', selector: '[data-testid]' }, fixture.operation());
    const values = [
      ['input-empty', ''], ['input-full', '  typed  '],
      ['textarea-empty', ''], ['textarea-full', '  note\nnext  '],
      ['select-empty', ''], ['select-full', 'internal-choice-token'],
      ['editor-empty', ''], ['editor-full', '  edit\nnext  '],
    ] as const;
    for (const [id, value] of values) {
      expect(byTestId(observed, id).value, `observed ${id}`).toBe(value);
      expect(byTestId(located, id).value, `located ${id}`).toBe(value);
    }
    for (const [id, value] of [['option-empty', ''], ['option-full', 'internal-choice-token'], ['checkbox', 'internal-check-token'], ['radio', '']] as const) {
      expect(byTestId(observed, id).value, `model-bound ${id} must omit its submission token`).toBeUndefined();
      expect(byTestId(located, id).value, `exact-query ${id} must retain its submission token`).toBe(value);
    }
    for (const nodes of [observed, located]) {
      expect(byTestId(nodes, 'checkbox').states?.checked).toBe(true);
      expect(byTestId(nodes, 'radio').states?.checked).toBe(false);
      expect(byTestId(nodes, 'option-full').states?.selected).toBe(true);
    }
    expect(captured.truncated).toBe(false);
    expect(await fixture.browser.locator('[data-testid="input-empty"]').inputValue()).toBe('');
    expect(await fixture.browser.locator('[data-testid="select-full"]').inputValue()).toBe('internal-choice-token');
    expect(await fixture.browser.locator('[data-testid="editor-full"]').inputValue()).toBe('  edit\nnext  ');
  } finally {
    await fixture.close();
  }
});

it('withholds password and protected-editor values through actual native observation and query', async () => {
  const fixture = await startNativeFixture('control-values-secure');
  const secret = 'i04-synthetic-secret-not-a-credential';
  try {
    await nativeDocument(fixture.browser, `
      <input type="password" data-testid="password-empty" aria-label="Empty password" value="">
      <input type="password" data-testid="password-full" aria-label="Full password" value="${secret}">
      <div contenteditable="true" role="textbox" data-testid="protected-editor" aria-label="Protected editor">
        public label <input type="password" aria-label="Nested password" value="${secret}">
      </div>
    `);
    const captured = await fixture.engine.observe!(fixture.operation(), { pixels: false });
    const observed = observedNodes(captured.root);
    const located = await fixture.engine.locate!({ kind: 'selector', selector: '[data-testid]' }, fixture.operation());
    for (const nodes of [observed, located]) {
      for (const id of ['password-empty', 'password-full']) {
        const node = byTestId(nodes, id);
        expect(node.states?.secure, id).toBe(true);
        expect(node.value, id).toBeUndefined();
        expect(node.text, id).toBeUndefined();
        expect(node.selection, id).toBeUndefined();
        expect(node.attributes?.['value'], id).toBeUndefined();
      }
      expect(byTestId(nodes, 'protected-editor').value).toBeUndefined();
      expect(JSON.stringify(nodes).includes(secret), 'Native payload must not contain the synthetic secret').toBe(false);
    }
    expect(captured.truncated).toBe(false);
  } finally {
    await fixture.close();
  }
});
