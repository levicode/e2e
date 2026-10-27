/** Typed fixture commands over the one native client session. No browser handles cross this boundary. */
import type { EngineError, JsonValue, NodeRef, OperationContext } from 'e2e/engine';
import type { Cookie } from '../browser.ts';
import type { Dialog } from '../dialog-types.ts';
import type { WebMedia } from '../media.ts';
import type { ErrorLatch } from '../runtime-support.ts';

/** One bounded chunk of an opaque native body or completed download. */
export interface NativeBodyChunk {
  readonly base64: string;
  readonly nextOffset: number;
  readonly eof: boolean;
}

/** Commands return null for success without a value, never an unchecked missing result. */
export interface BrowserCommandMap {
  /** Internal fixture acquisition identity only, never future live-action resolution. */
  'fixture.correlate': { args: { located: NodeRef[]; observed: NodeRef[] }; result: { identityScope: string; matches: (NodeRef | null)[] } };
  'blob.create': { args: { size: number; sha256: string }; result: { handle: string; size: number; sha256: string; maxChunkBytes: number } };
  'blob.write': { args: { handle: string; offset: number; base64: string }; result: { nextOffset: number } };
  'blob.seal': { args: { handle: string }; result: { handle: string; size: number; sha256: string } };
  'blob.release': { args: { handle: string }; result: { released: true } };
  'page.navigate': { args: { url: string; waitUntil: 'load' | 'domcontentloaded' | 'networkidle'; expectedPage?: { readonly contextId: string; readonly targetId: string } }; result: null };
  'page.reload': { args: Record<string, never>; result: null };
  'page.back': { args: Record<string, never>; result: null };
  'page.forward': { args: Record<string, never>; result: null };
  'page.url': { args: Record<string, never>; result: { url: string } };
  'page.title': { args: Record<string, never>; result: { title: string } };
  /** Native invokes the supplied function expression with one JSON argument and awaits its result. */
  'page.evaluate': { args: { source: string; argument: JsonValue }; result: { value: JsonValue } };
  'context.cookies.get': { args: Record<string, never>; result: { cookies: Cookie[] } };
  'context.cookies.set': { args: { cookies: Cookie[] }; result: null };
  'context.init-script': { args: { source: string }; result: null };
  'context.media': { args: WebMedia; result: null };
  'context.viewport': { args: { width: number; height: number }; result: null };
  'input.keyboard': { args: { action: 'press' | 'down' | 'up' | 'type'; value: string }; result: null };
  'input.mouse': { args: { action: 'move'; x: number; y: number } | { action: 'wheel'; deltaX: number; deltaY: number } | { action: 'down' | 'up' }; result: null };
  /** Atomic registry replacement; native captures this ordered list before emitting each paused request. */
  'network.routes.replace': { args: { version: number; registrationIds: string[] }; result: null };
  /** Enables response headers/body handles before any matching trigger is dispatched. */
  'network.responses.subscribe': { args: Record<string, never>; result: { subscriptionId: string } };
  'network.responses.unsubscribe': { args: { subscriptionId: string }; result: null };
  'network.body.read': { args: { handle: string; offset: number; maxBytes: number }; result: NativeBodyChunk };
  'network.body.release': { args: { handle: string }; result: null };
  /** Native still emits/latches an unhandled dialog when this registration is absent. */
  'dialog.register': { args: { enabled: boolean }; result: null };
  /** The channel adds its exact admission owner; this field is not taken from the wire. */
  'download.subscribe': { args: Record<string, never>; result: { subscriptionId: string; identityScope: string } };
  'download.unsubscribe': { args: { subscriptionId: string }; result: null };
  'download.metadata': { args: { handle: string }; result: { identityScope: string; source: 'local' } | { identityScope: string; source: 'provider'; basename: string } };
  'download.read': { args: { handle: string; offset: number; maxBytes: number }; result: NativeBodyChunk };
  'download.release': { args: { handle: string }; result: null };
}

/** Event envelopes are validated by the native client before fixture callbacks receive them. */
export interface BrowserEventMap {
  'network.request': {
    identityScope: string;
    token: string;
    timeoutMs: number;
    version: number;
    registrationIds: string[];
    fallbackOf?: string;
    request: { url: string; method: string; headers: Record<string, string>; postData?: string; postDataBase64?: string; postDataHandle?: string };
  };
  'registry-released': { identityScope: string; registryVersion: number };
  'network.response': { identityScope: string; activePage: boolean; handle: string; url: string; status: number; headers: Record<string, string> };
  'dialog.opened': { identityScope: string; token: string; timeoutMs: number; type: Dialog['type']; message: string };
  'download.started': { identityScope: string; activePage: boolean; handle: string; suggestedFilename: string };
}

/** Terminal decisions travel on the independent control lane, not the action queue. */
export type BrowserDecision =
  | ({ kind: 'fulfill'; status: number; headers: NativeHeader[] } & NativeDecisionBody)
  | { kind: 'continue' | 'fallback'; overrides: { url?: string; method?: string; headers?: NativeHeader[] } & (NativeDecisionBody | { bodyBase64?: never; bodyHandle?: never }) }
  | { kind: 'abort' }
  | { kind: 'dialog'; accept: boolean; promptText?: string };

/** Inline or staged data, never both. */
export type NativeDecisionBody = { bodyBase64: string; bodyHandle?: never } | { bodyHandle: string; bodyBase64?: never };

/** Ordered header pairs preserve duplicate protocol headers. */
export interface NativeHeader {
  readonly name: string;
  readonly value: string;
}

/** The native surface owns transport decoding, generation fencing, policy, and attempt teardown. */
export interface NativeWebSurface {
  readonly latch: Pick<ErrorLatch, 'throwPending' | 'latch' | 'track'>;
  readonly identityScope: string;
  /** Route a callback failure to its captured attempt, never a replacement scope. */
  latchCallbackFailure(identityScope: string, error: Error): void;
  /** Native registry versions are monotonic for the entire client lifetime. */
  routeRegistryVersion(): number;
  allocateRouteRegistryVersion(): number;
  /** Poison the current transport after impossible native data or failed resource cleanup. */
  invalidate(): EngineError;
  command<K extends keyof BrowserCommandMap>(name: K, args: BrowserCommandMap[K]['args'], operation: OperationContext): Promise<BrowserCommandMap[K]['result']>;
  /** Callbacks remain in the NativeClient event AsyncLocalStorage context; never invent another token. */
  subscribe<K extends keyof BrowserEventMap>(name: K, callback: (event: BrowserEventMap[K]) => void | Promise<void>): () => void;
  decide(token: string, decision: BrowserDecision, operation: OperationContext): Promise<void>;
  projectPath(file: string): string;
  siteHeaders(url: string): Readonly<Record<string, string>> | undefined;
  artifactPath(folder: string, label: string | undefined, extension: string): { relative: string; absolute: string };
}
