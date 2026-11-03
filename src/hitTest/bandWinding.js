// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bandWinding.js — the RENDERER's fill decision, on the CPU. A faithful JS twin of the
// Slug fill walk (_coverage.glsl fillLinear: the H/V band walkers with break-early,
// the calcRootCode2 LUT, the stable quadratic root pair, the clamped-Newton cubic solver
// with its apex-on-ray handling, the arc solvers, and the dual-ray blend fold), reading the
// same f32 band + curve buffers the shader reads.
//
// Purpose: hit testing that answers "is this point inside WHAT IS DRAWN". An independent
// f64 walk over re-decoded segments would be a parallel truth that can disagree with the
// render in razor cases. This walk cannot: same data,
// same algorithm, same conventions. Returns the render's coverage in [0,1] (a point is
// hit when coverage >= 0.5 — the drawn edge's midline); -1 when the bundle carries no
// band data (caller falls back to the segment walk).
//

const TEX_W = 4096;
const TWO_PI = Math.PI * 2;

// ---- CPU twins of the GLSL helpers (names and structure kept 1:1 for auditability) ----

const calcRootCode2 = (y1, y2, y3) => {
  const shift = (y1 < 0 ? 1 : 0) | (y2 < 0 ? 2 : 0) | (y3 < 0 ? 4 : 0);
  return (0x2e74 >> shift) & 0x0101;
};

// stable root pair (exact for a wide symmetric quad): q = b + sign(b)·d, other root c/q
function slugSolveQuad(a, b, cc, ax, bx, x0) {
  // solves a·t² − 2b·t + c = 0 in the ray axis; returns [r1, r2, t1, t2] with
  // r = (ax·t − 2bx)·t + x0 evaluated on the cross axis
  const d = Math.sqrt(Math.max(b * b - a * cc, 0));
  const q = b + (b >= 0 ? d : -d);
  const tBig = q / a;
  // no linear path and no guard on q: at a == 0 tSml is already the line's root c/(2b), the
  // only root the LUT admits there, and d > 0 makes |q| = |b| + d nonzero (see the shader)
  const tSml = d > 0 ? cc / q : tBig;
  const t1 = b >= 0 ? tSml : tBig;
  const t2 = b >= 0 ? tBig : tSml;
  return [(ax * t1 - bx * 2) * t1 + x0, (ax * t2 - bx * 2) * t2 + x0, t1, t2];
}

const cubicCoeff = (p1, p2, p3, p4) => [
  -p1 + 3 * p2 - 3 * p3 + p4,
  3 * (p1 - 2 * p2 + p3),
  3 * (p2 - p1),
  p1,
];
const evalC = (c, t) => ((c[0] * t + c[1]) * t + c[2]) * t + c[3];
const evalCD = (c, t) => (3 * c[0] * t + 2 * c[1]) * t + c[2];

/**
 * The critical points of y(t) in (0, 1) that split a cubic into y-monotone pieces: the roots of
 * qa·t² + qb·t + qc = 0 (qa = 3A, qb = 2B, qc = C), as [split1, split2], -1 for none. The shader's
 * solveCubicBisect block, line for line: the degeneracy test is RELATIVE to the coefficients in
 * play and the root pair is the stable one, so a small cubic keeps its splits and a nearly
 * symmetric one does not lose its apex root to cancellation.
 */
export function cubicSplits(qa, qb, qc) {
  let split1 = -1,
    split2 = -1;
  if (Math.abs(qa) <= 1e-6 * Math.max(Math.abs(qb), Math.abs(qc))) {
    if (Math.abs(qb) > 1e-30) {
      const s = -qc / qb;
      if (s > 0 && s < 1) split1 = s;
    }
  } else {
    const disc = qb * qb - 4 * qa * qc;
    if (disc >= 0) {
      const sd = Math.sqrt(disc);
      const qq = -0.5 * (qb + (qb >= 0 ? sd : -sd));
      let s1 = qq / qa,
        s2 = Math.abs(qq) > 1e-30 ? qc / qq : s1;
      if (s1 > s2) {
        const t = s1;
        s1 = s2;
        s2 = t;
      }
      if (s1 > 0 && s1 < 1) split1 = s1;
      if (s2 > 0 && s2 < 1) {
        if (split1 < 0) split1 = s2;
        else split2 = s2;
      }
    }
  }
  return [split1, split2];
}

// solveCubicBisect, on the CPU: monotone sub-intervals from the critical points, each crossing the ray
// cast a hair toward the negative side (0 counts as non-negative, the line walker's rule), with
// the segment's own ends taken as p1 and p4 exactly, the direction taken from the piece, and a
// root at t = 1 kept; secant-seeded clamped Newton (SLUG_NEWTON = 5). up[slot] is 1 for a crossing
// toward the positive side.
function solveCubicBisect(p1y, p2y, p3y, p4y, p1x, p2x, p3x, p4x, rs, ts, up) {
  rs[0] = rs[1] = rs[2] = 1e20;
  ts[0] = ts[1] = ts[2] = -1;
  up[0] = up[1] = up[2] = 0;
  const cy = cubicCoeff(p1y, p2y, p3y, p4y);
  const cx = cubicCoeff(p1x, p2x, p3x, p4x);
  let [split1, split2] = cubicSplits(3 * cy[0], 2 * cy[1], cy[2]);
  // A zero-speed end is a root of y' exactly: factor it out and take
  // the other root from the control points.
  const d0 = p2y - p1y,
    d1 = p3y - p2y,
    d2 = p4y - p3y;
  if (d0 === 0 || d2 === 0) {
    const tEnd = d2 === 0 ? 1 : 0;
    const num = d2 === 0 ? d0 : 2 * d1,
      den = d2 === 0 ? d0 - 2 * d1 : 2 * d1 - d2;
    const s = d0 === d2 || den === 0 ? -1 : num / den;
    let keep = -1;
    if (s > 0 && s < 1) {
      keep = s;
      if (split1 > 0 && Math.abs(split1 - s) < Math.abs(split1 - tEnd)) keep = split1;
      else if (split2 > 0 && Math.abs(split2 - s) < Math.abs(split2 - tEnd)) keep = split2;
    }
    split1 = keep;
    split2 = -1;
  }
  const bds = [0, 0, 0, 0];
  let nb = 1;
  if (split1 > 0) bds[nb++] = split1;
  if (split2 > 0) bds[nb++] = split2;
  bds[nb++] = 1;
  let slot = 0;
  for (let i = 0; i + 1 < nb; i++) {
    const lo = bds[i],
      hi = bds[i + 1];
    const yLo = i === 0 ? p1y : evalC(cy, lo),
      yHi = i + 2 === nb ? p4y : evalC(cy, hi);
    const sLo = yLo >= 0,
      sHi = yHi >= 0;
    if (sLo === sHi) continue;
    const sden = yHi - yLo; // the ends straddle zero, so nonzero
    let xr = Math.min(hi, Math.max(lo, lo - (yLo * (hi - lo)) / sden));
    // SAFEGUARDED, as the shader's: each iterate narrows the proven bracket, and a step
    // that would leave it bisects. A zero-speed end (a coincident handle) is flat, so the secant seed
    // lands there and plain clamped Newton parked at the far end for all five iterations.
    // A piece end exactly on the ray is the root as it stands (the shader's onEnd).
    let bl = lo,
      bh = hi;
    const onEnd = yHi === 0 || yLo === 0;
    if (onEnd) xr = yHi === 0 ? hi : lo;
    for (let k = 0; k < 5 && !onEnd; k++) {
      const fy = evalC(cy, xr);
      if (fy === 0) break;
      if (fy >= 0 === sLo) bl = xr;
      else bh = xr;
      const fdy = evalCD(cy, xr);
      const xn = fdy !== 0 ? xr - fy / fdy : 0.5 * (bl + bh);
      xr = xn >= bl && xn <= bh ? xn : 0.5 * (bl + bh);
    }
    if (slot < 3) {
      ts[slot] = xr;
      rs[slot] = evalC(cx, xr);
      up[slot] = sHi ? 1 : 0;
      slot++;
    }
  }
}

/*

 */
export const arcRayUlp = (c, rx, ry) => 1.2e-7 * (Math.abs(c) + Math.abs(rx) + Math.abs(ry));

/**
 * One monotone piece [ta, tb] of arcRayCrossings — the CPU twin of _coverage.glsl's arcPieceCross (the
 * count) and arcPieceRoot (band-hard's θ, which Slug's closed form does without): 0 when its
 * ends' u do not straddle the ray, else 1 where the end the path reaches last is non-negative and 2
 * where it is negative, with the crossing's θ. The line rule: a centered u of exactly 0 counts as
 * NON-NEGATIVE.
 */
function arcPieceCross(ta, ua, tb, ub, dir, ang, b2) {
  const aNeg = ua < 0,
    bNeg = ub < 0;
  if (aNeg === bNeg) return [0, ta];
  // u falls at ang + b2 and rises at ang − b2; the congruent value nearest the piece's midpoint
  let t = bNeg ? ang + b2 : ang - b2;
  t += TWO_PI * Math.floor((0.5 * (ta + tb) - t) / TWO_PI + 0.5);
  return [(dir > 0 ? bNeg : aNeg) ? 2 : 1, Math.min(tb, Math.max(ta, t))];
}

/**
 * An arc's crossings of a ray, COUNTED FROM THE ENDPOINT SIDES — the CPU twin of _coverage.glsl's
 * arcRayCrossings, which both of the shader's arc walkers share. u(θ) =
 * A·cosθ + B·sinθ − C is the arc's ray-centered crossing coordinate; it is monotone between its
 * stationary angles, so on each monotone piece the line rule is complete: the ends straddle the
 * ray (exactly one crossing, signed by the end the path reaches last) or they do not. The solve
 * only locates the crossing. `lo`/`hi` are the sweep's ends in θ order, `dir` the path's
 * direction, uLo/uHi their u. `aa` drops a TOUCHING pair — two crossings a hair apart at the
 * extremum facing a ray within 1e-5·Rlen of it, which cancel in the count but would give a ray
 * tangent to the outline full ramp weight (the shader's note has the measurement). Returns three
 * [code, θ] slots in θ order, one per fixed piece: code 0 for none, 1 for a crossing whose last
 * end along the path is non-negative, 2 for one whose last end is negative.
 */
export function arcRayCrossings(lo, hi, dir, A, B, C, uLo, uHi, aa) {
  const NONE = [
    [0, lo],
    [0, lo],
    [0, lo],
  ];
  const Rlen = Math.hypot(A, B);
  if (!(Rlen > 0)) return NONE; // a zero extent on the crossing axis never crosses
  const nLo = uLo < 0;
  if (nLo === uHi < 0 && nLo === Rlen - C < 0 && nLo === -Rlen - C < 0) return NONE;
  const ang = B === 0 ? (A >= 0 ? 0 : Math.PI) : Math.atan2(B, A);
  // the two stationary angles at or after lo; one outside the sweep collapses its piece to a point.
  // cos(kπ) = (−1)^k: a stationary angle's u is ±Rlen − C exactly
  const k0 = Math.ceil((lo - ang) / Math.PI),
    k1 = k0 + 1;
  const e0 = ang + k0 * Math.PI,
    e1 = ang + k1 * Math.PI;
  const in0 = e0 > lo && e0 < hi,
    in1 = e1 > lo && e1 < hi;
  const sv = (k) => (((k % 2) + 2) % 2 === 0 ? Rlen : -Rlen) - C;
  const t1 = in0 ? e0 : lo,
    u1 = in0 ? sv(k0) : uLo;
  const t2 = in1 ? e1 : hi,
    u2 = in1 ? sv(k1) : uHi;
  const b2 = Math.acos(Math.max(-1, Math.min(1, C / Rlen)));
  const cr = [
    arcPieceCross(lo, uLo, t1, u1, dir, ang, b2),
    arcPieceCross(t1, u1, t2, u2, dir, ang, b2),
    arcPieceCross(t2, u2, hi, uHi, dir, ang, b2),
  ];
  // a touching PAIR (aa only): two neighboring pieces that both cross, at the extremum facing the ray
  if (aa && Math.abs(C / Rlen) >= 0.99999) {
    const nearU = (C > 0 ? Rlen : -Rlen) - C;
    if (cr[0][0] && cr[1][0] && u1 === nearU) {
      cr[0] = [0, lo];
      cr[1] = [0, lo];
    } else if (cr[1][0] && cr[2][0] && u2 === nearU) {
      cr[1] = [0, lo];
      cr[2] = [0, lo];
    }
    // the extremum at the sweep's own ends (see _coverage.glsl): a closed arc whose seam is the facing extremum
    else if (uLo === nearU && uHi === nearU) {
      if (cr[1][0] && cr[2][0]) {
        cr[1] = [0, lo];
        cr[2] = [0, lo];
      } else if (cr[0][0] && cr[1][0]) {
        cr[0] = [0, lo];
        cr[1] = [0, lo];
      }
    }
  }
  return cr;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// exact area of the unit pixel box under the half-plane {x : n·x <= d}, |n| = 1
function exactBoxCov(nx, ny, d) {
  const a = Math.max(Math.abs(nx), Math.abs(ny));
  const b = Math.min(Math.abs(nx), Math.abs(ny));
  const ssum = 0.5 * (a + b),
    t = 0.5 * (a - b);
  if (d <= -ssum) return 0;
  if (d >= ssum) return 1;
  const ab = Math.max(2 * a * b, 1e-12);
  if (d <= -t) return ((d + ssum) * (d + ssum)) / ab;
  if (d >= t) return 1 - ((ssum - d) * (ssum - d)) / ab;
  return 0.5 + d / Math.max(a, 1e-12);
}

/**
 * The walker's packed tangent (_coverage.glsl slPackDir): x / (|x| + |y|), plus 4 where y < 0; 8 = none.
 */
export function slPackDir(x, y) {
  const s = Math.abs(x) + Math.abs(y);
  return s > 0 ? x / s + (y < 0 ? 4 : 0) : 8;
}

/**
 * renderFill's tail with the exact-edge branch compiled out (the default): the walk's per-ray
 * windings and blend weights, plus the nearest crossing on each ray and the path's packed tangent
 * there, to the drawn coverage. Line for line the shader's tail (renderFillM), including THE CORNER
 * CLIP and THE LOCAL CURVE and the pixel-space footprint -- see _coverage.glsl.
 * `mx`, `my` are the em -> pixel map's columns; the default is the axis-aligned map, where only the
 * direction matters (the walk's offsets are already in pixels), so (1, 0) and (0, 1).
 */
export function renderFillTail(
  xcov,
  ycov,
  xwgt,
  ywgt,
  slH,
  slV,
  evenOdd,
  slHt = 8,
  slVt = 8,
  mx = [1, 0],
  my = [0, 1],
) {
  // `mag` is a WINDING magnitude, not a coverage: the fill rule turns it into `est`, and only
  // `est` is compared.
  const wsum = Math.max(xwgt + ywgt, 1 / 65536);
  const mag = Math.max(
    Math.abs(xcov * xwgt + ycov * ywgt) / wsum,
    Math.min(Math.abs(xcov), Math.abs(ycov)),
  );
  const est = evenOdd
    ? 1 - Math.abs(1 - (mag * 0.5 - Math.floor(mag * 0.5)) * 2)
    : Math.min(1, Math.max(0, mag));
  // SLOPE-AA, always on: the boundary secant through the two nearest crossings a = (slH, 0) and
  // b = (0, slV), on a ramp pixel, or on a corner pixel of one gentle boundary edge, when that model
  // reproduces both rays' coverages. No `mag < 1.25` guard on a ramp: under nonzero est < 0.998
  // already means mag < 0.998.
  const ramp = est > 0.002 && est < 0.998;
  const px = [
    Math.max(Math.abs(mx[0]), Math.abs(mx[1])),
    Math.max(Math.abs(my[0]), Math.abs(my[1])),
  ];
  if (Math.abs(slH) < 8 && Math.abs(slV) < 8) {
    const a = slH,
      b = slV;
    const uHx = mx[0] / px[0],
      uHy = mx[1] / px[0],
      uVx = my[0] / px[1],
      uVy = my[1] / px[1];
    const Ax = a * uHx,
      Ay = a * uHy,
      Bx = b * uVx,
      By = b * uVy;
    const n0x = By - Ay,
      n0y = Ax - Bx;
    const L0 = Math.hypot(n0x, n0y);
    if (L0 > 1e-6) {
      const nx = n0x / L0,
        ny = n0y / L0,
        d = (n0x * Ax + n0y * Ay) / L0;
      if (!ramp && Math.abs(d) >= 0.5 * (Math.abs(nx) + Math.abs(ny))) return est; // a corner pixel the chord misses
      let lens = 0,
        tAx = 0,
        tAy = 0,
        gentle = false;
      if (slHt < 6 && slVt < 6) {
        const xA = slHt > 2 ? slHt - 4 : slHt,
          xB = slVt > 2 ? slVt - 4 : slVt;
        const yA = (slHt > 2 ? -1 : 1) * (1 - Math.abs(xA)),
          yB = (slVt > 2 ? -1 : 1) * (1 - Math.abs(xB));
        const iA = 1 / Math.sqrt(xA * xA + yA * yA),
          iB = 1 / Math.sqrt(xB * xB + yB * yB);
        const tBx = xB * iB,
          tBy = yB * iB;
        tAx = xA * iA;
        tAy = yA * iA;
        const chx = (Bx - Ax) / L0,
          chy = (By - Ay) / L0;
        const oA = tAx * chx + tAy * chy,
          oB = tBx * chx + tBy * chy;
        const cr = tAx * tBy - tAy * tBx;
        if (oA * oB > 0) {
          if (Math.abs(cr) < 1e-5) {
            gentle =
              Math.abs(tAx * chy - tAy * chx) < 0.02 && Math.abs(tBx * chy - tBy * chx) < 0.02;
          } else {
            const sC = ((Bx - Ax) * tBy - (By - Ay) * tBx) / cr;
            const u = (sC * oA) / L0;
            const h = nx * (Ax + sC * tAx) + ny * (Ay + sC * tAy) - d;
            let lo = -1e30,
              hi = 1e30;
            if (Math.abs(chx) > 1e-12) {
              const t1 = (-0.5 - Ax) / chx,
                t2 = (0.5 - Ax) / chx;
              lo = Math.max(lo, Math.min(t1, t2));
              hi = Math.min(hi, Math.max(t1, t2));
            } else if (Math.abs(Ax) > 0.5) hi = lo;
            if (Math.abs(chy) > 1e-12) {
              const t1 = (-0.5 - Ay) / chy,
                t2 = (0.5 - Ay) / chy;
              lo = Math.max(lo, Math.min(t1, t2));
              hi = Math.min(hi, Math.max(t1, t2));
            } else if (Math.abs(Ay) > 0.5) hi = lo;
            const g = (2 * h) / (L0 * L0);
            if (
              u >= 0.3 &&
              u <= 0.7 &&
              tAx * tBx + tAy * tBy >= 0.7071 &&
              2 * Math.abs(g) * Math.max(hi - lo, L0) <= 1
            ) {
              gentle = true;
              if (hi > lo)
                lens = g * (L0 * (hi * hi - lo * lo) * 0.5 - (hi * hi * hi - lo * lo * lo) / 3);
            }
          }
        }
      }
      const corner =
        !ramp &&
        gentle &&
        (evenOdd ||
          Math.abs(xcov) < 0.5 !==
            Math.abs(xcov + Math.sign(uHx * tAy - uHy * tAx) * Math.sign(a)) < 0.5);
      if (ramp || corner) {
        // each ray's coverage through the fill rule, as est is: under even-odd an interior edge's
        // ray reads a winding between 1 and 2, and 1.96 is 4% covered, not solid
        const cH = evenOdd
          ? 1 - Math.abs(1 - (Math.abs(xcov) * 0.5 - Math.floor(Math.abs(xcov) * 0.5)) * 2)
          : Math.min(1, Math.abs(xcov));
        const cV = evenOdd
          ? 1 - Math.abs(1 - (Math.abs(ycov) * 0.5 - Math.floor(Math.abs(ycov) * 0.5)) * 2)
          : Math.min(1, Math.abs(ycov));
        const pH = clamp01(0.5 + (nx * uHx + ny * uHy > 0 ? slH : -slH)),
          pV = clamp01(0.5 + (nx * uVx + ny * uVy > 0 ? slV : -slV));
        const e1 = Math.abs(pH - cH) + Math.abs(pV - cV),
          e2 = Math.abs(1 - pH - cH) + Math.abs(1 - pV - cV);
        if (Math.min(e1, e2) < 0.02) {
          const ec = clamp01(exactBoxCov(nx, ny, d) + lens);
          return e1 <= e2 ? ec : 1 - ec;
        }
      }
    }
  }
  return est;
}

/// THE CROSSING-AXIS LANES, as svg/textures.js writes them (BAND_HDR_RAY_LANES; this file
/// imports nothing, so it is restated here): bit 0 of a band header's texel 1 .y says the list's entries
/// carry (min, max) on the crossing axis in (z, w). Both read at the band header the walk fetches anyway.
const RAY_LANES_BIT = 1;

/**
 * The render's fill coverage at em point (cxq, cyq) for one shape, from its band + curve
 * buffers. `gd` = [glyphLoc.x, glyphLoc.y, bandMaxX, bandMaxY] (meta texel 4), `bb` =
 * the shape bbox meta floats (the same bbox the encoder banded over), `pxx/pxy` = pixels
 * per em (the AA scale; the 0.5 decision level is scale-independent).
 *
 * `opts.rayReject` (default true) takes the lane reject the shader takes; false walks every entry, which
 * is what a list without lanes gets anyway -- the smoke that proves the reject changes no answer runs
 * both. `opts.stats`, when given, counts per ray (0 = H, 1 = V) and segment type the entries that reach
 * the reject (`test`) and the ones it skips (`skip`): `{ test: [[0,0,0,0],[0,0,0,0]], skip: (same) }`.
 * `opts.state`, when given (length 8), receives (xcov, ycov, xwgt, ywgt, slH, slV, slHt, slVt) as the walk ends.
 */
export function bandFillCoverage(bandF, curveF, gd, bb, cxq, cyq, pxx, pxy, evenOdd, opts = null) {
  const rayReject = !(opts && opts.rayReject === false);
  const stats = opts && opts.stats ? opts.stats : null;
  const glx = gd[0] | 0,
    gly = gd[1] | 0;
  const bandsX = (gd[2] | 0) + 1,
    bandsY = (gd[3] | 0) + 1;
  // the bands' box, as the encoder and the shader's bandBoxSize form it (no absolute floor)
  const ew = bb[2] - bb[0],
    eh = bb[3] - bb[1];
  const bbw = ew > 0 ? ew : eh > 0 ? eh : 1,
    bbh = eh > 0 ? eh : ew > 0 ? ew : 1;
  const bix = Math.min(bandsX - 1, Math.max(0, Math.floor(((cxq - bb[0]) / bbw) * bandsX)));
  const biy = Math.min(bandsY - 1, Math.max(0, Math.floor(((cyq - bb[1]) / bbh) * bandsY)));
  // bLoc: linear texel index with row wrap at 4096
  const bTex = (off) => {
    const idx = gly * TEX_W + glx + off;
    return idx * 4;
  };
  const hBreak = cxq * pxx - 0.5,
    vBreak = cyq * pxy - 0.5;
  let xcov = 0,
    ycov = 0,
    xwgt = 0,
    ywgt = 0;
  // SL_H / SL_V: the signed pixel offset of the crossing nearest the pixel center on each ray, and the path's
  // tangent there in pixel units, oriented as the crossing was counted (an H crossing that adds runs toward -y, a V
  // crossing that adds toward +x) and packed (slPackDir)
  let slH = 1e30,
    slV = 1e30,
    slHt = 8,
    slVt = 8;
  const apply = (horiz, ri, sgn, tx, ty) => {
    const cv = sgn * clamp01(ri + 0.5);
    if (horiz) {
      xcov += cv;
      xwgt = Math.max(xwgt, clamp01(1 - Math.abs(ri) * 2));
      if (Math.abs(ri) < Math.abs(slH)) {
        slH = ri;
        slHt = ty * sgn > 0 ? slPackDir(-tx * pxx, -ty * pxy) : slPackDir(tx * pxx, ty * pxy);
      }
    } else {
      ycov += cv;
      ywgt = Math.max(ywgt, clamp01(1 - Math.abs(ri) * 2));
      if (Math.abs(ri) < Math.abs(slV)) {
        slV = ri;
        slVt = tx * sgn < 0 ? slPackDir(-tx * pxx, -ty * pxy) : slPackDir(tx * pxx, ty * pxy);
      }
    }
  };
  // The crossings of a ray are buffered and flushed at the end of its pass: two crossings at the same ri with opposite signs are
  // a ray through a VERTEX whose two segments both lie on one side of it (the touching pair found across two arcs
  // sharing an extremum: each counts the vertex by the exact sign rule, one up and one down). They cancel in the count either
  // way; but their ramp weights say nothing about the pixel -- the ray only grazes the outline -- so the pair is dropped whole,
  // count and weight, as arcRayCrossings drops it within one arc. exact float equality of ri, no tolerance: both segments read
  // the one stored vertex (a crossing at an arc's end, and a line's end on the ray, take its coordinate as stored), so the
  // decision is the same at every coordinate scale.
  const pend = [];
  const crossed = (horiz, ri, sgn, tx, ty) => {
    pend.push(horiz, ri, sgn, tx, ty);
  };
  const flush = () => {
    const n = pend.length / 5,
      dead = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (dead[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (
          !dead[j] &&
          pend[5 * j + 1] === pend[5 * i + 1] &&
          pend[5 * j + 2] === -pend[5 * i + 2]
        ) {
          dead[i] = 1;
          dead[j] = 1;
          break;
        }
      }
    }
    for (let i = 0; i < n; i++)
      if (!dead[i])
        apply(pend[5 * i], pend[5 * i + 1], pend[5 * i + 2], pend[5 * i + 3], pend[5 * i + 4]);
    pend.length = 0;
  };
  const rs = [0, 0, 0],
    tsv = [0, 0, 0],
    upv = [0, 0, 0];

  for (let pass = 0; pass < 2; pass++) {
    const horiz = pass === 0;
    const hdr = horiz ? biy * 2 : bandsY * 2 + bix * 2;
    const cb = bTex(hdr);
    const nLine = bandF[cb] | 0,
      nQuad = bandF[cb + 1] | 0,
      nCubic = bandF[cb + 2] | 0,
      nArc = bandF[cb + 3] | 0;
    const h1 = bTex(hdr + 1);
    const arrIdx = bandF[h1] | 0;
    const brk = horiz ? hBreak : vBreak;
    const pxa = horiz ? pxx : pxy;
    // THE LANE REJECT (_coverage.glsl fillRayReject / rayLaneMiss): the entry's crossing-axis range lies
    // wholly on one side of the ray -- max below it, or min at or above it, 0 counting as non-negative as in
    // every sign test below -- so the segment cannot cross it, and it is skipped before its curve texels are
    // read. The same comparison as the shader's; here in float64 of the float32 values, where the sign of a
    // difference is exact, so it agrees with the end signs and root codes below by construction.
    const lanes = rayReject && ((bandF[h1 + 1] | 0) & RAY_LANES_BIT) !== 0;
    const ray = horiz ? cyq : cxq;
    const miss = (e) => bandF[e + 3] - ray < 0 || bandF[e + 2] - ray >= 0;
    const tally = (type, e) => {
      if (stats) stats.test[pass][type]++;
      if (!(lanes && miss(e))) return false;
      if (stats) stats.skip[pass][type]++;
      return true;
    };
    let off = 0;
    // ONE entry per texel: (loc, breakAxis, z, w). Returns the entry's
    // float offset. This mirrors the GPU's bandEntry — the two read the same
    // buffer, so a packing change has to land in both or the CPU hit test and
    // the rendered pixels disagree about which segments exist.
    const entry = (k) => bTex(arrIdx + off + k);
    // ---- LINES ----
    for (let i = 0; i < nLine; i++) {
      const e = entry(i);
      if (bandF[e + 1] * pxa < brk) break;
      if (tally(0, e)) continue;
      const d = ((bandF[e] | 0) + 1) * 4;
      const p1a = curveF[d] - cxq,
        p1b = curveF[d + 1] - cyq;
      const p2a = curveF[d + 2] - cxq,
        p2b = curveF[d + 3] - cyq;
      // ray-parallel coordinate = the OTHER axis; eligibility on the crossing axis
      const c1 = horiz ? p1b : p1a,
        c2 = horiz ? p2b : p2a;
      const r1 = horiz ? p1a : p1b,
        r2 = horiz ? p2a : p2b;
      if (Math.max(r1, r2) * pxa < -0.5) continue;
      const p1Neg = c1 < 0,
        p2Neg = c2 < 0;
      if (p1Neg === p2Neg) continue;
      const dd = c2 - c1; // nonzero: the endpoints straddle the ray
      const t = -c1 / dd;
      // an end ON the ray is the stored vertex: its coordinate as stored, not as the interpolation rounds it
      const ri = (c1 === 0 ? r1 : c2 === 0 ? r2 : r1 + t * (r2 - r1)) * pxa;
      const sgn = horiz ? (p2Neg ? 1 : -1) : p2Neg ? -1 : 1;
      crossed(horiz, ri, sgn, p2a - p1a, p2b - p1b);
    }
    off += nLine;
    // ---- QUADS ----
    for (let i = 0; i < nQuad; i++) {
      const e = entry(i);
      if (bandF[e + 1] * pxa < brk) break;
      if (tally(1, e)) continue;
      const d = ((bandF[e] | 0) + 1) * 4;
      const p1a = curveF[d] - cxq,
        p1b = curveF[d + 1] - cyq;
      const p2a = curveF[d + 2] - cxq,
        p2b = curveF[d + 3] - cyq;
      const d2 = ((bandF[e] | 0) + 2) * 4;
      const p3a = curveF[d2] - cxq,
        p3b = curveF[d2 + 1] - cyq;
      const cA = horiz ? [p1b, p2b, p3b] : [p1a, p2a, p3a]; // crossing axis
      const rA = horiz ? [p1a, p2a, p3a] : [p1b, p2b, p3b]; // ray axis
      if (Math.max(rA[0], rA[1], rA[2]) * pxa < -0.5) continue;
      const code = calcRootCode2(cA[0], cA[1], cA[2]);
      if (code === 0) continue;
      const a = cA[0] - 2 * cA[1] + cA[2],
        b = cA[0] - cA[1];
      const ax = rA[0] - 2 * rA[1] + rA[2],
        bx = rA[0] - rA[1];
      const rt = slugSolveQuad(a, b, cA[0], ax, bx, rA[0]);
      // the tangent at t, (P2 - P1)(1 - t) + (P3 - P2) t (any positive scale: only its direction is kept)
      const qtx = (t) => (p2a - p1a) * (1 - t) + (p3a - p2a) * t,
        qty = (t) => (p2b - p1b) * (1 - t) + (p3b - p2b) * t;
      if ((code & 1) !== 0 && isFinite(rt[0])) {
        const ri = rt[0] * pxa;
        crossed(horiz, ri, horiz ? 1 : -1, qtx(rt[2]), qty(rt[2]));
      }
      if (code > 1 && isFinite(rt[1])) {
        const ri = rt[1] * pxa;
        crossed(horiz, ri, horiz ? -1 : 1, qtx(rt[3]), qty(rt[3]));
      }
    }
    off += nQuad;
    // ---- CUBICS ----
    for (let i = 0; i < nCubic; i++) {
      const e = entry(i);
      if (bandF[e + 1] * pxa < brk) break;
      if (tally(2, e)) continue;
      const d = ((bandF[e] | 0) + 1) * 4;
      const q1 = curveF[d] - cxq,
        q2 = curveF[d + 1] - cyq;
      const q3 = curveF[d + 2] - cxq,
        q4 = curveF[d + 3] - cyq;
      const d2 = ((bandF[e] | 0) + 2) * 4;
      const q5 = curveF[d2] - cxq,
        q6 = curveF[d2 + 1] - cyq;
      const q7 = curveF[d2 + 2] - cxq,
        q8 = curveF[d2 + 3] - cyq;
      const rx = horiz ? [q1, q3, q5, q7] : [q2, q4, q6, q8];
      const ry = horiz ? [q2, q4, q6, q8] : [q1, q3, q5, q7];
      if (Math.max(rx[0], rx[1], rx[2], rx[3]) * pxa < -0.5) continue;
      solveCubicBisect(ry[0], ry[1], ry[2], ry[3], rx[0], rx[1], rx[2], rx[3], rs, tsv, upv);
      for (let j = 0; j < 3; j++) {
        if (tsv[j] < 0 || rs[j] !== rs[j]) continue; // an unfilled slot has t = -1; t = 1 is a crossing
        const ri = rs[j] * pxa;
        // H: a downward crossing ADDS. V: the reversed root convention absorbed, one toward +x ADDS.
        const sgn = horiz ? (upv[j] ? -1 : 1) : upv[j] ? 1 : -1;
        const t = tsv[j],
          u = 1 - t;
        crossed(
          horiz,
          ri,
          sgn,
          (q3 - q1) * u * u + (q5 - q3) * 2 * u * t + (q7 - q5) * t * t,
          (q4 - q2) * u * u + (q6 - q4) * 2 * u * t + (q8 - q6) * t * t,
        );
      }
    }
    off += nCubic;
    // ---- ARCS ----
    for (let i = 0; i < nArc; i++) {
      const e = entry(i);
      if (bandF[e + 1] * pxa < brk) break;
      if (tally(3, e)) continue;
      const d = ((bandF[e] | 0) + 1) * 4;
      const acx = curveF[d],
        acy = curveF[d + 1],
        arx = curveF[d + 2],
        ary = curveF[d + 3];
      const d2 = ((bandF[e] | 0) + 2) * 4;
      const th0 = curveF[d2],
        th1 = curveF[d2 + 1],
        phi = curveF[d2 + 2];
      const sp = Math.sin(phi),
        cp = Math.cos(phi);
      const axr = cp * arx,
        bxr = sp * ary,
        ayr = sp * arx,
        byr = cp * ary;
      const at = (th) => [
        acx + axr * Math.cos(th) - bxr * Math.sin(th),
        acy + ayr * Math.cos(th) + byr * Math.sin(th),
      ];
      // THE ENDPOINT SIDES COUNT THE CROSSINGS (_coverage.glsl's H arc sub-loop and its V twin):
      // arcRayCrossings splits the sweep into monotone pieces on the crossing axis and takes one
      // crossing per piece whose ends straddle the ray, so an endpoint near the ray is decided by the
      // same exact sign test the line walker applies to the segment sharing it. The sweep in θ order,
      // as the shader's arcSweep forms it: a full turn or more is one full ellipse.
      const lo = Math.min(th0, th1),
        hi = Math.min(Math.max(th0, th1), lo + TWO_PI),
        dir = th1 >= th0 ? 1 : -1;
      // the ENDS are the record's stored vertices, in path order: the floats the neighbors store
      const dE = ((bandF[e] | 0) + 3) * 4;
      const pS = [curveF[dE], curveF[dE + 1]],
        pE = [curveF[dE + 2], curveF[dE + 3]];
      const pLo = dir > 0 ? pS : pE,
        pHi = dir > 0 ? pE : pS;
      // H solves y(θ) = cyq: A = sp·rx, B = cp·ry, C = −(cy − cyq).
      // V solves x(θ) = cxq: A = cp·rx, B = −sp·ry, C = −(cx − cxq).
      const hits = horiz
        ? arcRayCrossings(
            lo,
            hi,
            dir,
            sp * arx,
            cp * ary,
            -(acy - cyq),
            pLo[1] - cyq,
            pHi[1] - cyq,
            true,
          )
        : arcRayCrossings(
            lo,
            hi,
            dir,
            cp * arx,
            -sp * ary,
            -(acx - cxq),
            pLo[0] - cxq,
            pHi[0] - cxq,
            true,
          );
      for (const [code, th] of hits) {
        if (code === 0) continue;

        const p = th === lo ? pLo : th === hi ? pHi : at(th);
        const ri = (horiz ? p[0] - cxq : p[1] - cyq) * pxa;
        // code 2: the path's last end is on the negative side. H: a crossing the path makes toward −y
        // ADDS. V: one toward +x ADDS, so toward −x subtracts.
        const endNeg = code === 2;
        const sgn = horiz ? (endNeg ? 1 : -1) : endNeg ? -1 : 1;
        crossed(
          horiz,
          ri,
          sgn,
          -axr * Math.sin(th) - bxr * Math.cos(th),
          -ayr * Math.sin(th) + byr * Math.cos(th),
        );
      }
    }
    flush();
  }
  // `opts.state` receives the walk's whole state -- what the reject must leave exactly as it was, since the
  // tail and the shader's exact-edge branch read more than the coverage does
  if (opts && opts.state) {
    const st = opts.state;
    st[0] = xcov;
    st[1] = ycov;
    st[2] = xwgt;
    st[3] = ywgt;
    st[4] = slH;
    st[5] = slV;
    st[6] = slHt;
    st[7] = slVt;
  }
  return renderFillTail(xcov, ycov, xwgt, ywgt, slH, slV, evenOdd, slHt, slVt);
}
