/**
 * The replaced engine's storage-state file, imported by the native one.
 *
 * The old engine captured `playwright-storage-state`; the native engine
 * accepts the same file at `state.restore`. A real file is produced here by
 * the same Playwright 1.64.1 client the old engine used — normal and
 * partitioned cookies, `localStorage`, and an IndexedDB database with a store,
 * an index and a record — and handed to the native engine as that file. The
 * receipt is behavioural: `/legacy-session` refuses the request without its
 * login cookie, so reaching its protected body proves the cookie jar is sent,
 * and the body itself reads the imported `localStorage` and IndexedDB values.
 * The partitioned cookie reaches only the cross-site frame it is partitioned
 * for, never the top-level page, which proves the import kept its partition.
 *
 * The edge cases pin the format's boundaries: a file missing a required field,
 * a file with an unknown field, duplicate IndexedDB databases and an opaque
 * cookie partition are refused instead of partly restored or broadened. Names
 * shared between a cookie, a `localStorage` key and an IndexedDB database are
 * independent namespaces, not a conflict.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser as PlaywrightBrowser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JsonValue } from 'e2e/engine';
import { LEGACY_SESSION_COOKIES, startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { startNativeFixture, type NativeFixture } from '../helpers/native-fixture.ts';

const PLAYWRIGHT_VERSION = (createRequire(import.meta.url)('playwright-core/package.json') as { version: string }).version;

/** One legacy file as it was written to and read back from disk. */
interface LegacyFile {
  readonly data: Record<string, unknown>;
}

/** What the protected page reports after the import. */
interface SessionReading {
  readonly user: string;
  readonly role: string;
  readonly token: string;
  readonly cookies: string;
  readonly title: string;
}

let app: FixtureApp;
let playwright: PlaywrightBrowser;
let workDir: string;

beforeAll(async () => {
  app = await startFixtureApp();
  playwright = await chromium.launch();
  workDir = mkdtempSync(path.join(tmpdir(), 'e2e-legacy-state-'));
});

afterAll(async () => {
  await playwright?.close();
  await app?.close();
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * A real file from the replaced engine's client: one normal cookie, one
 * partitioned cookie, a `localStorage` token and an IndexedDB record. It is
 * written to disk and read back, so the test imports the file a migration
 * would carry, not an object only this test could build.
 */
async function recordLegacyFile(name = 'session'): Promise<LegacyFile> {
  const context = await playwright.newContext();
  try {
    await context.addCookies([
      { name: 'session', value: LEGACY_SESSION_COOKIES.session, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' },
      // Partitioned for a different top-level site: only the cross-site frame
      // under `loopbackUrl` may present it.
      { name: 'partitioned', value: LEGACY_SESSION_COOKIES.partitioned, domain: '127.0.0.1', path: '/', secure: true, sameSite: 'None', partitionKey: app.loopbackUrl },
      // A name shared with the IndexedDB database and a localStorage key: all
      // three stores carry it, and none of them can shadow another.
      { name: 'vault', value: 'cookie-vault', domain: '127.0.0.1', path: '/' },
    ]);
    const page = await context.newPage();
    await page.goto(`${app.url}/legacy-setup`);
    await page.waitForFunction(() => document.title === 'stored');
    await page.evaluate(() => localStorage.setItem('vault', 'local-vault'));
    const storage = await context.storageState({ indexedDB: true });
    const target = path.join(workDir, `${name}.json`);
    writeFileSync(target, `${JSON.stringify(storage, null, 2)}\n`);
    return { data: JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown> };
  } finally {
    await context.close();
  }
}

/** What the protected page shows once its IndexedDB and `localStorage` reads settle. */
async function readSession(fixture: NativeFixture): Promise<SessionReading> {
  await expect.poll(() => fixture.browser.evaluate(() => document.getElementById('state')?.textContent ?? null), { timeout: 5_000 }).toBe('ready');
  return fixture.browser.evaluate(() => ({
    user: document.getElementById('user')?.textContent ?? '',
    role: document.getElementById('role')?.textContent ?? '',
    token: document.getElementById('token')?.textContent ?? '',
    cookies: document.getElementById('cookies')?.textContent ?? '',
    title: document.title,
  }));
}

/** Restores one legacy payload into a fresh attempt, opens the gated page, and reads it. */
async function restoreAndOpen(data: JsonValue): Promise<{ fixture: NativeFixture; reading: SessionReading }> {
  const fixture = await startNativeFixture('legacy-state');
  try {
    await fixture.engine.state!.restore({ format: 'playwright-storage-state', version: 1, data }, { ...fixture.operation(), timeoutMs: 30_000 });
    await fixture.engine.session!.open!(`${app.url}/legacy-session`, { ...fixture.operation(), timeoutMs: 30_000 });
    return { fixture, reading: await readSession(fixture) };
  } catch (cause) {
    await fixture.close();
    throw cause;
  }
}

/** The error a rejected restore raises, so each boundary names its actual classification. */
async function restoreError(data: JsonValue): Promise<unknown> {
  const fixture = await startNativeFixture('legacy-state-invalid');
  try {
    return await fixture.engine.state!
      .restore({ format: 'playwright-storage-state', version: 1, data }, { ...fixture.operation(), timeoutMs: 30_000 })
      .then(() => 'restored', (cause: unknown) => cause);
  } finally {
    await fixture.close();
  }
}

describe('legacy Playwright storage-state import', () => {
  it('imports a real 1.64.1 file and reaches a session-gated page with its cookie, localStorage and IndexedDB state', async () => {
    expect(PLAYWRIGHT_VERSION).toBe('1.64.1');
    const file = await recordLegacyFile();
    // The recorded file is the legacy envelope the native entry accepts, and
    // the partition is stored as the top-level site Playwright records.
    expect(Object.keys(file.data).toSorted()).toEqual(['cookies', 'origins']);
    const cookies = file.data['cookies'] as { name: string; partitionKey?: string; _crHasCrossSiteAncestor?: boolean }[];
    const partitioned = cookies.find(cookie => cookie.name === 'partitioned');
    expect(partitioned?.partitionKey).toBe(`http://${new URL(app.loopbackUrl).hostname}`);
    expect(partitioned?.['_crHasCrossSiteAncestor']).toBe(true);

    const { fixture, reading } = await restoreAndOpen(file.data as JsonValue);
    try {
      expect(reading.title).toBe('Fixture Legacy Protected');
      expect(reading.user).toBe('ada');
      expect(reading.role).toBe('admin');
      expect(reading.token).toBe('file-token');
      // The same-name cookie reaches the top-level page; the partitioned one
      // must not be broadened into this first-party context. The login cookie
      // is httpOnly, so its own receipt is the server gate above and the jar.
      expect(reading.cookies).toContain('vault=cookie-vault');
      expect(reading.cookies).not.toContain('partitioned=');
      expect(await fixture.browser.cookies()).toContainEqual(expect.objectContaining({
        name: 'session', value: LEGACY_SESSION_COOKIES.session, httpOnly: true, domain: '127.0.0.1',
      }));
      // The same name in three stores stays three independent values.
      expect(await fixture.browser.evaluate(() => localStorage.getItem('vault'))).toBe('local-vault');
      // The imported store keeps its key path, its index and its record.
      expect(await fixture.browser.evaluate(() => new Promise<{ stores: string[]; indexes: string[]; keyPath: string; count: number }>((resolve) => {
        const opening = indexedDB.open('vault');
        opening.onsuccess = () => {
          const db = opening.result;
          const store = db.transaction('sessions', 'readonly').objectStore('sessions');
          const count = store.count();
          count.onsuccess = () => {
            resolve({
              stores: [...db.objectStoreNames],
              indexes: [...store.indexNames],
              keyPath: String(store.keyPath),
              count: count.result,
            });
            db.close();
          };
        };
      }))).toEqual({ stores: ['sessions'], indexes: ['byUser'], keyPath: 'id', count: 1 });

      // The partition still matches: the cross-site frame receives it.
      await fixture.engine.session!.open!(`${app.loopbackUrl}/legacy-partition`, { ...fixture.operation(), timeoutMs: 30_000 });
      await expect.poll(() => fixture.browser.evaluate(() => document.getElementById('partition')?.textContent ?? null), { timeout: 5_000 }).toContain(`partitioned=${LEGACY_SESSION_COOKIES.partitioned}`);
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('refuses a file missing a required field instead of restoring part of it', async () => {
    const file = await recordLegacyFile('missing');
    const outcome = await restoreError({ cookies: file.data['cookies'] } as JsonValue);
    expect(outcome, 'a missing origins array is refused').toMatchObject({ code: 'ENGINE_FAILURE' });
  }, 120_000);

  it('refuses a file with an unknown field instead of ignoring it', async () => {
    const file = await recordLegacyFile('extra');
    const outcome = await restoreError({ ...file.data, extra: true } as JsonValue);
    expect(outcome, 'an unknown top-level field is refused').toMatchObject({ code: 'ENGINE_FAILURE' });
  }, 120_000);

  it('refuses duplicate IndexedDB databases instead of merging them', async () => {
    const file = await recordLegacyFile('duplicate');
    const origins = structuredClone(file.data['origins'] as { indexedDB: unknown[] }[]);
    origins[0]!.indexedDB.push(structuredClone(origins[0]!.indexedDB[0]));
    const outcome = await restoreError({ ...file.data, origins } as JsonValue);
    expect(outcome, 'two databases with one name are refused').toMatchObject({ code: 'ENGINE_FAILURE' });
  }, 120_000);

  it('refuses a cookie field this converter does not know instead of dropping it', async () => {
    const file = await recordLegacyFile('unknown-cookie-field');
    // A field a newer client adds is not silently ignored: the whole import is
    // refused, so a cookie cannot be restored with its semantics missing.
    const cookies = (file.data['cookies'] as Record<string, unknown>[]).map(cookie => cookie.name === 'session'
      ? { ...cookie, unknownField: true }
      : cookie);
    const outcome = await restoreError({ ...file.data, cookies } as JsonValue);
    expect(outcome, 'an unknown cookie field is refused').toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  }, 120_000);
});
