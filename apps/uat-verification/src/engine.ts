/** The web engine a UAT target uses: the user's own launch, or the loop's external browser over CDP. */
import { web } from '@e2e-dev/web';
import { browserPathFromEnvironment, browserViewport } from './browser-path.ts';

/**
 * `web()` for the user's real launch (headed 1440×1000), and `connect` when a
 * script launched the Chromium that trusts the internal CA. `UAT_BROWSER_PATH`
 * picks one; without it an exported `UAT_CDP_ENDPOINT` still means `cdp`.
 */
export function uatEngine() {
  const path = browserPathFromEnvironment(process.env);
  const options = { viewport: browserViewport(path), locale: 'zh-CN' } as const;
  if (path === 'engine') return web(options);
  const endpoint = process.env['UAT_CDP_ENDPOINT'];
  if (endpoint === undefined || endpoint === '') {
    throw new Error('UAT_CDP_ENDPOINT_MISSING: the cdp browser path needs the endpoint a trusted Chromium exports');
  }
  return web({ ...options, connect: { cdpEndpoint: () => endpoint } });
}
