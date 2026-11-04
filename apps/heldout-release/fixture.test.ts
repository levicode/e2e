import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cases, catalog, serve, verify } from './fixture.ts';

for (const kind of cases) test(`persisted oracle: ${kind}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shelf-'));
  const spec = catalog(kind, 'structural-seed');
  assert.deepEqual(spec, catalog(kind, 'structural-seed'));
  const journal = join(directory, 'journal.jsonl');
  const fixture = await serve(spec, journal);
  const read = () => fetch(`${fixture.url}/collection`);
  const commit = (value: string[]) => fetch(`${fixture.url}/collection`, { method: 'POST', body: JSON.stringify(value) });
  try {
    assert.equal((await verify(spec, journal)).passed, false);
    await read();
    const unchanged = kind === 'already-selected' || kind === 'missing';
    if (!unchanged) {
      await commit(spec.expected);
      assert.equal((await verify(spec, journal)).passed, false, 'commit without persisted readback must fail');
    }
    await read();
    assert.equal((await verify(spec, journal)).passed, true);
    await commit(spec.expected);
    assert.equal((await verify(spec, journal)).passed, false, 'redundant writes must fail, including no-op targets');
  } finally { await fixture.close(); await rm(directory, { recursive: true }); }
});
test('long-list target starts beyond the initial visible choices', () => {
  const spec = catalog('long-list', 'new-seed');
  assert.equal(spec.choices.indexOf(spec.wanted), 77);
});
test('invalid writes do not enter the persisted journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shelf-'));
  const spec = catalog('preserve-defaults', 'another-seed');
  const journal = join(directory, 'journal.jsonl');
  const fixture = await serve(spec, journal);
  try {
    assert.equal((await fetch(`${fixture.url}/collection`, { method: 'POST', body: '["unknown"]' })).status, 400);
    assert.equal((await verify(spec, journal)).writes, 0);
  } finally { await fixture.close(); await rm(directory, { recursive: true }); }
});
