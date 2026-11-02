// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbStaticDrawEmu.mjs — the CPU Loop-Blinn draw model of test/_lbMorphDrawEmu.mjs, extended for STATIC meshes
// and for the scoring streamDivergenceCost does. Copied rather than edited, so the shared morph model is untouched.
//
// Added: ARC crescents (kind 5), INTERIOR LINE ROWS (kind 0 with an edge line, up to three), cubic chain faces, the
// whole CURVE_BAND kernel (kind 12: the shared model ports its cubic morph rings only), a static ring's fill-side
// cession on kind 2, DISC (7: disc, annulus, ellipse, with the vertex push), EDGE_STRIP (10: the straight edge's
// exterior band and end wedges, with its vertex extrusion), CHAIN_STRIP (13), and the static route's two
// composites -- OVER accumulation for an opaque shape, the depth claim (first fragment owns the pixel) for a
// translucent one. Every kind the builders pack is modelled, so partial (edge) pixels can be scored as well.
import {
  exactBoxCov as boxCov,
  exactBoxCov2,
  chainBoxCov,
  cubicChainBoxCov,
} from './_lbBoxCov.mjs';
import { LB_VERT_FLOATS as VF } from '../../src/renderer/lbPack.js';

const slugCov = (f, g) => {
  const L = Math.max(Math.hypot(g[0], g[1]), 1e-6);
  return boxCov([g[0] / L, g[1] / L], -f / L);
};
const f32 = new Float32Array(1),
  u32 = new Uint32Array(f32.buffer);
const bitsOf = (f) => {
  f32[0] = f;
  return u32[0];
};
const fromBits = (u) => {
  u32[0] = u >>> 0;
  return f32[0];
};
const halfToF = (h) => {
  const s = h & 0x8000 ? -1 : 1,
    e = (h >> 10) & 31,
    m = h & 1023;
  return e === 0
    ? s * m * 2 ** -24
    : e === 31
      ? m
        ? NaN
        : s * Infinity
      : s * (1 + m / 1024) * 2 ** (e - 15);
};
const unpackHalf2 = (f) => {
  const u = bitsOf(f);
  return [halfToF(u & 0xffff), halfToF(u >>> 16)];
};
const unpackKlmGrad = (f) => {
  const u = bitsOf(f),
    s = fromBits(u & 0x7f800000) / 1024;
  const dx = ((u >>> 12) & 0x7ff) * s,
    dy = ((u >>> 1) & 0x7ff) * s;
  return [u & 0x80000000 ? -dx : dx, u & 1 ? -dy : dy];
};
const mixUnit = (a, b, t) => {
  const n = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    L = Math.hypot(n[0], n[1]);
  return L > 0 ? [n[0] / L, n[1] / L] : n;
};

function curveCov(f, fx, fy, fxx, fyy, fxy) {
  const g = Math.max(Math.hypot(fx, fy), 1e-6);
  const k = Math.max(
    -2,
    Math.min(2, (fxx * fy * fy - 2 * fxy * fx * fy + fyy * fx * fx) / (g * g * g)),
  );
  return boxCov([fx / g, fy / g], -f / g - k / 24);
}
/// _lbCoverage.glsl arcCov: curveCov with the curvature offset taken as the exact moment over the chord the pixel cuts.
function arcCov(f, fx, fy, fxx, fyy, fxy) {
  const g = Math.max(Math.hypot(fx, fy), 1e-6);
  const k = Math.max(
    -2,
    Math.min(2, (fxx * fy * fy - 2 * fxy * fx * fy + fyy * fx * fx) / (g * g * g)),
  );
  const n = [fx / g, fy / g],
    d = -f / g;
  let lo = -1e9,
    hi = 1e9;
  if (Math.abs(n[1]) > 1e-9) {
    const u0 = (d * n[0] - 0.5) / n[1],
      u1 = (d * n[0] + 0.5) / n[1];
    lo = Math.max(lo, Math.min(u0, u1));
    hi = Math.min(hi, Math.max(u0, u1));
  } else if (Math.abs(d * n[0]) > 0.5) {
    lo = 1;
    hi = -1;
  }
  if (Math.abs(n[0]) > 1e-9) {
    const v0 = (-0.5 - d * n[1]) / n[0],
      v1 = (0.5 - d * n[1]) / n[0];
    lo = Math.max(lo, Math.min(v0, v1));
    hi = Math.min(hi, Math.max(v0, v1));
  } else if (Math.abs(d * n[1]) > 0.5) {
    lo = 1;
    hi = -1;
  }
  const mom = hi > lo ? (lo * lo + lo * hi + hi * hi) / 6 : 0;
  return boxCov(n, d - k * mom);
}
/// The packed Bezout determinant (lbPack `bezout`: slots 7..21) and its em-gradient by cofactors, as kind 4 reads them.
function bezout(s, x, y) {
  const [m00a, m00b, m00c, m01a, m01b, m01c, m02a, m02b, m02c, m11a, m12, m22, cx, cy, sc] = s;
  const nx = (x - cx) / sc,
    ny = (y - cy) / sc,
    lin02 = m02b * nx + m02c * ny;
  const M00 = m00a + m00b * nx + m00c * ny,
    M01 = m01a + m01b * nx + m01c * ny,
    M02 = m02a + lin02,
    M11 = m11a + lin02;
  const det =
    M00 * (M11 * m22 - m12 * m12) - M01 * (M01 * m22 - m12 * M02) + M02 * (M01 * m12 - M11 * M02);
  const d00 = M11 * m22 - m12 * m12,
    d01 = -2 * M01 * m22 + 2 * M02 * m12,
    d02 = 2 * M01 * m12 - 2 * M02 * M11,
    d11 = M00 * m22 - M02 * M02;
  return [
    det,
    (d00 * m00b + d01 * m01b + (d02 + d11) * m02b) / sc,
    (d00 * m00c + d01 * m01c + (d02 + d11) * m02c) / sc,
  ];
}

function vertsAt({ S, D, n, lt: t }, emPerPx) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = S.subarray(i * VF, i * VF + VF),
      b = D.subarray(i * VF, i * VF + VF),
      L = (k) => a[k] + (b[k] - a[k]) * t;
    const kind = Math.round(a[5] - (a[5] % 1 === 0.25 ? 0.25 : 0)),
      sign = a[6],
      seam = a[23];
    const v = {
      kind,
      sign,
      seam,
      pos: [L(0), L(1)],
      tc: [L(2), L(3), L(4)],
      C0: [L(7), L(8), L(9), L(10)],
      C1: [L(11), L(12), L(13), L(14)],
      C2: [L(15), L(16), L(17), L(18)],
      C3: [L(19), L(20), L(21), L(22)],
    };
    let em = v.pos,
      vtc = v.tc;
    if (kind === 4 && seam > 5) {
      const n4 = mixUnit(unpackHalf2(a[22]), unpackHalf2(b[22]), t);
      if (n4[0] || n4[1]) em = [em[0] + n4[0] * 0.25 * emPerPx, em[1] + n4[1] * 0.25 * emPerPx];
    }
    if (kind === 7) {
      // DISC: every vertex pushed LB_DISC_PUSH (2) px out from the center
      const o7 = [v.pos[0] - v.C3[0], v.pos[1] - v.C3[1]],
        L7 = Math.max(Math.hypot(o7[0], o7[1]), 1e-9);
      em = [v.pos[0] + (o7[0] / L7) * 2.0 * emPerPx, v.pos[1] + (o7[1] / L7) * 2.0 * emPerPx];
    }
    if (kind === 10) {
      // EDGE_STRIP extrusion (_lbVertexSetup.glsl): the quad is built from the edge (aC3) and the vertex's role
      // aTC.x = tEnd + 2 sOuter -- inner verts ON the edge endpoints, outer verts out by nExt px and along by tExt px.
      const p1 = [v.C3[0], v.C3[1]],
        p2 = [v.C3[2], v.C3[3]],
        dL = Math.max(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), 1e-9);
      const td = [(p2[0] - p1[0]) / dL, (p2[1] - p1[1]) / dL],
        nOut = [-td[1] * sign, td[0] * sign];
      const tR = ((a[2] % 2) + 2) % 2,
        sR = Math.floor(a[2] / 2 + 0.25),
        base = tR < 0.5 ? p1 : p2;
      let tExt = 3.2,
        nExt = 0.8;
      if (sR >= 0.5) {
        const cA = Math.floor((seam + 0.5) / 16),
          cB = seam - cA * 16,
          code = tR < 0.5 ? cA : cB;
        const ty = Math.floor((code + 0.5) / 4) - 1,
          curve = code % 4 >= 1.5;
        if (ty > 0.5 && !curve) {
          const nN = tR < 0.5 ? [v.C0[0], v.C0[1]] : [v.C0[2], v.C0[3]],
            nd = nOut[0] * nN[0] + nOut[1] * nN[1];
          if (nd < -0.35) {
            const bo = 1 + 0.55 * Math.max(0, Math.min(1.35, -0.35 - nd));
            tExt *= bo;
            nExt *= bo;
          }
        }
      }
      const ts = (tR < 0.5 ? -tExt : tExt) * (sR < 0.5 ? 0 : emPerPx),
        ns = (sR < 0.5 ? 0 : nExt) * emPerPx;
      em = [base[0] + td[0] * ts + nOut[0] * ns, base[1] + td[1] * ts + nOut[1] * ns];
    }
    if (kind === 12) {
      v.nOA = mixUnit(unpackHalf2(a[15]), unpackHalf2(b[15]), t);
      v.nOB = mixUnit(unpackHalf2(a[16]), unpackHalf2(b[16]), t);
      const amt = 0.25 * emPerPx;
      em = [v.pos[0] + v.C0[0] * amt, v.pos[1] + v.C0[1] * amt];
      if (Math.abs(sign) >= 8192) {
        const ga = unpackKlmGrad(a[9]),
          gb = unpackKlmGrad(b[9]);
        vtc = [
          v.tc[0] + (ga[0] + (gb[0] - ga[0]) * t) * amt,
          v.tc[1] + (ga[1] + (gb[1] - ga[1]) * t) * amt,
          v.tc[2] + v.C0[3] * amt,
        ];
      } else vtc = [v.tc[0] + v.C0[2] * amt, v.tc[1] + v.C0[3] * amt, v.tc[2]];
    }
    v.em = em;
    v.vtc = vtc;
    out[i] = v;
  }
  return out;
}

/// Render `packs` into an N x N canvas over `bb` (a square xywh em box, the morph bundle's globalBBox). Returns per-pixel
/// coverage (-1 where no fragment survived) and the set of kernel features the model met but does not model.
/// `who`, when given, is a Map filled with pixel index -> [{ tri, kind, c }] for every fragment that painted.
export function renderStatic(packs, bb, N = 256, claim = false, who = null) {
  const emPerPx = bb[2] / N,
    verts = vertsAt(packs, emPerPx);
  const toPx = (p) => [((p[0] - bb[0]) / bb[2]) * N, ((p[1] - bb[1]) / bb[3]) * N];
  const toEm = (x, y) => [bb[0] + (x / N) * bb[2], bb[1] + (y / N) * bb[3]];
  const cov = new Float32Array(N * N).fill(-1),
    unmodelled = new Set();
  for (let tri = 0; tri + 2 < verts.length; tri += 3) {
    const V = [verts[tri], verts[tri + 1], verts[tri + 2]],
      P = V[2],
      E = V.map((v) => v.em),
      px = E.map(toPx);
    const ex1 = E[1][0] - E[0][0],
      ey1 = E[1][1] - E[0][1],
      ex2 = E[2][0] - E[0][0],
      ey2 = E[2][1] - E[0][1];
    const det = ex1 * ey2 - ey1 * ex2;
    if (!(Math.abs(det) > 0)) continue;
    const grad = [0, 1, 2].map((j) => {
      const d1 = V[1].vtc[j] - V[0].vtc[j],
        d2 = V[2].vtc[j] - V[0].vtc[j];
      return [(d1 * ey2 - d2 * ey1) / det, (d2 * ex1 - d1 * ex2) / det];
    });
    const tcAt = (x, y) =>
      [0, 1, 2].map((j) => V[0].vtc[j] + grad[j][0] * (x - E[0][0]) + grad[j][1] * (y - E[0][1]));
    const kind = P.kind,
      pdet = Math.sign(
        (px[1][0] - px[0][0]) * (px[2][1] - px[0][1]) -
          (px[1][1] - px[0][1]) * (px[2][0] - px[0][0]),
      );
    const X0 = Math.max(0, Math.floor(Math.min(px[0][0], px[1][0], px[2][0]))),
      X1 = Math.min(N - 1, Math.ceil(Math.max(px[0][0], px[1][0], px[2][0])));
    const Y0 = Math.max(0, Math.floor(Math.min(px[0][1], px[1][1], px[2][1]))),
      Y1 = Math.min(N - 1, Math.ceil(Math.max(px[0][1], px[1][1], px[2][1])));
    for (let y = Y0; y <= Y1; y++)
      for (let x = X0; x <= X1; x++) {
        const idx = y * N + x;
        if (claim && cov[idx] >= 0) continue; // translucent: LESS + depth claim, first fragment owns
        const cx = x + 0.5,
          cy = y + 0.5,
          e = (i, j) =>
            ((px[j][0] - px[i][0]) * (cy - px[i][1]) - (px[j][1] - px[i][1]) * (cx - px[i][0])) *
            pdet;
        if (e(0, 1) < 0 || e(1, 2) < 0 || e(2, 0) < 0) continue;
        const [ex, ey] = toEm(cx, cy);
        let c;
        if (kind === 0) {
          if (P.vtc[0] > 1.5) {
            // chain mode: the chain kernels, chain 2 by min()
            const inv = 1 / emPerPx,
              cell = (q) => [(q[0] - ex) * inv, (q[1] - ey) * inv];
            const c1 = [
              [P.C3[0], P.C3[1]],
              [P.C3[2], P.C3[3]],
              [P.C0[0], P.C0[1]],
              [P.C0[2], P.C0[3]],
              [P.vtc[1], P.vtc[2]],
            ].map(cell);
            // _lbCoverage.glsl's chain branch: a cubic chain (modes 4, 5), else straight.
            c =
              P.vtc[0] > 3.5
                ? cubicChainBoxCov(c1[0], c1[1], c1[2], c1[3], c1[4], P.vtc[0] > 4.5, 2.0)
                : chainBoxCov(c1[0], c1[1], c1[2], c1[3], c1[4], 2.0);
            const ch2 = [
              [P.C1[0], P.C1[1]],
              [P.C1[2], P.C1[3]],
              [P.C2[0], P.C2[1]],
              [P.C2[2], P.C2[3]],
            ];
            if (ch2.some((q) => q[0] !== 0 || q[1] !== 0)) {
              const d = ch2.map(cell);
              const c2 =
                P.seam > 0.5
                  ? cubicChainBoxCov(d[0], d[1], d[2], d[3], d[3], false, 1.0)
                  : chainBoxCov(d[0], d[1], d[2], d[3], d[3], 1.0);
              c = Math.min(c, c2);
            }
          } else if (P.C3[0] || P.C3[1]) {
            // INTERIOR LINE ROWS (_lbCoverage.glsl, LB_IS_INTERIOR after the chain branch): the edge line in
            // aC3 (normal, offset), a second in aC0.xyz typed by aC0.w, a third in vTC typed by aC3.w.
            const inv = 1 / emPerPx,
              n1 = [P.C3[0], P.C3[1]],
              fi = n1[0] * ex + n1[1] * ey - P.C3[2];
            let cA = slugCov(fi, [n1[0] * emPerPx, n1[1] * emPerPx]);
            if (Math.abs(P.C0[3]) > 0.5) {
              const n2 = [P.C0[0], P.C0[1]],
                fiB = n2[0] * ex + n2[1] * ey - P.C0[2];
              const cB = slugCov(fiB, [n2[0] * emPerPx, n2[1] * emPerPx]);
              const inter =
                cA <= 0 || cB <= 0
                  ? 0
                  : cA >= 1
                    ? cB
                    : cB >= 1
                      ? cA
                      : exactBoxCov2(n1, -fi * inv, n2, -fiB * inv);
              cA = P.C0[3] > 0 ? inter : cA + cB - inter;
            }
            if (Math.abs(P.C3[3]) > 0.5 && P.vtc[0] * P.vtc[0] + P.vtc[1] * P.vtc[1] > 1e-9) {
              const cC = slugCov(P.vtc[0] * ex + P.vtc[1] * ey - P.vtc[2], [
                P.vtc[0] * emPerPx,
                P.vtc[1] * emPerPx,
              ]);
              cA = P.C3[3] > 0 ? Math.max(0, cA + cC - 1) : cA + cC - cA * cC;
            }
            c = cA;
          } else c = 1;
        } else if (kind === 2) {
          const k = tcAt(ex, ey),
            sg = P.sign;
          const tx = grad.map((g) => g[0] * emPerPx),
            ty = grad.map((g) => g[1] * emPerPx);
          const f = sg * (k[0] ** 3 - k[1] * k[2]);
          const fx = sg * (3 * k[0] * k[0] * tx[0] - (tx[1] * k[2] + k[1] * tx[2])),
            fy = sg * (3 * k[0] * k[0] * ty[0] - (ty[1] * k[2] + k[1] * ty[2]));
          const fxx = sg * (6 * k[0] * tx[0] * tx[0] - 2 * tx[1] * tx[2]),
            fyy = sg * (6 * k[0] * ty[0] * ty[0] - 2 * ty[1] * ty[2]);
          const fxy = sg * (6 * k[0] * tx[0] * ty[0] - (tx[1] * ty[2] + ty[1] * tx[2]));
          if (P.seam > 0.5 && P.seam < 5) {
            // ring-less piece: its own end-tangent planes
            const eps = 0.05 * emPerPx;
            if (
              (ex - P.C3[0]) * P.C0[0] + (ey - P.C3[1]) * P.C0[1] < -eps ||
              (ex - P.C3[2]) * P.C0[2] + (ey - P.C3[3]) * P.C0[3] < -eps
            )
              continue;
          }
          c = curveCov(f, fx, fy, fxx, fyy, fxy);
          if (P.seam > 5 && c < 0.999 && f < 0) continue; // an exterior ring cedes the fill side
        } else if (kind === 12) {
          // CURVE_BAND, the whole kernel (_lbCoverage.glsl LB_IS_CURVE_BAND): quad and cubic bands, span and bisector
          // clips, the hull-turf and inside discards, the end combines and the ribbon / near-zero gates.
          const k = tcAt(ex, ey),
            tx = grad.map((g) => g[0] * emPerPx),
            ty = grad.map((g) => g[1] * emPerPx);
          let mag = Math.abs(P.sign);
          const s12 = P.sign >= 0 ? 1 : -1;
          let cubic = false;
          if (mag >= 8192) {
            cubic = true;
            mag -= 8192;
          }
          if (mag >= 4096) mag -= 4096;
          let spanB = 0,
            spanA = 0;
          if (mag >= 2048) {
            spanB = 1;
            mag -= 2048;
          }
          if (mag >= 1024) {
            spanA = 1;
            mag -= 1024;
          }
          const codeA = Math.floor((mag + 0.5) / 16),
            codeB = mag - codeA * 16;
          const tyA = Math.floor((codeA + 0.5) / 4) - 1,
            tyB = Math.floor((codeB + 0.5) / 4) - 1;
          const a12 = [P.C3[0], P.C3[1]],
            b12 = [P.C3[2], P.C3[3]],
            rA = [ex - a12[0], ey - a12[1]],
            rB = [ex - b12[0], ey - b12[1]];
          const nA = [P.C1[0], P.C1[1]],
            nB = [P.C1[2], P.C1[3]],
            nOA = P.nOA,
            nOB = P.nOB,
            kA = P.C2[2],
            kB = P.C2[3];
          const dot2 = (p, q) => p[0] * q[0] + p[1] * q[1];
          const ends = cubic && dot2(a12, a12) + dot2(b12, b12) > 0;
          const [u, v, r] = k;
          let f, fx, fy, fxx, fyy, fxy;
          if (cubic) {
            f = s12 * (u * u * u - v * r);
            fx = s12 * (3 * u * u * tx[0] - (tx[1] * r + v * tx[2]));
            fy = s12 * (3 * u * u * ty[0] - (ty[1] * r + v * ty[2]));
            fxx = s12 * (6 * u * tx[0] * tx[0] - 2 * tx[1] * tx[2]);
            fyy = s12 * (6 * u * ty[0] * ty[0] - 2 * ty[1] * ty[2]);
            fxy = s12 * (6 * u * tx[0] * ty[0] - (tx[1] * ty[2] + ty[1] * tx[2]));
          } else {
            f = s12 * (u * u - v * r);
            fx = s12 * (2 * u * tx[0] - (tx[1] * r + v * tx[2]));
            fy = s12 * (2 * u * ty[0] - (ty[1] * r + v * ty[2]));
            fxx = s12 * (2 * tx[0] * tx[0] - 2 * tx[1] * tx[2]);
            fyy = s12 * (2 * ty[0] * ty[0] - 2 * ty[1] * ty[2]);
            fxy = s12 * (2 * tx[0] * ty[0] - (tx[1] * ty[2] + ty[1] * tx[2]));
          }
          if (cubic && !ends) {
            c = curveCov(f, fx, fy, fxx, fyy, fxy);
            if (c < 0.999 && f < 0) continue;
            if (c < 0.004) continue;
          } else {
            if (!cubic && Math.abs(r - 1) < 1e-3 && v >= 0 && u >= v && 1 - 2 * u + v >= 0)
              continue; // hull turf
            const sA = [-nOA[1] * (spanA ? 1 : -1), nOA[0] * (spanA ? 1 : -1)],
              sB = [-nOB[1] * (spanB ? 1 : -1), nOB[0] * (spanB ? 1 : -1)];
            const dpx = f / Math.max(Math.hypot(fx, fy), 1e-6);
            const chainA = Math.abs(tyA) > 0.5,
              chainB = Math.abs(tyB) > 0.5;
            if (!chainA) {
              if (dot2(rA, sA) < 0) continue;
            } else {
              const bis = [nOA[0] + nA[0], nOA[1] + nA[1]];
              if (dot2(bis, bis) > 1e-6) {
                const w = [-bis[1], bis[0]];
                if (dot2(rA, w) * dot2(w, sA) < 0) continue;
              } else if (dot2(rA, sA) < 0) continue;
            }
            if (!chainB) {
              if (dot2(rB, sB) < 0) continue;
            } else {
              const bis = [nOB[0] + nB[0], nOB[1] + nB[1]];
              if (dot2(bis, bis) > 1e-6) {
                const w = [-bis[1], bis[0]];
                if (dot2(rB, w) * dot2(w, sB) <= 0) continue;
              } else if (dot2(rB, sB) < 0) continue;
            }
            const wgA = chainA && dot2(rA, sA) < 0,
              wgB = chainB && dot2(rB, sB) < 0;
            const fA = dot2(nA, rA) - 0.5 * kA * dot2(rA, rA),
              fB = dot2(nB, rB) - 0.5 * kB * dot2(rB, rB);
            const gL = Math.max(Math.hypot(fx, fy), 1e-6);
            const kOwnS = (fxx * fy * fy - 2 * fxy * fx * fy + fyy * fx * fx) / (gL * gL * gL),
              kOwnPx = Math.abs(kOwnS);
            const invPx = 1 / Math.max(emPerPx, 1e-12);
            let fOwn, nOwn, dOwn;
            if (wgA || wgB) {
              const nOw = wgA ? nOA : nOB,
                rw = wgA ? rA : rB,
                L = Math.max(Math.hypot(nOw[0], nOw[1]), 1e-9);
              fOwn = dot2(nOw, rw);
              nOwn = [nOw[0] / L, nOw[1] / L];
              dOwn = -fOwn / (L * Math.max(emPerPx, 1e-12));
            } else {
              fOwn = f;
              nOwn = [fx / gL, fy / gL];
              dOwn = -f / gL - Math.max(-2, Math.min(2, kOwnS)) / 24;
            }
            const cOwn = boxCov(nOwn, dOwn);
            const rgA =
              0.5 / Math.max(Math.max(Math.abs(kA), 1e-6) * emPerPx, Math.max(kOwnPx, 1e-6));
            const rgB =
              0.5 / Math.max(Math.max(Math.abs(kB), 1e-6) * emPerPx, Math.max(kOwnPx, 1e-6));
            const gA = Math.max(0, Math.min(1, rgA - Math.hypot(rA[0], rA[1]) / emPerPx));
            const gB = Math.max(0, Math.min(1, rgB - Math.hypot(rB[0], rB[1]) / emPerPx));
            const cnA = Math.abs(tyA) > 0.5,
              cnB = Math.abs(tyB) > 0.5;
            const sOwn = fOwn < 0 ? 1 : 0,
              sAi = fA < 0 ? 1 : 0,
              sBi = fB < 0 ? 1 : 0;
            const sAe = tyA > 0.5 ? (gA > 0 ? sAi : 1) : gA > 0 ? sAi : 0,
              sBe = tyB > 0.5 ? (gB > 0 ? sBi : 1) : gB > 0 ? sBi : 0;
            let insid = sOwn;
            if (cnA) insid = tyA > 0.5 ? Math.min(insid, sAe) : Math.max(insid, sAe);
            if (cnB) insid = tyB > 0.5 ? Math.min(insid, sBe) : Math.max(insid, sBe);
            if (insid > 0.5) continue;
            const mix = (x0, y0, t0) => x0 + (y0 - x0) * t0,
              cl = (x0) => Math.max(0, Math.min(1, x0));
            let c12 = cOwn;
            if (cnA && gA > 0) {
              const L = Math.max(Math.hypot(nA[0], nA[1]), 1e-9),
                nAn = [nA[0] / L, nA[1] / L],
                dA = -fA * invPx;
              const cA = boxCov(nAn, dA),
                inter = exactBoxCov2(nOwn, dOwn, nAn, dA),
                kp = Math.max(0, dot2(nOA, nA));
              const exA =
                tyA > 0
                  ? mix(cl(c12 + inter - cOwn), Math.min(c12, cA), kp)
                  : mix(cl(c12 + cA - inter), Math.max(c12, cA), kp);
              c12 = mix(c12, exA, gA);
            }
            if (cnB && gB > 0) {
              const L = Math.max(Math.hypot(nB[0], nB[1]), 1e-9),
                nBn = [nB[0] / L, nB[1] / L],
                dB = -fB * invPx;
              const cB = boxCov(nBn, dB),
                inter = exactBoxCov2(nOwn, dOwn, nBn, dB),
                kp = Math.max(0, dot2(nOB, nB));
              const exB =
                tyB > 0
                  ? mix(cl(c12 + inter - cOwn), Math.min(c12, cB), kp)
                  : mix(cl(c12 + cB - inter), Math.max(c12, cB), kp);
              c12 = mix(c12, exB, gB);
            }
            if (c12 <= 0) continue;
            if (!wgA && !wgB && f < 0 && c12 < 0.999) continue;
            if (!wgA && !wgB && fOwn >= 0 && s12 < 0) {
              const ab = [b12[0] - a12[0], b12[1] - a12[1]],
                L2 = Math.max(dot2(ab, ab), 1e-12);
              const t0 = Math.max(0, Math.min(1, dot2(rA, ab) / L2)),
                dCh = Math.hypot(rA[0] - ab[0] * t0, rA[1] - ab[1] * t0) / Math.max(emPerPx, 1e-9);
              if (dCh > 1.5 && Math.abs(dpx) < 1) continue;
              if (dCh > 1.2 && Math.abs(dpx) < 0.7 && c12 < 0.95) continue;
            }
            if (!wgA && !wgB && fOwn >= 0 && c12 < 0.12) {
              if (gA > 0 && dot2(nA, rA) < 0) continue;
              if (gB > 0 && dot2(nB, rB) < 0) continue;
            }
            c = c12;
          }
        } else if (kind === 4) {
          const k = tcAt(ex, ey),
            sl = [...P.C0, ...P.C1, ...P.C2, ...P.C3.slice(0, 3)];
          const [F, gx, gy] = bezout(sl, ex, ey),
            f = P.sign * F;
          if (k[0] * k[0] + k[1] * k[1] > 0 && k[0] * ex + k[1] * ey > k[2] + 0.25 * emPerPx)
            c = 0; // keep half-plane
          else {
            const h = 1e-3 * emPerPx,
              [, gx1, gy1] = bezout(sl, ex + h, ey),
              [, gx2, gy2] = bezout(sl, ex, ey + h),
              q = (emPerPx * emPerPx) / h;
            c = curveCov(
              f,
              P.sign * gx * emPerPx,
              P.sign * gy * emPerPx,
              P.sign * (gx1 - gx) * q,
              P.sign * (gy2 - gy) * q,
              P.sign * (gx2 - gx) * q,
            );
          }
          if (P.seam > 5 && c < 0.999 && f < 0) continue;
        } else if (kind === 5) {
          // ARC (_lbCoverage.glsl): f = s(U^2 - V R), the chord-span clip, curveCov, and a lone crescent's chord edge.
          const a = [P.C3[0], P.C3[1]],
            b = [P.C3[2], P.C3[3]],
            ch = [b[0] - a[0], b[1] - a[1]];
          if (
            ch[0] * ch[0] + ch[1] * ch[1] > 1e-9 &&
            ((ex - a[0]) * ch[0] + (ey - a[1]) * ch[1] < 0 ||
              (ex - b[0]) * ch[0] + (ey - b[1]) * ch[1] > 0)
          )
            continue;
          const k = tcAt(ex, ey),
            s5 = P.sign > 0 ? 1 : -1;
          const tx = grad.map((g) => g[0] * emPerPx),
            ty = grad.map((g) => g[1] * emPerPx);
          const [U, V, Rr] = k,
            f = s5 * (U * U - V * Rr);
          const fx = s5 * (2 * U * tx[0] - (tx[1] * Rr + V * tx[2])),
            fy = s5 * (2 * U * ty[0] - (ty[1] * Rr + V * ty[2]));
          const fxx = s5 * (2 * tx[0] * tx[0] - 2 * tx[1] * tx[2]),
            fyy = s5 * (2 * ty[0] * ty[0] - 2 * ty[1] * ty[2]);
          const fxy = s5 * (2 * tx[0] * ty[0] - (tx[1] * ty[2] + ty[1] * tx[2]));
          c = curveCov(f, fx, fy, fxx, fyy, fxy);
          if (Math.abs(P.sign) > 2)
            c = Math.min(c, slugCov(s5 * (V - U), [s5 * (tx[1] - tx[0]), s5 * (ty[1] - ty[0])]));
        } else if (kind === 10) {
          // EDGE_STRIP (_lbCoverage.glsl LB_IS_EDGE_STRIP): a straight edge's exterior band and both end wedges.
          const dot2 = (p, q) => p[0] * q[0] + p[1] * q[1];
          const p1 = [P.C3[0], P.C3[1]],
            p2 = [P.C3[2], P.C3[3]],
            dL = Math.max(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), 1e-9);
          const td = [(p2[0] - p1[0]) / dL, (p2[1] - p1[1]) / dL],
            nOwn = [-td[1] * P.sign, td[0] * P.sign];
          const rA = [ex - p1[0], ey - p1[1]],
            rB = [ex - p2[0], ey - p2[1]],
            fOwn = dot2(nOwn, rA);
          const codeA = Math.floor((P.seam + 0.5) / 16),
            codeB = P.seam - codeA * 16;
          const tyA = Math.floor((codeA + 0.5) / 4) - 1,
            curveA = codeA % 4 >= 1.5,
            tsA = codeA % 2;
          const tyB = Math.floor((codeB + 0.5) / 4) - 1,
            curveB = codeB % 4 >= 1.5,
            tsB = codeB % 2;
          const nA = [P.C0[0], P.C0[1]],
            nB = [P.C0[2], P.C0[3]];
          if (curveA) {
            const wA = [-nA[1] * (tsA > 0.5 ? 1 : -1), nA[0] * (tsA > 0.5 ? 1 : -1)];
            if (
              dot2(rA, wA) >= 0 &&
              Math.hypot(rA[0], rA[1]) < 2.5 * emPerPx &&
              fOwn > 0.35 * emPerPx
            )
              continue;
          } else {
            const nDotA = dot2(nOwn, nA),
              acuteA = tyA > 0.5 && nDotA < -0.35,
              sumA = [nOwn[0] + nA[0], nOwn[1] + nA[1]];
            const degenA = dot2(sumA, sumA) < 0.08,
              tipA = acuteA && fOwn > 0 && Math.hypot(rA[0], rA[1]) < 2.2 * emPerPx;
            if (!(tipA && (acuteA || degenA))) {
              let wA = degenA ? [-nOwn[1], nOwn[0]] : [-sumA[1], sumA[0]];
              if (dot2(wA, td) < 0) wA = [-wA[0], -wA[1]];
              if (dot2(rA, wA) < 0) continue;
            }
          }
          if (curveB) {
            const wB = [-nB[1] * (tsB > 0.5 ? 1 : -1), nB[0] * (tsB > 0.5 ? 1 : -1)];
            if (
              dot2(rB, wB) >= 0 &&
              Math.hypot(rB[0], rB[1]) < 2.5 * emPerPx &&
              fOwn > 0.35 * emPerPx
            )
              continue;
          } else {
            const nDotB = dot2(nOwn, nB),
              acuteB = tyB > 0.5 && nDotB < -0.35;
            if (acuteB && fOwn > 0 && dot2(nB, rB) > 0 && Math.hypot(rB[0], rB[1]) < 2.2 * emPerPx)
              continue;
            const sumB = [nOwn[0] + nB[0], nOwn[1] + nB[1]],
              degenB = dot2(sumB, sumB) < 0.08;
            let wB = degenB ? [-nOwn[1], nOwn[0]] : [-sumB[1], sumB[0]];
            if (dot2(wB, td) < 0) wB = [-wB[0], -wB[1]];
            if (dot2(rB, wB) >= 0) continue;
          }
          const fA = dot2(nA, rA) - 0.5 * P.tc[1] * dot2(rA, rA),
            fB = dot2(nB, rB) - 0.5 * P.tc[2] * dot2(rB, rB);
          const tgA = tyA > 0.5 && !curveA && dot2(nOwn, nA) < -0.35 ? 2.2 : 2.0,
            tgB = tyB > 0.5 && !curveB && dot2(nOwn, nB) < -0.35 ? 2.2 : 2.0;
          const cl = (x0) => Math.max(0, Math.min(1, x0)),
            mix = (x0, y0, t0) => x0 + (y0 - x0) * t0;
          const gA = cl((tgA - Math.hypot(rA[0], rA[1]) / emPerPx) / 1.5),
            gB = cl((tgB - Math.hypot(rB[0], rB[1]) / emPerPx) / 1.5);
          if (fOwn < -1.2 * emPerPx) continue;
          const sOwn = fOwn < -0.012 * emPerPx ? 1 : 0,
            sAi = fA < 0 ? 1 : 0,
            sBi = fB < 0 ? 1 : 0;
          const sAe = tyA > 0.5 ? (gA > 0.01 ? sAi : 1) : gA > 0.01 ? sAi : 0,
            sBe = tyB > 0.5 ? (gB > 0.01 ? sBi : 1) : gB > 0.01 ? sBi : 0;
          let insid = sOwn;
          insid = tyA > 0.5 ? Math.min(insid, sAe) : tyA < -0.5 ? Math.max(insid, sAe) : insid;
          insid = tyB > 0.5 ? Math.min(insid, sBe) : tyB < -0.5 ? Math.max(insid, sBe) : insid;
          if (insid > 0.5) continue;
          const invPx = 1 / Math.max(emPerPx, 1e-12),
            dOwn = -fOwn * invPx;
          let c10 = boxCov(nOwn, dOwn);
          const cOwnP = c10;
          if (Math.abs(tyA) > 0.5 && gA > 0) {
            const L = Math.max(Math.hypot(nA[0], nA[1]), 1e-9),
              nAn = [nA[0] / L, nA[1] / L],
              dA = -fA * invPx;
            const cA = boxCov(nAn, dA),
              inter = exactBoxCov2(nOwn, dOwn, nAn, dA),
              kp = Math.max(0, dot2(nOwn, nA));
            const exA =
              tyA > 0
                ? mix(cl(c10 + inter - cOwnP), Math.min(c10, cA), kp)
                : mix(cl(c10 + cA - inter), Math.max(c10, cA), kp);
            c10 = mix(c10, exA, gA);
          }
          if (Math.abs(tyB) > 0.5 && gB > 0) {
            const L = Math.max(Math.hypot(nB[0], nB[1]), 1e-9),
              nBn = [nB[0] / L, nB[1] / L],
              dB = -fB * invPx;
            const cB = boxCov(nBn, dB),
              inter = exactBoxCov2(nOwn, dOwn, nBn, dB),
              kp = Math.max(0, dot2(nOwn, nB));
            const exB =
              tyB > 0
                ? mix(cl(c10 + inter - cOwnP), Math.min(c10, cB), kp)
                : mix(cl(c10 + cB - inter), Math.max(c10, cB), kp);
            c10 = mix(c10, exB, gB);
          }
          if (c10 < 0.004) continue;
          c = c10;
        } else if (kind === 13) {
          // CHAIN_STRIP: a thin band along one edge carrying that edge's local chain, chainBoxCov in exterior-aware mode.
          const inv = 1 / emPerPx,
            cell = (q) => [(q[0] - ex) * inv, (q[1] - ey) * inv];
          const q = [
            [P.C3[0], P.C3[1]],
            [P.C3[2], P.C3[3]],
            [P.C0[0], P.C0[1]],
            [P.C0[2], P.C0[3]],
          ].map(cell);
          c = chainBoxCov(q[0], q[1], q[2], q[3], q[3], 0.0);
        } else if (kind === 7 || kind === 6) {
          // DISC (_lbCoverage.glsl): disc, annulus (cHalf >= 0) or ellipse (cHalf < -1.5) SDF with its analytic gradient
          // and curvature; arcCov for a circle / annulus, curveCov for an ellipse.
          const d7 = [ex - P.C3[0], ey - P.C3[1]],
            cScale = P.C3[2],
            cHalf = P.C3[3],
            sg = P.sign;
          let f, G, W, w;
          if (cHalf < -1.5) {
            const rx = Math.max(cScale, 1e-9),
              ry = Math.max(P.C0[0], 1e-9),
              c7 = P.C0[1],
              s7 = P.C0[2];
            const q7 = [(d7[0] * c7 + d7[1] * s7) / rx, (-d7[0] * s7 + d7[1] * c7) / ry],
              Lq = Math.max(Math.hypot(q7[0], q7[1]), 1e-9);
            f = sg * (Lq - 1);
            const qh = [q7[0] / Lq, q7[1] / Lq],
              th = [-qh[1], qh[0]];
            G = [
              sg * ((qh[0] * c7) / rx - (qh[1] * s7) / ry),
              sg * ((qh[0] * s7) / rx + (qh[1] * c7) / ry),
            ];
            W = [(th[0] * c7) / rx - (th[1] * s7) / ry, (th[0] * s7) / rx + (th[1] * c7) / ry];
            w = sg / Lq;
          } else {
            const L7 = Math.max(Math.hypot(d7[0], d7[1]), 1e-9),
              dh = [d7[0] / L7, d7[1] / L7];
            let sig = 1,
              halfW = 0;
            if (kind === 7 && cHalf >= 0) {
              sig = L7 >= cScale ? 1 : -1;
              halfW = cHalf;
            }
            f = sg * (sig * (L7 - cScale) - halfW);
            G = [sg * sig * dh[0], sg * sig * dh[1]];
            W = [-dh[1], dh[0]];
            w = (sg * sig) / L7;
          }
          const fx = G[0] * emPerPx,
            fy = G[1] * emPerPx,
            wx = W[0] * emPerPx,
            wy = W[1] * emPerPx;
          c =
            cHalf < -1.5
              ? curveCov(f, fx, fy, w * wx * wx, w * wy * wy, w * wx * wy)
              : arcCov(f, fx, fy, w * wx * wx, w * wy * wy, w * wx * wy);
        } else {
          unmodelled.add('kind ' + kind);
          c = 1;
        }
        if (c < 0.004) continue;
        if (who) {
          let l = who.get(idx);
          if (!l) who.set(idx, (l = []));
          l.push({ tri, kind, c });
        }
        cov[idx] = claim ? c : cov[idx] < 0 ? c : 1 - (1 - cov[idx]) * (1 - c); // opaque: OVER accumulates
      }
  }
  return { cov, unmodelled: [...unmodelled] };
}
