/** Focused typing validates the actual control inside open and closed shadow roots. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startNativeFixture, type NativeFixture } from '../helpers/native-fixture.ts';
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
  failed(section: keyof SyntheticOutcome = this.section, cause?: unknown): void {
    if (cause !== undefined) this.observer.failure(section, cause);
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

let fixture: NativeFixture | undefined;
const operation = () => ({ ...fixture!.operation(), timeoutMs: 5_000 });

const fixtureClients = new Set<NativeClient>();
let restoreFixtureConnection = () => {};
let restoreIframeConnection = () => {};
let iframeEvidence: CaseEvidence | undefined;
const iframeTasks = new WeakMap<object, CaseEvidence>();

beforeAll(async () => {
  const restore = restoreFixtureConnection = watchConnections(undefined, fixtureClients);
  try { fixture = await startNativeFixture('keyboard-shadow'); }
  finally { restore(); }
});
beforeEach((context) => {
  const evidence = context.task.name === 'does not mistake the iframe host for an editable control when its button has focus'
    ? new CaseEvidence('P23') : undefined;
  if (evidence !== undefined) {
    iframeEvidence = evidence;
    iframeTasks.set(context.task, evidence);
    restoreIframeConnection = watchConnections(evidence, fixtureClients);
    for (const client of fixtureClients) evidence.observer.attach(client);
  }
  const open = async () => {
    try {
      evidence?.phase('setup', 'navigate');
      await fixture!.browser.goto('about:blank');
      evidence?.passed('setup');
    } catch (cause) { evidence?.failed('setup', cause); throw cause; }
  };
  return evidence === undefined ? open() : evidence.observer.run(open);
});
afterEach((context) => {
  // Pause the shared client between rows; only the original afterAll reattaches for cleanup.
  const evidence = iframeTasks.get(context.task);
  if (evidence !== undefined) { restoreIframeConnection(); evidence.observer.detach(); }
});
afterAll(async () => {
  try {
    if (iframeEvidence) for (const client of fixtureClients) iframeEvidence.observer.attach(client);
    iframeEvidence?.phase('cleanup', 'dispose');
    await fixture?.close();
    iframeEvidence?.passed('cleanup');
  } catch (cause) { iframeEvidence?.failed('cleanup', cause); throw cause; }
  finally { restoreFixtureConnection(); restoreIframeConnection(); iframeEvidence?.finish(); }
});
// Shared beforeAll failure has no P23 body record. Its original hook failure is authoritative.
// Shared fixture close is observed only when afterAll explicitly reattaches these exact clients.

/** Create nested real shadow roots and record only events delivered to their focused leaf. */
async function focusShadow(shadowMode: ShadowRootMode, markup: string): Promise<void> {
  await fixture!.browser.evaluate(({ mode, html }) => {
    document.body.innerHTML = '<div id="outer"></div>';
    const outer = document.getElementById('outer')!.attachShadow({ mode });
    outer.innerHTML = '<div id="inner"></div>';
    const inner = outer.getElementById('inner')!.attachShadow({ mode });
    inner.innerHTML = html;
    const field = inner.querySelector<HTMLElement>('input,button,[tabindex]')!;
    field.focus();
    field.addEventListener('keydown', () => { document.body.dataset.keys = String(Number(document.body.dataset.keys ?? 0) + 1); });
    field.addEventListener('input', () => { document.body.dataset.value = (field as HTMLInputElement).value; });
    return null;
  }, { mode: shadowMode, html: markup });
}

describe.each(['open', 'closed'] as const)('%s shadow focus', (mode) => {
  it.each(['<button>Stop</button>', '<input readonly value="kept">'])('refuses a noneditable focused leaf: %s', async (html) => {
    await focusShadow(mode, html);
    await expect(fixture!.engine.keyboard!.type('lost', { replace: true }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(await fixture!.browser.evaluate(() => document.body.getAttribute('data-keys'))).toBeNull();
    expect(await fixture!.browser.evaluate(() => document.body.getAttribute('data-value'))).toBeNull();
  });

  it('types into a nested editable leaf', async () => {
    await focusShadow(mode, '<input value="before">');
    await fixture!.engine.keyboard!.type('after', { replace: true }, operation());
    expect(await fixture!.browser.evaluate(() => document.body.getAttribute('data-value'))).toBe('after');
  });

  it('retains focused custom widgets that opt into keystrokes', async () => {
    await focusShadow(mode, '<div tabindex="0">Custom widget</div>');
    await fixture!.engine.keyboard!.type('a', { replace: false }, operation());
    expect(await fixture!.browser.evaluate(() => document.body.getAttribute('data-keys'))).toBe('1');
  });
});

it('does not mistake the iframe host for an editable control when its button has focus', (context) => {
  const evidence = iframeTasks.get(context.task);
  const check = async () => {
    try {
      evidence?.phase('body', 'document');
      await fixture!.browser.evaluate(async () => {
        const frame = document.createElement('iframe');
        const loaded = new Promise<void>((resolve) => { frame.addEventListener('load', () => resolve(), { once: true }); });
        frame.srcdoc = '<button id="stop">Stop</button>';
        document.body.append(frame);
        await loaded;
        frame.contentDocument!.getElementById('stop')!.focus();
        return null;
      });
      evidence?.phase('body', 'perform');
      const type = () => fixture!.engine.keyboard!.type('lost', { replace: false }, operation());
      const pending = evidence ? evidence.observer.select(0, 'browser.keyboard.type', type) : type();
      const assertion = () => expect(pending).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
      await (evidence ? evidence.observer.assert(0, assertion) : assertion());
      evidence?.passed('body');
    } catch (cause) { evidence?.failed('body', cause); throw cause; }
  };
  return evidence === undefined ? check() : evidence.observer.run(check);
});
