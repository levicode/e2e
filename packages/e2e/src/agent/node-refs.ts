/** Short executor references, isolated from the engine's opaque node identities. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolSet, ToolExecutionOptions } from 'ai';
import { AgentError } from './error.ts';
import type { ExecutorActions, ExecutorTarget, StepExecutorContext } from './executor.ts';

type RefScope = ReadonlyMap<string, string>;
const contexts = new WeakMap<StepExecutorContext, NodeRefs>();
const REQUEST_REFS = Symbol('request node references');

/** One invocation's monotonically allocated references; an expired alias is never recycled. */
export class NodeRefs {
  private next = 0;
  private readonly byId = new Map<string, string>();
  private readonly byAlias = new Map<string, string>();
  private readonly issued = new Map<string, string>();
  private readonly request = new AsyncLocalStorage<Map<string, string>>();

  /** Encodes the complete opaque identity, without interpreting any of its components. */
  encode = (id: string): string => {
    let alias = this.byId.get(id);
    if (alias === undefined) {
      alias = `n${(++this.next).toString(36)}`;
      this.byId.set(id, alias);
      this.byAlias.set(alias, id);
    }
    return alias;
  };

  /** Rejects unknown or foreign input before the ordinary historical resolution runs. */
  decode(target: ExecutorTarget): ExecutorTarget {
    const alias = typeof target?.id === 'string' ? target.id.replace(/^#/, '') : '';
    const id = (this.request.getStore() ?? this.issued).get(alias);
    if (id === undefined) throw new AgentError('LOCATOR_NOT_FOUND', 'node reference was not issued for this request or has expired; observe and use a listed id');
    return { id };
  }

  /** Makes only references actually handed to an executor addressable. */
  expose(alias: string): void {
    const id = this.byAlias.get(alias);
    if (id !== undefined) this.issued.set(alias, id);
  }

  /** Drops identities no retained observation can resolve, without resetting the counter. */
  retain(ids: ReadonlySet<string>): void {
    for (const [id, alias] of this.byId) {
      if (ids.has(id)) continue;
      this.byId.delete(id);
      this.byAlias.delete(alias);
      this.issued.delete(alias);
    }
  }

  /** Rewrites diagnostic references only; application text is not an identifier protocol. */
  prose(text: string): string {
    return text.replace(/#([^\s,;()]+)(?=$|[\s,;()])/g, (whole, id: string) => {
      const alias = this.byId.get(id);
      return alias === undefined ? whole : `#${alias}`;
    });
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
        const hit = await raw.hitTest(p);
        return { ...hit, summary: this.prose(hit.summary),
          ...(hit.control === undefined ? {} : { control: { id: this.output(hit.control.id) } }),
          ...(hit.under === undefined ? {} : { under: { id: this.output(hit.under.id) } }),
        };
      },
      tapAt: async (p) => this.point(await raw.tapAt(p)),
      hoverAt: async (p) => this.point(await raw.hoverAt(p)),
    };
    for (const name of Object.keys(actions) as (keyof ExecutorActions)[]) {
      const action = actions[name];
      Object.assign(actions, { [name]: async (...args: never[]) => {
        try { return await (action as (...args: never[]) => Promise<unknown>)(...args); }
        catch (error) {
          if (error instanceof Error) error.message = this.prose(error.message);
          throw error;
        }
      } });
    }
    return actions;
  }

  /** Publishes an explicit point lookup result to the executor that requested it. */
  private output(id: string): string {
    const alias = this.encode(id);
    this.expose(alias);
    this.request.getStore()?.set(alias, id);
    return alias;
  }

  /** Converts the point result without changing what the dispatcher actually acted on. */
  private point(result: Awaited<ReturnType<ExecutorActions['tapAt']>>) {
    return { ...result, summary: this.prose(result.summary),
      ...(result.target === undefined ? {} : { target: { id: this.output(result.target.id) } }),
    };
  }

  /** Associates a context with its private identity map without expanding the public API. */
  bind(context: StepExecutorContext): StepExecutorContext {
    contexts.set(context, this);
    return context;
  }

  /** Freezes the aliases that existed when one model request was assembled. */
  scope(): RefScope { return new Map(this.issued); }

  /** Runs a tool against the immutable scope of the request that produced it. */
  run<T>(scope: RefScope, body: () => T): T { return this.request.run(new Map(scope), body); }
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
