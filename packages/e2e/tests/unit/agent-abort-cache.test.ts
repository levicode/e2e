/** The real dispatch/caching boundary must distinguish runtime cancellation from executor prose. */
import assert from 'node:assert/strict';
import { it } from 'vitest';
import { dispatchAgentStep, type DispatchAgent } from '../../src/agent/act.ts';
import type { AgentContext } from '../../src/agent/invocation.ts';
import type { StepVerdict } from '../../src/agent/executor.ts';
import type { AgentCacheContext } from '../../src/cache/context.ts';
import { buildTraceEntry } from '../../src/cache/trace.ts';
import { EngineError } from '../../src/engine/index.ts';
import type { Observation, OperationContext, SemanticNode } from '../../src/engine/surface.ts';
import { Deadline } from '../../src/internal/time.ts';
import { StepRecorder } from '../../src/run/steps.ts';

interface ReplayScreen {
  nodes(): readonly SemanticNode[];
  tap(): Promise<void>;
  maxBytes: number;
}

/** Runs the dispatcher and trace cache against a stored step and its current screen. */
function harness(execute: (controller: AbortController) => Promise<StepVerdict>, timeout = 5_000, replay?: ReplayScreen) {
  const controller = new AbortController();
  const steps = new StepRecorder('attempt');
  const counts = { deleted: 0, written: 0, called: 0 };
  const entry = replay ? buildTraceEntry({
    actions: [{ name: 'tap', summary: 'tap Submit', target: { role: 'button', name: 'Submit' } }],
    startPath: '/code', endPath: '/code', endAnchors: [{ role: 'status', name: 'Receipt' }],
    executor: { name: 'test' }, summary: 'submitted',
  }) : buildTraceEntry({
    actions: [{ name: 'tool', summary: 'runtime-derived value', derived: 'whole-node' }],
    startPath: '/code', executor: { name: 'test' }, summary: 'copied output',
  });
  const cache: AgentCacheContext = {
    mode: replay ? 'read-only' : 'read-write', replayEligible: true, strict: replay ? { advice: 'check the screen' } : false, staged: [],
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
  const context = {
    steps, cache, config: { timeout, actionTimeout: 1_000, limits: { maxLedgerBytes: 4096 } },
    target: { name: 'web', platform: 'web', verbs: new Set(replay ? ['tap'] : []) },
    attempt: { testId: 'test', titlePath: ['test'], attemptId: 'attempt', index: 0, signal: controller.signal, memory: new Map() },
    priorSteps: () => [], redact: (text: string) => text, redactCut: (text: string) => text,
    app: { base: new URL('http://fixture.invalid') }, exposure: { withholdsModelPixels: false },
    engine: {
      signal: controller.signal, deadline: (ms: number) => new Deadline(ms),
      operation: (ms: number): OperationContext => ({ signal: controller.signal, timeoutMs: ms, runId: 'run', attemptId: 'attempt', origin: 'agent' }),
      session: {
        observe: async () => replay ? { ...observation, tree: { ...observation.tree, children: replay.nodes() } } : observation,
        perform: replay?.tap,
      },
    },
  } as unknown as AgentContext;
  const agent = {
    name: 'default', agentContext: undefined,
    config: { maxSteps: 25, maxModelCalls: 1, maxObservationBytes: replay?.maxBytes ?? 65536, maxInputTokens: 128000 },
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

/** The receipt either appears during relocation or as the real effect of the click. */
function replaySubmit(staleFirst: boolean, maxBytes: number) {
  let taps = 0;
  const filler = Array.from({ length: 80 }, (_, index) => ({
    ref: { id: 'item-' + index, revision: 'r1' }, role: 'button', name: 'Item ' + index,
  }));
  const h = harness(async () => { throw new Error('strict replay invoked the executor'); }, 5_000, {
    maxBytes,
    nodes: () => [
      ...filler,
      { ref: { id: taps ? 'submit-new' : 'submit', revision: 'r1' }, role: 'button', name: 'Submit' },
      ...(taps ? [{ ref: { id: 'receipt', revision: 'r1' }, role: 'status', name: 'Receipt' }] : []),
    ],
    tap: async () => {
      taps++;
      if (staleFirst && taps === 1) throw new EngineError('NODE_STALE', 'remounted', { retryable: true });
    },
  });
  return { ...h, taps: () => taps };
}

it('does not claim a receipt that appeared before dispatch to the relocated target', async () => {
  const replay = replaySubmit(true, 65536);
  await assert.rejects(replay.run(), { code: 'REPLAY_STALE' });
  assert.equal(replay.steps.all()[0]?.cache?.reason, 'end-mismatch');
  assert.equal(replay.taps(), 2);
});

it('checks the full semantic tree when only the model-facing text was shortened', async () => {
  const replay = replaySubmit(false, 1024);
  await replay.run();
  assert.equal(replay.steps.all()[0]?.cache?.mode, 'self-finalized');
  assert.equal(replay.taps(), 1);
});
