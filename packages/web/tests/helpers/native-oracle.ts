/** Temporary migration setup for a read-only Playwright oracle beside the native adapter. */
import { randomUUID } from 'node:crypto';
import { chromium, type Browser as OracleBrowser, type Page } from 'playwright-core';
import { closeRemoteChrome, launchRemoteChrome } from './cdp-host.ts';
import { startNativeFixture, type NativeFixture } from './native-fixture.ts';

export interface NativeOracle extends NativeFixture {
  /** Independent reference reads only. The native fixture owns all app operations. */
  readonly oracle: Page;
}

/** Attach both clients to an owned host and identify the native page without URL guessing. */
export async function startNativeOracle(name: string): Promise<NativeOracle> {
  const remote = await launchRemoteChrome();
  let fixture: NativeFixture | undefined;
  let connection: OracleBrowser | undefined;
  const close = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const work of [() => fixture?.close(), () => connection?.close(), () => closeRemoteChrome(remote)]) {
      try { await work(); } catch (cause) { failures.push(cause); }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Native oracle fixture cleanup failed');
  };
  try {
    fixture = await startNativeFixture(name, { connect: { cdpEndpoint: () => remote.endpoint } });
    const marker = randomUUID();
    await fixture.browser.evaluate((value) => {
      (window as unknown as { nativeOracleWitness: string }).nativeOracleWitness = value;
      return null;
    }, marker);
    connection = await chromium.connectOverCDP(remote.endpoint);
    const matches: Page[] = [];
    for (const page of connection.contexts().flatMap(context => context.pages())) {
      const value = await page.evaluate(() => (window as unknown as { nativeOracleWitness?: string }).nativeOracleWitness);
      if (value === marker) matches.push(page);
    }
    if (matches.length !== 1) throw new Error(`Expected one native page, found ${matches.length}`);
    return { ...fixture, oracle: matches[0]!, close };
  } catch (cause) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([cause, cleanupError], 'Native oracle startup and cleanup failed', { cause: cleanupError }); }
    throw cause;
  }
}
