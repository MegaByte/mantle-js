// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// markerAspectSmoke — a marker's viewBox is fitted into its viewport by preserveAspectRatio.
//
// WHY. Scaling a marker's content by markerWidth / viewBox width on x and markerHeight / viewBox height on y, each on
// its own, is preserveAspectRatio="none" whatever the marker says. The default is "xMidYMid meet": one scale, the
// smaller ratio ("slice", the larger), so a marker whose viewBox is not the shape of its viewport must not come out
// stretched. And a marker with NO viewBox is not fitted as if its viewBox were "0 0 3 3": its content is in the
// viewport's own units, and such a fit would draw it markerWidth / 3 times too big.
//
// SO instantiateMarker fits the viewBox as preserveAspectRatio says (meet / slice uniform, none per axis); the
// alignment moves the fitted content and its reference point together, so the placement does not see it -- it only
// chooses what the viewport clip keeps, which the hit test honors: under "slice" the arrow overflows
// its 30 x 30 viewport and is cut to it. With no viewBox the content is unscaled.
//
// An asymmetric filled arrow, viewBox 0 0 10 20 in a 30 x 30 viewport (markerUnits userSpaceOnUse), at the end of a line,
// under the default fit, "xMinYMax meet", "none", "xMidYMid slice", and with no viewBox (markerWidth 30); plain and
// under rotate(30) scale(2). The reference is the float64 placement SVG specifies; the hit test answers every point
// clear of the arrow's outline (by 1% of its size) on the right side.
import { fillHits, HitMode } from '../src/hitTest/index.js';
// Rendered marker geometry is probed through HitMode.Coverage: SVG 2 §13.7.4 "Markers cannot be interacted with", so the default (SVG) model never targets marker content.

if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const D2R = Math.PI / 180;
const mm = (P, Q) => [
  P[0] * Q[0] + P[2] * Q[1],
  P[1] * Q[0] + P[3] * Q[1],
  P[0] * Q[2] + P[2] * Q[3],
  P[1] * Q[2] + P[3] * Q[3],
  P[0] * Q[4] + P[2] * Q[5] + P[4],
  P[1] * Q[4] + P[3] * Q[5] + P[5],
];
const rot = (d) => [
  Math.cos(d * D2R),
  Math.sin(d * D2R),
  -Math.sin(d * D2R),
  Math.cos(d * D2R),
  0,
  0,
];
const ARROW = [
  [1, 2],
  [9, 6],
  [5, 9],
  [9, 16],
  [2, 18],
]; // in viewBox units, inside 0 0 10 20
const REF = [2, 10],
  MW = 30,
  MH = 30,
  END = [20, 0];
// [attribute text, the content's scale (x, y), the viewport in content units (x0, y0, x1, y1)]
const FITS = [
  ['', [1.5, 1.5], [-5, 0, 15, 20]], // the default, xMidYMid meet: min(30/10, 30/20)
  ['preserveAspectRatio="xMinYMax meet"', [1.5, 1.5], [0, 0, 20, 20]],
  ['preserveAspectRatio="none"', [3, 1.5], [0, 0, 10, 20]],
  ['preserveAspectRatio="xMidYMid slice"', [3, 3], [0, 5, 10, 15]], // 30 x 60 centered on 30 x 30: y cut to 5..15
  ['NOVIEWBOX', [1, 1], [0, 0, 30, 30]], // no viewBox: the viewport's own units
];
const CARRIERS = [
  ['plain', [1, 0, 0, 1, 0, 0]],
  ['rotate(30) scale(2)', mm(rot(30), [2, 0, 0, 2, 0, 0])],
];
const T = [50, 100],
  SIZE = 200;
const polyIn = (P, q) => {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const a = P[j],
      b = P[i];
    if (
      a[1] > q[1] !== b[1] > q[1] &&
      q[0] < a[0] + ((q[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
    )
      inside = !inside;
  }
  return inside;
};
const polyDist = (P, q) => {
  let d = Infinity;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const a = P[j],
      b = P[i],
      ex = b[0] - a[0],
      ey = b[1] - a[1];
    const t = Math.max(
      0,
      Math.min(1, ((q[0] - a[0]) * ex + (q[1] - a[1]) * ey) / (ex * ex + ey * ey)),
    );
    d = Math.min(d, Math.hypot(q[0] - a[0] - ex * t, q[1] - a[1] - ey * t));
  }
  return d;
};
const rectDist = (R, q) =>
  Math.min(
    Math.abs(q[0] - R[0]),
    Math.abs(q[0] - R[2]),
    Math.abs(q[1] - R[1]),
    Math.abs(q[1] - R[3]),
  );
const rectIn = (R, q) => q[0] > R[0] && q[0] < R[2] && q[1] > R[1] && q[1] < R[3];
for (const [cname, C] of CARRIERS)
  for (const [attr, [kx, ky], VP] of FITS) {
    const vb = attr === 'NOVIEWBOX' ? '' : `viewBox="0 0 10 20" ${attr}`;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><defs>` +
      `<marker id="m" ${vb} refX="${REF[0]}" refY="${REF[1]}" markerWidth="${MW}" markerHeight="${MH}" markerUnits="userSpaceOnUse" orient="0">` +
      `<path d="M${ARROW.map((p) => p.join(' ')).join(' L')} Z" fill="#000"/></marker></defs>` +
      `<g transform="translate(${T[0]} ${T[1]}) ${cname === 'plain' ? '' : cname}"><path d="M-20 0 L${END[0]} ${END[1]}" fill="none" stroke="none" marker-end="url(#m)"/></g></svg>`;
    const b = await importSvg(svg, { preserveViewport: true });
    // content point p -> document: T C (END + diag(kx, ky) (p - REF))
    const W = mm([1, 0, 0, 1, T[0], T[1]], C);
    const place = mm(W, [kx, 0, 0, ky, END[0] - kx * REF[0], END[1] - ky * REF[1]]);
    const det = place[0] * place[3] - place[1] * place[2];
    const inv = [
      place[3] / det,
      -place[1] / det,
      -place[2] / det,
      place[0] / det,
      (place[2] * place[5] - place[3] * place[4]) / det,
      (place[1] * place[4] - place[0] * place[5]) / det,
    ];
    const toContent = (x, y) => [
      inv[0] * x + inv[2] * y + inv[4],
      inv[1] * x + inv[3] * y + inv[5],
    ];
    let n = 0,
      nIn = 0,
      bad = 0,
      first = '';
    for (let y = 0; y < SIZE; y += 0.53)
      for (let x = 0; x < SIZE; x += 0.53) {
        const q = toContent(x, y);
        if (polyDist(ARROW, q) < 0.2 || rectDist(VP, q) < 0.2) continue; // 1% of the arrow's 20-unit height
        const want = polyIn(ARROW, q) && rectIn(VP, q);
        n++;
        if (want) nIn++;
        const got = fillHits(b, x, y, { mode: HitMode.Coverage }).length > 0;
        if (got !== want) {
          bad++;
          if (!first)
            first = `(${x.toFixed(2)}, ${y.toFixed(2)}): ${got ? 'in' : 'out'} for ${want ? 'in' : 'out'}`;
        }
      }
    const what = attr === 'NOVIEWBOX' ? 'no viewBox' : attr || 'the default fit';
    ok(
      nIn > 50 && bad === 0,
      `${cname}, ${what}: of ${n} points clear of the arrow (${nIn} inside it), ${bad} on the wrong side${first ? ' -- first ' + first : ''}`,
    );
  }
console.log(fail ? `MARKER-ASPECT FAIL (${fail})` : 'MARKER-ASPECT PASS');
process.exit(fail ? 1 : 0);
