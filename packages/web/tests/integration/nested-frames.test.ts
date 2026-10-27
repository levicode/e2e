/**
 * A `frameLocator` chain resolves each frame inside the one before it: the
 * inner selector is looked up in the outer frame's document, never in the
 * page. The page's DOM geometry supplies an independent box oracle. A
 * located node's box is in the top-level viewport, as the contract asks.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LocatorExpression } from 'e2e/engine';
import { web, type Browser } from '../../src/index.ts';
import { nativeBrowser, nativeDocument } from '../helpers/native-browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
import { NativeClient } from '../../src/native/client.ts';
import { beginSyntheticCase, type SyntheticCaseId, type SyntheticEvidence, type SyntheticOutcome, type SyntheticPhase } from '../helpers/synthetic-evidence.ts';
import { observeSyntheticConnection, SyntheticNativeObserver } from '../helpers/synthetic-native-outcomes.ts';

/** Test-only boundaries. A missing footer remains unknown, including a hard test timeout. */
class CaseEvidence {
  readonly evidence: SyntheticEvidence;
  readonly outcome: SyntheticOutcome = { setup: 'not-started', body: 'not-started', cleanup: 'not-started' };
  readonly observer: SyntheticNativeObserver;
  currentPhase: SyntheticPhase = 'init';
  section: keyof SyntheticOutcome = 'setup';
  private active: { section: keyof SyntheticOutcome; phase: SyntheticPhase } | undefined;
  constructor(id: SyntheticCaseId) {
    this.evidence = beginSyntheticCase(id);
    this.observer = new SyntheticNativeObserver(this.evidence, () => this.currentPhase);
  }
  phase(section: keyof SyntheticOutcome, phase: SyntheticPhase): void {
    // A different hook may start after a hard timeout; that is not a returned phase.
    if (this.active?.section === section) this.returned();
    else this.active = undefined;
    this.section = section; this.currentPhase = phase;
    if (this.outcome[section] !== 'failed') this.outcome[section] = 'incomplete';
    this.active = { section, phase };
    this.evidence.record({ kind: 'phase', section, phase, state: 'enter' });
  }
  returned(): void {
    if (this.active !== undefined) this.evidence.record({ kind: 'phase', ...this.active, state: 'passed' });
    this.active = undefined;
  }
  passed(section: keyof SyntheticOutcome): void {
    if (this.active?.section === section) this.returned();
    else this.active = undefined;
    if (this.outcome[section] !== 'failed') this.outcome[section] = 'passed';
  }
  failed(section: keyof SyntheticOutcome = this.section): void {
    if (this.active?.section === section) this.evidence.record({ kind: 'phase', ...this.active, state: 'failed' });
    this.active = undefined;
    this.outcome[section] = 'failed';
  }
  finish(): void { this.observer.close(); this.evidence.finish(this.outcome); }
}

/** Capture only this file's owned fixture connections; never patch a client prototype. */
function watchConnections(evidence: CaseEvidence | undefined, clients: Set<NativeClient>): () => void {
  try {
    const connect = NativeClient.connect;
    const connection = vi.spyOn(NativeClient, 'connect').mockImplementation((...args) => {
      const pending = connect(...args);
      // Passive observation preserves the exact original Promise but adds a microtask observer.
      void pending.then(client => { clients.add(client); }, () => {}).catch(() => { evidence?.evidence.invalidate(); });
      return observeSyntheticConnection(pending);
    });
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      try { connection.mockRestore(); } catch { evidence?.evidence.invalidate(); }
    };
  } catch { evidence?.evidence.invalidate(); return () => {}; }
}

/** Escapes HTML for a double-quoted attribute value, so a document can carry a nested `srcdoc`. */
function attribute(html: string): string {
  return html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Wraps `source` in `frame` scopes, outermost first, as a `browser.frameLocator` chain does. */
function withinFrames(selectors: readonly string[], source: LocatorExpression): LocatorExpression {
  return selectors.reduceRight<LocatorExpression>(
    (inner, selector) => ({ kind: 'frame', selector, source: inner }),
    source,
  );
}

const TWIN_FRAME = '<iframe class="twin" title="twin" srcdoc="<p>twin</p>"></iframe>';
const DEEP_DOCUMENT = '<button>Deep button</button>';
const INNER_DOCUMENT =
  '<button onclick="this.textContent = \'Inner clicked\'">Inner button</button>' +
  `<iframe id="deep" title="deep" srcdoc="${attribute(DEEP_DOCUMENT)}"></iframe>`;
const OUTER_DOCUMENT =
  `<h2>Outer</h2><iframe id="inner" title="inner" style="border:7px solid;padding:5px" srcdoc="${attribute(INNER_DOCUMENT)}"></iframe>` +
  TWIN_FRAME +
  TWIN_FRAME;
const HOST_DOCUMENT =
  '<h1>Host</h1><iframe id="aside" title="aside" srcdoc="<p>aside</p>"></iframe>' +
  TWIN_FRAME +
  `<iframe id="outer" title="outer" srcdoc="${attribute(OUTER_DOCUMENT)}"></iframe>`;

/** A role query for the one button named `name`. */
function buttonNamed(name: string): LocatorExpression {
  return {
    kind: 'query',
    query: {
      kind: 'role',
      value: { kind: 'string', value: 'button', exact: true },
      name: { kind: 'string', value: name, exact: true },
    },
  };
}

const INNER_BUTTON = buttonNamed('Inner button');
const DEEP_BUTTON = buttonNamed('Deep button');

describe('nested frame locators', () => {
  const engine = web({});
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-nested-frames-'));
  const signal = new AbortController().signal;
  const operation = { signal, timeoutMs: 5_000, runId: 'frames', attemptId: 'attempt', origin: 'test' as const };
  const cleanup = { signal, timeoutMs: 30_000 };
  let browser: Browser;
  let setupEvidence: CaseEvidence | undefined;
  const fixtureClients = new Set<NativeClient>();
  let restoreSetupConnection = () => {};

  function frameCase(id: SyntheticCaseId, body: (evidence: CaseEvidence) => Promise<void>) {
    return (): Promise<void> => {
      const evidence = new CaseEvidence(id);
      // Shared setup/cleanup is solely nested-setup; not-started here is intentional.
      for (const client of fixtureClients) evidence.observer.attach(client);
      const restore = watchConnections(evidence, fixtureClients);
      return evidence.observer.run(async () => {
        try { await body(evidence); evidence.passed('body'); }
        catch (cause) { evidence.failed('body'); throw cause; }
        finally { restore(); evidence.finish(); }
      });
    };
  }

  beforeAll(() => {
    const evidence = setupEvidence = new CaseEvidence('nested-setup');
    const restore = restoreSetupConnection = watchConnections(evidence, fixtureClients);
    return evidence.observer.run(async () => {
      try {
        evidence.phase('setup', 'init');
        await engine.init!({ runId: 'frames', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: process.env, headed: false, workerSlot: 0, signal, log: () => undefined });
        evidence.phase('setup', 'start');
        await engine.startAttempt!({ attemptId: 'attempt', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
        evidence.phase('setup', 'open');
        await engine.session!.open!('about:blank', operation);
        evidence.phase('setup', 'fixture-create');
        browser = nativeBrowser(engine, () => operation);
        evidence.phase('setup', 'document');
        await nativeDocument(browser, HOST_DOCUMENT);
        evidence.phase('setup', 'readiness');
        await vi.waitFor(async () => {
          expect(await browser.evaluate(() => {
            const outer = document.querySelector<HTMLIFrameElement>('#outer')?.contentDocument;
            const inner = outer?.querySelector<HTMLIFrameElement>('#inner')?.contentDocument;
            const deep = inner?.querySelector<HTMLIFrameElement>('#deep')?.contentDocument;
            return deep?.querySelector('button')?.textContent ?? null;
          })).toBe('Deep button');
        }, { timeout: 1_000, interval: 50 });
        evidence.passed('setup');
      } catch (cause) { evidence.failed('setup'); throw cause; }
      finally { restore(); evidence.observer.close(); }
    });
  });

  afterAll(async () => {
    try {
      setupEvidence?.phase('cleanup', 'end');
      await engine.endAttempt!(cleanup);
      setupEvidence?.phase('cleanup', 'dispose');
      await engine.dispose!(cleanup);
      rmSync(artifactsDir, { recursive: true, force: true });
      setupEvidence?.passed('cleanup');
    } catch (cause) { setupEvidence?.failed('cleanup'); throw cause; }
    finally { restoreSetupConnection(); setupEvidence?.finish(); }
  });

  it('resolves a two-level chain and taps inside the innermost frame', frameCase('P36', async (evidence) => {
    evidence.phase('body', 'locate');
    const matches = await engine.locate!(withinFrames(['#outer', '#inner'], INNER_BUTTON), operation);
    evidence.phase('body', 'assertion');
    expect(matches.map((node) => node.name)).toEqual(['Inner button']);
    evidence.phase('body', 'perform');
    await engine.perform!(matches[0]!.ref, { kind: 'tap' }, operation);
    evidence.phase('body', 'evaluate');
    expect(await browser.evaluate(() => document.querySelector<HTMLIFrameElement>('#outer')!.contentDocument!
      .querySelector<HTMLIFrameElement>('#inner')!.contentDocument!.querySelector('button')!.textContent)).toBe('Inner clicked');
  }));

  it('reports a located node\'s box in the top-level viewport, past each frame\'s border and padding', frameCase('P37', async (evidence) => {
    // The inner document's one button, whatever an earlier test renamed it to.
    const button: LocatorExpression = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } };
    evidence.phase('body', 'locate');
    const [node] = await engine.locate!(withinFrames(['#outer', '#inner'], button), operation);
    // DOM rectangles and computed frame insets are independent of the native query projection.
    evidence.phase('body', 'evaluate');
    const expected = await browser.evaluate(() => {
      const outer = document.querySelector<HTMLIFrameElement>('#outer')!;
      const inner = outer.contentDocument!.querySelector<HTMLIFrameElement>('#inner')!;
      const element = inner.contentDocument!.querySelector('button')!;
      const bounds = element.getBoundingClientRect();
      const inset = (frame: HTMLIFrameElement) => {
        const rect = frame.getBoundingClientRect();
        const style = frame.ownerDocument.defaultView!.getComputedStyle(frame);
        return { x: rect.x + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
          y: rect.y + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop) };
      };
      const outside = inset(outer);
      const inside = inset(inner);
      return { x: outside.x + inside.x + bounds.x, y: outside.y + inside.y + bounds.y, width: bounds.width, height: bounds.height };
    });
    evidence.phase('body', 'assertion');
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(node!.rect![key]).toBeCloseTo(expected[key], 3);
  }));

  it('resolves a three-level chain, counting the last frame inside the second', frameCase('P38', async (evidence) => {
    evidence.phase('body', 'locate');
    const matches = await engine.locate!(withinFrames(['#outer', '#inner', '#deep'], DEEP_BUTTON), operation);
    evidence.phase('body', 'assertion');
    expect(matches.map((node) => node.name)).toEqual(['Deep button']);
    evidence.phase('body', 'locate');
    await expect(engine.locate!(withinFrames(['#outer', '#deep'], DEEP_BUTTON), operation)).rejects.toMatchObject({
      code: 'FRAME_NOT_FOUND',
      message: 'no frame matches #deep',
    });
  }));

  it('names the inner selector when the outer frame holds no such frame, even though the page does', frameCase('P39', async (evidence) => {
    evidence.phase('body', 'locate');
    await expect(engine.locate!(withinFrames(['#outer', '#aside'], INNER_BUTTON), operation)).rejects.toMatchObject({
      code: 'FRAME_NOT_FOUND',
      message: 'no frame matches #aside',
      retryable: true,
    });
  }));

  it('reports two matching frames inside the outer document as ambiguous, though the page holds one', frameCase('P40', async (evidence) => {
    evidence.phase('body', 'evaluate');
    expect(await browser.evaluate(() => document.querySelectorAll('.twin').length)).toBe(1);
    evidence.phase('body', 'locate');
    await expect(engine.locate!(withinFrames(['#outer', '.twin'], INNER_BUTTON), operation)).rejects.toMatchObject({
      code: 'FRAME_AMBIGUOUS',
      message: '2 frames match .twin',
      retryable: false,
    });
  }));
});
