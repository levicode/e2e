import assert from 'node:assert/strict';
import type { E2EConfig, ExecutorNode, StepExecutor } from 'e2e';
import { agentBrowser } from '@e2e-dev/agent-browser';

function* walk(node: ExecutorNode): Generator<ExecutorNode> {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

/** A deterministic executor exercises the real observation/action API without an LLM. */
const executor: StepExecutor = {
  name: 'packaged-consumer-click', version: '1',
  async runStep(context) {
    const observation = await context.observe({ tree: true });
    assert.ok(observation.tree, 'The installed engine must produce a semantic observation');
    const buttons = [...walk(observation.tree)].filter(node => node.role === 'button' && node.name === 'Commit once');
    assert.equal(buttons.length, 1, 'The public observation must contain exactly one Commit once button');
    const button = buttons[0]!;
    await context.actions.tap({ id: button.id });
    await context.observe();
    return { status: 'passed', summary: 'Clicked the observed fixture button once' };
  },
};

export default {
  projectId: 'agent-browser-packaged-consumer',
  targets: [{
    name: 'chromium', platform: 'web',
    engine: agentBrowser({
      executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE ?? 'agent-browser',
      executablePath: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium',
      args: process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
      viewport: { width: 640, height: 480 },
    }),
    app: { url: process.env.CONSUMER_FIXTURE_URL ?? 'http://127.0.0.1:4173' },
  }],
  agents: { default: { executor } },
  tests: 'tests/**/*.e2e.ts', workers: 1, retries: 0,
  timeout: 90_000, launchTimeout: 60_000, actionTimeout: 20_000,
  cache: 'off', trace: 'on', video: 'off',
} satisfies E2EConfig;
