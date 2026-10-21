/** Model-facing MCP locate cannot reuse an earlier trusted fixture projection. */
import { beforeAll, describe, expect, it } from 'vitest';
import { defineEngine, EngineError, type EngineLocateOptions, type OperationContext } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { LocatorEngine } from '../../src/locator/engine.ts';
import { createSessionCatalog } from '../../src/mcp/catalog.ts';
import { invokeTool } from '../../src/mcp/tools.ts';
import { ScreenPresenter } from '../../src/agent/screen-update.ts';
import { loadAiSdk } from '../../src/agent/ai-sdk.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { Deadline } from '../../src/internal/time.ts';
import { fakeExecutorContext } from '../helpers/fake-executor-context.ts';
import { roleQuery } from '../../src/locator/expression.ts';

beforeAll(() => loadAiSdk());
const signal = new AbortController().signal;
const operation: OperationContext = { signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' };
function fixture(failProtected = false) {
  const purposes: EngineLocateOptions['purpose'][] = [];
  const engine = defineEngine({ name: 'purpose-fixture', version: '1', spiVersion: 1,
    observe: async () => ({ root: { ref: { id: 'document', revision: '' } }, viewport: { width: 10, height: 10 } }),
    locate: async (_expression, _operation, options) => {
      const purpose = options?.purpose ?? 'protected'; purposes.push(purpose);
      if (purpose === 'protected' && failProtected) throw new EngineError('ENGINE_FAILURE', 'Protected read cannot be proven', { retryable: false });
      return [{ ref: { id: 'field', revision: '' }, role: 'textbox', name: 'Custom secret', ...(purpose === 'fixture' ? { value: 'synthetic-unregistered-secret' } : { states: { secure: true } }) }];
    },
  });
  const session = createEngineSession({ engine, targetName: 'fixture' });
  // Deliberately bind a fixture locator: the MCP tool must still force protected.
  const locator = new LocatorEngine({ session, readPurpose: 'fixture', budget: new AttemptBudget(signal, new Deadline(5000)), runId: 'run', attemptId: 'attempt', actionTimeout: 1000, assertionTimeout: 1000 });
  const { context } = fakeExecutorContext();
  const catalog = createSessionCatalog({ context, screen: new ScreenPresenter(), locator, session, tools: {}, redaction: { redact: text => text, redactCut: text => text }, recorder: undefined, warn: () => {} });
  return { session, locator, catalog, purposes };
}

describe('runner-bound locate projections', () => {
  it('defaults direct session queries to protected and accepts an explicit trusted fixture binding', async () => {
    const f = fixture();
    await f.session.locate(roleQuery('textbox', undefined, undefined), operation);
    await f.locator.resolveNow(roleQuery('textbox', undefined, undefined));
    expect(f.purposes).toEqual(['protected', 'fixture']);
  });
  it('MCP refreshes a cached fixture target with protected reads and never exposes its old value', async () => {
    const f = fixture();
    const [old] = await f.locator.resolveNow(roleQuery('textbox', undefined, undefined));
    expect((await f.session.read(old!, operation)).value).toBe('synthetic-unregistered-secret');
    const result = await invokeTool('locate', f.catalog.tools['locate']!, { role: 'textbox' }, { signal });
    expect(JSON.stringify(result)).not.toContain('synthetic-unregistered-secret');
    expect(f.purposes).toEqual(['fixture', 'protected']);
    await expect(f.session.read(old!, operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
  });
  it('a failed protected MCP read never retries the fixture projection', async () => {
    const f = fixture(true);
    await f.locator.resolveNow(roleQuery('textbox', undefined, undefined));
    await expect(invokeTool('locate', f.catalog.tools['locate']!, { role: 'textbox' }, { signal })).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(f.purposes).toEqual(['fixture', 'protected']);
  });
});
