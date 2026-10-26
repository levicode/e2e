/** Diagnostic override consumer only. Not no-override installed-candidate acceptance. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { openHost } from 'e2e/runner';
import { web } from '@e2e-dev/web';

assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE?.startsWith('/'), 'Diagnostic requires an explicit absolute runtime override');
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>Installed native candidate</title><button onclick="this.textContent=\'Saved\'">Save</button><input type="password" value="synthetic-private-value">');
});
await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
const url = `http://127.0.0.1:${server.address().port}`;
let host; let session; let closed = false; let checks = 0;

/** Retire resources with the existing cleanup-failure precedence. */
async function cleanup() {
  const failures = [];
  if (!closed) {
    try { if (session) failures.push(...await session.close()); } catch (error) { failures.push(error); }
    try { if (host) failures.push(...await host.close()); } catch (error) { failures.push(error); }
  }
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  if (failures.length) throw new AggregateError(failures, 'Installed consumer cleanup failed');
}

try {
  host = await openHost({ cwd: process.cwd(), config: { targets: [{ name: 'installed', engine: web(), app: { url } }] } });
  session = await host.openSession({ name: 'installed candidate public browser contract', timeout: 30_000 });
  const { browser, screen, app } = session.fixtures;
  await app.open();
  assert.equal(await browser.title(), 'Installed native candidate'); checks++;
  await screen.getByRole('button', { name: 'Save' }).click();
  assert.equal(await browser.locator('button').textContent(), 'Saved'); checks++;
  await browser.route('**/callback', async route => {
    assert.equal(await browser.title(), 'Installed native candidate');
    await route.fulfill({ body: 'installed callback' });
  });
  assert.equal(await browser.evaluate(() => fetch('/callback').then(response => response.text())), 'installed callback'); checks++;
  await browser.setCookies([{ name: 'candidate', value: 'synthetic', url }]);
  assert.ok((await browser.cookies()).some(cookie => cookie.name === 'candidate' && cookie.value === 'synthetic')); checks++;
  const capture = readFileSync(resolve(session.artifactsDir, await app.screenshot('installed-candidate')));
  assert.equal(capture.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); checks++;
  assert.deepEqual(await session.close(), []);
  assert.equal(session.report()?.run.status, 'passed');
  assert.deepEqual(await host.close(), []); closed = true; checks++;
  writeFileSync('diagnostic-public-result.json', JSON.stringify({ status: 'passed', checks, runtimeOverridePresent: true, releaseEligible: false, publicBrowserActionPassed: true, callbackPassed: true, cleanupConfirmed: true, report: session.report() }, null, 2));
} finally {
  await cleanup();
}
