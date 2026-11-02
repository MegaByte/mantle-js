// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbKernel — the CPU twin of src/shaders/_lbVertexSetup.glsl + _lbCoverage.glsl.
//
// WHAT this IS FOR. Every question about LB antialiasing (sub-pixel over-cover, edge AA against
// real artwork, jaggies at smooth joints, the curved counter) is "where does the kernel's
// coverage depart from the true area, and which TERM does it". A render can only
// show the departure; attributing it needs the kernel's own arithmetic beside the exact answer at
// the same pixel, which is what this gives.
//
// IT MODELS THE KERNEL'S current BEHAVIOR, NOT ITS INTENT. A twin that models a superseded term
// invalidates every measurement written against it (src/renderer/cpatchCov.js is the warning). So
// this is a line-for-line copy with the same branches, the same literals and the same discards,
// and _kernelSelfTest.mjs pins the parts that can be checked against brute force.
//
// DRIFT IS CHECKED, NOT ASSUMED. The DISC branch calls `arcCov` on the circle/annulus side of its
// `cHalf < -1.5` test, as the shader does; `test/lbKernelTwinFidelitySmoke.mjs` compares both
// against the package shader text compiled to float32 (test/_glslEmu.mjs) rather than against a
// second reading of it, and that smoke also asserts that every coverage function _lbCoverage.glsl
// calls is called here. `opt.noArcMoment` keeps the curveCov-on-both-sides answer reachable so the
// numbers taken under it stay reproducible.
//
// WHAT IT ASSUMES, and these are the model's edges:
//   * no world matrix and no per-shape override  -> emPerPxFor() == basePx for every vertex and
//     every direction, so vEmPerPx is one number for the whole draw (_emPerPx.glsl).
//   * the fill is OPAQUE and static -> unifiedFillDraw takes the no-claim path, the depth test is
//     OFF, and the composite is plain OVER of one color. Coverage then composites as
//     1 - prod(1 - c) over every fragment that does not discard, INDEPENDENT of draw order (the
//     same form _rowGateAaRef.mjs uses for CPatch). A translucent or morph bundle claims depth
//     (depthFunc LESS at one z per shape = first fragment wins) and is NOT modelled here.
//   * float64 arithmetic against the GPU's float32. The inputs are float32 (they come out of the
//     packed Float32Array); the kernel's own arithmetic is wider here.
//   * `flat` varyings take the LAST vertex of each triangle (GL's default provoking convention).
//
// DERIVATIVES. vEm and vTC are affine in screen space, so dFdx/dFdy of them are exact and taken
// from the triangle's own plane. f4gEm (the Bezout cofactor gradient) is NOT affine, and the GPU
// takes its derivative across the 2x2 quad; the model reproduces that forward difference at the
// quad's own pixels, helper invocations included.
import {
  exactBoxCov,
  exactBoxCov2,
  exactBoxCov3,
  chainBoxCov,
  cubicChainBoxCov,
  dot,
  sub,
  add,
  mul,
  len,
  norm,
  clamp,
} from './_lbBoxCov.mjs';
import { unpackKlmGrad } from '../../src/renderer/lbPack.js';

export const DISCARD = null;

// ---------------------------------------------------------------- half decode
const _b4 = new ArrayBuffer(4);
const _f32 = new Float32Array(_b4);
const _u32 = new Uint32Array(_b4);
function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >>> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 5.960464477539063e-8; // 2^-24
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (m + 1024) * Math.pow(2, e - 25);
}
/** GLSL unpackHalf2x16(floatBitsToUint(f)) — low half first. */
export function unpackHalf2x16(f) {
  _f32[0] = f;
  const u = _u32[0];
  return [halfToFloat(u & 0xffff), halfToFloat((u >>> 16) & 0xffff)];
}

const GLmod = (x, y) => x - y * Math.floor(x / y);
const mix = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- kinds
export const LBK = {
  INTERIOR: 0,
  CUBIC: 2,
  CUBIC_BEZ: 4,
  ARC: 5,
  DISC: 7,
  EDGE_STRIP: 10,
  CURVE_BAND: 12,
  CHAIN_STRIP: 13,
};
export const LB_VERT_FLOATS = 24;
// The packed stream's slot plan (lbPack.js `head` + the per-kind writers).
export const SLOT = { POS: 0, TC: 2, KIND: 5, SIGN: 6, C0: 7, C1: 11, C2: 15, C3: 19, SEAM: 23 };

/** Decode one packed LB vertex into the attributes the vertex stage reads. */
export function decodeVert(v, i) {
  const o = i * LB_VERT_FLOATS;
  return {
    pos: [v[o], v[o + 1]],
    tc: [v[o + 2], v[o + 3], v[o + 4]],
    // The blend bit rides the kind's fraction (2048/8192 = 0.25); floor recovers the kind.
    kind: Math.floor(v[o + 5] + 1e-4),
    sign: v[o + 6],
    C0: [v[o + 7], v[o + 8], v[o + 9], v[o + 10]],
    C1: [v[o + 11], v[o + 12], v[o + 13], v[o + 14]],
    C2: [v[o + 15], v[o + 16], v[o + 17], v[o + 18]],
    C3: [v[o + 19], v[o + 20], v[o + 21], v[o + 22]],
    seam: v[o + 23],
  };
}

// ---------------------------------------------------------------- vertex stage
export const LB_DISC_PUSH = 2.0;
export const LB_STRIP_NEXT = 0.8;
export const LB_KLM_RING = 0.25;
export const LB_BEZ_RING = 0.25;
/// The Bezout keep half-plane's bound: the part of the pixel box the keep half-plane
/// g = m . em - c <= 0 covers, exact because g is affine over the pixel, with demx / demy the em step
/// per pixel. The crescent's coverage is clamped to it, and a fragment where it is zero is cut: the
/// fence, at g > (|m . demx| + |m . demy|) / 2. The shader's lines, `_lbCoverage.glsl`; they replaced
/// a constant 0.25 px release (`opt.bezFence` restores a constant release, in px of a unit normal,
/// for an A/B arm).
export function bezKeepCov(m, c, em, emx, emy) {
  if (!(m[0] * m[0] + m[1] * m[1] > 0)) return 1;
  const d = [m[0] * emx[0] + m[1] * emx[1], m[0] * emy[0] + m[1] * emy[1]],
    L = Math.hypot(d[0], d[1]);
  const g = m[0] * em[0] + m[1] * em[1] - c;
  return L > 0 ? exactBoxCov([d[0] / L, d[1] / L], -g / L) : g <= 0 ? 1 : 0;
}
export const bezFenced = (m, c, em, emx, emy) => bezKeepCov(m, c, em, emx, emy) <= 0;
/// The pixel box's share of {p : n . p <= c}, and of two such half-planes' intersection, with the em step per pixel
/// (the shader's lbHalfPlaneBoxCov / lbHalfPlanesBoxCov2).
/// Both decide first, as the shader does: g against the box's reach s = (|d.x| + |d.y|) / 2 says wholly inside or outside.
export function lbHalfPlaneBoxCov(n, c, em, emx, emy) {
  const d = [n[0] * emx[0] + n[1] * emx[1], n[0] * emy[0] + n[1] * emy[1]],
    g = n[0] * em[0] + n[1] * em[1] - c;
  const s = 0.5 * (Math.abs(d[0]) + Math.abs(d[1]));
  if (g <= -s) return 1;
  if (g >= s) return 0;
  const L = Math.hypot(d[0], d[1]);
  return exactBoxCov([d[0] / L, d[1] / L], -g / L);
}
export function lbHalfPlanesBoxCov2(n1, c1, n2, c2, em, emx, emy) {
  const d1 = [n1[0] * emx[0] + n1[1] * emx[1], n1[0] * emy[0] + n1[1] * emy[1]],
    d2 = [n2[0] * emx[0] + n2[1] * emx[1], n2[0] * emy[0] + n2[1] * emy[1]];
  const g1 = n1[0] * em[0] + n1[1] * em[1] - c1,
    g2 = n2[0] * em[0] + n2[1] * em[1] - c2;
  const s1 = 0.5 * (Math.abs(d1[0]) + Math.abs(d1[1])),
    s2 = 0.5 * (Math.abs(d2[0]) + Math.abs(d2[1]));
  const in1 = g1 <= -s1,
    in2 = g2 <= -s2;
  if ((!in1 && g1 >= s1) || (!in2 && g2 >= s2)) return 0;
  if (in1) return lbHalfPlaneBoxCov(n2, c2, em, emx, emy);
  if (in2) return lbHalfPlaneBoxCov(n1, c1, em, emx, emy);
  const L1 = Math.hypot(d1[0], d1[1]),
    L2 = Math.hypot(d2[0], d2[1]);
  return exactBoxCov2([d1[0] / L1, d1[1] / L1], -g1 / L1, [d2[0] / L2, d2[1] / L2], -g2 / L2);
}

/**
 * lbVertexSetup: the dilated em position plus the per-vertex vTC and vEmPerPx.
 * `basePx` is em per device pixel (no world matrix, so emPerPxFor() returns it for every direction).
 */
/// The pixel box's reach along a unit em direction, in px: 0.5 (|n.x| + |n.y|) with no world matrix (sqrt(2)/2 at 45
/// degrees, CP_AA_REACH). A pixel whose center is farther than this past a line cannot touch it.
export const boxSupport = (n) => 0.5 * (Math.abs(n[0]) + Math.abs(n[1]));
/// The reach of a curve band's PUSH VECTOR v, in px per unit of v (the shader's lbBandReach): v = n + s t with n the unit
/// edge normal, so v moves the ring's far edge 1 along n per unit, and v leans acos(1 / |v|) off n to one side or the
/// other. The larger reach of the two candidates is at least the reach along n.
export function bandReach(v) {
  const L = Math.hypot(v[0], v[1]);
  if (!(L > 0)) return 0;
  const u = [v[0] / L, v[1] / L],
    c = 1 / Math.max(L, 1),
    sn = Math.sqrt(Math.max(1 - c * c, 0));
  return Math.max(
    boxSupport([c * u[0] - sn * u[1], sn * u[0] + c * u[1]]),
    boxSupport([c * u[0] + sn * u[1], -sn * u[0] + c * u[1]]),
  );
}
export function lbVertexSetup(a, basePx, opt) {
  opt = opt || {};
  // THE RINGS REACH THE BOX FILTER'S own DISTANCE by default (the shader's lbBoxReach); a morph draw
  // (opt.morph) and an A/B arm with a number in opt.ringReach or opt.legacyRing keep a constant push.
  const derived = !opt.morph && !opt.legacyRing && typeof opt.ringReach !== 'number';
  const BEZ_RING =
    typeof opt.ringReach === 'number'
      ? opt.ringReach
      : opt.bezRing != null
        ? opt.bezRing
        : LB_BEZ_RING;
  const KLM_RING =
    typeof opt.ringReach === 'number'
      ? opt.ringReach
      : opt.klmRing != null
        ? opt.klmRing
        : LB_KLM_RING;
  let emPerPx = basePx,
    LB0 = null;
  let emPos = [a.pos[0], a.pos[1]];
  let tc = [a.tc[0], a.tc[1], a.tc[2]];
  const k = a.kind;
  if (k === LBK.CUBIC_BEZ) {
    // vEmPerPx radially from the crescent's center; identical to basePx with no world matrix.
    emPerPx = basePx;
    if (a.seam > 5.0) {
      const n4 = unpackHalf2x16(a.C3[3]);
      if (n4[0] * n4[0] + n4[1] * n4[1] > 0.0) {
        if (derived) {
          // the ring's base edge rides vEmPerPx (the shader's lbVertexSetup): n4 . p <= this
          const L4 = Math.hypot(n4[0], n4[1]),
            u4 = [n4[0] / L4, n4[1] / L4];
          emPerPx = u4[0] * a.pos[0] + u4[1] * a.pos[1];
          emPos = add(emPos, mul(u4, boxSupport(u4) * basePx));
        } else emPos = add(emPos, mul(n4, BEZ_RING * basePx));
      }
      // a ring that carries its arc maps it into the pixel cell at the directionless scale
      if (a.seam > 9.5) emPerPx = basePx;
    }
  } else if (k === LBK.DISC) {
    const out7 = sub(a.pos, [a.C3[0], a.C3[1]]);
    const L7 = Math.max(len(out7), 1e-9);
    emPos = add(a.pos, mul(out7, (LB_DISC_PUSH * basePx) / L7));
  } else if (k === LBK.EDGE_STRIP) {
    const p1k = [a.C3[0], a.C3[1]],
      p2k = [a.C3[2], a.C3[3]];
    const tdk = mul(sub(p2k, p1k), 1 / Math.max(len(sub(p2k, p1k)), 1e-9));
    const nOutk = mul([-tdk[1], tdk[0]], a.sign);
    const tR = GLmod(a.tc[0], 2.0),
      sR = Math.floor(a.tc[0] / 2.0 + 0.25);
    const basek = tR < 0.5 ? p1k : p2k;
    let tExt = 3.2,
      nExt = LB_STRIP_NEXT;
    if (sR >= 0.5) {
      const codeA10 = Math.floor((a.seam + 0.5) / 16.0),
        codeB10 = a.seam - codeA10 * 16.0;
      const code10 = tR < 0.5 ? codeA10 : codeB10;
      const ty10 = Math.floor((code10 + 0.5) / 4.0) - 1.0;
      const curve10 = GLmod(code10, 4.0) >= 1.5;
      if (ty10 > 0.5 && !curve10) {
        const nN10 = tR < 0.5 ? [a.C0[0], a.C0[1]] : [a.C0[2], a.C0[3]];
        const nDot10 = dot(nOutk, nN10);
        if (nDot10 < -0.35) {
          const boost10 = 1.0 + 0.55 * clamp(-0.35 - nDot10, 0.0, 1.35);
          tExt *= boost10;
          nExt *= boost10;
        }
      }
    }
    emPos = add(
      add(basek, mul(tdk, (tR < 0.5 ? -tExt : tExt) * (sR < 0.5 ? 0.0 : basePx))),
      mul(nOutk, (sR < 0.5 ? 0.0 : nExt) * basePx),
    );
  } else if (k === LBK.CURVE_BAND) {
    const n12 = [a.C0[0], a.C0[1]],
      L12 = Math.hypot(n12[0], n12[1]);
    // A QUAD band on a morph draw reaches the box filter's distance too, and takes mode 2; a klm ring on a
    // morph keeps the constant push and no bound.
    const derivedBand =
      derived ||
      (opt.morph &&
        !opt.legacyRing &&
        typeof opt.ringReach !== 'number' &&
        Math.abs(a.sign) < 8192.0);
    const amt12 = (derivedBand ? bandReach(n12) : KLM_RING) * basePx;
    // the band's bound, in vLB0 (the shader's lbVertexSetup): a klm ring's unit normal and arc support (mode 1), a quad
    // band's mode 2, none (mode 0) on a morph klm ring
    LB0 = !derivedBand
      ? [a.C0[0], a.C0[1], a.C0[2], 0]
      : Math.abs(a.sign) >= 8192.0
        ? [L12 > 0 ? n12[0] / L12 : 0, L12 > 0 ? n12[1] / L12 : 0, a.seam, 1]
        : [0, 0, 0, 2];
    emPos = add(a.pos, mul([a.C0[0], a.C0[1]], amt12));
    if (Math.abs(a.sign) >= 8192.0) {
      const dkl12 = unpackKlmGrad(a.C0[2]);
      tc = [a.tc[0] + dkl12[0] * amt12, a.tc[1] + dkl12[1] * amt12, a.tc[2] + a.C0[3] * amt12];
    } else {
      // R pushes with U and V on a quad band, static or morph: R = 1 + 2(1 - w)(U - V), the factor in the seam slot (the shader's lbVertexSetup)
      tc = [
        a.tc[0] + a.C0[2] * amt12,
        a.tc[1] + a.C0[3] * amt12,
        a.tc[2] + a.seam * (a.C0[2] - a.C0[3]) * amt12,
      ];
    }
  }
  return { emPos, tc, emPerPx, LB0 };
}

/**
 * THE NORMAL LINE AT THE ARC POINT WHOSE NORMAL BISECTS A HOOK'S END NORMALS (the shader's aSide12 / bSide12 block). A rational
 * quad a, c, b with weight w has its tangent at parameter s along p1 u + p2 v (u = c - a, v = b - c), p1 = (1-s)(w(1-s)+s),
 * p2 = s(1-s+ws); the bisecting normal is equal and opposite on the two end tangents, so p1 |u| = p2 |v|, a quadratic in
 * r = s/(1-s), and the point is a + (u (2wr+r^2) + v r^2) / (1+2wr+r^2). Returns the line as { nM (unit normal), off (its
 * offset from a along the tangent), side(rA) } with side positive toward b: the pixels on a's side are those whose nearest arc
 * point is before it, each end's test applying on its own side only.
 */
export function hookMidLine(a, b, c, w, nOA, nOB) {
  const nm = add(nOA, nOB),
    nL = len(nm),
    nM = [nm[0] / nL, nm[1] / nL];
  const k0 = len(sub(c, a)),
    k1 = len(sub(b, c)),
    dk = k0 - k1;
  const r = (dk + Math.sqrt(dk * dk + 4.0 * k0 * k1 * w * w)) / (2.0 * k1 * w);
  const wr = 1.0 + 2.0 * w * r + r * r;
  const qm = mul(add(mul(sub(c, a), 2.0 * w * r + r * r), mul(sub(b, c), r * r)), 1 / wr);
  const off = nM[0] * qm[1] - nM[1] * qm[0];
  const ab = sub(b, a);
  const sgnB = nM[0] * ab[1] - nM[1] * ab[0] - off < 0.0 ? -1.0 : 1.0;
  return { nM, off, qm, side: (rA) => (nM[0] * rA[1] - nM[1] * rA[0] - off) * sgnB };
}

// ---------------------------------------------------------------- fragment stage
//
// `F` is the fragment's whole varying set plus the screen derivatives, as the kernel reads them.
//   kind sign seam emPerPx   LB0 LB1 LB2 LB3   tc   em   dtcx dtcy demx demy   bez(emQuad)
// `opt` carries the A/B knobs the shader has as defines, so one model can serve both arms of a
// measurement without a second copy of the port.

function slugCov(f, grad) {
  const g = Math.max(len(grad), 1e-30); // no absolute floor in a length: only a guard for a zero gradient
  return exactBoxCov(mul(grad, 1 / g), -f / g);
}

/** Curve coverage: exact box area of the tangent half-plane, plus the mean-curvature bias. */
export function curveCov(f, fx, fy, fxx, fyy, fxy, opt) {
  const grad = [fx, fy];
  const g = Math.max(len(grad), 1e-30);
  const nn = mul(grad, 1 / g);
  let kPx = (fxx * nn[1] * nn[1] - 2.0 * fxy * nn[0] * nn[1] + fyy * nn[0] * nn[0]) / g;
  kPx = clamp(kPx, -2.0, 2.0);
  const bias = opt && opt.kappaScale != null ? opt.kappaScale : 1.0;
  return exactBoxCov(mul(grad, 1 / g), -f / g - (bias * kPx) / 24.0);
}

/**
 * ...AND THE same THING WHERE kappa IS CONSTANT ALONG THE LEVEL SET — the recognized SDF
 * primitives (a circle or an annulus, and nothing else). The offset is the arc's mean deviation
 * from its tangent over the CHORD this PIXEL CUTS, kappa*(x1^2 + x1*x2 + x2^2)/6, rather than
 * kappa/24 (which is that moment for a unit chord centered on the foot of the perpendicular).
 *
 * `_lbCoverage.glsl`'s DISC branch reads `(cHalf < -1.5) ? curveCov : arcCov`. An ellipse keeps
 * curveCov because its kappa varies along the level set; a circle and an annulus take this.
 * Direction of the difference: for a CONVEX arc (kappa > 0) the chord moment is at least 1/24 and
 * up to 2/24 on a diagonal cut, so curveCov on both sides reads MORE coverage than the shader on
 * every disc's outer rim and less on an annulus's inner wall — see test/lbKernelTwinFidelitySmoke.
 */
export function arcCov(f, fx, fy, fxx, fyy, fxy, opt) {
  const grad = [fx, fy];
  const g = Math.max(len(grad), 1e-30);
  const n = mul(grad, 1 / g);
  const kPx = clamp(
    (fxx * n[1] * n[1] - 2.0 * fxy * n[0] * n[1] + fyy * n[0] * n[0]) / g,
    -2.0,
    2.0,
  );
  const d = -f / g;
  // The chord's x-range, from the two slab clips. |n| == 1, so at most one component is zero and
  // that axis simply imposes no bound (or rejects the line outright).
  let lo = -1e9,
    hi = 1e9;
  if (Math.abs(n[1]) > 1e-9) {
    const u0 = (d * n[0] - 0.5) / n[1],
      u1 = (d * n[0] + 0.5) / n[1];
    lo = Math.max(lo, Math.min(u0, u1));
    hi = Math.min(hi, Math.max(u0, u1));
  } else if (Math.abs(d * n[0]) > 0.5) {
    lo = 1.0;
    hi = -1.0;
  }
  if (Math.abs(n[0]) > 1e-9) {
    const v0 = (-0.5 - d * n[1]) / n[0],
      v1 = (0.5 - d * n[1]) / n[0];
    lo = Math.max(lo, Math.min(v0, v1));
    hi = Math.min(hi, Math.max(v0, v1));
  } else if (Math.abs(d * n[1]) > 0.5) {
    lo = 1.0;
    hi = -1.0;
  }
  const mom = hi > lo ? (lo * lo + lo * hi + hi * hi) / 6.0 : 0.0;
  const bias = opt && opt.kappaScale != null ? opt.kappaScale : 1.0;
  return exactBoxCov(n, d - bias * kPx * mom);
}

/// _lbCoverage.glsl's lbTangentTriDist, line for line: the distance from p (relative to a) to the triangle a convex
/// curve piece lies in -- its chord a->b and the point q where the two end tangents meet. The ribbon gate measures to
/// this triangle; the chord distance, which is never smaller, would discard fragments near the arc's bulge that the
/// shader paints.
export function lbTangentTriDist(p, ab, nA, nB, chordD) {
  const det = nA[0] * nB[1] - nA[1] * nB[0];
  const L = len(ab);
  if (!(Math.abs(det) > 1e-3) || !(L > 0.0)) return chordD;
  const q = mul([-nA[1], nA[0]], dot(nB, ab) / det);
  if (len(sub(q, mul(ab, 0.5))) > L) return chordD;
  const qb = sub(ab, q),
    pq = sub(p, q),
    pb = sub(p, ab);
  const s1 = q[0] * p[1] - q[1] * p[0],
    s2 = qb[0] * pq[1] - qb[1] * pq[0],
    s3 = ab[1] * pb[0] - ab[0] * pb[1];
  if ((s1 >= 0.0 && s2 >= 0.0 && s3 >= 0.0) || (s1 <= 0.0 && s2 <= 0.0 && s3 <= 0.0)) return 0.0;
  const dAq = len(sub(p, mul(q, clamp(dot(p, q) / Math.max(dot(q, q), 1e-30), 0.0, 1.0))));
  const dQb = len(sub(pq, mul(qb, clamp(dot(pq, qb) / Math.max(dot(qb, qb), 1e-30), 0.0, 1.0))));
  return Math.min(chordD, Math.min(dAq, dQb));
}

export function lbCoverage(F, opt) {
  opt = opt || {};
  const cCen = [F.LB3[0], F.LB3[1]],
    cScale = F.LB3[2],
    cHalf = F.LB3[3];
  const vNa = [F.LB0[0], F.LB0[1]],
    vNb = [F.LB0[2], F.LB0[3]];
  const vLine2 = [F.LB0[0], F.LB0[1], F.LB0[2]],
    vLineT = F.LB0[3];
  const vEm = F.em,
    vEmPerPx = F.emPerPx,
    vSign = F.sign,
    vSeam = F.seam,
    vTC = F.tc;
  const kind = F.kind;
  const gate = (g) => (opt.noCornerGate ? true : g > 0.0);

  // ---- EDGE_STRIP -----------------------------------------------------------
  if (kind === LBK.EDGE_STRIP) {
    const p1k = cCen,
      p2k = [cScale, cHalf];
    const tdk = mul(sub(p2k, p1k), 1 / Math.max(len(sub(p2k, p1k)), 1e-9));
    const nOwn = mul([-tdk[1], tdk[0]], vSign);
    const fOwn = dot(nOwn, sub(vEm, p1k));
    const codeA = Math.floor((vSeam + 0.5) / 16.0),
      codeB = vSeam - codeA * 16.0;
    const tyA = Math.floor((codeA + 0.5) / 4.0) - 1.0;
    const curveA = GLmod(codeA, 4.0) >= 1.5;
    const tsA = GLmod(codeA, 2.0);
    const tyB = Math.floor((codeB + 0.5) / 4.0) - 1.0;
    const curveB = GLmod(codeB, 4.0) >= 1.5;
    const tsB = GLmod(codeB, 2.0);
    const rA = sub(vEm, p1k),
      rB = sub(vEm, p2k);
    // A line-line corner's ONE partition plane, packed per corner (aC1 = the normals, aC2 = the points), which
    // both strips test -- the shader in canvas pixels against gl_FragCoord, the twin here in em against its exact
    // center. >= 0 is the outgoing edge's side: START keeps it, END the rest. opt.ownStripPlane keeps each strip's own plane.
    const wA10 = [F.LB1[0], F.LB1[1]],
      wB10 = [F.LB1[2], F.LB1[3]];
    const shA10 = !opt.ownStripPlane && dot(wA10, wA10) > 0,
      shB10 = !opt.ownStripPlane && dot(wB10, wB10) > 0;
    const sA10 = dot(sub(vEm, [F.LB2[0], F.LB2[1]]), wA10),
      sB10 = dot(sub(vEm, [F.LB2[2], F.LB2[3]]), wB10);
    if (curveA) {
      const wA = mul([-vNa[1], vNa[0]], tsA > 0.5 ? 1.0 : -1.0);
      if (dot(rA, wA) >= 0.0 && len(rA) < 2.5 * vEmPerPx && fOwn > 0.35 * vEmPerPx) return DISCARD;
    } else {
      const nDotA = dot(nOwn, vNa);
      const acuteA = tyA > 0.5 && nDotA < -0.35;
      const sumA = add(nOwn, vNa);
      const degenA = dot(sumA, sumA) < 0.08;
      const tipA = acuteA && fOwn > 0.0 && len(rA) < 2.2 * vEmPerPx;
      if (!(tipA && (acuteA || degenA))) {
        if (shA10) {
          if (sA10 < 0.0) return DISCARD;
        } else {
          let wA = degenA ? [-nOwn[1], nOwn[0]] : [-sumA[1], sumA[0]];
          if (dot(wA, tdk) < 0.0) wA = mul(wA, -1);
          if (dot(rA, wA) < 0.0) return DISCARD;
        }
      }
    }
    if (curveB) {
      const wB = mul([-vNb[1], vNb[0]], tsB > 0.5 ? 1.0 : -1.0);
      if (dot(rB, wB) >= 0.0 && len(rB) < 2.5 * vEmPerPx && fOwn > 0.35 * vEmPerPx) return DISCARD;
    } else {
      const nDotB = dot(nOwn, vNb);
      const acuteB = tyB > 0.5 && nDotB < -0.35;
      if (acuteB && fOwn > 0.0 && dot(vNb, rB) > 0.0 && len(rB) < 2.2 * vEmPerPx) return DISCARD;
      if (shB10) {
        if (sB10 >= 0.0) return DISCARD;
      } else {
        const sumB = add(nOwn, vNb);
        const degenB = dot(sumB, sumB) < 0.08;
        let wB = degenB ? [-nOwn[1], nOwn[0]] : [-sumB[1], sumB[0]];
        if (dot(wB, tdk) < 0.0) wB = mul(wB, -1);
        if (dot(rB, wB) >= 0.0) return DISCARD;
      }
    }
    const fA = dot(vNa, rA) - 0.5 * vTC[1] * dot(rA, rA);
    const fB = dot(vNb, rB) - 0.5 * vTC[2] * dot(rB, rB);
    const tipGateA = tyA > 0.5 && !curveA && dot(nOwn, vNa) < -0.35 ? 2.2 : 2.0;
    const tipGateB = tyB > 0.5 && !curveB && dot(nOwn, vNb) < -0.35 ? 2.2 : 2.0;
    const gA = clamp((tipGateA - len(rA) / vEmPerPx) / 1.5, 0.0, 1.0);
    const gB = clamp((tipGateB - len(rB) / vEmPerPx) / 1.5, 0.0, 1.0);
    if (fOwn < -1.2 * vEmPerPx) return DISCARD;
    const sOwn = fOwn < -0.012 * vEmPerPx ? 1.0 : 0.0;
    const sA = fA < 0.0 ? 1.0 : 0.0,
      sB = fB < 0.0 ? 1.0 : 0.0;
    const sAe = tyA > 0.5 ? (gA > 0.01 ? sA : 1.0) : gA > 0.01 ? sA : 0.0;
    const sBe = tyB > 0.5 ? (gB > 0.01 ? sB : 1.0) : gB > 0.01 ? sB : 0.0;
    let insid = sOwn;
    insid = tyA > 0.5 ? Math.min(insid, sAe) : tyA < -0.5 ? Math.max(insid, sAe) : insid;
    insid = tyB > 0.5 ? Math.min(insid, sBe) : tyB < -0.5 ? Math.max(insid, sBe) : insid;
    if (insid > 0.5) return DISCARD;
    const invPx10 = 1.0 / Math.max(vEmPerPx, 1e-12);
    const dOwn10 = -fOwn * invPx10;
    let c10 = exactBoxCov(nOwn, dOwn10);
    const cOwnP10 = c10;
    if (Math.abs(tyA) > 0.5 && gate(gA)) {
      const nA10 = mul(vNa, 1 / Math.max(len(vNa), 1e-9));
      const dA10 = -fA * invPx10;
      const cA10 = exactBoxCov(nA10, dA10);
      const interA = exactBoxCov2(nOwn, dOwn10, nA10, dA10);
      const kpA = Math.max(0.0, dot(nOwn, vNa));
      const exA =
        tyA > 0.0
          ? mix(clamp(c10 + interA - cOwnP10, 0.0, 1.0), Math.min(c10, cA10), kpA)
          : mix(clamp(c10 + cA10 - interA, 0.0, 1.0), Math.max(c10, cA10), kpA);
      c10 = mix(c10, exA, gA);
    }
    if (Math.abs(tyB) > 0.5 && gate(gB)) {
      const nB10 = mul(vNb, 1 / Math.max(len(vNb), 1e-9));
      const dB10 = -fB * invPx10;
      const cB10 = exactBoxCov(nB10, dB10);
      const interB = exactBoxCov2(nOwn, dOwn10, nB10, dB10);
      const kpB = Math.max(0.0, dot(nOwn, vNb));
      const exB =
        tyB > 0.0
          ? mix(clamp(c10 + interB - cOwnP10, 0.0, 1.0), Math.min(c10, cB10), kpB)
          : mix(clamp(c10 + cB10 - interB, 0.0, 1.0), Math.max(c10, cB10), kpB);
      c10 = mix(c10, exB, gB);
    }
    if (c10 < 0.004) return DISCARD;
    // (no fill-side cession: _lbCoverage.glsl)
    F._hit = 'EDGE_STRIP';
    return c10;
  }

  // ---- CURVE_BAND -----------------------------------------------------------
  if (kind === LBK.CURVE_BAND) {
    let mag12 = Math.abs(vSign);
    const s12 = vSign >= 0.0 ? 1.0 : -1.0;
    let cubic12 = false;
    if (mag12 >= 8192.0) {
      cubic12 = true;
      mag12 -= 8192.0;
    }
    if (mag12 >= 4096.0) mag12 -= 4096.0;
    let spanB12 = 0.0,
      spanA12 = 0.0;
    if (mag12 >= 2048.0) {
      spanB12 = 1.0;
      mag12 -= 2048.0;
    }
    if (mag12 >= 1024.0) {
      spanA12 = 1.0;
      mag12 -= 1024.0;
    }
    const codeA = Math.floor((mag12 + 0.5) / 16.0),
      codeB = mag12 - codeA * 16.0;
    const tyA = Math.floor((codeA + 0.5) / 4.0) - 1.0;
    const tyB = Math.floor((codeB + 0.5) / 4.0) - 1.0;
    const a12 = cCen,
      b12 = [cScale, cHalf];
    const rA = sub(vEm, a12),
      rB = sub(vEm, b12);
    const nA12 = [F.LB1[0], F.LB1[1]]; // cM01.yz = aC1.xy
    const nB12 = [F.LB1[2], F.LB1[3]]; // cM02.xy = aC1.zw
    const nOA = unpackHalf2x16(F.LB2[0]); // cM02.z = aC2.x
    const nOB = unpackHalf2x16(F.LB2[1]); // cM11a  = aC2.y
    const kA12 = F.LB2[2],
      kB12 = F.LB2[3];
    const ends12 = cubic12 && dot(a12, a12) + dot(b12, b12) > 0.0;
    // dFdy IN GL WINDOW COORDINATES, y UP, as the shader takes it. The model rasterizes top-down, so its dtcy (and demy)
    // is the negative of the shader's. The own plane in span is built from these derivatives, so its normal is in the
    // window frame. The em-space planes (the neighbour's, a wedge's osculating line) are mapped into the same frame
    // through the em derivatives (emx12, emy12) before the corner combine intersects them with it. `opt.mirroredCornerFrame`
    // intersects the y-mirrored pair instead, for comparison.
    const tx12d = F.dtcx,
      ty12d = F.dtcy.map((x) => -x);
    const emx12 = F.demx,
      emy12 = [-F.demy[0], -F.demy[1]];
    const toWin = (n) => [dot(n, emx12), dot(n, emy12)];
    // THE BAND'S BOUND: mode 1 a klm ring's arc support along its normal, mode 2 a quad band's tangent
    // half-planes (convex arc) or chord (concave), from its own end data. As _lbCoverage.glsl, in its window frame.
    let bound12 = 1.0;
    const LB0b = F.LB0;
    if (LB0b[3] > 0.5 && LB0b[3] < 1.5)
      bound12 = lbHalfPlaneBoxCov([LB0b[0], LB0b[1]], LB0b[2], vEm, emx12, emy12);
    else if (
      LB0b[3] > 1.5 &&
      dot(nOA, nOA) > 0 &&
      dot(nOB, nOB) > 0 &&
      dot(sub(b12, a12), sub(b12, a12)) > 0
    ) {
      const ab = sub(b12, a12); // (planes are scale-free: the normals go in as they are)
      if (dot(nOA, ab) < 0)
        bound12 = lbHalfPlanesBoxCov2(nOA, dot(nOA, a12), nOB, dot(nOB, b12), vEm, emx12, emy12);
      else {
        let nC = [ab[1], -ab[0]];
        if (dot(nC, nOA) < 0) nC = mul(nC, -1);
        bound12 = lbHalfPlaneBoxCov(nC, dot(nC, a12), vEm, emx12, emy12);
      }
    }
    if (cubic12 && !ends12) {
      const k12 = vTC[0],
        l12 = vTC[1],
        m12 = vTC[2];
      const f12c = s12 * (k12 * k12 * k12 - l12 * m12);
      const fx12c = s12 * (3.0 * k12 * k12 * tx12d[0] - (tx12d[1] * m12 + l12 * tx12d[2]));
      const fy12c = s12 * (3.0 * k12 * k12 * ty12d[0] - (ty12d[1] * m12 + l12 * ty12d[2]));
      const fxx12c = s12 * (6.0 * k12 * tx12d[0] * tx12d[0] - 2.0 * tx12d[1] * tx12d[2]);
      const fyy12c = s12 * (6.0 * k12 * ty12d[0] * ty12d[0] - 2.0 * ty12d[1] * ty12d[2]);
      const fxy12c =
        s12 * (6.0 * k12 * tx12d[0] * ty12d[0] - (tx12d[1] * ty12d[2] + ty12d[1] * tx12d[2]));
      const c12c = Math.min(curveCov(f12c, fx12c, fy12c, fxx12c, fyy12c, fxy12c, opt), bound12);
      if (c12c < 0.999 && f12c < 0.0) return ((F._why = 'CURVE_BAND:ring-fill'), DISCARD);
      if (c12c < 0.004) return ((F._why = 'CURVE_BAND:ring-zero'), DISCARD);
      F._hit = 'CURVE_BAND';
      return c12c;
    }
    const u12 = vTC[0],
      v12 = vTC[1],
      r12 = vTC[2];
    if (!cubic12 && r12 > 0.0) {
      const hu12 = u12 / r12,
        hv12 = v12 / r12;
      if (hv12 >= 0.0 && hu12 >= hv12 && 1.0 - 2.0 * hu12 + hv12 >= 0.0)
        return ((F._why = 'CURVE_BAND:hull'), DISCARD);
    }
    const sA12 = mul([-nOA[1], nOA[0]], spanA12 > 0.5 ? 1.0 : -1.0);
    const sB12 = mul([-nOB[1], nOB[0]], spanB12 > 0.5 ? 1.0 : -1.0);
    // A piece that turns past a right angle: an end test applies on its own side of the normal line at the arc point whose
    // normal bisects the end normals (the shader's aSide12 / bSide12, with its derivation).
    let aSide12 = true,
      bSide12 = true;
    if (!cubic12 && dot(nOA, nOB) < 0.0) {
      const ab12 = sub(b12, a12);
      const sinT12 = sB12[0] * sA12[1] - sB12[1] * sA12[0];
      const detEm12 = emx12[0] * emy12[1] - emx12[1] * emy12[0];
      const lam12 = (sB12[0] * ab12[1] - sB12[1] * ab12[0]) / sinT12;
      const c12 = add(a12, mul(sA12, lam12));
      const gU12 = [
        (tx12d[0] * emy12[1] - emx12[1] * ty12d[0]) / detEm12,
        (emx12[0] * ty12d[0] - emy12[0] * tx12d[0]) / detEm12,
      ];
      const uc12 = u12 + dot(gU12, sub(c12, vEm));
      const k0 = len(sub(c12, a12)),
        k1 = len(sub(b12, c12));
      if (
        uc12 > 0.0 &&
        lam12 > 0.0 &&
        dot(add(nOA, nOB), add(nOA, nOB)) > 0.0 &&
        k0 > 0.0 &&
        k1 > 0.0
      ) {
        const m12 = hookMidLine(a12, b12, c12, 0.5 / uc12, nOA, nOB);
        const side12 = m12.side(rA);
        aSide12 = side12 <= 0.0;
        bSide12 = side12 > 0.0;
      }
    }
    let f12, fx12, fy12, fxx12, fyy12, fxy12;
    if (cubic12) {
      const k12 = u12,
        l12 = v12,
        m12 = r12;
      f12 = s12 * (k12 * k12 * k12 - l12 * m12);
      fx12 = s12 * (3.0 * k12 * k12 * tx12d[0] - (tx12d[1] * m12 + l12 * tx12d[2]));
      fy12 = s12 * (3.0 * k12 * k12 * ty12d[0] - (ty12d[1] * m12 + l12 * ty12d[2]));
      fxx12 = s12 * (6.0 * k12 * tx12d[0] * tx12d[0] - 2.0 * tx12d[1] * tx12d[2]);
      fyy12 = s12 * (6.0 * k12 * ty12d[0] * ty12d[0] - 2.0 * ty12d[1] * ty12d[2]);
      fxy12 = s12 * (6.0 * k12 * tx12d[0] * ty12d[0] - (tx12d[1] * ty12d[2] + ty12d[1] * tx12d[2]));
    } else {
      f12 = s12 * (u12 * u12 - v12 * r12);
      fx12 = s12 * (2.0 * u12 * tx12d[0] - (tx12d[1] * r12 + v12 * tx12d[2]));
      fy12 = s12 * (2.0 * u12 * ty12d[0] - (ty12d[1] * r12 + v12 * ty12d[2]));
      fxx12 = s12 * (2.0 * tx12d[0] * tx12d[0] - 2.0 * tx12d[1] * tx12d[2]);
      fyy12 = s12 * (2.0 * ty12d[0] * ty12d[0] - 2.0 * ty12d[1] * ty12d[2]);
      fxy12 = s12 * (2.0 * tx12d[0] * ty12d[0] - (tx12d[1] * ty12d[2] + ty12d[1] * tx12d[2]));
    }
    const dpx12 = f12 / Math.max(len([fx12, fy12]), 1e-30);
    const chainA = Math.abs(tyA) > 0.5,
      chainB = Math.abs(tyB) > 0.5;
    if (!chainA) {
      if (aSide12 && dot(rA, sA12) < 0.0) return ((F._why = 'CURVE_BAND:spanA'), DISCARD);
    } else if (aSide12) {
      const bisA = add(nOA, nA12);
      if (dot(bisA, bisA) > 1e-6) {
        const wA12 = [-bisA[1], bisA[0]];
        if (dot(rA, wA12) * dot(wA12, sA12) < 0.0)
          return ((F._why = 'CURVE_BAND:bisectorA'), DISCARD);
      } else if (dot(rA, sA12) < 0.0) return ((F._why = 'CURVE_BAND:spanA2'), DISCARD);
    }
    if (!chainB) {
      if (bSide12 && dot(rB, sB12) < 0.0) return ((F._why = 'CURVE_BAND:spanB'), DISCARD);
    } else if (bSide12) {
      const bisB = add(nOB, nB12);
      if (dot(bisB, bisB) > 1e-6) {
        const wB12 = [-bisB[1], bisB[0]];
        if (dot(rB, wB12) * dot(wB12, sB12) <= 0.0)
          return ((F._why = 'CURVE_BAND:bisectorB'), DISCARD);
      } else if (dot(rB, sB12) < 0.0) return ((F._why = 'CURVE_BAND:spanB2'), DISCARD);
    }
    const wgA = chainA && aSide12 && dot(rA, sA12) < 0.0;
    const wgB = chainB && bSide12 && dot(rB, sB12) < 0.0;
    const fA12 = dot(nA12, rA) - 0.5 * kA12 * dot(rA, rA);
    const fB12 = dot(nB12, rB) - 0.5 * kB12 * dot(rB, rB);
    const gL12 = Math.max(len([fx12, fy12]), 1e-30); // no absolute floor: the curvature from the unit normal
    const nG12 = [fx12 / gL12, fy12 / gL12];
    const kOwnS12 =
      (fxx12 * nG12[1] * nG12[1] - 2.0 * fxy12 * nG12[0] * nG12[1] + fyy12 * nG12[0] * nG12[0]) /
      gL12;
    const kOwnPx = Math.abs(kOwnS12);
    const invPx12 = 1.0 / Math.max(vEmPerPx, 1e-12);
    let fOwn12, nOwn12, dOwn12;
    if (wgA || wgB) {
      const nOw = wgA ? nOA : nOB;
      const rw = wgA ? rA : rB;
      fOwn12 = dot(nOw, rw);
      if (opt.mirroredCornerFrame) {
        const nOwL = Math.max(len(nOw), 1e-9);
        nOwn12 = mul(nOw, 1 / nOwL);
        dOwn12 = -fOwn12 / (nOwL * Math.max(vEmPerPx, 1e-12));
      } else {
        const gOw = toWin(nOw),
          gOwL = Math.max(len(gOw), 1e-12);
        nOwn12 = mul(gOw, 1 / gOwL);
        dOwn12 = -fOwn12 / gOwL;
      }
    } else {
      fOwn12 = f12;
      nOwn12 = mul([fx12, fy12], 1 / gL12);
      const bias = opt.kappaScale != null ? opt.kappaScale : 1.0;
      dOwn12 = -f12 / gL12 - (bias * clamp(kOwnS12, -2.0, 2.0)) / 24.0;
    }
    const cOwn12 = Math.min(exactBoxCov(nOwn12, dOwn12), bound12);
    const rgA12 = 0.5 / Math.max(Math.max(Math.abs(kA12) * vEmPerPx, 1e-6), kOwnPx);
    const rgB12 = 0.5 / Math.max(Math.max(Math.abs(kB12) * vEmPerPx, 1e-6), kOwnPx);
    const gA12 = clamp(rgA12 - len(rA) / vEmPerPx, 0.0, 1.0);
    const gB12 = clamp(rgB12 - len(rB) / vEmPerPx, 0.0, 1.0);
    const cnA = Math.abs(tyA) > 0.5,
      cnB = Math.abs(tyB) > 0.5;
    const sOwn12 = fOwn12 < 0.0 ? 1.0 : 0.0;
    const sA12i = fA12 < 0.0 ? 1.0 : 0.0,
      sB12i = fB12 < 0.0 ? 1.0 : 0.0;
    const sAe12 = tyA > 0.5 ? (gA12 > 0.0 ? sA12i : 1.0) : gA12 > 0.0 ? sA12i : 0.0;
    const sBe12 = tyB > 0.5 ? (gB12 > 0.0 ? sB12i : 1.0) : gB12 > 0.0 ? sB12i : 0.0;
    let insid12 = sOwn12;
    if (cnA) insid12 = tyA > 0.5 ? Math.min(insid12, sAe12) : Math.max(insid12, sAe12);
    if (cnB) insid12 = tyB > 0.5 ? Math.min(insid12, sBe12) : Math.max(insid12, sBe12);
    if (insid12 > 0.5) return ((F._why = 'CURVE_BAND:inside'), DISCARD);
    let c12 = cOwn12;
    if (cnA && gate(gA12)) {
      const gA = toWin(nA12),
        gAL = Math.max(len(gA), 1e-12);
      const nAn12 = opt.mirroredCornerFrame
        ? mul(nA12, 1 / Math.max(len(nA12), 1e-9))
        : mul(gA, 1 / gAL);
      const dA12 = opt.mirroredCornerFrame ? -fA12 * invPx12 : -fA12 / gAL;
      let cA12 = exactBoxCov(nAn12, dA12);
      let interA12 = Math.min(exactBoxCov2(nOwn12, dOwn12, nAn12, dA12), cOwn12);
      if (tyA < 0.0) {
        // The neighbor's boundary starts at the shared vertex: past it (behind its span-start line) its half-plane
        // is no boundary at all, so the union takes the neighbor's region only on its own side of that line. Built in
        // EM from the em unit normal, then mapped into the window frame.
        const sN = mul(
          [-nA12[1], nA12[0]],
          (spanA12 > 0.5 ? -1.0 : 1.0) / Math.max(len(nA12), 1e-9),
        );
        const gF = toWin(sN),
          gFL = Math.max(len(gF), 1e-12);
        const nF = mul(gF, -1 / gFL),
          dF = dot(rA, sN) / gFL;
        cA12 = exactBoxCov2(nAn12, dA12, nF, dF);
        interA12 = Math.min(exactBoxCov3(nOwn12, dOwn12, nAn12, dA12, nF, dF), cOwn12);
      }
      const kpA12 = Math.max(0.0, dot(nOA, nA12));
      const exA12 =
        tyA > 0.0
          ? mix(clamp(c12 + interA12 - cOwn12, 0.0, 1.0), Math.min(c12, cA12), kpA12)
          : mix(clamp(c12 + cA12 - interA12, 0.0, 1.0), Math.max(c12, cA12), kpA12);
      c12 = mix(c12, exA12, gA12);
    }
    if (cnB && gate(gB12)) {
      const gB = toWin(nB12),
        gBL = Math.max(len(gB), 1e-12);
      const nBn12 = opt.mirroredCornerFrame
        ? mul(nB12, 1 / Math.max(len(nB12), 1e-9))
        : mul(gB, 1 / gBL);
      const dB12 = opt.mirroredCornerFrame ? -fB12 * invPx12 : -fB12 / gBL;
      let cB12 = exactBoxCov(nBn12, dB12);
      let interB12 = Math.min(exactBoxCov2(nOwn12, dOwn12, nBn12, dB12), cOwn12);
      if (tyB < 0.0) {
        // The neighbor's boundary starts at the shared vertex: past it (behind its span-start line) its half-plane
        // is no boundary at all, so the union takes the neighbor's region only on its own side of that line. Built in
        // EM from the em unit normal, then mapped into the window frame.
        const sN = mul(
          [-nB12[1], nB12[0]],
          (spanB12 > 0.5 ? -1.0 : 1.0) / Math.max(len(nB12), 1e-9),
        );
        const gF = toWin(sN),
          gFL = Math.max(len(gF), 1e-12);
        const nF = mul(gF, -1 / gFL),
          dF = dot(rB, sN) / gFL;
        cB12 = exactBoxCov2(nBn12, dB12, nF, dF);
        interB12 = Math.min(exactBoxCov3(nOwn12, dOwn12, nBn12, dB12, nF, dF), cOwn12);
      }
      const kpB12 = Math.max(0.0, dot(nOB, nB12));
      const exB12 =
        tyB > 0.0
          ? mix(clamp(c12 + interB12 - cOwn12, 0.0, 1.0), Math.min(c12, cB12), kpB12)
          : mix(clamp(c12 + cB12 - interB12, 0.0, 1.0), Math.max(c12, cB12), kpB12);
      c12 = mix(c12, exB12, gB12);
    }
    if (opt.debug)
      F._dbg = {
        tyA,
        tyB,
        cnA,
        cnB,
        wgA,
        wgB,
        gA12,
        gB12,
        cOwn12,
        nOwn12,
        dOwn12,
        fA12,
        fB12,
        nA12,
        nB12,
        kA12,
        kB12,
        nOA,
        nOB,
        c12,
        f12,
      };
    if (c12 <= 0.0) return ((F._why = 'CURVE_BAND:zero'), DISCARD);
    if (!wgA && !wgB && f12 < 0.0 && c12 < 0.999)
      return ((F._why = 'CURVE_BAND:fill-side'), DISCARD);
    if (!wgA && !wgB && fOwn12 >= 0.0 && s12 < 0.0) {
      const ab = sub(b12, a12);
      const abL2 = Math.max(dot(ab, ab), 1e-12);
      const t = clamp(dot(rA, ab) / abL2, 0.0, 1.0);
      const dChord =
        lbTangentTriDist(rA, ab, nOA, nOB, len(sub(rA, mul(ab, t)))) / Math.max(vEmPerPx, 1e-9);
      if (dChord > 1.5 && Math.abs(dpx12) < 1.0) return ((F._why = 'CURVE_BAND:chord1'), DISCARD);
      if (dChord > 1.2 && Math.abs(dpx12) < 0.7 && c12 < 0.95)
        return ((F._why = 'CURVE_BAND:chord2'), DISCARD);
    }
    // A center inside the fill at an UNCHAINED reflex end (inside the neighbour's plane AND on its own stretch) is
    // the interior's. opt.fixedConflictGate uses a `c12 < 0.12` conflict gate instead, for comparison.
    if (opt.fixedConflictGate) {
      if (!wgA && !wgB && fOwn12 >= 0.0 && c12 < 0.12) {
        if (gA12 > 0.0 && dot(nA12, rA) < 0.0) return ((F._why = 'CURVE_BAND:conflictA'), DISCARD);
        if (gB12 > 0.0 && dot(nB12, rB) < 0.0) return ((F._why = 'CURVE_BAND:conflictB'), DISCARD);
      }
    } else if (!wgA && !wgB && fOwn12 >= 0.0) {
      const uA12 = mul([-nA12[1], nA12[0]], GLmod(codeA, 2.0) > 0.5 ? 1.0 : -1.0);
      const uB12 = mul([-nB12[1], nB12[0]], GLmod(codeB, 2.0) > 0.5 ? 1.0 : -1.0);
      if (!cnA && gA12 > 0.0 && dot(sA12, nA12) > 0.0 && fA12 < 0.0 && dot(rA, uA12) >= 0.0)
        return ((F._why = 'CURVE_BAND:reflexInsideA'), DISCARD);
      if (!cnB && gB12 > 0.0 && dot(sB12, nB12) > 0.0 && fB12 < 0.0 && dot(rB, uB12) >= 0.0)
        return ((F._why = 'CURVE_BAND:reflexInsideB'), DISCARD);
    }
    F._hit = 'CURVE_BAND';
    return c12;
  }

  // ---- CHAIN_STRIP ----------------------------------------------------------
  if (kind === LBK.CHAIN_STRIP) {
    const invE = 1.0 / Math.max(vEmPerPx, 1e-12);
    const c0 = mul(sub(cCen, vEm), invE);
    const c1 = mul(sub([cScale, cHalf], vEm), invE);
    const c2 = mul(sub([F.LB0[0], F.LB0[1]], vEm), invE);
    const c3 = mul(sub([F.LB0[2], F.LB0[3]], vEm), invE);
    F._hit = 'CHAIN_STRIP';
    return chainBoxCov(c0, c1, c2, c3, c3, 0.0);
  }

  // ---- INTERIOR -------------------------------------------------------------
  if (kind === LBK.INTERIOR) {
    if (vTC[0] > 1.5) {
      const invE = 1.0 / Math.max(vEmPerPx, 1e-12);
      const c0 = mul(sub(cCen, vEm), invE);
      const c1 = mul(sub([cScale, cHalf], vEm), invE);
      const c2 = mul(sub([F.LB0[0], F.LB0[1]], vEm), invE);
      const c3 = mul(sub([F.LB0[2], F.LB0[3]], vEm), invE);
      const c4 = mul(sub([vTC[1], vTC[2]], vEm), invE);
      // CUBIC mode: the five points are a cubic's four and a straight neighbor, after it (sentinel 4) or
      // before it (5).
      const cubicMode = vTC[0] > 3.5;
      const cov0 = cubicMode
        ? cubicChainBoxCov(c0, c1, c2, c3, c4, vTC[0] > 4.5, 2.0)
        : chainBoxCov(c0, c1, c2, c3, c4, 2.0);
      let cov = cov0;
      const ch2 = F.LB1.some((x) => x !== 0) || F.LB2.some((x) => x !== 0);
      if (ch2 && !opt.noChain2) {
        const d0 = mul(sub([F.LB1[0], F.LB1[1]], vEm), invE);
        const d1 = mul(sub([F.LB1[2], F.LB1[3]], vEm), invE);
        const d2 = mul(sub([F.LB2[0], F.LB2[1]], vEm), invE);
        const d3 = mul(sub([F.LB2[2], F.LB2[3]], vEm), invE);
        // aSeamM = 1: chain 2 is one cubic
        cov = Math.min(
          cov,
          vSeam > 0.5
            ? cubicChainBoxCov(d0, d1, d2, d3, d3, false, 1.0)
            : chainBoxCov(d0, d1, d2, d3, d3, 1.0),
        );
      }
      F._hit = cubicMode ? 'INTERIOR_CUBIC' : 'INTERIOR_CHAIN';
      if (opt.noChainCov) return 1.0;
      return cov;
    }
    if (dot(cCen, cCen) > 1e-9) {
      const fi = dot(cCen, vEm) - cScale;
      let cA = slugCov(fi, mul(cCen, vEmPerPx));
      if (Math.abs(vLineT) > 0.5) {
        const fiB = dot([vLine2[0], vLine2[1]], vEm) - vLine2[2];
        const cB = slugCov(fiB, mul([vLine2[0], vLine2[1]], vEmPerPx));
        const invPx = 1.0 / Math.max(vEmPerPx, 1e-12);
        const inter =
          cA <= 0.0 || cB <= 0.0
            ? 0.0
            : cA >= 1.0
              ? cB
              : cB >= 1.0
                ? cA
                : exactBoxCov2(cCen, -fi * invPx, [vLine2[0], vLine2[1]], -fiB * invPx);
        cA = vLineT > 0.0 ? inter : cA + cB - inter;
      }
      if (Math.abs(cHalf) > 0.5 && dot([vTC[0], vTC[1]], [vTC[0], vTC[1]]) > 1e-9) {
        const cC = slugCov(dot([vTC[0], vTC[1]], vEm) - vTC[2], mul([vTC[0], vTC[1]], vEmPerPx));
        cA = cHalf > 0.0 ? Math.max(0.0, cA + cC - 1.0) : cA + cC - cA * cC;
      }
      F._hit = 'INTERIOR_LINE';
      return cA;
    }
    F._hit = 'INTERIOR_SOLID';
    return 1.0;
  }

  // ---- the shared tail: CUBIC / CUBIC_BEZ / ARC / DISC -----------------------
  let f = 0.0;
  let f4gEm = [0, 0];
  let f4has = false;
  if (kind === LBK.CUBIC) {
    f = vSign * (vTC[0] * vTC[0] * vTC[0] - vTC[1] * vTC[2]);
  } else if (kind === LBK.CUBIC_BEZ) {
    // A RING THAT CARRIES ITS ARC (seam 10): the box's exact share of the arc's ink side, as the shader.
    if (vSeam > 9.5) {
      const invE = 1.0 / Math.max(vEmPerPx, 1e-12),
        cell = (x, y) => mul(sub([x, y], vEm), invE);
      const q0 = cell(F.LB0[0], F.LB0[1]),
        q1 = cell(F.LB0[2], F.LB0[3]),
        q2 = cell(F.LB1[0], F.LB1[1]),
        q3 = cell(F.LB1[2], F.LB1[3]);
      const covArc = cubicChainBoxCov(q0, q1, q2, q3, q3, false, 0.0);
      if (covArc < 0.004) return DISCARD;
      F._hit = 'CUBIC_BEZ_ARC';
      return covArc;
    }
    const cM00 = [F.LB0[0], F.LB0[1], F.LB0[2]];
    const cM01 = [F.LB0[3], F.LB1[0], F.LB1[1]];
    const cM02 = [F.LB1[2], F.LB1[3], F.LB2[0]];
    const cM11a = F.LB2[1],
      cM12 = F.LB2[2],
      cM22 = F.LB2[3];
    const bez = (p) => {
      const n = [(p[0] - cCen[0]) / cScale, (p[1] - cCen[1]) / cScale];
      const lin02 = cM02[1] * n[0] + cM02[2] * n[1];
      const M00 = cM00[0] + cM00[1] * n[0] + cM00[2] * n[1];
      const M01 = cM01[0] + cM01[1] * n[0] + cM01[2] * n[1];
      const M02 = cM02[0] + lin02;
      const M11 = cM11a + lin02;
      const det =
        M00 * (M11 * cM22 - cM12 * cM12) -
        M01 * (M01 * cM22 - cM12 * M02) +
        M02 * (M01 * cM12 - M11 * M02);
      const d00 = M11 * cM22 - cM12 * cM12;
      const d01 = -2.0 * M01 * cM22 + 2.0 * M02 * cM12;
      const d02 = 2.0 * M01 * cM12 - 2.0 * M02 * M11;
      const d11 = M00 * cM22 - M02 * M02;
      const gN = [
        d00 * cM00[1] + d01 * cM01[1] + (d02 + d11) * cM02[1],
        d00 * cM00[2] + d01 * cM01[2] + (d02 + d11) * cM02[2],
      ];
      return { det, g: [(vSign * gN[0]) / cScale, (vSign * gN[1]) / cScale] };
    };
    const here = bez(vEm);
    f = vSign * here.det;
    f4gEm = here.g;
    f4has = true;
    // dFdx/dFdy of f4gEm: the GPU's 2x2-quad forward difference (helper pixels included). FINE by default: the
    // fragment's own row and column (F.emQuadX / F.emQuadY, which _lbRaster sets), because that is what ANGLE on Metal
    // takes -- the GPU readback of tiger's fills at 256 px matches the fine-derivative emulator to 1.6/255 and misses
    // the coarse one by 71 px, up to 55.7/255. `opt.coarseDeriv` takes one difference per quad, from its
    // top-left pixel, which another GPU may do; the choice moves Bezout coverage by up to 56/255.
    const q = F.emQuad;
    const fine = !opt.coarseDeriv && F.emQuadX && F.emQuadY;
    const qx = fine ? F.emQuadX : [q[0], q[1]],
      qy = fine ? F.emQuadY : [q[0], q[2]];
    F._g4x = sub(bez(qx[1]).g, bez(qx[0]).g);
    F._g4y = sub(bez(qy[1]).g, bez(qy[0]).g);
  } else if (kind === LBK.ARC) {
    f = (vSign > 0.0 ? 1.0 : -1.0) * (vTC[0] * vTC[0] - vTC[1] * vTC[2]);
  } else if (kind === LBK.DISC || kind === 6) {
    const d7 = sub(vEm, cCen);
    let G7, W7, w7;
    if (cHalf < -1.5) {
      const rx7 = Math.max(cScale, 1e-9),
        ry7 = Math.max(vNa[0], 1e-9);
      const c7 = vNa[1],
        s7 = vNb[0];
      const q7 = [(d7[0] * c7 + d7[1] * s7) / rx7, (-d7[0] * s7 + d7[1] * c7) / ry7];
      const Lq7 = Math.max(len(q7), 1e-9);
      f = vSign * (Lq7 - 1.0);
      const qh7 = mul(q7, 1 / Lq7),
        th7 = [-qh7[1], qh7[0]];
      G7 = [
        vSign * ((qh7[0] * c7) / rx7 - (qh7[1] * s7) / ry7),
        vSign * ((qh7[0] * s7) / rx7 + (qh7[1] * c7) / ry7),
      ];
      W7 = [(th7[0] * c7) / rx7 - (th7[1] * s7) / ry7, (th7[0] * s7) / rx7 + (th7[1] * c7) / ry7];
      w7 = vSign / Lq7;
    } else {
      const L7 = Math.max(len(d7), 1e-9);
      const dh7 = mul(d7, 1 / L7);
      let sig7 = 1.0,
        halfW7 = 0.0;
      if (kind === LBK.DISC && cHalf >= 0.0) {
        sig7 = L7 >= cScale ? 1.0 : -1.0;
        halfW7 = cHalf;
      }
      f = vSign * (sig7 * (L7 - cScale) - halfW7);
      G7 = mul(dh7, vSign * sig7);
      W7 = [-dh7[1], dh7[0]];
      w7 = (vSign * sig7) / L7;
    }
    const emx7 = F.demx,
      emy7 = F.demy;
    const fx7 = dot(G7, emx7),
      fy7 = dot(G7, emy7);
    const wx7 = dot(W7, emx7),
      wy7 = dot(W7, emy7);
    // A CIRCLE OR AN ANNULUS takes the exact moment over its own chord (arcCov); an ELLIPSE's
    // curvature varies along the level set, so it keeps the centered kappa/24. The two branches are
    // already distinguished by cHalf above, exactly as _lbCoverage.glsl distinguishes them.
    // `opt.noArcMoment` takes curveCov on both branches, kept so a number recorded under that
    // model can still be reproduced rather than merely asserted. It is not a shader arm: no define
    // makes _lbCoverage.glsl behave this way.
    const cov7 =
      cHalf < -1.5 || opt.noArcMoment
        ? curveCov(f, fx7, fy7, w7 * wx7 * wx7, w7 * wy7 * wy7, w7 * wx7 * wy7, opt)
        : arcCov(f, fx7, fy7, w7 * wx7 * wx7, w7 * wy7 * wy7, w7 * wx7 * wy7, opt);
    if (cov7 < 0.004) return DISCARD;
    F._hit = 'DISC';
    return cov7;
  } else {
    f = 0.0;
  }

  const txT = F.dtcx,
    tyT = F.dtcy;
  const emxT = F.demx,
    emyT = F.demy;
  const isCubic = kind === LBK.CUBIC;
  const isBez = kind === LBK.CUBIC_BEZ;
  const isRquad = kind === LBK.ARC;
  let cov;
  if (isCubic && vSeam > 0.5 && vSeam < 5.0) {
    const a = cCen,
      b = [cScale, cHalf];
    const clipEpsC = 0.05 * vEmPerPx;
    if (dot(sub(vEm, a), vNa) < -clipEpsC || dot(sub(vEm, b), vNb) < -clipEpsC) return DISCARD;
  } else if (isRquad) {
    const a = cCen,
      b = [cScale, cHalf],
      ch = sub(b, a);
    if (dot(ch, ch) > 1e-9 && (dot(sub(vEm, a), ch) < 0.0 || dot(sub(vEm, b), ch) > 0.0))
      return DISCARD;
  }
  if (isCubic || isRquad) {
    const tx = txT,
      ty = tyT;
    let fx, fy, fxx, fyy, fxy;
    if (isCubic) {
      const k = vTC[0],
        l = vTC[1],
        m = vTC[2];
      fx = vSign * (3.0 * k * k * tx[0] - (tx[1] * m + l * tx[2]));
      fy = vSign * (3.0 * k * k * ty[0] - (ty[1] * m + l * ty[2]));
      fxx = vSign * (6.0 * k * tx[0] * tx[0] - 2.0 * tx[1] * tx[2]);
      fyy = vSign * (6.0 * k * ty[0] * ty[0] - 2.0 * ty[1] * ty[2]);
      fxy = vSign * (6.0 * k * tx[0] * ty[0] - (tx[1] * ty[2] + ty[1] * tx[2]));
    } else {
      const s5 = vSign > 0.0 ? 1.0 : -1.0;
      const U = vTC[0],
        Vv = vTC[1],
        Rr = vTC[2];
      fx = s5 * (2.0 * U * tx[0] - (tx[1] * Rr + Vv * tx[2]));
      fy = s5 * (2.0 * U * ty[0] - (ty[1] * Rr + Vv * ty[2]));
      fxx = s5 * (2.0 * tx[0] * tx[0] - 2.0 * tx[1] * tx[2]);
      fyy = s5 * (2.0 * ty[0] * ty[0] - 2.0 * ty[1] * ty[2]);
      fxy = s5 * (2.0 * tx[0] * ty[0] - (tx[1] * ty[2] + ty[1] * tx[2]));
    }
    cov = curveCov(f, fx, fy, fxx, fyy, fxy, opt);
    if (isRquad && Math.abs(vSign) > 2.0) {
      const s5 = vSign > 0.0 ? 1.0 : -1.0;
      const gC = s5 * (vTC[1] - vTC[0]);
      const gG = [s5 * (tx[1] - tx[0]), s5 * (ty[1] - ty[0])];
      cov = Math.min(cov, slugCov(gC, gG));
    }
  } else if (f4has) {
    const m4 = [vTC[0], vTC[1]];
    let keep4 =
      opt.bezFence != null
        ? dot(m4, m4) > 0.0 && dot(m4, vEm) > vTC[2] + opt.bezFence * vEmPerPx
          ? 0
          : 1
        : bezKeepCov(m4, vTC[2], vEm, emxT, emyT);
    // a RING fragment: the keep half-plane AND the hull edge it was pushed from, the edge's offset in
    // vEmPerPx (lbVertexSetup)
    if (vSeam > 5.0 && !opt.morph && !opt.legacyRing && typeof opt.ringReach !== 'number') {
      const n4f = unpackHalf2x16(F.LB3[3]);
      if (dot(n4f, n4f) > 0) {
        const u4f = norm(n4f);
        keep4 =
          dot(m4, m4) > 0
            ? lbHalfPlanesBoxCov2(m4, vTC[2], u4f, vEmPerPx, vEm, emxT, emyT)
            : lbHalfPlaneBoxCov(u4f, vEmPerPx, vEm, emxT, emyT);
      }
    }
    if (keep4 <= 0) {
      cov = 0.0;
    } else {
      const fx4 = dot(f4gEm, emxT),
        fy4 = dot(f4gEm, emyT);
      const fxx4 = dot(F._g4x, emxT),
        fyy4 = dot(F._g4y, emyT);
      const fxy4 = dot(F._g4y, emxT);
      cov = Math.min(curveCov(f, fx4, fy4, fxx4, fyy4, fxy4, opt), keep4);
    }
  } else {
    F._unreachableTail = true; // no live kind reaches the first-order fallback
    cov = slugCov(f, [0, 0]);
  }
  if (!opt.noRingDiscard && (isCubic || isBez) && vSeam > 5.0 && cov < 0.999 && f < 0.0)
    return DISCARD;
  if (cov < 0.004) return DISCARD;
  F._hit = isCubic ? 'CUBIC' : isBez ? 'CUBIC_BEZ' : isRquad ? 'ARC' : 'OTHER';
  return cov;
}
