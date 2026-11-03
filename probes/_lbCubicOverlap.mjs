// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbCubicOverlap — do LB's cubic pieces OVERLAP, or does each one over-reach on its own?
//
// LB over-covers cubic edges by +0.04 mean while line/quad/arc sit at 0.003, and the audit that
// catches it declines the whole shape to Slug. Excluded already, each by A/B: the Bezout hull
// dilation, the decomposition, the depth claim, and the kind-12 band. What is left is the two
// explanations a sample COUNT cannot separate:
//
//   pieces OVERLAP           two crescents both paint a pixel -> composited twice under OVER
//   each piece OVER-REACHES  one crescent's coverage runs past its own share of the boundary
//
// They need different fixes — a partition repair versus a coverage-function fix — so this measures
// the geometry directly. A partition's pieces should tile: their areas should sum to the shape's
// area, and no two should intersect. Both are computable exactly from the mesh.
import { mkCubic, mkQuad } from '../src/svg/importer.js';
import { buildLoopBlinnPartition } from '../src/renderer/lbPartition.js';
import { splitCubicCusps } from '../src/svg/cubicCusp.js';

const R = 44,
  CX = 64,
  CY = 64;
const contour = (n, k) => {
  const P = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    P.push([CX + R * Math.cos(a), CY + R * Math.sin(a)]);
  }
  const segs = [];
  for (let i = 0; i < n; i++) {
    const p = P[i],
      q = P[(i + 1) % n];
    const mx = (p[0] + q[0]) / 2,
      my = (p[1] + q[1]) / 2;
    const bx = CX + (mx - CX) * 1.18,
      by = CY + (my - CY) * 1.18;
    segs.push(
      mkCubic(
        p,
        [p[0] + (bx - p[0]) * k, p[1] + (by - p[1]) * k],
        [q[0] + (bx - q[0]) * k, q[1] + (by - q[1]) * k],
        q,
      ),
    );
  }
  return segs;
};

const triArea = (t) => Math.abs((t[2] - t[0]) * (t[5] - t[1]) - (t[3] - t[1]) * (t[4] - t[0])) / 2;
// Sutherland-Hodgman: clip polygon `poly` by triangle `t`, return the intersection's area.
function clipArea(poly, t) {
  let out = poly;
  const sgn = (t[2] - t[0]) * (t[5] - t[1]) - (t[3] - t[1]) * (t[4] - t[0]) >= 0 ? 1 : -1;
  for (let e = 0; e < 3; e++) {
    const ax = t[e * 2],
      ay = t[e * 2 + 1],
      bx = t[((e + 1) % 3) * 2],
      by = t[((e + 1) % 3) * 2 + 1];
    const side = (px, py) => sgn * ((bx - ax) * (py - ay) - (by - ay) * (px - ax));
    const nxt = [];
    for (let i = 0; i < out.length; i++) {
      const c = out[i],
        d = out[(i + 1) % out.length];
      const sc = side(c[0], c[1]),
        sd = side(d[0], d[1]);
      if (sc >= 0) nxt.push(c);
      if (sc >= 0 !== sd >= 0) {
        const u = sc / (sc - sd);
        nxt.push([c[0] + (d[0] - c[0]) * u, c[1] + (d[1] - c[1]) * u]);
      }
    }
    out = nxt;
    if (!out.length) return 0;
  }
  let a = 0;
  for (let i = 0; i < out.length; i++) {
    const c = out[i],
      d = out[(i + 1) % out.length];
    a += c[0] * d[1] - d[0] * c[1];
  }
  return Math.abs(a) / 2;
}

for (const n of [4, 8, 16]) {
  const contours = [contour(n, 1.35)].map(splitCubicCusps);
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__lbAuditOff = true;
  let part = null;
  try {
    part = buildLoopBlinnPartition(contours, { fillRule: 'nonzero' });
  } catch (e) {
    /* reported below */
  }
  globalThis.__lbAuditOff = false;
  if (!part) {
    console.log('  ' + n + ' segs: partition still null');
    continue;
  }
  const pieces = [];
  const inter = part.interior || new Float32Array(0);
  for (let i = 0; i + 5 < inter.length; i += 6)
    pieces.push({
      t: [inter[i], inter[i + 1], inter[i + 2], inter[i + 3], inter[i + 4], inter[i + 5]],
      kind: 'tri',
    });
  for (const c of part.cubics || [])
    if (c.hull) pieces.push({ t: Array.from(c.hull), kind: 'cubic' });
  for (const q of part.quads || [])
    if (q.tri) pieces.push({ t: Array.from(q.tri).slice(0, 6), kind: 'quad' });
  let sum = 0;
  for (const p of pieces) sum += triArea(p.t);
  let ov = 0,
    pairs = 0;
  for (let i = 0; i < pieces.length; i++)
    for (let j = i + 1; j < pieces.length; j++) {
      const poly = [
        [pieces[i].t[0], pieces[i].t[1]],
        [pieces[i].t[2], pieces[i].t[3]],
        [pieces[i].t[4], pieces[i].t[5]],
      ];
      const a = clipArea(poly, pieces[j].t);
      if (a > 1e-9) {
        ov += a;
        pairs++;
      }
    }
  const kinds = {};
  for (const p of pieces) kinds[p.kind] = (kinds[p.kind] | 0) + 1;
  console.log(
    '  ' +
      String(n).padStart(2) +
      ' segs   pieces ' +
      String(pieces.length).padStart(4) +
      ' (' +
      Object.entries(kinds)
        .map(([k, v]) => k + ':' + v)
        .join(' ') +
      ')' +
      '   hull area ' +
      sum.toFixed(1) +
      '   OVERLAP ' +
      ov.toFixed(2) +
      ' over ' +
      pairs +
      ' pairs' +
      '   (' +
      ((100 * ov) / Math.max(sum, 1e-9)).toFixed(1) +
      '% of hull area)',
  );
}
console.log(
  '\n  A partition tiles: overlap 0. Hull area exceeds SHAPE area legitimately — a crescent\n' +
    '  hull covers the chord-to-curve region and the implicit trims it — so overlap, not area, is\n  the signal.',
);

// WHICH INTERIOR FACES CARRY A BOUNDARY CHAIN. A face with no chain and no edge rows returns 1.0
// — solid — and every over-covered pixel measured is pinned at exactly 1.0, so the faces that
// straddle the boundary WITHOUT a chain are the defect. Counted here against the contour.
{
  const segs =
    process.env.QUAD === '1'
      ? (() => {
          const n = 16,
            R = 44,
            CX = 64,
            CY = 64,
            P = [];
          for (let i = 0; i < n; i++) {
            const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
            P.push([CX + R * Math.cos(a), CY + R * Math.sin(a)]);
          }
          const out = [];
          for (let i = 0; i < n; i++) {
            const p = P[i],
              q = P[(i + 1) % n];
            const mx = (p[0] + q[0]) / 2,
              my = (p[1] + q[1]) / 2;
            out.push(mkQuad(p, [CX + (mx - CX) * 1.18, CY + (my - CY) * 1.18], q));
          }
          return out;
        })()
      : contour(16, 1.35);
  const contours = [segs].map(splitCubicCusps);
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__lbAuditOff = true;
  let part = null;
  try {
    part = buildLoopBlinnPartition(contours, { fillRule: 'nonzero' });
  } catch {}
  globalThis.__lbAuditOff = false;
  if (part) {
    console.log(
      '  hulls9: ' +
        ((part.hulls9 && part.hulls9.length) | 0) +
        '   cubicRecs9: ' +
        ((part.cubicRecs9 && part.cubicRecs9.length) | 0) +
        '   route: ' +
        (part._route || '?') +
        '   stripArcs: ' +
        ((part.stripArcs && part.stripArcs.length) | 0),
    );
    console.log(
      '\n  partition fields: ' +
        Object.keys(part)
          .filter((k) => part[k] != null)
          .join(' '),
    );
    const inter = part.interior || new Float32Array(0);
    const nF = (inter.length / 6) | 0;
    const chain = part.interiorChainA || part.chainA || null;
    const edges = part.interiorEdges || null;
    console.log(
      '  interior faces: ' +
        nF +
        '   chainA: ' +
        (chain ? chain.length + ' floats' : 'ABSENT') +
        '   interiorEdges: ' +
        (edges ? edges.length + ' floats' : 'ABSENT'),
    );
    // How many faces have an all-zero chain AND all-zero edges -> solid?
    if (chain) {
      let solid = 0,
        chained = 0;
      const per = chain.length / Math.max(nF, 1);
      for (let f = 0; f < nF; f++) {
        let any = false;
        for (let k = 0; k < per; k++)
          if (chain[f * per + k] !== 0) {
            any = true;
            break;
          }
        if (any) chained++;
        else solid++;
      }
      console.log('  faces WITH a chain: ' + chained + '   faces solid (no chain): ' + solid);
    }
  }
}
