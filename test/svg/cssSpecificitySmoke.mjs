// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// CSS specificity uses the lexicographically greatest :not() argument tuple.
// Importer checks also preserve selector lists through stylesheet parsing.
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;

const { parseCssCompound, compoundSpec } = await import('../../src/svg/stylesheet.js');
const { default: importSvg } = await import('../../src/svg/importer.js');

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

// ---- T1: the tuples --------------------------------------------------
{
  const want = {
    '#x': [1, 0, 0],
    '.a.b.c': [0, 3, 0],
    rect: [0, 0, 1],
    '*': [0, 0, 0],
    ':not(.a)': [0, 1, 0],
    // The most specific argument is #id (1,0,0) — the classes of the OTHER
    // argument must not be added on top of it.
    ':not(#id,.a.b.c)': [1, 0, 0],
    // A type selector inside :not() contributes to the type component.
    ':not(rect)': [0, 0, 1],
    ':not(.a,rect)': [0, 1, 0],
    'rect.a:not(#z)': [1, 1, 1],
  };
  const bad = [];
  for (const [sel, exp] of Object.entries(want)) {
    const got = compoundSpec(parseCssCompound(sel));
    if (JSON.stringify(got) !== JSON.stringify(exp)) {
      bad.push(`${sel} -> ${JSON.stringify(got)}, want ${JSON.stringify(exp)}`);
    }
  }
  if (!bad.length) ok(`T1 ${Object.keys(want).length} selectors match Selectors L4 §16`);
  else for (const b of bad) fail(`T1 ${b}`);
}

// Resolve competing declarations through the production importer.
const hexOf = (c) =>
  '#' +
  [0, 1, 2]
    .map((k) =>
      Math.round(Math.max(0, Math.min(1, c[k])) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
const metaOf = (r) => r.metaFloats || new Float32Array(r.meta, 32);
const fillOf = (r, i) => {
  const m = metaOf(r),
    o = i * 48;
  return [m[o + 4], m[o + 5], m[o + 6], m[o + 7]];
};

{
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
    '<style>.hit:not(rect){fill:#00ff00} .hit{fill:#ff0000}</style>' +
    '<circle class="hit" cx="5" cy="5" r="4"/></svg>';
  const r = await importSvg(svg, {});
  const got = hexOf(fillOf(r, 0));
  if (got === '#00ff00') ok('T2 :not(type) wins the cascade on the type component');
  else if (got === '#ff0000')
    fail('T2 the later, LESS specific rule won — :not() type component is not counted');
  else fail(`T2 unexpected fill ${got}`);
}

// A non-winning :not() argument cannot add specificity.
{
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
    '<style>.hit:not(#nope,.a.b.c){fill:#ff0000} #id.hit{fill:#00ff00}</style>' +
    '<circle id="id" class="hit" cx="5" cy="5" r="4"/></svg>';
  const r = await importSvg(svg, {});
  const got = hexOf(fillOf(r, 0));
  if (got === '#00ff00')
    ok('T3 :not() does not inflate its class count from a non-winning argument');
  else if (got === '#ff0000')
    fail('T3 the :not() rule won — its class count is still being inflated');
  else fail(`T3 unexpected fill ${got}`);
}

// Functional-selector commas and quoted punctuation are not top-level separators.
for (const [selector, value] of [
  ['rect:not(.cold,#two)', 'a],b'],
  ['rect:not(:not([data-tags="a],b"],#two))', 'other'],
]) {
  const expected = ['#ff0000', '#ff0000', '#0000ff'];
  if (selector.includes(':not(:not')) expected.splice(0, 3, '#ff0000', '#0000ff', '#ff0000');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 20">' +
    '<style>' +
    selector +
    '{fill:blue}</style>' +
    '<rect class="cold" data-tags="' +
    value +
    '" width="10" height="10" fill="red"/>' +
    '<rect id="two" x="20" width="10" height="10" fill="red"/>' +
    '<rect x="40" width="10" height="10" fill="red"/></svg>';
  const bundle = await importSvg(svg);
  const actual = expected.map((_, i) => hexOf(fillOf(bundle, i)));
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok('stylesheet preserves ' + selector);
  else fail(selector + ': ' + actual.join(', '));
}

console.log();
console.log(failures === 0 ? 'CSS-SPECIFICITY PASS' : `CSS-SPECIFICITY FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
