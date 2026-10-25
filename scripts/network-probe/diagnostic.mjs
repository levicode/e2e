// Temporary diagnostic interpretation only. Never import this into the formal collector.
// The caller binds these bytes and adapter entries to one owned capture/daemon lifetime.
const COMMON = ['schemaVersion', 'source', 'pid', 'record', 'operationSeq', 'phase', 'droppedBefore', 'emittedBefore', 'suppressedBefore', 'overflow'];
const BINDING = ['generation', 'attachmentOrdinal', 'targetOrdinal'];
const STAGES = new Set(['ready', 'receive', 'dispatch', 'project', 'emit', 'bind', 'detach', 'limit']);
const OUTCOMES = {
  dispatch: ['no-session', 'not-application'],
  project: ['unreached', 'invalid', 'wrong-session', 'missing-request', 'stored', 'duplicate', 'ignored', 'projected', 'unsupported'],
  emit: ['accepted', 'failed'],
};
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const natural = value => Number.isSafeInteger(value) && value >= 0;
const u32 = value => natural(value) && value <= 0xffffffff;
const tag = value => Array.isArray(value) && value.length === 4 && value.every(u32);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (value, required, optional = []) => required.every(key => own(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const envelope = value => object(value) && COMMON.every(key => own(value, key)) && value.schemaVersion === 2
  && value.source === 'native' && u32(value.pid) && value.pid > 0 && typeof value.phase === 'string'
  && ['record', 'operationSeq', 'droppedBefore', 'emittedBefore', 'suppressedBefore'].every(key => natural(value[key]))
  && typeof value.overflow === 'boolean';

export function validNetworkProbeRecord(value) {
  if (!envelope(value) || value.phase !== 'NetworkProbe' || value.operationSeq !== 0 || !object(value.probe)) return false;
  const p = value.probe, bound = p.stage === 'bind' || p.stage === 'detach';
  if (!STAGES.has(p.stage) || !keys(value, [...COMMON, 'probe', ...(bound ? BINDING : [])])) return false;
  if (bound && (!natural(value.generation) || !natural(value.attachmentOrdinal) || value.attachmentOrdinal > 65535
    || !natural(value.targetOrdinal) || value.targetOrdinal > 65535)) return false;
  if (p.stage === 'ready' || p.stage === 'limit') return keys(p, ['stage']);
  if (bound) return keys(p, ['stage'], ['session']) && (!own(p, 'session') || tag(p.session));
  const outcome = OUTCOMES[p.stage];
  if (!keys(p, ['stage', 'kind', ...(outcome ? ['outcome'] : [])], ['session', 'request', 'status']) || ![1, 2, 3].includes(p.kind)) return false;
  if (outcome && !outcome.includes(p.outcome)) return false;
  if (own(p, 'session') && !tag(p.session) || own(p, 'request') && (!tag(p.request) || !tag(p.session))) return false;
  return !own(p, 'status') || natural(p.status) && p.status <= 999;
}

export function analyzeNetworkProbe(options) { return analyze(options, 'network'); }
export function analyzeLauncherReady(options) { return analyze(options, 'launcher-ready'); }

function analyze({ bytes, expectedPid, expectedUrl, adapterEntries, processIdentityConfirmed,
  knownCleanupConfirmed, fixtureCleanup, validCleanupRecord } = {}, mode) {
  const reasons = new Set(), globalCaveats = new Set();
  const result = {
    schemaVersion: 1, mode, diagnosticOnly: true, releaseEligible: false, status: 'unknown',
    selectedTargetObserved: false, rawSchemaValid: false, absenceClaim: false,
    reasons: [], globalCaveats: [], selectedChain: null,
  };
  const finish = () => ({ ...result, reasons: [...reasons], globalCaveats: [...globalCaveats] });
  // A terminal seal is not invented here. Positive observations and absence claims differ.
  globalCaveats.add('no-terminal-capture-seal-no-absence-claim');
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 256 * 1024) {
    reasons.add('invalid-or-oversize-capture'); return finish();
  }
  if (!u32(expectedPid) || expectedPid === 0 || typeof validCleanupRecord !== 'function'
    || mode === 'network' && (typeof expectedUrl !== 'string' || !expectedUrl || expectedUrl.length > 65536 || !Array.isArray(adapterEntries))) {
    reasons.add('invalid-analysis-input'); return finish();
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { reasons.add('invalid-utf8'); return finish(); }
  if (!text || !text.endsWith('\n')) { reasons.add('empty-or-partial-capture'); return finish(); }
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > 2048) { reasons.add('capture-record-limit'); return finish(); }
  const records = [], probeCounts = new Map(), limitedPids = new Set();
  let probeCount = 0;
  for (const [index, line] of lines.entries()) {
    let value;
    try {
      if (Buffer.byteLength(line) + 1 > 512) throw Error('line-limit');
      value = JSON.parse(line);
      if (!envelope(value)) throw Error('envelope');
      if (value.phase === 'NetworkProbe') {
        if (!validNetworkProbeRecord(value) || ++probeCount > 64 || limitedPids.has(value.pid)) throw Error('probe-schema-or-limit');
        const count = (probeCounts.get(value.pid) ?? 0) + 1; probeCounts.set(value.pid, count);
        if (count === 64 && value.probe.stage !== 'limit') throw Error('missing-probe-limit');
        if (value.probe.stage === 'limit') { limitedPids.add(value.pid); globalCaveats.add('probe-limit'); }
      } else if (own(value, 'probe') || !validCleanupRecord(value)) throw Error('non-probe-schema');
    } catch { reasons.add('invalid-record'); continue; }
    if (value.droppedBefore !== 0 || value.suppressedBefore !== 0 || value.overflow) globalCaveats.add('global-drop-suppression-or-overflow');
    if (value.phase === 'CaptureLimitReached') globalCaveats.add('capture-limit');
    records.push({ ...value, lineIndex: index });
  }
  result.rawSchemaValid = reasons.size === 0;
  // Unknown/malformed records might contain an unobserved conflicting tenure. Fail closed.
  if (!result.rawSchemaValid) return finish();
  const pidRows = records.filter(row => row.pid === expectedPid);
  let previous = -1;
  for (const row of pidRows) {
    if (row.record !== previous + 1 || row.emittedBefore !== row.record) globalCaveats.add('global-record-or-emission-gap');
    previous = row.record;
  }
  const started = pidRows.filter(row => row.phase === 'CaptureStarted');
  const probes = pidRows.filter(row => row.phase === 'NetworkProbe');
  const ready = probes.filter(row => row.probe.stage === 'ready');
  if (started.length !== 1 || started[0].record !== 0 || ready.length !== 1
    || started[0].lineIndex >= ready[0].lineIndex || started[0].record >= ready[0].record) {
    reasons.add('daemon-capture-or-ready-unconfirmed'); return finish();
  }
  if (mode === 'launcher-ready') {
    // Caller confirms the same PID/startTicks, exact ELF and writable capture inode.
    if (processIdentityConfirmed !== true) reasons.add('daemon-process-identity-unconfirmed');
    result.selectedTargetObserved = processIdentityConfirmed === true;
    if (knownCleanupConfirmed !== true) reasons.add('owned-process-cleanup-unconfirmed');
    if (!object(fixtureCleanup) || !['end', 'dispose', 'server'].every(key => fixtureCleanup[key] === 'passed')) reasons.add('fixture-cleanup-unconfirmed');
    if (reasons.size === 0) result.status = 'launcher-ready-observed';
    return finish();
  }
  const complete = [];
  for (const bind of probes.filter(row => row.probe.stage === 'bind' && tag(row.probe.session))) {
    if (bind.lineIndex <= ready[0].lineIndex || bind.record <= ready[0].record || bind.attachmentOrdinal === 0 || bind.targetOrdinal === 0) continue;
    const binding = BINDING.map(key => bind[key]);
    const transitions = probes.filter(row => row.lineIndex > bind.lineIndex && ['bind', 'detach'].includes(row.probe.stage)
      && same(row.probe.session, bind.probe.session));
    const transition = transitions[0], closures = [];
    if (transition?.probe.stage === 'detach' && same(BINDING.map(key => transition[key]), binding) && transition.record > bind.record)
      closures.push({ end: transition, kind: 'detach' });
    // Scope teardown often has no page Detach event. Use its real matched lifecycle,
    // never a fabricated end row, together with independently confirmed process cleanup.
    if (knownCleanupConfirmed === true && object(fixtureCleanup) && ['end', 'dispose', 'server'].every(key => fixtureCleanup[key] === 'passed')) {
      for (const start of pidRows.filter(row => row.phase === 'CleanupStarted' && row.cleanupLifecycle === 'scope-end'
        && row.generation === bind.generation && row.lineIndex > bind.lineIndex && row.record > bind.record)) {
        const lifecycle = ['generation', 'operationSeq', 'cleanupOwner', 'cleanupAttempt', 'cleanupLifecycle'];
        const matching = pidRows.filter(row => ['CleanupStarted', 'CleanupFirstFailure', 'CleanupResult'].includes(row.phase)
          && same(lifecycle.map(key => row[key]), lifecycle.map(key => start[key])));
        const ends = matching.filter(row => row.phase === 'CleanupResult');
        if (matching.filter(row => row.phase === 'CleanupStarted').length !== 1 || ends.length !== 1
          || matching.some(row => row.phase === 'CleanupFirstFailure')) continue;
        const end = ends[0];
        if (end.cleanupResult === 'passed' && end.lineIndex > start.lineIndex && end.record > start.record
          && (!transition || transition.lineIndex > end.lineIndex)) closures.push({ start, end, kind: 'scope-end' });
      }
    }
    const closure = closures.sort((a, b) => a.end.lineIndex - b.end.lineIndex)[0];
    if (!closure) continue;
    const { end } = closure;
    const bridged = pidRows.filter(row => row.phase === 'TargetAttribution' && row.lineIndex < bind.lineIndex
      && row.lineIndex > ready[0].lineIndex && row.record > ready[0].record && row.record < bind.record
      && same(BINDING.map(key => row[key]), binding));
    if (!bridged.length) continue;
    // One attachment ordinal cannot silently refer to another target/generation in this interval.
    if (pidRows.some(row => row.phase === 'TargetAttribution' && row.lineIndex >= bridged.at(-1).lineIndex
      && row.lineIndex <= end.lineIndex && row.attachmentOrdinal === bind.attachmentOrdinal
      && !same(BINDING.map(key => row[key]), binding))) continue;
    const within = probes.filter(row => row.lineIndex > bind.lineIndex && row.lineIndex < end.lineIndex
      && same(row.probe.session, bind.probe.session) && tag(row.probe.request));
    const requestKeys = [...new Set(within.filter(row => row.probe.stage === 'receive' && row.probe.kind === 1).map(row => JSON.stringify(row.probe.request)))];
    for (const requestKey of requestKeys) {
      const events = within.filter(row => JSON.stringify(row.probe.request) === requestKey);
      const nodes = [
        events.filter(row => row.probe.kind === 1 && row.probe.stage === 'receive'),
        events.filter(row => row.probe.kind === 1 && row.probe.stage === 'project' && row.probe.outcome === 'stored'),
        events.filter(row => row.probe.kind === 2 && row.probe.stage === 'receive' && row.probe.status === 500),
        events.filter(row => row.probe.kind === 2 && row.probe.stage === 'project' && row.probe.status === 500 && row.probe.outcome === 'projected'),
        events.filter(row => row.probe.kind === 2 && row.probe.stage === 'emit' && row.probe.status === 500 && row.probe.outcome === 'accepted'),
      ];
      if (nodes.some(rows => rows.length !== 1)) continue;
      const [requestReceive, stored, responseReceive, projected, accepted] = nodes.map(rows => rows[0]);
      const before = (a, b) => a.lineIndex < b.lineIndex && a.record < b.record;
      // The CDP reader can receive a response before the event pump stores its request.
      // Require the product's partial order, not a fabricated cross-task total order.
      if (!before(bind, requestReceive) || !before(requestReceive, stored) || !before(requestReceive, responseReceive)
        || !before(stored, projected) || !before(responseReceive, projected) || !before(projected, accepted) || !before(accepted, end)) continue;
      if (closure.start && !before(accepted, closure.start)) continue;
      // A dropped probe Detach cannot erase an existing exact-target lifecycle retirement.
      if (pidRows.some(row => row.phase === 'TargetLifecycle' && row.targetStage === 'detached'
        && row.generation === bind.generation && row.attachmentOrdinal === bind.attachmentOrdinal
        && ((row.lineIndex > bind.lineIndex && row.lineIndex < accepted.lineIndex)
          || (row.record > bind.record && row.record < accepted.record)))) continue;
      const chain = [bind, requestReceive, stored, responseReceive, projected, accepted, ...(closure.start ? [closure.start] : []), end].sort((a, b) => a.lineIndex - b.lineIndex);
      // A limit marker inside the still-open selected tenure prevents closing that proof.
      if (probes.some(row => row.probe.stage === 'limit' && row.lineIndex > bind.lineIndex && row.lineIndex < end.lineIndex)) continue;
      complete.push({ pid: expectedPid, generation: bind.generation, attachmentOrdinal: bind.attachmentOrdinal,
        targetOrdinal: bind.targetOrdinal, session: bind.probe.session, request: JSON.parse(requestKey),
        attributionRecord: bridged.at(-1).record, records: chain.map(row => row.record),
        closure: closure.start ? { kind: 'scope-end', startedRecord: closure.start.record, resultRecord: end.record,
          operationSeq: end.operationSeq, cleanupOwner: end.cleanupOwner, cleanupAttempt: end.cleanupAttempt }
          : { kind: 'detach', record: end.record } });
    }
  }
  const expectedText = `GET ${expectedUrl} 500 Internal Server Error`;
  const adapterMatches = adapterEntries.filter(entry => object(entry) && entry.source === 'network' && entry.text === expectedText).length;
  if (complete.length !== 1) reasons.add(complete.length ? 'ambiguous-selected-chain' : 'selected-chain-incomplete-or-wrong-tenure');
  if (adapterMatches !== 1) reasons.add('adapter-exact-match-count-not-one');
  if (processIdentityConfirmed !== true) reasons.add('daemon-process-identity-unconfirmed');
  result.selectedTargetObserved = complete.length === 1 && adapterMatches === 1 && processIdentityConfirmed === true;
  if (result.selectedTargetObserved) result.selectedChain = complete[0];
  if (knownCleanupConfirmed !== true) reasons.add('owned-process-cleanup-unconfirmed');
  if (!object(fixtureCleanup) || !['end', 'dispose', 'server'].every(key => fixtureCleanup[key] === 'passed')) reasons.add('fixture-cleanup-unconfirmed');
  if (result.selectedTargetObserved && reasons.size === 0) result.status = 'selected-chain-observed';
  return finish();
}
