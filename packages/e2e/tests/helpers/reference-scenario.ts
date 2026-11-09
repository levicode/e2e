/**
 * The engine boundary a browser reconnect leaves behind, as the consumers see
 * it: the same document identity scope and the same descriptors, with every
 * element re-issued under a new engine id and every earlier id refused as
 * stale. A reconnect is not a verb of the public engine contract, so the
 * consumer-level scenarios model its observable result here: `observe` mints
 * the newest generation, `perform` refuses an id that generation did not
 * issue, and the tap that reconnects retires every old id in one capture.
 *
 * The ids are the native shape (`@e<number>`), increasing across generations,
 * so a scenario can say exactly which issuance a consumer acted on. The
 * engine hands the runner a screen after each action, as the web engine does,
 * so the trace's own screen diff sees the reconnect too.
 */

import type {
  EngineAttemptContext,
  EngineSnapshot,
  LocatorAction,
  LocatorExpression,
  SemanticNode,
} from '../../src/engine/index.ts';
import { defineEngine, ENGINE_SPI_VERSION, engineFailure, obj, resolveExpression } from './engine-runtime.ts';

type States = NonNullable<SemanticNode['states']>;

/** One element of the scenario, addressed by a key that survives re-issuance. */
export interface ScenarioNode {
  readonly key: string;
  readonly role: string;
  readonly name?: string;
  readonly text?: string;
  readonly states?: States;
}

/** What the engine received, in order, with the exact issuance it was told to act on. */
export interface Dispatched {
  readonly id: string;
  readonly action: LocatorAction['kind'];
  readonly to?: string;
  /** How many reconnects had happened when this arrived: 1 is the first generation. */
  readonly generation: number;
}

export interface ReferenceScenario {
  readonly engine: ReturnType<typeof defineEngine>;
  /** Every action the engine received, oldest first. */
  readonly dispatched: Dispatched[];
}

/** The tree every scenario starts from; a node we may act on carries a known role and name. */
const TREE: readonly ScenarioNode[] = [
  { key: 'header', role: 'heading', name: 'Scenario' },
  { key: 'counter', role: 'status', name: 'Counter', text: '0' },
  { key: 'increment', role: 'button', name: 'Increment' },
  { key: 'reconnect', role: 'button', name: 'Reconnect the browser' },
];

/**
 * One engine whose ids are re-issued on demand. Tapping the `Reconnect the
 * browser` control reconnects: every id the screen listed becomes stale, and
 * the next capture lists the same descriptors under fresh ids.
 */
export function createReferenceScenario(tree: readonly ScenarioNode[] = TREE): ReferenceScenario {
  const generations = new Map<string, string>();
  const texts = new Map<string, string>();
  for (const node of tree) if (node.text !== undefined) texts.set(node.key, node.text);
  /** What every attempt starts from, so one attempt's taps never leak into the next. */
  const initialTexts = new Map(texts);

  let generation = 0;
  let nextId = 1;
  let opened = false;
  let attempt: EngineAttemptContext | undefined;
  const dispatched: Dispatched[] = [];

  const issue = (): void => {
    generation += 1;
    for (const node of tree) generations.set(node.key, `@e${String(nextId++)}`);
  };

  const semantic = (node: ScenarioNode): SemanticNode => {
    const text = texts.get(node.key);
    return {
      ref: { id: generations.get(node.key)!, revision: '' },
      role: node.role,
      ...(node.name === undefined ? {} : { name: node.name }),
      ...(text === undefined ? {} : { text }),
      ...(node.states === undefined ? {} : { states: { ...node.states } }),
    };
  };

  const snapshot = (): EngineSnapshot => ({
    identityScope: 'scenario-document',
    location: 'http://scenario.test/',
    root: { ref: { id: 'root', revision: '' }, role: 'document', children: tree.map(semantic) },
    viewport: { width: 800, height: 600 },
  });

  const keyOf = (id: string): string | undefined => {
    for (const [key, issued] of generations) if (issued === id) return key;
    return undefined;
  };

  const showScreen = (): void => {
    attempt?.screen?.(snapshot());
  };

  const engine = defineEngine({
    name: 'reference-scenario',
    version: '1.0.0',
    spiVersion: ENGINE_SPI_VERSION,
    actions: ['tap', 'dragTo'],
    async startAttempt(context) {
      attempt = context;
      opened = false;
      for (const [key, text] of initialTexts) texts.set(key, text);
      issue();
    },
    async endAttempt() {
      attempt = undefined;
      opened = false;
    },
    async observe() {
      if (!opened) throw engineFailure('INVALID_STATE', 'no app is open; call app.open() first');
      return snapshot();
    },
    async locate(expression: LocatorExpression) {
      if (!opened) throw engineFailure('INVALID_STATE', 'no app is open; call app.open() first');
      return resolveExpression(expression, tree.map(semantic)).map(match => obj({ ...match, children: undefined }));
    },
    async perform(ref, action) {
      const key = keyOf(ref.id);
      if (key === undefined) throw engineFailure('NODE_STALE', `node ${ref.id} was retired by the reconnect`, true);
      const to = action.kind === 'dragTo' ? keyOf(action.target.id) : undefined;
      if (action.kind === 'dragTo' && to === undefined) throw engineFailure('NODE_STALE', `drag target ${action.target.id} was retired by the reconnect`, true);
      dispatched.push({ id: ref.id, action: action.kind, ...(action.kind === 'dragTo' ? { to: action.target.id } : {}), generation });
      if (action.kind === 'tap' && key === 'increment') texts.set('counter', String(Number(texts.get('counter') ?? '0') + 1));
      if (action.kind === 'tap' && key === 'reconnect') {
        issue();
        showScreen();
        return;
      }
      showScreen();
    },
    session: {
      async open() {
        opened = true;
        showScreen();
      },
    },
  });

  return { engine, dispatched };
}
