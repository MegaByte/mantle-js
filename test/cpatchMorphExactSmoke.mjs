// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchMorphExactSmoke — a posed CPatch morph paints its pose's exact coverage.
//
// THE TRAP. Every patch can be valid on its own, and cpatchMorphLayoutSmoke (which compares a morph
// with the static pack of the same patches) blind to it, while the patches do not TILE the pose. A
// layout names each seam end locally (the neighbouring arc's end, or a barycentric point), and the
// converter cuts recursively, so a later cut ends in the middle of an earlier one: a T-junction whose
// vertex is barycentric while the line it sits on has its ends on the curves. A morph that is not
// affine pulls such a vertex off the line (0.63 units at t = 0.7), and the sliver between the two
// sides is rejected by both patches' hard seams: scored against the exact coverage of the
// interpolated pose on the GPU (256 px, probes/morph/_morphExactRef.mjs), the imported 6-cubic ring
// whose bow grows would draw 26 / 77 / 132 px off by more than 32/255 at t = 0.2 / 0.45 / 0.7, most of
// them whole pixels, in lines through the shape's interior. So extractLayout gives every seam
// vertex ONE definition shared by every patch (unifySeamVertices): its curve point, else a fixed
// fraction along the line it sits inside, else one barycentric point.
//
// WHAT this PINS, on the SHIPPED kernel text in float32 (test/_glslEmu.mjs, cpatch mode), through the
// real CPU morph route (applyCPatchMorphFrame, stub GL), against the pose's exact nonzero coverage
// (12 x 12 samples a pixel against the lerped curves, flattened at 400 steps each):
//   L. the layout TILES at every pose: each seam vertex comes out as one point in every patch that
//      has it, and each vertex that sits inside another patch's seam stays on that seam's line, both
//      to the layout's own vertex bar (2^-16 of the contour's extent);
//   E. the pixels: the imported 6-cubic ring (importSvg -> curveRangeToContours -> toCurvesPair, as
//      morphPairs builds it) and the synthetic cubic blob turning at 1 rad, at t = 0.2, 0.45, 0.7,
//      256 px across the t = 0 pose -- no pixel with the wrong verdict (off by half or more), and on
//      the imported ring not one off by more than 32/255 (the GPU probe's metric).
// A layout with locally named seam vertices FAILS: L finds vertices 0.18-0.63 units off their lines, and
// E finds 25 / 64 / 113 px off on the imported ring and 40 / 79 / 112 on the turning blob, all whole pixels.
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
import { hasCxx, buildGlslEmu, K_CPATCH_COV } from './_glslEmu.mjs';
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { applyCPatchMorphFrame, _toCurvesPair } from '../src/renderer/cpatchMorphBuild.js';
import { convertContour, morphTolPx } from '../src/renderer/cpatchConvert.js';
import { planMorph, splitForMorph, applyLayout } from '../src/renderer/cpatchMorphCert.js';
import { LB_STRIDE } from '../src/renderer/cpatchPack.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const N = 256,
  POSES = [0.2, 0.45, 0.7];

// ---- the two morphs -------------------------------------------------------------------------------------
const ringPts = (t, K, spin, round) => {
  const R = 40 + 22 * t,
    at = (j) => [
      100 + R * Math.cos((2 * Math.PI * j) / K + spin * t),
      100 + R * Math.sin((2 * Math.PI * j) / K + spin * t),
    ];
  const out = [];
  for (let j = 0; j < K; j++) {
    const A = at(j),
      B = at(j + 1),
      bow = 0.3 + 0.14 * t;
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
    out.push(
      [
        A,
        [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
        [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1],
        B,
      ].map((p) => p.map(round)),
    );
  }
  return out;
};
async function importedPair() {
  const svg = (t) => {
    const s = ringPts(t, 6, 0, (v) => v.toFixed(3));
    let d = `M${s[0][0][0]} ${s[0][0][1]}`;
    for (const c of s) d += ` C${c[1][0]} ${c[1][1]} ${c[2][0]} ${c[2][1]} ${c[3][0]} ${c[3][1]}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#123" d="${d} Z"/></svg>`;
  };
  const a = await importSvg(svg(0)),
    b = await importSvg(svg(1)),
    r = a.curveRangesByShape[0];
  return _toCurvesPair(
    curveRangeToContours(new Float32Array(a.curves), r.begin, r.end)[0],
    curveRangeToContours(new Float32Array(b.curves), r.begin, r.end)[0],
  );
}
const turning = () => {
  const cubic = (t) => ringPts(t, 6, 1, (v) => v).map((P) => ({ t: 'cubic', P }));
  return { A: cubic(0), B: cubic(1) };
};
const MORPHS = [
  { name: 'imported 6-cubic ring, bow grows', pair: await importedPair(), strict: true },
  { name: 'cubic blob, bow grows, turning 1 rad', pair: turning(), strict: false },
];

// ---- exact coverage and the painted picture ----------------------------------------------------------------
function exactInside(curves) {
  const segs = [];
  for (const c of curves) {
    let px = c.P[0][0],
      py = c.P[0][1];
    for (let k = 1; k <= 400; k++) {
      const u = k / 400;
      let Q = c.P.map((z) => z.slice());
      while (Q.length > 1)
        Q = Q.slice(1).map((z, i) => [
          Q[i][0] + (z[0] - Q[i][0]) * u,
          Q[i][1] + (z[1] - Q[i][1]) * u,
        ]);
      segs.push([px, py, Q[0][0], Q[0][1]]);
      px = Q[0][0];
      py = Q[0][1];
    }
  }
  return (x, y) => {
    let w = 0;
    for (const [x0, y0, x1, y1] of segs) {
      if (y0 <= y === y1 <= y) continue;
      if (x0 + ((y - y0) / (y1 - y0)) * (x1 - x0) > x) w += y1 > y0 ? 1 : -1;
    }
    return w !== 0;
  };
}
function paint(verts, plane, epp, x0, y0) {
  const qs = [],
    owners = [];
  for (let tri = 0; (tri + 1) * 3 * LB_STRIDE <= verts.length; tri++) {
    const vs = [0, 1, 2].map((k) =>
      verts.subarray((tri * 3 + k) * LB_STRIDE, (tri * 3 + k + 1) * LB_STRIDE),
    );
    const q = vs.map((v) => [v[0] + v[17] + v[2] * 1.5 * epp, v[1] + v[18] + v[3] * 1.5 * epp]); // cpatchVertexSetup
    let area =
      (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
    if (!(Math.abs(area) > 0)) continue;
    const o = area > 0 ? [0, 1, 2] : [0, 2, 1],
      Q = o.map((k) => q[k]),
      W = o.map((k) => vs[k]);
    area = Math.abs(area);
    const edge = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const inE = (w, a, b) =>
      w > 0 || (w === 0 && (b[1] - a[1] < 0 || (b[1] === a[1] && b[0] > a[0])));
    const xs = Q.map((p) => p[0]),
      ys = Q.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - x0) / epp - 0.5)),
      i1 = Math.min(N - 1, Math.ceil((Math.max(...xs) - x0) / epp));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - y0) / epp - 0.5)),
      j1 = Math.min(N - 1, Math.ceil((Math.max(...ys) - y0) / epp));
    const f = W[2];
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const p = [x0 + (i + 0.5) * epp, y0 + (j + 0.5) * epp];
        const w0 = edge(Q[1], Q[2], p),
          w1 = edge(Q[2], Q[0], p),
          w2 = edge(Q[0], Q[1], p);
        if (!(inE(w0, Q[1], Q[2]) && inE(w1, Q[2], Q[0]) && inE(w2, Q[0], Q[1]))) continue;
        const tc = [2, 3, 4].map((c) => (w0 * W[0][c] + w1 * W[1][c] + w2 * W[2][c]) / area);
        // c is the em position the vertex stage hands the kernel: relative to aC2.zw, the contour's corner
        // a static pack stores there (zero on a morph pack).
        qs.push({
          k: K_CPATCH_COV,
          GD: [f[7], f[8], f[9], f[10]],
          bb: [f[11], f[12], f[13], f[14]],
          c: [p[0] - f[17], p[1] - f[18]],
          ePx: [f[19], f[20]],
          ex: [tc[0], tc[1], tc[2], f[15], f[16], epp],
        });
        owners.push(j * N + i);
      }
  }
  const got = qs.length ? emu.run(new Float32Array(4), plane, qs) : [];
  const img = new Float64Array(N * N).fill(1);
  for (let k = 0; k < got.length; k++) img[owners[k]] *= 1 - Math.max(0, Math.min(1, got[k]));
  for (let k = 0; k < img.length; k++) img[k] = 1 - img[k];
  return img;
}
const glStub = {
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
};

for (const M of MORPHS) {
  console.log(`\n== ${M.name}`);
  // THE WORKER'S RECIPE (cpatch.worker.js planJob), with the time bound off so the plan is the same on
  // every machine.
  const { pair } = M,
    tolPx = morphTolPx(pair.A, pair.B);
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
  const [A, B] = splitForMorph(pair.A, pair.B);
  const plan = planMorph(A, B, convert, { tolPx, maxPlanMs: 0 });
  ok(!!plan, `${M.name}: plans (${plan ? plan.length : 0} segment(s))`);
  if (!plan) continue;
  const lerp = (cs, ds, t) =>
    cs.map((c, i) => ({
      t: c.t,
      cut: c.cut,
      w: c.w,
      _bez: c._bez,
      P: c.P.map((q, k) => [q[0] + (ds[i].P[k][0] - q[0]) * t, q[1] + (ds[i].P[k][1] - q[1]) * t]),
    }));
  let x0e = Infinity,
    y0e = Infinity,
    x1e = -Infinity,
    y1e = -Infinity;
  for (const c of pair.A)
    for (const q of c.P) {
      x0e = Math.min(x0e, q[0]);
      x1e = Math.max(x1e, q[0]);
      y0e = Math.min(y0e, q[1]);
      y1e = Math.max(y1e, q[1]);
    }
  const ext = Math.max(x1e - x0e, y1e - y0e);

  // -- L: the layout tiles. Vertices are identified at the segment's own start, where the converter
  // made them; then every pose is asked whether they are still one point and still on their lines.
  for (const t of POSES) {
    const seg = plan.find((s) => t >= s.t0 - 1e-12 && t <= s.t1 + 1e-12);
    const L0 = applyLayout(seg.layout, lerp(A, B, seg.t0)),
      Lt = applyLayout(seg.layout, lerp(A, B, t));
    const tol = ext * 2 ** -16,
      groups = [],
      seams = [];
    for (let p = 0; p < L0.length; p++)
      for (let i = 0; i < L0[p].length; i++) {
        const c0 = L0[p][i],
          ct = Lt[p][i];
        for (const e of [0, 1]) {
          const q0 = e ? c0.P[c0.P.length - 1] : c0.P[0],
            qt = e ? ct.P[ct.P.length - 1] : ct.P[0];
          let g = groups.find((G) => Math.hypot(G.q0[0] - q0[0], G.q0[1] - q0[1]) <= tol);
          if (!g) groups.push((g = { q0, at: [] }));
          g.at.push(qt);
        }
        if (c0.cut) seams.push([c0, ct]);
      }
    let split = 0,
      offLine = 0;
    for (const g of groups)
      for (const q of g.at)
        split = Math.max(split, Math.hypot(q[0] - g.at[0][0], q[1] - g.at[0][1]));
    for (const [s0, st] of seams) {
      const [a, b] = s0.P,
        L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (const g of groups) {
        const v = g.q0,
          u = ((v[0] - a[0]) * (b[0] - a[0]) + (v[1] - a[1]) * (b[1] - a[1])) / (L * L);
        const d = Math.abs((b[0] - a[0]) * (v[1] - a[1]) - (b[1] - a[1]) * (v[0] - a[0])) / L;
        if (!(u * L > tol && (1 - u) * L > tol && d <= tol)) continue; // not inside this seam
        const [at, bt] = st.P,
          Lt2 = Math.hypot(bt[0] - at[0], bt[1] - at[1]);
        for (const q of g.at)
          offLine = Math.max(
            offLine,
            Math.abs((bt[0] - at[0]) * (q[1] - at[1]) - (bt[1] - at[1]) * (q[0] - at[0])) / Lt2,
          );
      }
    }
    // "ONE POINT" AT THE LAYOUT'S own BAR (2^-16 of the extent, the tolerance it identified the vertex
    // with). The copies are not bit-identical and cannot be: where two patches reach a vertex along two
    // different arcs, the converter finds the two arcs' end parameters by two routes (see
    // cpatchPack's note on welding), ~1.5e-4 units apart here. What matters is that the gap stays at
    // that rounding as the pose moves instead of growing with it.
    ok(
      split <= tol && offLine <= tol,
      `${M.name} t=${t}: L. every seam vertex is one point in every patch (apart by ${split.toExponential(2)}) and every junction on its line (off by ${offLine.toExponential(2)}), within ${tol.toExponential(2)}`,
    );
  }

  // -- E: the pixels, 256 px across the t = 0 pose.
  const epp = ext / N,
    x0 = (x0e + x1e) / 2 - (N / 2) * epp,
    y0 = (y0e + y1e) / 2 - (N / 2) * epp;
  const morph = {
    shapes: [{ A, B, plan, seg: -1, pack: null, first: 0, plan2: null, planBase: -1 }],
    planned: 1,
  };
  const lerped = new Float32Array(4096);
  const bundle = {
    _morphSrc: { t: 0, mergedCurveF32: lerped },
    curveFloats: lerped,
    curveTex: {},
    numShapes: 1,
    _cpatchMorphPlan: morph,
  };
  for (const t of POSES) {
    bundle._morphSrc.t = t;
    if (!applyCPatchMorphFrame(glStub, bundle, { gpuBlend: false })) {
      ok(false, `${M.name} t=${t}: the CPU route poses the morph (${bundle._cpatchMorphWhy})`);
      continue;
    }
    const img = paint(bundle._lbMeshes[0].verts, bundle._cpatchMorphPlane.plane, epp, x0, y0);
    const inside = exactInside(lerp(pair.A, pair.B, t)),
      SS = 12;
    let off32 = 0,
      wrong = 0,
      worst = 0;
    for (let k = 0; k < N * N; k++) {
      const px = x0 + (k % N) * epp,
        py = y0 + Math.floor(k / N) * epp;
      const center = inside(px + epp / 2, py + epp / 2);
      let ref = center ? 1 : 0;
      // A pixel is supersampled wherever the picture is partial or disagrees with the center sample;
      // elsewhere it is whole on both sides.
      if ((img[k] > 1e-6 && img[k] < 1 - 1e-6) || center !== img[k] > 0.5) {
        let c = 0;
        for (let a = 0; a < SS; a++)
          for (let b = 0; b < SS; b++)
            if (inside(px + ((a + 0.5) * epp) / SS, py + ((b + 0.5) * epp) / SS)) c++;
        ref = c / (SS * SS);
      }
      const e = Math.abs(img[k] - ref);
      worst = Math.max(worst, e);
      if (e > 32 / 255) off32++;
      if (e >= 0.5) wrong++;
    }
    console.log(
      `  .. ${M.name} t=${t}: ${off32} px off the exact coverage by more than 32/255, ${wrong} by half or more, worst ${(worst * 255).toFixed(0)}/255`,
    );
    ok(
      wrong === 0,
      `${M.name} t=${t}: E. no pixel has the wrong verdict (${wrong} off by half or more)`,
    );
    if (M.strict)
      ok(off32 === 0, `${M.name} t=${t}: E. and none is off by more than 32/255 (${off32})`);
  }
}

console.log(fail ? `\ncpatchMorphExactSmoke FAIL (${fail})` : '\ncpatchMorphExactSmoke PASS');
process.exit(fail ? 1 : 0);
