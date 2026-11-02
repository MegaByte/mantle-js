// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbSerpentinePairSmoke — a morph whose inflection moves is served by ONE serpentine pair, or a few, and
// fine t-cells serve only what that cannot certify.
//
// The pair cuts both poses of a cubic at one set of parameters, and an inflection is a cut each pose places at its own:
// the piece between the two cuts bulges to opposite sides of its chord on the two poses, and no pair spans it. Fine
// t-cells cut the morph into cells short enough that the cuts merge, one mesh per quantum the inflection travels (up to
// 1457 cells and 30 MiB on the S-curve family). A serpentine pair does not cut at the moving inflection at all: the piece that
// holds it is a SERPENTINE on both poses, drawn over its whole control hull by its implicit -- a Loop-Blinn face covers
// its hull, and the implicit's sign is the ink side on both lobes -- with its sign and its keep half-plane read from
// the piece's own ink probe, since a serpentine bulges to both sides and "the control side" names none. The pair is
// certified between its poses by the drift oracle, refined into as many cells as its drift needs under the per-shape
// memory budget, and a morph it cannot certify falls to the fine cells.
//
// No GPU:
//   - the pair's plan keeps no cut inside a moving inflection's range, on either pose, when asked for serpentines;
//   - six family members build serpentine pairs, in far fewer cells and bytes than fine t-cells;
//   - in the CPU model of the morph draw, three members lose no ink inside the fill at seven t, and are off exact at no
//     more pixels in all than the fine t-cells of the same morph;
//   - a POINT-SYMMETRIC destination (d1 = 0, its second inflection at infinity) is served too: its serpentine has an
//     exact klmn frame (cubicKLMNSerpentine: affine-consistent rows, zero along the curve, cubicKLMN's orientation), and
//     a destination fan triangle that is collinear at that pose keeps the ring its source planned (lbPack
//     _ringPlanFrom9), so the two poses pack alike. The fine t-cells (lbMovingInflectionSmoke) then serve nothing in
//     the family.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { mkLine, mkCubic } = await import('../src/primitives/seg.js');
const { buildMorphShape } = await import('../src/renderer/lbMorphCore.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { cubicInflections } = await import('../src/geom/lbCubicMath.js');
const PAIR = await import('../src/renderer/lbPartitionPair.js');
const EMU = await import('./_lbMorphDrawEmu.mjs');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};

const shape = (a, b, h) => [
  [
    mkCubic([0, 0], [a, h], [100 - b, -h], [100, 0]),
    mkLine([100, 0], [100, 150]),
    mkLine([100, 150], [0, 150]),
    mkLine([0, 150], [0, 0]),
  ],
];
const meta = new Float32Array(40);
meta[28] = 1;
meta[7] = 1;
const cellsOf = (m) => (m ? (m.segments ? m.segments.length : 1) : 0);
const bytesOf = (m) =>
  m ? (m.segments ? m.segments.reduce((t, g) => t + g.vbo.byteLength, 0) : m.vbo.byteLength) : 0;
// The fine-cells arm is the TEST HOOK __LB_SERPENTINE_PAIR = false, read only under __MANTLE_DEBUG__.
const build = (a0, b0, h, da, serp) => {
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__LB_SERPENTINE_PAIR = serp;
  const t0 = performance.now();
  let r = null;
  try {
    r = buildMorphShape(shape(a0, b0, h), shape(a0 + da, b0, h), meta, meta, 0, 40);
  } finally {
    delete globalThis.__LB_SERPENTINE_PAIR;
    delete globalThis.__MANTLE_DEBUG__;
  }
  return { m: r && r.mesh, why: r && r.pairWhy, ms: performance.now() - t0 };
};

{
  console.log('-- the plan keeps a moving inflection inside one piece');
  const A = shape(30, 60, 100),
    B = shape(42, 60, 100);
  const iS = cubicInflections([A[0][0].p1, A[0][0].p2, A[0][0].p3, A[0][0].p4]),
    iD = cubicInflections([B[0][0].p1, B[0][0].p2, B[0][0].p3, B[0][0].p4]);
  const lo = Math.min(iS[0], iD[0]),
    hi = Math.max(iS[0], iD[0]);
  const cutsIn = (plan) => plan.get('0|0').ts.filter((t) => t >= lo && t <= hi).length;
  const plain = PAIR.pairCubicPlans9(A, B),
    serp = PAIR.pairCubicPlans9(A, B, A, B, true);
  ok(
    cutsIn(plain) === 2 && cutsIn(serp) === 0,
    `the inflection moves ${iS[0].toFixed(4)} -> ${iD[0].toFixed(4)}: cuts inside that range ${cutsIn(plain)} (each pose's own) -> ${cutsIn(serp)}`,
  );
}

const MEMBERS = [
  [50, 50, 100, 1],
  [50, 50, 100, 12],
  [30, 60, 60, 3],
  [60, 30, 60, -3],
  [30, 60, 100, -12],
  [60, 30, 100, 30],
];
const built = MEMBERS.map(([a0, b0, h, da]) => ({ a0, b0, h, da, ...build(a0, b0, h, da, true) }));
{
  console.log('-- six members of the family, served by serpentine pairs');
  ok(
    built.every((b) => b.m && b.m.serpentine && cellsOf(b.m) <= 32),
    built
      .map(
        (b) =>
          `P1 (${b.a0},${b.h}) ${b.da > 0 ? '+' : ''}${b.da}: ` +
          (b.m
            ? `${b.m.serpentine ? 'serpentine' : 'fine cells'}, ${cellsOf(b.m)} cell(s), ${(bytesOf(b.m) / 1024).toFixed(0)} KiB, ${b.ms.toFixed(0)} ms`
            : `Slug (${b.why})`),
      )
      .join('; '),
  );
  // Fine t-cells on the two cheapest, for the comparison.
  for (const i of [0, 2]) {
    const b = built[i],
      a = build(b.a0, b.b0, b.h, b.da, false);
    b.fine = a;
    ok(
      !!a.m &&
        !a.m.serpentine &&
        cellsOf(a.m) > 10 * cellsOf(b.m) &&
        bytesOf(a.m) > 10 * bytesOf(b.m),
      `P1 (${b.a0},${b.h}) ${b.da > 0 ? '+' : ''}${b.da}: fine cells ${cellsOf(a.m)} cells, ${(bytesOf(a.m) / 1024).toFixed(0)} KiB, ${a.ms.toFixed(0)} ms ` +
        `-> serpentine ${cellsOf(b.m)}, ${(bytesOf(b.m) / 1024).toFixed(0)} KiB, ${b.ms.toFixed(0)} ms`,
    );
  }
}

{
  console.log('-- the picture, in the CPU model of the morph draw');
  const bb = [-10, -80, 120, 240],
    TS = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  const score = (m, b, t) =>
    EMU.scoreExact(
      EMU.render(EMU.morphPacksAt(m, t), bb, 192).cov,
      shape(b.a0 + b.da * t, b.b0, b.h),
      bb,
      192,
      8,
    );
  for (const i of [0, 2, 1]) {
    const b = built[i];
    if (!b.m) {
      ok(false, `P1 (${b.a0},${b.h}) ${b.da}: not built`);
      continue;
    }
    let lost = 0,
      offS = 0,
      offF = 0,
      offStatic = 0;
    for (const t of TS) {
      const s = score(b.m, b, t);
      lost += s.lostIn;
      offS += s.off;
      if (b.fine && b.fine.m) offF += score(b.fine.m, b, t).off;
      const pose = shape(b.a0 + b.da * t, b.b0, b.h);
      offStatic += EMU.scoreExact(
        EMU.render(EMU.staticPacks(buildLbShape(pose, false, false).raw), bb, 192).cov,
        pose,
        bb,
        192,
        8,
      ).off;
    }
    const vsFine = b.fine && b.fine.m ? offS <= offF : true;
    ok(
      lost === 0 && vsFine,
      `P1 (${b.a0},${b.h}) ${b.da > 0 ? '+' : ''}${b.da} over t = ${TS.join(', ')}: ${offS} px off exact by >32/255 in all, ` +
        `${lost} lost inside` +
        (b.fine && b.fine.m ? `; the fine cells ${offF}` : '') +
        `; a static build of each pose ${offStatic}`,
    );
  }
}

{
  console.log('-- a point-symmetric destination (d1 = 0)');
  const CM = await import('../src/geom/lbCubicMath.js');
  const hasFn = typeof CM.cubicKLMNSerpentine === 'function';
  ok(hasFn, 'lbCubicMath exports cubicKLMNSerpentine');
  if (hasFn) {
    // Exact: the rows are one affine field over the control points, and k^3 - lm vanishes along the curve.
    const aff = (P, v) => {
      const [p0, p1, p2, p3] = P,
        det = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
      const w1 = ((p3[0] - p0[0]) * (p2[1] - p0[1]) - (p3[1] - p0[1]) * (p2[0] - p0[0])) / det;
      const w2 = ((p1[0] - p0[0]) * (p3[1] - p0[1]) - (p1[1] - p0[1]) * (p3[0] - p0[0])) / det;
      return (
        Math.abs((1 - w1 - w2) * v[0] + w1 * v[1] + w2 * v[2] - v[3]) / Math.max(...v.map(Math.abs))
      );
    };
    const Bz = (P, t) => {
      const u = 1 - t;
      return [0, 1].map(
        (i) =>
          u * u * u * P[0][i] +
          3 * u * u * t * P[1][i] +
          3 * u * t * t * P[2][i] +
          t * t * t * P[3][i],
      );
    };
    const f = (P, F, x, y) => {
      const [p0, p1, p2] = P,
        det = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
      const w1 = ((x - p0[0]) * (p2[1] - p0[1]) - (y - p0[1]) * (p2[0] - p0[0])) / det,
        w2 = ((p1[0] - p0[0]) * (y - p0[1]) - (p1[1] - p0[1]) * (x - p0[0])) / det;
      const e = (v) => (1 - w1 - w2) * v[0] + w1 * v[1] + w2 * v[2],
        K = e(F.k);
      return K * K * K - e(F.l) * e(F.m);
    };
    let worstAff = 0,
      worstOn = 0;
    for (const P of [
      [
        [0, 0],
        [60, 100],
        [40, -100],
        [100, 0],
      ],
      [
        [0, 0],
        [60, 60],
        [40, -60],
        [100, 0],
      ],
      [
        [0, 0],
        [59.999, 100],
        [40, -100],
        [100, 0],
      ],
    ]) {
      const F = CM.cubicKLMNSerpentine(P),
        ch = 100,
        h = 1e-4 * ch;
      if (!F) {
        worstAff = Infinity;
        continue;
      }
      for (const v of [F.k, F.l, F.m]) worstAff = Math.max(worstAff, aff(P, v));
      for (let i = 1; i < 32; i++) {
        const p = Bz(P, i / 32),
          g = Math.hypot(
            (f(P, F, p[0] + h, p[1]) - f(P, F, p[0] - h, p[1])) / (2 * h),
            (f(P, F, p[0], p[1] + h) - f(P, F, p[0], p[1] - h)) / (2 * h),
          );
        worstOn = Math.max(worstOn, Math.abs(f(P, F, p[0], p[1])) / (g * ch));
      }
    }
    ok(
      CM.cubicKLMN([
        [0, 0],
        [60, 100],
        [40, -100],
        [100, 0],
      ]) === null &&
        worstAff < 1e-13 &&
        worstOn < 1e-12,
      `cubicKLMN declines the point-symmetric S; its serpentine frame is affine-consistent to ${worstAff.toExponential(1)} and zero along the curve to ${worstOn.toExponential(1)} (d1 = 0, h 60, d1 = 6e-6)`,
    );
    let seed = 11,
      n = 0,
      same = 0;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
    for (let i = 0; i < 8000 && n < 1000; i++) {
      const P = [
        [0, 0],
        [rnd() * 200 - 50, rnd() * 200 - 100],
        [rnd() * 200 - 50, rnd() * 200 - 100],
        [100, rnd() * 40 - 20],
      ];
      const A = CM.cubicKLMN(P),
        Bf = CM.cubicKLMNSerpentine(P);
      if (!A || !Bf) continue;
      n++;
      let agree = true;
      for (let j = 0; j < 4; j++) {
        const x = rnd() * 150 - 25,
          y = rnd() * 150 - 75,
          fa = f(P, A, x, y),
          fb = f(P, Bf, x, y);
        if (Math.abs(fa) > 1e-9 && fa * fb <= 0) agree = false;
      }
      if (agree) same++;
    }
    ok(
      n >= 500 && same === n,
      `...with cubicKLMN's orientation wherever both answer (${same} of ${n} serpentines)`,
    );
  }
  for (const [a0, b0, h, da] of [
    [58, 60, 100, 2],
    [30, 60, 60, 30],
    [30, 60, 100, 30],
  ]) {
    const b = build(a0, b0, h, da, true);
    let pic = '';
    if (b.m && a0 === 58) {
      // ...and it draws: no ink lost inside, and off exact at no more pixels than a static build of each pose.
      const bb = [-10, -80, 120, 240];
      let off = 0,
        lost = 0,
        offS = 0;
      for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const pose = shape(a0 + da * t, b0, h);
        const sc = EMU.scoreExact(
          EMU.render(EMU.morphPacksAt(b.m, t), bb, 192).cov,
          pose,
          bb,
          192,
          8,
        );
        off += sc.off;
        lost += sc.lostIn;
        offS += EMU.scoreExact(
          EMU.render(EMU.staticPacks(buildLbShape(pose, false, false).raw), bb, 192).cov,
          pose,
          bb,
          192,
          8,
        ).off;
      }
      pic = `; over seven t ${off} px off exact (static ${offS}), ${lost} lost inside`;
      if (lost || off > offS) b.m = null;
    }
    ok(
      !!b.m && b.m.serpentine,
      `P1 (${a0},${h}) ${da > 0 ? '+' : ''}${da} -> P1.x 60, point-symmetric: ` +
        (b.m
          ? `${b.m.serpentine ? 'serpentine' : 'fine cells'}, ${cellsOf(b.m)} cell(s), ${(bytesOf(b.m) / 1024).toFixed(0)} KiB`
          : `not served (${b.why || 'picture'})`) +
        pic,
    );
  }
}

console.warn = warn;
console.log(fail ? `LB-SERPENTINE-PAIR FAIL (${fail})` : 'LB-SERPENTINE-PAIR PASS');
process.exit(fail ? 1 : 0);
