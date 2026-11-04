/** The real dispatch/caching boundary must distinguish runtime cancellation from executor prose. */
import assert from 'node:assert/strict';
import { it } from 'vitest';
import { dispatchAgentStep, type DispatchAgent } from '../../src/agent/act.ts';
import type { AgentContext } from '../../src/agent/invocation.ts';
import type { StepVerdict } from '../../src/agent/executor.ts';
import type { AgentCacheContext } from '../../src/cache/context.ts';
import { buildTraceEntry } from '../../src/cache/trace.ts';
import type { Observation, OperationContext } from '../../src/engine/surface.ts';
import { Deadline } from '../../src/internal/time.ts';
import { StepRecorder } from '../../src/run/steps.ts';

function harness(execute: (controller: AbortController) => Promise<StepVerdict>, timeout = 5_000) {
  const controller = new AbortController();
  const steps = new StepRecorder('attempt');
  const counts = { deleted: 0, written: 0, called: 0 };
  const entry = buildTraceEntry({
    actions: [{ name: 'tool', summary: 'runtime-derived value', derived: 'whole-node' }],
    startPath: '/code', executor: { name: 'test' }, summary: 'copied output',
  });
  const cache: AgentCacheContext = {
    mode: 'read-write', replayEligible: true, strict: false, staged: [],
    claimKey: () => ({
      keyHash: 'a'.repeat(64),
      context: { cacheSchema: 'trace-1', policyVersion: 'conservative/6', project: 'b'.repeat(64), platform: 'web', engineName: 'web', engineSpiVersion: 1, appIdentity: 'd'.repeat(64), agentContextDigest: 'c'.repeat(64) },
      step: { testId: 'test', targetId: 'web', instructionDigest: 'd'.repeat(64), paramsDigest: 'b'.repeat(64), callIndex: 0, agent: 'default' },
    }),
    store: {
      writable: true, read: async () => ({ status: 'hit', entry, bytes: Buffer.byteLength(JSON.stringify(entry)) }),
      write: async () => { counts.written += 1; return undefined; },
      delete: async () => { counts.deleted += 1; },
    },
  };
  const ref = { id: 'root', revision: 'r1' };
  const observation: Observation = {
    kind: 'semantic', root: ref, tree: { ref, role: 'document' }, truncated: false,
    revision: 'r1', capturedAt: new Date().toISOString(), viewport: { width: 1280, height: 720 },
    location: 'http://fixture.invalid/code', redaction: { secureNodeCount: 0, maskedRegionCount: 0 },
  };
  // Only the services reached by a semantic gap followed by a pending executor.
  const context = {
    steps, cache, config: { timeout, actionTimeout: 1_000, limits: { maxLedgerBytes: 4096 } },
    target: { name: 'web', platform: 'web', verbs: new Set() },
    attempt: { testId: 'test', titlePath: ['test'], attemptId: 'attempt', index: 0, signal: controller.signal, memory: new Map() },
    priorSteps: () => [], redact: (text: string) => text, redactCut: (text: string) => text,
    app: { base: new URL('http://fixture.invalid') }, exposure: { withholdsModelPixels: false },
    engine: {
      signal: controller.signal, deadline: (ms: number) => new Deadline(ms),
      operation: (ms: number): OperationContext => ({ signal: controller.signal, timeoutMs: ms, runId: 'run', attemptId: 'attempt', origin: 'agent' }),
      session: { observe: async () => observation },
    },
  } as unknown as AgentContext;
  const agent = {
    name: 'default', agentContext: undefined,
    config: { maxSteps: 25, maxModelCalls: 1, maxObservationBytes: 65536, maxInputTokens: 128000 },
    executor: { name: 'test', async runStep() { counts.called += 1; return execute(controller); } },
  } as unknown as DispatchAgent;
  const run = () => dispatchAgentStep(context, {
    api: 'agent.act', kind: 'act', instruction: 'copy code', params: undefined, secrets: new Map(), templates: [],
    defaultFailureCode: 'ACTION_FAILED', timeout: undefined, maxSteps: undefined, maxModelCalls: undefined, agent: undefined,
  }, agent);
  return { run, controller, counts, steps, cache };
}

for (const [name, reason] of [
  ['default DOMException', undefined], ['custom Error', new Error('stop')], ['non-error reason', 'stop'],
] as const) {
  it(`keeps the consumed gap entry on runtime cancellation with ${name}`, async () => {
    const h = harness(async (controller) => {
      controller.abort(reason);
      return new Promise<never>(() => undefined);
    });
    await assert.rejects(h.run(), { code: 'CANCELLED' });
    assert.deepEqual(h.counts, { called: 1, deleted: 0, written: 0 });
    assert.equal(h.steps.all()[0]?.cache?.reason, 'gap');
    assert.equal(h.steps.all()[0]?.metrics?.modelCalls, 0);
    assert.deepEqual(h.cache.staged, []);
  });
}

it('rejects an already-aborted attempt without invoking the executor or deleting its entry', async () => {
  const h = harness(async () => new Promise<never>(() => undefined));
  h.controller.abort();
  await assert.rejects(h.run(), { code: 'CANCELLED' });
  assert.deepEqual(h.counts, { called: 0, deleted: 0, written: 0 });
});

it('does not trust an executor-thrown AbortError without runtime cancellation', async () => {
  const h = harness(async () => { throw new DOMException('executor says aborted', 'AbortError'); });
  await assert.rejects(h.run(), { code: 'ACTION_FAILED' });
  assert.equal(h.controller.signal.aborted, false);
  assert.deepEqual(h.counts, { called: 1, deleted: 1, written: 0 });
});

it('keeps a genuine executor failure as a failure and evicts the consumed entry', async () => {
  const h = harness(async () => { throw new Error('the copied value was rejected'); });
  await assert.rejects(h.run(), { code: 'ACTION_FAILED' });
  assert.deepEqual(h.counts, { called: 1, deleted: 1, written: 0 });
});

it('preserves the step deadline classification rather than treating its abort as cancellation', async () => {
  const h = harness(async () => new Promise<never>(() => undefined), 1_000);
  await assert.rejects(h.run(), { code: 'STEP_TIMEOUT' });
  assert.equal(h.controller.signal.aborted, false);
  assert.deepEqual(h.counts, { called: 1, deleted: 1, written: 0 });
});
