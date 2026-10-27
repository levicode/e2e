import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foundationSource } from './foundation-source.ts';
const lock = { schemaVersion: 1, repository: 'levicode/agent-browser', commit: 'a'.repeat(40) };
test('dedicated branch uses immutable lock; only manual event can override it', () => {
  assert.equal(foundationSource(lock, 'push', undefined), lock.commit);
  assert.equal(foundationSource(lock, 'workflow_dispatch', 'b'.repeat(40)), 'b'.repeat(40));
});
test('source lock rejects refs, unpinned sources, event spoofing and repository swaps', () => {
  for (const commit of [null, 'main', '0'.repeat(40), 'a'.repeat(39), 'a'.repeat(40) + '\n']) assert.throws(() => foundationSource({ ...lock, commit }, 'push', undefined));
  assert.throws(() => foundationSource(lock, 'pull_request_target', undefined));
  assert.throws(() => foundationSource(lock, 'push', 'b'.repeat(40)));
  assert.throws(() => foundationSource({ ...lock, repository: 'other/repo' }, 'push', undefined));
});
