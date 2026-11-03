// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzHullContain — how much subdivision the CONTAINMENT invariant actually asks for, and what it
// would cost.
//
// A Loop-Blinn face carries one curve's implicit, so the model is only sound where a piece's
// control hull holds nothing of the shape but its own arc. Subdividing shrinks a hull onto its arc,
// so the invariant is always reachable -- the question is the PRICE, and the fear is that a thin
// feature (whose neighbouring boundary is a fraction of a pixel away) demands unbounded splitting.
// This counts the splits the invariant requires, per curve, without building anything.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { cubicSlice, cubicHull } from '../src/geom/lbCubicMath.js';
import { segPt } from '../src/geom/cpatchImplicit.js';
import { parseMetaBin } from '../src/core/metaBin.js';

const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const MAXD = +(process.env.MAXD || 12);

const inHull = (H, x, y) => {
  // H is a convex polygon of control points (3 or 4). Inside = same side of every edge.
  let pos = 0,
    neg = 0;
  for (let i = 0; i < H.length; i++) {
    const a = H[i],
      b = H[(i + 1) % H.length];
    const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (c > 0) pos++;
    else if (c < 0) neg++;
  }
  return pos === 0 || neg === 0;
};

let curves = 0,
  pieces = 0,
  unmet = 0,
  deepest = 0;
const depthHist = new Map();
for (let s = 0; s < meta.numShapes; s++) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  let cs = null;
  try {
    cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  } catch {
    continue;
  }
  let cv = null;
  try {
    cv = contoursToConverter(cs, null);
  } catch {
    continue;
  }
  if (!cv) continue;
  const segs = [];
  for (const c of cv) for (const sg of c) segs.push(sg);
  // Sample every OTHER segment densely; a hull containing any of those samples violates it.
  const pts = [];
  for (const sg of segs) {
    const P = [];
    for (let t = 0; t <= 1.0001; t += 1 / 24) P.push(segPt(sg, t));
    pts.push({ sg, P, a: segPt(sg, 0), b: segPt(sg, 1) });
  }
  for (const sg of segs) {
    if (sg.t !== 'cubic' || sg.P.length !== 4) continue;
    curves++;
    const A0 = segPt(sg, 0),
      B0 = segPt(sg, 1);
    const near = (p) =>
      Math.hypot(p[0] - A0[0], p[1] - A0[1]) < 1e-7 ||
      Math.hypot(p[0] - B0[0], p[1] - B0[1]) < 1e-7;
    const others = pts.filter((o) => o.sg !== sg && !(near(o.a) || near(o.b)));
    const P0 = sg.P.map((p) => [p[0], p[1]]);
    const stack = [[0, 1, 0]];
    while (stack.length) {
      const [t0, t1, d] = stack.pop();
      const piece = cubicSlice(P0, t0, t1);
      // cubicHull returns INDICES into the control points, not points (lbPartition reads
      // P[hull[0]]); treating them as coordinates makes every hull a sliver near the origin and
      // every test fail.
      const hi = cubicHull(piece);
      const H = hi && hi.length >= 3 ? hi.map((i2) => piece[i2]) : piece;
      let bad = false;
      for (const o of others) {
        for (const q of o.P)
          if (inHull(H, q[0], q[1])) {
            bad = true;
            break;
          }
        if (bad) break;
      }
      if (!bad || d >= MAXD) {
        pieces++;
        if (bad) unmet++;
        if (d > deepest) deepest = d;
        depthHist.set(d, (depthHist.get(d) || 0) + 1);
        continue;
      }
      const tm = (t0 + t1) / 2;
      stack.push([t0, tm, d + 1], [tm, t1, d + 1]);
    }
  }
}
console.log(
  `${curves} cubics -> ${pieces} pieces for "no other boundary inside my hull" (${(pieces / Math.max(1, curves)).toFixed(2)}x)`,
);
console.log(`  deepest split ${deepest}, still violating at the depth cap: ${unmet}`);
console.log(
  '  pieces by split depth: ' +
    [...depthHist]
      .sort((a, b) => a[0] - b[0])
      .map(([d, n]) => `${d}:${n}`)
      .join(' '),
);
