/** Public fixture setup for integration tests, never a replacement backend or Page handle. */
import type { EngineFixtureContext, EngineHandle, OperationContext } from 'e2e/engine';
import type { Browser } from '../../src/index.ts';

/** Build one fixture per attempt; callers retain it across document/scope transitions. */
export function nativeBrowser(engine: EngineHandle, operation: () => OperationContext, baseUrl = 'http://fixture.test/'): Browser {
  return engine.fixtures!['browser']!({
    operation,
    signal: operation().signal,
    app: { resolveUrl: (url: string) => new URL(url, baseUrl).href },
    timeouts: { test: operation().timeoutMs, assertion: operation().timeoutMs },
    expectable: (target: object) => target,
    fixture: (_name: string, target: object) => target,
    attachArtifact: () => undefined,
    attachViewport: () => undefined,
  } as unknown as EngineFixtureContext) as Browser;
}

/** Replace a synthetic fixture document through trusted evaluation, including inline scripts. */
export async function nativeDocument(browser: Browser, html: string): Promise<void> {
  await browser.evaluate((content) => {
    document.open();
    document.write(content);
    document.close();
    return null;
  }, html);
}
