// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// signedAreaCoverageSmoke.mjs — validate the signed-area coverage module against
// exact ground truth (per-pixel polygon∩pixel area via Sutherland–Hodgman) and prove
// it is CONFLATION-FREE (a shape split into abutting triangles has NO seam on the
// shared edge — the property the per-primitive path lacks).
//
// (5) every curve is cut at every integer x and y it crosses, and an edge entering from outside the grid keeps
// its x. Searching for a curve's crossings over x(0), x(0.5), x(1) only drops crossings at any other extremum, and
// moving a top-clipped edge's x0 without its y0 shifts an edge entering from above by -y0 * dxdy: either puts
// coverageAtPixel off by up to a whole pixel on random line, quad and cubic cells. None of (1)-(4) reaches either case. Checked against the independent f64
// reference, probes/fillperf/cellCoverage.mjs, and a raster whose art runs off the top against the same art in view.
import {
  signedAreaCoverage,
  signedAreaCoverageSegs,
  coverageAtPixel,
} from '../src/renderer/signedAreaCoverage.js';
import { cellCoverage } from '../probes/fillperf/cellCoverage.mjs';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

// exact area of poly ∩ [x0,x1]×[y0,y1]
function clipArea(poly, x0, y0, x1, y1) {
  const clip = (pts, inside, isect) => {
    const o = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length],
        b = pts[i];
      const ia = inside(a),
        ib = inside(b);
      if (ib) {
        if (!ia) o.push(isect(a, b));
        o.push(b);
      } else if (ia) o.push(isect(a, b));
    }
    return o;
  };
  let p = poly;
  p = clip(
    p,
    (q) => q[0] >= x0,
    (a, b) => {
      const t = (x0 - a[0]) / (b[0] - a[0]);
      return [x0, a[1] + t * (b[1] - a[1])];
    },
  );
  p = clip(
    p,
    (q) => q[0] <= x1,
    (a, b) => {
      const t = (x1 - a[0]) / (b[0] - a[0]);
      return [x1, a[1] + t * (b[1] - a[1])];
    },
  );
  p = clip(
    p,
    (q) => q[1] >= y0,
    (a, b) => {
      const t = (y0 - a[1]) / (b[1] - a[1]);
      return [a[0] + t * (b[0] - a[0]), y0];
    },
  );
  p = clip(
    p,
    (q) => q[1] <= y1,
    (a, b) => {
      const t = (y1 - a[1]) / (b[1] - a[1]);
      return [a[0] + t * (b[0] - a[0]), y1];
    },
  );
  if (p.length < 3) return 0;
  let a2 = 0;
  for (let i = 0; i < p.length; i++) {
    const u = p[i],
      v = p[(i + 1) % p.length];
    a2 += u[0] * v[1] - v[0] * u[1];
  }
  return Math.abs(a2) / 2;
}
const truthGrid = (poly, W, H) => {
  const g = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) g[y * W + x] = clipArea(poly, x, y, x + 1, y + 1);
  return g;
};
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

// 1) exactness vs ground truth on assorted single polygons
const W = 16,
  H = 16;
const polys = {
  'axis square': [
    [2, 2],
    [12, 2],
    [12, 12],
    [2, 12],
  ],
  'sub-pixel square': [
    [2.3, 3.7],
    [11.6, 3.7],
    [11.6, 10.2],
    [2.3, 10.2],
  ],
  'rotated diamond': [
    [8, 2],
    [14, 8],
    [8, 14],
    [2, 8],
  ],
  triangle: [
    [2, 2],
    [13, 4],
    [6, 13],
  ],
};
for (const [name, poly] of Object.entries(polys)) {
  const sa = signedAreaCoverage([poly], W, H, false);
  const gt = truthGrid(poly, W, H);
  const d = maxDiff(sa, gt);
  d < 1e-4
    ? ok(`${name}: signed-area == exact ground truth (max diff ${d.toExponential(1)})`)
    : fail(`${name}: max diff ${d.toExponential(2)} vs ground truth`);
}

// 2) CONFLATION-FREE: the square as ONE contour vs the same region declared as TWO
//    abutting triangles sharing the diagonal. Signed-area on both must equal the
//    square's coverage exactly (the shared diagonal's opposite-winding edges cancel).
{
  const square = [
    [2, 2],
    [12, 2],
    [12, 12],
    [2, 12],
  ];
  // two triangles, consistently wound, sharing diagonal (2,2)-(12,12)
  const T1 = [
    [2, 2],
    [12, 2],
    [12, 12],
  ];
  const T2 = [
    [2, 2],
    [12, 12],
    [2, 12],
  ];
  const one = signedAreaCoverage([square], W, H, false);
  const two = signedAreaCoverage([T1, T2], W, H, false);
  const d = maxDiff(one, two);
  d < 1e-4
    ? ok(
        `conflation-free: two abutting triangles == one square (max diff ${d.toExponential(1)}) — NO shared-diagonal seam`,
      )
    : fail(`conflation seam: two-triangle coverage differs from square by ${d.toFixed(3)}`);
  // and verify an interior pixel straddling the diagonal reads ~1.0 (not the 0.5/0.75 seam)
  const px = 7,
    py = 7; // center, on the diagonal, fully interior
  const cov = two[py * W + px];
  cov > 0.99
    ? ok(
        `interior-on-diagonal pixel coverage ${cov.toFixed(3)} ≈ 1.0 (per-primitive would give 0.5/0.75)`,
      )
    : fail(`interior-on-diagonal pixel under-covered: ${cov.toFixed(3)}`);
}

// 3) even-odd hole: square with a centered square hole (opposite winding) — the hole
//    must read 0 coverage, the ring ~1, matching ground truth (area = outer − hole).
{
  const outer = [
    [1, 1],
    [15, 1],
    [15, 15],
    [1, 15],
  ];
  const hole = [
    [5, 5],
    [5, 11],
    [11, 11],
    [11, 5],
  ]; // reversed winding → hole
  const sa = signedAreaCoverage([outer, hole], W, H, false);
  const gtOuter = truthGrid(outer, W, H),
    gtHole = truthGrid(hole, W, H);
  const gt = new Float32Array(W * H);
  for (let i = 0; i < gt.length; i++) gt[i] = Math.max(0, gtOuter[i] - gtHole[i]);
  const d = maxDiff(sa, gt);
  const holeCov = sa[8 * W + 8]; // center of the hole
  d < 1e-4 && holeCov < 1e-4
    ? ok(
        `holed square: matches (outer − hole) ground truth (diff ${d.toExponential(1)}, hole center ${holeCov.toExponential(1)})`,
      )
    : fail(`holed square: diff ${d.toExponential(2)}, hole center coverage ${holeCov.toFixed(3)}`);
}

// 4) CLOSED-FORM CURVE coverage (no flatten): a rounded shape from 4 quad arcs vs
//    exact ground truth. Proves the curve signed-area contribution is resolution-
//    independent and matches area coverage (the AA path for a mesh-free renderer).
{
  const cx = 8,
    cy = 8,
    r = 5;
  const on = [
    [cx + r, cy],
    [cx, cy + r],
    [cx - r, cy],
    [cx, cy - r],
  ];
  const ct = [
    [cx + r, cy + r],
    [cx - r, cy + r],
    [cx - r, cy - r],
    [cx + r, cy - r],
  ];
  const segs = on.map((a, i) => ({ type: 'quad', P0: a, P1: ct[i], P2: on[(i + 1) % 4] }));
  const q = (P0, P1, P2) => (t) => {
    const u = 1 - t;
    return [
      u * u * P0[0] + 2 * u * t * P1[0] + t * t * P2[0],
      u * u * P0[1] + 2 * u * t * P1[1] + t * t * P2[1],
    ];
  };
  const poly = [];
  for (let i = 0; i < 4; i++) {
    const f = q(on[i], ct[i], on[(i + 1) % 4]);
    for (let s = 0; s < 96; s++) poly.push(f(s / 96));
  }
  const cov = signedAreaCoverageSegs(segs, W, H, false);
  const gt = truthGrid(poly, W, H);
  const d = maxDiff(cov, gt);
  // tolerance ~1e-3: the residual is the 96-gon ground-truth's own arc approximation.
  d < 2e-3
    ? ok(
        `closed-form quad-arc coverage matches ground truth (max diff ${d.toExponential(1)}, no flatten)`,
      )
    : fail(`quad-arc coverage: max diff ${d.toExponential(2)} vs ground truth`);
}

// 5) random curved cells against the independent reference, and art running off the grid's top
{
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (const kind of ['line', 'quad', 'cubic']) {
    let worst = 0,
      bad = 0;
    for (let trial = 0; trial < 300; trial++) {
      const pts = [],
        n = 3 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.283 + rnd() * 0.5,
          r = 1 + rnd();
        pts.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      const segs = [];
      for (let i = 0; i < n; i++) {
        const p = pts[i],
          q = pts[(i + 1) % n];
        if (kind === 'line') segs.push({ t: 0, x0: p[0], y0: p[1], x1: q[0], y1: q[1] });
        else if (kind === 'quad')
          segs.push({
            t: 1,
            x0: p[0],
            y0: p[1],
            cx: (p[0] + q[0]) / 2 + (rnd() - 0.5) * 2,
            cy: (p[1] + q[1]) / 2 + (rnd() - 0.5) * 2,
            x1: q[0],
            y1: q[1],
          });
        else
          segs.push({
            t: 2,
            x0: p[0],
            y0: p[1],
            c1x: p[0] + (rnd() - 0.5) * 3,
            c1y: p[1] + (rnd() - 0.5) * 3,
            c2x: q[0] + (rnd() - 0.5) * 3,
            c2y: q[1] + (rnd() - 0.5) * 3,
            x1: q[0],
            y1: q[1],
          });
      }
      const e = 0.05 + rnd() * 0.5,
        c = [(rnd() - 0.5) * 3, (rnd() - 0.5) * 3],
        eo = rnd() < 0.5;
      const P = (x, y) => [(x - c[0]) / e + 0.5, (y - c[1]) / e + 0.5];
      const out = segs.map((g) =>
        g.t === 0
          ? { type: 'line', a: P(g.x0, g.y0), b: P(g.x1, g.y1) }
          : g.t === 1
            ? { type: 'quad', P0: P(g.x0, g.y0), P1: P(g.cx, g.cy), P2: P(g.x1, g.y1) }
            : {
                type: 'cubic',
                P0: P(g.x0, g.y0),
                P1: P(g.c1x, g.c1y),
                P2: P(g.c2x, g.c2y),
                P3: P(g.x1, g.y1),
              },
      );
      const d = Math.abs(coverageAtPixel(out, 1, 1, 0, 0, eo) - cellCoverage(segs, c, [e, e], eo));
      worst = Math.max(worst, d);
      if (d > 1e-9) bad++;
    }
    bad === 0
      ? ok(
          `coverageAtPixel equals the independent f64 reference on 300 random ${kind} cells (worst ${worst.toExponential(1)})`,
        )
      : fail(
          `coverageAtPixel off the independent reference on ${bad} of 300 random ${kind} cells, worst ${worst.toExponential(2)}`,
        );
  }
  // the same shape (a cubic with interior extrema, and two lines meeting at a vertex near the top) in view, and moved
  // up 4 px so the vertex and the cubic's crest hang off the grid: its rows still in view must not change
  const shape = (dy) => [
    { type: 'cubic', P0: [2, 9 + dy], P1: [2, -6 + dy], P2: [14, 20 + dy], P3: [14, 5 + dy] },
    { type: 'line', a: [14, 5 + dy], b: [9, 1.5 + dy] },
    { type: 'line', a: [9, 1.5 + dy], b: [2, 9 + dy] },
  ];
  const inView = signedAreaCoverageSegs(shape(0), W, H, false),
    offTop = signedAreaCoverageSegs(shape(-4), W, H, false);
  let d = 0;
  for (let y = 4; y < H; y++)
    for (let x = 0; x < W; x++)
      d = Math.max(d, Math.abs(offTop[(y - 4) * W + x] - inView[y * W + x]));
  d < 1e-6
    ? ok(
        `art running off the grid's top rasterizes its rows in view as it does in view (max diff ${d.toExponential(1)})`,
      )
    : fail(`art running off the grid's top differs from the same art in view by ${d.toFixed(4)}`);
}

console.log(failures ? `\nSIGNED-AREA-COVERAGE FAIL (${failures})` : `\nSIGNED-AREA-COVERAGE PASS`);
process.exit(failures ? 1 : 0);
