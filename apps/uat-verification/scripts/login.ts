/**
 * One-time (and renewal) login: take the local SSO session, set it in the
 * Chromium that trusts this environment's internal CA, prove the app answers as
 * a signed-in user, and persist the resulting browser state.
 *
 * The SSO cookie is written by `bili-auth` to a 0600 file; this script never
 * prints it, passes it as an argument, or logs it. The session file is the
 * reusable artifact, not the SSO secret itself.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runE2e } from '../src/e2e-cli.ts';
import { loadUatSettings } from '../src/settings.ts';
import { writeSsoCookieFile } from '../src/sso.ts';
import { launchTrustedBrowser } from '../src/trusted-browser.ts';

const settings = loadUatSettings();
const directory = mkdtempSync(path.join(tmpdir(), 'uat-login-'));
const cookieFile = path.join(directory, 'cookies.json');
try {
  console.log('Reading the local SSO session from bili-auth.');
  writeSsoCookieFile(cookieFile);
  const browser = await launchTrustedBrowser(settings);
  try {
    const code = await runE2e(['run', '--config', 'e2e.login.config.ts'], {
      ...process.env,
      ...settings.env,
      UAT_CDP_ENDPOINT: browser.endpoint,
      UAT_BOOTSTRAP_COOKIES: cookieFile,
    });
    if (code === 0) {
      console.log(`Signed in. Session saved to ${settings.sessionFile}.`);
      console.log('Next: pnpm --filter @e2e-dev/uat-verification verify');
    } else {
      console.error('The login run did not finish; no session was saved.');
      console.error('A failure before the app opens is a TLS/proxy/SSO problem, not a product defect; the report above names the host.');
      process.exitCode = code;
    }
  } finally {
    await browser.close();
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
