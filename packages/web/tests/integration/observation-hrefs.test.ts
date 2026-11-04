import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { projectionDiagnostics } from '../helpers/projection-diagnostics.ts';
import { nativeDocument } from '../helpers/native-browser.ts';
import { startNativeFixture } from '../helpers/native-fixture.ts';

// The source hash binds every diagnostic ordinal below to its exact fixture mapping.
const projection = projectionDiagnostics(readFileSync(new URL(import.meta.url), 'utf8'));

it('reports link targets as origin and whole path, marking a dropped query, fragment, or opaque payload', async () => {
  const fixture = await startNativeFixture('observation-hrefs');
  try {
    const project = '/dashboard/e2e-dc3cf837/projects/404b2532-9fab-44dc-b3d0-f0a1b2c3d4e5/runs/7d0c3b52-2f7e-4c55-9a51-6f1e0c9b8a77';
    await nativeDocument(fixture.browser, `<base href="http://app.test/dashboard/">
      <a href="${project}">Project</a>
      <a href="https://user:pass@docs.example.test/guides/setup">Docs</a>
      <a href="search?q=token&amp;page=2">Search</a>
      <a href="settings#billing">Billing</a>
      <a href="mailto:team@example.test?subject=hi">Mail</a>
      <a href="tel:+48123456789">Call</a>
      <a href="data:text/csv,${'id,name%0A1,Ada%0A'.repeat(200)}">Export</a>
      <a href="javascript:void(document.body.dataset.clicked = 'yes')">Script</a>
      <a href="blob:http://app.test/0b7c4c1e-8d9a-4f2e-9c1b-2a3d4e5f6a7b">Download</a>
      <a href="blob:https://user:pass@files.example.test/0b7c4c1e?token=abc">Signed</a>
      <a href="blob:null/0b7c4c1e">Opaque</a>`);
    const captured = await fixture.engine.observe!({ ...fixture.operation(), origin: 'agent' });

    const hrefs = Object.fromEntries((captured.root.children ?? []).map((node) => [node.name, node.attributes?.['href']]));
    const expected = {
      Project: `http://app.test${project}`,
      Docs: 'https://docs.example.test/guides/setup',
      Search: 'http://app.test/dashboard/search?…',
      Billing: 'http://app.test/dashboard/settings#…',
      Mail: 'mailto:team@example.test?…',
      Call: 'tel:+48123456789',
      Export: 'data:…',
      Script: 'javascript:…',
      Download: 'blob:http://app.test/0b7c4c1e-8d9a-4f2e-9c1b-2a3d4e5f6a7b',
      Signed: 'blob:https://files.example.test/0b7c4c1e?…',
      Opaque: 'blob:…',
    };
    // Ordinals follow the static expected map, never observed names or hrefs.
    const diagnostic = projection('hrefs', { observedCount: Object.keys(hrefs).length, expectedCount: Object.keys(expected).length },
      Object.entries(expected).map(([name, href], ordinal) => {
        const actual = hrefs[name];
        return {
          ordinal, missing: !Object.hasOwn(hrefs, name), hrefMatches: actual === href,
          hrefMissing: actual === undefined,
          ...(typeof actual === 'string' ? { hrefLength: actual.length } : {}),
          presentCount: (captured.root.children ?? []).filter(node => node.name === name).length,
        };
      }));
    expect(hrefs, diagnostic).toEqual(expected);
  } finally {
    await fixture.close();
  }
});
