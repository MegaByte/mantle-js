// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterLinearBlurRenderSmoke -- a lone blur of SourceGraphic in linearRGB is the single-kind in-place blur on linear light (filterTab kind 7).
// Each cell is drawn twice by Mantle: as the record (the filter alone) and as the graph form of it (the same blur followed by a
// one-node feMerge, which keeps the graph route and adds no conversion). The two must agree to the byte (a byte of slack for the cell edge), and
// the record is also held to Chrome's own SVG engine at 8x, box-averaged, like filterLinearRenderSmoke.
//
//   FLB_ONLY=a,b   run only the cells whose id starts with one of the prefixes
//   FLB_ROUTES=none  the fill routes (default both: 'none' = cover quads, 'lb' = the unified Loop-Blinn route)
import { launchBrowser } from './_launch.mjs';
import { openChrome8Ref, compare } from './_chrome8Ref.mjs';

const W = 128,
  H = 128;
const doc = (body, defs = '', extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 64 64" ${extra}><rect width="64" height="64" fill="white"/><defs>${defs}</defs>${body}</svg>`;
const SRC =
  '<rect x="12" y="12" width="28" height="28" fill="#e04020"/><circle cx="40" cy="40" r="13" fill="#2060d0" fill-opacity=".75"/><rect x="26" y="8" width="6" height="48" fill="#20a040" fill-opacity=".5"/>';
const GRAD =
  '<linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#ff2000"/><stop offset="1" stop-color="#0020ff" stop-opacity=".4"/></linearGradient><rect x="14" y="14" width="36" height="36" rx="6" fill="url(#g)"/>';
const REG = 'filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"';
// [id, blur attrs, body, { attrs: on the filter, g: on the group/shape, mean, bound for the Chrome cell }]
const CELLS = [
  ['iso', 'stdDeviation="3"', SRC, {}],
  ['small', 'stdDeviation="0.8"', SRC, {}],
  ['aniso', 'stdDeviation="5 1"', SRC, {}],
  ['xonly', 'stdDeviation="4 0"', SRC, {}],
  ['grad', 'stdDeviation="2.5"', GRAD, {}],
  ['opacity', 'stdDeviation="3"', SRC, { g: 'opacity=".6"' }],
  ['scaled', 'stdDeviation="2"', SRC, { g: 'transform="scale(.8) translate(6 6)"' }],
  ['rotated', 'stdDeviation="3"', SRC, { g: 'transform="rotate(20 32 32)"' }],
  ['box', 'stdDeviation="40"', SRC, { mean: 3.5 }], // past the Gaussian table: a box first pass takes its own conversion pass
  ['wide', 'stdDeviation="9"', SRC, {}],
  [
    'default-region',
    'stdDeviation="3"',
    '<rect x="20" y="20" width="24" height="24" fill="#e04020"/>',
    { region: false },
  ],
];
const svgOf = (blur, body, { attrs = '', g = '', region = true } = {}, graph = false) =>
  doc(
    `<g filter="url(#f)" ${g}>${body}</g>`,
    `<filter id="f" ${region ? REG : ''} ${attrs}><feGaussianBlur ${blur}${graph ? ' result="r"/><feMerge><feMergeNode in="r"/></feMerge>' : '/>'}</filter>`,
  );

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const only = process.env.FLB_ONLY ? process.env.FLB_ONLY.split(',') : null;
const ROUTES = process.env.FLB_ROUTES ? process.env.FLB_ROUTES.split(',') : ['none', 'lb'];
const ref = await openChrome8Ref(launchBrowser);
try {
  for (const route of ROUTES)
    for (const [cid, blur, body, o] of CELLS) {
      if (only && !only.some((p) => cid.startsWith(p))) continue;
      const id = `${cid}@${route}`;
      const rec = await ref.render(svgOf(blur, body, o), { w: W, h: H, route });
      const gra = await ref.render(svgOf(blur, body, o, true), { w: W, h: H, route });
      const same = compare(rec.mantle, gra.mantle, W, H, { tol: 1 });
      const cr = compare(rec.mantle, rec.chrome, W, H, { tol: 8, edge: rec.chrome });
      const meanB = o.mean ?? 1.5;
      const line = `${id}: record vs graph max ${same.max} over ${same.over} (mean ${same.mean.toFixed(4)}); vs Chrome mean ${cr.mean.toFixed(2)} (bound ${meanB})`;
      if (same.max > 1 || same.over > 0 || !(cr.mean <= meanB)) fail(line);
      else console.log('ok ' + line);
    }
} catch (e) {
  fail('setup: ' + ((e && e.stack) || e));
}
for (const m of ref.pageErrors) fail('page: ' + m);
await ref.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nfilterLinearBlurRenderSmoke: a lone linearRGB blur is the in-place record, byte-equal to the graph it replaced and within bounds of Chrome',
);
