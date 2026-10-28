/** Borrowed CDP control: same .73 host on both engines; not the original owned launch path. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { web } from '@e2e-dev/web';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../../../web/tests/helpers/cdp-host.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { primitiveFixtureDocument } from '../fixtures/popup-swipe/primitive.ts';
import { resultByTitle, createProject, runExisting, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const fixture = new URL('../fixtures/popup-swipe/', import.meta.url);
const titles = ['init scripts and partial media updates cover frames and new tabs', 'a path swipe drags and drops on the board'];
const boardLedger = `<script>(() => {
  const records = []; let overflow = 0; let sent = 0;
  const types = ['pointerdown','pointermove','pointerup','pointercancel','mousedown','mousemove','mouseup','dragstart','dragenter','dragover','dragleave','drop','dragend'];
  const record = event => {
    try {
    if (records.length >= 64) { overflow = Math.min(65535, overflow + 1); } else {
    const node = event.target;
    const bucket = node instanceof Element && node.closest('#card') ? 'source' : node instanceof Element && node.closest('#done') ? 'destination' : 'other';
    const dataTypes = event.dataTransfer ? Array.from(event.dataTransfer.types).slice(0,8).map(type => ['text/plain','text/html','text/uri-list','Files'].includes(type) ? type : 'other') : [];
    records.push({ordinal:records.length, type:event.type, trusted:event.isTrusted, button:event.button, buttons:event.buttons, bucket, dataTypes});
    }
    if (['mouseup','drop','dragend'].includes(event.type) && sent < 3) {
      sent += 1;
      try { navigator.sendBeacon('/__pair_drag', JSON.stringify({records, overflow})); } catch { /* Diagnostic only. */ }
    }
    } catch { /* Observation cannot prevent the original fixture handlers. */ } finally {
      if (['mouseup','dragend'].includes(event.type)) dispose();
    }
  };
  const dispose = () => { for (const type of types) { try { document.removeEventListener(type, record, true); } catch {} } try { removeEventListener('pagehide', dispose); } catch {} };
  try {
    for (const type of types) document.addEventListener(type, record, {capture:true, passive:true});
    addEventListener('pagehide', dispose, {once:true, passive:true});
    globalThis.__pairLedger = {records, get overflow(){return overflow;}, dispose};
  } catch { dispose(); }
})();</script>`;

describe('same-fixture borrowed popup and path-swipe diagnostic pair', () => {
  let server: Server | undefined;
  let project: FixtureProject | undefined;
  let chrome: RemoteChrome | undefined;
  let outcome: RunOutcome;
  const facts: unknown[] = [];
  const dragFacts: unknown[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  beforeAll(async () => {
    const board = readFileSync(new URL('board.html', fixture), 'utf8');
    server = createServer((request, response) => {
      if (request.url === '/__pair_drag') {
        if (request.method !== 'POST') { response.writeHead(405).end(); request.resume(); return; }
        let body = ''; let size = 0;
        request.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16384) { rejected = Math.min(65535, rejected + 1); response.writeHead(413).end(); request.destroy(); return; }
          body += chunk.toString('utf8');
        });
        request.on('end', () => {
          try {
            const data = JSON.parse(body) as { records: Record<string, unknown>[]; overflow: number };
            const eventTypes = ['pointerdown','pointermove','pointerup','pointercancel','mousedown','mousemove','mouseup','dragstart','dragenter','dragover','dragleave','drop','dragend'];
            if (dragFacts.length >= 3 || Object.keys(data).sort().join(',') !== 'overflow,records'
              || !Number.isInteger(data.overflow) || data.overflow < 0 || data.overflow > 65535
              || !Array.isArray(data.records) || data.records.length > 64
              || !data.records.every((record, index) => Object.keys(record).sort().join(',') === 'bucket,button,buttons,dataTypes,ordinal,trusted,type'
                && record['ordinal'] === index && typeof record['trusted'] === 'boolean'
                && typeof record['type'] === 'string' && eventTypes.includes(record['type'])
                && typeof record['bucket'] === 'string' && ['source','destination','other'].includes(record['bucket'])
                && Number.isInteger(record['button']) && Number(record['button']) >= -1 && Number(record['button']) <= 4
                && Number.isInteger(record['buttons']) && Number(record['buttons']) >= 0 && Number(record['buttons']) <= 31
                && Array.isArray(record['dataTypes']) && record['dataTypes'].length <= 8
                && record['dataTypes'].every(type => typeof type === 'string' && ['text/plain','text/html','text/uri-list','Files','other'].includes(type)))) throw new Error('invalid');
            dragFacts.push(data);
          } catch { rejected = Math.min(65535, rejected + 1); }
          response.writeHead(204).end();
        });
        return;
      }
      if (request.url === '/__pair_facts') {
        if (request.method !== 'POST') { response.writeHead(405).end(); request.resume(); return; }
        let body = ''; let size = 0;
        request.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 256) { rejected = Math.min(65535, rejected + 1); response.writeHead(413).end(); request.destroy(); return; }
          body += chunk.toString('utf8');
        });
        request.on('end', () => {
          try {
            if (size > 256 || facts.length >= 8) throw new Error('bounded');
            const data = JSON.parse(body) as Record<string, unknown>;
            if (Object.keys(data).sort().join(',') !== 'kind,marker,phase,ready'
              || !Object.values(data).every(value => typeof value === 'string')
              || !['main','frame','popup','parent'].includes(String(data['kind']))
              || !['first-script','dom-content-loaded','created'].includes(String(data['phase']))
              || !['match','absent','other','present'].includes(String(data['marker']))
              || !['loading','interactive','complete'].includes(String(data['ready']))) throw new Error('invalid');
            const key = `${String(data['kind'])}:${String(data['phase'])}`;
            if (seen.has(key)) throw new Error('duplicate');
            seen.add(key); facts.push({ ordinal: facts.length, ...data });
          } catch { rejected = Math.min(65535, rejected + 1); }
          response.writeHead(204).end();
        });
        return;
      }
      if (request.method !== 'GET' || !['/a','/frame','/popup','/board'].includes(request.url ?? '')) {
        response.writeHead(404).end(); return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(request.url === '/board' ? board.replace('</body>', `${boardLedger}</body>`) : primitiveFixtureDocument(request.url!));
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const executable = process.env['E2E_POPUP_SWIPE_CHROME_EXECUTABLE'];
    if (executable === undefined) throw new Error('explicit verified Chrome path required');
    chrome = await launchRemoteChrome(executable);
    const endpoint = chrome.endpoint;
    project = createProject({ 'tests/popup-swipe.e2e.ts': readFileSync(new URL('cases.txt', fixture), 'utf8') });
    outcome = await runExisting(project, { appUrl: origin, config: { workers: 1, targets: [{ name: 'web', engine: web({ connect: { cdpEndpoint: () => endpoint } }), app: { url: origin } }] } });
  }, 120_000);
  afterAll(async () => {
    // Persist before deleting project. No browser read/command is issued after cancellation.
    try {
      const output = path.resolve('.e2e/popup-swipe-borrowed-pair');
      mkdirSync(output, { recursive: true });
      writeFileSync(path.join(output, 'facts.json'), JSON.stringify({ facts, dragFacts, rejected }, null, 2));
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
    expect(result.status, JSON.stringify({ facts, dragFacts, rejected, errors: outcome.report.run.errors, attempts: result.attempts })).toBe('passed');
  });
});
