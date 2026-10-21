/** Next.js App Router's route announcer is never observed; an app's own alert still is. */

import { expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { nativeDocument } from '../helpers/native-browser.ts';
import { startNativeFixture } from '../helpers/native-fixture.ts';

const PAGE = `<!doctype html><html lang="en"><head><title>Acme Notes</title></head><body>
  <div role="alert" data-testid="app-alert">Acme Notes</div>
  <next-route-announcer></next-route-announcer>
  <script>
    document.querySelector('next-route-announcer').attachShadow({ mode: 'open' }).innerHTML =
      '<div id="__next-route-announcer__" role="alert" aria-live="assertive" style="position:absolute;width:1px;height:1px;overflow:hidden"></div>';
  </script>
</body></html>`;

/** Flatten only the protected observation. */
function flatten(node: SemanticNode): SemanticNode[] {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

it('omits the announcer empty or populated and keeps the app alert', async () => {
  const fixture = await startNativeFixture('route-announcer');
  try {
    await nativeDocument(fixture.browser, PAGE);
    for (const text of ['', 'Acme Notes']) {
      await fixture.browser.evaluate((value) => {
        document.querySelector('next-route-announcer')!.shadowRoot!.querySelector('#__next-route-announcer__')!.textContent = value;
        return null;
      }, text);
      const snapshot = await fixture.engine.observe!({ ...fixture.operation(), origin: 'agent' });
      expect(flatten(snapshot.root).filter((node) => node.role === 'alert')).toMatchObject([{ name: 'Acme Notes', testId: 'app-alert' }]);
    }
    expect(await fixture.browser.evaluate(() => document.querySelector('next-route-announcer')!.shadowRoot!.querySelector<HTMLElement>('#__next-route-announcer__')!.innerText)).toBe('Acme Notes');
  } finally {
    await fixture.close();
  }
});
