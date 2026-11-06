/**
 * One-time login: open the SSO QR page in a headed browser, let the person scan
 * it, and persist the resulting browser state to the fixed private path.
 *
 * The QR page is the app's own login page plus `?redirect=`, so a successful
 * scan returns to the UAT entry instead of the dashboard home.
 */
import { runE2e } from '../src/e2e-cli.ts';
import { loadUatSettings, uatConfigFile } from '../src/settings.ts';
import { launchTrustedBrowser, needsTrustedBrowser } from '../src/trusted-browser.ts';

const settings = loadUatSettings();
if (settings.loginUrl === undefined) {
  console.error(`UAT_CONFIG_MISSING: set UAT_LOGIN_URL or write loginUrl to ${uatConfigFile()}`);
  process.exitCode = 2;
} else {
  console.log('Opening the UAT login page in a headed browser.');
  console.log('Scan the QR code with WeCom once. The window redirects to the app and closes when the session is saved.');
  console.log(`Session file (private, outside the repository): ${settings.sessionFile}`);
  const trustedBrowser = needsTrustedBrowser(settings) ? await launchTrustedBrowser(settings, { headed: true }) : undefined;
  let code: number;
  try {
    code = await runE2e(['run', '--config', 'e2e.login.config.ts', '--headed'], {
      ...process.env,
      ...(trustedBrowser === undefined ? {} : { ...settings.env, UAT_CDP_ENDPOINT: trustedBrowser.endpoint }),
    });
  } finally {
    await trustedBrowser?.close();
  }
  if (code === 0) {
    console.log(`Signed in. Session saved to ${settings.sessionFile}.`);
    console.log('Next: pnpm --filter @e2e-dev/uat-verification verify');
  } else {
    console.error('The login run did not finish; no session was saved. Re-run login and scan the QR while the window is open.');
    process.exitCode = code;
  }
}
