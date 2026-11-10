/** The case table shared by measure.mjs and run.mjs. */
export const MiB = 1024 * 1024;
const MAX_TIMEOUT_MS = 3_600_000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export const CASES = {
  'evaluate-size-512KiB': { family: 'evaluate size', scenario: "evaluate returns 'x'.repeat(512KiB)", run: async (h) => `len=${(await h.evaluate((n) => 'x'.repeat(n), 512 * 1024)).length}` },
  'evaluate-size-900KiB': { family: 'evaluate size', scenario: "evaluate returns 'x'.repeat(900KiB)", run: async (h) => `len=${(await h.evaluate((n) => 'x'.repeat(n), 900 * 1024)).length}` },
  'evaluate-size-1MiB': { family: 'evaluate size', scenario: "evaluate returns 'x'.repeat(1MiB)", run: async (h) => `len=${(await h.evaluate((n) => 'x'.repeat(n), MiB)).length}` },
  'evaluate-size-4MiB': { family: 'evaluate size', scenario: "evaluate returns 'x'.repeat(4MiB)", run: async (h) => `len=${(await h.evaluate((n) => 'x'.repeat(n), 4 * MiB)).length}` },
  'evaluate-depth-80': { family: 'evaluate depth', scenario: 'evaluate returns an object nested 80 deep', run: async (h) => `depth=${80} ${typeof (await h.evaluate((d) => { let value = 'leaf'; for (let index = 0; index < d; index += 1) value = { n: value }; return value; }, 80))}` },
  'evaluate-depth-100': { family: 'evaluate depth', scenario: 'evaluate returns an object nested 100 deep', run: async (h) => `depth=${100} ${typeof (await h.evaluate((d) => { let value = 'leaf'; for (let index = 0; index < d; index += 1) value = { n: value }; return value; }, 100))}` },
  'evaluate-depth-126': { family: 'evaluate depth', scenario: 'evaluate returns an object nested 126 deep', run: async (h) => `depth=${126} ${typeof (await h.evaluate((d) => { let value = 'leaf'; for (let index = 0; index < d; index += 1) value = { n: value }; return value; }, 126))}` },
  'evaluate-depth-128': { family: 'evaluate depth', scenario: 'evaluate returns an object nested 128 deep', run: async (h) => `depth=${128} ${typeof (await h.evaluate((d) => { let value = 'leaf'; for (let index = 0; index < d; index += 1) value = { n: value }; return value; }, 128))}` },
  'init-count-100': { family: 'initScript count', scenario: 'add 100 init scripts, navigate, read the last marker', run: async (h) => { await h.addScripts(100, (index) => `window.initMark=${index};`); await h.goto('/?verify=1'); return h.evaluate(() => window.initMark); } },
  'init-count-1024': { family: 'initScript count', scenario: 'add 1024 init scripts, navigate, read the last marker', run: async (h) => { await h.addScripts(1024, (index) => `window.initMark=${index};`); await h.goto('/?verify=1'); return h.evaluate(() => window.initMark); } },
  'init-count-1025': { family: 'initScript count', scenario: 'add 1025 init scripts', run: (h) => h.addScripts(1025, (index) => `window.initMark=${index};`) },
  'init-total-7.4MiB': { family: 'initScript total', scenario: 'add 8 comment-only init scripts totalling 7.4MiB', run: (h) => h.addScripts(8, () => `/*${'x'.repeat(928 * 1024)}*/`) },
  'init-total-8.3MiB': { family: 'initScript total', scenario: 'add 9 comment-only init scripts totalling 8.3MiB', run: (h) => h.addScripts(9, () => `/*${'x'.repeat(928 * 1024)}*/`) },
  'init-single-1.2MiB': { family: 'initScript per script', scenario: 'add one 1.2MiB init script', run: (h) => h.addScripts(1, () => `/*${'x'.repeat(1_200_000)}*/`) },
  'blob-response-8MiB': { family: 'blob single', scenario: 'waitForResponse and read an 8MiB response body', run: (h) => h.readResponseBody(8 * MiB) },
  'blob-response-16MiB': { family: 'blob single', scenario: 'waitForResponse and read a 16MiB response body', run: (h) => h.readResponseBody(16 * MiB) },
  'blob-response-32MiB': { family: 'blob single', scenario: 'waitForResponse and read a 32MiB response body', run: (h) => h.readResponseBody(32 * MiB) },
  'blob-response-48MiB': { family: 'blob single', scenario: 'waitForResponse and read a 48MiB response body', run: (h) => h.readResponseBody(48 * MiB) },
  'blob-response-50MiB': { family: 'blob single', scenario: 'waitForResponse and read a 50MiB response body', run: (h) => h.readResponseBody(50 * MiB) },
  'blob-response-63MiB': { family: 'blob single', scenario: 'waitForResponse and read a 63MiB response body', run: (h) => h.readResponseBody(63 * MiB) },
  'blob-download-64MiB': { family: 'blob single', scenario: 'download one 64MiB file and read it from disk', run: (h) => h.download(64) },
  'blob-download-130MiB': { family: 'blob total', scenario: 'download one 130MiB file and read it from disk', run: (h) => h.download(130) },
  'blob-download-total-150MiB': { family: 'blob total', scenario: 'download three 50MiB files in sequence', run: async (h) => { const sizes = []; for (let index = 0; index < 3; index += 1) sizes.push((await h.download(50)).bytes); return `${sizes.join('+')} = ${sizes.reduce((left, right) => left + right, 0)}`; } },
  'state-localstorage-4MiB': { family: 'state', scenario: 'capture storage state after 4MiB of localStorage', run: (h) => h.captureState({ localStorage: 4 * MiB }) },
  'state-indexeddb-16MiB': { family: 'state', oldCannot: true, scenario: 'capture storage state after 16MiB in IndexedDB', run: (h) => h.captureState({ indexedDb: 16 * MiB }) },
  'state-indexeddb-33MiB': { family: 'state', oldCannot: true, scenario: 'capture storage state after 33MiB in IndexedDB', run: (h) => h.captureState({ indexedDb: 33 * MiB }) },
  'state-indexeddb-40MiB': { family: 'state', oldCannot: true, scenario: 'capture storage state after 40MiB in IndexedDB', run: (h) => h.captureState({ indexedDb: 40 * MiB }) },
  'route-background-31s': { family: 'route timeout', scenario: 'a page-timer request whose route handler awaits 31s', run: async (h) => { let invoked = false; await h.route('**/slow-fetch', async (route) => { invoked = true; await sleep(31_000); await route.continue(); }); await h.evaluate(() => { window.slowFetch = 'pending'; setTimeout(() => { fetch('/slow-fetch').then(() => { window.slowFetch = 'done'; }).catch(() => { window.slowFetch = 'err'; }); }, 500); }); await sleep(36_000); if (!invoked) throw new Error('route handler was not invoked'); const value = await h.evaluate(() => window.slowFetch); if (value !== 'done') throw new Error(`route fetch did not complete: ${value}`); return value; } },
  'route-foreground-5s': { family: 'route timeout', scenario: 'a goto whose route handler awaits 5s', run: async (h) => { let invoked = false; await h.route('**/slow-page', async (route) => { invoked = true; await sleep(5_000); await route.continue(); }); await h.goto('/slow-page'); if (!invoked) throw new Error('route handler was not invoked'); return h.evaluate(() => document.title); } },
  'dialog-background-31s': { family: 'dialog timeout', scenario: 'a page-timer alert whose dialog handler awaits 31s', run: async (h) => { let invoked = false; await h.onDialog(async (dialog) => { invoked = true; await sleep(31_000); await dialog.accept(); }); await h.evaluate(() => { setTimeout(() => alert('boundary'), 500); }); await sleep(36_000); if (!invoked) throw new Error('dialog handler was not invoked'); return h.evaluate(() => 1); } },
  'budget-timeout-0': { family: 'outer budget', scenario: 'navigate with timeout: 0', run: async (h) => { await h.goto('/?budget=0', { timeout: 0 }); return 'ok'; } },
  'budget-timeout-2h': { family: 'outer budget', scenario: 'navigate with timeout: 7200000 (2h)', run: async (h) => { await h.goto('/?budget=2h', { timeout: 2 * MAX_TIMEOUT_MS }); return 'ok'; } },
  'video-2s': { family: 'video', scenario: 'record 2s of video and collect the segment files', video: true, run: (h) => h.recordVideo(2_000) },
};

