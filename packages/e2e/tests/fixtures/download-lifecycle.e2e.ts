/** Synthetic consumer project, copied unchanged into a real runner project. */
import { readFile } from 'node:fs/promises';
import { test, type Browser } from '@e2e-dev/web';
import { expect } from 'e2e';

let fixtureOrigin: string;
test.beforeEach(async ({ app, browser }) => {
  await app.open();
  fixtureOrigin = new URL(await browser.url()).origin;
});

async function control(action: 'wait' | 'release', name: string): Promise<void> {
  const response = await fetch(`${fixtureOrigin}/control/${action}/${name}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`download fixture control failed: ${action}/${name}`);
  await response.text();
}

async function verify(file: Awaited<ReturnType<Browser['waitForDownload']>>, name: string): Promise<void> {
  expect(file.suggestedFilename).toBe(`${name}.bin`);
  expect(await readFile(file.absolutePath)).toEqual(Buffer.from(`${name}\nsynthetic download\u0000\u00ff\n`));
}

test('concurrent waiters own separate artifacts while an unrelated fixture step is pending', async ({ browser }) => {
  let bothReady!: () => void;
  const ready = new Promise<void>(resolve => { bothReady = resolve; });
  let admitted = 0;
  const rendezvous = async (): Promise<void> => {
    if (++admitted === 2) bothReady();
    await ready;
  };
  const first = browser.waitForDownload(async () => {
    await rendezvous();
    await browser.locator('#concurrent').tap();
  });
  const second = browser.waitForDownload(rendezvous);
  const files = Promise.all([first, second]);
  void files.catch(() => undefined);
  let unrelated: Promise<string> | undefined;
  try {
    await control('wait', 'read-concurrent');
    unrelated = browser.evaluate(() => fetch('/unrelated').then(response => response.text()));
    void unrelated.catch(() => undefined);
    await control('wait', 'unrelated-entered');
    await control('release', 'concurrent');
    const [left, right] = await files;
    expect(left.absolutePath).not.toBe(right.absolutePath);
    await verify(left, 'concurrent');
    await verify(right, 'concurrent');
    await control('release', 'unrelated');
    expect(await unrelated).toBe('unrelated finished');
  } finally {
    await control('release', 'concurrent');
    await control('release', 'unrelated');
    await Promise.allSettled([files, unrelated]);
  }
});

test('nested waiters each own their copy of the same download', async ({ browser }) => {
  let inner: Awaited<ReturnType<Browser['waitForDownload']>> | undefined;
  const outer = await browser.waitForDownload(async () => {
    inner = await browser.waitForDownload(() => browser.locator('#nested').tap());
  });
  if (inner === undefined) throw new Error('inner waiter did not finish');
  expect(inner.absolutePath).not.toBe(outer.absolutePath);
  await verify(inner, 'nested');
  await verify(outer, 'nested');
});

test('trigger error wins over a real provider read failure without publishing bytes', async ({ browser }) => {
  const primary = new Error('synthetic trigger failure');
  let caught: unknown;
  try {
    await browser.waitForDownload(async () => {
      await browser.locator('#capture-failure').tap();
      await control('wait', 'read-capture-failure');
      await control('release', 'capture-failure');
      await control('wait', 'returned-capture-failure');
      throw primary;
    });
  } catch (cause) { caught = cause; }
  finally { await control('release', 'capture-failure'); }
  expect(caught).toBe(primary);
  await verify(await browser.waitForDownload(() => browser.locator('#after-failure').tap()), 'after-failure');
});

test('trigger error returns before a held read and late bytes are discarded', async ({ browser }) => {
  const primary = new Error('synthetic held-read trigger failure');
  let caught: unknown;
  try {
    await browser.waitForDownload(async () => {
      await browser.locator('#throw-held').tap();
      await control('wait', 'read-throw-held');
      throw primary;
    });
  } catch (cause) { caught = cause; }
  finally {
    // This control request is reached only after the public rejection, not after a timer.
    await control('release', 'throw-held');
  }
  expect(caught).toBe(primary);
  await control('wait', 'returned-throw-held');
  await verify(await browser.waitForDownload(() => browser.locator('#after-throw').tap()), 'after-throw');
});

test('timed out provider bytes cannot publish into a replacement scope', async ({ app, browser }) => {
  const waiting = browser.waitForDownload(async () => {
    await browser.locator('#cancelled').tap();
    await control('wait', 'read-cancelled');
  }, { timeout: 3_000 }).then(() => { throw new Error('held download unexpectedly resolved'); }, (cause: unknown) => cause);
  void waiting.catch(() => undefined);
  try {
    await control('wait', 'read-cancelled');
    const cause = await waiting;
    expect(cause).toMatchObject({ code: 'ACTION_FAILED' });
    if (!(cause instanceof Error)) throw new Error('held provider read did not reject with an error');
    expect(cause.message).toContain('download did not complete within');
    await control('wait', 'aborted-cancelled');
    await app.clearState();
    await app.open();
    const fresh = await browser.waitForDownload(async () => {
      // The replacement subscription is admitted before the old read is released.
      await control('release', 'cancelled');
      await control('wait', 'returned-cancelled');
      await browser.locator('#after-cancel').tap();
    });
    await verify(fresh, 'after-cancel');
  } finally {
    await control('release', 'cancelled');
    await waiting;
  }
});

test('a held HTTP download is cancelled before a replacement waiter runs', async ({ app, browser }) => {
  const waiting = browser.waitForDownload(async () => {
    await browser.locator('#stream').tap();
    await control('wait', 'stream-started');
  }, { timeout: 3_000 }).then(() => { throw new Error('held stream unexpectedly resolved'); }, (cause: unknown) => cause);
  void waiting.catch(() => undefined);
  try {
    await control('wait', 'stream-started');
    const cause = await waiting;
    expect(cause).toMatchObject({ code: 'ACTION_FAILED' });
    if (!(cause instanceof Error)) throw new Error('held stream did not reject with an error');
    // This distinguishes a real native download.started from a subscription with no event.
    expect(cause.message).toContain('download did not complete within');
    await app.clearState();
    await app.open();
    const fresh = await browser.waitForDownload(async () => {
      await control('release', 'stream');
      await control('wait', 'stream-closed');
      await browser.locator('#after-stream').tap();
    });
    await verify(fresh, 'after-stream');
  } finally {
    await control('release', 'stream');
    await waiting;
  }
});

// Native 2b9e0a00 bounds live download entries at 128. This is a finite
// capacity regression, not a claim to inspect the native resource table.
test('129 sequential downloads remain usable in one scope', { timeout: 120_000 }, async ({ browser }) => {
  for (let index = 0; index < 129; index++) {
    await verify(await browser.waitForDownload(() => browser.locator('#capacity').tap()), 'capacity');
  }
});

test('run interruption discards a held download', async ({ browser }) => {
  await browser.waitForDownload(() => browser.locator('#interrupt').tap());
});

test('a new attempt downloads after run interruption', async ({ browser }) => {
  await verify(await browser.waitForDownload(() => browser.locator('#after-interrupt').tap()), 'after-interrupt');
});
