// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbBuildPathParitySmoke — ONE build path decides the route, and the shape it decides for is
// painted right.
//
// ONE ROUTE. A second copy of the per-shape route — fast earcut vs CDT partition vs Slug — in
// `_ensureLbMeshes` (main thread) beside `buildLbShape`'s (the worker's) drifts on details: the
// cubic gate, the cusp split, a straight-contour CDT retry, a per-mesh vertex cap a CURVED branch
// bypasses by returning early. Then identical input becomes a different mesh depending on WHICH
// BUILD PATH WINS A RACE, and the kind mask, the compiled shader variant, engineLedger, the memory
// accounting and every benchmark inherit that.
//
// INK IS THE CHECK. `buildLbShape`'s route without the degree reduction below makes
// `lbCubicOverfillSmoke`'s squircle paint LB/Slug = 0.595. Scoring meshes against their own paths
// and AVERAGING over shapes misses that; INK, per shape, against a reference, catches it.
//
// WHY the squircle: a cubic with C3 = -P0 + 3P1 - 3P2 + P3 == 0 is a QUADRATIC in cubic clothing,
// cubicKLMN bails on it, and the Bezout crescent that replaces it draws only the interior diamond.
// `buildRims` degree-reduces such a cubic (lbFastMesh.js); the PARTITION does not —
// `cubicDegreeReduce` is not called from lbPartition. So lbBuildCore reduces before the route
// decision, which fixes the partition AND makes the cubic gate agree with itself, so the shape
// takes the same route from either builder.
//
// THE GATE IS INK, and it is a CPU twin of lbCubicOverfillSmoke's: that smoke compares LB's ink to
// Slug's in a browser, this one compares LB's ink to the path's own exact coverage on the same
// fixtures, at the same threshold and the same tolerance band. No GPU.
import { buildLbShape } from '../src/renderer/lbBuildCore.js';
import { mkLine, mkQuad, mkCubic, SEG_QUAD, SEG_CUBIC } from '../src/primitives/seg.js';
import { viewOf, rasterMesh } from '../probes/lbAccuracy/_lbRaster.mjs';
import { refKit, exactCov } from '../probes/lbAccuracy/_lbAaRef.mjs';

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
const warn = console.warn;
console.warn = () => {};

const N = 160;
// lbCubicOverfillSmoke reads ink as `px < 250` on a #3366cc fill over white; the tightest channel
// is R = 255 - a*204, so the threshold it applies is a > 5/204.
const INK = 5 / 204;

const closed = (segs) => {
  const last = segs[segs.length - 1];
  const end = last.p4 || last.p3 || last.p2;
  if (Math.abs(end[0] - segs[0].p1[0]) > 1e-12 || Math.abs(end[1] - segs[0].p1[1]) > 1e-12)
    segs.push(mkLine(end, segs[0].p1));
  return segs;
};
const cubicRing = (n, bulge) => {
  const c = 100,
    r = 60;
  const P = (i) => {
    const a = (i / n) * 2 * Math.PI;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };
  const segs = [];
  for (let i = 0; i < n; i++) {
    const A = P(i),
      B = P(i + 1);
    const bx = (B[1] - A[1]) * bulge,
      by = -(B[0] - A[0]) * bulge;
    segs.push(
      mkCubic(
        A,
        [A[0] + (B[0] - A[0]) / 3 + bx, A[1] + (B[1] - A[1]) / 3 + by],
        [A[0] + (2 * (B[0] - A[0])) / 3 - bx, A[1] + (2 * (B[1] - A[1])) / 3 - by],
        B,
      ),
    );
  }
  return closed(segs);
};
const quadRing = (n, bulge) => {
  const c = 100,
    r = 60;
  const P = (i) => {
    const a = (i / n) * 2 * Math.PI;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };
  const segs = [];
  for (let i = 0; i < n; i++) {
    const A = P(i),
      B = P(i + 1);
    segs.push(
      mkQuad(
        A,
        [(A[0] + B[0]) / 2 + (B[1] - A[1]) * bulge, (A[1] + B[1]) / 2 - (B[0] - A[0]) * bulge],
        B,
      ),
    );
  }
  return closed(segs);
};
// The corner-control squircle, the exact fixture lbCubicOverfillSmoke names: C3 == 0 on all four.
const SQUIRCLE = closed([
  mkCubic([40, 100], [40, 60], [60, 40], [100, 40]),
  mkCubic([100, 40], [140, 40], [160, 60], [160, 100]),
  mkCubic([160, 100], [160, 140], [140, 160], [100, 160]),
  mkCubic([100, 160], [60, 160], [40, 140], [40, 100]),
]);

const kit = await refKit();
const bboxOf = (contours) => {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of contours)
    for (const s of c)
      for (const p of [s.p1, s.p2, s.p3, s.p4]) {
        if (!p) continue;
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
  return [x0, y0, x1, y1];
};
/// LB's ink over the path's own exact ink, on one shape.
function inkRatio(contours, evenOdd) {
  const view = viewOf(bboxOf(contours), N);
  const b = buildLbShape(contours, false, !!evenOdd);
  if (!b || !b.pk || !b.pk.vertexCount || (b.pk.fallback && b.pk.fallback.length))
    return { ratio: NaN, route: 'DECLINED' };
  const acc = new Float64Array(N * N).fill(1);
  rasterMesh(b.pk, view, acc, {}, null, null, null);
  const cv = kit.contoursToConverter(contours, null);
  const curves = kit.closed(cv);
  let lb = 0,
    ex = 0;
  const rc = new Map();
  for (let j = 0; j < N; j++) {
    rc.clear();
    for (let i = 0; i < N; i++) {
      if (1 - acc[j * N + i] > INK) lb++;
      if (exactCov(kit.rowSpans, curves, i, j, view, 16, !!evenOdd, rc) > INK) ex++;
    }
  }
  return { ratio: lb / Math.max(1, ex), route: b.raw._route || 'fast', verts: b.pk.vertexCount };
}

// ── 1. THE INK GATE, per shape ───────────────────────────────────────────────────────────────
// lbCubicOverfillSmoke's own band. The squircle is the sensitive one: 0.595 through buildLbShape's
// route without the reduction.
for (const [name, segs] of [
  ['squircle (degree-reducible)', SQUIRCLE],
  ['cubic ring  4 x bulge 0.55', cubicRing(4, 0.55)],
  ['cubic ring  8 x bulge 0.55', cubicRing(8, 0.55)],
  ['cubic ring  8 x bulge 0.30', cubicRing(8, 0.3)],
  ['cubic ring 16 x bulge 0.55', cubicRing(16, 0.55)],
  ['quad  ring  8 x bulge 0.55', quadRing(8, 0.55)],
]) {
  const r = inkRatio([segs], false);
  ok(
    r.ratio >= 0.985 && r.ratio <= 1.015,
    `${name}: ink LB/exact = ${r.ratio.toFixed(4)} within [0.985, 1.015] (route ${r.route})`,
  );
}

// ── 2. the mechanism, so a failure names itself ───────────────────────────────────────────
// A degree-reducible cubic is reduced to a quad before the route is chosen, which is why the
// squircle takes the fast path from either builder.
{
  const r = inkRatio([SQUIRCLE], false);
  ok(
    r.route === 'fast',
    `the squircle routes to the fast mesh, not the partition (got ${r.route}) — the reduction happens before the gate`,
  );
  // ...and it really is the degree-reduction doing it: the same shape with its control points
  // perturbed off C3 == 0 is a genuine cubic and takes the partition.
  const bent = closed([
    mkCubic([40, 100], [40, 59], [60, 40], [100, 40]),
    mkCubic([100, 40], [140, 40], [160, 60], [160, 100]),
    mkCubic([160, 100], [160, 140], [140, 160], [100, 160]),
    mkCubic([100, 160], [60, 160], [40, 140], [40, 100]),
  ]);
  const rb = inkRatio([bent], false);
  ok(
    rb.route !== 'fast',
    `a GENUINE cubic squircle still takes the partition (got ${rb.route}) — the reduction is exact-only`,
  );
  ok(
    rb.ratio >= 0.985 && rb.ratio <= 1.015,
    `...and it is painted right too: ink ${rb.ratio.toFixed(4)}`,
  );
}

// ── 3. a self-crossing straight outline is analytic, not Slug ────────────────────────────────
// The one route carries a CDT retry for a straight contour the fast rim cannot thread, so neither
// builder can be the only one that serves such a shape. `buildLoopBlinnMesh` resolves a crossing
// outline itself (resolveSelfOverlap honors the fill rule), so no input here reaches the retry,
// and this pins the outcome rather than the branch.
{
  const star = [];
  const pts = [];
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
    pts.push([100 + 60 * Math.cos(a), 100 + 60 * Math.sin(a)]);
  }
  for (let i = 0; i < 5; i++) star.push(mkLine(pts[i], pts[(i + 1) % 5]));
  const b = buildLbShape([star], false, true);
  ok(
    !!(b && b.pk && b.pk.vertexCount > 0),
    `a self-crossing pentagram builds through the straight-contour CDT retry (${b ? b.pk.vertexCount : 0} verts)`,
  );
}

// ── 4. the knobs the main thread hands in, rather than reimplementing ────────────────────────
{
  const ring = quadRing(8, 0.55);
  const plain = buildLbShape([ring], false, false);
  const forced = buildLbShape([ring], false, false, { forceCdt: true });
  ok(!!plain && !!forced, 'forceCdt builds');
  ok(
    plain && forced && (plain.raw._route || 'fast') !== (forced.raw._route || 'fast'),
    `forceCdt reaches the route: ${plain && (plain.raw._route || 'fast')} -> ${forced && (forced.raw._route || 'fast')}`,
  );
  // `prev` is the fixed-topology refresh, and a refreshed mesh must say so: a caller keying a
  // CONTENT cache cannot publish a mesh that reused another build's triangulation. The fixtures are a
  // triangle and a pentagon: an all-straight outline of any other side count takes the fast earcut
  // route, which is the one that keeps a topology to refresh. (A four-sided outline is NOT such a
  // fixture: it takes the non-overlapping partition at its corners, so a square
  // carries no topology and never reuses one; the last two assertions pin that too.)
  const poly = (pts) => [pts.map((p, i) => mkLine(p, pts[(i + 1) % pts.length]))];
  for (const [name, pts] of [
    [
      'triangle',
      [
        [0, 0],
        [10, 0],
        [5, 10],
      ],
    ],
    [
      'pentagon',
      [
        [0, 0],
        [10, 0],
        [13, 8],
        [5, 14],
        [-3, 8],
      ],
    ],
  ]) {
    const a = buildLbShape(poly(pts), false, false);
    ok(!!a && !a.raw._lbRefreshed, `${name}: a first build is not marked refreshed`);
    const moved = poly(pts.map(([x, y]) => [x * 1.01, y * 0.99]));
    const b2 = buildLbShape(moved, false, false, { prev: a && a.raw });
    ok(
      !!b2 && !!b2.raw._lbRefreshed,
      `${name}: a build handed \`prev\` reuses its topology and says so`,
    );
  }
  const sq = poly([
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]);
  const sa = buildLbShape(sq, false, false);
  ok(
    !!sa && sa.raw._route === 'partition-carve' && !sa.raw._topo,
    `a four-sided outline takes the partition (route ${sa && sa.raw._route}) and keeps no topology to refresh`,
  );
  const sb = buildLbShape(sq, false, false, { prev: sa && sa.raw });
  ok(
    !!sb && !sb.raw._lbRefreshed,
    'so a build handed its `prev` is a full build, and does not claim to be refreshed',
  );
}

console.warn = warn;
console.log(fail ? `LB-BUILD-PATH-PARITY FAIL (${fail})` : 'LB-BUILD-PATH-PARITY OK');
process.exit(fail ? 1 : 0);
