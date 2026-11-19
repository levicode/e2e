/**
 * A list that rebuilds its rows while an action runs. Scroll-triggered
 * virtualization detaches the exact target between the hover/visibility probe
 * and the box-model read; the engine must report that as a stale target, not as
 * an unusable environment, and the action receipt must name the stage and CDP
 * command that produced it.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LocatorAction, NodeRef } from 'e2e/engine';
import { nativeDocument } from '../helpers/native-browser.ts';
import { startNativeFixture, type NativeFixture } from '../helpers/native-fixture.ts';

let fixture: NativeFixture | undefined;
let server: Server;
let origin: string;
let diagnosticsDir: string;
let diagnosticsFile: string;

const LIST_PAGE = (rows: number) => `
  <style>#list{height:300px;overflow:auto;border:1px solid #999}#list > div{height:36px;border-bottom:1px solid #ddd}</style>
  <div id="list" role="list">${Array.from({ length: rows }, (_, i) => `<div id="row-${i}" role="listitem">row ${i}</div>`).join('')}</div>
  <script>
    window.clicks = 0;
    document.addEventListener('click', () => window.clicks++, true);
    const list = document.getElementById('list');
    list.addEventListener('scroll', () => {
      // A virtualized list recycles rows as soon as the action scrolls it.
      list.innerHTML = Array.from({ length: 20 }, (_, i) => '<div id="row-' + i + '" role="listitem">row ' + i + '</div>').join('');
    });
  </script>`;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><body><h1>list</h1></body>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  diagnosticsDir = mkdtempSync(path.join(tmpdir(), 'e2e-action-churn-'));
  diagnosticsFile = path.join(diagnosticsDir, 'native-cleanup.jsonl');
  writeFileSync(diagnosticsFile, '', { mode: 0o600 });
  process.env.AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE = diagnosticsFile;
  fixture = await startNativeFixture('action-list-churn');
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.close();
  delete process.env.AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE;
  rmSync(diagnosticsDir, { recursive: true, force: true });
});

const operation = () => ({ ...fixture!.operation(), timeoutMs: 5_000 });

async function locatedRef(selector: string): Promise<NodeRef> {
  const matches = await fixture!.engine.locate!({ kind: 'selector', selector }, operation(), { purpose: 'fixture' });
  expect(matches).toHaveLength(1);
  return matches[0]!.ref;
}

async function perform(ref: NodeRef, action: LocatorAction): Promise<Error | undefined> {
  try {
    await fixture!.engine.perform!(ref, action, operation());
    return undefined;
  } catch (cause) {
    if (cause instanceof Error) return cause;
    throw cause;
  }
}

function diagnostics(): readonly Record<string, unknown>[] {
  return readFileSync(diagnosticsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
}

describe('an action on a list that rebuilds on scroll', () => {
  it('reports the replaced target as stale and names the failing stage', async () => {
    await fixture!.browser.goto(`${origin}/`);
    await nativeDocument(fixture!.browser, LIST_PAGE(120));
    const ref = await locatedRef('#row-90');
    const failure = await perform(ref, { kind: 'tap' });
    // The scroll already dispatched, so the outcome is unknown; the reason must
    // still be a stale target, never an environment/browser failure.
    expect(failure).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    expect(failure!.message).toContain('stale');
    const records = diagnostics().filter((record) => record['phase'] === 'ActionFailure');
    expect(records).toHaveLength(1);
    // The rebuild races the probes: a fast run replaces the row while the
    // visibility probe reads it, a slower one lets that probe through and the
    // box-model read names the stale target. Both keep the intent — a named
    // stage and a stale reason, never an environment failure.
    expect(records[0]).toMatchObject({
      actionKind: 'tap',
      error: 'stale-reference',
      effects: 'unknown',
    });
    const stage = records[0]!['actionStage'];
    expect(['visibility', 'box-model']).toContain(stage);
    if (stage === 'box-model') expect(records[0]!['actionCdpMethod']).toBe('dom-get-box-model');
  });

  it('still taps a target whose list did not move', async () => {
    await fixture!.browser.goto(`${origin}/`);
    await nativeDocument(fixture!.browser, LIST_PAGE(20));
    const ref = await locatedRef('#row-3');
    expect(await perform(ref, { kind: 'tap' })).toBeUndefined();
    await expect(fixture!.browser.evaluate(() => (window as unknown as { clicks: number }).clicks)).resolves.toBe(1);
    expect(diagnostics().filter((record) => record['phase'] === 'ActionFailure')).toHaveLength(0);
  });
});
