import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { secrets } from 'e2e';
import { ConfigurationError, type OperationContext, type ResolveSecretOptions } from 'e2e/engine';
import { ProtectedContext, protectedSecrets, validateProtectedOptions, type ProtectedOptions } from '../src/protected.ts';
import type { CdpConnection } from '../src/cdp.ts';

const operation: OperationContext = { signal: new AbortController().signal, timeoutMs: 2_000, runId: 'r', attemptId: 'a', origin: 'test' };
const challenge = (origin: string) => ({ source: 'Server', origin, scheme: 'Basic', realm: 'private' });

function invalid(action: () => unknown, secret = ''): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.equal(error.code, 'INVALID_CONFIG');
    if (secret) assert.ok(!`${error.message}${error.stack}`.includes(secret));
    return true;
  });
}

test('headers use the public app-site rule and exclude malformed/non-network destinations', async () => {
  const context = new ProtectedContext({ headers: { 'X-Preview': 'secret', Authorization: 'Bearer credential' } }, 'example.test');
  await context.prepare('.', async () => 'unused');
  assert.deepEqual({ ...context.siteHeaders('https://preview.example.test/page') }, { 'x-preview': 'secret', authorization: 'Bearer credential' });
  assert.ok(context.siteHeaders('https://example.test:8443/subresource'));
  for (const url of ['https://example.test.evil.test/', 'https://unrelated.test/', 'file://example.test/private', 'not a URL']) assert.equal(context.siteHeaders(url), undefined);
  assert.deepEqual(context.configuredHeaderNames, ['x-preview', 'authorization']);
  assert.ok(Object.isFrozen(context.siteHeaders('https://example.test/')));
});

test('headers and default auth fail closed without a configured app site', () => {
  invalid(() => new ProtectedContext({ headers: { 'X-Private': 'value' } }));
  invalid(() => new ProtectedContext({ basicAuth: { username: 'user', password: 'value' } }));
  assert.doesNotThrow(() => new ProtectedContext({ headers: {} }));
});

test('basic auth defaults to app-site and validates actual server challenge origin', async () => {
  const context = new ProtectedContext({ basicAuth: { username: 'user', password: 'secret' } }, 'example.test');
  await context.prepare('.', async () => 'unused');
  assert.deepEqual(context.authorization('https://example.test/'), { username: 'user', password: 'secret' });
  assert.ok(context.authorization('https://login.example.test:8443/'));
  assert.equal(context.authorization('https://unrelated.test/'), undefined);
  assert.equal(context.credentials('https://example.test/', challenge('https://evil.test')), undefined);
  assert.equal(context.credentials('https://example.test/', { ...challenge('https://example.test'), source: 'Proxy' }), undefined);
  assert.equal(context.credentials('https://example.test/', { ...challenge('https://example.test'), scheme: 'Digest' }), undefined);
  assert.deepEqual(context.credentials('https://example.test/', challenge('https://example.test')), { username: 'user', password: 'secret' });
});

test('explicit any-origin auth opts into broader server challenges but never proxy or file scopes', async () => {
  const context = new ProtectedContext({ basicAuth: { username: 'user', password: 'secret', scope: 'any-origin' } });
  await context.prepare('.', async () => 'unused');
  assert.ok(context.credentials('https://another.test/', challenge('https://another.test')));
  assert.equal(context.authorization('file:///private'), undefined);
  assert.equal(context.credentials('https://another.test/', { ...challenge('https://another.test'), source: 'Proxy' }), undefined);
});

test('configuration validation rejects injection and conflicting overrides without echoing values', () => {
  for (const options of [
    { headers: { 'X-Token': 'private\r\nInjected: true' } },
    { headers: { 'X-Bad\n': 'private' } },
    { headers: { 'X-Value': 'private', 'x-value': 'different' } },
    { basicAuth: { username: 'bad:name', password: 'private' } },
    { basicAuth: { username: 'user', password: 'private', scope: 'all' } },
    { userAgent: 'private\nAgent' },
    { userAgent: 'agent', headers: { 'User-Agent': 'private' } },
    { locale: 'en-US', headers: { 'Accept-Language': 'private' } },
    { locale: 'und' }, { locale: 'not a tag' },
    { timezoneId: '+01:00' }, { timezoneId: 'europe/berlin' },
    { initScripts: [{ path: 'private', extra: true }] },
  ]) invalid(() => validateProtectedOptions(options as ProtectedOptions), 'private');
  assert.doesNotThrow(() => validateProtectedOptions({ headers: { 'X-Tab': 'allowed\ttab' }, locale: 'de-DE', timezoneId: 'Europe/Berlin' }));
});

test('declared secrets include header handles and Basic password once', async () => {
  const token = secrets.get('token');
  const password = secrets.get('password');
  const options = { headers: { Authorization: token, 'X-Token': token }, basicAuth: { username: 'user', password } };
  assert.deepEqual(protectedSecrets(options), [token, password]);
  const resolutions: Array<{ name: string; options?: ResolveSecretOptions }> = [];
  const context = new ProtectedContext(options, 'example.test');
  await context.prepare('.', async (secret, settings) => {
    resolutions.push({ name: secret.name, ...(settings ? { options: settings } : {}) });
    return secret.name === 'token' ? 'Bearer private' : 'sensitive-password';
  });
  assert.equal(context.siteHeaders('https://example.test/')?.authorization, 'Bearer private');
  const derived = resolutions.find((entry) => entry.name === 'password')?.options?.derived?.('sensitive-password');
  const encoded = Buffer.from('user:sensitive-password').toString('base64');
  assert.ok(derived?.includes(encoded));
  assert.ok(derived?.includes(encoded.replace(/=+$/, '')));
  assert.ok(derived?.includes(`Basic ${encoded}`));
});

test('resolved secret header injection is rejected without disclosing secret text', async () => {
  const context = new ProtectedContext({ headers: { Authorization: secrets.get('token') } }, 'example.test');
  await assert.rejects(context.prepare('.', async () => 'UNIQUE-SECRET\nInjected: true'), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.ok(!error.message.includes('UNIQUE-SECRET'));
    return true;
  });
  assert.throws(() => context.siteHeaders('https://example.test/'), { code: 'INVALID_STATE' });
});

test('option mutation after controller construction cannot broaden scope or change headers', async () => {
  const options: { headers: Record<string, string>; basicAuth: { username: string; password: string; scope?: 'app-site' | 'any-origin' } } = { headers: { 'X-Token': 'original' }, basicAuth: { username: 'user', password: 'original' } };
  const context = new ProtectedContext(options, 'example.test');
  options.headers['X-Token'] = 'changed'; options.basicAuth.scope = 'any-origin'; options.basicAuth.password = 'changed';
  await context.prepare('.', async () => 'unused');
  assert.equal(context.siteHeaders('https://example.test/')?.['x-token'], 'original');
  assert.equal(context.authorization('https://elsewhere.test/'), undefined);
  assert.equal(context.authorization('https://example.test/')?.password, 'original');
});

test('configured locale/timezone/media/init scripts install on the specified session before resume', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ab-protected-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'init.js'), 'globalThis.fromFile = true');
  const context = new ProtectedContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin', colorScheme: 'dark', reducedMotion: 'reduce', initScripts: [{ path: 'init.js' }, () => { Object.defineProperty(globalThis, 'fromFunction', { value: true }); }] }, 'example.test');
  await context.prepare(directory, async () => 'unused');
  const calls: Array<{ method: string; params: Record<string, unknown>; session?: string }> = [];
  const connection = { async send(method: string, params: Record<string, unknown>, _context: OperationContext, session?: string) {
    calls.push({ method, params, ...(session ? { session } : {}) });
    return method === 'Browser.getVersion' ? { userAgent: 'default-native-agent' } : {};
  } };
  await context.configureSession(connection as unknown as CdpConnection, 'new-frame', operation);
  const override = calls.find((call) => call.method === 'Network.setUserAgentOverride');
  assert.deepEqual(override?.params, { userAgent: 'default-native-agent', acceptLanguage: 'de-DE' });
  assert.equal(override?.session, 'new-frame');
  assert.equal(calls.filter((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument').length, 2);
  assert.ok(calls.some((call) => call.method === 'Emulation.setTimezoneOverride' && call.params.timezoneId === 'Europe/Berlin'));
  assert.ok(calls.filter((call) => call.method !== 'Browser.getVersion').every((call) => call.session === 'new-frame'));
});

test('missing init scripts report a static error and leave configuration unprepared', async () => {
  const context = new ProtectedContext({ initScripts: [{ path: 'private-secret-path/does-not-exist' }] });
  await assert.rejects(context.prepare('/tmp', async () => 'unused'), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.ok(!error.message.includes('private-secret-path'));
    return true;
  });
  assert.throws(() => context.authorization('https://example.test/'), { code: 'INVALID_STATE' });
});
