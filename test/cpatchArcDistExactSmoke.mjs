// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchArcDistExactSmoke — CPatch's arc distance finds the NEAREST point of the drawn arc.
//
// THE TRAP. Seeding nine parameters B(k/8), keeping the nearest and taking three Gauss-Newton steps
// from it converges in whichever basin that seed sits in -- and a Bezier can hold several minima.
// Against a dense float64 reference on the arcs of the real bundles, at points in their AA bands,
// that is off by up to 4.2 px on tiger at 512 (209 of 124,056 queries past 0.1 px) and by 58 px on
// a corpus conic. So cpArcDistFoot solves (B(t) - p).B'(t) = 0 on the curve's own
// degree: quadClosestT's closed form for a quadratic, the descending chain for a cubic's quintic
// (cubicClosestDescend) and for a conic's quartic (cpConicClosestT).
//
// WHAT this PINS, on the SHIPPED kernel text in float32 (test/_glslEmu.mjs, cpatch mode): on arcs
// built to hold two minima -- S-curves, loops, near-cusps, sharp conics -- and on ordinary ones, at
// query points around each, the distance cpArcDistFoot returns exceeds the true minimum (a dense
// float64 scan plus golden section) by no more than float32 rounding: 1e-5 of the arc's size. And an
// END is reported as exactly t = 0 or 1, the contract the kernel's interior test relies on.
// A seeded kernel text FAILS: the S-curves and loops land in the far basin.
import path from 'path';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!EMU.hasCxx()) {
  console.log('  SKIP: no C++ compiler for the shader emulator');
  process.exit(0);
}
if (EMU.K_CPATCH_ARC === undefined) {
  ok(false, 'the emulator has a query for cpArcDistFoot (K_CPATCH_ARC)');
  process.exit(1);
}
const emu = EMU.buildGlslEmu(ROOT, { cpatch: true });
const F = Math.fround;

// B(t) as the kernel evaluates it: a quadratic or conic from (P0, P1, P2, w), a cubic from four points.
const ev = (a, t) => {
  const u = 1 - t,
    P = a.P;
  if (a.arc3) {
    const w = a.w,
      b0 = u * u,
      b1 = 2 * u * t * w,
      b2 = t * t,
      W = b0 + b1 + b2;
    return [
      (b0 * P[0][0] + b1 * P[1][0] + b2 * P[2][0]) / W,
      (b0 * P[0][1] + b1 * P[1][1] + b2 * P[2][1]) / W,
    ];
  }
  const b0 = u * u * u,
    b1 = 3 * u * u * t,
    b2 = 3 * u * t * t,
    b3 = t * t * t;
  return [
    b0 * P[0][0] + b1 * P[1][0] + b2 * P[2][0] + b3 * P[3][0],
    b0 * P[0][1] + b1 * P[1][1] + b2 * P[2][1] + b3 * P[3][1],
  ];
};
function truth(a, p) {
  const N = 4096,
    d = (t) => {
      const q = ev(a, t);
      return Math.hypot(q[0] - p[0], q[1] - p[1]);
    };
  const ds = [];
  for (let i = 0; i <= N; i++) ds.push(d(i / N));
  let m = Infinity;
  for (let i = 0; i <= N; i++) {
    if (!(ds[i] <= (i ? ds[i - 1] : Infinity) && ds[i] <= (i < N ? ds[i + 1] : Infinity))) continue;
    let lo = Math.max(0, (i - 1) / N),
      hi = Math.min(1, (i + 1) / N);
    for (let k = 0; k < 80; k++) {
      const m1 = lo + (hi - lo) * 0.382,
        m2 = lo + (hi - lo) * 0.618;
      if (d(m1) < d(m2)) hi = m2;
      else lo = m1;
    }
    m = Math.min(m, d((lo + hi) / 2), ds[i]);
  }
  return m;
}

const ARCS = [
  // two minima by construction: an S-curve and a loop, with points between their lobes
  {
    name: 'S-curve cubic',
    arc3: false,
    P: [
      [0, 0],
      [100, 0],
      [0, 100],
      [100, 100],
    ],
  },
  {
    name: 'looping cubic',
    arc3: false,
    P: [
      [0, 0],
      [120, 100],
      [-20, 100],
      [100, 0],
    ],
  },
  {
    name: 'near-cusp cubic',
    arc3: false,
    P: [
      [0, 0],
      [100, 60],
      [0, 60],
      [100, 0.5],
    ],
  },
  {
    name: 'ordinary cubic',
    arc3: false,
    P: [
      [3, 7],
      [40, -10],
      [80, 60],
      [101, 33],
    ],
  },
  {
    name: 'tight quadratic',
    arc3: true,
    w: 1,
    P: [
      [0, 0],
      [50, 400],
      [100, 0],
    ],
  },
  {
    name: 'ordinary quadratic',
    arc3: true,
    w: 1,
    P: [
      [0, 0],
      [30, 70],
      [100, 20],
    ],
  },
  {
    name: 'sharp conic (w = 6)',
    arc3: true,
    w: 6,
    P: [
      [0, 0],
      [50, 100],
      [100, 0],
    ],
  },
  {
    name: 'flat conic (w = 0.2)',
    arc3: true,
    w: 0.2,
    P: [
      [0, 0],
      [50, 100],
      [100, 0],
    ],
  },
  {
    name: 'circular conic',
    arc3: true,
    w: Math.SQRT1_2,
    P: [
      [100, 0],
      [100, 100],
      [0, 100],
    ],
  },
];
let seed = 11;
const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
for (const a of ARCS) {
  const P = a.P.map((q) => q.map(F)),
    w = F(a.w ?? 1),
    A = { ...a, P, w };
  const g0 = [P[0][0], P[0][1], P[1][0], P[1][1]],
    g1 = a.arc3 ? [P[2][0], P[2][1], w, 0] : [P[2][0], P[2][1], P[3][0], P[3][1]];
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (let i = 0; i <= 64; i++) {
    const q = ev(A, i / 64);
    x0 = Math.min(x0, q[0]);
    x1 = Math.max(x1, q[0]);
    y0 = Math.min(y0, q[1]);
    y1 = Math.max(y1, q[1]);
  }
  const size = Math.max(x1 - x0, y1 - y0),
    pts = [];
  for (let i = 0; i < 400; i++)
    pts.push([F(x0 - 0.2 * size + rnd() * 1.4 * size), F(y0 - 0.2 * size + rnd() * 1.4 * size)]);
  const qs = [];
  for (const p of pts)
    for (const which of [0, 1])
      qs.push({ k: EMU.K_CPATCH_ARC, GD: [a.arc3 ? 1 : 0, which, 0, 0], bb: g0, c: p, ex: g1 });
  const r = emu.run(new Float32Array(4), new Float32Array(4), qs);
  let worst = 0,
    endsExact = true;
  for (let i = 0; i < pts.length; i++) {
    const d = r[2 * i],
      t = r[2 * i + 1],
      tr = truth(A, pts[i]);
    worst = Math.max(worst, (d - tr) / size);
    // an END: the true nearest point is an endpoint, and no interior point comes within rounding of it
    const e0 = Math.hypot(pts[i][0] - P[0][0], pts[i][1] - P[0][1]),
      pe = a.arc3 ? P[2] : P[3],
      e1 = Math.hypot(pts[i][0] - pe[0], pts[i][1] - pe[1]);
    if (Math.min(e0, e1) < tr + 1e-3 * size && !(t === 0 || t === 1)) {
      // only an error if the end is strictly nearest -- a tie with an interior point may report either
      const q = ev(A, t);
      if (Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]) > Math.min(e0, e1) + 1e-5 * size)
        endsExact = false;
    }
  }
  ok(
    worst <= 1e-5,
    `${a.name}: the distance is the nearest point's (worst excess ${worst.toExponential(2)} of the arc's size over ${pts.length} points)`,
  );
  ok(endsExact, `${a.name}: a foot point at an end comes back as exactly t = 0 or 1`);
}
console.log(fail ? `\ncpatchArcDistExactSmoke FAIL (${fail})` : '\ncpatchArcDistExactSmoke PASS');
process.exit(fail ? 1 : 0);
