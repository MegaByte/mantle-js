// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchMorphLayoutSmoke — a CPatch morph pose gives the kernel what a static pack of the same patches
// gives it.
//
// THREE CONTRACTS, each enough to blank a posed morph on its own when broken:
//   1. THE BLOCK. packCPatchMorphFrame must write the full seven-texel constraint block, not a four-texel
//      one (texel 3 a3/c1 for every kind, texel 4 a (-1e6,-1e6,1e6,1e6) "no box", texels 5-6 nothing, no
//      degree bit). The kernel reads texel 3 as the arc's BOX (all kinds but the Bezout cubic), texel 4 as
//      its cross-chord STRIP and texels 5-6 as the ARC -- so with the short block every inside fragment of
//      every non-cut constraint has its distance floored to its distance from the origin, and every
//      three-point arc is evaluated as a cubic through (0, 0).
//   2. THE VERTEX. planCPatchMorphSegment must fill aTC.z. The kernel reads vTC.z as the fragment's
//      distance to its hull (the static skirt's slot), and with 0 there it caps every fragment at
//      exactBoxCov(n, 0) = 0.5 -- mid-grey, which a render's ink count reads as blank.
//   3. THE ADDRESS. applyCPatchMorphFrame places the blocks at float baseFloat and must tell the kernel
//      the seven-texel block index; `first = baseFloat / 16` (four-texel blocks) reads 3 * baseBlock
//      texels past them.
//
// WHAT this PINS, on the SHIPPED kernel text compiled to float32 (test/_glslEmu.mjs, cpatch mode):
//   A. through the real CPU route -- applyCPatchMorphFrame with a stub GL, reading back the plane it
//      uploads -- every mesh's (first, count) addresses the blocks the writer packed;
//   B. per constraint, the morph block and the static block of the same patch at the same pose give
//      the kernel IDENTICAL answers (coverage, soft area, near flag, signed distance, bitwise) wherever
//      the morph carries the static data: every cut, every line whose endpoints keep their order over
//      the span, and every curve fragment the box and strip do not decide -- the static block under
//      the morph's seam rule (a seam's box unbounded), whose own cost is logged as R;
//   C. per pixel, the whole kernel -- cover rasterized, varyings interpolated, patches composited with
//      OVER -- paints the morph pose within an AA tolerance of the static pack: never a whole wrong
//      pixel, the ink within 0.05%, and every differing pixel in the outline's AA band;
//   D. the GPU blend (a float32 twin of cpatchMorphBlend's shader over packCPatchMorphPlanes) rebuilds
//      the CPU pack of the pose: the same picture to 1/255.
//
// THE TOLERANCE, and what the morph gives up for it. A morph block cannot carry the pose's own arc BOX
// or chord STRIP -- neither is polynomial in the pose, and the blend rebuilds every texel as one -- so it
// carries the span's (morphArcBounds: exact for a line that keeps its order, a union for a curve).
// Coverage reads the box only where the arc distance is not taken, and the arc distance is never less
// than the distance to a box around it, so the looser box changes two things only: the near-arc flag
// (which lets a seam or hull plane relax inside an AA band) and the curvature term just past saturation.
// And a morph cover is the span's dilated hull with no skirt or row fence, bounded by constraints the
// certificate proved leak-free across the span, where the static cover is the pose's own hull with
// ramped skirts. Both are edge effects, which is what C asserts.
//
// A tree that breaks the three contracts FAILS: A reads zeros where the blocks should be, B finds a box at
// the origin, C paints at most 0.5 everywhere (ink ~0.5x). Run it there with this file and test/_glslEmu.mjs
// copied in -- the emulator's CPatch mode is harness, not the thing under test.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, K_CPATCH_COV, K_CPATCH_CURVE } from './_glslEmu.mjs';
import { convertContour, morphTolPx, framePatch } from '../src/renderer/cpatchConvert.js';
import { planMorph, splitForMorph, applyLayout } from '../src/renderer/cpatchMorphCert.js';
import * as PK from '../src/renderer/cpatchPack.js';
import {
  applyCPatchMorphFrame,
  setCPatchMorphT,
  cpatchGlobalSegment,
  moveLoops,
} from '../src/renderer/cpatchMorphBuild.js';
import { distToContour } from '../src/renderer/cpatchCov.js';
import { rowSpans } from '../src/renderer/cpatchConvert.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0,
  rWorstAll = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!hasCxx()) {
  console.log('  SKIP: no C++ compiler for the shader emulator');
  process.exit(0);
}
const emu = buildGlslEmu(ROOT, { cpatch: true });
const BF = 28; // floats in a constraint block (7 texels)

// ---- the morphs ----------------------------------------------------------------------------------
// The 12-cubic ring the GPU check draws (a scale-only morph), a 6-cubic ring whose bow grows, a
// rotating 12-line star, whose outline lines carry boxes of their own, and a turning 4-cubic ring.
const ring = (K, bowGrows, t, spin = 0) => {
  const Rr = 40 + 22 * t,
    at = (j) => [
      100 + Rr * Math.cos((2 * Math.PI * j) / K + spin * t),
      100 + Rr * Math.sin((2 * Math.PI * j) / K + spin * t),
    ];
  const out = [];
  for (let j = 0; j < K; j++) {
    const A = at(j),
      B = at(j + 1),
      bow = bowGrows ? 0.3 + 0.14 * t : 0.3;
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
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
const star = (t) => {
  const out = [],
    K = 6,
    Rr = 40 + 22 * t;
  for (let j = 0; j < K; j++) {
    const a0 = (2 * Math.PI * j) / K + t,
      a1 = (2 * Math.PI * (j + 0.5)) / K + t,
      a2 = (2 * Math.PI * (j + 1)) / K + t;
    const p0 = [100 + Rr * Math.cos(a0), 100 + Rr * Math.sin(a0)],
      p1 = [100 + 0.55 * Rr * Math.cos(a1), 100 + 0.55 * Rr * Math.sin(a1)];
    const p2 = [100 + Rr * Math.cos(a2), 100 + Rr * Math.sin(a2)];
    out.push({ t: 'line', P: [p0, p1] }, { t: 'line', P: [p1, p2] });
  }
  return out;
};
const MORPHS = [
  { name: '12-cubic ring', A: ring(12, false, 0), B: ring(12, false, 1) },
  { name: '6-cubic ring, bow grows', A: ring(6, true, 0), B: ring(6, true, 1) },
  { name: '12-line star, turning', A: star(0), B: star(1) },
  // ...and one whose plan has TWO segments, so a pose past the first re-plans its cells.
  { name: '4-cubic ring, turning', A: ring(4, true, 0, 2), B: ring(4, true, 1, 2) },
];
const POSES = [0.2, 0.45, 0.7];
const N = 96; // pixels across the pose

// ---- a stub GL: enough of the API for the CPU route to upload, and a record of what it uploaded ------
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

// ---- the rasterizer: cover triangles, the vertex stage's dilation, interpolated vTC, OVER ---------------
function paint(verts, plane, epp, x0, y0) {
  const S = PK.LB_STRIDE,
    qs = [],
    owners = [];
  for (let tri = 0; (tri + 1) * 3 * S <= verts.length; tri++) {
    const vs = [0, 1, 2].map((k) => verts.subarray((tri * 3 + k) * S, (tri * 3 + k + 1) * S));
    const q = vs.map((v) => [v[0] + v[17] + v[2] * 1.5 * epp, v[1] + v[18] + v[3] * 1.5 * epp]); // cpatchVertexSetup
    let area =
      (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
    if (!(Math.abs(area) > 0)) continue;
    const o = area > 0 ? [0, 1, 2] : [0, 2, 1];
    const Q = o.map((k) => q[k]),
      W = o.map((k) => vs[k]);
    area = Math.abs(area);
    const edge = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const topLeft = (a, b) => b[1] - a[1] < 0 || (b[1] === a[1] && b[0] > a[0]); // one owner per shared edge
    const inE = (w, a, b) => w > 0 || (w === 0 && topLeft(a, b));
    const xs = Q.map((p) => p[0]),
      ys = Q.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - x0) / epp - 0.5)),
      i1 = Math.min(N - 1, Math.ceil((Math.max(...xs) - x0) / epp));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - y0) / epp - 0.5)),
      j1 = Math.min(N - 1, Math.ceil((Math.max(...ys) - y0) / epp));
    const f = W[2]; // flat varyings: equal on all three vertices
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

// ---- one constraint, both packs, at the same points ---------------------------------------------------
const OUTS = [0, 1, 2, 3]; // coverage, soft area, near-arc flag, signed distance
function constraintAnswers(plane, block, pts, epp) {
  const qs = [];
  for (const p of pts)
    for (const w of OUTS)
      qs.push({
        k: K_CPATCH_CURVE,
        GD: [w, block, 0, 0],
        bb: [0, 0, 0, 0],
        c: p,
        ex: [0, 0, 0, 0, 0, epp],
      });
  return emu.run(new Float32Array(4), plane, qs);
}

// ---- the GPU blend, in float32: cpatchMorphBlend's shader over packCPatchMorphPlanes -------------------
// A twin of THE TREE'S shader: which rows take a C term is read off its source, and the reconstruction
// it models is checked against that source below, so the twin cannot quietly describe another blend.
const BLEND_SRC = readFileSync(path.join(ROOT, 'src/renderer/cpatchMorphBlend.js'), 'utf8');
const C_ROWS = /row == 5/.test(BLEND_SRC) ? [2, 3, 5, 6] : [2, 3];
const f32 = Math.fround;
function blendTwin(planes, nBlocks, u) {
  const nA = nBlocks * BF,
    CF = PK.CP_MORPH_C_FLOATS || 4,
    out = new Float32Array(nA),
    C = planes.subarray(nA * 2);
  for (let t = 0; t < nA / 4; t++) {
    const blk = Math.floor(t / 7),
      row = t - blk * 7,
      a = t * 4,
      b = nA + t * 4;
    out[a] = f32(planes[a] + f32(u * planes[b]));
    out[a + 1] = f32(planes[a + 1] + f32(u * planes[b + 1]));
    out[a + 2] = f32(planes[a + 2] + f32(u * f32(planes[b + 2] + f32(u * planes[b + 3]))));
    let w = planes[a + 3];
    if (C_ROWS.includes(row)) {
      const c = blk * CF + (row > 3 ? 4 : 0) + (row === 2 || row === 5 ? 0 : 2);
      w = f32(w + f32(u * f32(C[c] + f32(u * C[c + 1]))));
    }
    out[a + 3] = w;
  }
  return out;
}

ok(
  BLEND_SRC.includes('o = vec4(a.xy + u * b.xy, a.z + u * (b.z + u * b.w), w);') &&
    BLEND_SRC.includes('w += (row == 2 || row == 5) ? u * (c.x + u * c.y) : u * (c.z + u * c.w);'),
  "D. the blend shader reconstructs a texel the way this smoke's twin does",
);
for (const M of MORPHS) {
  console.log(`\n== ${M.name}`);
  // THE WORKER'S RECIPE (cpatch.worker.js planJob), then the plan the bundle holds.
  const tolPx = morphTolPx(M.A, M.B);
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
  const [A, B] = splitForMorph(M.A, M.B);
  const plan = planMorph(A, B, convert, { tolPx, maxPlanMs: 0 }); // the same plan on every machine
  ok(!!plan, `${M.name}: plans (${plan ? plan.length : 0} segment(s))`);
  if (!plan) continue;
  const lerp = (t) =>
    A.map((c, i) => ({
      t: c.t,
      cut: c.cut,
      w: c.w,
      _bez: c._bez,
      P: c.P.map((q, k) => [q[0] + (B[i].P[k][0] - q[0]) * t, q[1] + (B[i].P[k][1] - q[1]) * t]),
    }));
  const morph = {
    shapes: [{ A, B, plan, seg: -1, pack: null, first: 0, plan2: null, planBase: -1 }],
    planned: 1,
  };
  // A lerped curve plane of 5,000 floats, so the morph's blocks go PAST it -- the case the address is for.
  const lerped = new Float32Array(5000);
  const bundle = {
    _morphSrc: { t: 0, mergedCurveF32: lerped },
    curveFloats: lerped,
    curveTex: {},
    numShapes: 1,
    _cpatchMorphPlan: morph,
  };
  for (const t of POSES) {
    bundle._morphSrc.t = t;
    const drew = applyCPatchMorphFrame(glStub(), bundle, { gpuBlend: false });
    ok(
      drew,
      `${M.name} t=${t}: the CPU route poses the morph${drew ? '' : ' — ' + bundle._cpatchMorphWhy}`,
    );
    if (!drew) continue;
    const mesh = bundle._lbMeshes[0],
      plane = bundle._cpatchMorphPlane.plane,
      sh = morph.shapes[0];
    // -- A: the address. Every cell's first block, in the uploaded plane, is the block the writer packed.
    let addr = 0,
      cellsSeen = 0;
    for (let k = 0; k * PK.LB_STRIDE < mesh.verts.length; k += 3) {
      const first = mesh.verts[k * PK.LB_STRIDE + 19],
        at = (first - sh.first) * BF;
      cellsSeen++;
      for (let q = 0; q < BF; q++)
        if (plane[first * BF + q] !== sh.pack.texels[at + q]) {
          addr++;
          break;
        }
    }
    ok(
      addr === 0,
      `${M.name} t=${t}: A. every triangle's block address holds the block packed for it (${addr} of ${cellsSeen} do not)`,
    );

    // The pose's patches, and the STATIC pack of exactly those patches (the converter's result handed in),
    // IN THE SPAN'S KERNEL FRAME O as the morph packs them: the patches derived from the pose's
    // loops moved by -O, packed where they are, and the cover moved back to world em carrying O in
    // aC2.zw -- what planCPatchMorphSegment does. A constraint is then asked at p - O on both sides.
    const segp = plan.find((s) => t >= s.t0 - 1e-12 && t <= s.t1 + 1e-12);
    const O = sh.plan2.frame || [0, 0];
    const patches = moveLoops(applyLayout(segp.layout, lerp(t)), O).map((l) => framePatch(l));
    const curves = lerp(t),
      curvesL = moveLoops([curves], O)[0],
      cache = new Map();
    cache.set(PK.cpatchConvKey(curvesL, null, PK.cpatchConvSettings({})), { patches, stats: {} });
    const st = PK.packCPatchContour(curvesL, 0, { convCache: cache, kernelFrame: false });
    for (let k = 0; k * PK.LB_STRIDE < st.verts.length; k++) {
      const v = st.verts.subarray(k * PK.LB_STRIDE);
      v[17] = O[0];
      v[18] = O[1];
    }
    ok(
      O[0] !== 0 || O[1] !== 0,
      `${M.name} t=${t}: the span packs in its own frame, (${O[0]}, ${O[1]})`,
    );
    let bx0 = Infinity,
      by0 = Infinity,
      bx1 = -Infinity,
      by1 = -Infinity;
    for (const c of curves)
      for (const q of c.P) {
        bx0 = Math.min(bx0, q[0]);
        bx1 = Math.max(bx1, q[0]);
        by0 = Math.min(by0, q[1]);
        by1 = Math.max(by1, q[1]);
      }
    const epp = (Math.max(bx1 - bx0, by1 - by0) * 1.1) / N;
    const x0 = (bx0 + bx1) / 2 - (N / 2) * epp,
      y0 = (by0 + by1) / 2 - (N / 2) * epp;

    // -- B: per constraint. The static pack's patch runs are its hull rows and then its curves, in the
    // patch's own order; the morph's cells are its curves. Points: a grid over each patch's box, a
    // pixel and a half past it, and rings a third of a pixel either side of every arc.
    let exact = 0,
      carried = 0,
      carriedBad = 0,
      bounded = 0,
      boundedDiff = 0,
      boundedCov = 0;
    const firstOf = new Map();
    for (let k = 0; k * PK.LB_STRIDE < st.verts.length; k += 3) {
      const v = st.verts.subarray(k * PK.LB_STRIDE);
      firstOf.set(v[19], v[20]);
    }
    const runs = [...firstOf.entries()].sort((a, b) => a[0] - b[0]);
    // THE MORPH'S SEAM RULE. A morph packs every seam with an unbounded box, so the kernel never stands it
    // down past its span (packCPatchMorphFrame -- a morph's layout ends seams at vertices the static decomposition never
    // makes, and past their spans those seams close the corners: cpatchMorphExactSmoke). `seamRule` is the static pack
    // under that rule, the reference B and C hold the morph to; the rule's own cost against the static pack's release is
    // logged on its own below (R).
    // ...AND ITS CORNERS: a morph's cover is the span's dilated hull, so the morph packer flags the corners a
    // static cover draws (squared seam corners, and the outline corners a line's floor stops at; the segment's, from its
    // first pose) and the kernel draws them; the static pack under the morph's rules carries the same flags.
    const endF = sh.plan2.endFlags;
    console.log(
      `  .. ${M.name} t=${t}: armed straight-seam outline ends (frozen from the segment's first pose): ${(sh.plan2.seamArm || []).flat().reduce((a, v) => a + (v & 1 ? 1 : 0) + (v & 2 ? 1 : 0), 0)}`,
    );
    const seamRule = st.texels.slice();
    for (let pi = 0; pi < patches.length && runs.length === patches.length; pi++) {
      const [sFirst, sCount] = runs[pi],
        rows = sCount - patches[pi].curves.length;
      patches[pi].curves.forEach((c, ci) => {
        const sb = (sFirst + rows + ci) * BF;
        if (c.cut && (seamRule[sb + 3] % 32) % 8 !== 4) {
          seamRule[sb + 12] = -1e30;
          seamRule[sb + 13] = -1e30;
          seamRule[sb + 14] = 1e30;
          seamRule[sb + 15] = 1e30;
        }
        if (!c.cut && endF && endF[pi]) seamRule[sb + 3] += PK.CPK_END * (endF[pi][ci] | 0);
      });
    }
    for (let pi = 0; pi < patches.length && runs.length === patches.length; pi++) {
      const p = patches[pi],
        [sFirst, sCount] = runs[pi],
        rows = sCount - p.curves.length;
      const cell = sh.plan2.cells.find((c) => c.pi === pi),
        bd = (sh.plan2.bounds || [])[pi] || [];
      const pts = [];
      const bb = p.bbox,
        pad = 1.5 * epp;
      for (let a = 0; a <= 16; a++)
        for (let b = 0; b <= 16; b++)
          pts.push([
            bb[0] - pad + ((bb[2] - bb[0] + 2 * pad) * (a + 0.31)) / 17,
            bb[1] - pad + ((bb[3] - bb[1] + 2 * pad) * (b + 0.57)) / 17,
          ]);
      for (const c of p.curves)
        for (let s = 0; s <= 12; s++) {
          const u = (s + 0.5) / 13,
            n = c.P.length - 1,
            P = c.P;
          const pt =
            n === 1 ? [P[0][0] + (P[1][0] - P[0][0]) * u, P[0][1] + (P[1][1] - P[0][1]) * u] : null;
          const q =
            pt ||
            (() => {
              let Q = P.map((z) => z.slice());
              while (Q.length > 1)
                Q = Q.slice(1).map((z, i) => [
                  Q[i][0] + (z[0] - Q[i][0]) * u,
                  Q[i][1] + (z[1] - Q[i][1]) * u,
                ]);
              return Q[0];
            })();
          for (const d of [-0.33, 0.33])
            pts.push([q[0] + d * epp, q[1] - d * epp], [q[0] - d * epp, q[1] + d * epp]);
        }
      for (let ci = 0; ci < p.curves.length; ci++) {
        const sb = sFirst + rows + ci,
          mb = cell.first + cell.idx.indexOf(ci);
        // (the points are the local patch's own, so already relative to O)
        const sa = constraintAnswers(seamRule, sb, pts, epp),
          ma = constraintAnswers(plane, mb, pts, epp);
        const c = p.curves[ci];
        const isCarried = !!c.cut || !!(bd[ci] && bd[ci].line && bd[ci].poseX && bd[ci].poseY);
        let same = true,
          maxCov = 0;
        for (let k = 0; k < sa.length; k++) {
          if (Object.is(sa[k], ma[k])) continue;
          same = false;
          if (k % OUTS.length === 0) maxCov = Math.max(maxCov, Math.abs(sa[k] - ma[k]));
        }
        if (isCarried) {
          carried++;
          if (!same) carriedBad++;
        } else {
          bounded++;
          if (!same) boundedDiff++;
          boundedCov = Math.max(boundedCov, maxCov);
        }
        if (same) exact++;
      }
    }
    ok(
      runs.length === patches.length,
      `${M.name} t=${t}: B. the static pack has one run per patch (${runs.length} for ${patches.length})`,
    );
    ok(
      carriedBad === 0,
      `${M.name} t=${t}: B. every constraint the morph CARRIES answers bitwise as the static one does (${carried - carriedBad}/${carried} cuts and ordered lines)`,
    );
    console.log(
      `  .. ${M.name} t=${t}: curves on the span's bounds ${bounded}, ${bounded - boundedDiff} of them bitwise identical too, worst coverage difference ${boundedCov.toFixed(4)}`,
    );

    // -- C: the picture, taken apart. Si is the static pack; S1 is its cover without hull rows (a
    // morph has none); S2 is S1 with the span's box and strip written into its blocks in place of the
    // pose's own -- the one thing a morph block cannot carry; Mi is the morph itself, whose remaining
    // difference is its cover: the span's dilated hull where the static pack draws the pose's own hull
    // with ramped skirts.
    const Si = paint(st.verts, seamRule, epp, x0, y0),
      Mi = paint(mesh.verts, plane, epp, x0, y0);
    const noRows = st.verts.slice(),
      spanBounds = seamRule.slice();
    for (let k = 0; k * PK.LB_STRIDE < noRows.length; k++) {
      const v = noRows.subarray(k * PK.LB_STRIDE),
        pi = runs.findIndex((r) => r[0] === v[19]);
      const rows = v[20] - patches[pi].curves.length;
      v[19] += rows;
      v[20] -= rows;
    }
    for (let pi = 0; pi < patches.length && runs.length === patches.length; pi++) {
      const [sFirst, sCount] = runs[pi],
        rows = sCount - patches[pi].curves.length;
      const cell = sh.plan2.cells.find((c) => c.pi === pi);
      for (let ci = 0; ci < patches[pi].curves.length; ci++) {
        const sb = (sFirst + rows + ci) * BF,
          mb = (cell.first + cell.idx.indexOf(ci)) * BF;
        const bez = (spanBounds[sb + 3] % 32) % 8 === 4; // texel 3 is coefficients, not a box
        for (let q = bez ? 16 : 12; q < 20; q++) spanBounds[sb + q] = plane[mb + q];
      }
    }
    const S1 = paint(noRows, seamRule, epp, x0, y0),
      S2 = paint(noRows, spanBounds, epp, x0, y0);
    let bMax = 0,
      bInk = 0;
    for (let k = 0; k < N * N; k++) {
      bMax = Math.max(bMax, Math.abs(S2[k] - S1[k]));
      bInk += S2[k] - S1[k];
    }
    ok(
      bMax <= 1 / 16,
      `${M.name} t=${t}: C. the span's box and strip in place of the pose's move no pixel by more than 1/16 (worst ${bMax.toFixed(4)}, ink ${bInk.toFixed(3)} px)`,
    );
    // THE REFERENCE, where it is needed: the pose's exact coverage, 32 x 32 samples a pixel against
    // exact crossings (rowSpans), at every pixel the two packs disagree on.
    const refAt = (k) => {
      const px = x0 + (k % N) * epp,
        py = y0 + Math.floor(k / N) * epp,
        SS = 32;
      let inside = 0;
      for (let b = 0; b < SS; b++) {
        const sp = rowSpans(curves, py + ((b + 0.5) * epp) / SS);
        for (let a = 0; a < SS; a++) {
          const x = px + ((a + 0.5) * epp) / SS;
          for (const [u, v] of sp)
            if (x >= u && x <= v) {
              inside++;
              break;
            }
        }
      }
      return inside / (SS * SS);
    };
    let inkS = 0,
      inkM = 0,
      dMax = 0,
      nDiff = 0,
      offBand = 0,
      worse = 0,
      worseBy = 0,
      eS = 0,
      eM = 0;
    for (let k = 0; k < N * N; k++) {
      inkS += Si[k];
      inkM += Mi[k];
      const d = Math.abs(Si[k] - Mi[k]);
      dMax = Math.max(dMax, d);
      if (!(d > 2 / 255)) continue;
      nDiff++;
      const px = x0 + ((k % N) + 0.5) * epp,
        py = y0 + (Math.floor(k / N) + 0.5) * epp;
      // THE AA BAND: the filter's reach (0.7072 px) plus the dilation a cover may carry past it.
      if (distToContour(curves, px, py) > 1.5 * epp) offBand++;
      const ref = refAt(k),
        es = Math.abs(Si[k] - ref),
        em = Math.abs(Mi[k] - ref);
      eS += es;
      eM += em;
      if (em > es + 2 / 255) {
        worse++;
        worseBy = Math.max(worseBy, em - es);
      }
    }
    console.log(
      `  .. ${M.name} t=${t}: static ink ${inkS.toFixed(1)} px, morph ${inkM.toFixed(1)} px; ${nDiff} px differ by more than 2/255 (worst ${dMax.toFixed(3)}), ` +
        `and there the error against the exact coverage sums to ${eS.toFixed(3)} static, ${eM.toFixed(3)} morph`,
    );
    ok(
      inkS > 0.25 * N * N,
      `${M.name} t=${t}: C. the static pack paints the pose (${inkS.toFixed(0)} px of ink)`,
    );
    ok(
      dMax < 0.5,
      `${M.name} t=${t}: C. no pixel of the morph is more than half off the static pack (worst ${dMax.toFixed(3)})`,
    );
    ok(
      offBand === 0,
      `${M.name} t=${t}: C. every one of the ${nDiff} differing px is in the outline's AA band (${offBand} outside it)`,
    );
    // A PATCH PAINTS nothing PAST ITS own ARC'S SEAM CORNER. A morph's cover is the span's dilated hull with
    // no skirt and no fence, so it reaches pixels a static cover stops short of; where two patches meet the outline at
    // one vertex through two different seams, both would claim the pixels past it, each by its own seam's extension
    // (the 12-cubic ring: 0.726 and 0.386 where the shape covers 0.476 and 0.215). So the kernel decides that corner
    // itself -- outside an outline arc and past its end where the patch's loop turns onto a seam, the patch paints
    // nothing -- and a line's floor past its own end holds only at such a corner (a star's tip: 0.128 against 0.048).
    ok(
      worse === 0,
      `${M.name} t=${t}: C. ...and at every one the morph is no further from the exact coverage than the static pack (${worse} are, by up to ${worseBy.toFixed(3)})`,
    );
    // -- R: the seam rule's own cost. The static pack as it ships, whose seams stand down past their spans, against the
    // morph: the pixels where the morph is further from the exact coverage than it.
    {
      const Sr = paint(st.verts, st.texels, epp, x0, y0);
      let rWorse = 0,
        rMax = 0;
      for (let k = 0; k < N * N; k++) {
        if (!(Math.abs(Sr[k] - Mi[k]) > 2 / 255)) continue;
        const ref = refAt(k),
          es = Math.abs(Sr[k] - ref),
          em = Math.abs(Mi[k] - ref);
        if (em > es + 2 / 255) {
          rWorse++;
          rMax = Math.max(rMax, em - es);
        }
      }
      rWorstAll = Math.max(rWorstAll, rWorse);
      console.log(
        `  .. ${M.name} t=${t}: R. against the static pack's own seams the morph is further from the exact coverage at ${rWorse} px (by up to ${rMax.toFixed(3)})`,
      );
    }

    // -- D: the GPU blend, over the global segment's three packed poses, at this pose's u.
    const gseg = cpatchGlobalSegment(morph, t),
      span = gseg.t1 - gseg.t0;
    const ats = [gseg.t0, gseg.t0 + span * 0.5, gseg.t1],
      snaps = [];
    const probe = {
      shapes: [{ A, B, plan, seg: -1, pack: null, first: 0, plan2: null, planBase: -1 }],
    };
    for (const ta of ats) {
      const r = setCPatchMorphT(probe, ta, sh.first, {}, true, ats[1]);
      if (!r || !probe.shapes[0].pack) break;
      snaps.push([{ first: probe.shapes[0].first, pack: probe.shapes[0].pack }]);
    }
    const nBlocks = sh.pack.texels.length / BF;
    if (snaps.length === 3 && probe.shapes[0].pack.texels.length === sh.pack.texels.length) {
      const planes = PK.packCPatchMorphPlanes(snaps[0], snaps[1], snaps[2], nBlocks, sh.first);
      const u = span > 0 ? (t - gseg.t0) / span : 0;
      const blended = blendTwin(planes, nBlocks, u);
      const bPlane = plane.slice();
      bPlane.set(blended, sh.first * BF);
      const Bi = paint(mesh.verts, bPlane, epp, x0, y0);
      let bMax = 0;
      for (let k = 0; k < N * N; k++) bMax = Math.max(bMax, Math.abs(Bi[k] - Mi[k]));
      ok(
        bMax <= 1 / 255,
        `${M.name} t=${t}: D. the GPU blend rebuilds the CPU pack's picture (worst ${(bMax * 255).toFixed(3)}/255)`,
      );
    } else ok(false, `${M.name} t=${t}: D. the blend's three poses packed (${snaps.length} of 3)`);
  }
}

console.log(fail ? `\ncpatchMorphLayoutSmoke FAIL (${fail})` : '\ncpatchMorphLayoutSmoke PASS');
process.exit(fail ? 1 : 0);
