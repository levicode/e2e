/** Execute only P41's page function against Node stubs; no browser or native process is started. */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../integration/protected-app.test.ts', import.meta.url), 'utf8');
const pageFunction = source.slice(source.indexOf('    const registrations = ') + '    const registrations = '.length).split('\n    const evidence = ')[0]!.trim().replace(/;$/, '');
const stages = ['register-invoked', 'register-settled', 'get-invoked', 'get-settled'].map(stage => `P41:service-worker:${stage}`);

/** Run the exact page body with inert browser-API and console substitutes. */
function registrations(register: (url: string) => Promise<unknown>, getRegistrations: () => Promise<unknown[]>, messages: unknown[][]): () => Promise<number> {
  return runInNewContext(`(${pageFunction.replace('(): Promise<number>', '()')})`, {
    navigator: { serviceWorker: { register, getRegistrations } },
    console: { info: (...args: unknown[]) => { messages.push(args); } },
  }) as () => Promise<number>;
}

/** Hold one Node stub operation so the marker boundary can be checked without polling. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('P41 Promise marker source contract', () => {
  it('preserves two awaits, one caught registration and one get, with only four literal info markers', () => {
    expect(pageFunction.match(/\bawait\b/g)).toHaveLength(2);
    expect(pageFunction.match(/navigator\.serviceWorker\.register\('\/sw\.js'\)\.catch\(\(\) => undefined\)/g)).toHaveLength(1);
    expect(pageFunction.match(/navigator\.serviceWorker\.getRegistrations\(\)/g)).toHaveLength(1);
    expect([...pageFunction.matchAll(/console\.info\('([^']+)'\)/g)].map(match => match[1])).toEqual(stages);
    expect(pageFunction.match(/console\./g)).toHaveLength(4);
    expect(pageFunction).not.toMatch(/\bPromise\.(?:all|race|resolve|reject)|new Promise|setTimeout|setInterval|while\s*\(/);
    expect(source.match(/\.evaluate\(registrations\)/g)).toHaveLength(2);
    expect(source).toContain('observer.assert(0, () => expect(count).toBe(1))');
    expect(source).toContain('expect(count).toBe(0)');
    expect(source.match(/timeoutMs: 30_000/g)).toHaveLength(2);
  });
  it('uses the existing appLog route only in the two P41 boots and preserves ignoreTrace defaults', () => {
    expect(source).toContain('...ignoreTrace, ...(appLog === undefined ? {} : { appLog })');
    expect(source.match(/promiseLog\('/g)).toHaveLength(2);
    expect(source).toContain("boot(plain, app, artifactsDir, 's0', undefined, promiseLog('plain'))");
    expect(source).toContain("boot(engine, app, artifactsDir, 's1', undefined, promiseLog('headers-blocked'))");
  });
  it('emits invocation before each await and settlement only after its Promise resolves', async () => {
    const messages: unknown[][] = [];
    const registration = deferred<unknown>();
    const query = deferred<unknown[]>();
    const getInvoked = deferred<void>();
    let registerCalls = 0; let getCalls = 0;
    const run = registrations(url => { expect(url).toBe('/sw.js'); registerCalls++; return registration.promise; }, () => { getCalls++; getInvoked.resolve(); return query.promise; }, messages);
    const pending = run();
    expect(messages).toEqual([[stages[0]]]);
    expect(registerCalls).toBe(1); expect(getCalls).toBe(0);
    registration.resolve(undefined);
    await getInvoked.promise;
    expect(messages).toEqual(stages.slice(0, 3).map(stage => [stage]));
    expect(getCalls).toBe(1);
    query.resolve([{}]);
    expect(await pending).toBe(1);
    expect(messages).toEqual(stages.map(stage => [stage]));
  });
  it('reports settled after caught rejection without implying that registration succeeded', async () => {
    const messages: unknown[][] = [];
    const run = registrations(() => Promise.reject(new Error('private rejection')), () => Promise.resolve([]), messages);
    expect(await run()).toBe(0);
    expect(messages).toEqual(stages.map(stage => [stage]));
  });
  it('does not report invocation if register throws before returning its caught Promise', async () => {
    const messages: unknown[][] = [];
    const failure = new Error('register threw');
    const run = registrations(() => { throw failure; }, () => Promise.resolve([]), messages);
    await expect(run()).rejects.toBe(failure);
    expect(messages).toEqual([]);
  });
  it('does not report get invocation if getRegistrations throws before returning a Promise', async () => {
    const messages: unknown[][] = [];
    const failure = new Error('get threw');
    const run = registrations(() => Promise.resolve(undefined), () => { throw failure; }, messages);
    await expect(run()).rejects.toBe(failure);
    expect(messages).toEqual(stages.slice(0, 2).map(stage => [stage]));
  });
  it('preserves get rejection and never emits get-settled on that path', async () => {
    const messages: unknown[][] = [];
    const failure = new Error('get rejected');
    const run = registrations(() => Promise.resolve(undefined), () => Promise.reject(failure), messages);
    await expect(run()).rejects.toBe(failure);
    expect(messages).toEqual(stages.slice(0, 3).map(stage => [stage]));
  });
});
