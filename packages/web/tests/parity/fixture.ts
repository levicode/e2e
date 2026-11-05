/**
 * The page the raw-selector differential runs on. Every element the selector
 * matrix can match carries a unique `data-id`, so a match set is compared by
 * identity and order rather than by text. The page covers the shapes the four
 * raw families touch: plain and nested text, whitespace and unicode, form
 * controls whose value is and is not text, an open and a closed shadow root,
 * rendered-hidden elements, and the role-bearing controls.
 */
export const RAW_LOCATOR_FIXTURE_HTML = `<!doctype html>
<html data-id="html">
<head data-id="head"><title data-id="title">Raw locator parity</title></head>
<body data-id="body">
<p data-id="p-alpha">Alpha Beta</p>
<p data-id="p-lower">alpha beta gamma</p>
<p data-id="p-space">  Alpha   Beta  </p>
<div data-id="d-wrap">Alpha <span data-id="s-beta">Beta</span></div>
<p data-id="p-nospace">AlphaBeta</p>
<p data-id="p-unicode">日本語 テキスト</p>
<p data-id="p-apostrophe">Bob's Place</p>
<p data-id="p-inner"><span data-id="s-inner">Alpha inner</span></p>
<p data-id="p-empty"></p>
<input data-id="i-button" type="button" value="Alpha Button">
<input data-id="i-text" type="text" value="Alpha Field">
<ul data-id="list">
  <li data-id="li-1">Alpha one</li>
  <li data-id="li-2">Beta two</li>
  <li data-id="li-3">Gamma three</li>
</ul>
<div data-id="row"><span data-id="row-a">A</span><span data-id="row-b">B</span></div>
<div data-layout="anchor" data-id="layout-anchor" style="position:absolute;left:100px;top:100px;width:20px;height:20px"></div>
<div data-layout="right" data-id="layout-right" style="position:absolute;left:200px;top:100px;width:20px;height:20px"></div>
<div data-layout="left" data-id="layout-left" style="position:absolute;left:20px;top:100px;width:20px;height:20px"></div>
<div data-layout="above" data-id="layout-above" style="position:absolute;left:100px;top:20px;width:20px;height:20px"></div>
<div data-layout="below" data-id="layout-below" style="position:absolute;left:100px;top:200px;width:20px;height:20px"></div>
<div data-layout="near" data-id="layout-near" style="position:absolute;left:150px;top:100px;width:20px;height:20px"></div>
<button data-id="btn-save">Save</button>
<button data-id="btn-save-draft">Save draft</button>
<div data-id="btn-custom" role="button" aria-label="Save">custom save</div>
<input data-id="btn-submit" type="submit" value="Save">
<input data-id="check-wifi" type="checkbox" aria-label="Wifi" checked>
<button data-id="btn-hidden" hidden>Save</button>
<button data-id="btn-disabled" disabled>Save disabled</button>
<h2 data-id="heading-two">Section two</h2>
<div data-id="div-hidden" style="display:none">Alpha hidden</div>
<div data-id="div-invisible" style="visibility:hidden">Alpha invisible</div>
<div data-id="div-zero" style="width:0;height:0;overflow:hidden">Alpha zero</div>
<div data-id="shadow-host">light text</div>
<div data-id="closed-host"></div>
<section data-id="sec-a"><span data-id="span-a">Alpha</span></section>
<section data-id="sec-b"><span data-id="span-b">Beta</span></section>
<div data-id="div-title" title="Alpha title">has title</div>
<span data-id="label-target" aria-label="Alpha label">x</span>
<span data-id="testid-x" data-testid="x">test id x</span>
<label data-id="label-alpha" for="labelled-input">Alpha label text</label>
<input id="labelled-input" data-id="labelled-input">
<input data-id="placeholder-input" placeholder="Alpha placeholder">
<span id="by-label" data-id="by-label">Alpha by label</span>
<input data-id="labelledby-input" aria-labelledby="by-label">
<script data-id="fixture-script">
  const open = document.querySelector('[data-id="shadow-host"]').attachShadow({ mode: 'open' });
  open.innerHTML = '<p data-id="shadow-p">Shadow Alpha</p><button data-id="shadow-btn">Shadow Save</button>';
  const closed = document.querySelector('[data-id="closed-host"]').attachShadow({ mode: 'closed' });
  closed.innerHTML = '<p data-id="closed-p">Closed Alpha</p><button data-id="closed-btn">Closed Save</button>';
</script>
</body>
</html>`;
