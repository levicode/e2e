/** Every original fixture method remains a public, typed part of the replacement. */
import type { Browser, BrowserExpectation, FrameScreen } from '../../src/index.ts';
import type { Expectable, Screen } from 'e2e';

const browserMembers = [
  'goto', 'reload', 'back', 'forward', 'url', 'title', 'waitForURL', 'locator', 'frameLocator',
  'evaluate', 'addInitScript', 'route', 'unroute', 'unrouteAll', 'waitForResponse', 'cookies',
  'setCookies', 'setViewport', 'emulateMedia', 'onDialog', 'waitForDownload', 'keyboard', 'mouse',
] as const satisfies readonly (keyof Browser)[];
const keyboardMembers = ['press', 'down', 'up', 'type'] as const satisfies readonly (keyof Browser['keyboard'])[];
const mouseMembers = ['move', 'wheel', 'down', 'up'] as const satisfies readonly (keyof Browser['mouse'])[];
const expectationMembers = ['not', 'toHaveURL', 'toHaveTitle', 'toHaveClass'] as const satisfies readonly (keyof BrowserExpectation)[];
const frameMembers = ['locator', 'frameLocator'] as const satisfies readonly (keyof FrameScreen)[];

type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type Assert<T extends true> = T;
type BrowserKeys = Assert<Equal<typeof browserMembers[number], Exclude<keyof Browser, keyof Expectable<BrowserExpectation>>>>;
type KeyboardKeys = Assert<Equal<typeof keyboardMembers[number], keyof Browser['keyboard']>>;
type MouseKeys = Assert<Equal<typeof mouseMembers[number], keyof Browser['mouse']>>;
type ExpectationKeys = Assert<Equal<typeof expectationMembers[number], keyof BrowserExpectation>>;
type FrameKeys = Assert<Equal<typeof frameMembers[number], Exclude<keyof FrameScreen, keyof Screen>>>;

const contracts: [BrowserKeys, KeyboardKeys, MouseKeys, ExpectationKeys, FrameKeys] = [true, true, true, true, true];
void contracts;

/** Current native scope is explicit rather than accepting options that cannot run. */
const supportedOptions: import('../../src/web-options.ts').WebOptions = {
  browser: 'chromium', viewport: null,
  connect: { cdpEndpoint: () => 'http://localhost:9222', reconnectEndpoint: async () => 'http://localhost:9222' },
  screencast: { size: { width: 640, height: 480 }, quality: 80 },
  headers: { 'x-fixture': 'synthetic' }, basicAuth: { username: 'fixture', password: 'synthetic' },
  testIdAttribute: 'data-test', userAgent: 'fixture-browser', locale: 'de-DE', timezoneId: 'Europe/Berlin',
  colorScheme: 'dark', reducedMotion: 'reduce', initScripts: ['globalThis.fixture = true'],
};
void supportedOptions;
// @ts-expect-error Other native engines require an implemented and negotiated backend, not a type-only promise.
const unsupportedBrowser: import('../../src/web-options.ts').WebOptions = { browser: 'firefox' };
void unsupportedBrowser;
