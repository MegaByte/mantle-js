// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbMorphDrawEmu — a CPU model of the Loop-Blinn morph draw at t, for node smokes that have no GPU.
//
// What it models, and where each part comes from:
//   - the VERTEX stage's mix (mantle.vert.glsl, MANTLE_LB_MORPH): every slot of the two endpoint packs mixed by t, with
//     the packed-bit slots mixed as the vectors they hold (lbMixKlmGrad, lbMixHalfUnit);
//   - _lbVertexSetup.glsl's ring pushes (kind 4 and kind 12, a quarter pixel along the ring normal, klm carried out by
//     its gradient) -- everything else stays where the pack put it;
//   - ONE FRAGMENT PER COVERED PIXEL CENTER, flat slots from the provoking (last) vertex, vTC affine over the triangle;
//   - _lbCoverage.glsl's per-kind coverage: curveCov (a CPU twin) for the klm and Bezout kinds from their analytic screen
//     derivatives, the Bezout keep half-plane, the ring claim rules, the curve band's span clips, and the INTERIOR chain
//     through chainBoxCov's line-for-line CPU twin (probes/lbAccuracy/_lbBoxCov.mjs), and a cubic chain (sentinels 4 / 5,
//     chain 2 flagged in aSeamM) through cubicChainBoxCov's;
//   - the morph route's DEPTH CLAIM (unifiedFillDraw: LESS, one z per shape), so the first surviving fragment in
//     primitive order owns its pixel.
// NOT modelled: a curve band's CHAINED ends (the corner combine at a typed joint); `render` reports them.
//
// Calibrated against the GPU on the two ring morphs (probes/morph/_morphExactRef.mjs, ANGLE Metal, 256 px): the model's
// counts of pixels off exact by more than 32/255 at t = 0.2 / 0.45 / 0.7 track the GPU's to within about 16 px.
import {
  exactBoxCov as boxCov,
  chainBoxCov,
  cubicChainBoxCov,
} from '../probes/lbAccuracy/_lbBoxCov.mjs';
import { bezKeepCov } from '../probes/lbAccuracy/_lbKernel.mjs';
import { packLoopBlinnMesh, LB_VERT_FLOATS as VF } from '../src/renderer/lbPack.js';
import { rayWinding } from '../src/geom/lbContour.js';

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
/// _lbCoverage.glsl's lbTangentTriDist, line for line: the distance from p (relative to the piece's
/// start a) to the triangle its chord ab and its end tangents make, or `chordD` when the tangents are
/// near parallel or meet further out than the chord is long.
export function tangentTriDist(p, ab, nA, nB, chordD) {
  const det = nA[0] * nB[1] - nA[1] * nB[0],
    L = Math.hypot(ab[0], ab[1]);
  if (!(Math.abs(det) > 1e-3) || !(L > 0)) return chordD;
  const k = (nB[0] * ab[0] + nB[1] * ab[1]) / det,
    q = [-nA[1] * k, nA[0] * k];
  if (Math.hypot(q[0] - 0.5 * ab[0], q[1] - 0.5 * ab[1]) > L) return chordD;
  const qb = [ab[0] - q[0], ab[1] - q[1]],
    pq = [p[0] - q[0], p[1] - q[1]],
    pb = [p[0] - ab[0], p[1] - ab[1]];
  const s1 = q[0] * p[1] - q[1] * p[0],
    s2 = qb[0] * pq[1] - qb[1] * pq[0],
    s3 = ab[1] * pb[0] - ab[0] * pb[1];
  if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return 0;
  const seg = (v, d) => {
    const t = Math.max(
      0,
      Math.min(1, (v[0] * d[0] + v[1] * d[1]) / Math.max(d[0] * d[0] + d[1] * d[1], 1e-30)),
    );
    return Math.hypot(v[0] - d[0] * t, v[1] - d[1] * t);
  };
  return Math.min(chordD, seg(p, q), seg(pq, qb));
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

/// The two endpoint packs of a morph mesh (buildMorphShape's `{ vbo | segments }`) that draw frame t, and the local t
/// the segment's uniform takes.
export function morphPacksAt(mesh, t) {
  const segs = mesh.segments || [
    { tLo: 0, tHi: 1, tLoB: 0, tHiB: 1, vbo: mesh.vbo, vertexCount: mesh.vertexCount },
  ];
  const g = segs.find((s) => t >= s.tLo && t <= s.tHi) || segs[segs.length - 1];
  const n = g.vertexCount,
    S = new Float32Array(n * VF),
    D = new Float32Array(n * VF);
  for (let i = 0; i < n; i++) {
    S.set(g.vbo.subarray(i * 2 * VF, i * 2 * VF + VF), i * VF);
    D.set(g.vbo.subarray(i * 2 * VF + VF, (i + 1) * 2 * VF), i * VF);
  }
  return { S, D, n, lt: (t - g.tLoB) / (g.tHiB - g.tLoB) };
}
/// A static mesh as a morph whose two endpoints are the same pack.
export function staticPacks(mesh) {
  const pk = packLoopBlinnMesh(mesh);
  return { S: pk.verts, D: pk.verts, n: pk.vertexCount, lt: 0 };
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
/// `opts.chordGate`: the chord form of the counter-hole ribbon gate (distance to the CHORD), for a
/// smoke's non-vacuity arm. The shipped gate is the tangent triangle.
/// `opts.watch = { px: [x, y], log: [] }`: every triangle whose rasterization reaches that pixel center is
/// logged in primitive order -- its kind, whether an interior face runs in chain mode, whether an
/// earlier fragment had already claimed the pixel, and its provoking vertex (the chains ride it).
export function render(packs, bb, N = 256, opts = {}) {
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
        const watched = opts.watch && opts.watch.px[0] === x && opts.watch.px[1] === y;
        if (cov[idx] >= 0 && !watched) continue; // claimed: LESS rejects this shape's later fragments
        const cx = x + 0.5,
          cy = y + 0.5,
          e = (i, j) =>
            ((px[j][0] - px[i][0]) * (cy - px[i][1]) - (px[j][1] - px[i][1]) * (cx - px[i][0])) *
            pdet;
        if (e(0, 1) < 0 || e(1, 2) < 0 || e(2, 0) < 0) continue;
        if (watched)
          opts.watch.log.push({
            tri,
            kind,
            sign: P.sign,
            chainMode: kind === 0 && P.vtc[0] > 1.5,
            claimed: cov[idx] >= 0,
            P,
            em: E,
          });
        if (cov[idx] >= 0) continue;
        const [ex, ey] = toEm(cx, cy);
        let c;
        if (kind === 0) {
          if (P.vtc[0] > 1.5) {
            // chain mode: chainBoxCov, min chain 2
            const inv = 1 / emPerPx,
              cell = (q) => [(q[0] - ex) * inv, (q[1] - ey) * inv];
            const c1 = [
              [P.C3[0], P.C3[1]],
              [P.C3[2], P.C3[3]],
              [P.C0[0], P.C0[1]],
              [P.C0[2], P.C0[3]],
              [P.vtc[1], P.vtc[2]],
            ].map(cell);
            const ch2 = [
              [P.C1[0], P.C1[1]],
              [P.C1[2], P.C1[3]],
              [P.C2[0], P.C2[1]],
              [P.C2[2], P.C2[3]],
            ];
            c =
              P.vtc[0] > 3.5 // cubic chain: a cubic and a line, mode 4 / 5
                ? cubicChainBoxCov(c1[0], c1[1], c1[2], c1[3], c1[4], P.vtc[0] > 4.5, 2.0)
                : chainBoxCov(c1[0], c1[1], c1[2], c1[3], c1[4], 2.0);
            if (ch2.some((q) => q[0] !== 0 || q[1] !== 0)) {
              const d = ch2.map(cell);
              c = Math.min(
                c,
                P.seam > 0.5
                  ? cubicChainBoxCov(d[0], d[1], d[2], d[3], d[3], false, 1.0)
                  : chainBoxCov(d[0], d[1], d[2], d[3], d[3], 1.0),
              );
            }
          } else {
            if (
              P.C3[0] ||
              P.C3[1] ||
              P.C3[2] ||
              P.C0[0] ||
              P.C0[1] ||
              P.C0[2] ||
              P.vtc[0] ||
              P.vtc[1] ||
              P.vtc[2]
            )
              unmodelled.add('interior line rows');
            c = 1;
          }
        } else if (kind === 2 || kind === 12) {
          const k = tcAt(ex, ey),
            s = kind === 12 ? (P.sign >= 0 ? 1 : -1) : P.sign;
          const tx = grad.map((g) => g[0] * emPerPx),
            ty = grad.map((g) => g[1] * emPerPx);
          const f = s * (k[0] ** 3 - k[1] * k[2]);
          const fx = s * (3 * k[0] * k[0] * tx[0] - (tx[1] * k[2] + k[1] * tx[2])),
            fy = s * (3 * k[0] * k[0] * ty[0] - (ty[1] * k[2] + k[1] * ty[2]));
          const fxx = s * (6 * k[0] * tx[0] * tx[0] - 2 * tx[1] * tx[2]),
            fyy = s * (6 * k[0] * ty[0] * ty[0] - 2 * ty[1] * ty[2]);
          const fxy = s * (6 * k[0] * tx[0] * ty[0] - (tx[1] * ty[2] + ty[1] * tx[2]));
          c = curveCov(f, fx, fy, fxx, fyy, fxy);
          if (kind === 2) {
            if (P.seam > 0.5 && P.seam < 5) {
              // ring-less piece: its own end-tangent planes
              const eps = 0.05 * emPerPx;
              if (
                (ex - P.C3[0]) * P.C0[0] + (ey - P.C3[1]) * P.C0[1] < -eps ||
                (ex - P.C3[2]) * P.C0[2] + (ey - P.C3[3]) * P.C0[3] < -eps
              )
                continue;
            }
          } else {
            let mag = Math.abs(P.sign);
            const cubic = mag >= 8192;
            if (cubic) mag -= 8192;
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
              codeB = mag - codeA * 16,
              tyA = Math.floor((codeA + 0.5) / 4) - 1,
              tyB = Math.floor((codeB + 0.5) / 4) - 1;
            const a = [P.C3[0], P.C3[1]],
              b = [P.C3[2], P.C3[3]];
            if (!(cubic && (a[0] || a[1] || b[0] || b[1]))) {
              if (c < 0.999 && f < 0) continue;
            } else {
              if (tyA !== 0 || tyB !== 0) unmodelled.add('chained curve-band ends');
              const rA = [ex - a[0], ey - a[1]],
                rB = [ex - b[0], ey - b[1]];
              const sA = [-P.nOA[1] * (spanA ? 1 : -1), P.nOA[0] * (spanA ? 1 : -1)],
                sB = [-P.nOB[1] * (spanB ? 1 : -1), P.nOB[0] * (spanB ? 1 : -1)];
              if (tyA === 0 && rA[0] * sA[0] + rA[1] * sA[1] < 0) continue;
              if (tyB === 0 && rB[0] * sB[0] + rB[1] * sB[1] < 0) continue;
              if (f < 0 || c <= 0) continue; // the fill side is the hull crescent's turf
              if (s < 0) {
                // counter-hole ribbon gates
                const dpx = f / Math.max(Math.hypot(fx, fy), 1e-6),
                  ab = [b[0] - a[0], b[1] - a[1]],
                  L2 = Math.max(ab[0] * ab[0] + ab[1] * ab[1], 1e-12);
                const u = Math.max(0, Math.min(1, (rA[0] * ab[0] + rA[1] * ab[1]) / L2));
                const dChord = Math.hypot(rA[0] - ab[0] * u, rA[1] - ab[1] * u);
                const dCh =
                  (opts.chordGate ? dChord : tangentTriDist(rA, ab, P.nOA, P.nOB, dChord)) /
                  emPerPx;
                if (dCh > 1.5 && Math.abs(dpx) < 1) continue;
                if (dCh > 1.2 && Math.abs(dpx) < 0.7 && c < 0.95) continue;
              }
            }
          }
        } else if (kind === 4 && P.seam > 9.5) {
          // a ring that carries its arc
          const inv = 1 / emPerPx,
            cell = (x, y) => [(x - ex) * inv, (y - ey) * inv];
          const q = [
            cell(P.C0[0], P.C0[1]),
            cell(P.C0[2], P.C0[3]),
            cell(P.C1[0], P.C1[1]),
            cell(P.C1[2], P.C1[3]),
          ];
          c = cubicChainBoxCov(q[0], q[1], q[2], q[3], q[3], false, 0.0);
        } else if (kind === 4) {
          const k = tcAt(ex, ey),
            sl = [...P.C0, ...P.C1, ...P.C2, ...P.C3.slice(0, 3)];
          const [F, gx, gy] = bezout(sl, ex, ey),
            f = P.sign * F;
          const keep = bezKeepCov([k[0], k[1]], k[2], [ex, ey], [emPerPx, 0], [0, emPerPx]); // keep half-plane
          if (keep <= 0) c = 0;
          else {
            const h = 1e-3 * emPerPx,
              [, gx1, gy1] = bezout(sl, ex + h, ey),
              [, gx2, gy2] = bezout(sl, ex, ey + h),
              q = (emPerPx * emPerPx) / h;
            c = Math.min(
              curveCov(
                f,
                P.sign * gx * emPerPx,
                P.sign * gy * emPerPx,
                P.sign * (gx1 - gx) * q,
                P.sign * (gy2 - gy) * q,
                P.sign * (gx2 - gx) * q,
              ),
              keep,
            );
          }
          if (P.seam > 5 && c < 0.999 && f < 0) continue;
        } else {
          unmodelled.add('kind ' + kind);
          c = 1;
        }
        if (c < 0.004) continue;
        cov[idx] = c;
      }
  }
  return { cov, unmodelled: [...unmodelled] };
}

/// The probe's score: pixels whose coverage is off the exact coverage of `contours` (12 x 12 supersampled nonzero
/// winding, or even-odd) by more than 32/255, split into `over` (painted more than the path covers), `lostIn` (ink lost at a pixel
/// whose center is inside the fill) and `lostOut` (the antialiasing just outside the outline, left unpainted).
export function scoreExact(cov, contours, bb, N = 256, SS = 12, evenOdd = false) {
  const segs = contours.flat(),
    toEm = (x, y) => [bb[0] + (x / N) * bb[2], bb[1] + (y / N) * bb[3]];
  const inside = (x, y) => {
    const w = rayWinding(segs, ...toEm(x, y));
    return evenOdd ? (w & 1) !== 0 : w !== 0;
  };
  const out = { off: 0, over: 0, lostIn: 0, lostOut: 0 };
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const got = Math.max(0, cov[y * N + x]);
      if (got === 0 || got === 1) {
        // a pixel the outline does not reach: one look
        const c = inside(x + 0.5, y + 0.5);
        if (
          (got === 1) === c &&
          [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ].every(([a, b]) => inside(x + a, y + b) === c)
        )
          continue;
      }
      let n = 0;
      for (let a = 0; a < SS; a++)
        for (let b = 0; b < SS; b++) if (inside(x + (a + 0.5) / SS, y + (b + 0.5) / SS)) n++;
      const want = n / (SS * SS);
      if (Math.abs(got - want) * 255 <= 32) continue;
      out.off++;
      if (got > want) out.over++;
      else if (inside(x + 0.5, y + 0.5)) out.lostIn++;
      else out.lostOut++;
    }
  return out;
}
