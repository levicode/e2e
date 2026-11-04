/** The real reader reports the text selected inside the focused field, and only there. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { nativeDocument } from '../helpers/native-browser.ts';
import { startNativeFixture, type NativeFixture } from '../helpers/native-fixture.ts';

let fixture: NativeFixture | undefined;

beforeAll(async () => { fixture = await startNativeFixture('read-node-selection'); });
afterAll(async () => { await fixture?.close(); });

/** One observation of the page through the same capture the engine uses, keyed by test id. */
async function captureByTestId(): Promise<Map<string | undefined, SemanticNode>> {
  const { root: tree } = await fixture!.engine.observe!({ ...fixture!.operation(), origin: 'agent' });
  const nodes: SemanticNode[] = [];
  const walk = (node: SemanticNode) => { nodes.push(node); for (const child of node.children ?? []) walk(child); };
  walk(tree);
  return new Map(nodes.map((node) => [node.testId, node]));
}

describe('selection', () => {
  it('reports the selected text of the focused input or editing host and nothing for a caret, an unfocused field, or a secure one', async () => {
    await nativeDocument(fixture!.browser, `
      <input data-testid="field" value="release approved">
      <textarea data-testid="note">first line</textarea>
      <div data-testid="editor" contenteditable>release approved</div>
      <input type="password" data-testid="secret" value="hunter2">
    `);

    await fixture!.browser.evaluate(() => {
      const field = document.querySelector<HTMLInputElement>('[data-testid=field]')!;
      field.focus(); field.setSelectionRange(8, 16);
      return null;
    });
    let nodes = await captureByTestId();
    expect(nodes.get('field')).toMatchObject({ value: 'release approved', selection: 'approved', states: { focused: true } });
    expect(nodes.get('note')?.selection).toBeUndefined();
    expect(nodes.get('editor')?.selection).toBeUndefined();

    await fixture!.browser.evaluate(() => {
      const note = document.querySelector<HTMLTextAreaElement>('[data-testid=note]')!;
      note.focus(); note.setSelectionRange(6, 10);
      return null;
    });
    nodes = await captureByTestId();
    expect(nodes.get('note')?.selection).toBe('line');
    // The input keeps its range while unfocused; only the focused field reports one.
    expect(nodes.get('field')?.selection).toBeUndefined();

    const editors = await fixture!.engine.locate!({ kind: 'selector', selector: '[data-testid=editor]' }, fixture!.operation());
    expect(editors).toHaveLength(1);
    await fixture!.engine.perform!(editors[0]!.ref, { kind: 'tap' }, fixture!.operation());
    await fixture!.browser.keyboard.press('End');
    nodes = await captureByTestId();
    expect(nodes.get('editor')).toMatchObject({ role: 'textbox', value: 'release approved', states: { focused: true } });
    expect(nodes.get('editor')?.selection).toBeUndefined();

    for (let index = 0; index < 'approved'.length; index += 1) await fixture!.browser.keyboard.press('Shift+ArrowLeft');
    nodes = await captureByTestId();
    expect(nodes.get('editor')?.selection).toBe('approved');

    await fixture!.browser.evaluate(() => {
      const secret = document.querySelector<HTMLInputElement>('[data-testid=secret]')!;
      secret.focus(); secret.select();
      return null;
    });
    nodes = await captureByTestId();
    expect(nodes.get('secret')?.states?.secure).toBe(true);
    expect(nodes.get('secret')?.value).toBeUndefined();
    expect(nodes.get('secret')?.selection).toBeUndefined();
  });
});
