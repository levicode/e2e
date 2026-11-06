import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { liveCookies, localStorageRestore, readSessionFile, toStoredCookies, writeSessionFile, type StoredCookie } from '../src/session.ts';
import type { UatSettings } from '../src/settings.ts';

const settings: UatSettings = {
  entryUrl: 'http://uat.example.test/app/',
  loginUrl: 'http://sso.example.test/login.html',
  accountId: '1234567890',
  homeHash: '#/home',
  sessionFile: '',
};

function directory(): string {
  return mkdtempSync(path.join(tmpdir(), 'uat-session-'));
}

function cookie(overrides: Partial<StoredCookie> = {}): StoredCookie {
  return { name: 'SESSDATA', value: 'secret-value', domain: '.example.test', path: '/', ...overrides };
}

test('writes the session 0600 inside a 0700 directory and reads it back', () => {
  const root = directory();
  try {
    const file = path.join(root, 'nested', 'session.json');
    writeSessionFile(file, {
      version: 1,
      savedAt: '2026-11-06T02:00:00.000Z',
      entryOrigin: 'http://uat.example.test',
      cookies: [cookie()],
      localStorage: { token: 'abc' },
    });
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const read = readSessionFile(settings, file);
    assert.equal(read.cookies[0]?.name, 'SESSDATA');
    assert.equal(read.localStorage['token'], 'abc');
    assert.equal(readFileSync(file, 'utf8').includes('"version": 1'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing session fails with the re-login command', () => {
  const root = directory();
  try {
    assert.throws(() => readSessionFile(settings, path.join(root, 'absent.json')), /UAT_SESSION_EXPIRED: .*login/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a session with no live cookie fails instead of silently redirecting to login', () => {
  const root = directory();
  try {
    const file = path.join(root, 'session.json');
    writeSessionFile(file, {
      version: 1,
      savedAt: '2026-11-06T02:00:00.000Z',
      entryOrigin: 'http://uat.example.test',
      cookies: [cookie({ expires: 1 })],
      localStorage: {},
    });
    assert.throws(() => readSessionFile(settings, file), /UAT_SESSION_EXPIRED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a session saved for another origin fails rather than mixing environments', () => {
  const root = directory();
  try {
    const file = path.join(root, 'session.json');
    writeSessionFile(file, {
      version: 1,
      savedAt: '2026-11-06T02:00:00.000Z',
      entryOrigin: 'http://other.example.test',
      cookies: [cookie()],
      localStorage: {},
    });
    assert.throws(() => readSessionFile(settings, file), /UAT_SESSION_EXPIRED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restoration drops expired cookies and keeps session cookies session-scoped', () => {
  const restored = liveCookies([cookie({ expires: 1 }), cookie({ name: 'live', expires: 4_000_000_000 }), cookie({ name: 'session', expires: -1 })]);
  assert.deepEqual(restored.map(item => item.name), ['live', 'session']);
  assert.equal('expires' in (restored[1] ?? {}), false);
  assert.deepEqual(toStoredCookies([{ name: 'a', value: 'b', domain: '.example.test', path: '/', expires: 4_000_000_000 }]), [
    { name: 'a', value: 'b', domain: '.example.test', path: '/', expires: 4_000_000_000 },
  ]);
});

test('localStorage restores only on the app origin', () => {
  assert.equal(localStorageRestore(settings, { version: 1, savedAt: '', entryOrigin: 'http://uat.example.test', cookies: [], localStorage: {} }), undefined);
  const restore = localStorageRestore(settings, { version: 1, savedAt: '', entryOrigin: 'http://uat.example.test', cookies: [], localStorage: { token: 'abc' } });
  assert.deepEqual(restore, { origin: 'http://uat.example.test', entries: { token: 'abc' } });
});
