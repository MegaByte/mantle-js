// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verify transformed marker polygons and stroked rings against local-space geometry.
// Ring queries also exercise the generated stroke shader in float32.
import path from 'path';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { fillHits, HitMode } from '../src/hitTest/index.js';
// Rendered marker geometry is probed through HitMode.Coverage: SVG 2 §13.7.4 "Markers cannot be interacted with", so the default (SVG) model never targets marker content.

if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const CARRIERS = [
  ['identity', [1, 0, 0, 1, 0, 0]],
  ['scale(2 1.5)', [2, 0, 0, 1.5, 0, 0]],
  ['skewX(30)', [1, 0, Math.tan(30 * D2R), 1, 0, 0]],
  ['rotate(30) scale(3 1)', mm(rot(30), [3, 0, 0, 1, 0, 0])],
  ['scale(-1 1)', [-1, 0, 0, 1, 0, 0]],
  ['scale(-2 1.5) rotate(20)', mm([-2, 0, 0, 1.5, 0, 0], rot(20))],
];
const ARROW = [
  [0, 0],
  [10, 2],
  [6, 5],
  [10, 9],
  [1, 10],
]; // asymmetric: a reflection shows
const PATH = [
    [-30, -10],
    [0, 10],
    [30, -5],
  ],
  SW = 2,
  T = [100, 100];
const svgOf = (t) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><defs>` +
  `<marker id="arr" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="8" markerHeight="8" orient="auto">` +
  `<path d="M${ARROW.map((p) => p.join(' ')).join(' L')} Z" fill="#000"/></marker>` +
  `<marker id="ring" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="8" markerHeight="8" orient="auto">` +
  `<circle cx="5" cy="5" r="3" fill="none" stroke="#000" stroke-width="1.5"/></marker></defs>` +
  `<g transform="translate(${T[0]} ${T[1]}) ${t === 'identity' ? '' : t}"><path d="M${PATH.map((p) => p.join(' ')).join(' L')}" fill="none" stroke="none"` +
  ` stroke-width="${SW}" marker-start="url(#ring)" marker-mid="url(#ring)" marker-end="url(#arr)"/></g></svg>`;

/// Each marker's full transform (marker space -> document), in float64: CTM x translate(vertex) rotate(angle)
/// scale(markerWidth / viewBox * strokeWidth) translate(-ref).
function placements(C) {
  const ang = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  const t0 = ang(PATH[0], PATH[1]),
    t1 = ang(PATH[1], PATH[2]);
  const mid = Math.atan2(Math.sin(t0) + Math.sin(t1), Math.cos(t0) + Math.cos(t1));
  const place = (v, a, mw, ref) => {
    const s = (mw / 10) * SW,
      c = Math.cos(a),
      sn = Math.sin(a);
    return [
      c * s,
      sn * s,
      -sn * s,
      c * s,
      v[0] - (c * s * ref[0] - sn * s * ref[1]),
      v[1] - (sn * s * ref[0] + c * s * ref[1]),
    ];
  };
  const W = mm([1, 0, 0, 1, T[0], T[1]], C);
  return {
    rings: [mm(W, place(PATH[0], t0, 8, [5, 5])), mm(W, place(PATH[1], mid, 8, [5, 5]))],
    arrow: mm(W, place(PATH[2], t1, 8, [2, 5])),
  };
}
const inv = (M) => {
  const d = M[0] * M[3] - M[1] * M[2];
  return [
    M[3] / d,
    -M[1] / d,
    -M[2] / d,
    M[0] / d,
    (M[2] * M[5] - M[3] * M[4]) / d,
    (M[1] * M[4] - M[0] * M[5]) / d,
  ];
};
const ap = (M, p) => [M[0] * p[0] + M[2] * p[1] + M[4], M[1] * p[0] + M[3] * p[1] + M[5]];
/// Signed distance to a closed polygon (negative inside), in its own space.
function polySd(P, q) {
  let d = Infinity,
    inside = false;
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
    if (a[1] > q[1] !== b[1] > q[1] && q[0] < a[0] + ((q[1] - a[1]) * ex) / ey) inside = !inside;
  }
  return inside ? -d : d;
}

const emu = EMU.hasCxx() ? EMU.buildGlslEmu(ROOT, { stroke: true }) : null;
// THE HIT TEST ANSWERS AS THE RENDER DRAWS: a fill is hit where the exact coverage of the pixel box reaches one half
//, and the reference here is the outline itself. The two agree wherever a pixel is small against the
// feature; at one unit per pixel (no world matrix) they did not at four points 0.16 units inside the arrow and within
// half a pixel of a convex corner (0.34-0.50 units), where the box is under half covered and the render draws the
// pixel under half. So the queries are made 16 px to the unit: the margins are then 2.5 px and more.
const ZOOM = 16,
  ZOOM_M = [ZOOM, 0, 0, 0, ZOOM, 0, 0, 0, 1];
for (const [t, C] of CARRIERS) {
  const b = await importSvg(svgOf(t), { preserveViewport: true });
  const { rings, arrow } = placements(C);
  const ringsInv = rings.map(inv),
    arrowInv = inv(arrow);
  // the reference, with a margin (marker units): 1% of the ring's half-width, 1% of the arrow's size
  const ref = (p) => {
    let inR = false,
      clear = true;
    for (const Mi of ringsInv) {
      const q = ap(Mi, p),
        e = Math.abs(Math.hypot(q[0] - 5, q[1] - 5) - 3) - 0.75;
      if (Math.abs(e) < 0.0075) clear = false;
      if (e <= 0) inR = true;
    }
    const sd = polySd(ARROW, ap(arrowInv, p));
    if (Math.abs(sd) < 0.1) clear = false;
    return { inRing: inR, inArrow: sd <= 0, clear };
  };
  const meta = new Float32Array(b.meta, 32);
  const strokeRows = [],
    fillRows = [];
  for (let i = 0; i < b.numShapes; i++) {
    if (meta[i * 48 + 12] > 0) strokeRows.push(i);
    else if (meta[i * 48 + 7] > 0) fillRows.push(i);
  }
  let hitBad = 0,
    n = 0,
    nIn = 0,
    first = '';
  const pts = [];
  // a grid over each marker's document box (its viewBox, 10% margin, mapped)
  const grid = [];
  for (const Wm of [...rings, arrow]) {
    const cs = [
      [-1, -1],
      [11, -1],
      [11, 11],
      [-1, 11],
    ].map((c) => ap(Wm, c));
    const x0 = Math.min(...cs.map((c) => c[0])),
      x1 = Math.max(...cs.map((c) => c[0]));
    const y0 = Math.min(...cs.map((c) => c[1])),
      y1 = Math.max(...cs.map((c) => c[1]));
    for (let y = y0; y < y1; y += 0.23) for (let x = x0; x < x1; x += 0.23) grid.push([x, y]);
  }
  for (const [x, y] of grid) {
    const r = ref([x, y]);
    if (!r.clear) continue;
    n++;
    const hits = fillHits(b, x * ZOOM, y * ZOOM, { mode: HitMode.Coverage, worldMatrix: ZOOM_M });
    const got = hits.some((i) => strokeRows.includes(i)),
      gotA = hits.some((i) => fillRows.includes(i));
    if (got !== r.inRing || gotA !== r.inArrow) {
      hitBad++;
      if (!first)
        first = `(${x.toFixed(2)}, ${y.toFixed(2)}): ring ${got} for ${r.inRing}, arrow ${gotA} for ${r.inArrow}`;
    }
    if (r.inRing || r.inArrow) nIn++;
    if (r.inRing || n % 20 === 0) pts.push({ p: [x, y], want: r.inRing });
  }
  let rendBad = 0;
  if (emu) {
    // the ring rows' walk at the sampled points: in either ring row
    const qs = [];
    for (const i of strokeRows) {
      const o = i * 48,
        m = (k) => meta[o + k],
        framed = (Math.round(m(27)) & 4) !== 0,
        cap = m(24) | 0;
      for (const { p } of pts)
        for (const which of [0, 3]) {
          const ex = [m(12) * 0.5, m(26), cap, cap, m(25) | 0, 0, 1, which];
          if (framed)
            qs.push({
              k: EMU.K_STROKE_LOCAL,
              GD: [m(16) | 0, m(17) | 0, m(18) | 0, m(19) | 0],
              bb: [m(0), m(1), m(2), m(3)],
              c: p,
              ePx: [0.05, 0.05],
              ex: [...ex, m(20), m(21), m(22), m(23)],
            });
          else
            qs.push({
              k: EMU.K_STROKE_WALK,
              GD: [m(16) | 0, m(17) | 0, m(18) | 0, m(19) | 0],
              bb: [m(0), m(1), m(2), m(3)],
              c: p,
              ePx: [0.05, 0.05],
              ex: [...ex.slice(0, 7), 0, -1e20],
            });
        }
    }
    const out = emu.run(new Float32Array(b.bands), new Float32Array(b.curves), qs);
    pts.forEach(({ want }, k) => {
      let got = false;
      strokeRows.forEach((i, r) => {
        const o = i * 48,
          framed = (Math.round(meta[o + 27]) & 4) !== 0,
          base = 2 * (r * pts.length + k);
        if (out[base] <= (framed ? out[base + 1] : meta[o + 12] * 0.5)) got = true;
      });
      if (got !== want) {
        rendBad++;
        if (!first)
          first = JSON.stringify({
            p: pts[k].p,
            want,
            got,
            rows: strokeRows.map((i, r) => ({
              row: i,
              values: out.slice(2 * (r * pts.length + k), 2 * (r * pts.length + k) + 2),
              query: qs[2 * (r * pts.length + k)],
            })),
          });
      }
    });
  }
  ok(
    strokeRows.length === 2 && fillRows.length === 1 && nIn > 0 && hitBad === 0 && rendBad === 0,
    `${t}: ${strokeRows.length} ring rows (want 2), ${fillRows.length} arrow row (want 1); of ${n} points (${nIn} inside a marker) clear of the markers' outlines, the hit test puts ${hitBad} on the wrong side, and the walk ${emu ? rendBad : '(skipped)'} of ${pts.length} ring samples${first ? ' -- first ' + first : ''}`,
  );
}
console.log(fail ? `MARKER-TRANSFORM FAIL (${fail})` : 'MARKER-TRANSFORM PASS');
process.exit(fail ? 1 : 0);
