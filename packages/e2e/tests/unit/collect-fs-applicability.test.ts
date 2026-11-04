import { describe, expect, it } from 'vitest';
import { recordCollectFsCapability, validateContext, validateFixtureObservation } from '../helpers/collect-fs-applicability.ts';

const directory = (realpath: string, ino: string) => ({ realpath, dev: '1', ino, type: 'directory', symlink: false });
const observation = (insensitive: boolean) => {
  const canonical = directory('/tmp/e2e-collect-ABC123/tests/agent', '3');
  return { root: directory('/tmp/e2e-collect-ABC123', '1'), tests: directory('/tmp/e2e-collect-ABC123/tests', '2'), canonical, alternate: insensitive ? { ...canonical } : null, alternateLookupOutcome: insensitive ? 'same-directory' : 'absent-ENOENT' };
};
const expected = () => ({ schemaVersion: 1, kind: 'collect-fs-context/v1', sourceCommit: '1'.repeat(40), sourceTree: '2'.repeat(40), sourceInventorySHA256: '3'.repeat(64), collectSourceSHA256: '4'.repeat(64), observerSourceSHA256: '5'.repeat(64), validatorSourceSHA256: '6'.repeat(64), consumerRun: '100', consumerAttempt: '1', job: 'consume_0', nodeSelector: '24.22.1', nodeVersion: 'v24.22.1', invocationKind: 'core-full-suite', collectionSHA256: '7'.repeat(64), tempRootRealpath: '/tmp' });
const context = () => ({ ...expected(), nonce: '8'.repeat(64) });

describe('collect fixture applicability evidence', () => {
  it('accepts a synthetic sensitive observation only with positive canonical identity and ENOENT', () => {
    expect(() => validateFixtureObservation(observation(false), false, '/tmp')).not.toThrow();
  });
  it('accepts a synthetic insensitive observation only when alternate is the same directory', () => {
    expect(() => validateFixtureObservation(observation(true), true, '/tmp')).not.toThrow();
  });
  it('binds context to separately supplied current identity', () => {
    expect(() => validateContext(context(), expected())).not.toThrow();
  });
  it('does not inspect or mutate the original fixture without explicit CI opt-in', () => {
    const prior = process.env.E2E_COLLECT_CAPABILITY_CONTEXT;
    delete process.env.E2E_COLLECT_CAPABILITY_CONTEXT;
    try { expect(() => recordCollectFsCapability('/this-path-is-not-read', false, 'not-a-url')).not.toThrow(); }
    finally { if (prior === undefined) delete process.env.E2E_COLLECT_CAPABILITY_CONTEXT; else process.env.E2E_COLLECT_CAPABILITY_CONTEXT = prior; }
  });
  for (const [name, mutate] of [
    ['sensitive bool with an alias', (x: ReturnType<typeof observation>) => { x.alternate = { ...x.canonical }; }],
    ['EACCES is not absence', (x: ReturnType<typeof observation>) => { x.alternateLookupOutcome = 'absent-EACCES'; }],
    ['EIO is not absence', (x: ReturnType<typeof observation>) => { x.alternateLookupOutcome = 'absent-EIO'; }],
    ['ENOTDIR is not absence', (x: ReturnType<typeof observation>) => { x.alternateLookupOutcome = 'absent-ENOTDIR'; }],
    ['root symlink', (x: ReturnType<typeof observation>) => { x.root.symlink = true; }],
    ['tests parent symlink', (x: ReturnType<typeof observation>) => { x.tests.symlink = true; }],
    ['canonical symlink', (x: ReturnType<typeof observation>) => { x.canonical.symlink = true; }],
    ['canonical file instead of directory', (x: ReturnType<typeof observation>) => { x.canonical.type = 'file'; }],
    ['zero inode unavailable identity', (x: ReturnType<typeof observation>) => { x.canonical.ino = '0'; }],
    ['noncanonical inode', (x: ReturnType<typeof observation>) => { x.canonical.ino = '03'; }],
    ['foreign temp root', (x: ReturnType<typeof observation>) => { x.root.realpath = '/other/e2e-collect-ABC123'; }],
    ['nonfixture root name', (x: ReturnType<typeof observation>) => { x.root.realpath = '/tmp/foreign-ABC123'; }],
    ['foreign tests directory', (x: ReturnType<typeof observation>) => { x.tests.realpath = '/tmp/other/tests'; }],
    ['foreign canonical directory', (x: ReturnType<typeof observation>) => { x.canonical.realpath = '/tmp/other/tests/agent'; }],
  ] as const) {
    it(`rejects ${name}`, () => { const value = observation(false); mutate(value); expect(() => validateFixtureObservation(value, false, '/tmp')).toThrow(); });
  }
  it('rejects an insensitive capability with an absent alternate', () => { expect(() => validateFixtureObservation(observation(false), true, '/tmp')).toThrow(); });
  it('rejects an alias to a different inode', () => { const value = observation(true); value.alternate!.ino = '4'; expect(() => validateFixtureObservation(value, true, '/tmp')).toThrow(); });
  it('rejects an alternate symlink even if its target matches', () => { const value = observation(true); value.alternate!.symlink = true; expect(() => validateFixtureObservation(value, true, '/tmp')).toThrow(); });
  it('rejects a forged category or allowed-skip list', () => { expect(() => validateFixtureObservation({ ...observation(false), allowedSkipNames: ['anything'] }, false, '/tmp')).toThrow(); });
  it('rejects missing observation fields', () => { const { canonical: _canonical, ...value } = observation(false); expect(() => validateFixtureObservation(value, false, '/tmp')).toThrow(); });
  it('rejects a nonboolean capability', () => { expect(() => validateFixtureObservation(observation(false), 'false' as unknown as boolean, '/tmp')).toThrow(); });
  for (const key of ['sourceCommit', 'sourceTree', 'sourceInventorySHA256', 'collectSourceSHA256', 'observerSourceSHA256', 'validatorSourceSHA256', 'consumerRun', 'consumerAttempt', 'job', 'nodeSelector', 'nodeVersion', 'invocationKind', 'collectionSHA256', 'tempRootRealpath', 'kind'] as const) {
    it(`rejects context mismatch in ${key}`, () => { const value = context(); value[key] = 'foreign'; expect(() => validateContext(value, expected())).toThrow(); });
  }
  it('rejects malformed nonce', () => { expect(() => validateContext({ ...context(), nonce: 'old' }, expected())).toThrow(); });
  it('rejects extra context category', () => { expect(() => validateContext({ ...context(), category: 'allow-skip' }, expected())).toThrow(); });
  it('rejects missing context identity', () => { const { sourceTree: _sourceTree, ...value } = context(); expect(() => validateContext(value, expected())).toThrow(); });
});
