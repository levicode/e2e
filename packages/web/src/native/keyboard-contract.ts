/** Playwright's public alias follows the test runner OS, not a remote daemon OS. */
export function controllerKey(key: string, platform: NodeJS.Platform = process.platform): string {
  return key.replace(/(^|\+)ControlOrMeta(?=\+|$)/g, `$1${platform === 'darwin' ? 'Meta' : 'Control'}`);
}
