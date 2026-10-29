/** Exact local guard only; synthetic journals are not browser cleanup evidence. */
import { expect, it } from 'vitest';
import { NativeSurface } from '../../src/native-surface.ts';

const allowsCallerDeparture = Reflect.get(NativeSurface.prototype, 'onlyPendingWorkerAcquisition') as (this: Record<string, unknown>) => boolean;
const emptyAttempt = () => ({ ready: false, scope: '', videoBlobBatches: new Set(), wireRequests: new Set(), recordingStarts: new Set(), lateRecordings: new Set(), lateRecordingStops: new Map(), downloads: new Map(), downloadFiles: new Set() });
const worker = () => ({ leases: { hasOnlyPendingWorkerAcquisition: () => true } } as Record<string, unknown>);

it('allows only an actual resource-free pending acquisition, with or without an empty attempt', () => {
  expect(allowsCallerDeparture.call(worker())).toBe(true);
  expect(allowsCallerDeparture.call({ ...worker(), attempt: emptyAttempt() })).toBe(true);
  expect(allowsCallerDeparture.call({ ...worker(), leases: { hasOnlyPendingWorkerAcquisition: () => false } })).toBe(false);
});
it.each(['playwrightClient', 'playwrightClosing'] as const)('does not exempt retained worker %s', key => {
  expect(allowsCallerDeparture.call({ ...worker(), [key]: {} })).toBe(false);
});
it.each(['rawOpening', 'rawClosing', 'rawBinding', 'interopPrepared'] as const)('does not exempt current or retired attempt %s', key => {
  const attempt = { ...emptyAttempt(), [key]: key === 'interopPrepared' ? true : {} };
  expect(allowsCallerDeparture.call({ ...worker(), attempt })).toBe(false);
  expect(allowsCallerDeparture.call({ ...worker(), retiringAttempt: attempt })).toBe(false);
});
it.each(['attempt', 'retiringAttempt'] as const)('does not exempt retained download-file custody in %s', slot => {
  const attempt = emptyAttempt();
  const surface = { ...worker(), [slot]: attempt };
  expect(allowsCallerDeparture.call(surface)).toBe(true);
  attempt.downloadFiles.add({});
  expect(allowsCallerDeparture.call(surface)).toBe(false);
  attempt.downloadFiles.clear();
  expect(allowsCallerDeparture.call(surface)).toBe(true);
});
