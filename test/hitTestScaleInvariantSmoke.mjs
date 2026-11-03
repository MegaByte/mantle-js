// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// hitTestScaleInvariantSmoke — the hit test's decisions on a shape do not depend on the size it is drawn at.
//
// THE PROPERTY. Scaling a shape and the query point by any factor, or moving both, changes no answer: in
// the fill, on the stroke (every join, a dashed stroke), and in which part of a segment is nearest and how
// far it is. The hit test works on decoded float64 segments in the bundle's own units, so any tolerance
// that carries a length and is compared against a constant breaks this. Five such places are pinned: the
// cubic closest-point polynomial must not go to solvePolyInUnitInterval in squared world units (that
// solver's value tests are absolute, for callers in a frame of their own), the fill ray's nudge must not be
// an absolute 1e-7, a near-circle arc must not become a circle when |rx - ry| < 1e-9, an arcs-join edge
// must not become straight when its curvature (1 / length) is under 1e-6, and the dash gate's quad arc
// length must not take a curved quad for its chord (A < 1e-12) or drop its log term (arg < 1e-12).
//
// (a) seven shapes -- a cubic/quad/arc/line outline, a looped cubic, a thin two-cubic lens, an ellipse, an
//     ellipse 1e-4 from a circle, an arc pie, and a 64-segment ring that the winding tree answers -- at
//     world scales 1e-6, 1e-3, 1e3 and 1e6, with and without an origin offset, against scale 1: fill (linear
//     and tree), stroke with miter / round / bevel / miter-clip / arcs joins, a dashed stroke, and closest()
//     per segment (where, and the distance to 1e-4 of the shape), over a grid, around every vertex, and on
//     rays through every vertex
// (b) closest() on a looped cubic finds the nearest point a dense search finds, at every size: a
//     false-position refinement that stalls with one end fixed returns the bracket's midpoint -- a
//     critical point at t = 0.18 that the polynomial does not have.
// (c) closest() on an ellipse, and on one 1e-4 from a circle, finds the nearest point at every size
// (d) an arcs join between two curved edges answers the same at every size
// (e) an imported stroke through fillHitShape with a worldMatrix at 5e-7..1e6: an absolute 1e-12 singular
//     test on the inverse's determinant would make a bundle drawn under 1e-6 answer no hit
// (f) decodeSegs on float32 curve planes with open subpaths, arc joints and a fan of open quads, at every
//     size, with and without an offset, and 3.1e4 shapes away: the same subpaths and closing lines, and the
//     same fill answers. An absolute 1e-4 joint test would merge subpaths when small, and let an arc's
//     rounding split a contour when far from the origin
// (g) a morphing bundle's fill hit (the lerped float32 pose, the winding tree, the memo) at every size
// (h) butt caps at 2^-20, 1 and 2^20 on cubic, quad, line and arc ends whose direction vector is short: the end
//     direction normalized with an absolute 1e-12 cut (unit()) is lost at 2^-20 on a short handle, line or arc,
//     and the cap cuts nothing
//
// (i) what a pixel is in em, at every scale: comparing the world matrix's axis lengths with an absolute 1e-12, and reading a smaller one as a size of
//     1 em, would turn 1e11 em per pixel at world scale 1e-11 into 1 at 1e-13, and Coverage mode's pixel box with it
//
// The bundle's float32 curve storage is not part of this: at 1e6 with an offset its rounding moves the
// boundary itself, so end-to-end invariance is bounded by the storage, not by these tolerances.
import {
  pointOnStroke,
  closest,
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  SEG_ARC,
} from '../src/hitTest/curveGeom.js';
import { pointInFill, buildFillTree } from '../src/hitTest/fillCoverage.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
const SCALES = [1e-6, 1e-3, 1e3, 1e6];

// ---- shapes: closed contours in coordinates about 10 across ------------------------------------------
const arc = (cx, cy, rx, ry, th0, th1, phi) => ({ t: SEG_ARC, cx, cy, rx, ry, th0, th1, phi });
const arcAt = (a, th) => [
  a.cx + a.rx * Math.cos(th) * Math.cos(a.phi) - a.ry * Math.sin(th) * Math.sin(a.phi),
  a.cy + a.rx * Math.cos(th) * Math.sin(a.phi) + a.ry * Math.sin(th) * Math.cos(a.phi),
];
const SHAPES = {};
{
  const a = arc(5, 6, 2, 1, 0, Math.PI * 0.9, 0.3),
    s = arcAt(a, a.th0);
  a.cx += 7 - s[0];
  a.cy += 6 - s[1];
  SHAPES.outline = [
    {
      t: SEG_CUBIC,
      p: [
        [0, 0],
        [3, -2],
        [5, 4],
        [8, 1],
      ],
    },
    {
      t: SEG_QUAD,
      p: [
        [8, 1],
        [10, 4],
        [7, 6],
      ],
    },
    a,
    { t: SEG_LINE, p: [arcAt(a, a.th1), [0, 0]] },
  ];
}
SHAPES.loopCubic = [
  {
    t: SEG_CUBIC,
    p: [
      [0, 0],
      [12, 8],
      [-2, 8],
      [10, 0],
    ],
  },
  {
    t: SEG_LINE,
    p: [
      [10, 0],
      [0, 0],
    ],
  },
];
SHAPES.thinLens = [
  {
    t: SEG_CUBIC,
    p: [
      [0, 0],
      [3, 0.4],
      [6, -0.4],
      [9, 0.02],
    ],
  },
  {
    t: SEG_CUBIC,
    p: [
      [9, 0.02],
      [6, 0.6],
      [3, 0.8],
      [0, 0],
    ],
  },
];
SHAPES.ellipse = [arc(5, 3, 5, 2.5, 0, 2 * Math.PI, 0.4)];
SHAPES.nearCircle = [arc(5, 5, 5, 5 * (1 - 1e-4), 0.2, 2 * Math.PI + 0.2, 0.7)];
{
  const a = arc(0, 0, 6, 3, 0, 2.2, 0.3);
  SHAPES.arcPie = [
    a,
    { t: SEG_LINE, p: [arcAt(a, a.th1), [0, 0]] },
    { t: SEG_LINE, p: [[0, 0], arcAt(a, a.th0)] },
  ];
}
{
  const ring = [],
    K = 64,
    P = (j) => {
      const g = (2 * Math.PI * j) / K,
        r = 5 * (1 + 0.15 * Math.sin(5 * g));
      return [5 + r * Math.cos(g), 5 + r * Math.sin(g)];
    };
  for (let j = 0; j < K; j++) {
    const A = P(j),
      B = P(j + 1),
      m = [(A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.3, (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.3];
    ring.push(
      j % 3 === 0
        ? { t: SEG_LINE, p: [A, B] }
        : j % 3 === 1
          ? { t: SEG_QUAD, p: [A, m, B] }
          : {
              t: SEG_CUBIC,
              p: [
                A,
                [A[0] * 0.6 + m[0] * 0.4, A[1] * 0.6 + m[1] * 0.4],
                [B[0] * 0.6 + m[0] * 0.4, B[1] * 0.6 + m[1] * 0.4],
                B,
              ],
            },
    );
  }
  SHAPES.ring64 = ring;
}

// ---- hit-test segments at a size, with join tangents, curvatures and startDist -----------------------
function evalSeg(s, t) {
  const u = 1 - t;
  if (s.t === SEG_LINE) return [s.x0 + (s.x1 - s.x0) * t, s.y0 + (s.y1 - s.y0) * t];
  if (s.t === SEG_QUAD)
    return [
      u * u * s.x0 + 2 * u * t * s.cx + t * t * s.x1,
      u * u * s.y0 + 2 * u * t * s.cy + t * t * s.y1,
    ];
  if (s.t === SEG_CUBIC)
    return [
      u * u * u * s.x0 + 3 * u * u * t * s.c1x + 3 * u * t * t * s.c2x + t * t * t * s.x1,
      u * u * u * s.y0 + 3 * u * u * t * s.c1y + 3 * u * t * t * s.c2y + t * t * t * s.y1,
    ];
  const th = s.th0 + (s.th1 - s.th0) * t;
  return [
    s.cx + s.rx * Math.cos(th) * s.cp - s.ry * Math.sin(th) * s.sp,
    s.cy + s.rx * Math.cos(th) * s.sp + s.ry * Math.sin(th) * s.cp,
  ];
}
function deriv(s, t) {
  const u = 1 - t;
  if (s.t === SEG_LINE) return [s.x1 - s.x0, s.y1 - s.y0];
  if (s.t === SEG_QUAD)
    return [
      2 * u * (s.cx - s.x0) + 2 * t * (s.x1 - s.cx),
      2 * u * (s.cy - s.y0) + 2 * t * (s.y1 - s.cy),
    ];
  if (s.t === SEG_CUBIC)
    return [
      3 * u * u * (s.c1x - s.x0) + 6 * u * t * (s.c2x - s.c1x) + 3 * t * t * (s.x1 - s.c2x),
      3 * u * u * (s.c1y - s.y0) + 6 * u * t * (s.c2y - s.c1y) + 3 * t * t * (s.y1 - s.c2y),
    ];
  const th = s.th0 + (s.th1 - s.th0) * t,
    d = s.th1 - s.th0;
  return [
    (-s.rx * Math.sin(th) * s.cp - s.ry * Math.cos(th) * s.sp) * d,
    (-s.rx * Math.sin(th) * s.sp + s.ry * Math.cos(th) * s.cp) * d,
  ];
}
const unitOf = (v) => {
  const L = Math.hypot(v[0], v[1]);
  return [v[0] / L, v[1] / L];
};
function curvature(s, t) {
  // signed, 1 / length
  if (s.t === SEG_LINE) return 0;
  const h = 1e-4,
    ta = Math.max(0, t - h),
    tb = Math.min(1, t + h);
  const a = unitOf(deriv(s, ta)),
    b = unitOf(deriv(s, tb)),
    pa = evalSeg(s, ta),
    pb = evalSeg(s, tb);
  return (
    Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]) /
    Math.hypot(pb[0] - pa[0], pb[1] - pa[1])
  );
}
function hitSegs(shape, f, o) {
  const X = (p) => [p[0] * f + o[0], p[1] * f + o[1]];
  const segs = shape.map((s) => {
    if (s.t === SEG_ARC) {
      const g = {
        t: SEG_ARC,
        cx: s.cx * f + o[0],
        cy: s.cy * f + o[1],
        rx: s.rx * f,
        ry: s.ry * f,
        th0: s.th0,
        th1: s.th1,
        cp: Math.cos(s.phi),
        sp: Math.sin(s.phi),
      };
      [g.x0, g.y0] = evalSeg(g, 0);
      [g.x1, g.y1] = evalSeg(g, 1);
      return g;
    }
    const p = s.p.map(X);
    if (s.t === SEG_LINE)
      return { t: SEG_LINE, x0: p[0][0], y0: p[0][1], x1: p[1][0], y1: p[1][1] };
    if (s.t === SEG_QUAD)
      return {
        t: SEG_QUAD,
        x0: p[0][0],
        y0: p[0][1],
        cx: p[1][0],
        cy: p[1][1],
        x1: p[2][0],
        y1: p[2][1],
      };
    return {
      t: SEG_CUBIC,
      x0: p[0][0],
      y0: p[0][1],
      c1x: p[1][0],
      c1y: p[1][1],
      c2x: p[2][0],
      c2y: p[2][1],
      x1: p[3][0],
      y1: p[3][1],
    };
  });
  segs.forEach((s, i) => {
    const prev = segs[(i + segs.length - 1) % segs.length],
      next = segs[(i + 1) % segs.length];
    const it = unitOf(deriv(prev, 1)),
      ot = unitOf(deriv(next, 0));
    // startDist steps off the dash pattern's grid (a vertex exactly on a dash boundary is decided by rounding)
    Object.assign(s, {
      f: false,
      freeS: false,
      freeE: false,
      sd: Math.PI * 3.3 * i * f,
      itx: it[0],
      ity: it[1],
      otx: ot[0],
      oty: ot[1],
      kSS: curvature(s, 0),
      kSE: curvature(s, 1),
      kPE: curvature(prev, 1),
      kNS: curvature(next, 0),
    });
  });
  return segs;
}

// ---- (a) every decision at every size -------------------------------------------------------------------
console.log('(a) hit decisions at every size and offset');
const halfW = 0.35;
const KINDS = [
  'fill',
  'fill (tree)',
  'miter',
  'round',
  'bevel',
  'miter-clip',
  'arcs',
  'dashed',
  'closest',
];
for (const [name, shape] of Object.entries(SHAPES)) {
  const base = hitSegs(shape, 1, [0, 0]);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of base)
    for (let k = 0; k <= 32; k++) {
      const p = evalSeg(s, k / 32);
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
  const size = Math.max(x1 - x0, y1 - y0),
    N = 40,
    probes = [];
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      probes.push([
        x0 - 1 + ((x1 - x0 + 2) * (i + 0.5 + 0.37 * Math.sin(i * 12.9898 + j * 78.233))) / N,
        y0 - 1 + ((y1 - y0 + 2) * (j + 0.5 + 0.37 * Math.cos(i * 39.34 + j * 11.13))) / N,
      ]);
    }
  for (const s of base)
    for (let k = 0; k < 24; k++) {
      // around each vertex: caps and joins decide here
      const g = 2.399963 * k,
        r = halfW * (0.3 + 1.9 * ((k * 0.618034) % 1));
      probes.push([s.x0 + r * Math.cos(g), s.y0 + r * Math.sin(g)]);
    }
  const decide = (segs, f, o) => {
    // A bundle's dash table is float32; float64 here, so the pattern's own rounding is not under test.
    const tree = buildFillTree(segs),
      dashF = new Float64Array(64);
    dashF[0] = 1.5 * f;
    dashF[1] = 2;
    dashF[4] = 1 * f;
    dashF[5] = 0.5 * f;
    const rows = [];
    const at = (p) => [p[0] * f + o[0], p[1] * f + o[1]];
    for (const p0 of probes) {
      const [px, py] = at(p0),
        row = [];
      row.push(
        pointInFill(segs, px, py, false, null),
        tree ? pointInFill(segs, px, py, false, tree) : 'no tree',
      );
      for (const join of [0, 1, 2, 3, 4])
        row.push(pointOnStroke(segs, px, py, halfW * f, 1, join, 4, null, 0));
      row.push(pointOnStroke(segs, px, py, halfW * f, 1, 1, 4, dashF, 1));
      row.push(
        segs
          .map((s) => {
            const c = closest(s, px, py);
            return `${c.where}:${Math.round((1e4 * Math.sqrt(c.d2)) / (f * size))}`;
          })
          .join(','),
      );
      rows.push(row);
    }
    for (const s of segs)
      rows.push([
        pointInFill(segs, s.x0 - size * f, s.y0, false, null),
        tree ? pointInFill(segs, s.x0 - size * f, s.y0, false, tree) : 'no tree',
      ]);
    return rows;
  };
  const ref = decide(base, 1, [0, 0]);
  const bad = {};
  for (const f of [1].concat(SCALES))
    for (const on of [false, true]) {
      if (f === 1 && !on) continue;
      const o = on ? [7.3e3 * f, -2.9e4 * f] : [0, 0];
      const got = decide(hitSegs(shape, f, o), f, o);
      got.forEach((row, r) =>
        row.forEach((v, k) => {
          if (v === ref[r][k]) return;
          const key = `${r >= probes.length ? 'ray through a vertex: ' : ''}${KINDS[k]}`;
          (bad[key] = bad[key] || []).push(`${f}${on ? '+o' : ''}`);
        }),
      );
    }
  const summary = Object.entries(bad).map(
    ([k, v]) => `${k} x${v.length} (${[...new Set(v)].join(' ')})`,
  );
  check(
    summary.length === 0,
    `${name}: ${probes.length + base.length} probes, every decision the same at every size${summary.length ? ' -- ' + summary.join('; ') : ''}`,
  );
}

// ---- (b) closest() on a looped cubic finds the nearest point ----------------------------------------------
console.log('(b) closest() finds the nearest point of a looped cubic');
{
  const [cubic] = hitSegs(SHAPES.loopCubic, 1, [0, 0]);
  let bad = 0,
    worst = 0,
    n = 0;
  for (let i = 0; i < 30; i++)
    for (let j = 0; j < 30; j++) {
      const px = -3 + (16 * (i + 0.5)) / 30,
        py = -3 + (12 * (j + 0.5)) / 30;
      let best = Infinity,
        bestT = 0;
      for (let k = 0; k <= 2000; k++) {
        const p = evalSeg(cubic, k / 2000),
          d = Math.hypot(p[0] - px, p[1] - py);
        if (d < best) {
          best = d;
          bestT = k / 2000;
        }
      }
      for (let h = 5e-4; h > 1e-12; h /= 2)
        for (const t of [bestT - h, bestT + h]) {
          if (t < 0 || t > 1) continue;
          const p = evalSeg(cubic, t),
            d = Math.hypot(p[0] - px, p[1] - py);
          if (d < best) {
            best = d;
            bestT = t;
          }
        }
      n++;
      const got = Math.sqrt(closest(cubic, px, py).d2),
        err = got - best;
      worst = Math.max(worst, err);
      if (err > 1e-9 * 10) bad++;
    }
  check(
    bad === 0,
    `${n - bad}/${n} query points get the nearest distance (worst excess ${worst.toExponential(2)})`,
  );
}

// ---- (c) closest() on an ellipse and on an ellipse 1e-4 from a circle, at every size ---------------------
console.log('(c) closest() finds the nearest point of an ellipse at every size');
for (const name of ['ellipse', 'nearCircle']) {
  let bad = 0,
    n = 0,
    worst = 0;
  for (const f of [1].concat(SCALES)) {
    const [e] = hitSegs(SHAPES[name], f, [0, 0]);
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++) {
        const px = (-2 + (14 * (i + 0.5)) / 12) * f,
          py = (-2 + (14 * (j + 0.5)) / 12) * f;
        let best = Infinity,
          bestT = 0;
        for (let k = 0; k <= 4000; k++) {
          const p = evalSeg(e, k / 4000),
            d = Math.hypot(p[0] - px, p[1] - py);
          if (d < best) {
            best = d;
            bestT = k / 4000;
          }
        }
        for (let h = 2.5e-4; h > 1e-13; h /= 2)
          for (const t of [bestT - h, bestT + h]) {
            const p = evalSeg(e, Math.min(1, Math.max(0, t))),
              d = Math.hypot(p[0] - px, p[1] - py);
            if (d < best) {
              best = d;
              bestT = Math.min(1, Math.max(0, t));
            }
          }
        n++;
        const err = (Math.sqrt(closest(e, px, py).d2) - best) / (10 * f);
        worst = Math.max(worst, err);
        if (err > 1e-9) bad++;
      }
  }
  check(
    bad === 0,
    `${name}: ${n - bad}/${n} query points at 1, 1e-6, 1e-3, 1e3, 1e6 get the nearest distance (worst excess ${worst.toExponential(2)} of the shape)`,
  );
}

// ---- (d) an arcs join between two gently curved edges, at every size ---------------------------------------
console.log('(d) arcs joins at every size');
{
  // a lens of two radius-1.5 circles whose centers are 2 apart: two corners where curved edges meet.
  // Curvature 2/3, so at 1e6 it is under an absolute 1e-6, which would take the edges for lines.
  const R0 = 1.5,
    h0 = Math.acos(Math.sqrt(R0 * R0 - 1) / R0);
  const up = arc(0, -1, R0, R0, Math.PI - h0, h0, 0);
  const down = arc(0, 1, R0, R0, -h0, -Math.PI + h0, 0);
  const lens = [down, up];
  const base = hitSegs(lens, 1, [0, 0]);
  const probes = [];
  for (const s of base)
    for (let k = 0; k < 1500; k++) {
      const g = 2.399963 * k,
        r = 4 * halfW * Math.sqrt((k * 0.618034) % 1);
      probes.push([s.x0 + r * Math.cos(g), s.y0 + r * Math.sin(g)]);
    }
  const ref = probes.map((p) => pointOnStroke(base, p[0], p[1], halfW, 1, 4, 4, null, 0));
  let bad = 0;
  const where = new Set();
  for (const f of SCALES)
    for (const on of [false, true]) {
      const o = on ? [7.3e3 * f, -2.9e4 * f] : [0, 0],
        segs = hitSegs(lens, f, o);
      probes.forEach((p, i) => {
        if (
          pointOnStroke(segs, p[0] * f + o[0], p[1] * f + o[1], halfW * f, 1, 4, 4, null, 0) !==
          ref[i]
        ) {
          bad++;
          where.add(`${f}${on ? '+o' : ''}`);
        }
      });
    }
  check(
    bad === 0,
    `${probes.length} probes around the two corners answer as at scale 1${bad ? ` -- ${bad} differ (${[...where].join(' ')})` : ''}`,
  );
}

// ---- (e) the same bundle drawn at every world scale ---------------------------------------------------------
console.log('(e) an imported stroke hit through worldMatrix at every scale (and 5e-7)');
{
  if (typeof DOMParser === 'undefined') {
    const x = await import('@xmldom/xmldom');
    globalThis.DOMParser = x.DOMParser;
    globalThis.XMLSerializer = x.XMLSerializer;
  }
  const { default: importSvg } = await import('../src/svg/importer.js');
  const { fillHitShape } = await import('../src/hitTest/hitTest.js');
  const b = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 80 C30 10 70 10 90 80" fill="none" stroke="#000" stroke-width="8"/></svg>',
  );
  const probes = [];
  for (let i = 0; i < 30; i++)
    for (let j = 0; j < 30; j++)
      probes.push([2 + (96 * (i + 0.5)) / 30, 2 + (96 * (j + 0.5)) / 30]);
  const ref = probes.map((p) => fillHitShape(b, p[0], p[1], 'outline'));
  let bad = 0;
  const where = new Set();
  for (const f of [5e-7].concat(SCALES)) {
    // 5e-7: under an absolute 1e-12 singular test
    const W = [f, 0, 0, 0, f, 0, 3.1 * f, -1.7 * f, 1]; // column-major, with a translation
    probes.forEach((p, i) => {
      if (
        fillHitShape(b, p[0] * f + 3.1 * f, p[1] * f - 1.7 * f, {
          mode: 'outline',
          worldMatrix: W,
        }) !== ref[i]
      ) {
        bad++;
        where.add(f);
      }
    });
  }
  check(
    ref.some((r) => r === 0) && bad === 0,
    `${probes.length} canvas points at world scales 5e-7..1e6 answer as at scale 1${bad ? ` -- ${bad} differ (${[...where].join(' ')})` : ''}`,
  );
}

// ---- (f) the float32 curve plane: subpath breaks and closures at every size --------------------------------
// Curve records written straight into a Float32Array, the way the encoder stores a shape at that size.
console.log('(f) decodeSegs finds the same subpaths in a float32 plane at every size');
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');
function plane(build, f, o) {
  const a = [],
    W = (p) => [p[0] * f + o[0], p[1] * f + o[1]];
  const rec = {
    line: (p, q) => {
      p = W(p);
      q = W(q);
      a.push(0, 0, 0, 0, p[0], p[1], q[0], q[1], 1, 0, 1, 0);
    },
    quad: (p, c, q) => {
      p = W(p);
      c = W(c);
      q = W(q);
      a.push(1, 0, 0, 0, p[0], p[1], c[0], c[1], q[0], q[1], 0, 0, 1, 0, 1, 0);
    },
    cubic: (p, c1, c2, q) => {
      p = W(p);
      c1 = W(c1);
      c2 = W(c2);
      q = W(q);
      a.push(2, 0, 0, 0, p[0], p[1], c1[0], c1[1], c2[0], c2[1], q[0], q[1], 1, 0, 1, 0);
    },
    // an arc record carries its endpoints after (th0, th1, phi): the path's points, as encodeSeg stores them
    arc: (c, rx, ry, th0, th1, phi) => {
      const e0 = W(ellAt(c, rx, ry, th0, phi)),
        e1 = W(ellAt(c, rx, ry, th1, phi));
      c = W(c);
      a.push(
        3,
        0,
        0,
        0,
        c[0],
        c[1],
        rx * f,
        ry * f,
        th0,
        th1,
        phi,
        0,
        e0[0],
        e0[1],
        e1[0],
        e1[1],
        1,
        0,
        1,
        0,
      );
    },
  };
  build(rec);
  return new Float32Array(a);
}
const ellAt = (c, rx, ry, th, phi) => [
  c[0] + rx * Math.cos(th) * Math.cos(phi) - ry * Math.sin(th) * Math.sin(phi),
  c[1] + rx * Math.cos(th) * Math.sin(phi) + ry * Math.sin(th) * Math.cos(phi),
];
const PLANES = {
  // two open subpaths, the second starting 0.5 from the first one's end
  twoOpen: (r) => {
    r.line([0, 0], [5, 8]);
    r.line([5, 8], [10, 0]);
    r.cubic([10.3, 0.4], [7, 6], [3, 6], [1, 0.5]);
  },
  // a closed ring of four arcs (every joint an arc's derived endpoint), then an open arc-and-line subpath
  arcs: (r) => {
    const c = [20, 20],
      rx = 6,
      ry = 4,
      phi = 0.3,
      T = [0.1, 1.7, 3.3, 4.8, 0.1 + 2 * Math.PI];
    for (let k = 0; k < 4; k++) r.arc(c, rx, ry, T[k], T[k + 1], phi);
    const c2 = [8, 25],
      a0 = 0.2,
      a1 = 2.4;
    r.arc(c2, 5, 3, a0, a1, -0.4);
    r.line(ellAt(c2, 5, 3, a1, -0.4), [9, 33]);
  },
  // eight open quads fanned around a center, each its own subpath
  fan: (r) => {
    for (let k = 0; k < 8; k++) {
      const g = (k * Math.PI) / 4,
        p = [15 + 3 * Math.cos(g), 15 + 3 * Math.sin(g)],
        q = [15 + 9 * Math.cos(g + 0.5), 15 + 9 * Math.sin(g + 0.5)];
      r.quad(p, [15 + 8 * Math.cos(g - 0.3), 15 + 8 * Math.sin(g - 0.3)], q);
      r.line(q, [15 + 5 * Math.cos(g + 0.9), 15 + 5 * Math.sin(g + 0.9)]);
    }
  },
};
const shapeSig = (segs) => segs.map((s) => (s.sd === undefined ? 'C' : `${s.t}`)).join('');
const evalAny = (s, t) =>
  evalSeg(s.cp === undefined && s.t === SEG_ARC ? { ...s, cp: 1, sp: 0 } : s, t);
for (const [name, build] of Object.entries(PLANES)) {
  const base = decodeSegs(plane(build, 1, [0, 0]), 0, 1e9);
  const baseSig = shapeSig(base);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of base)
    for (let k = 0; k <= 64; k++) {
      const p = evalAny(s, k / 64);
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
  const size = Math.max(x1 - x0, y1 - y0),
    probes = [];
  for (let i = 0; i < 36; i++)
    for (let j = 0; j < 36; j++) {
      const p = [
        x0 - 1 + ((x1 - x0 + 2) * (i + 0.5 + 0.3 * Math.sin(i * 3.1 + j))) / 36,
        y0 - 1 + ((y1 - y0 + 2) * (j + 0.5 + 0.3 * Math.cos(i + j * 2.3))) / 36,
      ];
      // away from the boundary by more than float32 storage moves it at the largest offset below
      let dmin = Infinity;
      for (const s of base) dmin = Math.min(dmin, Math.sqrt(closest(s, p[0], p[1]).d2));
      if (dmin > 2e-3 * size) probes.push(p);
    }
  const ref = probes.map((p) => pointInFill(base, p[0], p[1], false, null));
  const bad = [];
  for (const f of [1].concat(SCALES))
    for (const off of [0, 1, 2]) {
      if (f === 1 && off === 0) continue;
      // offset 2: ten thousand times the shape's size away, where float32 resolves 0.4% of the shape and an
      // arc's derived endpoint is rounded by as much -- far past any absolute or small relative tolerance
      const o =
        off === 0
          ? [0, 0]
          : off === 1
            ? [7.3e3 * f, -2.9e4 * f]
            : [3.1e4 * size * f, -1.7e4 * size * f];
      const segs = decodeSegs(plane(build, f, o), 0, 1e9);
      if (shapeSig(segs) !== baseSig) {
        bad.push(`${f}${off ? ` +offset${off}` : ''}: subpaths ${shapeSig(segs)} vs ${baseSig}`);
        continue;
      }
      if (off === 2) continue; // the geometry itself is float32 noise there: structure only
      const n = probes.filter(
        (p, i) => pointInFill(segs, p[0] * f + o[0], p[1] * f + o[1], false, null) !== ref[i],
      ).length;
      if (n) bad.push(`${f}${off ? ' +offset' : ''}: ${n} fill answers differ`);
    }
  check(
    bad.length === 0,
    `${name}: the same subpaths and closures (${baseSig}), and ${probes.length} fill answers, at every size${bad.length ? ' -- ' + bad.slice(0, 3).join('; ') : ''}`,
  );
}

// ---- (g) the morph fill walk over those planes -------------------------------------------------------------
// A morphing bundle's hit test decodes the lerped float32 pose (no band data), runs the winding tree over
// 48+ segments, and reuses answers inside the memo's clear radius -- all on decodeSegs' closures.
console.log('(g) the morph fill walk at every size');
{
  const { fillHitShape, HitMode } = await import('../src/hitTest/hitTest.js');
  // twelve copies of the open fan's first four subpaths: 96 records, so the winding tree and memo engage
  const build = (r) => {
    for (let c = 0; c < 6; c++)
      for (let k = 0; k < 8; k++) {
        const cx = 10 + 22 * (c % 3),
          cy = 10 + 22 * Math.floor(c / 3),
          g = (k * Math.PI) / 4;
        const p = [cx + 3 * Math.cos(g), cy + 3 * Math.sin(g)],
          q = [cx + 9 * Math.cos(g + 0.5), cy + 9 * Math.sin(g + 0.5)];
        r.quad(p, [cx + 8 * Math.cos(g - 0.3), cy + 8 * Math.sin(g - 0.3)], q);
        r.line(q, [cx + 5 * Math.cos(g + 0.9), cy + 5 * Math.sin(g + 0.9)]);
      }
  };
  const bundleAt = (f, o) => {
    const src = plane(build, f, o),
      dst = plane(build, f, [o[0] + 0.5 * f, o[1] + 0.25 * f]);
    const meta = new Float32Array(48);
    meta[0] = -2 * f + o[0];
    meta[1] = -2 * f + o[1];
    meta[2] = 72 * f + o[0];
    meta[3] = 52 * f + o[1];
    meta[7] = 1;
    return {
      numShapes: 1,
      metaFloatsPerShape: 48,
      metaFloats: meta.slice(),
      curveFloats: src.slice(),
      curveRangesByShape: [{ begin: 0, end: src.length }],
      _geomGen: 0,
      _morphSrc: {
        mergedCurveF32: src,
        dstCurveF32: dst,
        curveRanges: [{ begin: 0, end: src.length }],
        mergedMetaF32: meta,
        dstMetaF32: meta.slice(),
        metaStride: 48,
        matchedSrcIdxs: [0],
        t: 0.5,
      },
    };
  };
  const base = decodeSegs(plane(build, 1, [0.25, 0.125]), 0, 1e9); // the t = 0.5 pose at scale 1
  const probes = [];
  for (let j = 0; j < 40; j++)
    for (let i = 0; i < 60; i++) {
      // raster order, so consecutive queries sit inside the memo radius
      const p = [-1 + (72 * (i + 0.5)) / 60, -1 + (52 * (j + 0.5)) / 40];
      let dmin = Infinity;
      for (const s of base) dmin = Math.min(dmin, Math.sqrt(closest(s, p[0], p[1]).d2));
      if (dmin > 0.05) probes.push(p);
    }
  const b1 = bundleAt(1, [0, 0]);
  const ref = probes.map((p) => fillHitShape(b1, p[0], p[1], HitMode.Coverage));
  let bad = 0;
  const where = new Set();
  for (const f of SCALES)
    for (const on of [false, true]) {
      const o = on ? [7.3e3 * f, -2.9e4 * f] : [0, 0],
        bf = bundleAt(f, o);
      probes.forEach((p, i) => {
        if (fillHitShape(bf, p[0] * f + o[0], p[1] * f + o[1], HitMode.Coverage) !== ref[i]) {
          bad++;
          where.add(`${f}${on ? '+o' : ''}`);
        }
      });
    }
  check(
    ref.some((r) => r === 0) && ref.some((r) => r < 0) && bad === 0,
    `${probes.length} morph fill queries at t = 0.5 answer as at scale 1${bad ? ` -- ${bad} differ (${[...where].join(' ')})` : ''}`,
  );
}

// ---- (h) butt caps at every size, on short and zero end handles -----------------------------------------------
// A cap is built from the segment's own end direction (tangentStart / tangentEnd). Normalized by unit(), which returns
// no direction under an absolute 1e-12 -- a length -- at 2^-20 a cubic handle under ~3.5e-7 of a unit span, a quad's
// under ~1e-6, a line under 1e-6 long and an arc of radius under 1e-6 would all lose their direction, so their butt
// caps would cut nothing and points behind them would hit. The direction is the encoder's (textures.js
// segTangentAt): none only when the vector is within 64 ulps of the segment's coordinates. Points behind each cap along
// the ENCODER's tangent must be off the stroke at 2^-20, 1 and 2^20, and every point around each end must answer as at 1.
console.log('(h) butt caps on short and zero end handles at 2^-20, 1 and 2^20');
{
  const { segTangentAt } = await import('../src/svg/textures.js');
  const FAM = [];
  for (const h of [1e-2, 1e-4, 1e-6, 1e-7, 1e-8]) {
    FAM.push({
      name: `cubic handle ${h}`,
      s: {
        t: SEG_CUBIC,
        p: [
          [0, 0],
          [0, h],
          [0.7, 0.3],
          [1, 0],
        ],
      },
    });
    FAM.push({
      name: `cubic end handle ${h}`,
      s: {
        t: SEG_CUBIC,
        p: [
          [0, 0],
          [0.3, 0.3],
          [1, h],
          [1, 0],
        ],
      },
    });
    FAM.push({
      name: `quad handle ${h}`,
      s: {
        t: SEG_QUAD,
        p: [
          [0, 0],
          [0, h],
          [1, 0],
        ],
      },
    });
    FAM.push({
      name: `line ${h} long`,
      s: {
        t: SEG_LINE,
        p: [
          [0, 0],
          [h, 0.5 * h],
        ],
      },
    });
    FAM.push({ name: `arc radius ${h}`, s: arc(0, 0, h, h, 0.2, 2.1, 0) });
  }
  FAM.push({
    name: 'cubic zero handle',
    s: {
      t: SEG_CUBIC,
      p: [
        [0, 0],
        [0, 0],
        [0.5, 0.4],
        [1, 0],
      ],
    },
  });
  FAM.push({
    name: 'cubic double zero',
    s: {
      t: SEG_CUBIC,
      p: [
        [0, 0],
        [0, 0],
        [0, 0],
        [1, 0.5],
      ],
    },
  });
  const encSeg = (g) =>
    g.t === SEG_LINE
      ? { type: SEG_LINE, p1: [g.x0, g.y0], p2: [g.x1, g.y1] }
      : g.t === SEG_QUAD
        ? { type: SEG_QUAD, p1: [g.x0, g.y0], p2: [g.cx, g.cy], p3: [g.x1, g.y1] }
        : g.t === SEG_CUBIC
          ? {
              type: SEG_CUBIC,
              p1: [g.x0, g.y0],
              p2: [g.c1x, g.c1y],
              p3: [g.c2x, g.c2y],
              p4: [g.x1, g.y1],
            }
          : {
              type: SEG_ARC,
              cx: g.cx,
              cy: g.cy,
              rx: g.rx,
              ry: g.ry,
              phi: 0,
              theta_start: g.th0,
              theta_end: g.th1,
            };
  const at = (f) =>
    FAM.map((fm) => {
      const [g] = hitSegs([fm.s], f, [0, 0]);
      Object.assign(g, { freeS: true, freeE: true });
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let k = 0; k <= 32; k++) {
        const p = evalSeg(g, k / 32);
        x0 = Math.min(x0, p[0]);
        x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]);
        y1 = Math.max(y1, p[1]);
      }
      const hw = 0.05 * Math.max(x1 - x0, y1 - y0),
        behind = [],
        around = [];
      for (const atStart of [true, false]) {
        const T = segTangentAt(encSeg(g), atStart),
          V = atStart ? [g.x0, g.y0] : [g.x1, g.y1],
          o = atStart ? [-T[0], -T[1]] : T;
        const mid = evalSeg(g, 0.5);
        let N = [-T[1], T[0]];
        if (N[0] * (mid[0] - V[0]) + N[1] * (mid[1] - V[1]) > 0) N = [-N[0], -N[1]]; // away from the curve
        for (const [r, l] of [
          [0.5, 0],
          [0.5, 0.4],
          [0.2, 0.7],
        ])
          behind.push([V[0] + (o[0] * r + N[0] * l) * hw, V[1] + (o[1] * r + N[1] * l) * hw]);
        for (let k = 0; k < 24; k++) {
          const a = 2.399963 * k,
            r = hw * (0.3 + 1.9 * ((k * 0.618034) % 1));
          around.push([V[0] + r * Math.cos(a), V[1] + r * Math.sin(a)]);
        }
      }
      return { name: fm.name, g, hw, behind, around };
    });
  const ref = at(1);
  const painted = [],
    differ = [];
  let nb = 0,
    na = 0;
  for (const f of [2 ** -20, 1, 2 ** 20]) {
    const cur = at(f);
    cur.forEach((c, i) => {
      for (const p of c.behind) {
        nb++;
        if (pointOnStroke([c.g], p[0], p[1], c.hw, 0, 0, 4, null, 0))
          painted.push(`${c.name} at 2^${Math.log2(f)}`);
      }
      c.around.forEach((p, k) => {
        na++;
        const q = ref[i].around[k];
        if (
          pointOnStroke([c.g], p[0], p[1], c.hw, 0, 0, 4, null, 0) !==
          pointOnStroke([ref[i].g], q[0], q[1], ref[i].hw, 0, 0, 4, null, 0)
        )
          differ.push(`${c.name} at 2^${Math.log2(f)}`);
      });
    });
  }
  const u = (a) => [...new Set(a)];
  check(
    painted.length === 0,
    `no point behind a butt cap is on the stroke (${painted.length} of ${nb}${painted.length ? ': ' + u(painted).slice(0, 4).join('; ') : ''})`,
  );
  check(
    differ.length === 0,
    `${na} points around the ends answer as at scale 1${differ.length ? ` -- ${differ.length} differ: ${u(differ).slice(0, 4).join('; ')}` : ''}`,
  );
}

// Cached coverage must agree with a fresh query after zoom or a nearby move.
{
  const { default: importSvg } = await import('../src/svg/importer.js');
  const { fillHitShape } = await import('../src/hitTest/hitTest.js');
  const vertices = Array.from({ length: 64 }, (_, i) => {
    const a = (2 * Math.PI * i) / 64,
      r = i % 2 ? 5 : 10;
    return [r * Math.cos(a), r * Math.sin(a)];
  });
  const bundle = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -10 20 20"><path d="M${vertices.map((p) => p.join(' ')).join('L')}Z"/></svg>`,
  );
  const box = bundle.globalBBox;
  const query = (owner, p, scale) =>
    fillHitShape(owner, p[0] * scale, p[1] * scale, {
      mode: 'coverage',
      worldMatrix: [scale, 0, 0, 0, scale, 0, 0, 0, 1],
    });
  let zoomBad = 0,
    moveBad = 0,
    queries = 0;
  for (let j = 0; j < 12; j++)
    for (let i = 0; i < 12; i++) {
      const p = [box[0] + (box[2] * (i + 0.17)) / 12, box[1] + (box[3] * (j + 0.23)) / 12];
      for (const [s0, s1] of [
        [1, 32],
        [32, 1],
        [0.25, 8],
        [8, 0.25],
      ]) {
        const owner = { ...bundle };
        query(owner, p, s0);
        if (query(owner, p, s1) !== query({ ...bundle }, p, s1)) zoomBad++;
        queries++;
      }
      for (const [dx, dy] of [
        [0.05, 0],
        [-0.05, 0],
        [0, 0.05],
        [0, -0.05],
        [0.1, 0.1],
        [-0.1, -0.1],
        [0.2, 0],
        [-0.2, 0],
      ]) {
        const owner = { ...bundle },
          q = [p[0] + dx, p[1] + dy];
        query(owner, p, 1);
        if (query(owner, q, 1) !== query({ ...bundle }, q, 1)) moveBad++;
        queries++;
      }
    }
  check(
    queries === 1728 && zoomBad === 0 && moveBad === 0,
    `${queries} production hit queries are independent of cached zoom/pointer order (${zoomBad} zoom, ${moveBad} move differences)`,
  );
}

console.log('(i) em per pixel at every world scale');
{
  const { emPerPxOf } = await import('../src/hitTest/curveGeom.js');
  const { fillHitShape, HitMode } = await import('../src/hitTest/hitTest.js');
  const { default: importSvg } = await import('../src/svg/importer.js');
  const FINE = [1, 1e-3, 1e-6, 1e-11, 1e-12, 1e-13, 2 ** -40, 2 ** -60, 1e-30, 1e-300];
  const off = FINE.filter((f) => Math.abs(emPerPxOf([f, 0, 0, 0, f, 0, 0, 0, 1]) * f - 1) > 1e-12);
  check(
    off.length === 0,
    `em per pixel is the inverse of the scale${off.length ? ` -- wrong at ${off.join(' ')}` : ''}`,
  );
  check(
    emPerPxOf([2 ** -50, 0, 0, 0, 2 ** -48, 0, 0, 0, 1]) === 0.5 * (2 ** 50 + 2 ** 48),
    'each axis answers for itself at an anisotropic tiny scale',
  );
  check(
    emPerPxOf([0, 0, 0, 0, 2 ** -50, 0, 0, 0, 1]) === 2 ** 50,
    "an axis of no length takes the other axis's size, whatever the scale",
  );
  check(emPerPxOf([0, 0, 0, 0, 0, 0, 0, 0, 1]) === 1, 'a matrix with no size at all stays at 1');
  check(
    emPerPxOf([5e-324, 0, 0, 0, 5e-324, 0, 0, 0, 1]) === 1,
    'an inverse that does not fit a double reads as no size',
  );
  // A non-scaling stroke 10 pixels wide stays 10 pixels wide: 3 pixels off its center line hits and 7 does not.
  const b = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="M0 100H200" fill="none" stroke="#000" stroke-width="10" vector-effect="non-scaling-stroke"/></svg>',
    { preserveViewport: true },
  );
  const wrong = [];
  for (const f of FINE.slice(0, 9)) {
    const W = [f, 0, 0, 0, f, 0, 0, 0, 1];
    if (fillHitShape(b, 100 * f, 100 * f + 3, { mode: 'outline', worldMatrix: W }) < 0)
      wrong.push(`${f} near`);
    if (fillHitShape(b, 100 * f, 100 * f + 7, { mode: 'outline', worldMatrix: W }) >= 0)
      wrong.push(`${f} far`);
  }
  check(
    wrong.length === 0,
    `a non-scaling stroke keeps its pixel width at world scales 1..1e-30${wrong.length ? ` -- ${wrong.join(', ')}` : ''}`,
  );
  // Coverage mode: a curved shape far under a pixel covers less than half of the pixel around it, at every such scale.
  const r = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M40 50Q50 30 60 50T40 50Z"/></svg>',
    { preserveViewport: true },
  );
  const under = [1e-6, 1e-11, 1e-12, 1e-13, 2 ** -60].map((f) =>
    fillHitShape(r, 50 * f, 50 * f, {
      mode: HitMode.Coverage,
      worldMatrix: [f, 0, 0, 0, f, 0, 0, 0, 1],
    }),
  );
  check(
    under.every((a) => a === -1),
    `Coverage answers alike below a pixel: ${under.join(' ')}`,
  );
}

if (fail) {
  console.error(`HIT-TEST SCALE-INVARIANT FAIL (${fail})`);
  process.exit(1);
}
console.log('HIT-TEST SCALE-INVARIANT PASS');
