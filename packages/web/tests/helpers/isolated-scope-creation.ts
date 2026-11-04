import { expect } from 'vitest';

const commands = ['scope.open', 'scope.interop.prepare', 'scope.interop.adopt', 'scope.configure'] as const;
type Command = typeof commands[number];
interface Call { command: Command; args: Record<string, unknown>; result?: Record<string, unknown> }
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}
function text(value: unknown): asserts value is string {
  expect(typeof value).toBe('string'); expect(value).not.toBe('');
}

/** Passive test-only receipts from the real decoding channel; never substitutes a startup result. */
export class IsolatedScopeCreation {
  private readonly calls: Call[] = [];
  private readonly events: string[] = [];

  observe<T>(name: string, args: unknown, pending: Promise<T>): Promise<T> {
    const command = commands.find(candidate => candidate === name);
    if (command === undefined) return pending;
    const call: Call = { command, args: {} };
    for (const key of ['preparationId', 'contextId', 'targetId', 'identityScope', 'context']) call.args[key] = field(args, key);
    const viewport = field(args, 'viewport');
    call.args['viewport'] = viewport !== null && typeof viewport === 'object'
      ? { width: field(viewport, 'width'), height: field(viewport, 'height') } : viewport;
    this.calls.push(call); this.events.push(`${command}:dispatch`);
    void pending.then(result => {
      call.result = { preparationId: field(result, 'preparationId'), identityScope: field(result, 'identityScope') };
      this.events.push(`${command}:fulfilled`);
    }, () => { this.events.push(`${command}:rejected`); });
    return pending; // Preserve the production Promise and original rejection identity.
  }

  assertOne(options: { viewport?: unknown; identityScope?: unknown } = {}): void {
    expect(this.events).toEqual([
      'scope.interop.prepare:dispatch', 'scope.interop.prepare:fulfilled',
      'scope.interop.adopt:dispatch', 'scope.interop.adopt:fulfilled',
      'scope.configure:dispatch', 'scope.configure:fulfilled',
    ]);
    expect(this.calls.map(call => call.command)).toEqual(['scope.interop.prepare', 'scope.interop.adopt', 'scope.configure']);
    const [prepare, adopt, configure] = this.calls;
    expect(prepare!.args['context']).toBe('isolated');
    const preparationId = prepare!.args['preparationId']; text(preparationId);
    expect(prepare!.result!['preparationId']).toBe(preparationId);
    expect(adopt!.args['preparationId']).toBe(preparationId);
    text(adopt!.args['contextId']); text(adopt!.args['targetId']);
    const scope = adopt!.result!['identityScope']; text(scope);
    expect(configure!.args['identityScope']).toBe(scope);
    if ('viewport' in options) expect(prepare!.args['viewport']).toEqual(options.viewport);
    if ('identityScope' in options) this.assertScope(options.identityScope);
  }

  assertScope(identityScope: unknown): void {
    text(identityScope);
    expect(this.calls.find(call => call.command === 'scope.interop.adopt')?.result?.['identityScope']).toBe(identityScope);
    expect(this.calls.find(call => call.command === 'scope.configure')?.args['identityScope']).toBe(identityScope);
  }
}
