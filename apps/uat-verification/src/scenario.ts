/**
 * The one fixed, read-only UAT scenario, driven through the agent step path.
 *
 * It walks the same route a person would — home, the account menu, the account
 * label page, the account ID field, 查询 — but takes no branch on app content:
 * every control is found by its own visible name or placeholder and acted on by
 * node id, exactly as the agent path does, so the report records the same
 * engine events and observation phases. Nothing here writes business data; the
 * only input is the account ID the private settings name, and the step asks for
 * no label, dialog, or form submission other than the read-only query.
 *
 * `README.md` explains why this stays a scripted executor: a model would decide
 * a different path per run, and the loop exists to compare runs of one path.
 */
import type { ExecutorNode, ExecutorObservation, StepExecutor, StepExecutorContext, StepVerdict } from 'e2e';
import type { UatSettings } from './settings.ts';

/** The instruction the fixed test passes; any other act step is unsupported. */
export const SCENARIO_INSTRUCTION = 'query the account label page for the configured account';

const POLL_MS = 400;
const STEP_DEADLINE_MS = 60_000;

/** The app's own labels, matched as the rendered text, never as selectors. */
const LABELS = {
  accountMenu: '账号管理',
  accountLabelMenu: '账号标签管理',
  accountIdPlaceholder: '请输入账号ID',
  search: '查询',
} as const;

/** The scripted executor: no model, no branching on business content. */
export function readOnlyScenario(settings: UatSettings): StepExecutor {
  return {
    name: 'uat-read-only-scenario',
    version: '1',
    cache: 'off',
    async runStep(ctx) {
      if (ctx.step.kind !== 'act' || ctx.step.instruction !== SCENARIO_INSTRUCTION) {
        return { status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED', summary: 'This executor runs only the fixed read-only UAT scenario.' };
      }
      const accountId = settings.accountId;
      if (accountId === undefined) {
        return { status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED', summary: 'The private UAT settings name no account ID to query.' };
      }
      const deadline = Date.now() + STEP_DEADLINE_MS;
      let observation = await ctx.observe({ tree: true });
      await tapControl(ctx, observation, tree => byLabel(tree, LABELS.accountMenu), `menu item ${LABELS.accountMenu}`, deadline);
      observation = await ctx.observe({ tree: true });
      await tapControl(ctx, observation, tree => byLabel(tree, LABELS.accountLabelMenu), `menu item ${LABELS.accountLabelMenu}`, deadline);
      observation = await waitForAccountField(ctx, deadline);
      const field = accountIdField(observation);
      if (field === undefined) return missing(`the ${LABELS.accountIdPlaceholder} field`);
      await ctx.actions.type({ id: field.id }, accountId);
      observation = await ctx.observe({ tree: true });
      const search = searchButton(observation.tree);
      if (search === undefined) return missing(`the ${LABELS.search} button`);
      await ctx.actions.tap({ id: search.id });
      return { status: 'passed', summary: `Opened the account label page and submitted the read-only ${LABELS.search} query.` };
    },
  };
}

/** A verdict naming the control that never appeared, never its content. */
function missing(what: string): StepVerdict {
  return { status: 'failed', errorCode: 'LOCATOR_NOT_FOUND', summary: `The fixed scenario never saw ${what}.` };
}

/** Taps the one node a finder names, re-observing until it appears or the step clock runs out. */
async function tapControl(
  ctx: StepExecutorContext,
  observation: ExecutorObservation,
  find: (tree: ExecutorNode | undefined) => ExecutorNode | undefined,
  what: string,
  deadline: number,
): Promise<void> {
  let node = find(observation.tree);
  while (node === undefined) {
    if (Date.now() >= deadline) throw new Error(`UAT_SCENARIO_MISSING: the fixed scenario never saw ${what}`);
    await sleep(ctx, POLL_MS);
    observation = await ctx.observe({ tree: true });
    node = find(observation.tree);
  }
  if (node === undefined) throw new Error(`UAT_SCENARIO_MISSING: the fixed scenario never saw ${what}`);
  await ctx.actions.tap({ id: node.id });
}

/**
 * Waits for the account label page by its own control, not by the hash route:
 * the engine reports the location after a hash navigation without the fragment,
 * while the page's account ID field is unambiguous once it renders.
 */
async function waitForAccountField(ctx: StepExecutorContext, deadline: number): Promise<ExecutorObservation> {
  for (;;) {
    const observation = await ctx.observe({ tree: true });
    if (accountIdField(observation) !== undefined) return observation;
    if (Date.now() >= deadline) throw new Error(`UAT_SCENARIO_MISSING: the ${LABELS.accountIdPlaceholder} field never appeared`);
    await sleep(ctx, POLL_MS);
  }
}

/** The account ID input: its placeholder is the label a person reads. */
function accountIdField(observation: ExecutorObservation): ExecutorNode | undefined {
  const textboxes = flatten(observation.tree).filter(node => node.role === 'textbox' && node.rect !== undefined);
  return textboxes.find(node => (node.attributes?.['placeholder'] ?? '').includes(LABELS.accountIdPlaceholder))
    ?? (textboxes.length === 1 ? textboxes[0] : undefined);
}

/** The 查询 button, by role and name, falling back to its rendered text. */
function searchButton(tree: ExecutorNode | undefined): ExecutorNode | undefined {
  const button = flatten(tree).find(node => node.role === 'button' && node.name?.trim() === LABELS.search && node.rect !== undefined);
  return button ?? byLabel(tree, LABELS.search);
}

/** The first visible node whose name or text reads exactly `label`, preferring an actionable role. */
function byLabel(tree: ExecutorNode | undefined, label: string): ExecutorNode | undefined {
  const matches = flatten(tree).filter(node => node.rect !== undefined && (node.name?.trim() === label || node.text?.trim() === label));
  const actionable = new Set(['button', 'link', 'menuitem', 'tab', 'option', 'treeitem', 'listitem']);
  return matches.find(node => node.role !== undefined && actionable.has(node.role)) ?? matches[0];
}

function flatten(tree: ExecutorNode | undefined): ExecutorNode[] {
  if (tree === undefined) return [];
  return [tree, ...(tree.children ?? []).flatMap(flatten)];
}

/** Sleeps one poll, stopping on the step's abort signal instead of waiting it out. */
function sleep(ctx: StepExecutorContext, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ctx.signal.aborted) {
      reject(new Error('UAT_SCENARIO_CANCELLED: the verification step was aborted'));
      return;
    }
    const timer = setTimeout(() => {
      ctx.signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    function abort(): void {
      clearTimeout(timer);
      reject(new Error('UAT_SCENARIO_CANCELLED: the verification step was aborted'));
    }
    ctx.signal.addEventListener('abort', abort, { once: true });
  });
}
