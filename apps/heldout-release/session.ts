import { openHost, type E2ESession } from 'e2e/runner';
import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { cases, catalog, serve, verify } from './fixture.ts';

type Agent = NonNullable<E2EConfig['agents']>[string];
type ConfiguredModel = NonNullable<Agent['model']>;
export const budget = { callsPerScenario: 12, stepsPerScenario: 18, inputTokensPerCall: 12000, scenarioMs: 120000, runMs: 780000, repeats: 1, maximumCalls: 72 } as const;

/** Exercises only public built package APIs. Caller must establish candidate readiness before calling. */
export async function exercise(model: ConfiguredModel, output: string, signal: AbortSignal) {
  const rows = [];
  for (const kind of cases) {
    const seed = randomBytes(12).toString('hex');
    const spec = catalog(kind, seed);
    const journal = join(output, `${kind}-${seed}.jsonl`);
    const fixture = await serve(spec, journal);
    const start = Date.now();
    let session: E2ESession<object> | undefined;
    let host: Awaited<ReturnType<typeof openHost>> | undefined;
    let failure: string | undefined;
    let steps: ReturnType<E2ESession['steps']> = [];
    try {
      host = await openHost({ cwd: output, signal, config: {
        projectId: 'dev.e2e.heldout-shelf', cache: 'off', timeout: budget.scenarioMs,
        agents: { default: { model, maxSteps: budget.stepsPerScenario, maxModelCalls: budget.callsPerScenario, maxInputTokens: budget.inputTokensPerCall } },
        targets: [{ name: 'native-web', engine: web(), app: { url: fixture.url } }],
      } satisfies E2EConfig });
      session = await host.openSession({ name: `shelf-${kind}`, signal, timeout: budget.scenarioMs });
      await session.fixtures.app.open('/');
      await session.fixtures.agent.act(`Find "${spec.wanted}" in the paper catalog. If present, ensure it is on the saved shelf without removing existing papers. Do not write unchanged data. If absent, leave the saved shelf unchanged. Confirm the stored outcome by refreshing the shelf.`);
    } catch { failure = 'execution-failed'; }
    finally {
      try { if (session) { if ((await session.close()).length) failure = 'session-cleanup-failed'; steps = session.steps(); } }
      catch { failure = 'session-cleanup-failed'; }
      try { if (host && (await host.close()).length) failure = 'host-cleanup-failed'; }
      catch { failure = 'host-cleanup-failed'; }
      await fixture.close();
    }
    const observed = steps.flatMap(step => step.model ? [step.model] : []);
    const usage = { calls: observed.reduce((n, usageModel) => n + usageModel.calls, 0), inputTokens: observed.reduce((n, usageModel) => n + usageModel.inputTokens, 0), outputTokens: observed.reduce((n, usageModel) => n + usageModel.outputTokens, 0), estimatedCostUsd: observed.every(usageModel => usageModel.estimatedCostUsd !== undefined) && observed.length ? observed.reduce((n, usageModel) => n + usageModel.estimatedCostUsd!, 0) : null };
    const oracle = await verify(spec, journal);
    const elapsedMs = Date.now() - start;
    if (usage.calls === 0) failure = 'no-real-model-call';
    if (usage.calls > budget.callsPerScenario || elapsedMs > budget.scenarioMs) failure = 'observed-budget-exceeded';
    const row = { kind, seed, status: !failure && oracle.passed ? 'passed' : 'failed', failure, oracle, usage, elapsedMs, models: observed.map(value => ({ provider: value.provider, model: value.model, adapterVersion: value.adapterVersion, policyVersion: value.policyVersion, tokenAccounting: value.tokenAccounting })) };
    rows.push(row);
    await writeFile(join(output, `${kind}-${seed}.result.json`), JSON.stringify(row, null, 2), { flag: 'wx' });
    if (row.status !== 'passed') break;
  }
  return { status: rows.length === cases.length && rows.every(row => row.status === 'passed') ? 'passed' : 'failed', scenarios: rows };
}
