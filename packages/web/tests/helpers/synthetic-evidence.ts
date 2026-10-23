/** One concentrated synthetic evidence batch. Never imported by published runtime code. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { validInstallerRuntimeBinding, type InstallerRuntimeBinding } from './installer-fixture.ts';

export const SYNTHETIC_BATCH_ENV = 'E2E_SYNTHETIC_EVIDENCE_BATCH';
export const SYNTHETIC_DIRECTORY_ENV = 'E2E_SYNTHETIC_EVIDENCE_DIRECTORY';
export const SYNTHETIC_BINDING_ENV = 'E2E_SYNTHETIC_EVIDENCE_BINDING';
export const SYNTHETIC_BINDING_FILE = 'binding.json';
export const SYNTHETIC_CASE_MANIFEST = {
  P01: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/app-log.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P02: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/cdp-recovery.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P03: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/cdp-recovery.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P04: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/cdp-recovery.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P05: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/cdp-recovery.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P06: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/cdp-recovery.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P07: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/cdp-recovery.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P08: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/cdp-recovery.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P09: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/cdp-recovery.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P10: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/cdp-recovery.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P11: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/cdp-recovery.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P12: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/cdp-recovery.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P13: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/cdp-recovery.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P14: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/cli.test.ts", "packages/web/tests/helpers/installer-fixture.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P15: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/closed-shadow-locators.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P16: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/conformance.test.ts", "packages/web/tests/conformance/axe-core/implicit-role.cjs", "packages/web/tests/conformance/axe-core/accessible-text.cjs", "packages/web/tests/conformance/expected.txt", "packages/web/tests/helpers/conformance-evidence.ts", "packages/web/tests/crosscheck/expectations.ts"], maxRecords: 256, maxBytes: 64 * 1024 },
  P17: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/evaluate.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P18: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/evaluate.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P19: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/hung-page.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P20: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/hung-page.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P21: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/hung-page.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P22: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/init-scripts.test.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P23: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/keyboard-shadow-focus.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P24: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/lifecycle.test.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P25: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/lifecycle.test.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P26: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/lifecycle.test.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P27: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/lifecycle.test.ts", "packages/web/tests/helpers/native-browser.ts", "packages/web/tests/helpers/capture-fixture-surface.ts", "packages/web/tests/helpers/native-correlation.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P28: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/lifecycle.test.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P29: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/lifecycle.test.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P30: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/lifecycle.test.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P31: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/lifecycle.test.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P32: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/lifecycle.test.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P33: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/lifecycle.test.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P34: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/lifecycle.test.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P35: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/media.test.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P36: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/nested-frames.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P37: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/nested-frames.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P38: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/nested-frames.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P39: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/nested-frames.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P40: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/nested-frames.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P41: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/protected-app.test.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  P42: { suite: 'web-browser', group: 'public', sources: ['packages/web/tests/integration/read-node-roles.test.ts', 'packages/web/tests/helpers/canvas-oracle-provenance.ts'], maxRecords: 64, maxBytes: 32 * 1024 },
  P43: { suite: 'web-browser', group: 'public', sources: ["packages/web/tests/integration/route-announcer.test.ts", "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], maxRecords: 64, maxBytes: 32 * 1024 },
  C01: { suite: 'public-callbacks', group: 'callback', sources: ["packages/e2e/tests/integration/web-native-primitives-contract.test.ts", 'packages/web/tests/helpers/public-primitive-fixture.ts'], maxRecords: 64, maxBytes: 32 * 1024 },
  C02: { suite: 'public-callbacks', group: 'callback', sources: ["packages/e2e/tests/integration/web-native-primitives-contract.test.ts", 'packages/web/tests/helpers/public-primitive-fixture.ts'], maxRecords: 64, maxBytes: 32 * 1024 },
  C03: { suite: 'public-callbacks', group: 'callback', sources: ["packages/e2e/tests/integration/web-callback-contract.test.ts"], maxRecords: 8, maxBytes: 8 * 1024 },
  P05PW: { suite: 'web-browser', group: 'oracle', sources: ['packages/web/tests/integration/events-synthetic-controls.test.ts', 'packages/web/tests/helpers/public-primitive-fixture.ts'], maxRecords: 64, maxBytes: 32 * 1024 },
  C01N: { suite: 'web-browser', group: 'oracle', sources: ['packages/web/tests/integration/events-synthetic-controls.test.ts', 'packages/web/tests/helpers/public-primitive-fixture.ts'], maxRecords: 64, maxBytes: 32 * 1024 },
  C01PW: { suite: 'web-browser', group: 'oracle', sources: ['packages/web/tests/integration/events-synthetic-controls.test.ts', 'packages/web/tests/helpers/public-primitive-fixture.ts'], maxRecords: 64, maxBytes: 32 * 1024 },
  // Explicit source closure, never a dynamic producer-granted path list or an import of the page oracle.
  P42O: { suite: 'web-browser', group: 'oracle', sources: [
    'packages/web/tests/integration/read-node-roles.test.ts',
    'packages/web/tests/helpers/canvas-oracle.ts',
    'packages/web/tests/helpers/canvas-oracle-provenance.ts',
    'packages/web/tests/helpers/canvas-oracle-manifest.json',
    'packages/e2e/src/config/secrets.ts',
    'packages/e2e/src/engine/contract.ts',
    'packages/e2e/src/engine/index.ts',
    'packages/e2e/src/engine/manifest.ts',
    'packages/e2e/src/engine/recording.ts',
    'packages/e2e/src/engine/resolve.ts',
    'packages/e2e/src/engine/timing.ts',
    'packages/e2e/src/internal/brands.ts',
    'packages/e2e/src/internal/errors.ts',
    'packages/e2e/src/internal/json-value.ts',
    'packages/e2e/src/internal/objects.ts',
    'packages/e2e/src/internal/options.ts',
    'packages/e2e/src/internal/realm-slot.ts',
    'packages/e2e/src/internal/regexp.ts',
    'packages/e2e/src/internal/source.ts',
    'packages/e2e/src/internal/suggest.ts',
    'packages/e2e/src/internal/text.ts',
    'packages/e2e/src/internal/time.ts',
    'packages/e2e/src/internal/urls.ts',
    'packages/e2e/src/secrets.ts',
    'packages/web/src/capture-scope.ts',
    'packages/web/src/in-page/read-semantics.ts',
    'packages/web/src/observation.ts',
    'packages/web/src/read-node.ts',
    'packages/web/src/runtime-support.ts',
    'packages/web/src/support.ts',
  ], maxRecords: 32, maxBytes: 16 * 1024 },
  'nested-setup': { suite: 'web-browser', group: 'setup', sources: ['packages/web/tests/integration/nested-frames.test.ts', "packages/web/tests/helpers/synthetic-native-outcomes.ts", "packages/web/tests/helpers/synthetic-evidence.ts"], covers: ['P36', 'P37', 'P38', 'P39', 'P40'], maxRecords: 64, maxBytes: 32 * 1024 },
} as const;
export type SyntheticCaseId = keyof typeof SYNTHETIC_CASE_MANIFEST;
export type SyntheticSuite = typeof SYNTHETIC_CASE_MANIFEST[SyntheticCaseId]['suite'];
export const SYNTHETIC_TOTAL_BYTES = Object.values(SYNTHETIC_CASE_MANIFEST).reduce((sum, item) => sum + item.maxBytes, 0);
export const SYNTHETIC_RECORD_BYTES = 2048;
export const SYNTHETIC_MANIFEST_BYTES = 2 * 1024 * 1024;
export const SYNTHETIC_PHASES = [
  'init', 'host', 'start', 'open', 'document', 'readiness', 'witness', 'viewport', 'seed-state',
  'initial-locate', 'initial-observe', 'other-tab', 'route', 'dialog', 'disconnect', 'reconnect',
  'recovered-locate', 'recovered-state', 'stale-element', 'stale-viewport', 'stale-coordinate',
  'recovered-observe', 'recovered-action', 'observe', 'locate', 'action', 'evaluate', 'assertion',
  'capture', 'reset', 'restore', 'restart', 'media', 'reload', 'recording-start', 'recording-stop',
  'download-arm', 'download-trigger', 'download-event', 'navigation', 'cancel', 'end', 'dispose',
  'close-host', 'backstop', 'popup', 'register', 'registrations', 'dispatch', 'sample',
  'fixture-create', 'budget-change', 'target-close', 'browser-close', 'freeze-renderer', 'perform',
  'point-perform', 'navigate', 'abort', 'state-capture', 'state-reset', 'state-restore', 'video-start',
  'screenshot', 'video-stop', 'video-decode', 'popup-open', 'media-configure', 'media-read',
] as const;
export type SyntheticPhase = typeof SYNTHETIC_PHASES[number];
export const SYNTHETIC_COMMANDS = [
  'scope.open', 'scope.configure', 'scope.reconnect', 'scope.end', 'network.routes.replace',
  'page.activate', 'page.navigate', 'page.title', 'browser.observe', 'browser.query',
  'browser.perform', 'browser.performAt', 'fixture.evaluate', 'fixture.viewport',
  'capture.screenshot', 'blob.read', 'blob.release',
  'state.capture', 'state.reset', 'state.restore', 'recording.start', 'recording.stop', 'other',
] as const;
export type SyntheticCommand = typeof SYNTHETIC_COMMANDS[number];
export const SYNTHETIC_CODES = [
  'invalid-frame', 'unsupported-protocol', 'unsupported-capability', 'stale-generation', 'scope-unavailable',
  'sequence-reused', 'invalid-sequence', 'invalid-timeout', 'capacity-exceeded', 'operation-missing',
  'content-length-mismatch', 'redirect-body-unavailable', 'unsupported-command', 'deadline-exceeded',
  'cancelled', 'invalid-arguments', 'browser-failure', 'stale-scope', 'cleanup-failed', 'stale-reference',
  'policy-denied', 'not-actionable', 'intercepted-pointer', 'checked-state-unchanged',
  'checked-control-replaced', 'locator-not-found', 'decision-missing', 'decision-expired',
  'decision-kind-mismatch', 'registry-missing', 'registry-in-use', 'identifier-exhausted',
] as const;
export const SYNTHETIC_PUBLIC_CODES = ['NODE_STALE', 'FRAME_NOT_FOUND', 'FRAME_AMBIGUOUS', 'NOT_ACTIONABLE', 'ACTION_MAY_HAVE_COMMITTED', 'OPERATION_TIMEOUT', 'CANCELLED', 'UNSUPPORTED_CAPABILITY', 'INVALID_STATE', 'ENGINE_FAILURE', 'ACTION_FAILED', 'EVALUATE_FAILED', 'LOCATOR_NOT_FOUND', 'LOCATOR_AMBIGUOUS', 'POLICY_DENIED', 'other'] as const;
export interface SyntheticRetention {
  version: 1; retiredOperationSeq: number; producerState: 'retiring' | 'retired'; inputDebt: number; objectDebt: number;
}
export interface SyntheticNativeResult {
  operationSeq: number; ok: boolean; code: typeof SYNTHETIC_CODES[number] | null;
  effects: 'not-dispatched' | 'completed' | 'unknown'; scopeState: 'usable' | 'quarantined' | 'closed';
  retention?: SyntheticRetention;
}
export type SyntheticFact =
  | { kind: 'callback-failure'; stageOrdinal: number; code: typeof SYNTHETIC_PUBLIC_CODES[number]; causeCode: typeof SYNTHETIC_PUBLIC_CODES[number] | null }
  | ({ kind: 'installer-runtime' } & InstallerRuntimeBinding)
  | { kind: 'phase'; section: 'setup' | 'body' | 'cleanup' | 'backstop'; phase: SyntheticPhase; state: 'enter' | 'passed' | 'failed' }
  | { kind: 'native-result'; slot: 'first-refusal' | 'first-terminal'; phase: SyntheticPhase; command: typeof SYNTHETIC_COMMANDS[number]; result: SyntheticNativeResult | null }
  | { kind: 'request-rejected-without-result'; phase: SyntheticPhase; command: SyntheticCommand }
  | { kind: 'ownership'; phase: SyntheticPhase; hosts: number; clients: number; relays: number; pendingCleanup: number }
  | { kind: 'conformance'; tableOrdinal: 0 | 1; caseOrdinal: number; targetOrdinal: number; field: 'role' | 'name'; listed: boolean; matchesAxe: boolean; observedMissing: boolean; valueMissing: boolean; valueEmpty: boolean; matchesExistingException: boolean }
  | { kind: 'conformance-summary'; category: 'unexpected' | 'stale' | 'todo'; tableOrdinal: 0 | 1; caseOrdinal: number; targetOrdinal: number; expectedLineOrdinal: number }
  | { kind: 'conformance-counts'; total: number; emitted: number; omitted: number; truncated: boolean }
  | { kind: 'conformance-coverage'; tableOrdinal: 0 | 1; expectedCases: number; expectedTargets: number; expectedComparisons: number; completedCases: number; completedTargets: number; checkedComparisons: number; uniqueComparisons: number; mismatchComparisons: number; complete: boolean }
  | { kind: 'drag-acquisition'; sourcePresent: boolean; targetPresent: boolean; sourceUnique: boolean; targetUnique: boolean; sourceCount: number; targetCount: number }
  | { kind: 'canvas-oracle'; targetOrdinal: 0 | 1 | 2 | 3; nativeIncluded: boolean; baselineIncluded: boolean; roleMatchesExpected: boolean; nativeRoleEqualsBaseline: boolean; namePresence: boolean; valuePresence: boolean; truncated: boolean; unavailable: boolean }
  | { kind: 'popup-readiness'; phase: 'open-return' | 'ready-sample' | 'post-failure'; sampleOrdinal: number; present: boolean | null; closed: boolean | null; pathMatches: boolean | null; complete: boolean | null; activationActive: boolean | null; activationEver: boolean | null; predicate: boolean | null; readState: 'ok' | 'failed' | 'not-read' }
  | { kind: 'script-boot'; phase: 'main' | 'frame' | 'popup' | 'reset'; fixtureLifecycleOrdinal: 0 | 1 | 2 | 3; scriptOrdinal: 0 | 1 | 2 | 3; executionCount: number | null; exactOrder: boolean | null }
  | { kind: 'service-worker'; branch: 'plain' | 'headers-blocked'; phase: 'boot' | 'navigate' | 'register-count' | 'shutdown-end' | 'shutdown-dispose'; state: 'enter' | 'passed' | 'failed'; headersConfigured: boolean; registeredCount: number | null }
  | { kind: 'wheel-sample'; phase: 'original-sample' | 'post-result-sample' | 'delivery-witness'; sampleOrdinal: 0 | 1 | 2; downCount: number | null; upCount: number | null; wheelCount: number | null; expectedDeltaSeen: boolean | null; nativePublicResultObserved: boolean; cdpAckObserved: null }
  | { kind: 'frame-hit'; phase: 'pre-tap' | 'post-tap'; available: boolean; leafHitInput: boolean | null; leafHitButton: boolean | null; ancestorHitOwner: boolean | null; clickSeen: boolean | null; nativePointProven: false; nativeDispatchCount: null };
export type SyntheticOutcomeState = 'not-started' | 'passed' | 'failed' | 'incomplete';
export interface SyntheticOutcome { setup: SyntheticOutcomeState; body: SyntheticOutcomeState; cleanup: SyntheticOutcomeState }
export interface SyntheticBinding {
  // binarySha256 always identifies the primary suite runtime, not P14’s secondary child.
  runId: string; suite: SyntheticSuite; sourceRevision: string; testSourceDigest: string; binarySha256: string;
}
export interface SyntheticCaseBinding { caseId: SyntheticCaseId; sourceSha256: string }
export interface SyntheticConfiguration { schemaVersion: 1; binding: SyntheticBinding; cases: SyntheticCaseBinding[]; installerRuntime?: InstallerRuntimeBinding }
export type SyntheticSavedRecord =
  | { kind: 'header'; schemaVersion: 1; binding: SyntheticBinding; caseId: SyntheticCaseId; sourceSha256: string }
  | { kind: 'record'; sequence: number; fact: SyntheticFact }
  | { kind: 'footer'; sequence: number; dropped: number; truncated: boolean; incomplete: boolean; outcome: SyntheticOutcome };

/** Reject accessors, symbols, custom prototypes and custom serialization before reading values. */
export function syntheticObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)!.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}
export function syntheticKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export const syntheticCount = (value: unknown, max = 65_535): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
export const syntheticDigest = (value: unknown, length = 64): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value) && !/^0+$/.test(value);
export const syntheticCase = (value: unknown): value is SyntheticCaseId => typeof value === 'string' && Object.hasOwn(SYNTHETIC_CASE_MANIFEST, value);
const member = (values: readonly unknown[], value: unknown): boolean => values.includes(value);
const booleans = (value: Record<string, unknown>, keys: readonly string[]): boolean => keys.every(key => typeof value[key] === 'boolean');
const counts = (value: Record<string, unknown>, keys: readonly string[], max = 65_535): boolean => keys.every(key => syntheticCount(value[key], max));
/** Identity is only correlation. It cannot authorize producers or additional case IDs. */
export function validSyntheticBinding(value: unknown): value is SyntheticBinding {
  return syntheticObject(value) && syntheticKeys(value, ['runId', 'suite', 'sourceRevision', 'testSourceDigest', 'binarySha256'])
    && syntheticDigest(value['runId'], 32) && member(['web-browser', 'public-callbacks'], value['suite'])
    && syntheticDigest(value['sourceRevision'], 40) && syntheticDigest(value['testSourceDigest']) && syntheticDigest(value['binarySha256']);
}
/** The runner cannot grant arbitrary case IDs or skip any registered case in the selected suite. */
export function validSyntheticConfiguration(value: unknown): value is SyntheticConfiguration {
  if (!syntheticObject(value) || !syntheticKeys(value, Object.hasOwn(value, 'installerRuntime') ? ['schemaVersion', 'binding', 'cases', 'installerRuntime'] : ['schemaVersion', 'binding', 'cases']) || value['schemaVersion'] !== 1
    || !validSyntheticBinding(value['binding']) || !Array.isArray(value['cases'])) return false;
  const suite = value['binding'].suite;
  if (suite === 'web-browser' ? !validInstallerRuntimeBinding(value['installerRuntime']) || value['installerRuntime'].binarySha256 === value['binding'].binarySha256 : Object.hasOwn(value, 'installerRuntime')) return false;
  const expected = Object.keys(SYNTHETIC_CASE_MANIFEST).filter(id => SYNTHETIC_CASE_MANIFEST[id as SyntheticCaseId].suite === suite);
  return value['cases'].length === expected.length && value['cases'].every((item: unknown, index: number) => syntheticObject(item)
    && syntheticKeys(item, ['caseId', 'sourceSha256']) && item['caseId'] === expected[index] && syntheticDigest(item['sourceSha256']));
}
/** Informational retirement evidence only, never permission to continue an operation. */
function validSyntheticRetention(value: unknown, operationSeq: number): value is SyntheticRetention {
  return syntheticObject(value) && syntheticKeys(value, ['version', 'retiredOperationSeq', 'producerState', 'inputDebt', 'objectDebt'])
    && value['version'] === 1 && value['retiredOperationSeq'] === operationSeq
    && member(['retiring', 'retired'], value['producerState']) && counts(value, ['inputDebt', 'objectDebt'], 32);
}
/** Scalar projection of an already validated protocol result, never raw frames, payloads or errors. */
export function validSyntheticNativeResult(value: unknown): value is SyntheticNativeResult {
  if (!syntheticObject(value)) return false;
  const retained = Object.hasOwn(value, 'retention');
  return syntheticKeys(value, retained ? ['operationSeq', 'ok', 'code', 'effects', 'scopeState', 'retention'] : ['operationSeq', 'ok', 'code', 'effects', 'scopeState'])
    && syntheticCount(value['operationSeq'], 1_000_000) && value['operationSeq'] > 0 && typeof value['ok'] === 'boolean'
    && (value['ok'] ? value['code'] === null : member(SYNTHETIC_CODES, value['code']))
    && member(['not-dispatched', 'completed', 'unknown'], value['effects']) && member(['usable', 'quarantined', 'closed'], value['scopeState'])
    && (!retained || (value['ok'] === false && value['effects'] === 'unknown' && value['scopeState'] === 'usable'
      && validSyntheticRetention(value['retention'], value['operationSeq'])))
    && (value['effects'] !== 'unknown' || (value['ok'] === false && (value['scopeState'] !== 'usable' || retained)));
}
/** Each fact has an exact schema and a static case owner. There is no arbitrary fact map. */
export function validSyntheticFact(value: unknown, caseId: SyntheticCaseId): value is SyntheticFact {
  if (!syntheticObject(value)) return false;
  switch (value['kind']) {
    case 'callback-failure': return caseId === 'C03' && syntheticKeys(value, ['kind', 'stageOrdinal', 'code', 'causeCode']) && syntheticCount(value['stageOrdinal'], 5) && member(SYNTHETIC_PUBLIC_CODES, value['code']) && (value['causeCode'] === null || member(SYNTHETIC_PUBLIC_CODES, value['causeCode']));
    case 'installer-runtime': {
      if (caseId !== 'P14' || !syntheticKeys(value, ['kind', 'caseId', 'purpose', 'binarySha256', 'negotiationProofSha256'])) return false;
      const { kind: _kind, ...binding } = value; return validInstallerRuntimeBinding(binding);
    }
    case 'phase': return syntheticKeys(value, ['kind', 'section', 'phase', 'state'])
      && member(['setup', 'body', 'cleanup', 'backstop'], value['section']) && member(SYNTHETIC_PHASES, value['phase']) && member(['enter', 'passed', 'failed'], value['state']);
    case 'native-result': return syntheticKeys(value, ['kind', 'slot', 'phase', 'command', 'result']) && member(['first-refusal', 'first-terminal'], value['slot']) && member(SYNTHETIC_PHASES, value['phase'])
      && member(SYNTHETIC_COMMANDS, value['command']) && (value['result'] === null || (validSyntheticNativeResult(value['result'])
        && (value['slot'] === 'first-refusal' ? !value['result'].ok : value['result'].effects === 'unknown' || value['result'].scopeState !== 'usable')));
    case 'request-rejected-without-result': return syntheticKeys(value, ['kind', 'phase', 'command']) && member(SYNTHETIC_PHASES, value['phase']) && member(SYNTHETIC_COMMANDS, value['command']);
    case 'ownership': return syntheticKeys(value, ['kind', 'phase', 'hosts', 'clients', 'relays', 'pendingCleanup'])
      && member(SYNTHETIC_PHASES, value['phase']) && counts(value, ['hosts', 'clients', 'relays', 'pendingCleanup'], 1024);
    case 'conformance': return caseId === 'P16' && syntheticKeys(value, ['kind', 'tableOrdinal', 'caseOrdinal', 'targetOrdinal', 'field', 'listed', 'matchesAxe', 'observedMissing', 'valueMissing', 'valueEmpty', 'matchesExistingException'])
      && member([0, 1], value['tableOrdinal']) && counts(value, ['caseOrdinal']) && counts(value, ['targetOrdinal'], 255) && member(['role', 'name'], value['field'])
      && booleans(value, ['listed', 'matchesAxe', 'observedMissing', 'valueMissing', 'valueEmpty', 'matchesExistingException']);
    case 'conformance-summary': return caseId === 'P16' && syntheticKeys(value, ['kind', 'category', 'tableOrdinal', 'caseOrdinal', 'targetOrdinal', 'expectedLineOrdinal'])
      && member(['unexpected', 'stale', 'todo'], value['category']) && member([0, 1], value['tableOrdinal'])
      && counts(value, ['caseOrdinal', 'expectedLineOrdinal']) && counts(value, ['targetOrdinal'], 255);
    case 'conformance-counts': return caseId === 'P16' && syntheticKeys(value, ['kind', 'total', 'emitted', 'omitted', 'truncated'])
      && counts(value, ['total', 'emitted', 'omitted']) && booleans(value, ['truncated'])
      && value['total'] === (value['emitted'] as number) + (value['omitted'] as number) && value['truncated'] === (value['omitted'] !== 0);
    case 'conformance-coverage': return caseId === 'P16' && syntheticKeys(value, ['kind', 'tableOrdinal', 'expectedCases', 'expectedTargets', 'expectedComparisons', 'completedCases', 'completedTargets', 'checkedComparisons', 'uniqueComparisons', 'mismatchComparisons', 'complete'])
      && member([0, 1], value['tableOrdinal']) && typeof value['complete'] === 'boolean'
      && counts(value, ['expectedCases', 'expectedTargets', 'expectedComparisons', 'completedCases', 'completedTargets', 'checkedComparisons', 'uniqueComparisons', 'mismatchComparisons']);
    case 'drag-acquisition': return caseId === 'P26' && syntheticKeys(value, ['kind', 'sourcePresent', 'targetPresent', 'sourceUnique', 'targetUnique', 'sourceCount', 'targetCount'])
      && booleans(value, ['sourcePresent', 'targetPresent', 'sourceUnique', 'targetUnique']) && counts(value, ['sourceCount', 'targetCount']);
    case 'canvas-oracle': return caseId === 'P42O' && syntheticKeys(value, ['kind', 'targetOrdinal', 'nativeIncluded', 'baselineIncluded', 'roleMatchesExpected', 'nativeRoleEqualsBaseline', 'namePresence', 'valuePresence', 'truncated', 'unavailable'])
      && member([0, 1, 2, 3], value['targetOrdinal']) && booleans(value, ['nativeIncluded', 'baselineIncluded', 'roleMatchesExpected', 'nativeRoleEqualsBaseline', 'namePresence', 'valuePresence', 'truncated', 'unavailable']);
    case 'popup-readiness': return member(['P05', 'P05PW'], caseId) && syntheticKeys(value, ['kind', 'phase', 'sampleOrdinal', 'present', 'closed', 'pathMatches', 'complete', 'activationActive', 'activationEver', 'predicate', 'readState'])
      && member(['open-return', 'ready-sample', 'post-failure'], value['phase']) && syntheticCount(value['sampleOrdinal'], 15)
      && ['present', 'closed', 'pathMatches', 'complete', 'activationActive', 'activationEver', 'predicate'].every(key => value[key] === null || typeof value[key] === 'boolean') && member(['ok', 'failed', 'not-read'], value['readState']);
    case 'script-boot': return caseId === 'P22' && syntheticKeys(value, ['kind', 'phase', 'fixtureLifecycleOrdinal', 'scriptOrdinal', 'executionCount', 'exactOrder'])
      && member(['main', 'frame', 'popup', 'reset'], value['phase']) && counts(value, ['fixtureLifecycleOrdinal', 'scriptOrdinal'], 3)
      && value['fixtureLifecycleOrdinal'] === ['main', 'frame', 'popup', 'reset'].indexOf(value['phase'] as string)
      && (value['executionCount'] === null || syntheticCount(value['executionCount'], 8)) && (value['exactOrder'] === null || typeof value['exactOrder'] === 'boolean');
    case 'service-worker': return caseId === 'P41' && syntheticKeys(value, ['kind', 'branch', 'phase', 'state', 'headersConfigured', 'registeredCount'])
      && member(['plain', 'headers-blocked'], value['branch']) && member(['boot', 'navigate', 'register-count', 'shutdown-end', 'shutdown-dispose'], value['phase'])
      && member(['enter', 'passed', 'failed'], value['state']) && value['headersConfigured'] === (value['branch'] === 'headers-blocked') && (value['registeredCount'] === null || syntheticCount(value['registeredCount'], 2));
    case 'wheel-sample': return member(['C01', 'C01N', 'C01PW'], caseId) && syntheticKeys(value, ['kind', 'phase', 'sampleOrdinal', 'downCount', 'upCount', 'wheelCount', 'expectedDeltaSeen', 'nativePublicResultObserved', 'cdpAckObserved'])
      && member(['original-sample', 'post-result-sample', 'delivery-witness'], value['phase']) && syntheticCount(value['sampleOrdinal'], 2)
      && value['phase'] === ['original-sample', 'post-result-sample', 'delivery-witness'][value['sampleOrdinal'] as number]
      && ['downCount', 'upCount', 'wheelCount'].every(key => value[key] === null || syntheticCount(value[key], 8))
      && (value['expectedDeltaSeen'] === null || typeof value['expectedDeltaSeen'] === 'boolean') && typeof value['nativePublicResultObserved'] === 'boolean' && value['cdpAckObserved'] === null;
    case 'frame-hit': return caseId === 'C02' && syntheticKeys(value, ['kind', 'phase', 'available', 'leafHitInput', 'leafHitButton', 'ancestorHitOwner', 'clickSeen', 'nativePointProven', 'nativeDispatchCount'])
      && member(['pre-tap', 'post-tap'], value['phase']) && typeof value['available'] === 'boolean'
      && ['leafHitInput', 'leafHitButton', 'ancestorHitOwner', 'clickSeen'].every(key => value[key] === null || typeof value[key] === 'boolean') && value['nativePointProven'] === false && value['nativeDispatchCount'] === null;
    default: return false;
  }
}
export function validSyntheticOutcome(value: unknown): value is SyntheticOutcome {
  return syntheticObject(value) && syntheticKeys(value, ['setup', 'body', 'cleanup'])
    && Object.values(value).every(item => member(['not-started', 'passed', 'failed', 'incomplete'], item));
}
/** The same closed wire schema is enforced before append and again before artifact publication. */
export function validSyntheticSavedRecord(value: unknown, caseId: SyntheticCaseId): value is SyntheticSavedRecord {
  if (!syntheticObject(value)) return false;
  if (value['kind'] === 'header') return syntheticKeys(value, ['kind', 'schemaVersion', 'binding', 'caseId', 'sourceSha256'])
    && value['schemaVersion'] === 1 && value['caseId'] === caseId && validSyntheticBinding(value['binding'])
    && value['binding'].suite === SYNTHETIC_CASE_MANIFEST[caseId].suite && syntheticDigest(value['sourceSha256']);
  if (value['kind'] === 'record') return syntheticKeys(value, ['kind', 'sequence', 'fact']) && syntheticCount(value['sequence'], 255) && validSyntheticFact(value['fact'], caseId);
  return value['kind'] === 'footer' && syntheticKeys(value, ['kind', 'sequence', 'dropped', 'truncated', 'incomplete', 'outcome'])
    && syntheticCount(value['sequence'], 255) && syntheticCount(value['dropped']) && booleans(value, ['truncated', 'incomplete']) && validSyntheticOutcome(value['outcome']);
}
/** Reject noncanonical/symlink directories and platforms without no-follow support. */
export function requireSyntheticDirectory(directory: string): void {
  if (!constants.O_NOFOLLOW || !isAbsolute(directory) || realpathSync(directory) !== directory) throw new Error('Unavailable synthetic directory');
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new Error('Unavailable synthetic directory');
}
/** Size is checked before allocation and after reading; only private single-link regular files are accepted. */
export function readSyntheticFile(file: string, maxBytes: number): Buffer {
  if (!constants.O_NOFOLLOW) throw new Error('Unavailable no-follow support');
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size > maxBytes) throw new Error('Unavailable synthetic file');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new Error('Changing synthetic file');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) { const read = readSync(fd, bytes, size, bytes.length - size, null); if (!read) break; size += read; }
    const after = fstatSync(fd);
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Changing synthetic file');
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}
/** Only closed own error codes survive; no message, stack, URL, payload or getter is read. */
export function callbackFailureFact(stageOrdinal: number, error: unknown): SyntheticFact {
  const own = (value: unknown, key: string): unknown => {
    if (value === null || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  };
  const code = (value: unknown): typeof SYNTHETIC_PUBLIC_CODES[number] => {
    const candidate = own(value, 'code');
    return (SYNTHETIC_PUBLIC_CODES as readonly unknown[]).includes(candidate) ? candidate as typeof SYNTHETIC_PUBLIC_CODES[number] : 'other';
  };
  const cause = own(error, 'cause');
  return { kind: 'callback-failure', stageOrdinal, code: code(error), causeCode: cause === undefined ? null : code(cause) };
}
export interface SyntheticEvidence {
  readonly available: boolean;
  record(fact: SyntheticFact): void;
  /** True only when this exact fact was appended; failed attempts never claim first-slot ownership. */
  tryRecord(fact: SyntheticFact): boolean;
  observe(observer: () => SyntheticFact): void;
  finish(outcome: SyntheticOutcome): void;
  invalidate(): void;
}
const disabled = (): SyntheticEvidence => ({ available: false, record() {}, tryRecord() { return false; }, observe() {}, finish() {}, invalidate() {} });
function snapshotFact(value: unknown, depth = 0, retention = false): unknown {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if ((depth > 1 && !(depth === 2 && retention)) || !syntheticObject(value)) throw new Error('Invalid synthetic fact');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length > 16) throw new Error('Invalid synthetic fact');
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key]!;
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('Invalid synthetic fact');
    snapshot[key] = snapshotFact(descriptor.value, depth + 1, depth === 1 && key === 'retention');
  }
  return snapshot;
}

/** No business callback is wrapped. Diagnostic errors cannot replace, swallow or retry a test operation. */
export function beginSyntheticCase(caseId: SyntheticCaseId, env: NodeJS.ProcessEnv = process.env): SyntheticEvidence {
  let fd: number | undefined;
  try {
    if (env[SYNTHETIC_BATCH_ENV] !== '1' || !syntheticCase(caseId)) return disabled();
    const directory = env[SYNTHETIC_DIRECTORY_ENV]; const encoded = env[SYNTHETIC_BINDING_ENV];
    if (!directory || !encoded || encoded.length > SYNTHETIC_RECORD_BYTES) return disabled();
    requireSyntheticDirectory(directory);
    const binding: unknown = JSON.parse(encoded);
    const config: unknown = JSON.parse(readSyntheticFile(join(directory, SYNTHETIC_BINDING_FILE), 16 * 1024).toString('utf8'));
    if (!validSyntheticBinding(binding) || !validSyntheticConfiguration(config) || JSON.stringify(config.binding) !== JSON.stringify(binding)) return disabled();
    const entry = config.cases.find(item => item.caseId === caseId);
    if (!entry) return disabled();
    const path = join(directory, `${caseId}.jsonl`);
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); }
    catch {
      // One fixed, empty atomic conflict marker makes duplicate ownership visible without touching the existing sink.
      try { const conflict = openSync(join(directory, `${caseId}.conflict`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); closeSync(conflict); } catch { /* Existing marker already makes the directory incomplete. */ }
      return disabled();
    }
    const stat = fstatSync(fd); const pathStat = lstatSync(path); requireSyntheticDirectory(directory);
    if (!stat.isFile() || stat.size !== 0 || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || pathStat.ino !== stat.ino || pathStat.dev !== stat.dev) throw new Error('Unavailable synthetic owner');
    const handle = fd; const budget = SYNTHETIC_CASE_MANIFEST[caseId];
    let sequence = 0; let bytes = 0; let dropped = 0; let truncated = false; let incomplete = false; let closed = false; let writeFailed = false;
    const slots = new Set<string>();
    const append = (value: SyntheticSavedRecord): boolean => {
      if (closed || writeFailed) return false;
      try {
        if (!validSyntheticSavedRecord(value, caseId)) return false;
        const line = Buffer.from(`${JSON.stringify(value)}\n`);
        if (line.length > SYNTHETIC_RECORD_BYTES || bytes + line.length > budget.maxBytes) return false;
        if (writeSync(handle, line) !== line.length) { writeFailed = true; return false; }
        bytes += line.length; return true;
      } catch { writeFailed = true; return false; }
    };
    const header: SyntheticSavedRecord = { kind: 'header', schemaVersion: 1, binding: config.binding, caseId, sourceSha256: entry.sourceSha256 };
    if (!append(header)) { closeSync(handle); return disabled(); }
    const drop = (): void => { if (dropped === 65_535) truncated = true; else dropped++; incomplete = true; };
    const observe = (observer: () => SyntheticFact): boolean => {
      if (closed) return false;
      try {
        if (writeFailed || sequence >= budget.maxRecords - 2 || bytes + 2 * SYNTHETIC_RECORD_BYTES > budget.maxBytes) { truncated = true; drop(); return false; }
        const fact = snapshotFact(observer());
        if (!validSyntheticFact(fact, caseId)) { drop(); return false; }
        let slot: string | undefined;
        if (fact.kind === 'native-result' || fact.kind === 'request-rejected-without-result') {
          slot = fact.kind === 'native-result' ? fact.slot : fact.kind;
          if (slots.has(slot)) { drop(); return false; }
        }
        // Rebuild the already validated plain data; user getters/toJSON never reach serialization.
        const saved: SyntheticSavedRecord = { kind: 'record', sequence, fact };
        if (!append(saved)) { drop(); return false; }
        if (slot !== undefined) slots.add(slot);
        sequence++;
        if (('truncated' in fact && fact.truncated) || ('unavailable' in fact && fact.unavailable)) incomplete = true;
        return true;
      } catch { drop(); return false; }
    };
    return {
      available: true,
      record(fact) { observe(() => fact); },
      tryRecord(fact) { return observe(() => fact); }, observe,
      invalidate() { if (!closed) incomplete = true; },
      finish(outcome) {
        if (closed) return;
        try {
          const snapshot = snapshotFact(outcome);
          if (!validSyntheticOutcome(snapshot)) { drop(); outcome = { setup: 'incomplete', body: 'incomplete', cleanup: 'incomplete' }; }
          else outcome = snapshot;
          incomplete ||= Object.values(outcome).includes('incomplete') || (caseId === 'nested-setup' ? outcome.setup : outcome.body) === 'not-started';
          append({ kind: 'footer', sequence, dropped, truncated, incomplete: incomplete || writeFailed, outcome });
        } catch { /* Missing footer is explicitly incomplete at collection. */ }
        finally { closed = true; try { closeSync(handle); } catch { /* Never replace the original test outcome. */ } }
      },
    };
  } catch { if (fd !== undefined) { try { closeSync(fd); } catch { /* No functional consequence. */ } } return disabled(); }
}
