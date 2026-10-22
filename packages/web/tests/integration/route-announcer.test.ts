import { beginSyntheticCase } from '../helpers/synthetic-evidence.ts';
import { SyntheticRecoveryEvidence } from '../helpers/synthetic-native-outcomes.ts';
/** Next.js App Router's route announcer is never observed; an app's own alert still is. */

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { projectionDiagnostics } from '../helpers/projection-diagnostics.ts';
import { nativeDocument } from '../helpers/native-browser.ts';
import { startNativeFixture } from '../helpers/native-fixture.ts';

// The source hash binds every diagnostic ordinal below to its exact fixture mapping.
const projection = projectionDiagnostics(readFileSync(new URL(import.meta.url), 'utf8'));

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
  const evidence = new SyntheticRecoveryEvidence(beginSyntheticCase('P43'));
  evidence.enter('start');
  let fixture: Awaited<ReturnType<typeof startNativeFixture>>;
  try { fixture = await startNativeFixture('route-announcer'); }
  catch (cause) { evidence.failed('setup'); evidence.observer.close(); evidence.evidence.finish(evidence.outcome); throw cause; }
  evidence.passed('setup');
  try {
    evidence.enter('document', 'body');
    await nativeDocument(fixture.browser, PAGE);
    for (const text of ['', 'Acme Notes']) {
      await fixture.browser.evaluate((value) => {
        document.querySelector('next-route-announcer')!.shadowRoot!.querySelector('#__next-route-announcer__')!.textContent = value;
        return null;
      }, text);
      evidence.enter('observe');
      const snapshot = await fixture.engine.observe!({ ...fixture.operation(), origin: 'agent' });
      const alerts = flatten(snapshot.root).filter((node) => node.role === 'alert');
      const appAlerts = alerts.filter(node => node.testId === 'app-alert');
      // Ordinal 0 is the static app-alert fixture. Ordinal 1 counts unmatched
      // alerts without assuming their identity or exposing their names/IDs.
      const diagnostic = projection(text === '' ? 'announcer-empty' : 'announcer-populated',
        { observedCount: alerts.length, expectedCount: 1 }, [
          { ordinal: 0, missing: appAlerts.length === 0, presentCount: appAlerts.length,
            nameMatches: appAlerts.length === 1 && appAlerts[0]!.name === 'Acme Notes' },
          { ordinal: 1, presentCount: alerts.length - appAlerts.length },
        ]);
      evidence.enter('assertion');
      expect(alerts, diagnostic).toMatchObject([{ name: 'Acme Notes', testId: 'app-alert' }]);
    }
    expect(await fixture.browser.evaluate(() => document.querySelector('next-route-announcer')!.shadowRoot!.querySelector<HTMLElement>('#__next-route-announcer__')!.innerText)).toBe('Acme Notes');
    evidence.passed('body');
  } catch (cause) { evidence.failed('body'); throw cause; }
  finally {
    evidence.enter('dispose', 'cleanup');
    let cleanupFailed = false;
    try { await fixture.close(); }
    // eslint-disable-next-line no-unsafe-finally -- Preserve the original cleanup exception precedence.
    catch (cause) { cleanupFailed = true; throw cause; }
    finally { evidence.finishBackstop(cleanupFailed); }
  }
});
