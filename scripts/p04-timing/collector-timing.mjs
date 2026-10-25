/** Temporary recipe-local validator. Original raw bytes remain unchanged. */
import { createHash } from 'node:crypto';

// [budgetUs, writeCompleteUs, parsedReplyUs, interruptUs, restoreBeginUs,
//  restoreEndUs, replyKind, incomplete]. All clocks share witness creation.
// Reply kinds: 0 not observed, 1 exact success, 2 exact error, 3 invalid envelope.
export function validTiming(value) {
  if (!Array.isArray(value) || value.length !== 8 || typeof value[7] !== 'boolean') return false;
  if (!value.slice(0, 6).every(v => v === null || (Number.isSafeInteger(v) && v >= 0 && v <= 60_000_000))) return false;
  if (![0, 1, 2, 3].includes(value[6])) return false;
  if (value[0] === null && !value[7]) return false;
  if (value[6] === 0 && value[2] !== null) return false;
  if (value[6] !== 0 && value[2] === null && !value[7]) return false;
  if (value[4] !== null && value[5] !== null && value[5] < value[4]) return false;
  return true;
}

export function createTimingInspector(validCleanupRecord) {
  return function inspectCaptureTimingBytes(raw) {
    const bytes = Buffer.from(raw);
    const reasons = new Set(); const timings = []; const next = new Map(); const started = new Set();
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length > 256 * 1024 || bytes.length === 0 || bytes.at(-1) !== 10) reasons.add('raw-bound-or-partial');
    if (bytes.length <= 256 * 1024) {
      const lines = bytes.toString('utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      if (lines.length > 2048) reasons.add('record-bound');
      else for (const line of lines) {
        if (Buffer.byteLength(line) + 1 > 512) { reasons.add('line-bound'); continue; }
        let row; try { row = JSON.parse(line); } catch { reasons.add('malformed'); continue; }
        if (row === null || typeof row !== 'object' || Array.isArray(row)) { reasons.add('shape'); continue; }
        const { timing, ...base } = row;
        const hasTiming = Object.hasOwn(row, 'timing');
        // The formal schema is unchanged. Only this local projection admits one
        // explicit field on this one phase; it is not a reconstructed raw stream.
        if (!validCleanupRecord(hasTiming ? base : row)
          || (hasTiming && (row.phase !== 'ScreenshotFirstFailure' || !validTiming(timing)))) {
          reasons.add('shape'); continue;
        }
        if (row.record !== (next.get(row.pid) ?? 0)) reasons.add('gap');
        next.set(row.pid, row.record + 1);
        if (row.emittedBefore !== row.record) reasons.add('emitted-count');
        if (row.phase === 'CaptureStarted') {
          if (row.record !== 0 || started.has(row.pid)) reasons.add('duplicate-or-late-start');
          else started.add(row.pid);
        }
        if (row.droppedBefore || row.suppressedBefore || row.overflow || row.phase === 'CaptureLimitReached') reasons.add('dropped-or-limit');
        if (hasTiming) {
          if (!started.has(row.pid)) reasons.add('missing-start');
          if (timing[7]) reasons.add('timing-incomplete');
          timings.push(row);
        }
      }
    }
    if (!timings.length) reasons.add('no-timing-failure');
    return { schemaVersion: 1, rawSha256: digest, rawBytes: bytes.length,
      status: reasons.size ? 'unknown' : 'complete', reasons: [...reasons], timings,
      diagnosticOnly: true, cleanupAcceptance: 'unknown', releaseEligible: false };
  };
}
