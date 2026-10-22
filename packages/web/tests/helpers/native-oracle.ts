/** Test-only shared host for independent reads and explicitly opted-in retained-action probes. */
import { randomUUID } from 'node:crypto';
import { chromium, type Browser as OracleBrowser, type Page } from 'playwright-core';
import { closeRemoteChrome, launchRemoteChrome } from './cdp-host.ts';
import { startNativeFixture, type NativeFixture } from './native-fixture.ts';

export interface NativeOracle extends NativeFixture {
  /** Independent reference reads only. The native fixture owns all app operations. */
  readonly oracle: Page;
}

export interface NativeActionOracle extends NativeFixture {
  /** TEST ONLY: retained source-equivalent actions on synthetic event-only fixtures.
   * Setup, mutation and readback remain native Browser operations. */
  readonly actionOracle: Page;
}

/** Existing callers retain their read-only oracle contract. */
export async function startNativeOracle(name: string): Promise<NativeOracle> {
  const { page, ...fixture } = await connectNativeOracle(name);
  return { ...fixture, oracle: page };
}

/** Explicit action-probe opt-in, never an alternative production browser backend. */
export async function startNativeActionOracle(name: string): Promise<NativeActionOracle> {
  const { page, ...fixture } = await connectNativeOracle(name);
  return { ...fixture, actionOracle: page };
}

/** Identify the native page by a random witness, not by URL or node authority. */
async function connectNativeOracle(name: string): Promise<NativeFixture & { readonly page: Page }> {
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
    return { ...fixture, page: matches[0]!, close };
  } catch (cause) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([cause, cleanupError], 'Native oracle startup and cleanup failed', { cause: cleanupError }); }
    throw cause;
  }
}
