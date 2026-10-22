/** Test-only source-equivalent d7 primitive oracle. Its disposable page/handles never acquire native authority. */
import type { Page } from 'playwright-core';
import type { SemanticNode } from 'e2e/engine';
import type { CapturedDocument } from '../../src/observation.ts';
import type { SyntheticEvidence, SyntheticFact, SyntheticOutcome } from './synthetic-evidence.ts';
import { CANVAS_TARGET_IDS, CanvasOracleLifetime, canvasOracleAvailable, canvasPairMatches, canvasRoleOrdinal, canvasRolesMatch, type CanvasNativePair } from './canvas-oracle-provenance.ts';

type OracleFact = Extract<SyntheticFact, { kind: 'canvas-oracle' }>;

/** P42 never awaits this companion. Only closed scalars leave it; original refs/DTOs are not retained. */
export async function recordCanvasOracle(
  evidence: SyntheticEvidence, nativePair: CanvasNativePair | undefined, connectionPage: Page | undefined, html: string,
): Promise<SyntheticOutcome> {
  const outcome: SyntheticOutcome = { setup: 'not-started', body: 'not-started', cleanup: 'not-started' };
  if (!evidence.available) return outcome;
  const owner = new CanvasOracleLifetime();
  let captured: CapturedDocument | undefined;
  let unavailable = false;
  let contextAcquired = false;
  try {
    outcome.setup = 'failed';
    if (!canvasPairMatches(nativePair, html) || !canvasOracleAvailable() || connectionPage === undefined) throw new Error('Unavailable paired oracle provenance');
    const browser = connectionPage.context().browser();
    if (browser === null) throw new Error('Unavailable oracle connection');
    // The reader stamps Symbol.for('e2e.observation.ref'); this page is never used by a native operation.
    const context = await owner.acquire(() => browser.newContext(), resource => resource.close(), 2);
    contextAcquired = true;
    const page = await owner.acquire(() => context.newPage(), resource => resource.close(), 1);
    await owner.run(() => page.setContent(html, { timeout: owner.workRemaining }));
    const child = page.frames()[1];
    if (child !== undefined) await owner.run(() => child.waitForLoadState('domcontentloaded', { timeout: owner.workRemaining }));
    const { captureDocument } = await owner.run(() => import('../../src/observation.ts'));
    // Preserve the original 200-node/10-second capture settings, or do not start it at all.
    if (owner.workRemaining < 10_000) throw new Error('Unavailable original capture budget');
    outcome.setup = 'passed';
    outcome.body = 'failed';
    let nextId = 1;
    captured = await owner.run(() => captureDocument({
      testIdAttribute: 'data-testid', site: undefined,
      reserveIds: count => { const first = nextId; nextId += count; return first; },
      commit: (_id, element) => { owner.publish(element, resource => resource.dispose()); },
    }, page, { framePath: [], budget: 200, deadline: Date.now() + 10_000, signal: owner.signal }));
    outcome.body = 'passed';
    unavailable ||= captured.truncated;
  } catch { unavailable = true; }
  finally {
    // A deadline does not pretend an in-flight promise was cancelled. Late acquisitions/handles remain
    // owned and can only execute tracked disposal; only proven real settlement can make cleanup complete.
    const cleaned = await owner.cleanup();
    outcome.cleanup = !cleaned ? 'failed' : contextAcquired ? 'passed' : 'not-started';
    unavailable ||= !cleaned;
  }
  try {
    const baselineNodes = new Map<string, SemanticNode>();
    const visit = (node: SemanticNode): void => {
      if (node.testId !== undefined) {
        if (baselineNodes.has(node.testId)) unavailable = true;
        baselineNodes.set(node.testId, node);
      }
      for (const child of node.children ?? []) visit(child);
    };
    if (captured !== undefined) visit(captured.tree);
    for (const target of CANVAS_TARGET_IDS) if (canvasRoleOrdinal(baselineNodes.get(target)?.role) === 4) unavailable = true;
    for (const [ordinal, target] of CANVAS_TARGET_IDS.entries()) {
      evidence.observe((): OracleFact => {
        const native = nativePair?.targets[ordinal];
        const baseline = baselineNodes.get(target);
        return { kind: 'canvas-oracle', targetOrdinal: ordinal as 0 | 1 | 2 | 3,
          nativeIncluded: native?.nativeIncluded ?? false, baselineIncluded: baseline !== undefined,
          roleMatchesExpected: native?.roleOrdinal === ordinal,
          nativeRoleEqualsBaseline: !unavailable && native !== undefined && canvasRolesMatch(native.roleOrdinal, canvasRoleOrdinal(baseline?.role)),
          namePresence: native?.namePresence ?? false, valuePresence: native?.valuePresence ?? false,
          truncated: captured?.truncated ?? false, unavailable };
      });
    }
    if (outcome.cleanup !== 'not-started') evidence.record({ kind: 'phase', section: 'cleanup', phase: 'dispose', state: outcome.cleanup === 'passed' ? 'passed' : 'failed' });
    if (unavailable) evidence.invalidate();
  } catch { evidence.invalidate(); }
  return outcome;
}
