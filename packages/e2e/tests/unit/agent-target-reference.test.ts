/**
 * A model that copies a listed id can drop one of its two copy marks: the
 * `#` the listing adds and the `@` the web engine mints. `lookup` already
 * tolerated the `#`; these pin the `@` and the error that now names the
 * listing a missing id should have quoted. The incident: observation b2
 * listed the home page, the model wrote `e347`, and the harness answered
 * "removed or never existed" for a node that may have been on screen.
 */

import { describe, expect, it } from 'vitest';
import type { Observation, SemanticNode } from '../../src/engine/surface.ts';
import { prepareObservation, type SemanticAgentObservation } from '../../src/agent/observation.ts';
import { listedReference, nodeGone } from '../../src/agent/observation-feed.ts';

const NO_REDACT = (text: string): string => text;

function node(id: string, extra: Partial<SemanticNode> = {}): SemanticNode {
  return { ref: { id, revision: 'r1' }, ...extra };
}

function semantic(children: readonly SemanticNode[], truncated = false): SemanticAgentObservation {
  const root: SemanticNode = { ...node('@e1', { role: 'document' }), children: [...children] };
  const raw: Observation = {
    kind: 'semantic',
    root: root.ref,
    truncated,
    revision: 'b2',
    capturedAt: '2026-11-05T08:31:25.490Z',
    tree: root,
    viewport: { width: 768, height: 533 },
    redaction: { secureNodeCount: 1, maskedRegionCount: 1 },
  };
  const prepared = prepareObservation(raw, { redact: NO_REDACT, redactCut: NO_REDACT, maxBytes: 64_096 });
  if (prepared.kind !== 'semantic') throw new Error('expected semantic evidence');
  return prepared;
}

const listedIn = (keys: readonly string[]) => (id: string): boolean => keys.includes(id);

describe('listedReference', () => {
  const web = listedIn(['@e1', '@e347', '@e7110']);

  it('keeps an id the screen lists as written', () => {
    expect(listedReference('@e347', web)).toBe('@e347');
  });

  it('restores the web engine @ a model dropped from a listed id', () => {
    expect(listedReference('e347', web)).toBe('@e347');
    expect(listedReference('e7110', web)).toBe('@e7110');
  });

  it('strips an @ an engine without that prefix does not list', () => {
    expect(listedReference('@n7', listedIn(['n7']))).toBe('n7');
  });

  it('leaves an id that names no node as the model wrote it', () => {
    expect(listedReference('e335', web)).toBe('e335');
    expect(listedReference('e9007199254740991', web)).toBe('e9007199254740991');
  });
});

describe('nodeGone', () => {
  it('keeps the diagnosis and adds the listing the model should quote', () => {
    const message = nodeGone('e347', semantic([node('@e2', { role: 'button', name: 'Increment' }), node('@e3', { role: 'text', text: '0' })])).message;
    expect(message).toBe(
      'node #e347 is not on the current screen (observation b2); it was removed or never existed. ' +
      'The screen lists 3 nodes, such as #@e1, #@e2 and #@e3; quote an id exactly as the current listing prints it.',
    );
  });

  it('says a truncated listing may have cut the node instead of calling it gone', () => {
    const message = nodeGone('e347', semantic([node('@e2', { role: 'button', name: 'Increment' })], true)).message;
    expect(message).toContain('That listing is truncated, so a node past the cut is not listed.');
  });
});
