/** Short executor references, isolated from the engine's opaque node identities. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolSet, ToolExecutionOptions } from 'ai';
import type { SemanticNode } from '../engine/surface.ts';
import { modelRefLabel } from './observation.ts';
import { AgentError } from './error.ts';
import type { ExecutorActions, ExecutorTarget, StepExecutorContext } from './executor.ts';

interface RefScope { readonly bindings: ReadonlyMap<string, string>; readonly epoch: symbol }
const contexts = new WeakMap<StepExecutorContext, NodeRefs>();
const REQUEST_REFS = Symbol('request node references');

/** One invocation's engine-provided display references and immutable request bindings. */
export class NodeRefs {
  private readonly byId = new Map<string, string>();
  private readonly byAlias = new Map<string, string>();
  private readonly issued = new Map<string, string>();
  private readonly request = new AsyncLocalStorage<{ bindings: Map<string, string>; epoch: symbol }>();
  private epoch = Symbol();
  private engineScope: string | undefined;

  /** Validates the whole capture before updating any display-to-identity binding. */
  observe(tree: SemanticNode): boolean {
    const scopes = new Set<string>();
    const current = new Map<string, string>();
    const visit = (node: SemanticNode): void => {
      if (node.ref.modelRefScope !== undefined) scopes.add(node.ref.modelRefScope);
      const alias = node.ref.modelRef === undefined ? node.ref.id : node.ref.modelRef;
      if (alias !== null) {
        if (typeof alias !== 'string' || alias === '' || /\s/u.test(alias)) throw new AgentError('ACTION_FAILED', 'engine supplied an invalid model reference');
        const previous = current.get(alias);
        if (previous !== undefined && previous !== node.ref.id) throw new AgentError('ACTION_FAILED', 'engine supplied duplicate model references in one observation');
        current.set(alias, node.ref.id);
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
    const scope = JSON.stringify([...scopes].toSorted());
    const changed = this.engineScope !== undefined && this.engineScope !== scope;
    if (changed) {
      this.byId.clear(); this.byAlias.clear(); this.issued.clear();
      this.epoch = Symbol();
    }
    this.engineScope = scope;
    for (const [alias, id] of current) {
      this.byId.set(id, alias);
      this.byAlias.set(alias, id);
    }
    return changed;
  }

  /** Looks up an explicit engine display identity; structural nodes have none. */
  encode = (id: string): string | undefined => this.byId.get(id);

  /** Rejects unknown or foreign input before the ordinary historical resolution runs. */
  decode(target: ExecutorTarget): ExecutorTarget {
    const alias = typeof target?.id === 'string' ? target.id : '';
    const request = this.request.getStore();
    this.assertCurrent();
    const scope = request?.bindings ?? this.issued;
    const id = scope.get(alias) ?? (!alias.startsWith('#@') && alias.startsWith('#') ? scope.get(alias.slice(1)) : undefined);
    if (id === undefined) throw new AgentError('LOCATOR_NOT_FOUND', 'node reference was not issued for this request or has expired; observe and use a listed id');
    return { id };
  }

  /** Checks again at each actual dispatch, including retries after a relocation capture. */
  assertCurrent(): void {
    const request = this.request.getStore();
    if (request !== undefined && request.epoch !== this.epoch) throw new AgentError('LOCATOR_NOT_FOUND', 'the engine reference scope changed; this model request has expired');
  }

  /** Makes only references actually handed to an executor addressable. */
  expose(alias: string | undefined): void {
    if (alias === undefined) return;
    const id = this.byAlias.get(alias);
    if (id !== undefined) this.issued.set(alias, id);
  }

  /** Missing semantic evidence invalidates outstanding requests, even if the same spelling returns later. */
  invalidate(): void {
    this.byId.clear(); this.byAlias.clear(); this.issued.clear();
    this.epoch = Symbol();
  }

  /** Raw tree IDs are granted only to trusted executors that explicitly requested that tree. */
  exposeOpaque(id: string): void { this.issued.set(id, id); }

  /** Drops only retired bindings; an older capture must not remove a newer binding of the same native ref. */
  retain(ids: ReadonlySet<string>): void {
    for (const [key, id] of this.issued) if (!ids.has(id)) this.issued.delete(key);
    for (const [id, alias] of this.byId) {
      if (ids.has(id)) continue;
      this.byId.delete(id);
      if (this.byAlias.get(alias) === id) this.byAlias.delete(alias);
      if (this.issued.get(alias) === id) this.issued.delete(alias);
    }
  }

  /** Rewrites diagnostic references only; application text is not an identifier protocol. */
  prose(text: string): string {
    const aliases = new Map(this.byId);
    for (const [alias, id] of this.request.getStore()?.bindings ?? []) aliases.set(id, alias);
    const ids = [...aliases.keys()].toSorted((a, b) => b.length - a.length);
    if (ids.length === 0) return text;
    const pattern = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    return text.replace(new RegExp(`#(${pattern})(?=$|[\\s.,;!?()\\[\\]{}"'])`, 'g'), (_whole, id: string) => modelRefLabel(aliases.get(id)!));
  }

  /** Wraps every public action; replay continues to use the unwrapped dispatcher. */
  actions(raw: ExecutorActions): ExecutorActions {
    const target = (value: ExecutorTarget) => this.decode(value);
    const optional = (value: ExecutorTarget | undefined) => value === undefined ? undefined : target(value);
    const actions: ExecutorActions = {
      tap: (t, o) => raw.tap(target(t), o),
      doubleTap: (t, o) => raw.doubleTap(target(t), o),
      longPress: (t) => raw.longPress(target(t)),
      secondaryTap: (t, o) => raw.secondaryTap(target(t), o),
      hover: (t) => raw.hover(target(t)),
      type: (t, v) => raw.type(target(t), v),
      typeSecret: (t, v) => raw.typeSecret(target(t), v),
      press: (t, v) => raw.press(target(t), v),
      select: (t, v) => raw.select(target(t), v),
      check: (t, v) => raw.check(target(t), v),
      drag: (s, d) => raw.drag(target(s), target(d)),
      scrollTo: (t) => raw.scrollTo(target(t)),
      upload: (t, p) => raw.upload(target(t), p),
      scroll: (d, t) => raw.scroll(d, optional(t)),
      scrollUntil: (v, d, t) => raw.scrollUntil(v, d, optional(t)),
      navigate: (url) => raw.navigate(url),
      back: () => raw.back(),
      typeText: (v, o) => raw.typeText(v, o),
      pressKey: (k) => raw.pressKey(k),
      dismissKeyboard: () => raw.dismissKeyboard(),
      hitTest: async (p) => {
        const { control: rawControl, under: rawUnder, ...hit } = await raw.hitTest(p);
        const control = this.output(rawControl?.id);
        const under = this.output(rawUnder?.id);
        return { ...hit,
          ...(control === undefined ? {} : { control: { id: control } }),
          ...(under === undefined ? {} : { under: { id: under } }),
        };
      },
      tapAt: async (p) => this.point(await raw.tapAt(p)),
      hoverAt: async (p) => this.point(await raw.hoverAt(p)),
    };
    for (const name of Object.keys(actions) as (keyof ExecutorActions)[]) {
      const action = actions[name];
      Object.assign(actions, { [name]: (...args: never[]) => {
        const run = async () => {
          try { return await (action as (...args: never[]) => Promise<unknown>)(...args); }
          catch (error) {
            if (error instanceof Error) {
              error.message = this.prose(error.message);
              if (error instanceof AgentError) Object.assign(error, { explanation: error.message });
            }
            throw error;
          }
        };
        return this.request.getStore() === undefined ? this.run(this.scope(), run) : run();
      } });
    }
    return actions;
  }

  /** Publishes an explicit point lookup result to the executor that requested it. */
  private output(id: string | undefined): string | undefined {
    if (id === undefined) return undefined;
    this.assertCurrent();
    const alias = this.encode(id);
    if (alias === undefined) return undefined;
    this.expose(alias);
    this.request.getStore()?.bindings.set(alias, id);
    return alias;
  }

  /** Converts the point result without changing what the dispatcher actually acted on. */
  private point(result: Awaited<ReturnType<ExecutorActions['tapAt']>>) {
    const { target: rawTarget, ...rest } = result;
    const target = this.output(rawTarget?.id);
    return { ...rest, ...(target === undefined ? {} : { target: { id: target } }) };
  }

  /** Associates a context with its private identity map without expanding the public API. */
  bind(context: StepExecutorContext): StepExecutorContext {
    contexts.set(context, this);
    return context;
  }

  /** Freezes the aliases that existed when one model request was assembled. */
  scope(): RefScope { return { bindings: new Map(this.issued), epoch: this.epoch }; }

  /** Runs a tool against the immutable scope of the request that produced it. */
  run<T>(scope: RefScope, body: () => T): T { return this.request.run({ bindings: new Map(scope.bindings), epoch: scope.epoch }, body); }
}

/** Tool context is request-local and is never part of the provider payload. */
export function nodeRefRequest(context: StepExecutorContext, tools: ToolSet): object {
  const scope = contexts.get(context)?.scope();
  return Object.fromEntries(Object.keys(tools).map((name) => [name, { [REQUEST_REFS]: scope }]));
}

/** Binds tool execution to its originating request, including concurrent tool calls. */
export function scopeNodeRefTools(context: StepExecutorContext, tools: ToolSet): ToolSet {
  const refs = contexts.get(context);
  if (refs === undefined) return tools;
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (tool.execute === undefined) return [name, tool];
    const execute = tool.execute;
    return [name, { ...tool, execute: (input: never, options: ToolExecutionOptions<unknown>) => {
      const scope = (options.context as { [REQUEST_REFS]?: RefScope } | undefined)?.[REQUEST_REFS];
      if (scope === undefined) throw new AgentError('LOCATOR_NOT_FOUND', 'node reference request scope is unavailable');
      return refs.run(scope, () => execute(input, options));
    } }];
  })) as ToolSet;
}
