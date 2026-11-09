import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bind, EVIDENCE_DIRS } from './bind-popup-evidence.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const chromeSha256 = 'a'.repeat(64);

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'popup-evidence-binding-'));
  for (const directory of EVIDENCE_DIRS) mkdirSync(path.join(root, directory), { recursive: true });
  const [initDir, borrowedDir, swipeDir] = EVIDENCE_DIRS;
  const init = path.join(root, initDir);
  writeFileSync(path.join(init, 'popup-document-evidence.json'), '{"schemaVersion":2}\n');
  const borrowed = path.join(root, borrowedDir);
  writeFileSync(path.join(borrowed, 'report.json'), '{"borrowed":true}\n');
  const swipe = path.join(root, swipeDir);
  writeFileSync(path.join(swipe, 'facts.json'), '{"facts":[]}\n');
  mkdirSync(path.join(swipe, 'runner'), { recursive: true });
  writeFileSync(path.join(swipe, 'runner', 'report.json'), '{"report":1}\n');
  return { root, init, borrowed, swipe, options: {
    root, slot: '22.22.3', node: 'v22.22.3', chromeVersion: 'Chromium 142.0.7444.175',
    chromeSha256, sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), run: '42654207379', attempt: '1',
  } };
}

test('binds every evidence root to run, attempt, slot and Chromium identity', () => {
  const { init, borrowed, swipe, options } = fixture();
  const written = bind(options);
  try {
    assert.equal(written.length, 3);
    const initBinding = JSON.parse(readFileSync(path.join(init, 'binding.json'), 'utf8'));
    assert.equal(initBinding.kind, 'popup-evidence-binding');
    assert.equal(initBinding.run, '42654207379');
    assert.equal(initBinding.attempt, '1');
    assert.equal(initBinding.slot, '22.22.3');
    assert.equal(initBinding.chromeVersion, 'Chromium 142.0.7444.175');
    assert.equal(initBinding.chromeSha256, chromeSha256);
    assert.deepEqual(initBinding.files, [{ path: 'popup-document-evidence.json', bytes: Buffer.byteLength('{"schemaVersion":2}\n'), sha256: sha256('{"schemaVersion":2}\n') }]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(borrowed, 'binding.json'), 'utf8')).files.map(file => file.path), ['report.json']);
    const swipeBinding = JSON.parse(readFileSync(path.join(swipe, 'binding.json'), 'utf8'));
    assert.deepEqual(swipeBinding.files.map(file => file.path), ['facts.json', 'runner/report.json']);
  } finally { rmSync(options.root, { recursive: true, force: true }); }
});

test('a later run rewrites the binding instead of appending a second one', () => {
  const { init, options } = fixture();
  try {
    bind(options);
    const second = bind({ ...options, slot: '26', run: '42654207380' });
    assert.equal(second.length, 3);
    const binding = JSON.parse(readFileSync(path.join(init, 'binding.json'), 'utf8'));
    assert.equal(binding.slot, '26');
    assert.equal(binding.run, '42654207380');
    assert.equal(binding.files.length, 1);
  } finally { rmSync(options.root, { recursive: true, force: true }); }
});

test('evidence that exists without the Chromium identity is refused, not left unattributed', () => {
  const { options } = fixture();
  try {
    assert.throws(() => bind({ ...options, chromeVersion: '', chromeSha256: '' }), /cannot be bound/);
  } finally { rmSync(options.root, { recursive: true, force: true }); }
});

test('a slot whose tests never produced evidence is skipped', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'popup-evidence-binding-'));
  try {
    assert.deepEqual(bind({ root, slot: '26', node: 'v26.0.0', chromeVersion: 'Chromium 1', chromeSha256, sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), run: '1', attempt: '1' }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
