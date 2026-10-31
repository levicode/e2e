import { prepareEngineSecretsNativeCustody } from './engine-secrets-native-custody.ts';
/** Closed, opt-in evidence for the unchanged two-worker synthetic secret suite. */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { RunEventSink } from '../../src/run/events.ts';

const PREFIX = 'ENGINE_SECRETS_DIAGNOSTIC ';
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const base = { v: z.literal(1), captureNonce: hex, workerToken: hex, surface: integer, attempt: integer };
const state = z.enum(['undefined', 'null', 'value']);
const nativeCode = z.enum(['frame-not-found', 'frame-ambiguous', 'invalid-frame', 'unsupported-protocol', 'unsupported-capability', 'stale-generation', 'scope-unavailable', 'sequence-reused', 'invalid-sequence', 'invalid-timeout', 'capacity-exceeded', 'operation-missing', 'content-length-mismatch', 'redirect-body-unavailable', 'unsupported-command', 'deadline-exceeded', 'cancelled', 'invalid-arguments', 'invalid-locator', 'browser-failure', 'stale-scope', 'cleanup-failed', 'stale-reference', 'policy-denied', 'not-actionable', 'intercepted-pointer', 'checked-state-unchanged', 'checked-control-replaced', 'fill-unsupported-target', 'no-editable-focus', 'tap-target-replaced-before-press', 'locator-not-found', 'decision-missing', 'decision-expired', 'decision-kind-mismatch', 'registry-missing', 'registry-in-use', 'identifier-exhausted', 'unknown']);
const runtimeRow = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('start') }).strict(),
  z.object({ ...base, kind: z.literal('process-binding'), client: integer, proxyPid: integer }).strict(),
  z.object({ ...base, kind: z.literal('close'), client: integer, stage: z.enum(['preconditions', 'decision-receipts', 'close-exchange', 'channel-settle', 'post-settle', 'existing-client-failure', 'reuse-existing-close']), outcome: z.enum(['observed', 'completed', 'failed']), closedFrameConfirmed: z.boolean(), code: z.literal('unknown'), origin: z.literal('unjoined') }).strict(),
  z.object({ ...base, kind: z.literal('guard'), workerRetired: z.boolean(), workerCleanupUnconfirmed: z.boolean(), retirementFailurePresent: z.boolean(), attemptPresent: z.boolean(), retiringAttemptPresent: z.boolean(), connectingPresent: z.boolean() }).strict(),
  z.object({ ...base, kind: z.literal('admission'), stage: z.enum(['callback-check', 'require-attempt', 'owner-check', 'pending-latch', 'caller-aborted', 'download-readiness', 'ensure-connected', 'final-owner-check']), origin: z.literal('unjoined'), wire: z.literal('absent') }).strict(),
  z.object({ ...base, kind: z.literal('query'), client: integer, generation: integer, operationSeq: integer, command: z.enum(['fixture.read-fields', 'fixture.query', 'browser.query']), transmittedTimeoutMs: z.number().int().min(1).max(3_600_000), selectedLocalCancel: z.enum(['none', 'abort', 'deadline']), rawCode: nativeCode, rawEffects: z.enum(['not-dispatched', 'completed', 'unknown']), rawScopeState: z.enum(['usable', 'quarantined', 'closed', 'unknown']), returnedCode: nativeCode, timeoutRewritten: z.boolean(), cancelAckSeen: z.boolean() }).strict(),
  z.object({ ...base, kind: z.literal('retirement'), stage: z.enum(['download-file', 'retire-attempt', 'finalized-video', 'recording-stop', 'late-recording-stop', 'connection-cleanup', 'native-video-retire', 'interop-retire', 'playwright-close', 'scope-end', 'native-close', 'provider-release', 'publication', 'worker-release', 'worker-acquisition-cleanup', 'native-resource-cleanup', 'unknown']), before: state, after: state }).strict(),
  z.object({ ...base, kind: z.literal('cleanup'), nativeRetired: z.boolean(), finalizedCleanupProven: z.boolean(), recordingsRetired: z.boolean(), released: z.boolean(), connectingCleanupFailurePresent: z.boolean(), retiringAttemptCleared: z.boolean(), reason: z.enum(['receipt-failed', 'local-wait-departure', 'unresolved-custody', 'complete', 'unknown']), dirty: z.literal('unknown') }).strict(),
  z.object({ ...base, kind: z.literal('overflow'), limit: z.literal(8) }).strict(),
]);
const lossRow = z.object({ v: z.literal(1), captureNonce: hex, workerToken: hex, kind: z.literal('capture-loss'), reason: z.enum(['surface-cap', 'attempt-cap', 'client-cap', 'row-cap', 'owner-unjoined']) }).strict();
type RuntimeRow = z.infer<typeof runtimeRow>;
type Pair = { target: string; testId: string; agent: string; repeat: number };
type Binding = { pair: Pair; workerOrdinal: number; surface: number; attempt: number; terminal: boolean };
type Tail = { text: string; skipping: boolean; pair: Pair };
const TITLES = [
  'signs in through basic auth',
  'fails on the echoed password',
  'fails on the echoed Authorization header',
  'downloads the echoed headers',
  'takes a screenshot of the page, an engine-held secret tainting no pixels',
] as const;
const STATUS = ['passed', 'failed', 'timed-out', 'interrupted', 'skipped'] as const;
const PHASE = ['config', 'collection', 'filter', 'launch', 'beforeAll', 'beforeEach', 'body', 'afterEach', 'afterAll', 'cleanup', 'report'] as const;
const ERROR = ['ACTION_MAY_HAVE_COMMITTED', 'APP_NOT_OPEN', 'ASSERTION_FAILED', 'EXPECTATION_FAILED', 'OPERATION_TIMEOUT', 'CANCELLED', 'LAUNCH_TIMEOUT', 'CLEANUP_TIMEOUT', 'INVALID_STATE'] as const;
const CLEANUP = ['complete', 'failed', 'forced'] as const;
const object = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const closed = (value: unknown, choices: readonly string[]): string => value === undefined ? 'not-present' : typeof value === 'string' && choices.includes(value) ? value : 'unknown';
const pairKey = (pair: Pair): string => JSON.stringify([pair.target, pair.testId, pair.agent, pair.repeat]);
const errorProjection = (value: unknown) => { const error = object(value); return { phase: closed(error?.['phase'], PHASE), errorCode: closed(error?.['code'], ERROR) }; };

/** A bounded collector; no rejected text or opaque identity is returned by finish. */
export function createEngineSecretsCapture(captureNonce: string) {
  const workers = new Map<string, number>();
  const surfaces = new Set<string>();
  const bindings = new Map<string, Binding>();
  const pairWorkers = new Map<string, number>();
  const tails = new Map<string, Tail>();
  const retired = new Set<string>();
  const clientFailures = new Map<string, number>();
  const records: { row: RuntimeRow; binding: Binding }[] = [];
  const losses: Record<string, unknown>[] = [];
  let invalid = 0; let overflow = false; let finished = false;
  const bad = () => { invalid = Math.min(65, invalid + 1); };
  if (!hex.safeParse(captureNonce).success) bad();
  const accept = (line: string, pair: Pair | undefined) => {
    if (line.startsWith('NATIVE_DIAGNOSTIC_CAPTURE_CONFLICT ')) { bad(); return; }
    if (!line.startsWith(PREFIX)) return;
    if (line.length > 2048) { overflow = true; return; }
    let row: RuntimeRow;
    try {
      const value: unknown = JSON.parse(line.slice(PREFIX.length));
      const lost = lossRow.safeParse(value);
      if (lost.success) {
        if (lost.data.captureNonce !== captureNonce) { bad(); return; }
        overflow = true;
        if (losses.length < 5 && !losses.some(loss => loss['reason'] === lost.data.reason)) {
          const workerOrdinal = workers.get(lost.data.workerToken);
          losses.push({ v: 1, kind: 'capture-loss', reason: lost.data.reason, ...(workerOrdinal === undefined ? { worker: 'unjoined' } : { workerOrdinal }) });
        }
        return;
      }
      const parsed = runtimeRow.safeParse(value); if (!parsed.success || parsed.data.captureNonce !== captureNonce) { bad(); return; } row = parsed.data;
    } catch { bad(); return; }
    let workerOrdinal = workers.get(row.workerToken);
    const surfaceKey = `${row.workerToken}:${row.surface}`;
    const ownerKey = `${surfaceKey}:${row.attempt}`;
    let binding = bindings.get(ownerKey);
    if (row.kind === 'start') {
      if (pair === undefined || binding !== undefined) { bad(); return; }
      const pk = pairKey(pair);
      if (pairWorkers.has(pk)) { bad(); return; }
      if ((workerOrdinal === undefined && workers.size === 8) || (!surfaces.has(surfaceKey) && surfaces.size === 16) || bindings.size === 16) { overflow = true; return; }
      workerOrdinal ??= workers.size + 1;
      workers.set(row.workerToken, workerOrdinal); surfaces.add(surfaceKey); pairWorkers.set(pk, workerOrdinal);
      binding = { pair, workerOrdinal, surface: row.surface, attempt: row.attempt, terminal: false }; bindings.set(ownerKey, binding);
    }
    if (binding === undefined || workerOrdinal === undefined) { bad(); return; }
    if (row.kind === 'query') {
      const clientKey = `${row.workerToken}:${row.surface}:${row.client}`;
      if (!clientFailures.has(clientKey) && clientFailures.size === 16) { overflow = true; return; }
      const count = (clientFailures.get(clientKey) ?? 0) + 1;
      clientFailures.set(clientKey, Math.min(9, count)); if (count > 8) overflow = true;
    }
    if (row.kind === 'guard') {
      if (row.retirementFailurePresent && !retired.has(surfaceKey)) bad();
      if (row.workerRetired || row.workerCleanupUnconfirmed || row.retirementFailurePresent || row.attemptPresent || row.retiringAttemptPresent || row.connectingPresent) binding.terminal = true;
    }
    if (row.kind === 'retirement' && row.after !== 'undefined') retired.add(surfaceKey);
    if (row.kind === 'cleanup') binding.terminal = true;
    if (row.kind === 'overflow') overflow = true;
    if (records.length === 64) { records[63] = { row, binding }; overflow = true; } else records.push({ row, binding });
  };
  const onEvent: RunEventSink = event => {
    try {
      if (finished || event.type !== 'output' || event.stream !== 'stderr') return;
      const pair = event.pair === undefined ? undefined : { target: event.target, ...event.pair };
      if (pair === undefined) {
        // Never concatenate unattributed chunks from different worker processes.
        let line = ''; let skipping = false;
        for (const char of event.text) {
          if (char === '\n') { if (!skipping) accept(line, undefined); line = ''; skipping = false; }
          else if (!skipping) { if (line.length === 2048) { line = ''; skipping = true; overflow = true; } else line += char; }
        }
        if (line !== '' || skipping) bad();
        return;
      }
      if ([pair.target, pair.testId, pair.agent].some(value => typeof value !== 'string' || value.length > 1024) || pair.repeat !== 0) { bad(); return; }
      const key = pairKey(pair);
      let tail = tails.get(key);
      if (tail === undefined) { if (tails.size === 8) { overflow = true; return; } tail = { text: '', skipping: false, pair }; tails.set(key, tail); }
      for (const char of event.text) {
        if (char === '\n') { if (!tail.skipping) accept(tail.text, tail.pair); tail.text = ''; tail.skipping = false; }
        else if (!tail.skipping) {
          if (tail.text.length === 2048 || [...tails.values()].reduce((sum, entry) => sum + entry.text.length, 0) === 8192) { tail.text = ''; tail.skipping = true; overflow = true; }
          else tail.text += char;
        }
      }
      if (tail.text === '' && !tail.skipping) tails.delete(key);
    } catch { bad(); }
  };
  const finish = (report: unknown) => {
    finished = true;
    if ([...tails.values()].some(tail => tail.text !== '' || tail.skipping)) bad();
    let projectionValid = true;
    const cases: Record<string, unknown>[] = [];
    const caseByPair = new Map<string, number>();
    try {
      const run = object(object(report)?.['run']);
      const results = run?.['results']; const targets = run?.['targets'];
      if (!Array.isArray(results) || results.length !== 5 || !Array.isArray(targets) || targets.length !== 1) throw new Error('invalid');
      const targetId = object(targets[0])?.['id']; if (targetId !== 'web') throw new Error('invalid');
      const seen = new Set<number>(); let agent: string | undefined;
      for (const value of results) {
        const result = object(value); const titles = result?.['titlePath']; const declaration = result?.['declarationIndex'];
        if (result === undefined || !Array.isArray(titles) || titles.length !== 1 || typeof declaration !== 'number' || !Number.isInteger(declaration) || declaration < 0 || declaration >= 5 || titles[0] !== TITLES[declaration] || seen.has(declaration) || result['file'] !== 'tests/basic-auth.e2e.ts' || result['targetId'] !== targetId || result['repeat'] !== 0 || result['selected'] !== true || result['kind'] !== 'test' || typeof result['testId'] !== 'string' || typeof result['agent'] !== 'string') throw new Error('invalid');
        if (agent !== undefined && agent !== result['agent']) throw new Error('invalid'); agent = result['agent']; seen.add(declaration);
        if (typeof result['status'] !== 'string' || !STATUS.includes(result['status'] as typeof STATUS[number])) throw new Error('invalid');
        const attempts = result['attempts']; if (!Array.isArray(attempts) || attempts.length > 1 || (attempts.length === 0 && result['status'] !== 'skipped')) throw new Error('invalid');
        const attempt = object(attempts[0]); if (attempts.length === 1 && (attempt === undefined || attempt['index'] !== 0)) throw new Error('invalid');
        if (attempt !== undefined && (typeof attempt['status'] !== 'string' || !STATUS.includes(attempt['status'] as typeof STATUS[number]) || typeof attempt['cleanup'] !== 'string' || !CLEANUP.includes(attempt['cleanup'] as typeof CLEANUP[number]))) throw new Error('invalid');
        const secondary = attempt?.['secondaryErrors']; if (attempt !== undefined && !Array.isArray(secondary)) throw new Error('invalid');
        const errors = Array.isArray(secondary) ? secondary : [];
        if (errors.length > 8) overflow = true;
        const ordinal = declaration + 1;
        const identity = pairKey({ target: targetId, testId: result['testId'], agent: result['agent'], repeat: 0 });
        if (caseByPair.has(identity)) throw new Error('invalid');
        caseByPair.set(identity, ordinal);
        cases.push({ v: 1, kind: 'case', caseOrdinal: ordinal, status: closed(result['status'], STATUS), attemptCount: attempts.length, attemptStatus: closed(attempt?.['status'], STATUS), ...errorProjection(attempt?.['error']), cleanup: closed(attempt?.['cleanup'], CLEANUP), secondaryErrorCount: errors.length, secondaryErrors: errors.slice(0, 8).map(errorProjection) });
      }
      const runErrors = run?.['errors']; if (!Array.isArray(runErrors)) throw new Error('invalid');
      if (runErrors.length > 8) overflow = true;
      cases.sort((a, b) => Number(a['caseOrdinal']) - Number(b['caseOrdinal']));
      Object.assign(cases[0]!, { runErrorCount: runErrors.length, runErrors: runErrors.slice(0, 8).map(errorProjection) });
    } catch { projectionValid = false; cases.length = 0; caseByPair.clear(); }
    const output: Record<string, unknown>[] = [];
    const append = (row: Record<string, unknown>) => {
      if (JSON.stringify(row).length + PREFIX.length > 2048) { overflow = true; return; }
      if (output.length === 64) { output[63] = row; overflow = true; } else output.push(row);
    };
    for (const { row, binding } of records) {
      const caseOrdinal = caseByPair.get(pairKey(binding.pair));
      if (caseOrdinal === undefined) { bad(); continue; }
      const { workerToken: _workerToken, captureNonce: _captureNonce, ...safe } = row;
      append({ ...safe, workerOrdinal: binding.workerOrdinal, caseOrdinal });
    }
    for (const row of losses) append(row);
    for (const row of cases) append(row);
    for (const binding of bindings.values()) if (!binding.terminal) bad();
    for (const row of cases) {
      if (row['attemptCount'] === 1 && ![...bindings.values()].some(binding => caseByPair.get(pairKey(binding.pair)) === row['caseOrdinal'])) bad();
      if (row['errorCode'] === 'ACTION_MAY_HAVE_COMMITTED' && !output.some(record => record['caseOrdinal'] === row['caseOrdinal'] && (record['kind'] === 'admission' || record['kind'] === 'query'))) bad();
      if ((row['cleanup'] === 'failed' || row['cleanup'] === 'forced') && !output.some(record => record['caseOrdinal'] === row['caseOrdinal'] && record['kind'] === 'retirement') && losses.length === 0) bad();
      if (typeof row['runErrorCount'] === 'number' && row['runErrorCount'] > 0 && !output.some(record => record['kind'] === 'retirement') && losses.length === 0) bad();
    }
    const projectionRows = output.filter(row => row['kind'] === 'case').length;
    return { rows: output, custody: { schemaVersion: 1, suite: 'engine-secrets', baseConsumer: 'ad67f6c766c093800a04315ae5f05feb148cf28c', projection: projectionValid && projectionRows === 5 ? 'complete' : 'incomplete', lifecycle: projectionValid && invalid === 0 && !overflow ? 'observed' : 'incomplete', coverage: 'observed-only', exhaustive: false, noAbsenceInference: true, invalidRecords: invalid, overflow, rows: output.length, workerBindings: workers.size, surfaceBindings: surfaces.size, attemptBindings: bindings.size, nativeOrigin: 'unknown' } };
  };
  return { onEvent, finish };
}

/** Closed identity comes from the actual consumer process, never the base source constant. */
function matchesNodeSelector(selector: string | undefined, nodeVersion: string): boolean {
  if (selector === undefined) return false;
  const requested = /^(22|24|26)(?:\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2}))?$/.exec(selector);
  const actual = /^v(22|24|26)\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(nodeVersion);
  return requested !== null && requested[0] === selector && actual !== null && actual[0] === nodeVersion
    && (requested[2] === undefined ? requested[1] === actual[1] : nodeVersion === `v${selector}`);
}

export function projectEngineSecretsIdentity(env: Readonly<Record<string, string | undefined>>, nodeVersion: string) {
  try {
    const consumerRun = env['GITHUB_RUN_ID']; const consumerAttempt = env['GITHUB_RUN_ATTEMPT'];
    const selector = env['NODE_SELECTOR']; const sourceCommit = env['E2E_CAPTURE_SOURCE_COMMIT']; const sourceTree = env['E2E_CAPTURE_SOURCE_TREE'];
    const decimal = /^[1-9][0-9]{0,19}$/; const source = /^[a-f0-9]{40}$/;
    if (consumerRun === undefined || !decimal.test(consumerRun) || consumerAttempt === undefined || !decimal.test(consumerAttempt)
      || selector === undefined || !matchesNodeSelector(selector, nodeVersion)
      || sourceCommit === undefined || !source.test(sourceCommit) || sourceTree === undefined || !source.test(sourceTree)) return undefined;
    return { consumerRun, consumerAttempt, selector, nodeVersion, sourceCommit, sourceTree, caseSchema: 'engine-secrets-five-v1' as const };
  } catch { return undefined; }
}

/** Capture cannot change the original nested run's return value or thrown object. */
export async function withEngineSecretsDiagnostics<T extends { outcome: { report: unknown } }>(run: (onEvent: RunEventSink | undefined, env?: NodeJS.ProcessEnv) => Promise<T>, projectDir?: string): Promise<T> {
  if (process.env['E2E_ENGINE_SECRETS_CAPTURE'] !== '1') return run(undefined);
  const selectedSuite = process.env['E2E_NATIVE_DIAGNOSTIC_SUITE'];
  if ((process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC'] !== undefined && process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC'] !== '0')
    || (selectedSuite !== undefined && selectedSuite !== 'engine-secrets' && selectedSuite !== 'unserved-model-two-workers')) {
    const previous = process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC'];
    try {
      process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC'] = '0';
      try { process.stderr.write('NATIVE_DIAGNOSTIC_CAPTURE_CONFLICT {"schemaVersion":1,"status":"incomplete"}\n'); } catch { /* No business effect. */ }
      try { process.stderr.write('ENGINE_SECRETS_DIAGNOSTIC_UNAVAILABLE {"schemaVersion":1,"suite":"engine-secrets","status":"incomplete","reason":"capture-conflict"}\n'); } catch { /* No business effect. */ }
      return await run(undefined);
    } finally { if (previous === undefined) delete process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC']; else process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC'] = previous; }
  }
  const identity = projectEngineSecretsIdentity(process.env, process.version);
  if (identity === undefined) {
    try { process.stderr.write('ENGINE_SECRETS_DIAGNOSTIC_UNAVAILABLE {"schemaVersion":1,"suite":"engine-secrets","status":"incomplete","reason":"identity-unavailable"}\n'); } catch { /* Missing evidence cannot replace the workload. */ }
    return run(undefined);
  }
  let nonce: string;
  try { nonce = randomBytes(32).toString('hex'); } catch { return run(undefined); }
  const capture = createEngineSecretsCapture(nonce);
  const previous = process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC']; const previousNonce = process.env['E2E_ENGINE_SECRETS_CAPTURE_NONCE'];
  const previousSuite = process.env['E2E_NATIVE_DIAGNOSTIC_SUITE'];
  process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC'] = '1'; process.env['E2E_ENGINE_SECRETS_CAPTURE_NONCE'] = nonce; process.env['E2E_NATIVE_DIAGNOSTIC_SUITE'] = 'engine-secrets';
  const nativeCapture = prepareEngineSecretsNativeCustody(nonce, identity, projectDir);
  const envelope = JSON.stringify({ schemaVersion: 1, suite: 'engine-secrets', diagnosticContract: 'secrets-native-custody-v2', nativeCapture: nativeCapture === undefined ? 'unavailable' : 'ready', captureNonce: nonce, ...identity });
  let report: unknown; let began = false;
  try {
    try { process.stderr.write(`ENGINE_SECRETS_DIAGNOSTIC_BEGIN ${envelope}\n`); began = true; } catch { /* Missing boundary makes evidence incomplete. */ }
    const result = await run(capture.onEvent, nativeCapture?.env);
    try { report = result.outcome.report; } catch { /* Invalid projection cannot replace a successful run. */ }
    return result;
  } finally {
    if (previous === undefined) delete process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC']; else process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC'] = previous;
    if (previousNonce === undefined) delete process.env['E2E_ENGINE_SECRETS_CAPTURE_NONCE']; else process.env['E2E_ENGINE_SECRETS_CAPTURE_NONCE'] = previousNonce;
    if (previousSuite === undefined) delete process.env['E2E_NATIVE_DIAGNOSTIC_SUITE']; else process.env['E2E_NATIVE_DIAGNOSTIC_SUITE'] = previousSuite;
    try {
      const result = capture.finish(report);
      const nativeArchive = nativeCapture?.archive(result.rows) === true ? 'copied' : 'incomplete';
      for (const row of result.rows) process.stderr.write(`${PREFIX}${JSON.stringify(row)}\n`);
      process.stderr.write(`ENGINE_SECRETS_DIAGNOSTIC_CUSTODY ${JSON.stringify({ ...result.custody, began, nativeArchive })}\n`);
    } catch { /* Never replace business failure or cleanup. */ }
    finally { try { process.stderr.write(`ENGINE_SECRETS_DIAGNOSTIC_END ${envelope}\n`); } catch { /* Missing end remains incomplete. */ } }
  }
}
