// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbCubicChainSmoke — an interior face beside a CONCAVE cubic piece carries the piece's ARC in its chain (
// and so does its morph face).
//
// NO POLYLINE IS exact. An interior face's analytic AA clips the pixel box against a five-point window onto the
// outline (chainBoxCov). A cubic piece contributing a -> m -> b, its on-curve midpoint between its ends, puts m on the
// AIR side of the arc on a CONCAVE piece, so every box straddling the arc reads the gap between chord and arc as ink:
// an S-curve, and lbMorphEvenOdd's inner ring, where the chords sit 22.5 degrees off the ring's extreme tangent and a
// pixel 0.813 covered would paint 1.000. Every inner polyline (tangent or control polygons) runs along hull edges the
// interior faces border and cuts fully inked pixels where the hull is thick. So the half-chords carry their
// piece (fill-left, by the piece's own ink probe), and a face whose chain runs along one takes the arc: chain 1 as one
// cubic and a straight neighbor (sentinel 4 or 5), chain 2 as one cubic (aSeamM 1). cubicChainBoxCov integrates it
// exactly: the clipped chords' shoelace plus the closed-form area between each clipped sub-arc and its chord,
// (3/20)(a x b + a x c + 2 b x c), with the border closed from each exit to the nearest entry in its fill direction.
import { readFileSync } from 'fs';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const BC = await import('../probes/lbAccuracy/_lbBoxCov.mjs');
const { default: importSvg } = await import('../src/svg/importer.js');
const R = await import('../probes/lbAccuracy/_lbRaster.mjs');
const REF = await import('../probes/lbAccuracy/_lbAaRef.mjs');
const K = await import('../probes/lbAccuracy/_lbKernel.mjs');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};
const src = (f) => readFileSync(new URL(`../src/shaders/${f}`, import.meta.url), 'utf8');

let seed = 20260922;
const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
const Rn = (a, b) => a + (b - a) * rnd();

/// A random chain through the pixel box: one cubic and one line, entering from x = -3 and leaving at x = +3, as the
/// builder's two modes lay them out -- or null unless it is the kind of chain the builder hands the kernel: an outline
/// piece is cut at its inflections and at turns past about 100 degrees, and a chain is a SIMPLE path (fill on the left
/// is a winding statement only for a path that does not cross itself). So the arc here turns one way, by less than
/// 150 degrees, and meets its line at less than 120.
function randomChain() {
  const lineFirst = rnd() < 0.5;
  const E0 = [-3, Rn(-1, 1)],
    E1 = [3, Rn(-1, 1)],
    M = [Rn(-0.8, 0.8), Rn(-1, 1)];
  const c1 = [Rn(-2.5, 2.5), Rn(-2, 2)],
    c2 = [Rn(-2.5, 2.5), Rn(-2, 2)];
  const P = lineFirst ? [E0, M, c1, c2, E1] : [E0, c1, c2, M, E1];
  const cub = lineFirst ? [M, c1, c2, E1] : [E0, c1, c2, M];
  const pl = [];
  if (lineFirst) pl.push(E0);
  for (let i = 0; i <= 2000; i++) pl.push(BC.cAtC(cub, i / 2000));
  if (!lineFirst) pl.push(E1);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  if (pl.some((p, i) => i > 0 && i < pl.length - 1 && Math.abs(p[0]) > 3)) return null;
  let turn = 0,
    sgn = 0,
    prev = null;
  for (let i = 0; i <= 64; i++) {
    const g = BC.cTanC(cub, i / 64);
    if (Math.hypot(g[0], g[1]) < 1e-9) return null;
    if (prev) {
      const a = Math.atan2(prev[0] * g[1] - prev[1] * g[0], prev[0] * g[0] + prev[1] * g[1]);
      if (Math.abs(a) > 1e-12) {
        if (sgn && Math.sign(a) !== sgn) return null;
        sgn = Math.sign(a);
      }
      turn += a;
    }
    prev = g;
  }
  if (Math.abs(turn) > (150 * Math.PI) / 180) return null;
  const lineDir = lineFirst ? [M[0] - E0[0], M[1] - E0[1]] : [E1[0] - M[0], E1[1] - M[1]];
  const tj = BC.cTanC(cub, lineFirst ? 0 : 1);
  const ja = Math.abs(
    Math.atan2(lineDir[0] * tj[1] - lineDir[1] * tj[0], lineDir[0] * tj[0] + lineDir[1] * tj[1]),
  );
  if (ja > (120 * Math.PI) / 180) return null;
  // Self-crossing, on a coarse resample (a crossing the fine one has, the coarse one has within its resolution).
  const co = pl.filter((_, i) => i % 20 === 0 || i === pl.length - 1);
  for (let i = 0; i + 1 < co.length; i++)
    for (let j = i + 2; j + 1 < co.length; j++)
      if (
        cr(co[i], co[i + 1], co[j]) * cr(co[i], co[i + 1], co[j + 1]) < 0 &&
        cr(co[j], co[j + 1], co[i]) * cr(co[j], co[j + 1], co[i + 1]) < 0
      )
        return null;
  return { P, lineFirst, pl };
}
/// area(box ∩ fill): the chain closed by a loop on its LEFT (+y, far above, unless `close` says otherwise), clipped to
/// the box (Sutherland-Hodgman against a convex window is exact for a simple polygon), shoelaced.
function refCov(
  pl,
  close = [
    [3, 50],
    [-3, 50],
  ],
) {
  let poly = pl.concat(close);
  for (const [ax, sgn] of [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
  ]) {
    const inside = (p) => sgn * p[ax] <= 0.5;
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i],
        b = poly[(i + 1) % poly.length],
        ia = inside(a),
        ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) {
        const t = (sgn * 0.5 - a[ax]) / (b[ax] - a[ax]);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    poly = out;
    if (!poly.length) return 0;
  }
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - a[1] * b[0];
  }
  return Math.abs(s) / 2;
}

const haveKernel = typeof BC.cubicChainBoxCov === 'function' && typeof BC.cAtC === 'function';
ok(haveKernel, 'the CPU twin exports cubicChainBoxCov and its cubic helpers');
if (haveKernel) {
  console.log("-- the kernel is the exact area of the box on the arc's fill side");
  let n = 0,
    part = 0,
    worst = 0;
  for (let it = 0; it < 20000 && n < 400; it++) {
    const ch = randomChain();
    if (!ch) continue;
    const ref = refCov(ch.pl);
    // A chain that misses the box: the interior face's own verdict (forceInside), not the arc's -- not what this asks.
    const hits = ch.pl.some((p) => Math.abs(p[0]) <= 0.5 && Math.abs(p[1]) <= 0.5);
    if (!hits) continue;
    const got = BC.cubicChainBoxCov(ch.P[0], ch.P[1], ch.P[2], ch.P[3], ch.P[4], ch.lineFirst, 1.0);
    worst = Math.max(worst, Math.abs(got - ref));
    n++;
    if (ref > 0.01 && ref < 0.99) part++;
  }
  ok(
    n >= 300 && part > 200 && worst < 2e-4,
    `${n} chains through the box (${part} partial): worst |kernel - exact| ${worst.toExponential(2)}`,
  );
  // AN ARC THAT CROSSES THE BOX TWICE, so its pieces meet the border out of chain order and each exit must close to the
  // entry nearest it in its fill direction: a U whose two arms pass through the box, then a line away.
  let nU = 0,
    worstU = 0,
    multiU = 0;
  for (let it = 0; it < 200; it++) {
    const u0 = Rn(0.05, 0.45),
      u1 = Rn(0.05, 0.45),
      h = Rn(0.6, 4),
      top = 3;
    const cub = [
      [-u0, top],
      [-u0 - Rn(0, 0.3), -h],
      [u1 + Rn(0, 0.3), -h],
      [u1, top],
    ];
    const pl = [];
    for (let i = 0; i <= 2000; i++) pl.push(BC.cAtC(cub, i / 2000));
    pl.push([3, top]);
    const ref = refCov(pl);
    const got = BC.cubicChainBoxCov(cub[0], cub[1], cub[2], cub[3], [3, top], false, 1.0);
    worstU = Math.max(worstU, Math.abs(got - ref));
    nU++;
    let crossings = 0;
    for (let i = 0; i + 1 < pl.length; i++) {
      const a = Math.abs(pl[i][0]) <= 0.5 && Math.abs(pl[i][1]) <= 0.5,
        b = Math.abs(pl[i + 1][0]) <= 0.5 && Math.abs(pl[i + 1][1]) <= 0.5;
      if (a !== b) crossings++;
    }
    if (crossings >= 4) multiU++;
  }
  ok(
    multiU > 100 && worstU < 2e-4,
    `${nU} U-shaped arcs, ${multiU} crossing the box twice: worst |kernel - exact| ${worstU.toExponential(2)}`,
  );
}

{
  console.log("-- the shader's float32 text computes what the twin does");
  const E = await import('./_glslEmu.mjs');
  if (!E.hasCxx()) console.log('  SKIP no C++ compiler for the float32 emulator');
  else if (!haveKernel || typeof E.K_CUBIC_CHAIN_COV !== 'number')
    ok(false, 'the float32 emulator lifts cubicChainBoxCov (K_CUBIC_CHAIN_COV)');
  else {
    const emu = E.buildGlslEmu(new URL('..', import.meta.url).pathname, { cubicChainCov: true });
    const Q = [],
      T = [];
    for (let i = 0; i < 4000; i++) {
      const lf = rnd() < 0.5,
        sc = Math.exp(Rn(-1, 4));
      const E0 = [-3 * sc, Rn(-1, 1)],
        E1 = [3 * sc, Rn(-1, 1)],
        M = [Rn(-0.8, 0.8), Rn(-1, 1)];
      const c1 = [Rn(-2.5, 2.5) * sc, Rn(-2, 2)],
        c2 = [Rn(-2.5, 2.5) * sc, Rn(-2, 2)];
      const P = (lf ? [E0, M, c1, c2, E1] : [E0, c1, c2, M, E1]).map((p) => [
        Math.fround(p[0]),
        Math.fround(p[1]),
      ]);
      const fi = rnd() < 0.5 ? 2.0 : 1.0;
      Q.push({
        k: E.K_CUBIC_CHAIN_COV,
        bb: [P[0][0], P[0][1], P[1][0], P[1][1]],
        c: P[2],
        ePx: P[3],
        ex: [P[4][0], P[4][1], lf ? 1 : 0, fi],
      });
      T.push(BC.cubicChainBoxCov(P[0], P[1], P[2], P[3], P[4], lf, fi));
    }
    const out = emu.run(new Float32Array(4), new Float32Array(4), Q);
    let worst = 0;
    for (let i = 0; i < Q.length; i++) worst = Math.max(worst, Math.abs(out[i] - T[i]));
    ok(
      worst < 1 / 1024,
      `the assembled shader's cubicChainBoxCov, in float32, against the twin over ${Q.length} chains up to 55x the box: worst ${worst.toExponential(2)}`,
    );
  }
  const lc = src('_lbCoverage.glsl');
  ok(
    /#ifndef MANTLE_LB_NO_CUBIC_CHAIN[\s\S]*float cubicChainBoxCov\(/.test(lc) &&
      /if \(vTC\.x > 3\.5\) cov = cubicChainBoxCov\(c0, c1, c2, c3, c4, vTC\.x > 4\.5, 2\.0\)/.test(
        lc,
      ) &&
      /vSeam > 0\.5 \? cubicChainBoxCov\(d0, d1, d2, d3, d3, false, 1\.0\)/.test(lc),
    "_lbCoverage.glsl reads chain 1's sentinels 4 / 5 and chain 2's cubic flag through cubicChainBoxCov",
  );
  const fp = readFileSync(new URL('../src/renderer/fillPass.js', import.meta.url), 'utf8');
  ok(
    /MANTLE_LB_NO_CUBIC_CHAIN/.test(fp),
    'fillPass drops the kernel from a program whose meshes carry no cubic chain',
  );
}

{
  // ROBUST IN FLOAT32, AND NO ARRAYS. Closed-form roots divide the cubic by its t^3 coefficient, which a
  // degree-elevated quadratic has zero and a control point on its end leaves small against the rest: the depressed
  // cubic's float32 digits are gone and the shader returns the box's complement. So the kernel cuts the arc at its x and
  // y extrema and brackets each crossing, and streams two sums instead of clipping into arrays.
  console.log(
    '-- float32: an arc whose t^3 term is small against the rest, and a chain that ends on the border',
  );
  const E = await import('./_glslEmu.mjs');
  // The chain continued along its end tangents where an end is in the box, and away from the box where it is not, closed
  // far on its left, clipped to the box: the kernel's model, exactly.
  const extendedCov = (P, lf) => {
    const cub = lf ? P.slice(1) : P.slice(0, 4),
      L = lf ? [P[0], P[1]] : [P[3], P[4]];
    const pl = [];
    if (lf) pl.push(L[0]);
    for (let i = 0; i <= 4000; i++) pl.push(BC.cAtC(cub, i / 4000));
    if (!lf) pl.push(L[1]);
    const inB = (q) => Math.abs(q[0]) <= 0.5 && Math.abs(q[1]) <= 0.5,
      un = (a) => {
        const l = Math.hypot(a[0], a[1]);
        return [a[0] / l, a[1] / l];
      };
    let k0 = 1;
    while (Math.hypot(pl[k0][0] - pl[0][0], pl[k0][1] - pl[0][1]) < 1e-9) k0++;
    let k1 = pl.length - 2;
    while (Math.hypot(pl.at(-1)[0] - pl[k1][0], pl.at(-1)[1] - pl[k1][1]) < 1e-9) k1--;
    const s0 = pl[0],
      s1 = pl.at(-1);
    const t0 = inB(s0) ? un([pl[k0][0] - s0[0], pl[k0][1] - s0[1]]) : un([-s0[0], -s0[1]]);
    const t1 = inB(s1) ? un([s1[0] - pl[k1][0], s1[1] - pl[k1][1]]) : un(s1);
    const R = 1e4,
      E0 = [s0[0] - t0[0] * R, s0[1] - t0[1] * R],
      E1 = [s1[0] + t1[0] * R, s1[1] + t1[1] * R];
    const poly = [E0, ...pl, E1];
    let a1 = Math.atan2(E1[1], E1[0]),
      a0 = Math.atan2(E0[1], E0[0]);
    while (a0 <= a1) a0 += 2 * Math.PI;
    for (let k = 1; k < 64; k++) {
      const a = a1 + ((a0 - a1) * k) / 64;
      poly.push([2 * R * Math.cos(a), 2 * R * Math.sin(a)]);
    }
    return Math.min(1, Math.max(0, refCov(poly, [])));
  };
  // Tiger's two cells (arc rings, 512 px) where the shader returned the complement, then elevated quadratics and arcs with
  // a control point on an end, from inside the box to 3000x it.
  const cases = [
    {
      P: [
        [0.021536458283662796, 1.559861183166504],
        [0.42331597208976746, 0.30428820848464966],
        [0.6242100596427917, -0.901059],
        [0.6242100596427917, -0.901059],
        [0.6242100596427917, -0.901059],
      ],
      lf: false,
      fi: 0,
    },
    {
      P: [
        [-29.043, 6.819],
        [-21.51, 4.084],
        [-11.312, 1.636],
        [2.491, -0.032],
        [2.491, -0.032],
      ],
      lf: false,
      fi: 0,
    },
  ];
  for (let i = 0; i < 6000; i++) {
    const sc = Math.exp(Rn(-1.5, Math.log(i % 3 === 0 ? 3000 : 8))),
      cen = [Rn(-1.2, 1.2), Rn(-1.2, 1.2)];
    const A = [cen[0] + Rn(-1, 1) * sc, cen[1] + Rn(-1, 1) * sc],
      Bq = [cen[0] + Rn(-1, 1) * sc, cen[1] + Rn(-1, 1) * sc],
      Qc = [cen[0] + Rn(-1, 1) * sc, cen[1] + Rn(-1, 1) * sc];
    const kind = i % 3;
    const C1 =
      kind === 2 ? A.slice() : [A[0] + ((Qc[0] - A[0]) * 2) / 3, A[1] + ((Qc[1] - A[1]) * 2) / 3];
    const C2 =
      kind === 1
        ? Bq.slice()
        : [Bq[0] + ((Qc[0] - Bq[0]) * 2) / 3, Bq[1] + ((Qc[1] - Bq[1]) * 2) / 3];
    const cub = [A, C1, C2, Bq],
      fi = [0, 1, 2][i % 3],
      m = rnd();
    const P =
      m < 0.4
        ? [...cub, Bq]
        : m < 0.7
          ? [...cub, [Bq[0] + Rn(-2, 2), Bq[1] + Rn(-2, 2)]]
          : [[A[0] + Rn(-2, 2), A[1] + Rn(-2, 2)], ...cub];
    cases.push({ P: P.map((p) => [Math.fround(p[0]), Math.fround(p[1])]), lf: m >= 0.7, fi });
  }
  if (!E.hasCxx()) console.log('  SKIP no C++ compiler for the float32 emulator');
  else {
    const emu = E.buildGlslEmu(new URL('..', import.meta.url).pathname, { cubicChainCov: true });
    const Q = cases.map(({ P, lf, fi }) => ({
      k: E.K_CUBIC_CHAIN_COV,
      bb: [P[0][0], P[0][1], P[1][0], P[1][1]],
      c: P[2],
      ePx: P[3],
      ex: [P[4][0], P[4][1], lf ? 1 : 0, fi],
    }));
    const out = emu.run(new Float32Array(4), new Float32Array(4), Q);
    let worst = 0,
      off = 0,
      cells = 0;
    cases.forEach(({ P, lf, fi }, i) => {
      const d = Math.abs(out[i] - BC.cubicChainBoxCov(...P, lf, fi));
      worst = Math.max(worst, d);
      if (d > 1 / 255) off++;
      if (i < 2) cells = Math.max(cells, d);
    });
    ok(
      cells < 1 / 1024 && off === 0 && worst < 1 / 1024,
      `the shader's float32 kernel against the twin: tiger's two cells within ${cells.toExponential(2)}, ${cases.length - 2} arcs with a small t^3 term ${off} off by > 1/255 (worst ${worst.toExponential(2)})`,
    );
  }
  // A CHAIN THAT ENDS exactly ON THE BORDER, as pixel-aligned geometry puts one: its tangent still crosses the box.
  const edge = [
    {
      P: [
        [-1.5, -1.5],
        [-1.5, -1.5],
        [-0.5, -1.5],
        [-0.5, 2],
        [0, 0.5],
      ],
      lf: false,
    },
    {
      P: [
        [0.5, 0],
        [0.5, 0],
        [1, -0.5],
        [1, -0.5],
        [1, -0.5],
      ],
      lf: false,
    },
    {
      P: [
        [-0.5, -0.25],
        [-0.75, -0.25],
        [-0.75, -0.5],
        [-0.75, -0.5],
        [-0.75, -0.5],
      ],
      lf: false,
    },
    {
      P: [
        [-1, 0.5],
        [-1.75, 2.25],
        [-2.25, 2],
        [-2.25, 1.25],
        [0.25, 0.5],
      ],
      lf: true,
    },
  ];
  let worstE = 0;
  for (const { P, lf } of edge)
    worstE = Math.max(worstE, Math.abs(BC.cubicChainBoxCov(...P, lf, 1.0) - extendedCov(P, lf)));
  ok(
    worstE < 1e-3,
    `${edge.length} chains with an end or a crossing exactly on the border: worst |kernel - exact| ${worstE.toExponential(2)}`,
  );
  const lc = src('_lbCoverage.glsl');
  const body = lc.slice(
    lc.indexOf('float cubicChainBoxCov('),
    lc.indexOf('#endif  // MANTLE_LB_NO_CUBIC_CHAIN'),
  );
  ok(
    !/\w+\s+\w+\s*\[\s*\d+\s*\]/.test(body) && !/cubicRootsC|acos|pow\(/.test(body),
    'the kernel keeps no arrays and takes no closed-form roots (cbrt, acos)',
  );
  const face = lc.slice(
    lc.indexOf('if (vTC.x > 1.5) {'),
    lc.indexOf('#ifndef MANTLE_NO_BEZOUT', lc.indexOf('if (vTC.x > 1.5) {')),
  );
  ok(
    /float cov;\s*#ifndef MANTLE_LB_NO_CUBIC_CHAIN\s*if \(vTC\.x > 3\.5\) cov = cubicChainBoxCov\([^;]*;\s*else\s*#endif/.test(
      face,
    ),
    'an interior cubic face runs the cubic kernel alone, not the straight one first',
  );
}

// The S-curve: a convex bump, then a concave dip -- the dip's interior faces read its air-side chords.
const SCURVE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 384"><path d="M40 300 C80 230 160 380 200 300 S300 240 340 330 L340 370 L40 370 Z" fill="#000"/></svg>';
async function auditOne(svgText, N, on) {
  // The straight-chord arm is the TEST HOOK __LB_CUBIC_CHAIN = false, read only under __MANTLE_DEBUG__.
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__LB_CUBIC_CHAIN = on;
  const bundle = await importSvg(svgText, { preserveViewport: true });
  const { shapes, bbox } = await R.shapesOf(bundle);
  const view = R.viewOf(bbox, N);
  const { rowSpans, contoursToConverter, closed } = await REF.refKit();
  let over32 = 0,
    lost32 = 0,
    err = 0,
    faces = 0,
    cubicFaces = 0,
    flag = false;
  for (const sh of shapes) {
    const b = await R.buildMesh(sh);
    if (!b) continue;
    flag = flag || !!b.pk.hasCubicChain;
    const v = b.pk.verts,
      nv = b.pk.vertexCount;
    for (let t = 0; t + 2 < nv; t += 3) {
      const a = K.decodeVert(v, t + 2);
      if (a.kind !== 0 || !(a.tc[0] > 1.5)) continue;
      faces++;
      if (a.tc[0] > 3.5 || a.seam > 0.5) cubicFaces++;
    }
    const acc = new Float64Array(N * N).fill(1);
    R.rasterMesh(
      b.pk,
      view,
      acc,
      {},
      new Int32Array(N * N),
      new Int32Array(N * N).fill(-1),
      new Float64Array(N * N),
    );
    const curves = closed(contoursToConverter(sh.contours, null));
    for (let j = 0; j < N; j++) {
      const rc = new Map();
      for (let i = 0; i < N; i++) {
        const ex = REF.exactCov(rowSpans, curves, i, j, view, 64, sh.evenOdd, rc),
          mo = 1 - acc[j * N + i],
          d = mo - ex;
        err += Math.abs(d);
        if (d > 32 / 255) over32++;
        if (d < -32 / 255) lost32++;
      }
    }
  }
  delete globalThis.__LB_CUBIC_CHAIN;
  delete globalThis.__MANTLE_DEBUG__;
  return { over32, lost32, err, faces, cubicFaces, flag };
}

{
  // THE SLOWEST LANE. A GPU runs a SIMD group in lockstep, so a lane that does the exact work sets
  // the pace for its neighbours that do not: the crossings take Halley's step (the cubic's second derivative costs two
  // operations, and fewer evaluations a solve), a chain end's continuation direction is worked out only where a
  // chain ends in the box, and a crossing's second coordinate is the one the slab test already evaluated. Checked through
  // the whole-pipeline emulator's operation count: the shipped text against it with Newton's step and the directions
  // taken up front, on the S-curve, fragment for fragment.
  console.log('-- the exact work, per lane: the same answers for fewer operations');
  const P = await import('./_lbPipeEmu.mjs');
  if (!P.hasLbPipeEmu()) console.log('  SKIP no C++ compiler / clang for the pipeline emulator');
  else {
    const { lbScene, renderScene } = await import('./_lbPipeScene.mjs');
    const vt = readFileSync(
      new URL('../src/shaders/generated/mantle.vert.glsl', import.meta.url),
      'utf8',
    );
    const ft = readFileSync(
      new URL('../src/shaders/generated/mantle.frag.glsl', import.meta.url),
      'utf8',
    );
    const newton = ft.replace(
      /    float d = cbEvalD\(co, t\), dd = 6\.0 \* co\.x \* t \+ 2\.0 \* co\.y;\n    float den = 2\.0 \* d \* d - ft \* dd;\n    float tn = den != 0\.0 \? t - 2\.0 \* ft \* d \/ den : -1\.0;/,
      '    float d = cbEvalD(co, t);\n    float tn = d != 0.0 ? t - ft / d : -1.0;',
    );
    ok(newton !== ft, "cbSolve takes Halley's step (the text the comparison swaps is there)");
    const sc = await lbScene(SCURVE, { N: 384 });
    const A = renderScene(sc, vt, ft, [], { alu: true }),
      B = renderScene(sc, vt, newton, [], { alu: true });
    const n = A.recs.length / 9,
      eq = (f) => (f % 65536) + 4 * Math.floor(f / 65536);
    let worst = 0,
      sameDisc = true,
      costA = 0,
      costB = 0,
      heavy = 0;
    for (let q = 0; q < n; q++) {
      if ((A.recs[q * 9 + 7] === 1) !== (B.recs[q * 9 + 7] === 1)) sameDisc = false;
      else if (A.recs[q * 9 + 7] !== 1)
        worst = Math.max(worst, Math.abs(A.recs[q * 9 + 6] - B.recs[q * 9 + 6]));
      const a = eq(A.recs[q * 9 + 8]),
        b = eq(B.recs[q * 9 + 8]);
      if (b > a + 20 || a > b + 20) {
        heavy++;
        costA += a;
        costB += b;
      }
    }
    ok(
      sameDisc && worst * 255 <= 1,
      `the two texts agree on all ${n} fragments (worst ${(worst * 255).toFixed(3)}/255)`,
    );
    ok(
      heavy > 50 && costA < costB,
      `the ${heavy} fragments whose work differs: ${(costB / Math.max(heavy, 1)).toFixed(1)} -> ${(costA / Math.max(heavy, 1)).toFixed(1)} operations each`,
    );
    const lc = src('_lbCoverage.glsl');
    const kb = lc.slice(
      lc.indexOf('float cubicChainBoxCov('),
      lc.indexOf('#endif  // MANTLE_LB_NO_CUBIC_CHAIN'),
    );
    ok(
      !/vec2 gS = |vec2 gE = /.test(kb) && /cbDirEnd\(A, C1, C2, B\)/.test(kb),
      "a chain end's direction is asked for only where a chain ends in the box",
    );
  }
}

{
  console.log("-- the S-curve: the concave dip's interior faces follow the arc");
  const a = await auditOne(SCURVE, 384, false),
    b = await auditOne(SCURVE, 384, true);
  // (The pack's flag is not asked of the straight-chord arm: a Bezout ring that carries its arc needs the same kernel.)
  ok(
    a.cubicFaces === 0 && b.flag && b.cubicFaces > 0,
    `${b.cubicFaces} of ${b.faces} chain faces carry a cubic (${a.cubicFaces} with the straight chords), and the pack says so`,
  );
  ok(
    b.over32 < a.over32 && b.lost32 <= a.lost32 && b.err < a.err,
    `pixels over exact by > 32/255 ${a.over32} -> ${b.over32}, under ${a.lost32} -> ${b.lost32}; error ${a.err.toFixed(2)} -> ${b.err.toFixed(2)} px^2`,
  );
}

{
  console.log("-- lbMorphEvenOdd's inner ring, drawn as a morph");
  const EMU = await import('./_lbMorphDrawEmu.mjs');
  const { parseMetaBin } = await import('../src/core/metaBin.js');
  const { curveRangeToContours, rayWinding } = await import('../src/geom/lbContour.js');
  const { buildMorphBundle } = await import('../src/renderer/lbMorphCore.js');
  const S = readFileSync(
    new URL('../examples/smoke/lbMorphEvenOdd__SRC.svg', import.meta.url),
    'utf8',
  );
  const D = readFileSync(
    new URL('../examples/smoke/lbMorphEvenOdd__DST.svg', import.meta.url),
    'utf8',
  );
  const A = await importSvg(S, { preserveViewport: true }),
    B = await importSvg(D, { preserveViewport: true });
  const pa = parseMetaBin(A.meta, A.metaFloatsPerShape),
    pb = parseMetaBin(B.meta, B.metaFloatsPerShape);
  const input = {
    srcCurve: new Float32Array(A.curves),
    dstCurve: new Float32Array(B.curves),
    srcMeta: pa.metaFloats,
    dstMeta: pb.metaFloats,
    metaStride: pa.floatsPerShape,
    ranges: A.curveRangesByShape,
    numShapes: A.numShapes,
    bb: A.globalBBox,
  };
  const sc = curveRangeToContours(
    input.srcCurve,
    A.curveRangesByShape[0].begin,
    A.curveRangesByShape[0].end,
  );
  const dc = curveRangeToContours(
    input.dstCurve,
    B.curveRangesByShape[0].begin,
    B.curveRangesByShape[0].end,
  );
  const N = 512,
    bb = Array.from(A.globalBBox),
    e = bb[2] / N,
    SS = 16,
    TS = [0.03, 0.04, 0.09, 0.25, 1];
  const overAt = (mesh, t) => {
    const segs = sc
      .map((c, ci) =>
        c.map((g, si) => {
          const d = dc[ci][si],
            lp = (p, q) => p && [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
          return {
            type: g.type,
            p1: lp(g.p1, d.p1),
            p2: lp(g.p2, d.p2),
            p3: lp(g.p3, d.p3),
            p4: lp(g.p4, d.p4),
          };
        }),
      )
      .flat();
    const inside = (x, y) => (rayWinding(segs, bb[0] + x * e, bb[1] + y * e) & 1) !== 0;
    const cov = EMU.render(EMU.morphPacksAt(mesh, t), bb, N).cov;
    let over = 0,
      under = 0;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const v = Math.max(0, cov[y * N + x]),
          c = inside(x + 0.5, y + 0.5);
        if (
          (v === 0 || v === 1) &&
          (v === 1) === c &&
          [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ].every(([a, b]) => inside(x + a, y + b) === c)
        )
          continue;
        let n = 0;
        for (let a = 0; a < SS; a++)
          for (let b = 0; b < SS; b++) if (inside(x + (a + 0.5) / SS, y + (b + 0.5) / SS)) n++;
        const d = Math.round((v - n / SS / SS) * 255);
        if (d > 32) over++;
        if (d < -32 && c) under++;
      }
    return { over, under };
  };
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__LB_CUBIC_CHAIN = false;
  const before = buildMorphBundle(input).meshes[0];
  delete globalThis.__LB_CUBIC_CHAIN;
  delete globalThis.__MANTLE_DEBUG__;
  const after = buildMorphBundle(input).meshes[0];
  const rb = TS.map((t) => overAt(before, t)),
    ra = TS.map((t) => overAt(after, t));
  ok(
    rb.some((r) => r.over > 0) &&
      ra.every((r) => r.over === 0) &&
      ra.every((r, i) => r.under <= rb[i].under),
    `over exact by > 32 levels at t = ${TS.join(' / ')}: ${rb.map((r) => r.over).join(' / ')} -> ${ra.map((r) => r.over).join(' / ')}` +
      ` (lost inside ${rb.map((r) => r.under).join(' / ')} -> ${ra.map((r) => r.under).join(' / ')})`,
  );
}

console.warn = warn;
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
