/** One raw selector under differential test, grouped by the issue family it covers. */
export interface RawLocatorCase {
  /** Issue family: 30 raw text, 31 raw role, 32 extended CSS, 33 internal/capture. */
  readonly family: '30' | '31' | '32' | '33';
  /** The authored selector, passed to both the original and the current entry. */
  readonly selector: string;
  /** Why this selector is in the matrix. */
  readonly intent: string;
}

export const RAW_LOCATOR_CASES: readonly RawLocatorCase[] = [
  // #30 raw text: exact/lax/regex, implicit quotes, normalized substring,
  // immediate text, root chaining, shadow search domain and `:light`.
  { family: '30', selector: 'text=Alpha Beta', intent: 'lax normalized substring' },
  { family: '30', selector: 'text="Alpha Beta"', intent: 'quoted exact immediate text' },
  { family: '30', selector: 'text=alpha', intent: 'lax is case-insensitive' },
  { family: '30', selector: 'text=/^Alpha/', intent: 'regex source' },
  { family: '30', selector: '"Alpha Beta"', intent: 'implicit text from a quoted body' },
  { family: '30', selector: "'Alpha Beta'", intent: 'implicit text from a single-quoted body' },
  { family: '30', selector: 'text="Alpha"', intent: 'exact matches an element whose own text is Alpha' },
  { family: '30', selector: 'text=AlphaBeta', intent: 'lax matches without a space' },
  { family: '30', selector: 'text="AlphaBeta"', intent: 'exact matches without a space' },
  { family: '30', selector: 'text=/^alpha beta$/i', intent: 'regex flags' },
  { family: '30', selector: 'text=日本', intent: 'unicode substring' },
  { family: '30', selector: "text=Bob's Place", intent: 'apostrophe is data, not a quote' },
  { family: '30', selector: 'text=Shadow Alpha', intent: 'text pierces an open shadow root' },
  { family: '30', selector: 'text:light=Shadow Alpha', intent: 'text:light does not pierce' },
  { family: '30', selector: 'text:light="Alpha Beta"', intent: 'quoted text:light' },
  { family: '30', selector: 'text=Alpha >> text=Beta', intent: 'text chained onto text' },
  { family: '30', selector: 'css=p >> text=Alpha', intent: 'text chained onto CSS' },
  { family: '30', selector: 'text=Alpha hidden', intent: 'text matches rendered-hidden content' },
  { family: '30', selector: 'text=Alpha >> nth=1', intent: 'nth after text' },
  { family: '30', selector: 'text=', intent: 'empty text body is malformed' },

  // #31 raw role: typed body, operators, ARIA states and root rules.
  { family: '31', selector: 'role=button', intent: 'raw role without a body tag' },
  { family: '31', selector: 'role=button[name="Save"]', intent: 'role name in the typed body' },
  { family: '31', selector: 'role=button[name="Save draft"]', intent: 'role name with a space' },
  { family: '31', selector: 'role=button[name="save"i]', intent: 'role name with the i flag' },
  { family: '31', selector: 'role=button[name=/^Save/]', intent: 'role name regex' },
  { family: '31', selector: 'role=checkbox[checked]', intent: 'role ARIA state' },
  { family: '31', selector: 'role=heading[level=2]', intent: 'role heading level' },
  { family: '31', selector: 'role=button[disabled]', intent: 'role disabled state' },
  { family: '31', selector: 'role=button >> nth=0', intent: 'nth after role' },
  { family: '31', selector: 'role=button[name="Save"] >> nth=0', intent: 'nth after a named role' },
  { family: '31', selector: 'role=', intent: 'empty role body is malformed' },

  // #32 Playwright extended CSS: text matchers, visibility, nth-match and the
  // layout matchers. Every selector here matched the original entry when the
  // ledger was recorded, so a line for this family is a new regression.
  { family: '32', selector: 'css=li:has-text("Alpha")', intent: ':has-text descendant text' },
  { family: '32', selector: 'css=li:has-text("alpha")', intent: ':has-text is case-insensitive' },
  { family: '32', selector: 'css=li:text("Alpha")', intent: ':text normalized substring' },
  { family: '32', selector: 'css=li:text-is("Alpha one")', intent: ':text-is exact normalized text' },
  { family: '32', selector: 'css=li:text-matches("^Alpha")', intent: ':text-matches regex' },
  { family: '32', selector: 'css=li:text-matches("^BETA", "i")', intent: ':text-matches with the i flag' },
  { family: '32', selector: 'css=:nth-match(li, 1)', intent: ':nth-match is one-based' },
  { family: '32', selector: 'css=:nth-match(li, 2)', intent: ':nth-match second match' },
  { family: '32', selector: 'css=:nth-match(li, 0)', intent: ':nth-match zero matches nothing' },
  { family: '32', selector: 'css=:nth-match(:text("Alpha"), 1)', intent: ':nth-match with a text matcher' },
  { family: '32', selector: 'css=p:visible', intent: ':visible keeps rendered paragraphs' },
  { family: '32', selector: 'css=:visible', intent: ':visible across the document' },
  { family: '32', selector: 'css=div:has-text("Shadow")', intent: ':has-text pierces an open shadow root' },
  { family: '32', selector: 'css=:text("Alpha Button")', intent: ':text reads a button input value' },
  { family: '32', selector: 'css=input:text("Alpha Field")', intent: ':text ignores a text input value' },
  { family: '32', selector: 'css=p:text-is("Alpha Beta")', intent: ':text-is on paragraphs' },
  { family: '32', selector: 'css=li:has-text("Alpha"):visible', intent: 'chained extended matchers' },
  { family: '32', selector: 'css=button:has-text("Save")', intent: ':has-text on buttons' },
  { family: '32', selector: 'css=li:has-text("Alpha") >> nth=0', intent: 'extended CSS followed by nth' },

  // #33 internal composition, capture and nth.
  { family: '33', selector: 'internal:has="css=span"', intent: 'internal:has composed selector' },
  { family: '33', selector: 'css=section >> internal:has="css=span"', intent: 'internal:has scoped by CSS' },
  { family: '33', selector: 'css=section >> internal:has-not="css=span"', intent: 'internal:has-not' },
  { family: '33', selector: 'css=section >> internal:and="css=[data-id=\'sec-a\']"', intent: 'internal:and intersects' },
  { family: '33', selector: 'css=section >> internal:or="css=[data-id=\'sec-b\']"', intent: 'internal:or unions in DOM order' },
  { family: '33', selector: 'css=section >> internal:chain="css=span"', intent: 'internal:chain continues the chain' },
  { family: '33', selector: 'internal:text="Alpha inner"', intent: 'internal:text exact normalized text' },
  { family: '33', selector: 'internal:text="Alpha"', intent: 'internal:text exact without descendants' },
  { family: '33', selector: 'internal:label="Alpha label text"', intent: 'internal:label' },
  { family: '33', selector: 'internal:role=button[name="Save"]', intent: 'internal:role typed body' },
  { family: '33', selector: 'internal:attr=[title="Alpha title"i]', intent: 'internal:attr named attribute' },
  { family: '33', selector: 'internal:testid=[data-testid="x"s]', intent: 'internal:testid typed body' },

  { family: '33', selector: '*css=section >> css=span', intent: 'capture a non-final part' },
  { family: '33', selector: 'css=section >> *css=span', intent: 'capture the final part' },
  { family: '33', selector: '*css=li >> css=span', intent: 'capture with no descendant match' },
  { family: '33', selector: '*css=li >> nth=0', intent: 'capture with nth is refused' },
  { family: '33', selector: 'css=li >> nth=1', intent: 'nth after CSS' },
  { family: '33', selector: 'css=li >> nth=-1', intent: 'negative nth' },

  // Shared syntax errors, so the error classification is compared too.
  { family: '33', selector: 'div >>', intent: 'trailing chain syntax' },
  { family: '33', selector: 'nosuch=1', intent: 'unknown engine' },
  { family: '33', selector: '_react=Button', intent: '_react reachability: the original client registers no such engine' },
  { family: '33', selector: '_vue=Button', intent: '_vue reachability: the original client registers no such engine' },
  { family: '32', selector: 'css=[data-layout]:right-of([data-id="layout-anchor"])', intent: ':right-of layout matcher' },
  { family: '32', selector: 'css=[data-layout]:left-of([data-id="layout-anchor"])', intent: ':left-of layout matcher' },
  { family: '32', selector: 'css=[data-layout]:above([data-id="layout-anchor"])', intent: ':above layout matcher' },
  { family: '32', selector: 'css=[data-layout]:below([data-id="layout-anchor"])', intent: ':below layout matcher' },
  { family: '32', selector: 'css=[data-layout]:near([data-id="layout-anchor"], 60)', intent: ':near with a distance' },
  { family: '32', selector: 'css=[data-layout]:near([data-id="layout-anchor"], 10)', intent: ':near excludes a farther element' },
  { family: '33', selector: 'css=li >> internal:has-text="alpha"i', intent: 'internal:has-text lax' },
  { family: '33', selector: 'css=li >> internal:has-text="Alpha one"', intent: 'internal:has-text strict normalized text' },
  { family: '33', selector: 'css=li >> internal:has-not-text="beta"i', intent: 'internal:has-not-text lax' },
  { family: '33', selector: 'css=li >> internal:has-not="css=span"', intent: 'internal:has-not keeps roots without the target' },
  { family: '33', selector: '*text=Alpha', intent: 'capture a text engine' },
  { family: '33', selector: 'css=section >> *text=Alpha >> css=span', intent: 'capture in the middle of a chain' },
  { family: '33', selector: '*css=section >> *css=span', intent: 'two captures are refused' },
  { family: '33', selector: 'css=ul >> internal:chain="css=li"', intent: 'internal:chain after CSS' },
  { family: '33', selector: 'internal:label="Alpha by label"', intent: 'internal:label from aria-labelledby' },
  { family: '31', selector: 'role=button[name="Shadow Save"]', intent: 'raw role pierces an open shadow root' },
  { family: '31', selector: 'css=[data-id="shadow-host"] >> role=button', intent: 'raw role under an element root still pierces that host shadow' },
  { family: '31', selector: 'css=section >> role=button', intent: 'raw role scoped by CSS' },
];

