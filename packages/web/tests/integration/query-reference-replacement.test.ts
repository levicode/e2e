/**
 * Frozen source: 6fe0a07db4d65d3cb8275bb66651a114b8fee34b. Observations retain
 * original ElementHandles. surface.ts:678-772 pins displayValue/exact-label,
 * retains a strict Locator for one other result, and nth(originalIndex) for
 * multiple results. locators.ts keeps explicit indices and FrameLocators logical.
 *
 * These fixed, plain-DOM probes reproduce that retained object, not a second
 * selector engine. No legacy production imports, reference table or fake fixture
 * context. Native Browser owns setup, mutation and all event readback; the
 * explicitly opted-in Playwright client only reads and performs its retained
 * action. Element actions merely append synthetic witnesses, never mutate the DOM.
 * The viewport case separately compares equal, unclamped scroll increments.
 *
 * Direct calls use Browser's actual TargetSession, without LocatorEngine's
 * NODE_STALE re-resolution. Its cached read is deliberately asserted unchanged.
 * Element probes cover same-document replacement; the viewport probe separately
 * covers same-Page navigation. Neither relaxes frame or cross-session authority.
 * This is a Playwright primitive oracle, not execution of the frozen RefRegistry.
 * Official d7c6b5e5 lifecycle tests independently establish the API lifetime
 * obligations. A disagreement fails acceptance.
 */
import type { LocatorExpression, NodeRef, SemanticNode } from 'e2e/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nativeDocument } from '../helpers/native-browser.ts';
import { startNativeActionOracle, type NativeActionOracle } from '../helpers/native-oracle.ts';

const ACTION_TIMEOUT = 2_000;
const MATCH: LocatorExpression = { kind: 'selector', selector: '.match' };
const DISPLAY_VALUE: LocatorExpression = {
  kind: 'query', query: { kind: 'displayValue', value: { kind: 'string', value: 'chosen', exact: true } },
};
const EXACT_LABEL: LocatorExpression = {
  kind: 'query', query: { kind: 'label', value: { kind: 'string', value: 'Choice', exact: true } },
};
const FRAME_MATCH: LocatorExpression = {
  kind: 'frame', selector: 'iframe[name="outer"]', source: {
    kind: 'frame', selector: 'iframe[name="inner"]', source: MATCH,
  },
};
type WitnessWindow = Window & { referenceActionEvents: string[] };
type SourceTarget = { click(options: { timeout: number }): Promise<void> };
type Failure = { readonly message: string; readonly code?: unknown };
type ActionOutcome = {
  readonly status: 'returned' | 'refused';
  readonly events: string[] | null;
  readonly logIntact: boolean;
  readonly error?: Failure;
  readonly readbackErrors: Failure[];
};
type Retained = { readonly ref: NodeRef; readonly cached: SemanticNode };

/** No default form/navigation behavior: the only app effect is the event witness. */
function button(id: 'A' | 'B' | 'X'): string {
  return `<button type="button" class="match" data-testid="${id}" onclick="top.referenceActionEvents.push(this.dataset.testid)">${id}</button>`;
}

/** Plain input values and aria-labels avoid unrelated label-composition semantics. */
function field(id: 'A' | 'B'): string {
  return `<input data-testid="${id}" aria-label="Choice" value="chosen" onclick="top.referenceActionEvents.push(this.dataset.testid)">`;
}

/** Wraps a synthetic document without creating adapter-side reference authority. */
function documentHtml(body: string): string {
  return `<!doctype html><html><body>${body}<script>window.referenceActionEvents = [];</script></body></html>`;
}

/** Nest a complete same-origin srcdoc document in a fixed frame selector. */
function frame(name: 'outer' | 'inner', body: string): string {
  const srcdoc = `<!doctype html><html><body>${body}</body></html>`.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<iframe name="${name}" srcdoc="${srcdoc}"></iframe>`;
}

/** Traverse one observed tree, without re-resolving or manufacturing its refs. */
function observedNodes(node: SemanticNode): SemanticNode[] {
  return [node, ...(node.children ?? []).flatMap(observedNodes)];
}

describe('retained query-reference replacement matches the frozen source action', () => {
  let fixture: NativeActionOracle;
  let closed = true;
  beforeEach(async () => { fixture = await startNativeActionOracle('query-reference-replacement'); closed = false; });
  afterEach(close);

  /** Cleanup is attempted once, in the oracle helper's fixture/connection/host order. */
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await fixture.close();
  }

  /** The public Browser reads the synthetic log after each independent action. */
  const events = () => fixture.browser.evaluate(() => [...(window as unknown as WitnessWindow).referenceActionEvents]);

  /** Retain diagnostic text and the native code without reclassifying either backend. */
  function failure(cause: unknown): Failure {
    return {
      message: cause instanceof Error ? cause.message : String(cause),
      ...(typeof cause === 'object' && cause !== null && 'code' in cause ? { code: cause.code } : {}),
    };
  }

  /** Capture failures as data so neither a dispatch nor a readback failure skips the other side. */
  async function record(action: () => Promise<void>): Promise<ActionOutcome> {
    const readbackErrors: Failure[] = [];
    const before = await events().catch(cause => { readbackErrors.push(failure(cause)); return null; });
    let error: Failure | undefined;
    try { await action(); } catch (cause) { error = failure(cause); }
    const after = await events().catch(cause => { readbackErrors.push(failure(cause)); return null; });
    return {
      status: error === undefined ? 'returned' : 'refused',
      events: before === null || after === null ? null : after.slice(before.length),
      logIntact: before !== null && after !== null && JSON.stringify(after.slice(0, before.length)) === JSON.stringify(before),
      ...(error === undefined ? {} : { error }), readbackErrors,
    };
  }

  /** Resolve once through the actual fixture session, then keep its cached read. */
  async function retain(expression: LocatorExpression, ids: readonly string[], index = 0): Promise<Retained> {
    const refs = await fixture.session.locate(expression, fixture.operation(), { purpose: 'fixture' });
    const nodes = await Promise.all(refs.map(ref => fixture.session.read(ref, fixture.operation())));
    expect(nodes.map(node => node.testId)).toEqual(ids);
    return { ref: refs[index]!, cached: structuredClone(nodes[index]!) };
  }

  /**
   * Native runs first; even its failure cannot skip the retained source action.
   * Capture all evidence, close fixture/connection/host, then assert the source
   * prediction AND native agreement. A mismatch is never a passing diagnostic.
   */
  async function compare(target: NodeRef | Retained, source: SourceTarget, expected: 'A' | 'B' | 'refused', refusal?: RegExp): Promise<void> {
    const retained = 'cached' in target ? target : undefined;
    const ref = 'cached' in target ? target.ref : target;
    const readCached = () => retained === undefined ? undefined : fixture.session.read(ref, fixture.operation())
      .then(node => ({ node: structuredClone(node) }), cause => ({ error: failure(cause) }));
    const before = await events();
    const cachedBefore = await readCached();
    const nativeResult = await record(() => fixture.session.perform(ref, { kind: 'tap' }, { ...fixture.operation(), timeoutMs: ACTION_TIMEOUT }));
    const sourceResult = await record(() => source.click({ timeout: ACTION_TIMEOUT }));
    const cachedAfter = await readCached();
    const finalEvents = await events().then(value => ({ value }), cause => ({ error: failure(cause) }));
    let cleanupError: Failure | undefined;
    try { await close(); } catch (cause) { cleanupError = failure(cause); }

    const prediction = { status: expected === 'refused' ? 'refused' : 'returned', events: expected === 'refused' ? [] : [expected] };
    const evidence = JSON.stringify({ nativeResult, sourceResult });
    expect.soft(cleanupError, `cleanup must finish before assertions: ${evidence}`).toBeUndefined();
    expect.soft(sourceResult, `frozen-source retained object prediction: ${evidence}`).toMatchObject({ ...prediction, logIntact: true, readbackErrors: [] });
    if (expected === 'refused') {
      expect.soft(sourceResult.error?.message, 'oracle refusal must be detach/strictness, not an unrelated timeout or infrastructure error').toMatch(refusal!);
      expect.soft(nativeResult.error?.code, 'native refusal must preserve the stale-reference contract').toBe('NODE_STALE');
    }
    expect.soft(nativeResult, `native action must satisfy the source prediction: ${evidence}`).toMatchObject({ ...prediction, logIntact: true, readbackErrors: [] });
    expect.soft({ status: nativeResult.status, events: nativeResult.events }, 'actual native and source outcomes must agree').toEqual({ status: sourceResult.status, events: sourceResult.events });
    if (retained !== undefined) {
      expect.soft(cachedBefore, 'cached read after mutation still describes the original resolution').toEqual({ node: retained.cached });
      expect.soft(cachedAfter, 'cached read cannot hide an action-target disagreement').toEqual({ node: retained.cached });
    }
    expect(finalEvents, 'both sides must leave exactly the predicted app effects').toEqual({ value: [...before, ...prediction.events, ...prediction.events] });
  }

  it('unchanged strict reference clicks A, with a baseline public locator smoke', async () => {
    await nativeDocument(fixture.browser, documentHtml(button('A')));
    await fixture.browser.locator('.match').click();
    expect(await events()).toEqual(['A']);
    const retained = await retain(MATCH, ['A']);
    const source = fixture.actionOracle.locator('.match');
    expect(await source.count()).toBe(1);
    await compare(retained, source, 'A');
  });

  it('an observed live A remains actionable after a new observation, like the retained source handle', async () => {
    await nativeDocument(fixture.browser, documentHtml(button('A')));
    const first = await fixture.session.observe(fixture.operation());
    expect(first.kind).toBe('semantic');
    if (first.kind !== 'semantic') throw new Error('This fixture requires a semantic observation');
    const original = observedNodes(first.tree).filter(node => node.testId === 'A');
    expect(original).toHaveLength(1);
    const source = await fixture.actionOracle.locator('.match').elementHandle();
    expect(source).not.toBeNull();
    const second = await fixture.session.observe(fixture.operation());
    expect(second.kind).toBe('semantic');
    if (second.kind !== 'semantic') throw new Error('This fixture requires a semantic observation');
    const current = observedNodes(second.tree).filter(node => node.testId === 'A');
    expect(current).toHaveLength(1);
    expect(current[0]!.ref.id).toBe(original[0]!.ref.id);
    // Core presentation generations remain fresh. ReferenceEvidence must still
    // resolve the old presentation to its unchanged native issuance, not widen bN.
    expect(second.tree.ref.revision).not.toBe(first.tree.ref.revision);
    expect(current[0]!.ref.revision).not.toBe(original[0]!.ref.revision);
    await compare(original[0]!.ref, source!, 'A');
  });

  it('the same observed DOM object detached and reinserted remains A, not a replacement object', async () => {
    await nativeDocument(fixture.browser, documentHtml(button('A')));
    const observation = await fixture.session.observe(fixture.operation());
    expect(observation.kind).toBe('semantic');
    if (observation.kind !== 'semantic') throw new Error('This fixture requires a semantic observation');
    const matches = observedNodes(observation.tree).filter(node => node.testId === 'A');
    expect(matches).toHaveLength(1);
    const source = await fixture.actionOracle.locator('.match').elementHandle();
    expect(source).not.toBeNull();
    await fixture.browser.evaluate(() => {
      const original = document.querySelector('.match')!;
      original.remove();
      document.body.append(original);
      return null;
    });
    // No intervening committed observation omitted A. This does not authorize an
    // omitted node or a new, same-looking backend to reuse the old capability.
    await compare(matches[0]!.ref, source!, 'A');
  });

  it('the original viewport survives same-Page navigation like the retained source Page', async () => {
    await nativeDocument(fixture.browser, documentHtml(button('A')));
    const first = await fixture.engine.observe!(fixture.operation());
    expect(first.viewportRef).toBeDefined();
    const sourcePage = fixture.actionOracle; // Never reacquire a Page after navigation.
    await fixture.engine.session!.open!('about:blank?viewport-lifetime', fixture.operation());
    await nativeDocument(fixture.browser, documentHtml(`
      <style>html,body { margin:0; scroll-behavior:auto } body { height:4000px }</style>
      <script>addEventListener('wheel', event => {
        referenceActionEvents.push(event.deltaY === Math.round(innerHeight / 2) ? 'A' : 'unexpected-wheel');
      });</script>
    `));
    const second = await fixture.engine.observe!(fixture.operation());
    expect(await fixture.browser.evaluate(() => scrollY)).toBe(0);
    // Frozen support.ts:272 uses half the current viewport for momentum:none.
    const distance = Math.round(second.viewport.height / 2);
    // Each independent action advances equally on the same unchanging tall body.
    // There are no nested scrollers or boundary clamping, and no DOM mutation.
    const nativeResult = await record(async () => {
      const count = (await events()).length;
      await fixture.engine.perform!(first.viewportRef!, { kind: 'swipe', direction: 'down' },
        { ...fixture.operation(), timeoutMs: ACTION_TIMEOUT });
      await expect.poll(async () => (await events()).length, { timeout: ACTION_TIMEOUT }).toBe(count + 1);
      await expect.poll(() => fixture.browser.evaluate(() => scrollY), { timeout: ACTION_TIMEOUT }).toBe(distance);
    });
    const sourceResult = await record(async () => {
      const count = (await events()).length;
      const before = await fixture.browser.evaluate(() => scrollY);
      await sourcePage.mouse.wheel(0, distance);
      await expect.poll(async () => (await events()).length, { timeout: ACTION_TIMEOUT }).toBe(count + 1);
      await expect.poll(() => fixture.browser.evaluate(() => scrollY), { timeout: ACTION_TIMEOUT }).toBe(before + distance);
    });
    const finalEvents = await events();
    await close();
    expect(second.viewportRef).toEqual(first.viewportRef);
    expect(second.root.ref.id).not.toBe(first.root.ref.id);
    const prediction = { status: 'returned', events: ['A'], logIntact: true, readbackErrors: [] };
    expect(sourceResult, 'the original Page remains usable across navigation').toMatchObject(prediction);
    expect(nativeResult, 'the original viewport capability preserves that same Page lifetime').toMatchObject(prediction);
    expect(finalEvents).toEqual(['A', 'A']);
  });

  it('observed ElementHandle refuses a detached A instead of clicking replacement B', async () => {
    await nativeDocument(fixture.browser, documentHtml(button('A')));
    const observation = await fixture.session.observe(fixture.operation());
    expect(observation.kind).toBe('semantic');
    if (observation.kind !== 'semantic') throw new Error('This fixture requires a semantic observation');
    const matches = observedNodes(observation.tree).filter(node => node.testId === 'A');
    expect(matches).toHaveLength(1);
    const source = await fixture.actionOracle.locator('.match').elementHandle();
    expect(source).not.toBeNull();
    await fixture.browser.evaluate(html => { document.querySelector('.match')!.outerHTML = html; return null; }, button('B'));
    expect(await fixture.browser.evaluate(() => document.querySelector('.match')?.getAttribute('data-testid') ?? null)).toBe('B');
    await compare(matches[0]!.ref, source!, 'refused', /not attached|detached/i);
  });

  for (const kind of ['displayValue', 'exact-label'] as const) {
    for (const mutation of ['new match', 'predicate change', 'detach'] as const) {
      it(`${kind} pinned handle after ${mutation} ${mutation === 'detach' ? 'refuses without clicking B' : 'still clicks original A'}`, async () => {
        await nativeDocument(fixture.browser, documentHtml(field('A')));
        const retained = await retain(kind === 'displayValue' ? DISPLAY_VALUE : EXACT_LABEL, ['A']);
        expect(retained.cached).toMatchObject({ testId: 'A', name: 'Choice', value: 'chosen' });
        // For this one-input fixture the value reader selects the sole candidate;
        // the plain aria-label has exactly the same candidate as the old reader.
        const source = kind === 'displayValue'
          ? (await fixture.actionOracle.locator('input').elementHandles())[0]
          : await fixture.actionOracle.getByLabel('Choice', { exact: true }).elementHandle();
        expect(source).toBeTruthy();
        expect(await source!.getAttribute('data-testid')).toBe('A');
        await fixture.browser.evaluate(({ html, kind: queryKind, mutation: change }) => {
          const original = document.querySelector<HTMLInputElement>('[data-testid="A"]')!;
          original.insertAdjacentHTML('beforebegin', html);
          if (change === 'detach') original.remove();
          else if (change === 'predicate change') {
            if (queryKind === 'displayValue') original.value = 'changed';
            else original.setAttribute('aria-label', 'Changed');
          }
          return null;
        }, { html: field('B'), kind, mutation });
        expect(await fixture.browser.evaluate(() => Array.from(document.querySelectorAll('input'), node => node.getAttribute('data-testid')))).toEqual(mutation === 'detach' ? ['B'] : ['B', 'A']);
        if (mutation === 'predicate change') {
          expect(await fixture.browser.evaluate(queryKind => {
            const original = document.querySelector<HTMLInputElement>('[data-testid="A"]')!;
            return queryKind === 'displayValue' ? original.value : original.getAttribute('aria-label');
          }, kind)).toBe(kind === 'displayValue' ? 'changed' : 'Changed');
        }
        await compare(retained, source!, mutation === 'detach' ? 'refused' : 'A', /not attached|detached/i);
      });
    }
  }

  it('strict unique query becoming ambiguous refuses without clicking either match', async () => {
    await nativeDocument(fixture.browser, documentHtml(button('A')));
    const retained = await retain(MATCH, ['A']);
    const source = fixture.actionOracle.locator('.match');
    expect(await source.count()).toBe(1);
    await fixture.browser.evaluate(html => { document.body.insertAdjacentHTML('beforeend', html); return null; }, button('B'));
    expect(await fixture.browser.evaluate(() => document.querySelectorAll('.match').length)).toBe(2);
    await compare(retained, source, 'refused', /strict mode violation/i);
  });

  for (const mutation of ['replace A', 'connected A loses class'] as const) {
    it(`strict query after ${mutation} resolves the unique replacement B, not cached A`, async () => {
      await nativeDocument(fixture.browser, documentHtml(button('A')));
      const retained = await retain(MATCH, ['A']);
      const source = fixture.actionOracle.locator('.match');
      expect(await source.count()).toBe(1);
      await fixture.browser.evaluate(({ html, mutation: change }) => {
        const original = document.querySelector('.match')!;
        if (change === 'replace A') original.outerHTML = html;
        else { original.classList.remove('match'); original.insertAdjacentHTML('afterend', html); }
        return null;
      }, { html: button('B'), mutation });
      expect(await fixture.browser.evaluate(() => Array.from(document.querySelectorAll('.match'), node => node.getAttribute('data-testid')))).toEqual(['B']);
      expect(await fixture.browser.evaluate(() => document.querySelector('[data-testid="A"]')?.isConnected ?? false)).toBe(mutation !== 'replace A');
      await compare(retained, source, 'B');
    });
  }

  for (const selection of ['multi-result ref[1]', 'explicit nth(1)'] as const) {
    it(`${selection} keeps logical index 1: prepending X changes the action from cached B to A`, async () => {
      await nativeDocument(fixture.browser, documentHtml(button('A') + button('B')));
      const retained = selection === 'multi-result ref[1]'
        ? await retain(MATCH, ['A', 'B'], 1)
        : await retain({ kind: 'index', source: MATCH, index: 1 }, ['B']);
      const source = fixture.actionOracle.locator('.match').nth(1);
      expect(await source.getAttribute('data-testid')).toBe('B');
      await fixture.browser.evaluate(html => { document.body.insertAdjacentHTML('afterbegin', html); return null; }, button('X'));
      expect(await fixture.browser.evaluate(() => Array.from(document.querySelectorAll('.match'), node => node.getAttribute('data-testid')))).toEqual(['X', 'A', 'B']);
      await compare(retained, source, 'A');
    });
  }

  /** Wait for the nested document's actual target, not merely an iframe element. */
  async function readyFrames(ids: string[]): Promise<void> {
    await expect.poll(() => fixture.browser.evaluate(() => Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[name="outer"]'), outer =>
      outer.contentDocument?.querySelector<HTMLIFrameElement>('iframe[name="inner"]')?.contentDocument?.querySelector('.match')?.getAttribute('data-testid') ?? null,
    )), { timeout: 5_000 }).toEqual(ids);
  }

  it('nested FrameLocator re-resolves same-document child replacement B', async () => {
    await nativeDocument(fixture.browser, documentHtml(frame('outer', frame('inner', button('A')))));
    await readyFrames(['A']);
    const retained = await retain(FRAME_MATCH, ['A']);
    const source = fixture.actionOracle.frameLocator('iframe[name="outer"]').frameLocator('iframe[name="inner"]').locator('.match');
    expect(await source.getAttribute('data-testid')).toBe('A');
    await fixture.browser.evaluate(html => {
      const child = document.querySelector<HTMLIFrameElement>('iframe[name="outer"]')!.contentDocument!
        .querySelector<HTMLIFrameElement>('iframe[name="inner"]')!.contentDocument!;
      child.querySelector('.match')!.outerHTML = html;
      return null;
    }, button('B'));
    await readyFrames(['B']);
    await compare(retained, source, 'B');
  });

  it('same-name sibling iframe makes the retained ancestor FrameLocator ambiguous and refuses all clicks', async () => {
    await nativeDocument(fixture.browser, documentHtml(frame('outer', frame('inner', button('A')))));
    await readyFrames(['A']);
    const retained = await retain(FRAME_MATCH, ['A']);
    const source = fixture.actionOracle.frameLocator('iframe[name="outer"]').frameLocator('iframe[name="inner"]').locator('.match');
    expect(await source.getAttribute('data-testid')).toBe('A');
    await fixture.browser.evaluate(html => { document.body.insertAdjacentHTML('beforeend', html); return null; }, frame('outer', frame('inner', button('B'))));
    await readyFrames(['A', 'B']);
    await compare(retained, source, 'refused', /strict mode violation/i);
  });
});
