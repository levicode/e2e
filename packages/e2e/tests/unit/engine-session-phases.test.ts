/** The engine-to-session adapter must not drop observation timing evidence. */
import { describe, expect, it } from 'vitest';
import { defineEngine } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';

describe('engine session observation phases', () => {
  it('keeps the engine phases on the session observation', async () => {
    const engine = defineEngine({
      name: 'phase-fixture', version: '1', spiVersion: 1,
      observe: async () => ({
        root: { ref: { id: 'root', revision: '' }, role: 'document' } as const,
        viewport: { width: 100, height: 100 },
        phases: { 'semantic-metadata': 12, 'semantic-node-geometry': 3 },
      }),
    });
    const session = createEngineSession({ engine, targetName: 'fake' });
    const observation = await session.observe({ signal: new AbortController().signal, timeoutMs: 1_000, runId: 'run', attemptId: 'attempt', origin: 'test' });
    expect(observation.phases).toEqual({ 'semantic-metadata': 12, 'semantic-node-geometry': 3 });
  });
});
