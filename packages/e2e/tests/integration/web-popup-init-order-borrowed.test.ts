/** Same source fixture on original and current engines. Real browser required. */
import { web } from '@e2e-dev/web';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../../../web/tests/helpers/cdp-host.ts';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resultByTitle, createProject, runExisting, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const titles = [
  'existing document stays untouched until next navigation',
  'popup first inline sees each init once and reload starts a fresh document',
  'blank popup has each init once before explicit first navigation',
];
describe('popup initialization document boundary controls', () => {
  let server: Server | undefined;
  let chrome: RemoteChrome | undefined;
  let project: FixtureProject | undefined;
  let outcome: RunOutcome;
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.method !== 'GET' || !['/main', '/next', '/popup'].includes(request.url ?? '')) {
        response.writeHead(404).end(); return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><script>globalThis.firstInline = [...(globalThis.initOrder ?? [])];</script><script>addEventListener("DOMContentLoaded", () => { if (opener) opener.postMessage({kind: "init-document", snapshot: {first: globalThis.firstInline, final: globalThis.initOrder}}, location.origin); }, {once: true});</script><title>Synthetic init order</title><body>fixture</body>');
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const executable = process.env['E2E_POPUP_SWIPE_CHROME_EXECUTABLE'];
    if (executable === undefined) throw new Error('explicit verified Chrome path required');
    chrome = await launchRemoteChrome(executable);
    const endpoint = chrome.endpoint;
    project = createProject({ 'tests/popup-init-order.e2e.ts': readFileSync(new URL('../fixtures/popup-init-order/cases.txt', import.meta.url), 'utf8') });
    outcome = await runExisting(project, { appUrl: origin, config: { workers: 1, targets: [{ name: 'web', engine: web({ connect: { cdpEndpoint: () => endpoint } }), app: { url: origin } }] } });
  }, 120_000);
  afterAll(async () => {
    try {
      const output = path.resolve('.e2e/popup-init-order-borrowed');
      mkdirSync(output, { recursive: true });
      if (outcome) writeFileSync(path.join(output, 'report.json'), JSON.stringify(outcome.report, null, 2));
      if (project && existsSync(path.join(project.dir, '.e2e'))) cpSync(path.join(project.dir, '.e2e'), path.join(output, 'runner'), { recursive: true });
    } finally {
      try { project?.cleanup(); } finally {
        try { if (chrome !== undefined) await closeRemoteChrome(chrome); } finally {
        if (server?.listening) {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
        }
        }
      }
    }
  });
  it.each(titles)('%s', title => {
    const result = resultByTitle(outcome, title);
    expect(result.status, JSON.stringify(result.attempts)).toBe('passed');
  });
});
