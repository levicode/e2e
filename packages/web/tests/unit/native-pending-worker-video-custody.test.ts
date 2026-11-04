/** Predicate-only composition regression; no provider/browser/producer proof. */
import { expect, it } from 'vitest';
import { NativeSurface } from '../../src/native-surface.ts';
function fixture(slot: 'attempt' | 'retiringAttempt') {
  const surface = new NativeSurface({});
  Reflect.set(surface, 'leases', { hasOnlyPendingWorkerAcquisition: () => true });
  const owner = { ready: false, scope: '', wireRequests: new Set(), recordingStarts: new Set(), lateRecordings: new Set(), lateRecordingStops: new Map(), videoBlobBatches: new Set<unknown>(), downloads: new Map(), downloadFiles: new Set(), nativeVideoStop: undefined as Promise<void> | undefined };
  Reflect.set(surface, slot, owner);
  const probe = () => (Reflect.get(surface, 'onlyPendingWorkerAcquisition') as () => boolean).call(surface);
  return { owner, probe };
}
it.each(['attempt','retiringAttempt'] as const)('does not call %s pure pending while immutable video custody remains', slot => {
  const { owner, probe } = fixture(slot); expect(probe()).toBe(true);
  owner.videoBlobBatches.add({ pendingHandles: ['old-video'] }); expect(probe()).toBe(false);
  owner.videoBlobBatches.clear(); expect(probe()).toBe(true);
});
it.each(['attempt','retiringAttempt'] as const)('does not hide a retained native-video stop under the %s pending-acquire exemption', slot => {
  const { owner, probe } = fixture(slot); owner.nativeVideoStop = new Promise(() => {});
  expect(probe()).toBe(false);
});
