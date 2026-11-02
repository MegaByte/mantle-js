// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeCubicScaleSmoke — a stroked cubic's closest point, and so its coverage, is the same at every drawing size
// (the rule that a result is correct at any scale).
//
// THE HAZARD. The band walk finds a cubic's closest point with the descending chain (_strokeMath.glsl
// cubicClosestDescend): f = P.P' is a quintic whose coefficients are PRODUCTS of two cubic coefficients, and the
// level-3 discriminant and every bracket's sign test multiply two of those -- fourth powers of the curve's size in em.
// A 170 px loop drawn at 2^20 em per pixel has cubic coefficients near 4e8: unscaled, (24 c4)^2 passes float32's
// 3.4e38, the brackets' products are infinite, the chain finds no root and the closest point falls to an end, so
// pixels in the middle of the stroke read EMPTY.
//
// The chain scales the curve by a POWER OF TWO first, which brings its largest shape coefficient into [1, 2). A
// power of two is exact in float32, so every sum, product and comparison scales with it: the roots are bit for bit
// those of the unscaled arithmetic wherever that did not overflow, and the same at every scale.
//
// (a) THE KERNEL: the shipped cubicClosestDescend (test/_glslEmu.mjs K_CUBIC_DESCEND) on loops, cusps and plain
//     curves 1 to 400 units across, each query's coefficients scaled by 2^-20, 2^20 and 2^40 -- a parameter is
//     dimensionless, so it must be BIT FOR BIT the scale-1 one;
// (b) END TO END: the main pass's coverage (test/_strokeMainCov.mjs mainCov: the shipped walk and main()'s choice, in
//     float32) of three seeded stroked loops, at every pixel within the stroke's reach, at 2^-20 and 2^20 against
//     scale 1.
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import * as EMU from './_glslEmu.mjs';
import { strokeRowsOf, mainCov, hasExact } from './_strokeMainCov.mjs';
import { makeCubicCases, evalC, cubicCoeff } from './_strokeCubicArcRef.mjs';
import { JOINS } from './_strokeShapeRef.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!EMU.hasCxx()) {
  console.log('  SKIPPED: no C++ compiler ($CXX, clang++, g++, c++) for the kernel emulation');
  process.exit(0);
}
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const f32 = new Float32Array(1),
  u32 = new Uint32Array(f32.buffer);
const bits = (v) => {
  f32[0] = v;
  return u32[0];
};

// ---- (a) the kernel ---------------------------------------------------------------------------------------------------
{
  const emu = EMU.buildGlslEmu(ROOT, { cubicSolve: true, glsl: GLSL });
  let seed = 0x5ca1e;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const FAMILIES = {
    loop: (L) => [
      [0, 0],
      [L, 0.77 * L],
      [-L, 0.77 * L],
      [0, 1e-4 * L],
    ],
    cusp: (L) => [
      [0, 0],
      [1.6 * L, 0],
      [-0.7 * L, 0],
      [0.9 * L, 0.05 * L],
    ],
    plain: (L) => [
      [0, 0],
      [0.5 * L * rnd(), L * rnd()],
      [0.5 * L + 0.5 * L * rnd(), L * rnd()],
      [L, 0.15 * L * rnd()],
    ],
  };
  // query-relative coefficients, in float32 as the walk has them: scaling them by a power of two is then exact
  const coeff = (P, q) => {
    const c = (i) =>
      cubicCoeff(
        Math.fround(P[0][i] - q[i]),
        Math.fround(P[1][i] - q[i]),
        Math.fround(P[2][i] - q[i]),
        Math.fround(P[3][i] - q[i]),
      );
    return [c(0).map(Math.fround), c(1).map(Math.fround)];
  };
  const SCALES = [1, 2 ** -20, 2 ** 20, 2 ** 40];
  const qs = [],
    meta = [];
  for (const [fam, gen] of Object.entries(FAMILIES))
    for (let c = 0; c < 24; c++) {
      const L = 2 ** (rnd() * 8.6),
        P = gen(L);
      for (let s = 0; s < 12; s++) {
        const q = [L * (-0.3 + 1.6 * rnd()), L * (-0.3 + 1.2 * rnd())];
        const [cx, cy] = coeff(P, q);
        for (const S of SCALES)
          qs.push({ k: EMU.K_CUBIC_DESCEND, bb: cx.map((v) => v * S), ex: cy.map((v) => v * S) });
        meta.push({ fam, L });
      }
    }
  const got = emu.run(new Float32Array(4), new Float32Array(4), qs);
  const bad = { loop: 0, cusp: 0, plain: 0 },
    n = { loop: 0, cusp: 0, plain: 0 };
  let worst = 0,
    at = '';
  meta.forEach((m, i) => {
    const t1 = got[i * SCALES.length];
    n[m.fam]++;
    let diff = false;
    for (let k = 1; k < SCALES.length; k++) {
      const tk = got[i * SCALES.length + k];
      if (bits(tk) !== bits(t1)) {
        diff = true;
        const [cx, cy] = [qs[i * SCALES.length].bb, qs[i * SCALES.length].ex];
        const d = (t) => Math.hypot(evalC(cx, t), evalC(cy, t));
        const ex = (d(tk) - d(t1)) / m.L;
        if (Math.abs(ex) > Math.abs(worst)) {
          worst = ex;
          at = `${m.fam} ${m.L.toFixed(1)} units at 2^${Math.log2(SCALES[k])}: t ${tk} for ${t1}`;
        }
      }
    }
    if (diff) bad[m.fam]++;
  });
  for (const fam of Object.keys(bad)) {
    ok(
      bad[fam] === 0,
      `(a) ${fam}: the closest parameter is bit for bit the scale-1 one at 2^-20, 2^20 and 2^40 on ${bad[fam] === 0 ? 'all' : n[fam] - bad[fam] + ' of'} ${n[fam]} queries`,
    );
  }
  if (at)
    console.log(
      `      worst: the found point ${(worst * 100).toFixed(1)}% of the curve's size farther (${at})`,
    );
}

// ---- (b) end to end ---------------------------------------------------------------------------------------------------
{
  if (typeof globalThis.DOMParser === 'undefined') {
    const x = await import('@xmldom/xmldom');
    globalThis.DOMParser = x.DOMParser;
    globalThis.XMLSerializer = x.XMLSerializer;
  }
  const { default: importSvg } = await import('../src/svg/importer.js');
  const emu = EMU.buildGlslEmu(ROOT, { stroke: true, glsl: GLSL });
  const EXACT = hasExact(GLSL),
    CAPS = ['butt', 'round', 'square'],
    f = (v) => +v.toPrecision(9);
  const cases = makeCubicCases(0x3d19, 240);
  for (const ci of [0, 6, 12]) {
    // three seeded LOOPS
    const cs = cases[ci];
    const d =
      `M ${f(cs.Cs[0][0][0])} ${f(cs.Cs[0][0][1])}` +
      cs.Cs.map(
        ([, h1, h2, e]) =>
          ` C ${f(h1[0])} ${f(h1[1])} ${f(h2[0])} ${f(h2[1])} ${f(e[0])} ${f(e[1])}`,
      ).join('');
    // the centerline, densely sampled, for the pixels within the stroke's reach (a miter's tip included)
    const pts = [];
    for (const [p0, p1, p2, p3] of cs.Cs) {
      const kx = cubicCoeff(p0[0], p1[0], p2[0], p3[0]),
        ky = cubicCoeff(p0[1], p1[1], p2[1], p3[1]);
      for (let k = 0; k <= 400; k++) pts.push([evalC(kx, k / 400), evalC(ky, k / 400)]);
    }
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
    const reach = cs.halfW * Math.max(cs.miterLimit, 1.5) + 2;
    const T = [Math.ceil(reach - x0) + 0.25, Math.ceil(reach - y0) + 0.375];
    const W = Math.ceil(x1 - x0 + 2 * reach) + 2,
      H = Math.ceil(y1 - y0 + 2 * reach) + 2;
    const pix = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const c = [x + 0.5 - T[0], y + 0.5 - T[1]];
        if (pts.some((p) => Math.hypot(c[0] - p[0], c[1] - p[1]) < reach)) pix.push([x, y]);
      }
    const covAt = async (S) => {
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W * S}" height="${H * S}" viewBox="0 0 ${W * S} ${H * S}">` +
        `<g transform="scale(${S}) translate(${T[0]} ${T[1]})"><path d="${d}" fill="none" stroke="#000" stroke-width="${2 * cs.halfW}"` +
        ` stroke-linecap="${CAPS[cs.cap]}" stroke-linejoin="${JOINS[cs.joinStyle]}" stroke-miterlimit="${cs.miterLimit}"/></g></svg>`;
      const B = strokeRowsOf(await importSvg(svg, { preserveViewport: true }));
      return mainCov(emu, B, B.rows[0], pix, S, EXACT);
    };
    const c1 = await covAt(1);
    for (const S of [2 ** -20, 2 ** 20]) {
      const cS = await covAt(S);
      let n = 0,
        worst = 0,
        at = '';
      pix.forEach(([x, y], k) => {
        const e = Math.abs(cS[k] - c1[k]);
        if (e > 1 / 255) n++;
        if (e > worst) {
          worst = e;
          at = ` at (${x},${y}) ${(cS[k] * 255).toFixed(1)} for ${(c1[k] * 255).toFixed(1)}`;
        }
      });
      ok(
        n === 0,
        `(b) seeded loop #${ci} (${JOINS[cs.joinStyle]} joins, ${CAPS[cs.cap]} caps, half-width ${cs.halfW}) at 2^${Math.log2(S)}: ${n} of ${pix.length} pixels differ from scale 1 by over 1/255 (worst ${(worst * 255).toFixed(2)}/255${at})`,
      );
    }
  }
}
if (fail) {
  console.error(`strokeCubicScaleSmoke: ${fail} FAILED`);
  process.exit(1);
}
console.log('strokeCubicScaleSmoke: PASS');
