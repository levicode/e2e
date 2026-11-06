/**
 * Opt-in, bounded ledger of validated native results.
 *
 * `E2E_NATIVE_RESULT_LEDGER` names an absolute file the caller owns (a
 * verification harness keeps it outside the project). Every validated native
 * result appends one JSON line holding only closed protocol facts: the command,
 * its operation sequence and transmitted budget, the settlement enums, the
 * error code, and the retention counters. Arguments, result data, page content,
 * node IDs, URLs, and error messages are never written — the ledger answers
 * which native operation failed, how it settled, and what the browser retained,
 * which no public report carries. A relative or unusable path, the per-file
 * entry cap, or a write failure disables that file; it can never change an
 * operation's result.
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import type { NativeResult } from './protocol.ts';

export const NATIVE_RESULT_LEDGER_ENV = 'E2E_NATIVE_RESULT_LEDGER';

/** One file takes at most this many result lines, then one truncation line. */
const MAX_ENTRIES = 4096;

interface LedgerFile {
  entries: number;
  disabled: boolean;
}

interface LedgerEntry {
  readonly schemaVersion: 1;
  readonly at: string;
  readonly command: string;
  readonly operationSeq: number;
  readonly timeoutMs: number;
  readonly ok: boolean;
  readonly effects: NativeResult['effects'];
  readonly scopeState: NativeResult['scopeState'];
  readonly code?: string;
  readonly retention?: {
    readonly retiredOperationSeq: number;
    readonly producerState: 'retired' | 'retiring';
    readonly inputDebt: number;
    readonly objectDebt: number;
  };
}

const files = new Map<string, LedgerFile>();

/** Appends one settled native result; a no-op unless the environment names a usable file. */
export function recordNativeResult(command: string, operationSeq: number, timeoutMs: number, result: NativeResult): void {
  const file = process.env[NATIVE_RESULT_LEDGER_ENV];
  if (file === undefined || file === '' || !path.isAbsolute(file)) return;
  const state = files.get(file) ?? { entries: 0, disabled: false };
  files.set(file, state);
  if (state.disabled) return;
  try {
    if (state.entries >= MAX_ENTRIES) {
      state.disabled = true;
      appendFileSync(file, `${JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), kind: 'truncated', limit: MAX_ENTRIES })}\n`);
      return;
    }
    state.entries += 1;
    appendFileSync(file, `${JSON.stringify(entry(command, operationSeq, timeoutMs, result))}\n`);
  } catch {
    state.disabled = true;
  }
}

function entry(command: string, operationSeq: number, timeoutMs: number, result: NativeResult): LedgerEntry {
  const retention = result.retention;
  return {
    schemaVersion: 1,
    at: new Date().toISOString(),
    command: command.slice(0, 64),
    operationSeq,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(0, Math.round(timeoutMs)) : 0,
    ok: result.ok,
    effects: result.effects,
    scopeState: result.scopeState,
    ...(result.error?.code === undefined ? {} : { code: result.error.code.slice(0, 128) }),
    ...(retention === undefined ? {} : {
      retention: {
        retiredOperationSeq: retention.retiredOperationSeq,
        producerState: retention.producerState,
        inputDebt: retention.inputDebt,
        objectDebt: retention.objectDebt,
      },
    }),
  };
}
