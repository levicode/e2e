/** Full runner + real native transport + Chrome. The provider reads Chrome's
 * actual files; only those reads and our synthetic HTTP body can be held. */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { web, type BrowserProvider } from '@e2e-dev/web';
import type { E2EConfig } from '../../src/index.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../../../web/tests/helpers/cdp-host.ts';
import { createProject, resultByTitle, runExisting, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const TITLES = [
  'concurrent waiters own separate artifacts while an unrelated fixture step is pending',
  'nested waiters each own their copy of the same download',
  'trigger error wins over a real provider read failure without publishing bytes',
  'trigger error returns before a held read and late bytes are discarded',
  'timed out provider bytes cannot publish into a replacement scope',
  'a held HTTP download is cancelled before a replacement waiter runs',
  '129 sequential downloads remain usable in one scope',
] as const;
const INTERRUPTED = 'run interruption discards a held download';
const RECOVERED = 'a new attempt downloads after run interruption';
const BURST = 'Chrome drops the eleventh burst request before native download events';
const NAMES = ['concurrent', 'nested', 'capture-failure', 'after-failure', 'throw-held', 'after-throw', 'cancelled', 'after-cancel', 'stream', 'after-stream', 'capacity', 'burst', 'interrupt', 'after-interrupt'];
const HELD = new Set(['concurrent', 'capture-failure', 'throw-held', 'cancelled', 'interrupt']);
const SOURCE = readFileSync(new URL('../fixtures/download-lifecycle.e2e.ts', import.meta.url), 'utf8');

function downloadFiles(root: string, relative = ''): string[] {
  return readdirSync(path.join(root, relative)).flatMap(name => {
    const file = path.join(relative, name);
    return statSync(path.join(root, file)).isDirectory() ? downloadFiles(root, file)
      : file.split(path.sep).includes('downloads') ? [file.split(path.sep).join('/')] : [];
  });
}

/** Observes Chrome directly without changing download behavior or native frames. */
async function observeChromeDownload(endpoint: string, url: string, started: () => void): Promise<() => Promise<void>> {
  const socket = new WebSocket(endpoint);
  const closed = new Promise<void>(resolve => socket.addEventListener('close', () => resolve(), { once: true }));
  const close = async (): Promise<void> => { socket.close(); await closed; };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome observer connection deadline')), 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome observer connection failed')); }, { once: true });
    });
    let id = 0;
    const command = (method: 'Target.getTargets' | 'Target.attachToTarget' | 'Page.enable', params: object, sessionId?: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error(`Chrome observer ${method} deadline`)); }, 10_000);
      function receive(event: MessageEvent) {
        const message = JSON.parse(String(event.data)) as { id?: number; error?: unknown; result?: Record<string, unknown> };
        if (message.id !== requestId) return;
        clearTimeout(timer); socket.removeEventListener('message', receive);
        if (message.error !== undefined || message.result === undefined) reject(new Error(`Chrome observer ${method} failed`));
        else resolve(message.result);
      }
      socket.addEventListener('message', receive);
      socket.send(JSON.stringify({ id: requestId, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
    const targets = (await command('Target.getTargets', {}))['targetInfos'] as { type: string; url: string; targetId: string }[];
    const pages = targets.filter(target => target.type === 'page' && target.url === new URL('/', url).href);
    if (pages.length !== 1) throw new Error('Chrome observer needs exactly one synthetic page');
    const sessionId = (await command('Target.attachToTarget', { targetId: pages[0]!.targetId, flatten: true }))['sessionId'];
    if (typeof sessionId !== 'string') throw new Error('Chrome observer has no session');
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as { method?: string; sessionId?: string; params?: { url?: string } };
      if (message.sessionId === sessionId && message.method === 'Page.downloadWillBegin' && message.params?.url === url) started();
    });
    await command('Page.enable', {}, sessionId);
    return close;
  } catch (cause) { await close(); throw cause; }
}

describe('native download lifecycle through the public fixture', () => {
  const gates = new Map<string, { promise: Promise<void>; resolve(): void }>();
  const events: string[] = [];
  const unhandled: unknown[] = [];
  const projects: FixtureProject[] = [];
  const completed: { outcome: RunOutcome; project: FixtureProject }[] = [];
  let server: Server | undefined;
  let chrome: RemoteChrome | undefined;
  let disk: string | undefined;
  let main: RunOutcome;
  let interrupted: RunOutcome;
  let recovered: RunOutcome;
  let origin: string;
  const observers: (() => Promise<void>)[] = [];
  const event = (name: string) => {
    let gate = gates.get(name);
    if (gate === undefined) {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      gate = { promise, resolve }; gates.set(name, gate);
    }
    return gate;
  };
  const mark = (name: string): void => { events.push(name); event(name).resolve(); };
  const onUnhandled = (cause: unknown): void => { unhandled.push(cause); };

  beforeAll(async () => {
    process.on('unhandledRejection', onUnhandled);
    server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://fixture.test').pathname;
      if (pathname.startsWith('/control/')) {
        const [, , action, name] = pathname.split('/');
        if (action === 'observe' && (name === 'stream' || name === 'capacity' || name === 'burst')) {
          let starts = 0;
          void observeChromeDownload(chrome!.endpoint, `${origin}/file/${name}`, () => {
            mark(`chrome-${name}-started`);
            starts++;
            if (name === 'capacity' && starts === 129) mark('chrome-capacity-all-started');
            if (name === 'burst' && starts === 10) mark('chrome-burst-ten-started');
            if (name === 'burst' && starts === 11) mark('chrome-burst-eleven-started');
          }).then(close => {
            observers.push(close); mark(`chrome-${name}-observer-ready`); response.end('observing');
          }, () => { mark(`chrome-${name}-observer-failed`); response.writeHead(500).end('observer failed'); });
          return;
        }
        if (!name || (action !== 'wait' && action !== 'release')) { response.writeHead(400).end(); return; }
        if (action === 'release') { mark(`release-${name}`); response.end('released'); }
        else void event(name).promise.then(() => { response.end('observed'); });
        return;
      }
      if (pathname === '/unrelated') {
        mark('unrelated-entered');
        void event('release-unrelated').promise.then(() => response.end('unrelated finished'));
        return;
      }
      if (pathname.startsWith('/file/')) {
        const name = pathname.slice('/file/'.length);
        if (!NAMES.includes(name)) { response.writeHead(404).end(); return; }
        if (name === 'capacity' || name === 'burst') mark(`request-${name}`);
        const bytes = name === 'stream' ? Buffer.alloc(4097, 0x61) : Buffer.from(`${name}\nsynthetic download\u0000\u00ff\n`);
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}.bin"`, 'content-length': bytes.length,
          ...(name === 'stream' ? { 'x-content-type-options': 'nosniff' } : {}) });
        if (name === 'stream') {
          response.on('close', () => mark('stream-closed'));
          // A one-byte response may still be in Chromium's MIME sniffing path.
          // Send a full prefix, retaining EOF; the independent Chrome event
          // proves creation instead of inferring it from the server's write.
          response.write(bytes.subarray(0, -1));
          mark('stream-started');
          void event('release-stream').promise.then(() => response.end(bytes.subarray(-1)));
        } else response.end(bytes);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><title>Synthetic downloads</title><h1>Downloads</h1>${NAMES.map(name => `<a id="${name}" href="/file/${name}" download>${name}</a>`).join('<br>')}`);
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    disk = mkdtempSync(path.join(tmpdir(), 'e2e-download-lifecycle-'));
    chrome = await launchRemoteChrome();
    const provider: BrowserProvider = {
      name: 'synthetic-download-disk', scope: 'worker',
      acquire: async () => ({ id: 'synthetic-download-lease', cdpEndpoint: chrome!.endpoint }),
      release: async () => { mark('lease-released'); },
      downloads: {
        dir: path.join(disk, 'downloads'),
        async read(_lease, file, context) {
          const bytes = await readFile(file);
          const name = bytes.subarray(0, bytes.indexOf(10)).toString('utf8');
          const onAbort = (): void => mark(`aborted-${name}`);
          context.signal.addEventListener('abort', onAbort, { once: true });
          if (context.signal.aborted) onAbort();
          mark(`read-${name}`);
          try {
            if (HELD.has(name)) await event(`release-${name}`).promise;
            if (name === 'capture-failure') throw new Error('synthetic provider read failed');
            return bytes;
          } finally {
            context.signal.removeEventListener('abort', onAbort);
            mark(`returned-${name}`);
          }
        },
      },
    };
    const run = async (grep: RegExp[], interruptSignal?: AbortSignal): Promise<RunOutcome> => {
      const project = createProject({ 'tests/download-lifecycle.e2e.ts': SOURCE });
      projects.push(project);
      const outcome = await runExisting(project, {
        appUrl: origin,
        config: {
          workers: 1, timeout: 30_000, actionTimeout: 8_000, retries: 0,
          targets: [{ name: 'web', engine: web({ browser: provider }) as unknown as NonNullable<E2EConfig['targets'][number]['engine']>, app: { url: origin } }],
        },
        runOptions: { grep, interruptSignal },
      });
      completed.push({ outcome, project });
      return outcome;
    };
    main = await run([...TITLES, BURST].map(title => new RegExp(`^${title}$`)));
    const controller = new AbortController();
    const cancellation = run([new RegExp(`^${INTERRUPTED}$`)], controller.signal);
    void cancellation.catch(() => undefined);
    try {
      await Promise.race([Promise.all([event('read-interrupt').promise, event('release-interrupt-tap-finished').promise]), cancellation.then(() => { throw new Error('interrupted run ended before its held read and completed tap'); })]);
      controller.abort();
      await Promise.race([event('aborted-interrupt').promise, cancellation.then(() => { throw new Error('interrupted run ended without aborting its held read'); })]);
    } finally {
      mark('release-interrupt');
      interrupted = await cancellation;
    }
    recovered = await run([new RegExp(`^${RECOVERED}$`)]);
  }, 240_000);

  afterAll(async () => {
    for (const gate of gates.values()) gate.resolve();
    const failures: unknown[] = [];
    try {
      // Fixed synthetic facts only. CI can retain these without the temporary projects.
      process.stdout.write(`DOWNLOAD_LIFECYCLE_EVENTS ${JSON.stringify({ events, unhandled: unhandled.length })}\n`);
      for (const { outcome } of completed) {
        process.stdout.write(`DOWNLOAD_LIFECYCLE_RUN ${JSON.stringify({ status: outcome.status, exitCode: outcome.exitCode, errors: outcome.report.run.errors })}\n`);
        for (const result of outcome.results.filter(candidate => candidate.status !== 'skipped')) {
          process.stdout.write(`DOWNLOAD_LIFECYCLE_RESULT ${JSON.stringify({ title: result.test.title, status: result.status,
            attempts: result.attempts.map(attempt => ({ cleanup: attempt.cleanup, error: attempt.error,
              steps: attempt.steps.map(step => ({ api: step.api, status: step.status, artifacts: step.artifacts })),
              downloads: attempt.artifacts.filter(artifact => artifact.kind === 'download') })) })}\n`);
        }
      }
    } catch (cause) { failures.push(cause); }
    const releases = [
      async () => { for (const close of observers) await close(); },
      async () => { if (chrome !== undefined) await closeRemoteChrome(chrome); },
      async () => { server?.closeAllConnections(); if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(cause => cause ? reject(cause) : resolve())); },
      async () => { for (const project of projects) project.cleanup(); },
      async () => { if (disk !== undefined) rmSync(disk, { recursive: true, force: true }); },
    ];
    for (const release of releases) { try { await release(); } catch (cause) { failures.push(cause); } }
    process.off('unhandledRejection', onUnhandled);
    if (failures.length) throw new AggregateError(failures, 'download lifecycle fixture cleanup failed');
  });

  it.each(TITLES)('%s', title => {
    const result = resultByTitle(main, title);
    expect(result.status, JSON.stringify({ attempts: result.attempts, errors: main.report.run.errors })).toBe('passed');
    expect(result.attempts[0]!.cleanup).toBe('complete');
  });

  it.each(TITLES.slice(0, 2))('attributes both copies only to their waiters: %s', title => {
    const attempt = resultByTitle(main, title).attempts[0]!;
    const downloads = attempt.artifacts.filter(artifact => artifact.kind === 'download');
    expect(downloads).toHaveLength(2);
    const waiters = attempt.steps.filter(step => step.api === 'browser.waitForDownload');
    expect(waiters).toHaveLength(2);
    expect(waiters.map(step => step.artifacts.length)).toEqual([1, 1]);
    expect(new Set(waiters.flatMap(step => step.artifacts))).toEqual(new Set(downloads.map(artifact => artifact.id)));
    expect(attempt.steps.filter(step => step.api !== 'browser.waitForDownload').flatMap(step => step.artifacts)).toEqual([]);
  });

  it('publishes only replacement downloads after failures, timeout and scope reset', () => {
    for (const [index, name] of [[2, 'after-failure'], [3, 'after-throw'], [4, 'after-cancel'], [5, 'after-stream']] as const) {
      const attempt = resultByTitle(main, TITLES[index]).attempts[0]!;
      const downloads = attempt.artifacts.filter(artifact => artifact.kind === 'download');
      expect(downloads).toHaveLength(1);
      expect(downloads[0]!.path).toContain(`-${name}.bin`);
      const waiters = attempt.steps.filter(step => step.api === 'browser.waitForDownload');
      expect(waiters).toHaveLength(2);
      expect(waiters[0]!.status).not.toBe('passed');
      expect(waiters[0]!.artifacts).toEqual([]);
      expect(waiters[1]!.artifacts).toEqual([downloads[0]!.id]);
    }
    expect(events.indexOf('aborted-cancelled')).toBeLessThan(events.indexOf('release-cancelled'));
    expect(events.indexOf('release-cancelled')).toBeLessThan(events.indexOf('returned-cancelled'));
    expect(events.indexOf('returned-cancelled')).toBeLessThan(events.indexOf('read-after-cancel'));
    expect(events.filter(name => name === 'read-concurrent')).toHaveLength(1);
    expect(events.filter(name => name === 'read-nested')).toHaveLength(1);
    expect(events).not.toContain('read-stream');
    expect(events).toContain('chrome-stream-started');
    expect(events).not.toContain('chrome-stream-observer-failed');
    expect(events.indexOf('chrome-stream-observer-ready')).toBeLessThan(events.indexOf('chrome-stream-started'));
    expect(events.indexOf('chrome-stream-started')).toBeLessThan(events.indexOf('release-stream'));
  });

  it('crosses the native 128-entry limit without accumulating live downloads', () => {
    const attempt = resultByTitle(main, TITLES[6]).attempts[0]!;
    expect(attempt.artifacts.filter(artifact => artifact.kind === 'download')).toHaveLength(129);
    expect(attempt.steps.filter(step => step.api === 'browser.waitForDownload')).toHaveLength(129);
    expect(events.filter(name => name === 'read-capacity')).toHaveLength(129);
    expect(events.filter(name => name === 'returned-capacity')).toHaveLength(129);
    expect(events.filter(name => name === 'request-capacity')).toHaveLength(129);
    expect(events.filter(name => name === 'chrome-capacity-started')).toHaveLength(129);
    expect(events).not.toContain('chrome-capacity-observer-failed');
    expect(events.indexOf('chrome-capacity-observer-ready')).toBeLessThan(events.indexOf('chrome-capacity-started'));
  });

  it('distinguishes Chrome burst throttling from missing native events', () => {
    const result = resultByTitle(main, BURST);
    expect(result.status, JSON.stringify(result.attempts)).toBe('passed');
    expect(result.attempts[0]!.cleanup).toBe('complete');
    expect(result.attempts[0]!.artifacts.filter(artifact => artifact.kind === 'download')).toHaveLength(2);
    expect(events).toContain('release-burst-eleven-clicks-under-second');
    expect(events.filter(name => name === 'request-burst')).toHaveLength(11);
    expect(events.filter(name => name === 'chrome-burst-started')).toHaveLength(11);
    expect(events).not.toContain('chrome-burst-observer-failed');
    expect(events.indexOf('chrome-burst-observer-ready')).toBeLessThan(events.indexOf('chrome-burst-started'));
  });

  it('interrupts a real held read, completes cleanup and downloads in a new attempt', () => {
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.exitCode).toBe(130);
    const attempt = resultByTitle(interrupted, INTERRUPTED).attempts[0]!;
    expect(attempt.cleanup).toBe('complete');
    expect(attempt.artifacts.filter(artifact => artifact.kind === 'download')).toEqual([]);
    expect(events.indexOf('read-interrupt')).toBeLessThan(events.indexOf('aborted-interrupt'));
    expect(events).toContain('release-interrupt-tap-finished');
    expect(events.indexOf('release-interrupt-tap-finished')).toBeLessThan(events.indexOf('aborted-interrupt'));
    expect(events.indexOf('aborted-interrupt')).toBeLessThan(events.indexOf('release-interrupt'));
    expect(events.filter(name => name === 'returned-interrupt')).toHaveLength(1);
    expect(resultByTitle(recovered, RECOVERED).status).toBe('passed');
    expect(resultByTitle(recovered, RECOVERED).attempts[0]!.cleanup).toBe('complete');
  });

  it('leaves no unreported download file or unhandled rejection after all cleanup', () => {
    for (const { outcome, project } of completed) {
      const reported = outcome.results.flatMap(result => result.attempts.flatMap(attempt => attempt.artifacts.filter(artifact => artifact.kind === 'download').map(artifact => artifact.path!)));
      expect(downloadFiles(path.join(project.dir, '.e2e', 'results')).toSorted()).toEqual(reported.toSorted());
      expect(outcome.report.run.errors).toEqual([]);
    }
    expect(events.filter(name => name === 'lease-released')).toHaveLength(3);
    expect(unhandled).toEqual([]);
  });
});
