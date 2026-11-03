// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importLeafCascadeSmoke: what a leaf reads comes through the whole cascade, and the CSS-wide keywords mean what they say.
//
// (a) mix-blend-mode, isolation, vector-effect, filter and paint-order on a shape are read through the cascade, as a group's are, not
//     from the style attribute and the presentation attribute only: a stylesheet rule applies, and an inline `!important` value reads.
// (b) stroke: initial is none, not black; fill-opacity: initial does not inherit; visibility: initial is visible;
//     `unset` on an inherited property (stroke-linecap, fill-rule ...) reads the parent's value, not a keyword.
// (c) A compositing group's row has no box of its own, and its [0, 0, 0, 0] must not pull a document without a viewBox out to the origin.
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
const doc = (body, attrs = 'viewBox="0 0 100 100"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const rows = (b) => {
  const m = new Float32Array(b.meta, 32),
    s = b.metaFloatsPerShape || 48,
    out = [];
  for (let r = 0; r < b.numShapes; r++) out.push(m.subarray(r * s, (r + 1) * s));
  return out;
};
const imp = async (body, attrs) => rows(await importSvg(doc(body, attrs)));
const R = 'width="9" height="9"';

console.log('(a) a rule and an !important reach the leaf');
for (const [how, rule, leaf] of [
  ['a stylesheet rule', (d) => `<style>.x{${d}}</style>`, () => `class="x"`],
  ['an inline !important', () => '', (d) => `style="${d} !important"`],
]) {
  let r = await imp(
    rule('mix-blend-mode:multiply') + `<rect ${R} ${leaf('mix-blend-mode:multiply')}/>`,
  );
  ok(r[0][L.META_BLEND_MODE] === 1, `mix-blend-mode by ${how}`);
  r = await imp(rule('isolation:isolate') + `<rect ${R} ${leaf('isolation:isolate')}/>`);
  ok(r[0][L.META_ISOLATION] === 1, `isolation by ${how}`);
  r = await imp(
    rule('vector-effect:non-scaling-stroke') +
      `<path d="M0 0L9 9" fill="none" stroke="red" ${leaf('vector-effect:non-scaling-stroke')}/>`,
  );
  ok((r[0][L.META_FLAGS_SHAPE] & 1) === 1, `vector-effect by ${how}`);
  r = await imp(
    rule('paint-order:stroke') +
      `<rect ${R} fill="blue" stroke="red" ${leaf('paint-order:stroke')}/>`,
  );
  ok(r[0][L.META_STROKE_W] > 0 && r[1][L.META_STROKE_W] === 0, `paint-order by ${how}`);
  r = await imp(
    '<filter id="f"><feGaussianBlur stdDeviation="2"/></filter>' +
      rule('filter:url(#f)') +
      `<rect ${R} fill="blue" stroke="red" ${leaf('filter:url(#f)')}/>`,
  );
  ok(
    r[0][L.META_FLAGS_SHAPE] === L.FS_GROUP_BEGIN &&
      r[0][L.META_FILTER_ID] > 0 &&
      r[1][L.META_FILTER_ID] === 0,
    `a filter by ${how} takes the fill and the stroke as one picture, as the attribute does`,
  );
}
{
  const a = await imp(`<rect ${R} mix-blend-mode="screen"/>`);
  ok(a[0][L.META_BLEND_MODE] === 2, 'the presentation attribute still reads');
}

console.log('(b) the CSS-wide keywords');
let r = await imp(`<g stroke="red"><rect ${R} style="stroke:initial"/></g>`);
ok(r.length === 1 && r[0][L.META_STROKE_W] === 0, 'stroke: initial is none');
r = await imp(`<g stroke="red"><rect ${R} style="stroke:revert"/></g>`);
ok(r.length === 2 && r[1][L.META_STROKE_R] === 1, 'stroke: revert is the inherited value');
r = await imp(`<g fill="red"><rect ${R} style="fill:initial"/></g>`);
ok(r[0][L.META_FILL_R] === 0 && r[0][L.META_FILL_A] === 1, 'fill: initial is black');
r = await imp(`<g fill-opacity="0.5"><rect ${R} style="fill-opacity:initial"/></g>`);
ok(r[0][L.META_FILL_A] === 1, 'fill-opacity: initial is 1');
r = await imp(`<g fill-opacity="0.5"><rect ${R} style="fill-opacity:unset"/></g>`);
ok(r[0][L.META_FILL_A] === 0.5, 'fill-opacity: unset inherits');
r = await imp(`<g visibility="hidden"><rect ${R} style="visibility:initial"/></g>`);
ok(r.length === 1, 'visibility: initial is visible under a hidden parent');
r = await imp(
  `<g stroke-linecap="round" stroke="red"><path d="M0 0L9 9" fill="none" style="stroke-linecap:unset"/></g>`,
);
ok(r[0][L.META_CAP_STYLE] === 1, 'stroke-linecap: unset inherits');
r = await imp(`<g fill-rule="evenodd"><path d="M0 0H9V9Z" style="fill-rule:unset"/></g>`);
ok(r[0][L.META_FILL_RULE] === 1, 'fill-rule: unset inherits');

console.log('(c) a group row does not widen the box');
const b = await importSvg(
  doc(`<g opacity="0.5"><rect x="50" y="50" width="10" height="10"/></g>`, ''),
);
ok(
  b.globalBBox.join() === '50,50,10,10',
  `an opacity group in a document with no viewBox: ${b.globalBBox.join()}`,
);

console.log(fail ? `\nimportLeafCascadeSmoke: ${fail} failed` : '\nimportLeafCascadeSmoke: passed');
process.exit(fail ? 1 : 0);
