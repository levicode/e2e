/** Scope-configured frame policy through the real web engine and native process. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { LocatorExpression, OperationContext } from 'e2e/engine';
import { web } from '../../src/index.ts';
import { startFixtureApp } from '../helpers/fixture-app.ts';
import { nativeBrowser, nativeDocument } from '../helpers/native-browser.ts';
import { observedNodes } from '../helpers/native-correlation.ts';
import { startNativeFixture } from '../helpers/native-fixture.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** Resolve each frame in its parent document using the public locator expression. */
function inFrames(selectors: readonly string[], role: string, name: string): LocatorExpression {
  return selectors.reduceRight<LocatorExpression>((source, selector) => ({ kind: 'frame', selector, source }), {
    kind: 'query', query: {
      kind: 'role', value: { kind: 'string', value: role, exact: true },
      name: { kind: 'string', value: name, exact: true },
    },
  });
}

/** Escape a complete srcdoc document for a double-quoted HTML attribute. */
function attribute(html: string): string {
  return html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

it('observes only configured-site child content while loaded offsite frames remain explicitly queryable and caller mutation cannot change policy', async () => {
  const fixtureApp = await startFixtureApp();
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-observation-frame-policy-'));
  const engine = web();
  const app = { site: new URL(fixtureApp.url).hostname };
  const operation = (): OperationContext => ({
    signal: new AbortController().signal, timeoutMs: 10_000,
    runId: 'observation-frame-policy', attemptId: 'site-policy-1', origin: 'test',
  });
  const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 30_000 });
  try {
    await engine.init!({
      runId: 'observation-frame-policy', targetName: 'web', projectRoot: process.cwd(),
      app, env: process.env, headed: false, workerSlot: 0,
      signal: new AbortController().signal, log: () => undefined,
    });
    await engine.startAttempt!({
      attemptId: 'site-policy-1', artifactsDir, signal: new AbortController().signal,
      resolveSecret: noSecrets, ...ignoreTrace,
    });
    await engine.session!.open!(fixtureApp.url, operation());
    const browser = nativeBrowser(engine, operation, fixtureApp.url);
    // Both hostnames reach this owned loopback server, but they are different sites.
    const offsite = fixtureApp.url.replace('127.0.0.1', 'localhost');
    const data = `data:text/html;base64,${Buffer.from('<button>Opaque child marker</button>').toString('base64')}`;
    await nativeDocument(browser, `<h1>Observation policy host</h1>
      <iframe id="allowed" title="allowed" src="${fixtureApp.url}/form"></iframe>
      <iframe id="offsite" title="offsite" src="${offsite}/values"></iframe>
      <iframe id="opaque" title="opaque" src="${data}"></iframe>`);

    // Positive reads rule out failed loads as the reason for missing snapshot content.
    for (const [selector, role, name] of [
      ['#allowed', 'heading', 'Form'], ['#offsite', 'heading', 'Values'],
      ['#opaque', 'button', 'Opaque child marker'],
    ] as const) {
      expect((await engine.locate!(inFrames([selector], role, name), operation())).map(node => node.name)).toEqual([name]);
    }
    for (const changed of [false, true]) {
      // The second capture must still apply the original scope.configure policy.
      if (changed) app.site = 'localhost';
      const snapshot = await engine.observe!({ ...operation(), origin: 'agent' });
      const headings = observedNodes(snapshot.root).filter(node => node.role === 'heading').map(node => node.name);
      expect(headings).toContain('Observation policy host');
      expect(headings).toContain('Form');
      expect(JSON.stringify(snapshot.root)).not.toContain('Values');
      expect(JSON.stringify(snapshot.root)).not.toContain('Opaque child marker');
    }
    expect(app.site).toBe('localhost');
    expect((await engine.locate!(inFrames(['#offsite'], 'heading', 'Values'), operation())).map(node => node.name)).toEqual(['Values']);
    expect((await engine.locate!(inFrames(['#opaque'], 'button', 'Opaque child marker'), operation())).map(node => node.name)).toEqual(['Opaque child marker']);
    await engine.endAttempt!(cleanup());
  } finally {
    try { await engine.dispose!(cleanup()); }
    finally {
      try { await fixtureApp.close(); }
      finally { rmSync(artifactsDir, { recursive: true, force: true }); }
    }
  }
});

it('publishes actionable depth-four srcdoc content but omits a loaded depth-five child and marks the observation truncated', async () => {
  const fixture = await startNativeFixture('observation-frame-depth');
  try {
    let html = '<button>Depth five excluded</button>';
    for (let depth = 4; depth >= 1; depth -= 1) {
      html = `<body style="margin:0"><button onclick="this.textContent = 'Depth four clicked'">Depth ${depth} included</button>` +
        `<iframe id="level-${depth + 1}" style="display:block;border:0;width:400px;height:400px" srcdoc="${attribute(html)}"></iframe></body>`;
    }
    await nativeDocument(fixture.browser, `<h1>Depth host</h1><iframe id="level-1" style="border:0;width:400px;height:400px" srcdoc="${attribute(html)}"></iframe>`);
    const chain = ['#level-1', '#level-2', '#level-3', '#level-4', '#level-5'];
    expect((await fixture.engine.locate!(inFrames(chain, 'button', 'Depth five excluded'), fixture.operation())).map(node => node.name)).toEqual(['Depth five excluded']);

    const snapshot = await fixture.engine.observe!({ ...fixture.operation(), origin: 'agent' });
    const depthFour = observedNodes(snapshot.root).filter(node => node.role === 'button' && node.name === 'Depth 4 included');
    expect(depthFour).toHaveLength(1);
    expect(JSON.stringify(snapshot.root)).not.toContain('Depth five excluded');
    expect(snapshot.truncated).toBe(true);
    // Use the published observation ref, with no intervening locator or re-observation.
    await fixture.engine.perform!(depthFour[0]!.ref, { kind: 'tap' }, fixture.operation());
    expect(await fixture.browser.evaluate(() => {
      let current = document;
      for (let depth = 1; depth <= 4; depth += 1) {
        current = current.querySelector<HTMLIFrameElement>(`#level-${depth}`)!.contentDocument!;
      }
      return current.querySelector('button')!.textContent;
    })).toBe('Depth four clicked');
  } finally {
    await fixture.close();
  }
});
