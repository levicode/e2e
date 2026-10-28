/** Identical public API assertions on original e557432 and the pinned native candidate. */
import { test, type Browser } from '@e2e-dev/web';
import { expect } from 'e2e';

async function fixture(browser: Browser): Promise<void> {
  await browser.evaluate(() => {
    document.body.innerHTML = `<div id="shown" style="width:20px;height:20px">shown</div>
<div id="hidden" style="display:none">hidden</div>
<div id="visibility-hidden" style="visibility:hidden;width:20px;height:20px">hidden</div>
<div id="zero" style="width:0;height:0;overflow:hidden">zero</div>
<div id="transparent" style="opacity:0;width:20px;height:20px">transparent</div>
<div id="contents" style="display:contents"><span style="display:inline-block;width:20px;height:20px">child</span></div>
<div id="empty-contents" style="display:contents"></div>
<ul id="rows"><li id="row-1" style="display:none">one</li><li id="row-2">two</li><li id="row-3" style="visibility:hidden">three</li><li id="row-4">four</li></ul>
<div id="open-host"></div><div id="closed-host"></div>`;
    document.querySelector('#open-host')!.attachShadow({ mode: 'open' }).innerHTML = '<span id="open-child">open</span>';
    document.querySelector('#closed-host')!.attachShadow({ mode: 'closed' }).innerHTML = '<span id="closed-child">closed</span>';
    return null;
  });
}
async function count(label: string, read: () => Promise<number>, expected: number): Promise<void> {
  expect({ label, count: await read() }).toEqual({ label, count: expected });
}

test('public visible union: rendered visibility and chain position', async ({ app, browser }) => {
  await app.open(); await fixture(browser);
  for (const [id, visible] of [['shown', true], ['hidden', false], ['visibility-hidden', false], ['zero', false], ['transparent', true], ['contents', true], ['empty-contents', false]] as const) {
    await count(`${id} visible`, () => browser.locator(`css=#${id} >> visible=true`).count(), visible ? 1 : 0);
    await count(`${id} hidden`, () => browser.locator(`css=#${id} >> visible=false`).count(), visible ? 0 : 1);
  }
  await count('visibility precedes nth', () => browser.locator('css=#rows li >> visible=true >> nth=0 >> css=:scope').count(), 1);
  await count('nth before visibility retains hidden first', () => browser.locator('css=#rows li >> nth=0 >> visible=true').count(), 0);
  await count('negative nth then visibility', () => browser.locator('css=#rows li >> nth=-1 >> visible=true').count(), 1);
  await count('scoped visible chain reaches descendants', () => browser.locator('css=#rows >> visible=true >> css=li >> visible=true').count(), 2);
});

test('public visible union: terminal element root and union admission', async ({ app, browser }) => {
  await app.open(); await fixture(browser);
  const shown = browser.locator('#shown');
  const visible = browser.locator('visible=true');
  const hidden = browser.locator('visible=false');
  await count('terminal has visible keeps root', () => shown.filter({ has: visible }).count(), 1);
  await count('terminal has hidden rejects root', () => shown.filter({ has: hidden }).count(), 0);
  await count('hidden root positive', () => browser.locator('#hidden').filter({ has: hidden }).count(), 1);
  await count('union keeps issued root', () => shown.filter({ has: visible.or(hidden) }).count(), 1);
  await count('reversed union keeps issued root', () => shown.filter({ has: hidden.or(visible) }).count(), 1);
  await count('duplicate root deduplicates', () => shown.filter({ has: visible.or(visible).nth(1) }).count(), 0);
  await count('negative union never admits root', () => shown.filter({ has: hidden.or(browser.locator('#missing')) }).count(), 0);
  await count('ordinary CSS does not self match', () => shown.filter({ has: browser.locator('#shown').or(browser.locator('#missing')) }).count(), 0);
  await count('nested union keeps root', () => shown.filter({ has: browser.locator('#missing').or(hidden.or(visible)) }).count(), 1);
  await count('nested filter keeps root', () => shown.filter({ has: visible.or(browser.locator('#missing')).filter({ has: visible }) }).count(), 1);
});

test('public visible union: DOM order and dedup inside scoped filters', async ({ app, browser }) => {
  await app.open(); await fixture(browser);
  const rows = browser.locator('#rows');
  const visible = browser.locator('visible=true');
  const hidden = browser.locator('visible=false');
  const child = browser.locator('#row-1');
  await count('ancestor precedes child regardless of union branch order', () => rows.filter({ has: child.or(visible).first().filter({ has: visible }) }).count(), 1);
  await count('child follows ancestor regardless of union branch order', () => rows.filter({ has: visible.or(child).last().filter({ has: hidden }) }).count(), 1);
  await count('duplicate ancestor has no second result', () => rows.filter({ has: visible.or(visible).nth(1) }).count(), 0);
  await count('descendant reverse branch union is DOM ordered', () => rows.filter({ has: browser.locator('#row-4').or(child).first().filter({ has: hidden }) }).count(), 1);
  await count('descendant union last follows DOM order', () => rows.filter({ has: browser.locator('#row-4').or(child).last().filter({ has: visible }) }).count(), 1);
  await count('descendant duplicate has no second result', () => rows.filter({ has: child.or(child).nth(1) }).count(), 0);
});

test('public visible union: shadow boundaries and live reevaluation', async ({ app, browser }) => {
  await app.open(); await fixture(browser);
  const visible = browser.locator('visible=true');
  await count('open shadow visible child', () => browser.locator('css=#open-child >> visible=true').count(), 1);
  await count('closed shadow remains excluded', () => browser.locator('css=#closed-child >> visible=true').count(), 0);
  await count('scoped union preserves open shadow child', () => browser.locator('#open-host').filter({ has: browser.locator('#open-child').or(browser.locator('#missing')) }).count(), 1);
  await count('scoped union cannot expose closed shadow child', () => browser.locator('#closed-host').filter({ has: browser.locator('#closed-child').or(browser.locator('#missing')) }).count(), 0);
  const retained = browser.locator('#shown').filter({ has: visible.or(browser.locator('#missing')) });
  await count('initial rendered root', () => retained.count(), 1);
  await browser.evaluate(() => { (document.querySelector('#shown') as HTMLElement).style.display = 'none'; return null; });
  await count('same locator observes hidden root', () => retained.count(), 0);
  await browser.evaluate(() => { (document.querySelector('#shown') as HTMLElement).style.display = 'block'; return null; });
  await count('same locator observes restored root', () => retained.count(), 1);
});
