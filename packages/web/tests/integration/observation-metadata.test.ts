import { expect, it, TestRunner } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { nativeDocument } from '../helpers/native-browser.ts';
import { startNativeFixture } from '../helpers/native-fixture.ts';

function descendants(node: SemanticNode): SemanticNode[] {
  return [node, ...(node.children ?? []).flatMap(descendants)];
}

type StringifyPhase = 'startup' | 'document' | 'override' | 'observe' | 'assert-metadata' | 'perform' | 'assert-clicked' | 'close';
type StringifyFailure = 'native-refusal:cleanup-failed' | 'ENGINE_FAILURE' | 'CANCELLED' | 'OPERATION_TIMEOUT' | 'INVALID_STATE' | 'UNSUPPORTED_CAPABILITY' | 'assertion' | 'other';
interface StringifySlot { phase: StringifyPhase; state: 'not-started' | 'running' | 'passed' | 'failed'; failure: StringifyFailure | null }

/** Two fixed test-local slots only. Never serialize an error, message, stack, or page value. */
function stringifyFailure(cause: unknown): StringifyFailure {
  try {
    if (cause instanceof Error && cause.message === 'The native browser protocol became invalid (native-refusal:cleanup-failed)') return 'native-refusal:cleanup-failed';
    if (typeof cause === 'object' && cause !== null && 'code' in cause) {
      const code = cause.code;
      switch (code) {
        case 'ENGINE_FAILURE': case 'CANCELLED': case 'OPERATION_TIMEOUT': case 'INVALID_STATE': case 'UNSUPPORTED_CAPABILITY': return code;
      }
    }
    if (cause instanceof Error && cause.name === 'AssertionError') return 'assertion';
  } catch { /* Diagnostic access cannot replace the original thrown value. */ }
  return 'other';
}

it.each(['stringify', 'bound-stringify', 'object-toJSON', 'array-toJSON', 'function-toString'] as const)('captures live refs when the page overrides %s', async (override) => {
  const evidence: { schemaVersion: 1; body: StringifySlot; cleanup: StringifySlot } | undefined = override === 'stringify' ? {
    schemaVersion: 1,
    body: { phase: 'startup', state: 'running', failure: null },
    cleanup: { phase: 'close', state: 'not-started', failure: null },
  } : undefined;
  if (evidence) {
    // it.each supplies only its row, not TestContext; capture the current task before any await.
    try {
      const task = TestRunner.getCurrentTest();
      if (task) Object.assign(task.meta, { nativeStringifyFailure: evidence });
    } catch { /* Missing metadata is unknown, never permission to change the test outcome. */ }
  }
  const phase = (next: StringifyPhase): void => { if (evidence) evidence.body.phase = next; };
  const failed = (slot: 'body' | 'cleanup', cause: unknown): void => {
    if (evidence) { evidence[slot].state = 'failed'; evidence[slot].failure = stringifyFailure(cause); }
  };
  let fixture: Awaited<ReturnType<typeof startNativeFixture>>;
  try { fixture = await startNativeFixture(`observation-metadata-${override}`); }
  catch (cause) { failed('body', cause); throw cause; }
  try {
    phase('document');
    await nativeDocument(fixture.browser, `<button onclick="this.textContent = 'Clicked'">Preserved "quoted" name</button>
      <input type="password" aria-label="Password" value="withheld-secret">`);
    phase('override');
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
    phase('observe');
    const captured = await fixture.engine.observe!({ ...fixture.operation(), origin: 'agent' });

    // The former reader's three total nodes were implementation metadata, not a
    // public shape contract: native AX may retain additional static-text nodes.
    // Preserve both controls, exact labels/privacy, non-truncation, and live identity.
    phase('assert-metadata');
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
    phase('perform');
    await fixture.engine.perform!(button!.ref, { kind: 'tap' }, fixture.operation());
    phase('assert-clicked');
    expect(await fixture.browser.evaluate(() => document.querySelector('button')!.textContent)).toBe('Clicked');
    if (evidence) evidence.body.state = 'passed';
  } catch (cause) { failed('body', cause); throw cause; }
  finally {
    if (evidence) evidence.cleanup.state = 'running';
    try {
      await fixture.close();
      if (evidence) evidence.cleanup.state = 'passed';
    } catch (cause) { failed('cleanup', cause); throw cause; }
  }
});
