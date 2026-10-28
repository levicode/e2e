/** Bounded #34 supplement; run identical bytes on original and native candidate. */
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

async function count(label: string, read: () => Promise<number>, expected: number): Promise<void> {
  expect({ label, count: await read() }).toEqual({ label, count: expected });
}

test('public union boundaries: actual scope root and ordinary CSS exclusion', async ({ app, browser }) => {
  await app.open();
  await browser.evaluate(() => { document.body.innerHTML = '<section id="scope"><span id="child">child</span></section>'; return null; });
  const root = browser.locator('#scope');
  const self = browser.locator('css=:scope');
  const missing = browser.locator('#missing');
  await count('scope union retains issued root', () => root.filter({ has: self.or(missing) }).count(), 1);
  await count('reversed scope union retains issued root', () => root.filter({ has: missing.or(self) }).count(), 1);
  await count('scope duplicate is deduplicated', () => root.filter({ has: self.or(self).nth(1) }).count(), 0);
  await count('ordinary ID does not become self matching', () => root.filter({ has: browser.locator('#scope').or(missing) }).count(), 0);
  await count('ordinary descendant remains matched', () => root.filter({ has: browser.locator('#child').or(missing) }).count(), 1);
  await count('nested scope union retains root', () => root.filter({ has: self.or(missing).filter({ has: self }) }).count(), 1);
});

test('public union boundaries: frame-local root and nested ordering', async ({ app, browser }) => {
  await app.open();
  await browser.evaluate(async () => {
    document.body.innerHTML = '<div id="outside-only">outside</div>';
    const frame = document.createElement('iframe'); frame.id = 'frame';
    frame.srcdoc = '<!doctype html><html><body><section id="scope" style="width:20px;height:20px"><span id="child" style="display:none">child</span></section></body></html>';
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('union fixture frame load timed out')), 10_000);
      frame.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    document.body.append(frame); await loaded; return null;
  });
  const root = browser.frameLocator('#frame').locator('#scope');
  const self = browser.locator('css=:scope');
  const child = browser.locator('#child');
  const missing = browser.locator('#missing');
  await count('frame scope union retains root', () => root.filter({ has: self.or(missing) }).count(), 1);
  await count('frame reversed scope union retains root', () => root.filter({ has: missing.or(self) }).count(), 1);
  await count('frame duplicate root has no second match', () => root.filter({ has: self.or(self).nth(1) }).count(), 0);
  await count('frame ancestor precedes child', () => root.filter({ has: child.or(self).first().filter({ has: browser.locator('visible=true') }) }).count(), 1);
  await count('frame child follows ancestor', () => root.filter({ has: self.or(child).last().filter({ has: browser.locator('visible=false') }) }).count(), 1);
  await count('frame ordinary ID excludes self', () => root.filter({ has: browser.locator('#scope').or(missing) }).count(), 0);
  await count('frame does not admit top-level match', () => root.filter({ has: browser.locator('#outside-only').or(missing) }).count(), 0);
  await count('missing frame remains immediate empty count', () => browser.frameLocator('#missing-frame').locator('#scope').filter({ has: self.or(missing) }).count(), 0);
});

test('public union boundaries: secure values stay withheld after scoped union', async ({ app, browser }) => {
  await app.open();
  await browser.evaluate(() => {
    document.body.innerHTML = '<section id="scope"><input id="private" type="password"><input id="ordinary"><div id="closed-host"></div></section>';
    (document.querySelector('#private') as HTMLInputElement).value = 'union-private-sentinel-34';
    (document.querySelector('#ordinary') as HTMLInputElement).value = 'ordinary-control-34';
    document.querySelector('#closed-host')!.attachShadow({ mode: 'closed' }).innerHTML = '<span id="closed-child">closed</span>';
    return null;
  });
  const scope = browser.locator('#scope').filter({ has: browser.locator('css=:scope').or(browser.locator('#missing')) });
  await count('secure field does not erase valid scope root', () => scope.count(), 1);
  await count('secure element ID selection is still allowed', () => browser.locator('#private').filter({ has: browser.locator('css=:scope').or(browser.locator('#missing')) }).count(), 1);
  await count('private value is not a display-value match', () => scope.getByDisplayValue('union-private-sentinel-34', { exact: true }).count(), 0);
  await count('ordinary display-value control still matches', () => scope.getByDisplayValue('ordinary-control-34', { exact: true }).count(), 1);
  await count('closed child is not admitted by raw union branch', () => scope.filter({ has: browser.locator('#closed-child').or(browser.locator('#missing')) }).count(), 0);
});
