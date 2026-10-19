import { test as base } from 'e2e';
import type { Browser } from './browser.ts';
export { agentBrowser, ENGINE_NAME, ENGINE_VERSION } from './engine.ts';
export type { AgentBrowserOptions } from './surface.ts';
export type { Browser, BrowserExpectation } from './browser.ts';
export type { RouteContinueOverrides, RouteFulfillResponse, WebResponse, WebRoute } from './network.ts';
export const test = base.extend<{ browser: Browser }>();
export const { describe, beforeEach, afterEach, beforeAll, afterAll } = test;

export type { BrowserProvider, BrowserLease, BrowserRequest, BrowserReleaseContext, BrowserDownloadContext, BrowserProviderDownloads } from './provider.ts';
export type { ScreencastOptions } from './video.ts';

export type { BrowserConnect, CdpEndpointResolver } from './connection-source.ts';
