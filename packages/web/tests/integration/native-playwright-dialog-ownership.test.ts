/** Real native/PW dialog ownership. Run this unchanged on baseline and candidate.
 * No raw dialog observer is installed on the held-decision control: such an
 * observer would itself disable Playwright's automatic dismissal. */
import { expect, it } from 'vitest';
import type { Dialog as PlaywrightDialog } from 'playwright-core';
import { dialogBounded, dialogGate, dialogListeners, withNativeDialogFixture } from '../helpers/native-dialog-fixture.ts';

it('installs passive ownership before isolated app code can run', async () => {
  await withNativeDialogFixture('before-app', 'isolated', async ({ engine, live, url, operation, facts }) => {
    const context = live.context();
    const reserved = context.pages()[0]!;
    facts['reservedBlank'] = reserved.url() === 'about:blank';
    facts['contextDialogListenersBeforeOpen'] = dialogListeners(context).length;
    expect(reserved.url()).toBe('about:blank');
    expect(dialogListeners(context).length).toBe(1);
    expect(dialogListeners(reserved).length).toBe(0);
    await engine.session!.open!(url, operation());
    expect(live.page()).toBe(reserved);
  });
}, 95000);

it('keeps a native-held prompt open across a read-only Playwright CDP barrier', async () => {
  await withNativeDialogFixture('held-decision', 'isolated', async ({ engine, browser, live, url, operation, facts }) => {
    await engine.session!.open!(url, operation());
    const page = live.page();
    const context = live.context();
    const release = dialogGate();
    const nativeEntered = dialogGate();
    const opened = dialogGate();
    const pageCdp = await context.newCDPSession(page);
    const browserCdp = await context.browser()!.newBrowserCDPSession();
    let closed = false;
    let nativeDecisionStarted = false;
    let response: Promise<string | null> | undefined;
    const onOpening = () => { opened.resolve(); };
    const onClosed = () => { closed = true; };
    pageCdp.on('Page.javascriptDialogOpening', onOpening);
    pageCdp.on('Page.javascriptDialogClosed', onClosed);
    try {
      await pageCdp.send('Page.enable');
      const { targetInfo: capturedTarget } = await dialogBounded(pageCdp.send('Target.getTargetInfo'), 'capture exact prompt target');
      expect(capturedTarget.type).toBe('page');
      expect(capturedTarget.targetId).not.toBe('');
      expect(capturedTarget.browserContextId).toBeTypeOf('string');
      expect(capturedTarget.browserContextId).not.toBe('');
      await browser.onDialog(async dialog => {
        facts['nativeHandlerEntered'] = true;
        nativeEntered.resolve();
        await release.promise;
        nativeDecisionStarted = true;
        await dialog.accept('native answer');
        facts['nativeDecisionPromiseResolved'] = true;
      });
      facts['rawPageObservers'] = dialogListeners(page).length;
      facts['rawContextListeners'] = dialogListeners(context).length;
      expect(dialogListeners(page).length).toBe(0);
      response = page.evaluate(() => prompt('held prompt', 'initial'));
      void response.catch(() => undefined);
      await dialogBounded(Promise.all([opened.promise, nativeEntered.promise]), 'both real dialog opening observations');
      // Both held-dialog markers stay on the browser session: Page.getFrameTree
      // depends on the renderer, which the held modal can block. Its completion
      // must not be required before the test permits the native decision.
      // Target.getTargetInfo reads the captured target's browser-side identity.
      // These responses share PW's Chromium connection; cross-session event
      // ordering is still not asserted. Actual early-close/answer is the witness.
      await dialogBounded(browserCdp.send('Browser.getVersion'), 'browser marker');
      facts['browserMarkerCompleted'] = true;
      const { targetInfo: heldTarget } = await dialogBounded(browserCdp.send('Target.getTargetInfo', { targetId: capturedTarget.targetId }), 'exact target browser marker');
      facts['targetMarkerMatched'] = heldTarget.targetId === capturedTarget.targetId
        && heldTarget.type === capturedTarget.type && heldTarget.browserContextId === capturedTarget.browserContextId;
      expect(facts['targetMarkerMatched']).toBe(true);
      facts['barrierCompleted'] = true;
      facts['closedBeforeNativeDecision'] = closed;
      facts['decisionStartedBeforeRelease'] = nativeDecisionStarted;
      release.resolve();
      const answer = await dialogBounded(response, 'real prompt settlement');
      facts['nativeAnswerReachedApplication'] = answer === 'native answer';
      facts['promptWasDismissed'] = answer === null;
      expect(nativeDecisionStarted).toBe(true);
      expect(facts['decisionStartedBeforeRelease']).toBe(false);
      expect(facts['closedBeforeNativeDecision']).toBe(false);
      expect(answer).toBe('native answer');
      expect(await browser.title()).toBe('Dialog fixture');
    } finally {
      release.resolve();
      pageCdp.off('Page.javascriptDialogOpening', onOpening);
      pageCdp.off('Page.javascriptDialogClosed', onClosed);
      await browserCdp.detach();
      await pageCdp.detach();
      if (response !== undefined) await dialogBounded(response.catch(() => undefined), 'released prompt settlement');
    }
  });
}, 95000);

it('delivers the genuine Dialog to raw observers and removes only its own context listener', async () => {
  await withNativeDialogFixture('raw-observers', 'isolated', async ({ engine, browser, live, url, operation, facts }) => {
    await engine.session!.open!(url, operation());
    const context = live.context();
    const page = live.page();
    let contextDialog: PlaywrightDialog | undefined;
    let pageDialog: PlaywrightDialog | undefined;
    const contextObserved = dialogGate();
    const pageObserved = dialogGate();
    const contextObserver = (dialog: PlaywrightDialog) => { contextDialog = dialog; contextObserved.resolve(); };
    const pageObserver = (dialog: PlaywrightDialog) => { pageDialog = dialog; pageObserved.resolve(); };
    context.on('dialog', contextObserver);
    page.on('dialog', pageObserver);
    try {
      await browser.onDialog(async dialog => { await dialog.accept('observed answer'); });
      expect(await dialogBounded(page.evaluate(() => prompt('observed prompt', 'initial')), 'observed native answer')).toBe('observed answer');
      await dialogBounded(Promise.all([contextObserved.promise, pageObserved.promise]), 'raw observer delivery');
      expect(pageDialog).toBe(contextDialog);
      expect(pageDialog!.page()).toBe(page);
      expect(pageDialog!.type()).toBe('prompt');
      expect(pageDialog!.message()).toBe('observed prompt');
      expect(pageDialog!.defaultValue()).toBe('initial');
      expect(Object.hasOwn(pageDialog!, 'accept')).toBe(false);
      expect(Object.hasOwn(pageDialog!, 'dismiss')).toBe(false);
      expect(typeof Object.getPrototypeOf(pageDialog!).accept).toBe('function');
      expect(typeof Object.getPrototypeOf(pageDialog!).dismiss).toBe('function');
      facts['sameGenuineDialog'] = contextDialog === pageDialog && pageDialog!.page() === page;
      expect(await browser.title()).toBe('Dialog fixture');
      await engine.endAttempt!(operation());
      expect(dialogListeners(context)).toEqual([contextObserver]);
      expect(dialogListeners(page)).toEqual([pageObserver]);
      facts['ownListenerRemovedUserListenersPreserved'] = true;
    } finally {
      context.off('dialog', contextObserver);
      page.off('dialog', pageObserver);
    }
  });
}, 95000);

it('retains native no-handler dismissal and the existing unhandled-dialog failure', async () => {
  await withNativeDialogFixture('no-handler', 'isolated', async ({ engine, browser, live, url, operation, facts }) => {
    await engine.session!.open!(url, operation());
    const page = live.page();
    expect(dialogListeners(page).length).toBe(0);
    expect(await dialogBounded(page.evaluate(() => prompt('unhandled prompt')), 'native default dismissal')).toBeNull();
    facts['applicationObservedDismissal'] = true;
    await expect(browser.title()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    facts['unhandledDialogErrorPreserved'] = true;
  });
}, 95000);

it('keeps native decisions for script-created popups and an isolated replacement', async () => {
  await withNativeDialogFixture('popup-replacement', 'isolated', async ({ engine, browser, live, url, operation, facts }) => {
    await engine.session!.open!(url, operation());
    const oldContext = live.context();
    const rootPage = live.page();
    let handlers = 0;
    await browser.onDialog(async dialog => { handlers++; await dialog.accept('owned answer'); });
    const popupReady = oldContext.waitForEvent('page', { timeout: 5000 });
    await rootPage.evaluate(popupUrl => { window.open(popupUrl); }, new URL('/popup', url).href);
    const popup = await popupReady;
    await popup.waitForLoadState('load', { timeout: 5000 });
    expect(await popup.evaluate(() => (globalThis as typeof globalThis & { answer?: string | null }).answer)).toBe('owned answer');
    expect(live.page()).toBe(rootPage);
    facts['popupNativeAnswer'] = true;
    await engine.session!.reset!(operation());
    const replacementContext = live.context();
    expect(replacementContext).not.toBe(oldContext);
    expect(dialogListeners(oldContext).length).toBe(0);
    expect(dialogListeners(replacementContext).length).toBe(1);
    expect(popup.isClosed()).toBe(true);
    await engine.session!.open!(url, operation());
    const replacement = live.page();
    expect(await dialogBounded(replacement.evaluate(() => prompt('replacement prompt')), 'replacement native answer')).toBe('owned answer');
    expect(handlers).toBe(2);
    expect(await browser.title()).toBe('Dialog fixture');
    facts['replacementNativeAnswer'] = true;
    facts['nativeHandlers'] = handlers;
  });
}, 95000);

it('guards only the exact borrowed Page, rebinds its replacement, and leaves a sibling untouched', async () => {
  await withNativeDialogFixture('borrowed-exact-page', 'persistent', async ({ engine, browser, live, url, operation, facts }) => {
    const context = live.context();
    const original = context.pages()[0]!;
    expect(dialogListeners(context).length).toBe(0);
    expect(dialogListeners(original).length).toBe(1);
    await engine.session!.open!(url, operation());
    let handlers = 0;
    await browser.onDialog(async dialog => { handlers++; await dialog.accept('borrowed answer'); });
    const foreign = await context.newPage();
    expect(dialogListeners(foreign).length).toBe(0);
    expect(await dialogBounded(foreign.evaluate(() => prompt('foreign prompt')), 'untouched sibling default')).toBeNull();
    expect(handlers).toBe(0);
    expect(await dialogBounded(original.evaluate(() => prompt('owned borrowed prompt')), 'borrowed native answer')).toBe('borrowed answer');
    expect(handlers).toBe(1);
    await original.close();
    expect(dialogListeners(original).length).toBe(0);
    await engine.session!.open!(url, operation());
    const replacement = live.page();
    expect(replacement).not.toBe(original);
    expect(replacement).not.toBe(foreign);
    expect(dialogListeners(context).length).toBe(0);
    expect(dialogListeners(replacement).length).toBe(1);
    expect(dialogListeners(foreign).length).toBe(0);
    expect(await dialogBounded(replacement.evaluate(() => prompt('reopened borrowed prompt')), 'reopened native answer')).toBe('borrowed answer');
    expect(handlers).toBe(2);
    expect(foreign.isClosed()).toBe(false);
    const observer = (_dialog: PlaywrightDialog) => undefined;
    replacement.on('dialog', observer);
    try {
      await engine.endAttempt!(operation());
      expect(dialogListeners(replacement)).toEqual([observer]);
      expect(dialogListeners(context).length).toBe(0);
      facts['ownListenerRemovedUserListenerPreserved'] = true;
    } finally { replacement.off('dialog', observer); }
    facts['siblingAutoDismissedWithoutNativeHandler'] = true;
    facts['exactReplacementNativeAnswer'] = true;
    facts['nativeHandlers'] = handlers;
  });
}, 95000);
