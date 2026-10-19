import { ConfigurationError, defineEngine, rejectUnknownKeys, type EngineHandle, type LocatorActionKind, type PointerActionKind } from 'e2e/engine';
import { AgentBrowserSurface, type AgentBrowserOptions } from './surface.ts';
import { createBrowserFixture } from './browser.ts';
import { validateProtectedOptions, protectedSecrets } from './protected.ts';
import { asBrowserProvider } from './provider.ts';
import { validateVideoOptions } from './video.ts';
import { validateConnect } from './connection-source.ts';

/** Core cache keys include name + SPI, not package version. Bump this semantic epoch on incompatible changes. */
export const ENGINE_NAME = 'agent-browser-exact-3';
export const ENGINE_VERSION = '0.0.0-ab.0.39.1-exact.2-cdp.3';
const ACTIONS = ['tap', 'doubleTap', 'secondaryTap', 'longPress', 'fill', 'clear', 'press', 'check', 'uncheck', 'focus', 'hover', 'scrollIntoView', 'selectOption', 'setInputFiles', 'dragTo', 'swipe'] as const satisfies readonly LocatorActionKind[];
const POINTER = ['tap', 'doubleTap', 'secondaryTap', 'longPress', 'hover', 'dragTo', 'swipe', 'swipeTo'] as const satisfies readonly PointerActionKind[];

/** Public EngineHandle1 implementation; no import of @e2e-dev/web or its internals. */
export function agentBrowser(options: AgentBrowserOptions = {}): EngineHandle {
  rejectUnknownKeys('agentBrowser()', options, ['executable', 'executablePath', 'args', 'viewport', 'testIdAttribute', 'headers', 'basicAuth', 'userAgent', 'locale', 'timezoneId', 'initScripts', 'colorScheme', 'reducedMotion', 'browser', 'screencast', 'connect']);
  validateProtectedOptions(options);
  if (options.connect !== undefined) {
    const connect = validateConnect(options.connect);
    if (connect.scope !== 'attempt') throw new ConfigurationError('INVALID_CONFIG', 'agentBrowser requires a dedicated browser endpoint per attempt; shared or worker-scoped connect endpoints are unsupported. Set connect.scope to attempt and supply a browser with no unrelated contexts, pages, or users');
    if (options.browser !== undefined || options.executablePath !== undefined || options.args !== undefined) throw new ConfigurationError('INVALID_CONFIG', 'agentBrowser connect cannot combine with browser selection or local launch options');
    options = { ...options, connect };
  }
  if (options.screencast) rejectUnknownKeys('agentBrowser screencast', options.screencast, ['size', 'quality', 'ffmpegPath']);
  validateVideoOptions(options.screencast ?? {});
  if (options.browser !== undefined && options.browser !== 'chromium') {
    if (typeof options.browser !== 'object' || options.browser === null) throw new ConfigurationError('INVALID_CONFIG', 'agentBrowser supports Chromium or a browser provider');
    const provider = asBrowserProvider(options.browser);
    if (provider.scope !== 'attempt') throw new ConfigurationError('INVALID_CONFIG', 'agentBrowser requires a dedicated browser endpoint per attempt; shared or worker-scoped browser providers are unsupported. Use an attempt-scoped provider with no unrelated contexts, pages, or users');
    if (options.executablePath !== undefined || options.args !== undefined) throw new ConfigurationError('INVALID_CONFIG', 'Remote browser providers cannot use local launch arguments or paths');
  }
  if (options.viewport && (!Number.isInteger(options.viewport.width) || !Number.isInteger(options.viewport.height) || options.viewport.width <= 0 || options.viewport.height <= 0)) throw new ConfigurationError('INVALID_CONFIG', 'agentBrowser viewport must have positive integer width and height');
  if (options.args?.some((arg) => /^--(remote-debugging|user-data-dir|profile-directory)/.test(arg))) throw new ConfigurationError('INVALID_CONFIG', 'agentBrowser owns browser endpoint and profile isolation');
  const surface = new AgentBrowserSurface(options);
  return defineEngine({
    name: ENGINE_NAME, version: ENGINE_VERSION, spiVersion: 1, platform: 'web',
    secrets: protectedSecrets(options),
    validateApp(app) {
      for (const key of ['bundleId', 'appPath', 'launchArguments', 'permissions'] as const) if (app[key] !== undefined) throw new ConfigurationError('INVALID_CONFIG', 'agentBrowser cannot launch a native application');
    },
    prepare: (info) => surface.prepare(info),
    finish: (info) => surface.finish(info),
    init: (info) => surface.init(info),
    startAttempt: (context) => surface.startAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    settleAttempt: (context) => surface.settle(context),
    dispose: (context) => surface.dispose(context),
    observe: (context, observeOptions) => surface.observe(context, observeOptions),
    locate: (expression, context) => surface.locate(expression, context),
    perform: (ref, action, context) => surface.perform(ref, action, context),
    actions: ACTIONS, tapModifiers: true,
    performAt: (point, action, context) => surface.pointer(point, action, context), pointerActions: POINTER,
    keyboard: { press: (key, context) => surface.pressKey(key, context), type: (text, input, context) => surface.typeText(text, input.replace, context) },
    session: { open: (url, context) => surface.open(url, context), back: (context) => surface.back(context), restart: (context) => surface.restart(context), reset: (context) => surface.reset(context) },
    state: { capture: (context) => surface.capture(context), restore: (state, context) => surface.restore(state, context) },
    artifacts: { screenshot: (_label, context) => surface.screenshot(context), startVideo: context => surface.startVideo(context), stopVideo: context => surface.stopVideo(context) },
    fixtures: { browser: (context) => createBrowserFixture(surface, context) },
  });
}
