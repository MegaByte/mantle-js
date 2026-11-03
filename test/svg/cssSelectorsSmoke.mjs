// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cssSelectorsSmoke.mjs — verify combinators + attribute selectors
// + structural pseudo-classes in the CSS selector engine.

import { DOMParser as DP } from '@xmldom/xmldom';
import {
  parseCssChain,
  compoundMatches,
  chainMatches,
  parseCssCompound,
} from '../../src/svg/stylesheet.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL', msg);
  failures++;
};
const ok = (msg) => console.log('ok', msg);

function parse(xml) {
  return new DP().parseFromString(xml, 'application/xml').documentElement;
}
function findByTag(root, tag) {
  if (root.tagName === tag) return root;
  for (let i = 0; i < root.childNodes.length; i++) {
    const c = root.childNodes[i];
    if (c.nodeType !== 1) continue;
    const r = findByTag(c, tag);
    if (r) return r;
  }
  return null;
}
function findById(root, id) {
  if (root.getAttribute && root.getAttribute('id') === id) return root;
  for (let i = 0; i < root.childNodes.length; i++) {
    const c = root.childNodes[i];
    if (c.nodeType !== 1) continue;
    const r = findById(c, id);
    if (r) return r;
  }
  return null;
}

// ---- T1: attribute presence selector ------------------------------
{
  const doc = parse(
    `<svg xmlns="http://www.w3.org/2000/svg"><rect id="r" fill="red"/><rect id="r2"/></svg>`,
  );
  const r = findById(doc, 'r'),
    r2 = findById(doc, 'r2');
  const ch = parseCssChain('[fill]');
  if (!chainMatches(ch, r)) fail('T1 [fill] should match rect with fill attr');
  else if (chainMatches(ch, r2)) fail('T1 [fill] should NOT match rect without fill attr');
  else ok('T1 [fill] presence selector works');
}

// ---- T2: attribute equality ---------------------------------------
{
  const doc = parse(
    `<svg xmlns="http://www.w3.org/2000/svg"><rect id="r" fill="red"/><rect id="r2" fill="blue"/></svg>`,
  );
  const r = findById(doc, 'r'),
    r2 = findById(doc, 'r2');
  const ch = parseCssChain('[fill="red"]');
  if (!chainMatches(ch, r)) fail('T2 [fill="red"] should match red rect');
  else if (chainMatches(ch, r2)) fail('T2 [fill="red"] should NOT match blue rect');
  else ok('T2 [fill="red"] equality selector works');
}

// ---- T3: attribute substring matches ------------------------------
{
  const doc = parse(
    `<svg xmlns="http://www.w3.org/2000/svg"><rect id="r" class="icon-home" data-x="hello world"/></svg>`,
  );
  const r = findById(doc, 'r');
  const c1 = parseCssChain('[class^="icon-"]');
  const c2 = parseCssChain('[class$="-home"]');
  const c3 = parseCssChain('[class*="icon"]');
  const c4 = parseCssChain('[data-x~="hello"]');
  if (!chainMatches(c1, r)) fail('T3a [class^="icon-"] should match');
  else if (!chainMatches(c2, r)) fail('T3b [class$="-home"] should match');
  else if (!chainMatches(c3, r)) fail('T3c [class*="icon"] should match');
  else if (!chainMatches(c4, r)) fail('T3d [data-x~="hello"] should match');
  else ok('T3 attribute ^=, $=, *=, ~= all work');
}

// ---- T4: adjacent sibling combinator (+) --------------------------
{
  const doc = parse(
    `<svg xmlns="http://www.w3.org/2000/svg"><rect id="r1"/><circle id="c1"/><rect id="r2"/></svg>`,
  );
  const c1 = findById(doc, 'c1'),
    r2 = findById(doc, 'r2');
  const ch = parseCssChain('rect + circle');
  if (!chainMatches(ch, c1)) fail('T4 rect + circle should match circle following rect');
  // r2 follows a circle, not a rect → does not match `rect + circle`.
  if (chainMatches(ch, r2)) fail('T4 rect + circle should NOT match rect following circle');
  else ok('T4 adjacent sibling (+) works');
}

// ---- T5: general sibling combinator (~) ---------------------------
{
  const doc = parse(
    `<svg xmlns="http://www.w3.org/2000/svg"><rect id="r1"/><line/><circle id="c1"/></svg>`,
  );
  const c1 = findById(doc, 'c1');
  const ch = parseCssChain('rect ~ circle');
  if (!chainMatches(ch, c1)) fail('T5 rect ~ circle should match circle later than rect');
  else ok('T5 general sibling (~) works');
}

// ---- T6: :first-child / :last-child / :only-child ----------------
{
  const doc = parse(
    `<svg xmlns="http://www.w3.org/2000/svg"><g><rect id="r1"/><rect id="r2"/><rect id="r3"/></g><g><circle id="c1"/></g></svg>`,
  );
  const r1 = findById(doc, 'r1');
  const r3 = findById(doc, 'r3');
  const c1 = findById(doc, 'c1');
  if (!chainMatches(parseCssChain(':first-child'), r1)) fail('T6a :first-child r1');
  if (!chainMatches(parseCssChain(':last-child'), r3)) fail('T6b :last-child r3');
  if (!chainMatches(parseCssChain(':only-child'), c1)) fail('T6c :only-child c1');
  if (chainMatches(parseCssChain(':only-child'), r1)) fail('T6d r1 is NOT only-child');
  ok('T6 :first-child / :last-child / :only-child');
}

// ---- T7: :nth-child ----------------------------------------------
{
  const doc = parse(
    `<svg xmlns="http://www.w3.org/2000/svg"><g><rect id="r1"/><rect id="r2"/><rect id="r3"/><rect id="r4"/></g></svg>`,
  );
  const r1 = findById(doc, 'r1'),
    r2 = findById(doc, 'r2'),
    r3 = findById(doc, 'r3'),
    r4 = findById(doc, 'r4');
  if (!chainMatches(parseCssChain(':nth-child(2)'), r2)) fail('T7a :nth-child(2)');
  if (!chainMatches(parseCssChain(':nth-child(odd)'), r1)) fail('T7b :nth-child(odd) r1');
  if (!chainMatches(parseCssChain(':nth-child(odd)'), r3)) fail('T7c :nth-child(odd) r3');
  if (!chainMatches(parseCssChain(':nth-child(even)'), r2)) fail('T7d :nth-child(even) r2');
  if (!chainMatches(parseCssChain(':nth-child(2n+1)'), r3)) fail('T7e :nth-child(2n+1) r3');
  ok('T7 :nth-child(n)/odd/even/An+B');
}

// ---- T8: :not() ---------------------------------------------------
{
  const doc = parse(
    `<svg xmlns="http://www.w3.org/2000/svg"><rect id="r1" class="x"/><rect id="r2"/></svg>`,
  );
  const r1 = findById(doc, 'r1'),
    r2 = findById(doc, 'r2');
  const ch = parseCssChain('rect:not(.x)');
  if (chainMatches(ch, r1)) fail('T8 rect:not(.x) should NOT match r1 (has .x)');
  if (!chainMatches(ch, r2)) fail('T8 rect:not(.x) should match r2');
  else ok('T8 :not(.cls) works');
}

// ---- T9: :root ----------------------------------------------------
{
  const doc = parse(`<svg xmlns="http://www.w3.org/2000/svg"><rect id="r1"/></svg>`);
  const r1 = findById(doc, 'r1');
  if (!chainMatches(parseCssChain(':root'), doc)) fail('T9 :root should match the SVG root');
  if (chainMatches(parseCssChain(':root'), r1)) fail('T9 :root should NOT match a child');
  else ok('T9 :root matches the SVG root only');
}

// ---- T10: interactive pseudos never match -------------------------
{
  const doc = parse(`<svg xmlns="http://www.w3.org/2000/svg"><rect id="r1"/></svg>`);
  const r1 = findById(doc, 'r1');
  for (const ps of [':hover', ':active', ':focus', ':visited']) {
    if (chainMatches(parseCssChain('rect' + ps), r1))
      fail(`T10 rect${ps} should never match in static renderer`);
  }
  ok('T10 :hover / :active / :focus / :visited never match');
}

// ---- T11: pseudo-elements (::before) never match ------------------
{
  const doc = parse(`<svg xmlns="http://www.w3.org/2000/svg"><rect id="r1"/></svg>`);
  const r1 = findById(doc, 'r1');
  if (chainMatches(parseCssChain('rect::before'), r1)) fail('T11 ::before should never match');
  else ok('T11 ::before (pseudo-element) never matches');
}

// ---- T12: combined chain — descendant + attribute + nth ----------
{
  const doc = parse(
    `<svg xmlns="http://www.w3.org/2000/svg"><g class="layer"><rect fill="red"/><rect fill="blue" id="r2"/><rect fill="green"/></g></svg>`,
  );
  const r2 = findById(doc, 'r2');
  const ch = parseCssChain('g.layer > rect[fill="blue"]:nth-child(2)');
  if (!chainMatches(ch, r2)) fail('T12 combined chain should match r2');
  else ok('T12 combined chain works');
}

// ---- T13: specificity ordering ------------------------------------
// Tests via parseCssCompound's spec, indirectly. Ensure that
// `[fill="red"]` has class-level specificity (b component).
{
  const c1 = parseCssCompound('rect'); // (0,0,1)
  const c2 = parseCssCompound('rect[fill]'); // (0,1,1)
  const c3 = parseCssCompound('#id.cls'); // (1,1,0)
  const c4 = parseCssCompound(':not(.x)'); // (0,1,0)
  const s1 = c1.id ? 1 : 0;
  // Just spot-check that attrs[] populated:
  if (!(c2.attrs && c2.attrs.length === 1 && c2.attrs[0].name === 'fill'))
    fail('T13 [fill] not parsed');
  if (!(c3.id === 'id' && c3.classes.length === 1)) fail('T13 #id.cls not parsed');
  if (!(c4.pseudos && c4.pseudos.length === 1 && c4.pseudos[0].kind === 'not'))
    fail('T13 :not(.x) not parsed');
  ok('T13 compounds with attrs / pseudos parse cleanly');
}

if (failures > 0) {
  console.error(`\nCSS-SELECTORS FAIL (${failures})`);
  process.exit(1);
}
console.log('\nCSS-SELECTORS PASS');
