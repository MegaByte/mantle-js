// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _sCurveFamily — a morph whose inflection MOVES along its cubic, and what serving it would cost.
//
// The morph pair cuts both poses of a cubic at every cut either pose's plan needs, at the same parameter, because a
// Bezier split commutes with the vertex stage's lerp. An inflection is a cut each pose places at its own parameter, so
// both are taken, and the piece between them lies after one pose's inflection and before the other's: it bulges to
// opposite sides of its chord on the two poses. A lerped crescent face cannot cross its chord, so the pair declines
// (`bulge-flip`, or `dst-klmn-frame` where the destination's piece is the degenerate one), and so does every t-segment
// of it, because each cell's piece flips the same way.
//
// The family: a 100-unit S-curve closed by three lines, its first control point moved by da; 60 pairs. Per pair it
// reports the inflection's parameter on each pose, how far it travels in vertex quanta (each pose's own, 2^-16 of the
// shape), the full pair's answer and buildMorphShape's route -- the SERPENTINE pair (the piece holding the moving
// inflection kept whole on both poses, certified by the drift oracle in as many cells as it needs) or the fine
// t-cells it falls back to, with cells, MiB and build time per route; then it prices two ways to serve the
// class:
//
//   FINE t-CELLS: a cell whose flipping piece fits inside one quantum of both poses is merged away (mergeCubicPlans9),
//     so cells of one quantum of travel each would all build. That is `travel` cells per morph, each a full mesh.
//   A MOVING CUT: cut each pose at its own inflection and lerp the two pieces. Exact at both poses; between them the
//     drawn outline is not the lerped curve, and this reports how far it strays (sampled, as a fraction of the chord,
//     with a sampling floor near 3e-4) against the drift oracle's bar of 0.002.
//
//   node probes/morphScale/_sCurveFamily.mjs
const PAIR = await import('../../src/renderer/lbPartitionPair.js');
const LC = await import('../../src/geom/lbContour.js');
const { buildMorphShape } = await import('../../src/renderer/lbMorphCore.js');
const { LB_VERT_FLOATS: VF } = await import('../../src/renderer/lbPack.js');
const { mkLine, mkCubic } = await import('../../src/primitives/seg.js');
const { splitCubicMulti } = await import('../../src/geom/lbCubicMath.js');

const shape = (a, b, h) => [
  [
    mkCubic([0, 0], [a, h], [100 - b, -h], [100, 0]),
    mkLine([100, 0], [100, 150]),
    mkLine([100, 150], [0, 150]),
    mkLine([0, 150], [0, 0]),
  ],
];
const Bz = (P, t) => {
  const u = 1 - t;
  return [0, 1].map(
    (k) =>
      u * u * u * P[0][k] + 3 * u * u * t * P[1][k] + 3 * u * t * t * P[2][k] + t * t * t * P[3][k],
  );
};
/// The inflection parameters of a cubic in (0, 1): roots of cross(B', B''), a quadratic in t.
function infl(P) {
  const a = [
    -P[0][0] + 3 * P[1][0] - 3 * P[2][0] + P[3][0],
    -P[0][1] + 3 * P[1][1] - 3 * P[2][1] + P[3][1],
  ];
  const b = [3 * (P[0][0] - 2 * P[1][0] + P[2][0]), 3 * (P[0][1] - 2 * P[1][1] + P[2][1])],
    c = [3 * (P[1][0] - P[0][0]), 3 * (P[1][1] - P[0][1])];
  const x = (u, v) => u[0] * v[1] - u[1] * v[0],
    A = 6 * x(a, b),
    B = 6 * x(a, c),
    C = 2 * x(b, c),
    d = B * B - 4 * A * C;
  if (Math.abs(A) <= 1e-12 * (Math.abs(B) + Math.abs(C)))
    return B ? [-C / B].filter((t) => t > 0 && t < 1) : [];
  if (d < 0) return [];
  const r = Math.sqrt(d);
  return [(-B - r) / (2 * A), (-B + r) / (2 * A)]
    .filter((t) => t > 0 && t < 1)
    .sort((p, q) => p - q);
}
const cps = (C) => [C[0][0].p1, C[0][0].p2, C[0][0].p3, C[0][0].p4];
const meta = new Float32Array(40);
meta[28] = 1;
meta[7] = 1;
const _warn = console.warn;
console.warn = () => {};

const why = {},
  route = {},
  served = [];
let travelLo = Infinity,
  travelHi = 0,
  n = 0;
for (const [a0, b0] of [
  [50, 50],
  [30, 60],
  [60, 30],
])
  for (const da of [-12, -6, -3, -1, 1, 3, 6, 12, 20, 30])
    for (const h of [100, 60]) {
      const A = shape(a0, b0, h),
        B = shape(a0 + da, b0, h),
        PA = cps(A),
        PB = cps(B),
        iA = infl(PA),
        iB = infl(PB);
      if (iA.length !== 1 || iB.length !== 1) continue;
      n++;
      const qA = LC.emUnitsOf(A).res,
        qB = LC.emUnitsOf(B).res,
        d = (P, s, t) => Math.hypot(Bz(P, s)[0] - Bz(P, t)[0], Bz(P, s)[1] - Bz(P, t)[1]);
      const travel = Math.max(d(PA, iA[0], iB[0]) / qA, d(PB, iA[0], iB[0]) / qB);
      travelLo = Math.min(travelLo, travel);
      travelHi = Math.max(travelHi, travel);
      const w = PAIR.buildLoopBlinnPartitionPair(A, B, 'nonzero') ? 'built' : PAIR.lbPairDeclineWhy;
      let r = null;
      const t0 = performance.now();
      try {
        r = buildMorphShape(A, B, meta, meta, 0, 40);
      } catch {
        r = null;
      }
      const ms = performance.now() - t0;
      const rt = r && r.mesh ? 'LB' : 'Slug';
      why[w] = (why[w] || 0) + 1;
      route[rt] = (route[rt] || 0) + 1;
      const me = r && r.mesh,
        cells = me ? (me.segments ? me.segments.length : 1) : 0;
      const bytes = me
        ? me.segments
          ? me.segments.reduce((t, g) => t + g.vbo.byteLength, 0)
          : me.vbo.byteLength
        : 0;
      served.push({ travel, cells, bytes, ms, serp: !!(me && me.serpentine) });
      if (process.env.ALL)
        console.log(
          `  P1 (${a0},${h}) + ${da}: inflection ${iA[0].toFixed(4)} -> ${iB[0].toFixed(4)}, ${travel.toFixed(0)} quanta; pair ${w}; ` +
            `${rt}${me ? `, ${cells} cells, ${(bytes / 1048576).toFixed(2)} MiB` : r && r.pairWhy ? ` (${r.pairWhy})` : ''}; ${ms.toFixed(0)} ms`,
        );
    }
console.log(
  `${n} pairs: the full pair ${JSON.stringify(why)}; buildMorphShape ${JSON.stringify(route)}; the inflection travels ${travelLo.toFixed(0)} to ${travelHi.toFixed(0)} quanta`,
);
// Which route served each member: the SERPENTINE pair first, and the fine t-cells for what the
// serpentine route cannot certify. A single-mesh morph counts as one cell.
for (const [name, lb] of [
  ['the serpentine pair (c)', served.filter((v) => v.cells > 0 && v.serp)],
  ['fine t-cells (a), the fallback', served.filter((v) => v.cells > 0 && !v.serp)],
]) {
  if (!lb.length) {
    console.log(`served by ${name}: 0`);
    continue;
  }
  const r = (k, f = (v) => v) => {
    const xs = lb.map((v) => f(v[k]));
    return `${Math.min(...xs).toFixed(k === 'bytes' ? 2 : 0)} to ${Math.max(...xs).toFixed(k === 'bytes' ? 2 : 0)}`;
  };
  console.log(
    `served by ${name}: ${lb.length}; cells ${r('cells')}; MiB ${r('bytes', (b) => b / 1048576)}; ` +
      `build ${r('ms')} ms; cells per quantum of travel ${Math.min(...lb.map((v) => v.cells / v.travel)).toFixed(3)} to ${Math.max(...lb.map((v) => v.cells / v.travel)).toFixed(3)}`,
  );
}

// FINE t-CELLS: one mesh per quantum of travel
{
  const A = shape(50, 50, 100),
    B = shape(50.001, 50, 100),
    r = buildMorphShape(A, B, meta, meta, 0, 40),
    me = r && r.mesh;
  const bytes = me ? me.vertexCount * 2 * VF * 4 : 0;
  console.log(
    `fine t-cells: a cell of this shape is ${me ? me.vertexCount : '?'} vertices, ${(bytes / 1024).toFixed(1)} KiB; ` +
      `${travelLo.toFixed(0)} to ${travelHi.toFixed(0)} cells is ${((bytes * travelLo) / 1048576).toFixed(1)} to ${((bytes * travelHi) / 1048576).toFixed(1)} MiB per morph`,
  );
}
// A MOVING CUT: each pose cut at its own inflection, the pieces lerped, against the lerped curve
for (const da of [1, 6, 12, 20, 30]) {
  const PA = cps(shape(50, 50, 100)),
    PB = cps(shape(50 + da, 50, 100)),
    tA = infl(PA)[0],
    tB = infl(PB)[0];
  const sA = splitCubicMulti(PA, [tA]),
    sB = splitCubicMulti(PB, [tB]);
  let worst = 0;
  for (let t = 0.05; t < 1; t += 0.05) {
    const Pt = PA.map((p, k) => [p[0] + (PB[k][0] - p[0]) * t, p[1] + (PB[k][1] - p[1]) * t]),
      dense = [];
    for (let i = 0; i <= 4000; i++) dense.push(Bz(Pt, i / 4000));
    for (let k = 0; k < 2; k++) {
      const Q = sA[k].map((p, j) => [
        p[0] + (sB[k][j][0] - p[0]) * t,
        p[1] + (sB[k][j][1] - p[1]) * t,
      ]);
      for (let i = 0; i <= 200; i++) {
        const q = Bz(Q, i / 200);
        let dm = Infinity;
        for (const p of dense) dm = Math.min(dm, Math.hypot(p[0] - q[0], p[1] - q[1]));
        worst = Math.max(worst, dm / 100);
      }
    }
  }
  console.log(
    `moving cut, P1.x + ${da}: the drawn outline strays ${worst.toExponential(2)} of the chord from the lerped curve; ` +
      `cells to hold 0.002: ${Math.max(1, Math.ceil(Math.sqrt(worst / 0.002)))}`,
  );
}
console.warn = _warn;
