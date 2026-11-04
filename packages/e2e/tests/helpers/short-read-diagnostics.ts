/** Opt-in only around the original synthetic short-read integration workloads. */
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { RunEventSink } from '../../src/run/events.ts';

// Closed native protocol values, not arbitrary error messages or user page text.
const code = z.enum([
  'frame-not-found', 'frame-ambiguous', 'invalid-frame', 'unsupported-protocol', 'unsupported-capability', 'stale-generation', 'scope-unavailable',
  'sequence-reused', 'invalid-sequence', 'invalid-timeout', 'capacity-exceeded', 'operation-missing',
  'content-length-mismatch', 'redirect-body-unavailable', 'unsupported-command', 'deadline-exceeded', 'cancelled', 'invalid-arguments', 'invalid-locator', 'browser-failure', 'stale-scope', 'cleanup-failed', 'stale-reference', 'policy-denied', 'not-actionable', 'intercepted-pointer', 'checked-state-unchanged', 'checked-control-replaced', 'fill-unsupported-target', 'no-editable-focus', 'tap-target-replaced-before-press', 'locator-not-found', 'decision-missing', 'decision-expired', 'decision-kind-mismatch', 'registry-missing', 'registry-in-use', 'identifier-exhausted',
]);
const recordSchema = z.object({
  phase: z.enum(['settled-failure', 'capture-limit-reached']),
  suite: z.enum(['transformed-secrets', 'web-platform', 'replaced-nodes']),
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  operationSeq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  command: z.enum(['fixture.read-fields', 'fixture.query', 'browser.query']),
  transmittedTimeoutMs: z.number().int().min(1).max(3_600_000),
  selectedLocalCancel: z.enum(['none', 'abort', 'deadline']),
  rawCode: code, rawEffects: z.enum(['not-dispatched', 'completed', 'unknown']), rawScopeState: z.enum(['usable', 'quarantined', 'closed']),
  returnedCode: code, timeoutRewritten: z.boolean(), cancelAckSeen: z.boolean(),
  limit: z.literal(8).optional(), laterFailuresOmitted: z.literal(true).optional(),
}).strict();
const PREFIX = 'QUERY_READ_RESULT_DIAGNOSTIC ';
const CLASS_PREFIX = 'CLASS_SAMPLE_DIAGNOSTIC ';
const milliseconds = z.number().int().min(0).max(3_600_000);
const classSampleSchema = z.object({
  schemaVersion: z.literal(1), fixture: z.literal('web-platform-class300'), api: z.literal('toHaveClass'),
  invocationOrdinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  outcome: z.enum(['passed', 'threw']), sampleCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), overflow: z.boolean(),
  samples: z.array(z.object({
    ordinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), priorSample: z.boolean(), priorMismatch: z.boolean(),
    startRemainingMs: milliseconds, endRemainingMs: milliseconds, elapsedMs: milliseconds,
    outcome: z.enum(['match', 'mismatch', 'unevaluable', 'threw']),
  }).strict()).max(16),
}).strict();

/** Receives worker output even when quiet=true; emits only validated closed rows after run settles. */
export async function withShortReadDiagnostics<T>(suite: 'transformed-secrets' | 'web-platform' | 'replaced-nodes', run: (onEvent: RunEventSink | undefined) => Promise<T>, capture?: (closedRows: string, captureNonce?: string) => void): Promise<T> {
  if (process.env[suite === 'replaced-nodes' ? 'E2E_REPLACED_FIELD_CAPTURE' : 'E2E_SHORT_READ_DIAGNOSTIC'] !== '1') return run(undefined);
  // Bind direct inline stderr to this fresh fixture invocation without replacing
  // stderr or retroactively importing an unrelated outer log into its archive.
  let captureNonce: string | undefined;
  if (suite === 'replaced-nodes' && capture !== undefined) {
    try { captureNonce = randomBytes(32).toString('hex'); } catch { /* Missing nonce fails capture, not the workload. */ }
  }
  const boundary = () => JSON.stringify({ schemaVersion: 1, suite, captureNonce });
  const previous = process.env['E2E_QUERY_READ_DIAGNOSTIC'];
  process.env['E2E_QUERY_READ_DIAGNOSTIC'] = suite;
  const records: z.infer<typeof recordSchema>[] = [];
  const classRecords: z.infer<typeof classSampleSchema>[] = [];
  let tail = ''; let skipping = false; let invalidRecords = 0; let lineOverflow = false; let recordOverflow = false;
  const accept = (line: string) => {
    if (suite === 'web-platform' && line.startsWith(CLASS_PREFIX)) {
      try {
        const row = classSampleSchema.safeParse(JSON.parse(line.slice(CLASS_PREFIX.length)));
        if (!row.success) { invalidRecords = Math.min(65, invalidRecords + 1); return; }
        if (classRecords.length < 16) classRecords.push(row.data);
        else { classRecords[15] = row.data; recordOverflow = true; }
      } catch { invalidRecords = Math.min(65, invalidRecords + 1); }
      return;
    }
    if (!line.startsWith(PREFIX)) return;
    try {
      const parsed = recordSchema.safeParse(JSON.parse(line.slice(PREFIX.length)));
      if (!parsed.success || parsed.data.suite !== suite
        || (suite === 'replaced-nodes' ? parsed.data.generation === undefined || parsed.data.operationSeq === undefined : parsed.data.generation !== undefined || parsed.data.operationSeq !== undefined)
        || (parsed.data.phase === 'capture-limit-reached') !== (parsed.data.limit === 8 && parsed.data.laterFailuresOmitted === true)
        || (parsed.data.phase === 'settled-failure' && (parsed.data.limit !== undefined || parsed.data.laterFailuresOmitted !== undefined))) {
        invalidRecords = Math.min(65, invalidRecords + 1); return;
      }
      // Keep the first 63 and the latest closed row; overflow never silently loses the last failure.
      if (records.length === 64) { records[63] = parsed.data; recordOverflow = true; }
      else records.push(parsed.data);
    } catch { invalidRecords = Math.min(65, invalidRecords + 1); }
  };
  const onEvent: RunEventSink = event => {
    if (event.type !== 'output' || event.stream !== 'stderr') return;
    // Original worker fixture has one worker/target. Never buffer unbounded raw stderr.
    for (const char of event.text) {
      if (char === '\n') { if (!skipping) accept(tail); tail = ''; skipping = false; }
      else if (!skipping) {
        if (tail.length === (tail.startsWith(CLASS_PREFIX) ? 8192 : 2048)) { tail = ''; skipping = true; lineOverflow = true; }
        else tail += char;
      }
    }
  };
  if (captureNonce !== undefined) {
    try { process.stderr.write(`QUERY_READ_DIAGNOSTIC_BEGIN ${boundary()}\n`); } catch { /* Missing boundary fails capture only. */ }
  }
  try { return await run(onEvent); }
  finally {
    if (previous === undefined) delete process.env['E2E_QUERY_READ_DIAGNOSTIC'];
    else process.env['E2E_QUERY_READ_DIAGNOSTIC'] = previous;
    // Inline rows are already in the bounded BEGIN/END region of the current
    // outer log. Worker rows are forwarded here exactly once before END.
    try {
      if (!skipping && tail !== '') accept(tail);
      const rows = [...records.map(record => `${PREFIX}${JSON.stringify(record)}\n`), ...classRecords.map(record => `${CLASS_PREFIX}${JSON.stringify(record)}\n`)];
      const custody = `QUERY_READ_DIAGNOSTIC_CUSTODY ${JSON.stringify({ suite, workerRecords: records.length, invalidRecords, lineOverflow, recordOverflow })}\n`;
      // Archive the same bounded closed worker facts, never raw stderr. A failed
      // archive callback cannot replace business outcomes or suppress forwarding.
      try { capture?.(rows.join('') + custody, captureNonce); } catch { /* Missing archive fails acceptance. */ }
      for (const row of rows) process.stderr.write(row);
      process.stderr.write(custody);
    } catch { /* Custody output must not replace the original outcome or cleanup failure. */ }
    finally {
      if (captureNonce !== undefined) {
        try { process.stderr.write(`QUERY_READ_DIAGNOSTIC_END ${boundary()}\n`); } catch { /* Missing END remains incomplete evidence. */ }
      }
    }
  }
}
