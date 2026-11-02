/** Secure descendants must not grant an author-only landmark a content name. */
import { expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { nativeDocument } from '../helpers/native-browser.ts';
import { startNativeFixture, type NativeFixture } from '../helpers/native-fixture.ts';

const PRIVATE_VALUE = 'synthetic-landmark-private-value';

/** Find a required observed receiver without assuming a native reference grammar. */
function byTestId(root: SemanticNode, id: string): SemanticNode {
  const nodes = [root, ...(root.children ?? []).flatMap(descendants)];
  const found = nodes.filter(node => node.testId === id);
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** Flatten the actual public observation without inventing nodes or names. */
function descendants(node: SemanticNode): SemanticNode[] {
  return [node, ...(node.children ?? []).flatMap(descendants)];
}

/** Exercise the receiver through protected query, retained read, and fixture field reads. */
async function protectedReceiver(fixture: NativeFixture, id: string) {
  const operation = { ...fixture.operation(), origin: 'agent' as const };
  const located = await fixture.engine.locate!({ kind: 'selector', selector: `[data-testid="${id}"]` }, operation);
  expect(located).toHaveLength(1);
  const refs = await fixture.session.locate({ kind: 'selector', selector: `[data-testid="${id}"]` }, operation);
  expect(refs).toHaveLength(1);
  const read = await fixture.session.read(refs[0]!, operation);
  const fields = await fixture.engine.readFields!({ kind: 'selector', selector: `[data-testid="${id}"]` }, ['name', 'text', 'value', 'states'], operation, { purpose: 'fixture' });
  expect(fields).toHaveLength(1);
  expect(JSON.stringify({ located, read, fields })).not.toContain(PRIVATE_VALUE);
  return { located: located[0]!, read, fields: fields[0]! };
}

it.each(['main', 'div role="main"'])('keeps an unnamed %s anonymous with password descendants', async tag => {
  const fixture = await startNativeFixture('secure-main-anonymous');
  try {
    const element = tag.startsWith('div') ? 'div' : 'main';
    await nativeDocument(fixture.browser, `<${tag} data-testid="landmark"><a href="#">Back</a><h1>Login Form</h1><p>Public hint</p><input type="password" value="${PRIVATE_VALUE}"></${element}>`);
    const captured = await fixture.engine.observe!({ ...fixture.operation(), origin: 'agent' }, { pixels: false });
    const observed = byTestId(captured.root, 'landmark');
    const receiver = await protectedReceiver(fixture, 'landmark');
    for (const node of [observed, receiver.located, receiver.read, receiver.fields]) {
      expect.soft(node.name, 'A main without author naming must not acquire descendant text').toBeUndefined();
    }
    expect(JSON.stringify(captured.root)).not.toContain(PRIVATE_VALUE);
    const role = (name: string) => ({ kind: 'query' as const, query: { kind: 'role' as const, value: { kind: 'string' as const, value: 'main', exact: true }, name: { kind: 'string' as const, value: name, exact: true } } });
    expect.soft(await fixture.engine.locate!(role('Back Login Form Public hint'), fixture.operation())).toHaveLength(0);
    expect.soft(await fixture.engine.locate!(role(''), fixture.operation())).toHaveLength(1);
    expect(await fixture.engine.locate!(role(PRIVATE_VALUE), fixture.operation())).toHaveLength(0);
    expect(await fixture.engine.locate!({ kind: 'filter', source: { kind: 'selector', selector: '[data-testid="landmark"]' }, hasText: { kind: 'string', value: PRIVATE_VALUE, exact: false } }, fixture.operation())).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

it.each(['aria-label="Account center"', 'aria-labelledby="landmark-label"'])('preserves safe main author naming from %s', async naming => {
  const fixture = await startNativeFixture('secure-main-author');
  try {
    await nativeDocument(fixture.browser, `<span id="landmark-label">Account center</span><main ${naming} data-testid="landmark"><p>Different descendant content</p><input type="password" value="${PRIVATE_VALUE}"></main>`);
    const captured = await fixture.engine.observe!({ ...fixture.operation(), origin: 'agent' }, { pixels: false });
    const receiver = await protectedReceiver(fixture, 'landmark');
    for (const node of [byTestId(captured.root, 'landmark'), receiver.located, receiver.read, receiver.fields]) expect(node.name).toBe('Account center');
    expect(await fixture.engine.locate!({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'main', exact: true }, name: { kind: 'string', value: 'Account center', exact: true } } }, fixture.operation())).toHaveLength(1);
    expect(JSON.stringify(captured.root)).not.toContain(PRIVATE_VALUE);
  } finally {
    await fixture.close();
  }
});

it.each(['div', 'main'])('preserves a legitimate %s button content name while excluding its password value', async tag => {
  const fixture = await startNativeFixture('secure-button-content');
  try {
    await nativeDocument(fixture.browser, `<${tag} role="button" data-testid="control">Unlock <input type="password" value="${PRIVATE_VALUE}"> now</${tag}>`);
    const captured = await fixture.engine.observe!({ ...fixture.operation(), origin: 'agent' }, { pixels: false });
    const receiver = await protectedReceiver(fixture, 'control');
    for (const node of [byTestId(captured.root, 'control'), receiver.located, receiver.read, receiver.fields]) expect(node.name).toBe('Unlock now');
    expect(await fixture.engine.locate!({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true }, name: { kind: 'string', value: 'Unlock now', exact: true } } }, fixture.operation())).toHaveLength(1);
    expect(await fixture.engine.locate!({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true }, name: { kind: 'string', value: PRIVATE_VALUE, exact: false } } }, fixture.operation())).toHaveLength(0);
    expect(JSON.stringify(captured.root)).not.toContain(PRIVATE_VALUE);
  } finally {
    await fixture.close();
  }
});
