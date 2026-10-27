/** Engine hooks over the same native command lane as the public Browser fixture. */
import type {
  EngineFieldValues, EngineReadField, EngineObserveOptions, LocatorAction, LocatorExpression, NodeRef, PointerAction,
  SemanticNode, ViewportPoint, ViewportSize,
} from 'e2e/engine';

export interface Scoped { readonly identityScope: string }
export interface NativeBlob extends Scoped {
  readonly handle: string;
  readonly size: number;
  readonly sha256: string;
}
export interface NativeImage extends NativeBlob {
  readonly mediaType: 'image/png';
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly maskedRegionCount: number;
}
export interface NativeTraceImage extends NativeImage {
  readonly viewportRef: NodeRef;
  readonly viewport: ViewportSize;
  readonly location: string;
}
export interface NativeObservation extends Scoped {
  readonly revision: string;
  readonly location?: string;
  readonly root: SemanticNode;
  readonly viewportRef?: NodeRef;
  readonly viewport: ViewportSize;
  readonly truncated?: boolean;
  readonly treeUnavailable?: boolean;
  readonly pixels?: NativeImage;
  readonly maskedRegionCount?: number;
}
export type NativeLocatorAction = Exclude<LocatorAction, { kind: 'setInputFiles' }> | {
  readonly kind: 'setInputFiles';
  readonly directoryName?: string;
  readonly files: readonly { readonly name: string; readonly mimeType: string; readonly bodyHandle: string; readonly relativePath?: string }[];
};
interface ReadPolicy {
  readonly testIdAttribute: string;
  readonly secureFieldSelector: string;
}
export interface ScopeCreationOptions {
  readonly blockServiceWorkers: boolean;
  readonly viewport: ViewportSize | null;
  readonly userAgent?: string;
  readonly locale?: string;
  readonly timezoneId?: string;
  readonly media: { readonly colorScheme?: 'light' | 'dark' | 'no-preference'; readonly reducedMotion?: 'reduce' | 'no-preference' };
  readonly initScripts: readonly string[];
}
export interface RecoveryIdentity { readonly browser: string; readonly context: string; readonly page: string }
export interface EngineCommandMap {
  'scope.open': { args: ScopeCreationOptions & (
    | { readonly source: 'launch'; readonly context: 'isolated'; readonly executablePath?: string; readonly headless: boolean }
    | { readonly source: 'connect'; readonly context: 'isolated' | 'persistent'; readonly endpoint: string }
    | { readonly source: 'reuse'; readonly context: 'isolated' }
  ); result: Scoped & { readonly recoveryIdentity: RecoveryIdentity } };
  'scope.interop.prepare': { args: EngineCommandMap['scope.open']['args'] & { readonly preparationId: string }; result: { readonly preparationId: string; readonly endpoint: string } };
  'scope.interop.adopt': { args: { readonly preparationId: string; readonly contextId: string; readonly targetId: string }; result: Scoped & { readonly recoveryIdentity: RecoveryIdentity } };
  'scope.interop.retire': { args: Scoped & { readonly contextId: string }; result: null };
  'scope.interop.abort': { args: { readonly preparationId: string }; result: null };
  'scope.interop.identify': { args: Scoped; result: { readonly contextId: string; readonly targetId: string; readonly persistent: boolean } };
  'scope.configure': { args: Scoped & ReadPolicy & { readonly requestPolicy: { readonly site?: string; readonly headers?: Readonly<Record<string, string>>; readonly basicAuth?: { readonly username: string; readonly password: string } }; readonly downloads: { readonly source: 'local' } | { readonly source: 'provider'; readonly remoteDirectory: string } }; result: null };
  'page.activate': { args: Scoped; result: { readonly activated: true } };
  'scope.end': { args: Scoped; result: null };

  'browser.observe': { args: Scoped & ReadPolicy & { readonly options: EngineObserveOptions }; result: NativeObservation };
  /** Live trace-only tree: temporary refs never enter native action authority. */
  'browser.trace': { args: Scoped & ReadPolicy & { readonly options: EngineObserveOptions }; result: NativeObservation };
  'fixture.query': { args: Scoped & ReadPolicy & { readonly expression: LocatorExpression }; result: Scoped & { readonly revision: string; readonly nodes: readonly SemanticNode[] } };
  'fixture.read-fields': { args: Scoped & ReadPolicy & { readonly expression: LocatorExpression; readonly fields: readonly EngineReadField[] }; result: Scoped & { readonly values: readonly EngineFieldValues[] } };
  'browser.query': { args: Scoped & ReadPolicy & { readonly expression: LocatorExpression }; result: Scoped & { readonly revision: string; readonly nodes: readonly SemanticNode[] } };
  'browser.perform': { args: Scoped & { readonly ref: NodeRef; readonly action: NativeLocatorAction }; result: null };
  'browser.pointer': { args: Scoped & { readonly point: ViewportPoint; readonly action: PointerAction }; result: null };
  'browser.keyboard.type': { args: Scoped & { readonly text: string; readonly replace: boolean }; result: null };
  'browser.keyboard.press': { args: Scoped & { readonly key: string }; result: null };
  'capture.screenshot': { args: Scoped & { readonly secureFieldSelector: string; readonly purpose?: 'pixelsOnly' | 'trace' }; result: NativeImage };
  'state.capture': { args: Scoped; result: NativeBlob & { readonly format: 'agent-browser-storage-state'; readonly version: 1 } };
  'state.restore': { args: Scoped & { readonly format: 'agent-browser-storage-state' | 'playwright-storage-state'; readonly version: 1; readonly bodyHandle: string }; result: Scoped & { readonly activatePage?: boolean } };
  'recording.start': { args: Scoped & { readonly size?: ViewportSize; readonly quality?: number }; result: null };
  'recording.stop': { args: Scoped; result: Scoped & ({ readonly segments: readonly (NativeBlob & { readonly mediaType: 'video/webm'; readonly startedAt: string })[]; readonly missingSegment?: number } | { readonly missingSegment: number }) };
  'session.environment': { args: Scoped; result: Scoped & { readonly browser: string; readonly userAgent?: string } };
  'scope.restart': { args: Scoped; result: Scoped & { readonly recoveryIdentity: RecoveryIdentity } };
  'scope.reset': { args: Scoped; result: Scoped & { readonly activatePage?: boolean } };
  'scope.reconnect': { args: Scoped & { readonly endpoint: string; readonly expectedBrowserIdentity: string; readonly expectedContextIdentity: string; readonly expectedPageIdentity: string }; result: Scoped };
  'blob.read': { args: Scoped & { readonly handle: string; readonly offset: number; readonly maxBytes: number }; result: { readonly base64: string; readonly nextOffset: number; readonly eof: boolean } };
}
