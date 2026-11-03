// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cssRuleIndexSmoke.mjs — the subject-compound rule index in lookupCssProp must
// return exactly the same result as a full rule scan. The index buckets each
// rule by its subject's most-selective token (id > first class > tag) and an
// element gathers every bucket its tokens hit. This guards the bucketing
// doesn't drop matches (or surface non-matches) across selector kinds, and that
// the specificity cascade still wins ties.
//
// The rules carry marker words, not real paint values, so they use properties whose values the declaration reader
// does not judge (font-family, font-weight, font-size): fill, stroke and opacity declarations with a value no paint
// or alpha grammar accepts are dropped at parse time (svg/cssDecl.js). `fill` below reads font-family, `stroke`
// font-weight and `opacity` font-size.
import { DOMParser as DP } from '@xmldom/xmldom';
import {
  buildStylesheet,
  setActiveStylesheet,
  clearActiveStylesheet,
  lookupCssProp,
} from '../../src/svg/stylesheet.js';

let failures = 0;
const fail = (m) => {
  console.error('FAIL', m);
  failures++;
};
const ok = (m) => console.log('ok', m);

const SVG = `<svg xmlns="http://www.w3.org/2000/svg">
  <style>
    rect            { font-family: tagval; }
    .foo            { font-family: classval; }
    #bar            { font-family: idval; }
    rect.foo        { font-family: compoundval; }
    g .deep         { font-family: descval; }
    .foo.bar        { font-family: twoclassval; }
    *               { font-weight: starval; }
    [data-x="1"]    { font-size: attrval; }
    circle.foo      { font-family: circlefoo; }
  </style>
  <g id="wrap">
    <rect id="bar" class="foo"/>            <!-- A: #bar.foo.rect -->
    <rect class="foo bar"/>                 <!-- B: rect.foo.bar -->
    <circle class="bar"/>                   <!-- C: circle.bar (NOT .foo.bar) -->
    <g><path class="deep"/></g>             <!-- D: descendant g .deep -->
    <ellipse data-x="1"/>                   <!-- E: attribute -->
    <line/>                                 <!-- F: bare tag, no class -->
  </g>
</svg>`;

const root = new DP().parseFromString(SVG, 'application/xml').documentElement;
setActiveStylesheet(root, buildStylesheet(root));

const byId = (id) => {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.getAttribute && n.getAttribute('id') === id) return n;
    for (let i = 0; n.childNodes && i < n.childNodes.length; i++)
      if (n.childNodes[i].nodeType === 1) stack.push(n.childNodes[i]);
  }
  return null;
};
const nth = (tag, idx = 0) => {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if ((n.tagName || n.localName || '').toLowerCase() === tag) out.push(n);
    for (let i = 0; n.childNodes && i < n.childNodes.length; i++)
      if (n.childNodes[i].nodeType === 1) stack.push(n.childNodes[i]);
  }
  // stack is LIFO → reverse for document order
  return out.reverse()[idx];
};

const val = (got) => (got && typeof got === 'object' ? got.value : got);
const eq = (got, want, label) =>
  val(got) === want
    ? ok(`${label} → ${want}`)
    : fail(`${label}: got ${JSON.stringify(got)}, want ${want}`);

// A: #bar.foo (a <rect>). Candidates: #bar(id), .foo(class), rect(tag),
// rect.foo(compound). Highest specificity = #bar → idval.
eq(lookupCssProp(byId('bar'), 'font-family'), 'idval', 'A id beats class/tag/compound');
// A also matches the universal `*` for stroke.
eq(lookupCssProp(byId('bar'), 'font-weight'), 'starval', 'A universal * stroke');

// B: rect.foo.bar. fill candidates: .foo, rect, rect.foo, .foo.bar. Specificity:
// .foo.bar (0,2,0) > rect.foo (0,1,1) > .foo (0,1,0) > rect (0,0,1) → twoclassval.
eq(lookupCssProp(nth('rect', 1), 'font-family'), 'twoclassval', 'B .foo.bar beats rect.foo');

// C: circle.bar — has .bar but NOT .foo, so .foo / .foo.bar / circle.foo must
// NOT match. Only `*` applies (no fill rule) → fill null, stroke starval.
eq(
  lookupCssProp(nth('circle'), 'font-family'),
  null,
  'C circle.bar matches no fill rule (bucketing rejects .foo.bar)',
);
eq(lookupCssProp(nth('circle'), 'font-weight'), 'starval', 'C universal stroke still applies');

// D: descendant `g .deep` on a <path class="deep"> inside <g>. Subject is
// `.deep` (class bucket); ancestor walk finds the <g>.
eq(lookupCssProp(nth('path'), 'font-family'), 'descval', 'D descendant g .deep');

// E: attribute selector [data-x="1"] (universal bucket, no tag/class/id).
eq(
  lookupCssProp(nth('ellipse'), 'font-size'),
  'attrval',
  'E attribute selector via universal bucket',
);

// F: bare <line> — only the tag bucket has nothing for line; `*` gives stroke.
eq(lookupCssProp(nth('line'), 'font-family'), null, 'F bare line: no fill rule');
eq(lookupCssProp(nth('line'), 'font-weight'), 'starval', 'F bare line: universal stroke');

clearActiveStylesheet(root);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nCSS-RULE-INDEX PASS');
process.exit(failures ? 1 : 0);
