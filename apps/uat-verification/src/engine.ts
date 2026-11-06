/** The web engine a UAT target uses: attach to the loop's trusted browser when one was launched. */
import { web } from '@e2e-dev/web';

/** `web()` normally; `connect` when a script launched the Chromium that trusts the internal CA. */
export function uatEngine() {
  const endpoint = process.env['UAT_CDP_ENDPOINT'];
  const options = { viewport: { width: 1440, height: 900 }, locale: 'zh-CN' } as const;
  return endpoint === undefined || endpoint === ''
    ? web(options)
    : web({ ...options, connect: { cdpEndpoint: () => endpoint } });
}
