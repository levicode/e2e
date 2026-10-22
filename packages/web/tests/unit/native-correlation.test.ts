import { describe, expect, it } from 'vitest';
import type { OperationContext, SemanticNode } from 'e2e/engine';
import type { BrowserCommandMap, NativeWebSurface } from '../../src/native/browser-contract.ts';
import { decodeBrowserResult, snapshotCorrelationArgs } from '../../src/native/browser-decode.ts';
import { correlateObserved, observedNodes } from '../helpers/native-correlation.ts';

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' });

describe('test-only protected observation identity join', () => {
  it('batches refs on the captured facade and returns original protected nodes, never query metadata', async () => {
    const target: SemanticNode = { ref: { id: '@e2', revision: '3' }, role: 'button', name: 'Protected name' };
    const pseudo: SemanticNode = { ref: { id: '@e3', revision: '3' }, role: 'text', name: 'Protected pseudo' };
    const tree: SemanticNode = { ref: { id: '@e1', revision: '3' }, role: 'document', children: [target, pseudo] };
    const observed = observedNodes(tree);
    expect(observed).toEqual([tree, target, pseudo]);
    const request = operation();
    const commands: unknown[] = [];
    const surface = {
      command(name: string, args: unknown, current: OperationContext) {
        expect(this).toBe(surface);
        expect(name).toBe('fixture.correlate');
        expect(current).toBe(request);
        commands.push(args);
        return Promise.resolve({ identityScope: 'scope-1', matches: [target.ref, null, target.ref] });
      },
    } as unknown as NativeWebSurface;
    const locateMetadata = [
      { ref: { id: '@e10', revision: '2' }, role: 'wrong role', name: 'Unprotected query name' },
      { ref: { id: '@e11', revision: '2' }, name: pseudo.name },
      { ref: { id: '@e12', revision: '2' }, name: 'Same acquired node' },
    ];
    const result = await correlateObserved(surface, operation)(locateMetadata.map(node => node.ref), observed, request);
    expect(commands).toEqual([{ located: locateMetadata.map(node => node.ref), observed: observed.map(node => node.ref) }]);
    expect(result).toEqual([target, null, target]);
    expect(result[0]).toBe(target);
    expect(result[2]).toBe(target);
    expect(result[0]?.name).toBe('Protected name');
  });

  it('cannot decode correlation as a context-free successful response', () => {
    expect(() => decodeBrowserResult('fixture.correlate', { identityScope: 'scope-1', matches: [] })).toThrow();
  });

  it('accepts the exact combined candidate bound and u64 endpoints without number conversion', () => {
    const located = Array.from({ length: 50_000 }, (_, index) => ({ id: `@e${index + 1}`, revision: '1' }));
    const observed = Array.from({ length: 50_000 }, (_, index) => ({ id: `@e${index + 50_001}`, revision: '18446744073709551615' }));
    observed[0] = { id: '@e18446744073709551615', revision: '18446744073709551615' };
    const result = snapshotCorrelationArgs({ located, observed });
    expect(result.located).toHaveLength(50_000);
    expect(result.observed).toHaveLength(50_000);
    expect(result.observed[0]).toEqual(observed[0]);
    expect(result.observed[0]).not.toBe(observed[0]);
  });

  it('does not expand a bounded request with sparse candidate arrays', () => {
    expect(() => snapshotCorrelationArgs({ located: new Array(1), observed: [] })).toThrow();
  });

  it('does not manufacture a protected semantic node from an absent matched ref', async () => {
    const surface = {
      command: () => Promise.resolve({ identityScope: 'scope-1', matches: [{ id: '@e99', revision: '1' }] } satisfies BrowserCommandMap['fixture.correlate']['result']),
    } as unknown as NativeWebSurface;
    await expect(correlateObserved(surface, operation)([{ id: '@e1', revision: '1' }], [])).rejects.toThrow('absent from the protected observation');
  });
});
