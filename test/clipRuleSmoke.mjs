// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// clipRuleSmoke — a shape inside a <clipPath> winds by `clip-rule`, not `fill-rule`
// (CSS Masking 1 §6.2.1: clip-rule "applies to graphics elements within a clipPath"; it inherits, and
// its initial value is nonzero).
//
// The clip drain walks clip content through the ordinary shape handler, which stores the shape's
// fill-rule; storing it for clip content would make `<clipPath clip-rule="evenodd">` clip nonzero (a
// donut clip comes out a disc) and let a clip child's own fill-rule="evenodd" -- which a clip ignores --
// cut a hole. So the drain marks its walk (walkCtx.inClipContent) and the handler takes clip-rule there; the
// computeSilhouette clip reader does the same so it agrees with what is drawn. Mask content still winds
// by fill-rule (a mask paints), and so does a pattern claimed from inside clip content.
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import importSvg from '../src/svg/importer.js';
import { parseMetaBin } from '../src/core/metaBin.js';
import * as M from '../src/bundle/layout.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
/// The fill rule (0 nonzero, 1 evenodd) of every row painted with fill color `h`.
function rulesOf(b, h) {
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats,
    want = hex(h),
    out = [];
  const ids = { '#700001': 'clip1', '#700002': 'clip2', '#700003': 'clip3', '#700004': 'ring' };
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * pm.floatsPerShape;
    if (
      ids[h]
        ? b.shapeIds[s] === ids[h]
        : want.every((v, i) => Math.abs(F[o + 4 + i] - v) < 0.6 / 255)
    )
      out.push(F[o + M.META_FILL_RULE]);
  }
  return out;
}
const RING = 'M10 10 L90 10 L90 90 L10 90 Z M30 30 L70 30 L70 70 L30 70 Z'; // same winding: a hole only under evenodd
const b = await importSvg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><defs>
    <clipPath id="c1"><path d="${RING}" clip-rule="evenodd" fill="#700001" id="clip1"/></clipPath>
    <clipPath id="c2" clip-rule="evenodd"><path d="${RING}" fill="#700002" id="clip2"/></clipPath>
    <clipPath id="c3"><path d="${RING}" fill-rule="evenodd" fill="#700003" id="clip3"/></clipPath>
    <clipPath id="c4"><use href="#ring" clip-rule="evenodd"/></clipPath>
    <path id="ring" d="${RING}" fill="#700004"/>
    <mask id="m1"><path d="${RING}" fill-rule="evenodd" clip-rule="nonzero" fill="#700005"/></mask>
  </defs>
  <rect width="100" height="100" fill="#000" clip-path="url(#c1)"/>
  <rect x="100" width="100" height="100" fill="#000" clip-path="url(#c2)"/>
  <rect x="200" width="100" height="100" fill="#000" clip-path="url(#c3)"/>
  <rect x="300" width="100" height="100" fill="#000" clip-path="url(#c4)"/>
  <rect width="100" height="100" fill="#000" mask="url(#m1)"/>
</svg>`,
  { preserveViewport: true },
);

for (const [h, want, what] of [
  ['#700001', 1, 'a clip child\'s own clip-rule="evenodd"'],
  ['#700002', 1, 'clip-rule="evenodd" inherited from the <clipPath>'],
  ['#700003', 0, 'a clip child\'s fill-rule="evenodd" is ignored (clip-rule is nonzero)'],
  ['#700004', 1, 'clip-rule on a <use> inside the <clipPath> reaches its target'],
  ['#700005', 1, 'mask content still winds by fill-rule'],
]) {
  const r = rulesOf(b, h);
  ok(
    r.length > 0 && r.every((v) => v === want),
    `${what}: rule ${r.join(', ') || 'no row'}, want ${want ? 'evenodd' : 'nonzero'}`,
  );
}

console.log(fail ? `clipRuleSmoke FAIL (${fail})` : 'clipRuleSmoke PASS');
process.exit(fail ? 1 : 0);
