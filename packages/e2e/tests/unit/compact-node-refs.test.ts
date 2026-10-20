import { describe, expect, it } from 'vitest';
import { NodeRefs } from '../../src/agent/node-refs.ts';
import { prepareObservation } from '../../src/agent/observation.ts';
import type { NodeRef, SemanticNode } from '../../src/engine/index.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';
import type { E2EConfig } from '../../src/types.ts';
import { runAgentStepsOnFakeTime } from '../helpers/agent-fake-time.ts';
import { snapshot } from '../helpers/snapshot.ts';

runAgentStepsOnFakeTime();

import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';
/** A real fixture graph with an in-memory engine and no runner process or model provider. */
function runtime(nodes: readonly SemanticNode[], performed: NodeRef[], overrides: Partial<E2EConfig> = {}) {
  const engine = defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => snapshot(nodes), actions: ['tap'], perform: async (ref) => { performed.push(ref); } });
  const config = resolveConfig(
    { targets: [{ name: 'fake', platform: 'custom', engine }], cache: 'off', ...overrides },
    { projectRoot: process.cwd(), env: {} },
  );
  const signal = new AbortController().signal;
  const steps = new StepRecorder('attempt');
  const { fixtures } = createFixtures({
    config,
    target: config.targets[0]!,
    session: createEngineSession({ engine, targetName: 'fake' }),
    steps,
    budget: new AttemptBudget(signal, new Deadline(10_000)),
    runId: 'run',
    attemptId: 'attempt',
    attempt: { testId: 'test', attemptId: 'attempt', index: 0, signal, memory: new Map() },
    artifacts: { dir: '/tmp', register: () => 'artifact', link: () => 'artifact' },
    priorSteps: () => steps.completed(),
    agentContext: undefined,
    saveSession: undefined,
    models: new WorkerModels(() => {}),
  });
  return { fixtures, steps };
}


const opaque = (index: number) => `agent-browser:00000000-0000-4000-8000-000000000000:1:e${index}`;
const dense: SemanticNode[] = Array.from({ length: 707 }, (_, index) => ({
  ref: { id: opaque(index), revision: '' },
  role: 'button', name: index === 702 ? '+' : index === 705 ? 'Confirm' : index === 706 ? 'Cancel' : `Row ${index} action details`,
}));

describe('compact model node references', () => {
  it('fits all 707 nodes including the late controls without raising the byte budget', () => {
    const tree = snapshot(dense).root;
    const raw = { kind: 'semantic' as const, tree, root: tree.ref, capturedAt: '', truncated: false, redaction: { secureNodeCount: 0, maskedRegionCount: 0 }, revision: '1', viewport: { width: 1280, height: 720 } };
    const options = { redact: (s: string) => s, redactCut: (s: string) => s, maxBytes: 59_816 };
    const before = prepareObservation(raw, options);
    const after = prepareObservation(raw, { ...options, nodeId: new NodeRefs().encode });
    expect(before.kind === 'semantic' && before.truncated).toBe(true);
    expect(before.text).not.toContain('"+"');
    expect(after.kind === 'semantic' && after.truncated).toBe(false);
    expect(after.text).toContain('"+"');
    expect(after.text).toContain('"Confirm"');
    expect(after.text).toContain('"Cancel"');
    expect(after.bytes).toBeLessThan(59_816);
    expect(after.kind === 'semantic' && after.nodes.has(opaque(702))).toBe(true);
  });

  it('sends short refs in the actual SDK request and decodes the response to the original opaque ref', async () => {
    const performed: NodeRef[] = [];
    const model = installFakeLoopModel(({ turn, prompt }) => {
      if (turn > 1) return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'done' } }];
      expect(prompt).not.toContain('00000000-0000');
      const target = prompt.match(/#(n[0-9a-z]+) button "\+"/u)?.[1];
      expect(target).toBeDefined();
      expect(prompt).toContain('"Confirm"');
      return [{ toolName: 'tap', input: { target } }];
    });
    const { fixtures } = runtime(dense, performed, { agents: { default: { model, maxObservationBytes: 59_816 } } });
    await fixtures.agent.act('tap the plus');
    expect(performed.map((ref) => ref.id)).toEqual([opaque(702)]);
    expect(loopCalls.length).toBe(2);
  });

  it('never reuses an alias after eviction and rejects raw or unknown references', () => {
    const refs = new NodeRefs();
    const first = refs.encode(opaque(1));
    refs.expose(first);
    expect(refs.decode({ id: `#${first}` }).id).toBe(opaque(1));
    refs.retain(new Set());
    expect(() => refs.decode({ id: first })).toThrow(/expired/);
    expect(refs.encode(opaque(1))).not.toBe(first);
    expect(() => refs.decode({ id: opaque(1) })).toThrow();
    expect(() => refs.decode({ id: 'e1' })).toThrow();
  });

  it('isolates immutable request scopes when later captures allocate references', async () => {
    const refs = new NodeRefs();
    const first = refs.encode('first');
    refs.expose(first);
    const request = refs.scope();
    const later = refs.encode('later');
    refs.expose(later);
    await refs.run(request, async () => {
      expect(refs.decode({ id: first }).id).toBe('first');
      await Promise.resolve();
      expect(() => refs.decode({ id: later })).toThrow();
    });
    expect(refs.decode({ id: later }).id).toBe('later');
  });
});
