// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importDefContentSmoke: the content of a clip or mask keeps what it inherits and what matches it, however the import folds the def, and an
// ancestor's mask reaches a leaf that says something about masks itself.
//
// (a) A clip-path on a <mask> or <clipPath>, and the intersection of two clips, must not walk COPIES of the content under a detached
//     element: a <mask fill="white"> or an ancestor's fill would stop reaching it, a rule like `#m rect` would stop matching it, and the
//     mask would turn black, which hides what it masks. clip-rule inherited from a <clipPath> would be lost the same way.
// (b) A mask of plain white and black on a group rides down to each leaf. A leaf with a mask of its own does not replace it (the group's
//     mask is kept), and `mask="none"` on a leaf does not take it off (`mask` does not inherit: the leaf is in the masked group either way).
if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const L = await import('../src/bundle/layout.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const doc = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
const rows = (b) => {
  const m = new Float32Array(b.meta, 32),
    s = b.metaFloatsPerShape || 48,
    out = [];
  for (let r = 0; r < b.numShapes; r++) out.push(m.subarray(r * s, (r + 1) * s));
  return out;
};
const imp = async (body) => rows(await importSvg(doc(body)));
const layer = (r) => r.filter((a) => a[L.META_FLAGS_SHAPE] & 0x100);
const R = 'width="9" height="9"';
const C = '<clipPath id="c"><rect width="50" height="50"/></clipPath>';
// The layer row of the mask's or clip's own content: its 10-wide rect, not the 50-wide outer clip.
const content = (r) => layer(r).find((a) => a[L.META_BBOX_XMAX] === 10);

console.log('(a) a clip-path on a <mask>');
let r = await imp(
  `${C}<mask id="m" fill="white" clip-path="url(#c)"><rect width="10" height="10"/></mask><rect ${R} mask="url(#m)"/>`,
);
ok(content(r)[L.META_FILL_R] === 1, "the <mask> element's own fill reaches the content");
r = await imp(
  `${C}<g fill="white"><mask id="m" clip-path="url(#c)"><rect width="10" height="10"/></mask></g><rect ${R} mask="url(#m)"/>`,
);
ok(content(r)[L.META_FILL_R] === 1, "an ancestor's fill reaches the content");
r = await imp(
  `<style>#m rect{fill:white}</style>${C}<mask id="m" clip-path="url(#c)"><rect width="10" height="10"/></mask><rect ${R} mask="url(#m)"/>`,
);
ok(content(r)[L.META_FILL_R] === 1, "a rule through the <mask>'s id still matches the content");
r = await imp(
  `<style>rect:first-child{fill:white}</style>${C}<mask id="m" clip-path="url(#c)"><rect width="10" height="10"/></mask><rect ${R} mask="url(#m)"/>`,
);
ok(content(r)[L.META_FILL_R] === 1, 'a structural rule still matches the content');
r = await imp(
  `${C}<mask id="m" clip-path="url(#c)" x="0" y="0" width="1" height="1"><rect width="10" height="10" fill="white"/></mask><rect x="5" ${R} mask="url(#m)"/>`,
);
ok(
  r.some((a) => a[L.META_MASK_ID] > 0),
  'the mask keeps its region',
);

console.log('(a) clip-rule, and the content of an intersection');
const B = (extra = '') => `<clipPath id="b" ${extra}><path d="M0 0H10V10H0Z"/></clipPath>`;
r = await imp(
  `${C}${B('clip-rule="evenodd"')}<g clip-path="url(#c)"><rect ${R} clip-path="url(#b)"/></g>`,
);
ok(content(r)[L.META_FILL_RULE] === 1, 'an intersection: clip-rule from the inner <clipPath>');
r = await imp(
  `${C}${B('clip-rule="evenodd" clip-path="url(#c)"')}<rect ${R} clip-path="url(#b)"/>`,
);
ok(content(r)[L.META_FILL_RULE] === 1, 'a clip of a clip: clip-rule from the <clipPath>');
r = await imp(
  `<style>#b path{clip-rule:evenodd}</style>${C}${B()}<g clip-path="url(#c)"><rect ${R} clip-path="url(#b)"/></g>`,
);
ok(content(r)[L.META_FILL_RULE] === 1, "an intersection: a rule through the inner <clipPath>'s id");
r = await imp(
  `<g clip-rule="evenodd">${B()}</g>${C}<g clip-path="url(#c)"><rect ${R} clip-path="url(#b)"/></g>`,
);
ok(
  content(r)[L.META_FILL_RULE] === 1,
  "an intersection: clip-rule from the <clipPath>'s ancestor, not the referencing element's",
);
r = await imp(
  `${C}${B()}<g clip-rule="evenodd" clip-path="url(#c)"><rect ${R} clip-path="url(#b)"/></g>`,
);
ok(
  content(r)[L.META_FILL_RULE] === 0,
  "an intersection: the referencing element's clip-rule does not reach the content",
);
r = await imp(
  `${C}<clipPath id="o" clipPathUnits="objectBoundingBox" clip-rule="evenodd"><path d="M0 0H1V1H0Z"/></clipPath><g clip-path="url(#c)"><rect width="10" height="10" clip-path="url(#o)"/></g>`,
);
ok(
  content(r) && content(r)[L.META_FILL_RULE] === 1,
  'an objectBoundingBox clip inside another: clip-rule from its <clipPath>',
);

console.log('(b) a binary mask over a leaf that names a mask');
const A = '<mask id="a"><rect width="50" height="100" fill="white"/></mask>',
  G = '<mask id="b"><rect width="100" height="50" fill="#888"/></mask>';
r = await imp(`${A}${G}<g mask="url(#a)"><rect ${R} mask="url(#b)"/></g>`);
ok(
  r.filter((x) => x[L.META_MASK_ID] > 0 && !(x[L.META_FLAGS_SHAPE] & 0x100)).length === 2,
  "both masks stay: the group's on a group row, the leaf's on the leaf",
);
ok(r[0][L.META_FLAGS_SHAPE] === L.FS_GROUP_BEGIN, 'the group opens');
r = await imp(
  `${A}${G}<defs><rect id="u" ${R} mask="url(#b)"/></defs><g mask="url(#a)"><use href="#u"/></g>`,
);
ok(
  r[0][L.META_FLAGS_SHAPE] === L.FS_GROUP_BEGIN &&
    r[0][L.META_MASK_ID] > 0 &&
    r[1][L.META_MASK_ID] > 0,
  'the leaf is behind a <use>',
);
r = await imp(
  `${A}${G}<defs><rect id="u" ${R} mask="url(#b)"/></defs><use href="#u" mask="url(#a)"/>`,
);
ok(
  r[0][L.META_FLAGS_SHAPE] === L.FS_GROUP_BEGIN &&
    r[0][L.META_MASK_ID] > 0 &&
    r[1][L.META_MASK_ID] > 0,
  'the binary mask is on a <use> of the leaf',
);
r = await imp(`${A}<g mask="url(#a)"><rect ${R}/><rect x="20" ${R}/></g>`);
ok(
  r[0][L.META_FLAGS_SHAPE] === 0 && r[0][L.META_MASK_ID] > 0 && r[1][L.META_MASK_ID] > 0,
  'no leaf names a mask: the binary mask rides down, no group (unchanged)',
);

console.log('(b) mask="none" under a masked group');
r = await imp(`${A}<g mask="url(#a)"><rect ${R}/><rect x="20" ${R} mask="none"/></g>`);
ok(
  r[0][L.META_MASK_ID] > 0 && r[1][L.META_MASK_ID] === r[0][L.META_MASK_ID],
  'the binary mask rides past mask="none"',
);
r = await imp(
  `<mask id="g"><rect width="100" height="100" fill="#888"/></mask><g mask="url(#g)"><rect x="20" ${R} mask="none"/></g>`,
);
ok(r[0][L.META_MASK_ID] > 0, 'a one-leaf group\'s mask rides past mask="none"');
r = await imp(`<rect ${R} mask="none"/>`);
ok(r[0][L.META_MASK_ID] === 0, 'mask="none" with no ancestor mask is no mask');

console.log(fail ? `\nimportDefContentSmoke: ${fail} failed` : '\nimportDefContentSmoke: passed');
process.exit(fail ? 1 : 0);
