import { describe, expect, it, vi } from 'vitest';
import { NodeRefs } from '../../src/agent/node-refs.ts';
import { ScreenPresenter } from '../../src/agent/screen-update.ts';
import { prepareObservation } from '../../src/agent/observation.ts';
import type { ExecutorActions } from '../../src/agent/executor.ts';
import { AgentError } from '../../src/agent/error.ts';
import type { NodeRef, SemanticNode } from '../../src/engine/index.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { EngineError } from '../../src/engine/contract.ts';
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
function runtime(nodes: readonly SemanticNode[], performed: NodeRef[], overrides: Partial<E2EConfig> = {}, afterPerform?: () => void) {
  const engine = defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => snapshot(nodes), actions: ['tap'], perform: async (ref) => { performed.push(ref); afterPerform?.(); } });
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
const node = (id: string, modelRef?: string | null, scope = 'native-session'): SemanticNode => ({ ref: { id, revision: '', ...(modelRef === undefined ? {} : { modelRef, modelRefScope: scope }) }, role: 'button', name: id });
const tree = (nodes: readonly SemanticNode[]): SemanticNode => ({ ref: { id: 'structural-root', revision: '', modelRef: null, modelRefScope: 'native-session' }, children: nodes });
const dense: SemanticNode[] = Array.from({ length: 706 }, (_, index) => ({
  ...node(opaque(index), `@e${index === 702 ? 221 : index === 221 ? 702 : index}`),
  name: index === 702 ? '+' : index === 704 ? 'Confirm' : index === 705 ? 'Cancel' : `Row ${index} action details`,
}));

/** Registers a whole capture without exposing it to a request until explicitly shown. */
function observe(refs: NodeRefs, ...nodes: SemanticNode[]): void { refs.observe(tree(nodes)); }

describe('native model node references', () => {
  it('preserves current-screen diagnostics without dispatching unissued generic or native refs', async () => {
    const refs = new NodeRefs(); observe(refs, node('known'), node('opaque-known', '@e1'));
    refs.expose('known'); refs.expose('@e1');
    const tap = vi.fn(); const actions = refs.actions({ tap } as unknown as ExecutorActions);
    await expect(actions.tap({ id: 'n9999' })).rejects.toThrow(/^node #n9999 is not on the current screen.*re-observe/);
    await expect(actions.tap({ id: '@e9999' })).rejects.toThrow(/^node @e9999 is not on the current screen.*not issued for this request/);
    expect(tap).not.toHaveBeenCalled();
  });

  it('preserves screenshot-only guidance and never dispatches previous node ids after semantic loss', async () => {
    const refs = new NodeRefs(); observe(refs, node('save')); refs.expose('save');
    const request = refs.scope(); refs.invalidate();
    const tap = vi.fn(); const actions = refs.actions({ tap } as unknown as ExecutorActions);
    await expect(actions.tap({ id: 'save' })).rejects.toThrow('previous node ids are no longer valid');
    await refs.run(request, async () => {
      await expect(actions.tap({ id: 'save' })).rejects.toThrow('use the current screenshot');
    });
    observe(refs, node('save')); refs.expose('save');
    await refs.run(request, async () => {
      await expect(actions.tap({ id: 'save' })).rejects.toThrow('expired');
    });
    expect(tap).not.toHaveBeenCalled();
  });

  it('allows current screenshot point and keyboard actions while rejecting expired requests', async () => {
    const refs = new NodeRefs(); observe(refs, node('save')); refs.expose('save');
    const oldRequest = refs.scope(); refs.invalidate();
    const performed: string[] = [];
    const actions = refs.actions({
      tapAt: async () => { refs.assertCurrent(); performed.push('point'); return { summary: 'Tapped point' }; },
      typeText: async () => { refs.assertCurrent(); performed.push('text'); },
    } as unknown as ExecutorActions);
    await actions.tapAt({ x: 10, y: 20 });
    await actions.typeText('hello');
    await refs.run(oldRequest, async () => {
      await expect(actions.tapAt({ x: 10, y: 20 })).rejects.toThrow('expired');
      await expect(actions.typeText('hello')).rejects.toThrow('expired');
    });
    expect(performed).toEqual(['point', 'text']);
  });

  it('fits 707 nodes with the late native @e221 control without raising the byte budget', () => {
    const root = tree(dense);
    const raw = { kind: 'semantic' as const, tree: root, root: root.ref, capturedAt: '', truncated: false, redaction: { secureNodeCount: 0, maskedRegionCount: 0 }, revision: '1', viewport: { width: 1280, height: 720 } };
    const options = { redact: (s: string) => s, redactCut: (s: string) => s, maxBytes: 59_816 };
    const before = prepareObservation(raw, options);
    const refs = new NodeRefs(); refs.observe(root);
    const after = prepareObservation(raw, { ...options, nodeId: refs.encode });
    expect(before.kind === 'semantic' && before.truncated).toBe(true);
    expect(before.text).not.toContain('"+"');
    expect(after.kind === 'semantic' && after.truncated).toBe(false);
    expect(after.text).toContain('@e221 button "+"');
    expect(after.text).toContain('"Confirm"'); expect(after.text).toContain('"Cancel"');
    const defaultBefore = prepareObservation(raw, { ...options, maxBytes: 262_144 });
    const defaultAfter = prepareObservation(raw, { ...options, maxBytes: 262_144, nodeId: refs.encode });
    expect(defaultBefore.bytes).toBe(64_696);
    expect(defaultAfter.bytes).toBe(27_262);
    expect(defaultBefore.kind === 'semantic' && defaultBefore.truncated).toBe(false);
    expect(defaultAfter.kind === 'semantic' && defaultAfter.truncated).toBe(false);
    expect(defaultBefore.text).toContain('"+"');
    expect(defaultAfter.text).toContain('@e221 button "+"');
    expect(before.bytes).toBe(59_751);
    expect(after.bytes).toBe(27_262);
    expect(before.text.split('\n').filter(line => /^\s*#/.test(line))).toHaveLength(652);
    expect(after.kind === 'semantic' && after.nodes.size).toBe(707);
    expect(after.text.split('\n').filter(line => /^\s*@e\d+\b/.test(line))).toHaveLength(706);
    expect(after.bytes).toBeLessThan(59_816);
    expect(after.text).not.toContain('structural-root');
    expect(after.kind === 'semantic' && after.nodes.has(opaque(702))).toBe(true);
  });

  it('sends actual native refs to the SDK and decodes the response to the exact opaque ref', async () => {
    const performed: NodeRef[] = [];
    const model = installFakeLoopModel(({ turn, prompt }) => {
      if (turn > 1) return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'done' } }];
      expect(prompt).not.toContain('00000000-0000');
      expect(prompt).toContain('@e221 button "+"');
      expect(prompt).toContain('"Confirm"');
      return [{ toolName: 'tap', input: { target: '@e221' } }];
    });
    const { fixtures } = runtime([tree(dense)], performed, { agents: { default: { model, maxObservationBytes: 59_816 } } });
    await fixtures.agent.act('tap the plus');
    expect(performed.map((ref) => ref.id)).toEqual([opaque(702)]);
    expect(loopCalls.length).toBe(2);
    expect(loopCalls[1]!.toolResults.join('\n')).not.toContain('#@');
  });

  it('rejects bare native IDs and opaque IDs unless a trusted executor explicitly requested the raw tree', () => {
    const refs = new NodeRefs(); observe(refs, node(opaque(1), '@e1')); refs.expose('@e1');
    expect(refs.decode({ id: '@e1' }).id).toBe(opaque(1));
    for (const id of ['e1', '#@e1', opaque(1), 'n1']) expect(() => refs.decode({ id })).toThrow();
    refs.exposeOpaque(opaque(1));
    expect(refs.decode({ id: opaque(1) }).id).toBe(opaque(1));
  });

  it('freezes request bindings while a native ref keeps its spelling across capture generations', async () => {
    const refs = new NodeRefs(); observe(refs, node('generation-one', '@e1')); refs.expose('@e1');
    const request = refs.scope();
    observe(refs, node('generation-two', '@e1')); refs.expose('@e1');
    refs.retain(new Set(['generation-two']));
    expect(refs.decode({ id: '@e1' }).id).toBe('generation-two');
    await refs.run(request, async () => { await Promise.resolve(); expect(refs.decode({ id: '@e1' }).id).toBe('generation-one'); });
  });

  it('rejects old requests after native instance reset even when @e1 is allocated again', async () => {
    const refs = new NodeRefs(); refs.observe(node('old', '@e1', 'session-one')); refs.expose('@e1');
    const request = refs.scope();
    expect(refs.observe(node('new', '@e1', 'session-two'))).toBe(true); refs.expose('@e1');
    await refs.run(request, async () => { expect(() => refs.decode({ id: '@e1' })).toThrow(/scope changed/); });
    expect(refs.decode({ id: '@e1' }).id).toBe('new');
  });

  it('invalidates pixel-only gaps and rejects duplicate native refs within a capture', async () => {
    const refs = new NodeRefs(); observe(refs, node('old', '@e1')); refs.expose('@e1');
    const request = refs.scope(); refs.invalidate(); observe(refs, node('old', '@e1')); refs.expose('@e1');
    await refs.run(request, async () => { expect(() => refs.decode({ id: '@e1' })).toThrow(/expired/); });
    expect(() => observe(refs, node('one', '@e1'), node('two', '@e1'))).toThrow(/duplicate/);
  });

  it('keeps historical native refs bound while the existing descriptor relocation handles a batch', async () => {
    const nodes: SemanticNode[] = [{ ...node(opaque(1), '@e1'), name: 'First' }, { ...node(opaque(2), '@e2'), name: 'Second' }];
    const performed: NodeRef[] = [];
    const model = installFakeLoopModel(({ turn }) => turn === 1 ? [
      { toolName: 'tap', input: { target: '@e1' } }, { toolName: 'tap', input: { target: '@e2' } },
    ] : [{ toolName: 'complete_step', input: { status: 'passed', summary: 'done' } }]);
    const { fixtures } = runtime(nodes, performed, { agents: { default: { model } } }, () => {
      if (performed.length === 1) nodes[1] = { ...nodes[1]!, ref: { ...nodes[1]!.ref, id: opaque(20) } };
    });
    await fixtures.agent.act('tap both');
    expect(performed.map((ref) => ref.id)).toEqual([opaque(1), opaque(20)]);
  });

  it('rejects a native reference first exposed by an earlier action in the same response', async () => {
    const nodes: SemanticNode[] = [{ ...node(opaque(1), '@e1'), name: 'First' }]; const performed: NodeRef[] = [];
    const model = installFakeLoopModel(({ turn, lastToolResult }) => {
      if (turn === 1) return [{ toolName: 'tap', input: { target: '@e1' } }, { toolName: 'tap', input: { target: '@e2' } }];
      expect(lastToolResult).toContain('not issued for this request');
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'refused the invented reference' } }];
    });
    const { fixtures } = runtime(nodes, performed, { agents: { default: { model } } }, () => { nodes[0] = { ...node(opaque(2), '@e2'), name: 'Later' }; });
    await fixtures.agent.act('tap only a listed node'); expect(performed.map((ref) => ref.id)).toEqual([opaque(1)]);
  });

  it('decodes drag ends and preserves canonical point output without re-encoding its prose', async () => {
    const refs = new NodeRefs(); observe(refs, node('left', '@e1'), node('right', '@e2')); refs.expose('@e1'); refs.expose('@e2');
    const drag = vi.fn(async () => {});
    const actions = refs.actions({ drag, hitTest: async () => ({ point: { x: 1, y: 2 }, control: { id: 'left' }, under: { id: 'right' }, summary: '@e1 button' }) } as unknown as ExecutorActions);
    await actions.drag({ id: '@e1' }, { id: '@e2' }); expect(drag).toHaveBeenCalledWith({ id: 'left' }, { id: 'right' });
    expect(await actions.hitTest({ x: 1, y: 2 })).toEqual({ point: { x: 1, y: 2 }, control: { id: '@e1' }, under: { id: '@e2' }, summary: '@e1 button' });
  });

  it('retains generic engine IDs and the existing raw custom-executor tree contract', async () => {
    const performed: NodeRef[] = [];
    const { fixtures } = runtime([node('field')], performed, { agents: { default: { executor: { name: 'test', async runStep(context) {
      const observed = await context.observe({ tree: true }); expect(observed.tree!.id).toBe('field'); expect(observed.text).toContain('#field');
      await context.actions.tap({ id: observed.tree!.id }); return { status: 'passed', summary: 'done' };
    } } } } });
    await fixtures.agent.act('use the original engine id'); expect(performed[0]!.id).toBe('field');
  });

  it('shows structural-text changes even when no addressable node changed', () => {
    const presenter = new ScreenPresenter(); const base = { revision: '1', truncated: false, viewport: { width: 100, height: 100 }, text: 'root\n @e1 button "Same"\n text "Pending"' };
    presenter.open(base);
    expect(presenter.present({ ...base, revision: '2', text: base.text.replace('Pending', 'Complete') })).toContain('text "Complete"');
    expect(presenter.present({ ...base, revision: '3', text: base.text.replace('Same', 'Changed') })).toContain('@e1 button "Changed"');
  });

  it('does not cascade diagnostic replacements and preserves scoped errors after eviction', async () => {
    const refs = new NodeRefs(); observe(refs, node('n1', '@e1'), node('n2', '@e2')); refs.expose('@e1');
    expect(refs.prose('node #n1, then #n2.')).toBe('node @e1, then @e2.');
    const request = refs.scope(); refs.retain(new Set());
    const actions = refs.actions({ tap: async () => { throw new AgentError('LOCATOR_NOT_FOUND', 'node #n1.'); } } as unknown as ExecutorActions);
    await refs.run(request, async () => { await expect(actions.tap({ id: '@e1' })).rejects.toMatchObject({ message: 'node @e1.', explanation: 'node @e1.' }); });
  });

  it('isolates native reference scopes across concurrent invocations', async () => {
    const left = new NodeRefs(); const right = new NodeRefs(); observe(left, node('left', '@e1')); observe(right, node('right', '@e1')); left.expose('@e1'); right.expose('@e1');
    await Promise.all([
      left.run(left.scope(), async () => { await Promise.resolve(); expect(left.decode({ id: '@e1' }).id).toBe('left'); }),
      right.run(right.scope(), async () => { await Promise.resolve(); expect(right.decode({ id: '@e1' }).id).toBe('right'); }),
    ]);
  });
  it('does not retry a stale action into a new native instance after relocation detects reset', async () => {
    const nodes: SemanticNode[] = [{ ...node('old-opaque', '@e1', 'session-one'), name: 'Same button' }];
    const performed: NodeRef[] = [];
    const model = installFakeLoopModel(({ turn, lastToolResult }) => {
      if (turn === 1) return [{ toolName: 'tap', input: { target: '@e1' } }];
      expect(lastToolResult).toContain('scope changed');
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'reset prevented the retry' } }];
    });
    const { fixtures } = runtime(nodes, performed, { agents: { default: { model } } }, () => {
      if (performed.length !== 1) return;
      nodes[0] = { ...node('new-opaque', '@e1', 'session-two'), name: 'Same button' };
      throw new EngineError('NODE_STALE', 'instance reset', { retryable: false });
    });
    await fixtures.agent.act('tap the original button only');
    expect(performed.map((ref) => ref.id)).toEqual(['old-opaque']);
  });

});
