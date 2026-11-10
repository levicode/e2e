/** Icon-only controls: an unnamed action target the page identifies by its own id and class, and one it identifies by nothing at all. */

import { constant, type PageRenderer } from './page.ts';

export const ICON_PAGES: Record<string, PageRenderer> = {
  // The "add tag" affordance of a tag editor: a glyph-only control with no
  // role, name, or text, revealed by the named button beside it. The page's
  // `id` and `class` are the only facts that tell it apart from any other
  // icon, the way the model-facing line shows them (`id=`/`class=`).
  '/icon-targets': constant(`<!doctype html>
<html>
<head><title>Icon targets</title></head>
<body>
  <h1>Icon targets</h1>
  <button id="edit" onclick="document.getElementById('toolbar').hidden = false">Edit tags</button>
  <div id="toolbar" class="toolbar" hidden>
    <div id="tag-add" class="icon icon-add" style="width:32px;height:32px" onclick="document.getElementById('result').textContent = 'added'"></div>
  </div>
  <output id="result" role="status" aria-label="Result">empty</output>
</body>
</html>`),
  // The same flow with the icon's id and class removed: the control is listed
  // and clickable, but the page gives a replay nothing to re-find it by.
  '/icon-anonymous': constant(`<!doctype html>
<html>
<head><title>Anonymous icon</title></head>
<body>
  <h1>Anonymous icon</h1>
  <button id="edit" onclick="document.getElementById('toolbar').hidden = false">Edit tags</button>
  <div id="toolbar" class="toolbar" hidden>
    <div style="width:32px;height:32px" onclick="document.getElementById('result').textContent = 'added'"></div>
  </div>
  <output id="result" role="status" aria-label="Result">empty</output>
</body>
</html>`),
};
