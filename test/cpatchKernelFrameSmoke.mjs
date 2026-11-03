// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchKernelFrameSmoke — the CPatch kernel draws a contour far from the origin as it draws it at the
// origin.
//
// THE TRAP. The kernel evaluates in float32, and in WORLD em coordinates the fragment's position and every
// affine functional's constant are numbers the size of the contour's distance from the origin. At y = 1e5 the
// position is quantized to 1/128 of a unit and the functionals cancel terms that size, so a pixel whose center
// lies within a hundredth of a pixel of a hard hull plane or a cut reads the other side: noAaArcRow__FAR draws 6
// pixels off by half at y = 1e5 and none with the same patches moved exactly to the origin (the converter makes
// the patches the same; the frame makes the drawing the same).
//
// THE RULE. The packer packs each contour's texels relative to O, the corner of its control-point box in
// float32, and puts O in every cover vertex's aC2.zw; the vertex stage hands the fragment em - O (exact:
// both float32 and close), and the fragment adds O back for paint and clips.
//
// WHAT this PINS, through the float32 kernel twin (test/_glslEmu.mjs) fed exactly what the vertex stage
// feeds the GPU kernel (em - aC2.zw): noAaArcRow__FAR's rotated ring and a cubic blob, quantized to 2^-20 so
// every placement is exact, packed and drawn at 256 px across at the origin, at y = 1e5 and at x = -1e5.
//   E. at most two pixels draw more than 1e-3 away from the origin's (a center a few float32 steps from a hard
//      step can read either side), and the pixels off the exact coverage by half or more number the same.
// A kernel that reads world coordinates there FAILS.
//   E, AT y = 1e6 AND 1e7 TOO: the cover vertices are packed in the same frame, not in world
//      coordinates -- rounded to float32 at 1e6 they would sit a sixteenth of a unit off the seams the kernel
//      cuts exactly, and FAR would draw 44 pixels off by half at y = 1e6 and 2,322 at 1e7.
//   M. the same of a MORPH pose, whose span packs in one frame of its own (a morph pack evaluated in world em
//      fails it).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { hasCxx, buildGlslEmu, K_CPATCH_COV } = await import('./_glslEmu.mjs');
const { packCPatchShape, LB_STRIDE } = await import('../src/renderer/cpatchPack.js');
const { default: importSvg } = await import('../src/svg/importer.js');
const cb = await import('../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
console.warn = () => {};

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!hasCxx()) {
  console.log('  SKIP: no C++ compiler for the shader emulator');
  process.exit(0);
}
const emu = buildGlslEmu(ROOT, { cpatch: true });
const N = 256;
// A KNIFE EDGE MAY still MOVE. The kernel steps at a hard hull plane and a cut, so a pixel whose center
// lies within a few float32 steps of one reads either side, and the frame moves those steps by a rounding
// of the corner. A world-coordinate kernel moves every pixel within a hundredth of a pixel.
const MOVED = 2;
const Q = 2 ** 20;
const quant = (cs) =>
  cs.map((c) => {
    const o = { t: c.t, P: c.P.map((p) => [Math.round(p[0] * Q) / Q, Math.round(p[1] * Q) / Q]) };
    if (c.w !== undefined) o.w = c.w;
    return o;
  });
const place = (cs, tx, ty) =>
  cs.map((c) => {
    const o = {
      t: c.t,
      P: c.P.map((p) => {
        const q = [p[0] + tx, p[1] + ty];
        if (q[0] - tx !== p[0] || q[1] - ty !== p[1]) throw new Error('inexact');
        return q;
      }),
    };
    if (c.w !== undefined) o.w = c.w;
    return o;
  });

/// Pack, rasterize the cover (the vertex stage as cpatchMorphExactSmoke replicates it) on a grid of N px
/// across the contour that moves with it, and run the kernel twin on every fragment. Per pixel: drawn
/// coverage (fragments OVER-composited) and exact coverage (8x8 samples).
function draw(curves) {
  return drawPacked(packCPatchShape([curves], 0, {}), curves);
}
function drawPacked(m, curves) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of curves)
    for (const p of c.P) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
  const epp = Math.max(x1 - x0, y1 - y0) / N,
    W = N + 8,
    gx = x0 - 4 * epp,
    gy = y0 - 4 * epp;
  const verts = m.verts,
    qs = [],
    own = [];
  for (let tri = 0; (tri + 1) * 3 * LB_STRIDE <= verts.length; tri++) {
    const vs = [0, 1, 2].map((k) =>
      verts.subarray((tri * 3 + k) * LB_STRIDE, (tri * 3 + k + 1) * LB_STRIDE),
    );
    const q = vs.map((v) => [v[0] + v[17] + v[2] * 1.5 * epp, v[1] + v[18] + v[3] * 1.5 * epp]);
    let area =
      (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
    if (!(Math.abs(area) > 0)) continue;
    const o = area > 0 ? [0, 1, 2] : [0, 2, 1],
      T = o.map((k) => q[k]),
      V = o.map((k) => vs[k]);
    area = Math.abs(area);
    const edge = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const inE = (w, a, b) =>
      w > 0 || (w === 0 && (b[1] - a[1] < 0 || (b[1] === a[1] && b[0] > a[0])));
    const xs = T.map((p) => p[0]),
      ys = T.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - gx) / epp - 0.5)),
      i1 = Math.min(W - 1, Math.ceil((Math.max(...xs) - gx) / epp));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - gy) / epp - 0.5)),
      j1 = Math.min(W - 1, Math.ceil((Math.max(...ys) - gy) / epp));
    const f = V[2];
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const p = [gx + (i + 0.5) * epp, gy + (j + 0.5) * epp];
        const w0 = edge(T[1], T[2], p),
          w1 = edge(T[2], T[0], p),
          w2 = edge(T[0], T[1], p);
        if (!(inE(w0, T[1], T[2]) && inE(w1, T[2], T[0]) && inE(w2, T[0], T[1]))) continue;
        const tc = [2, 3, 4].map((c) => (w0 * V[0][c] + w1 * V[1][c] + w2 * V[2][c]) / area);
        qs.push({
          k: K_CPATCH_COV,
          GD: [f[7], f[8], f[9], f[10]],
          bb: [f[11], f[12], f[13], f[14]],
          c: [p[0] - f[17], p[1] - f[18]],
          ePx: [f[19], f[20]],
          ex: [tc[0], tc[1], tc[2], f[15], f[16], epp],
        });
        own.push(j * W + i);
      }
  }
  const got = emu.run(new Float32Array(4), new Float32Array(m.texels), qs);
  const img = new Float64Array(W * W).fill(1);
  for (let k = 0; k < got.length; k++) img[own[k]] *= 1 - Math.max(0, Math.min(1, got[k]));
  // exact coverage, 8x8 samples, nonzero
  const segs = [];
  for (const c of curves) {
    const at = (u) => {
      if (c.t === 'rquad') {
        const w = c.w,
          a = (1 - u) * (1 - u),
          b = 2 * u * (1 - u) * w,
          d = u * u,
          t = a + b + d;
        return [
          (a * c.P[0][0] + b * c.P[1][0] + d * c.P[2][0]) / t,
          (a * c.P[0][1] + b * c.P[1][1] + d * c.P[2][1]) / t,
        ];
      }
      let P = c.P.map((z) => z.slice());
      while (P.length > 1)
        P = P.slice(1).map((z, i) => [
          P[i][0] + (z[0] - P[i][0]) * u,
          P[i][1] + (z[1] - P[i][1]) * u,
        ]);
      return P[0];
    };
    let prev = c.P[0];
    for (let k = 1; k <= 96; k++) {
      const q = k === 96 ? c.P[c.P.length - 1] : at(k / 96);
      segs.push([prev, q]);
      prev = q;
    }
  }
  // scanline crossings: each of the 8 sample rows of a pixel row takes its crossings once
  const drawn = new Float64Array(W * W),
    exact = new Float64Array(W * W);
  for (let j = 0; j < W; j++)
    for (let sy = 0; sy < 8; sy++) {
      const y = gy + (j + (sy + 0.5) / 8) * epp,
        xs = [];
      for (const [a, b] of segs) {
        if (a[1] <= y === b[1] <= y) continue;
        xs.push([a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), b[1] > a[1] ? 1 : -1]);
      }
      xs.sort((u, v) => u[0] - v[0]);
      let w = 0,
        k = 0;
      for (let i = 0; i < W; i++)
        for (let sx = 0; sx < 8; sx++) {
          const x = gx + (i + (sx + 0.5) / 8) * epp;
          while (k < xs.length && xs[k][0] <= x) w += xs[k++][1];
          // the crossings left of the sample sum to minus the winding to its right (a closed contour sums to 0)
          if (w !== 0) exact[j * W + i] += 1 / 64;
        }
    }
  for (let k = 0; k < drawn.length; k++) drawn[k] = 1 - img[k];
  let half = 0;
  for (let k = 0; k < drawn.length; k++) if (Math.abs(drawn[k] - exact[k]) >= 0.5) half++;
  return { drawn, half };
}

const contours = [];
{
  const sec = await importSvg(
    readFileSync(path.join(ROOT, 'examples/smoke/noAaArcRow__FAR.svg'), 'utf8'),
  );
  const b = cb.headlessCPatchBundle(sec),
    cf = cb.cpatchCurvePlane(b),
    r = b.curveRangesByShape[11];
  const cs = cb.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null);
  const got = [];
  packCPatchShape(cs, 0, { evenOdd: cb.shapeEvenOdd(b, 11), collect: got });
  contours.push({
    name: "FAR's rotated ring",
    curves: quant(got[0].curves.map((c) => ({ ...c, P: c.P.map((p) => [p[0], p[1] - 1e5]) }))),
  });
}
{
  const sec = await importSvg(
    readFileSync(path.join(ROOT, 'examples/smoke/fillBezoutOmit__BLOB.svg'), 'utf8'),
  );
  const b = cb.headlessCPatchBundle(sec),
    cf = cb.cpatchCurvePlane(b),
    r = b.curveRangesByShape[0];
  contours.push({
    name: 'a cubic blob',
    curves: quant(cb.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null)[0]),
  });
}
for (const { name, curves } of contours) {
  console.log(`\n-- ${name} --`);
  const ref = draw(curves);
  console.log(`  at the origin: ${ref.half} pixels off the exact coverage by half or more`);
  for (const [lab, tx, ty] of [
    ['at y = 1e5', 0, 1e5],
    ['at x = -1e5', -1e5, 0],
    ['at y = 1e6', 0, 1e6],
    ['at y = 1e7', 0, 1e7],
  ]) {
    const d = draw(place(curves, tx, ty));
    let maxd = 0,
      moved = 0;
    for (let k = 0; k < d.drawn.length; k++) {
      const e = Math.abs(d.drawn[k] - ref.drawn[k]);
      maxd = Math.max(maxd, e);
      if (e > 1e-3) moved++;
    }
    console.log(
      `     ${lab}: ${moved} pixels differ from the origin's by more than 1e-3 (max ${maxd.toExponential(1)}); ${d.half} off by half (origin ${ref.half})`,
    );
    ok(
      moved <= MOVED && d.half === ref.half,
      `E. ${lab}: at most ${MOVED} pixels move by more than 1e-3, and as many are off by half`,
    );
  }
}

// ---- M. A MORPH, whose span packs in one frame of its own (morphKernelFrame) -----------------------------
// The 12-cubic ring the GPU morph check draws, quantized so every placement is exact, planned and posed at
// t = 0.45 through the CPU route (applyCPatchMorphFrame, a stub GL, the plane it uploads) and drawn the
// same way at the origin, at y = 1e5 and at x = -1e5. A morph pack evaluated in world em (0 in aC2.zw)
// FAILS it.
{
  const { convertContour, morphTolPx } = await import('../src/renderer/cpatchConvert.js');
  const { planMorph, splitForMorph } = await import('../src/renderer/cpatchMorphCert.js');
  const { applyCPatchMorphFrame } = await import('../src/renderer/cpatchMorphBuild.js');
  const ring = (t) => {
    const K = 12,
      Rr = 40 + 22 * t,
      at = (j) => [
        100 + Rr * Math.cos((2 * Math.PI * j) / K),
        100 + Rr * Math.sin((2 * Math.PI * j) / K),
      ];
    const out = [];
    for (let j = 0; j < K; j++) {
      const A = at(j),
        B = at(j + 1),
        mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.3,
        my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.3;
      out.push({
        t: 'cubic',
        P: [
          A,
          [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
          [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1],
          B,
        ],
      });
    }
    return out;
  };
  const QM = 2 ** 10,
    qm = (cs) =>
      cs.map((c) => ({
        t: c.t,
        P: c.P.map((p) => [Math.round(p[0] * QM) / QM, Math.round(p[1] * QM) / QM]),
      }));
  const A0 = qm(ring(0)),
    B0 = qm(ring(1)),
    T = 0.45;
  const glStub = () => ({
    TEXTURE_2D: 1,
    RGBA32F: 2,
    RGBA: 3,
    FLOAT: 4,
    NEAREST: 5,
    TEXTURE_MIN_FILTER: 6,
    TEXTURE_MAG_FILTER: 7,
    TEXTURE_WRAP_S: 8,
    TEXTURE_WRAP_T: 9,
    CLAMP_TO_EDGE: 10,
    bindTexture() {},
    texImage2D() {},
    texSubImage2D() {},
    texParameteri() {},
    deleteTexture() {},
  });
  const drawMorph = (tx, ty) => {
    const MA = place(A0, tx, ty),
      MB = place(B0, tx, ty);
    const tolPx = morphTolPx(MA, MB);
    const convert = (cs, o) => {
      try {
        return convertContour(cs, {
          maxCurves: 8,
          tolPx,
          noCurveCuts: true,
          forceBezout: true,
          leakMargin: (o && o.leakMargin) || 0,
        });
      } catch {
        return null;
      }
    };
    const [A, B] = splitForMorph(MA, MB);
    const plan = planMorph(A, B, convert, { tolPx, maxPlanMs: 0 });
    if (!plan) return null;
    const morph = {
      shapes: [{ A, B, plan, seg: -1, pack: null, first: 0, plan2: null, planBase: -1 }],
      planned: 1,
    };
    const lerped = new Float32Array(5000);
    const bundle = {
      _morphSrc: { t: T, mergedCurveF32: lerped },
      curveFloats: lerped,
      curveTex: {},
      numShapes: 1,
      _cpatchMorphPlan: morph,
    };
    if (!applyCPatchMorphFrame(glStub(), bundle, { gpuBlend: false })) return null;
    const mesh = bundle._lbMeshes[0],
      plane = bundle._cpatchMorphPlane.plane;
    const pose = A.map((c, i) => ({
      t: c.t,
      P: c.P.map((p, k) => [p[0] + (B[i].P[k][0] - p[0]) * T, p[1] + (B[i].P[k][1] - p[1]) * T]),
    }));
    return drawPacked({ verts: mesh.verts, texels: plane }, pose);
  };
  console.log('\n-- M. a morph pose (12-cubic ring, t = 0.45) --');
  const ref = drawMorph(0, 0);
  ok(!!ref, 'M. the morph plans and poses at the origin');
  if (ref) {
    console.log(`  at the origin: ${ref.half} pixels off the exact coverage by half or more`);
    // Not at 1e7: a morph's pose is lerped in the bundle's float32 curve stream, in world coordinates, which
    // holds a unit there -- 3 pixels move by up to 1.2e-2. That is the pose data, not the cover or the kernel.
    for (const [lab, tx, ty] of [
      ['at y = 1e5', 0, 1e5],
      ['at x = -1e5', -1e5, 0],
      ['at y = 1e6', 0, 1e6],
    ]) {
      const d = drawMorph(tx, ty);
      if (!d) {
        ok(false, `M. ${lab}: the morph plans and poses`);
        continue;
      }
      let maxd = 0,
        moved = 0;
      for (let k = 0; k < d.drawn.length; k++) {
        const e = Math.abs(d.drawn[k] - ref.drawn[k]);
        maxd = Math.max(maxd, e);
        if (e > 1e-3) moved++;
      }
      console.log(
        `     ${lab}: ${moved} pixels differ from the origin's by more than 1e-3 (max ${maxd.toExponential(1)}); ${d.half} off by half (origin ${ref.half})`,
      );
      ok(
        moved <= MOVED && d.half === ref.half,
        `M. ${lab}: at most ${MOVED} pixels move by more than 1e-3, and as many are off by half`,
      );
    }
  }
}

console.log(fail ? `\ncpatchKernelFrameSmoke FAIL (${fail})` : '\ncpatchKernelFrameSmoke PASS');
process.exit(fail ? 1 : 0);
