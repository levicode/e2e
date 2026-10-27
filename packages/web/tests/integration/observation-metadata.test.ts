import { expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { nativeDocument } from '../helpers/native-browser.ts';
import { startNativeFixture } from '../helpers/native-fixture.ts';

function descendants(node: SemanticNode): SemanticNode[] {
  return [node, ...(node.children ?? []).flatMap(descendants)];
}

it.each(['stringify', 'bound-stringify', 'object-toJSON', 'array-toJSON', 'function-toString'] as const)('captures live refs when the page overrides %s', async (override) => {
  const fixture = await startNativeFixture(`observation-metadata-${override}`);
  try {
    await nativeDocument(fixture.browser, `<button onclick="this.textContent = 'Clicked'">Preserved "quoted" name</button>
      <input type="password" aria-label="Password" value="withheld-secret">`);
    await fixture.browser.evaluate((kind) => {
      if (kind === 'stringify') JSON.stringify = () => '{"nodes":[],"ids":[],"truncated":false}';
      else if (kind === 'bound-stringify') {
        // oxlint-disable-next-line no-extra-bind -- Bound replacements stringify like anonymous native functions.
        JSON.stringify = (() => 'not JSON').bind(null);
      } else if (kind === 'function-toString') {
        // oxlint-disable-next-line no-extend-native -- Serializer detection must survive application overrides too.
        Function.prototype.toString = () => { throw new Error('disabled'); };
      } else {
        // oxlint-disable-next-line no-extend-native -- The fixture reproduces application prototype overrides.
        Object.defineProperty(kind === 'object-toJSON' ? Object.prototype : Array.prototype, 'toJSON', {
          value: () => 'not metadata', configurable: true,
        });
      }
      return null;
    }, override);
    const captured = await fixture.engine.observe!({ ...fixture.operation(), origin: 'agent' });

    // The former reader's three total nodes were implementation metadata, not a
    // public shape contract: native AX may retain additional static-text nodes.
    // Preserve both controls, exact labels/privacy, non-truncation, and live identity.
    const nodes = descendants(captured.root);
    const buttons = nodes.filter(node => node.role === 'button');
    const passwords = nodes.filter(node => node.states?.secure === true && node.name === 'Password');
    expect(buttons).toHaveLength(1);
    expect(passwords).toHaveLength(1);
    expect(captured.truncated ?? false).toBe(false);
    const button = buttons[0];
    expect(button).toMatchObject({ role: 'button', name: 'Preserved "quoted" name' });
    expect(passwords[0]).toMatchObject({ states: { secure: true }, name: 'Password' });
    expect(JSON.stringify(captured.root)).not.toContain('withheld-secret');
    await fixture.engine.perform!(button!.ref, { kind: 'tap' }, fixture.operation());
    expect(await fixture.browser.evaluate(() => document.querySelector('button')!.textContent)).toBe('Clicked');
  } finally {
    await fixture.close();
  }
});
