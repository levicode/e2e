import { describe, expect, it } from 'vitest';
import { interactiveNodeCount, observationShape, prepareObservation, projectTree } from '../../src/agent/observation.ts';
import { createGrammarTools } from '../../src/agent/primitives.ts';
import { fakeExecutorContext } from '../helpers/fake-executor-context.ts';
import { ScreenPresenter } from '../../src/agent/screen-update.ts';
import { nodeLine } from '../../src/agent/point-tap.ts';
import type { Observation, SemanticNode } from '../../src/engine/surface.ts';

/** A synthetic tree with exactly the IDs supplied by its engine. */
function screen(rootId: string, buttonId: string) {
  const tree: SemanticNode = {
    ref: { id: rootId, revision: 'r1' }, role: 'document', children: [
      { ref: { id: buttonId, revision: 'r1' }, role: 'button', name: 'Save' },
    ],
  };
  const raw: Observation = {
    kind: 'semantic', root: tree.ref, tree, revision: 'r1', capturedAt: '', truncated: false,
    viewport: { width: 100, height: 100 }, redaction: { secureNodeCount: 0, maskedRegionCount: 0 },
  };
  return prepareObservation(raw, { redact: text => text, redactCut: text => text, maxBytes: 4_096 });
}

describe('canonical engine references', () => {
  it('renders an engine-supplied reference without adding another sigil', () => {
    expect(screen('@e1', '@e7').text).toContain('@e7 button "Save"');
    expect(screen('@e1', '@e7').text).not.toContain('#@');
    expect(screen('root', 'mobile7').text).toContain('#mobile7 button');
  });

  it('retains the same ID in custom-executor trees and point feedback', () => {
    const observation = screen('@e1', '@e7');
    expect(nodeLine(observation, '@e7')).toBe('@e7 button "Save"');
    expect(nodeLine({ text: '' }, '@e7')).toBe('@e7');
    expect(nodeLine(screen('root', 'mobile7'), 'mobile7')).toBe('#mobile7 button "Save"');
    if (observation.kind !== 'semantic') throw new Error('expected semantic observation');
    expect(projectTree(observation.tree).children?.[0]?.id).toBe('@e7');
  });

  it('tracks canonical IDs in incremental screen updates', () => {
    const presenter = new ScreenPresenter();
    presenter.initial({ revision: 'r1', text: '@e1 document\n @e7 button "Save"', truncated: false, viewport: { width: 100, height: 100 } });
    const output = presenter.update({ revision: 'r2', text: '@e1 document\n @e7 button "Saved"', truncated: false, viewport: { width: 100, height: 100 } });
    expect(output).toContain('changed @e7 button');
    expect(output).not.toContain('#@');
  });

  it('dispatches the unchanged canonical ID and uses it in action feedback', async () => {
    const { context } = fakeExecutorContext();
    const ids: string[] = [];
    const tools = createGrammarTools({
      ...context,
      actions: { ...context.actions, tap: async target => { ids.push(target.id); } },
      observe: async () => ({ revision: 'r1', text: '@e7 button "Save"', truncated: false, viewport: { width: 100, height: 100 } }),
    });
    const result = await tools['tap']!.execute!({ target: '@e7' }, { toolCallId: 'tap', messages: [], context: undefined });
    expect(ids).toEqual(['@e7']);
    expect(result).toContain('Tapped @e7.');
    expect(result).not.toContain('#@');
  });

  it('counts controls and ignores ID churn in screen comparison for either grammar', () => {
    const first = screen('@e1', '@e7');
    expect(interactiveNodeCount(first)).toBe(1);
    expect(observationShape(first)).toBe(observationShape(screen('@e22', '@e91')));
    expect(observationShape(first)).toBe(observationShape(screen('root', 'mobile7')));
  });
});
