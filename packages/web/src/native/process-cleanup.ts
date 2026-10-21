import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EngineError } from 'e2e/engine';

const unresolved = new WeakMap<EngineError, ChildProcessWithoutNullStreams>();
/** Retain exact failed-start ownership; no automatic process substitution or retry. */
export function retainUnresolvedProcess(failure: EngineError, child: ChildProcessWithoutNullStreams): void { unresolved.set(failure, child); }
/** Internal evidence, never inferred from a public error message or model argument. */
export function isNativeProcessCleanupUnresolved(cause: unknown): boolean { return cause instanceof EngineError && unresolved.has(cause); }
