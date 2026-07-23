// bandWinding.js — the RENDERER's fill decision, on the CPU. A faithful JS port of the
// Slug fill walk (_coverage.glsl fillLinear: the H/V band walkers with break-early,
// the calcRootCode2 LUT, the stable quadratic root pair, the clamped-Newton cubic solver
// with the apex-on-ray fix, the arc solvers, and the dual-ray blend fold), reading the
// SAME f32 band + curve buffers the shader reads.
//
// Purpose: hit testing that answers "is this point inside WHAT IS DRAWN" — the previous
// hit test ran an independent f64 walk over re-decoded segments, which is a parallel
// truth that can disagree with the render in razor cases. This walk cannot: same data,
// same algorithm, same conventions. Returns the render's coverage in [0,1] (a point is
// hit when coverage >= 0.5 — the drawn edge's midline); -1 when the bundle carries no
// band data (caller falls back to the segment walk).
//
// The exact-edge (EX) refinement IS ported: at near-tangent-ray pixels (an arc's
// horizontal extremum) the blend fold's polluted ray contributions shift the boundary by
// up to ~1px and the render's EX single-edge override is what rescues it — skipping the
// port left a measurable band of disagreement on the even-odd rings fixture.

const TEX_W = 4096;
const TWO_PI = Math.PI * 2;

// ---- ports of the GLSL helpers (names and structure kept 1:1 for auditability) ----

const calcRootCode2 = (y1, y2, y3) => {
  const shift = (y1 < 0 ? 1 : 0) | (y2 < 0 ? 2 : 0) | (y3 < 0 ? 4 : 0);
  return (0x2E74 >> shift) & 0x0101;
};

// stable root pair (the wide-symmetric-quad fix): q = b + sign(b)·d, other root c/q
function slugSolveQuad(a, b, cc, ax, bx, x0) {
  // solves a·t² − 2b·t + c = 0 in the ray axis; returns [r1, r2, t1, t2] with
  // r = (ax·t − 2bx)·t + x0 evaluated on the cross axis
  const d = Math.sqrt(Math.max(b * b - a * cc, 0));
  const q = b + (b >= 0 ? d : -d);
  const tBig = q / a;
  const tSml = (d > 0 && Math.abs(q) > 1e-30) ? cc / q : tBig;
  let t1 = b >= 0 ? tSml : tBig;
  let t2 = b >= 0 ? tBig : tSml;
  if (Math.abs(a) < 1 / 65536) { t1 = cc * 0.5 / b; t2 = t1; }
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

// solveCubicBisect port: monotone sub-intervals from the critical points, the apex-on-ray
// endpoint-side correction, secant-seeded clamped Newton (SLUG_NEWTON = 5).
function solveCubicBisect(p1y, p2y, p3y, p4y, p1x, p2x, p3x, p4x, rs, ts) {
  rs[0] = rs[1] = rs[2] = 1e20;
  ts[0] = ts[1] = ts[2] = -1;
  const cy = cubicCoeff(p1y, p2y, p3y, p4y);
  const cx = cubicCoeff(p1x, p2x, p3x, p4x);
  const qa = 3 * cy[0], qb = 2 * cy[1], qc = cy[2];
  let split1 = -1, split2 = -1;
  if (Math.abs(qa) < 1 / 65536) {
    if (Math.abs(qb) > 1 / 65536) {
      const s = -qc / qb;
      if (s > 0 && s < 1) split1 = s;
    }
  } else {
    const disc = qb * qb - 4 * qa * qc;
    if (disc >= 0) {
      const sd = Math.sqrt(disc);
      let s1 = (-qb - sd) / (2 * qa), s2 = (-qb + sd) / (2 * qa);
      if (s1 > s2) { const t = s1; s1 = s2; s2 = t; }
      if (s1 > 0 && s1 < 1) split1 = s1;
      if (s2 > 0 && s2 < 1) { if (split1 < 0) split1 = s2; else split2 = s2; }
    }
  }
  const bds = [0, 0, 0, 0];
  let nb = 1;
  if (split1 > 0) bds[nb++] = split1;
  if (split2 > 0) bds[nb++] = split2;
  bds[nb++] = 1;
  let slot = 0;
  for (let i = 0; i + 1 < nb; i++) {
    const lo = bds[i], hi = bds[i + 1];
    const yLo = evalC(cy, lo), yHi = evalC(cy, hi);
    let sLo = yLo > 0, sHi = yHi > 0;
    const EPS = 1e-6;
    if (Math.abs(yLo) < EPS && Math.abs(yHi) >= EPS) sLo = !sHi;
    else if (Math.abs(yHi) < EPS && Math.abs(yLo) >= EPS) sHi = !sLo;
    if (sLo === sHi) continue;
    const fLo = yLo, fHi = yHi;
    const sden = fHi - fLo;
    let xr = Math.abs(sden) > 1e-12 ? Math.min(hi, Math.max(lo, lo - fLo * (hi - lo) / sden)) : 0.5 * (lo + hi);
    for (let k = 0; k < 5; k++) {
      const fy = evalC(cy, xr);
      const fdy = evalCD(cy, xr);
      if (Math.abs(fdy) < 1e-12) break;
      xr = Math.min(hi, Math.max(lo, xr - fy / fdy));
    }
    if (slot < 3) { ts[slot] = xr; rs[slot] = evalC(cx, xr); slot++; }
  }
}

const hlslFmod = (x, m) => x - m * Math.trunc(x / m);
function arcInRange(t, tS, tE) {
  if (Math.abs(tE - tS) >= TWO_PI) return true;
  const dur = tE - tS;
  let d = hlslFmod(t - tS, TWO_PI);
  if (d < 0) d += TWO_PI;
  if (dur > 0) return d < dur;
  if (d > 0) d -= TWO_PI;
  return d > dur;
}

const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;

// exact area of the unit pixel box under the half-plane {x : n·x <= d}, |n| = 1
function exactBoxCov(nx, ny, d) {
  const a = Math.max(Math.abs(nx), Math.abs(ny));
  const b = Math.min(Math.abs(nx), Math.abs(ny));
  const ssum = 0.5 * (a + b), t = 0.5 * (a - b);
  if (d <= -ssum) return 0;
  if (d >= ssum) return 1;
  const ab = Math.max(2 * a * b, 1e-12);
  if (d <= -t) return (d + ssum) * (d + ssum) / ab;
  if (d >= t) return 1 - (ssum - d) * (ssum - d) / ab;
  return 0.5 + d / Math.max(a, 1e-12);
}

/**
 * The render's fill coverage at em point (cxq, cyq) for one shape, from its band + curve
 * buffers. `gd` = [glyphLoc.x, glyphLoc.y, bandMaxX, bandMaxY] (meta texel 4), `bb` =
 * the shape bbox meta floats (the SAME bbox the encoder banded over), `pxx/pxy` = pixels
 * per em (the AA scale; the 0.5 decision level is scale-independent).
 */
export function bandFillCoverage(bandF, curveF, gd, bb, cxq, cyq, pxx, pxy, evenOdd) {
  const glx = gd[0] | 0, gly = gd[1] | 0;
  const bandsX = (gd[2] | 0) + 1, bandsY = (gd[3] | 0) + 1;
  const bbw = Math.max(bb[2] - bb[0], 1e-6), bbh = Math.max(bb[3] - bb[1], 1e-6);
  const bix = Math.min(bandsX - 1, Math.max(0, Math.floor((cxq - bb[0]) / bbw * bandsX)));
  const biy = Math.min(bandsY - 1, Math.max(0, Math.floor((cyq - bb[1]) / bbh * bandsY)));
  // bLoc: linear texel index with row wrap at 4096
  const bTex = (off) => {
    const idx = gly * TEX_W + glx + off;
    return idx * 4;
  };
  const hBreak = cxq * pxx - 0.5, vBreak = cyq * pxy - 0.5;
  let xcov = 0, ycov = 0, xwgt = 0, ywgt = 0;
  const rs = [0, 0, 0], tsv = [0, 0, 0];
  // exact-edge records: per ray, the FIRST crossing's (unnormalized) half-plane; counts +
  // a degenerate flag — the merge below mirrors fillLinear's tail exactly.
  let exNH = 0, exNV = 0, exOther = false;
  let exHnx = 0, exHny = 0, exHd = 0, exVnx = 0, exVny = 0, exVd = 0;
  const exRec = (horiz, tanPxX, tanPxY, ptPxX, ptPxY) => {
    const nx = tanPxY, ny = -tanPxX;
    if (horiz) { exNH++; if (exNH === 1) { if (nx * nx + ny * ny < 1e-18) exOther = true; else { exHnx = nx; exHny = ny; exHd = nx * ptPxX + ny * ptPxY; } } }
    else { exNV++; if (exNV === 1) { if (nx * nx + ny * ny < 1e-18) exOther = true; else { exVnx = nx; exVny = ny; exVd = nx * ptPxX + ny * ptPxY; } } }
  };

  for (let pass = 0; pass < 2; pass++) {
    const horiz = pass === 0;
    const hdr = horiz ? biy * 2 : bandsY * 2 + bix * 2;
    const cb = bTex(hdr);
    const nLine = bandF[cb] | 0, nQuad = bandF[cb + 1] | 0, nCubic = bandF[cb + 2] | 0, nArc = bandF[cb + 3] | 0;
    const arrIdx = bandF[bTex(hdr + 1)] | 0;
    const brk = horiz ? hBreak : vBreak;
    const pxa = horiz ? pxx : pxy;
    let off = 0;
    // packed entries: 2 per texel, (loc0, brk0, loc1, brk1); returns the entry's float offset
    const entry = (k) => { const eIdx = off + k; return bTex(arrIdx + (eIdx >> 1)) + ((eIdx & 1) << 1); };
    // ---- LINES ----
    for (let i = 0; i < nLine; i++) {
      const e = entry(i);
      if (bandF[e + 1] * pxa < brk) break;
      const d = ((bandF[e] | 0) + 1) * 4;
      const p1a = curveF[d] - cxq, p1b = curveF[d + 1] - cyq;
      const p2a = curveF[d + 2] - cxq, p2b = curveF[d + 3] - cyq;
      // ray-parallel coordinate = the OTHER axis; eligibility on the crossing axis
      const c1 = horiz ? p1b : p1a, c2 = horiz ? p2b : p2a;
      const r1 = horiz ? p1a : p1b, r2 = horiz ? p2a : p2b;
      if (Math.max(r1, r2) * pxa < -0.5) continue;
      const p1Neg = c1 < 0, p2Neg = c2 < 0;
      if (p1Neg === p2Neg) continue;
      const dd = c2 - c1;
      if (Math.abs(dd) < 1 / 65536) continue;
      const t = -c1 / dd;
      const ri = (r1 + t * (r2 - r1)) * pxa;
      const sgn = horiz ? (p2Neg ? 1 : -1) : (p2Neg ? -1 : 1);
      const cv = sgn * clamp01(ri + 0.5);
      if (Math.abs(ri) < 1) {
        const A2x = p1a * pxx, A2y = p1b * pxy, B2x = p2a * pxx, B2y = p2b * pxy;
        exRec(horiz, B2x - A2x, B2y - A2y, A2x, A2y);
      }
      if (horiz) { xcov += cv; xwgt = Math.max(xwgt, clamp01(1 - Math.abs(ri) * 2)); }
      else { ycov += cv; ywgt = Math.max(ywgt, clamp01(1 - Math.abs(ri) * 2)); }
    }
    off += nLine;
    // ---- QUADS ----
    for (let i = 0; i < nQuad; i++) {
      const e = entry(i);
      if (bandF[e + 1] * pxa < brk) break;
      const d = ((bandF[e] | 0) + 1) * 4;
      const p1a = curveF[d] - cxq, p1b = curveF[d + 1] - cyq;
      const p2a = curveF[d + 2] - cxq, p2b = curveF[d + 3] - cyq;
      const d2 = ((bandF[e] | 0) + 2) * 4;
      const p3a = curveF[d2] - cxq, p3b = curveF[d2 + 1] - cyq;
      const cA = horiz ? [p1b, p2b, p3b] : [p1a, p2a, p3a];   // crossing axis
      const rA = horiz ? [p1a, p2a, p3a] : [p1b, p2b, p3b];   // ray axis
      if (Math.max(rA[0], rA[1], rA[2]) * pxa < -0.5) continue;
      const code = calcRootCode2(cA[0], cA[1], cA[2]);
      if (code === 0) continue;
      const a = cA[0] - 2 * cA[1] + cA[2], b = cA[0] - cA[1];
      const ax = rA[0] - 2 * rA[1] + rA[2], bx = rA[0] - rA[1];
      const rt = slugSolveQuad(a, b, cA[0], ax, bx, rA[0]);
      const qTan = (t, ri) => {
        const dxq = 2 * ((p2a - p1a) * (1 - t) + (p3a - p2a) * t) * pxx;
        const dyq = 2 * ((p2b - p1b) * (1 - t) + (p3b - p2b) * t) * pxy;
        exRec(horiz, dxq, dyq, horiz ? ri : 0, horiz ? 0 : ri);
      };
      if ((code & 1) !== 0 && isFinite(rt[0])) {
        const ri = rt[0] * pxa;
        const cv = clamp01(ri + 0.5);
        if (Math.abs(ri) < 1) qTan(rt[2], ri);
        if (horiz) { xcov += cv; xwgt = Math.max(xwgt, clamp01(1 - Math.abs(ri) * 2)); }
        else { ycov -= cv; ywgt = Math.max(ywgt, clamp01(1 - Math.abs(ri) * 2)); }
      }
      if (code > 1 && isFinite(rt[1])) {
        const ri = rt[1] * pxa;
        const cv = clamp01(ri + 0.5);
        if (Math.abs(ri) < 1) qTan(rt[3], ri);
        if (horiz) { xcov -= cv; xwgt = Math.max(xwgt, clamp01(1 - Math.abs(ri) * 2)); }
        else { ycov += cv; ywgt = Math.max(ywgt, clamp01(1 - Math.abs(ri) * 2)); }
      }
    }
    off += nQuad;
    // ---- CUBICS ----
    for (let i = 0; i < nCubic; i++) {
      const e = entry(i);
      if (bandF[e + 1] * pxa < brk) break;
      const d = ((bandF[e] | 0) + 1) * 4;
      const q1 = curveF[d] - cxq, q2 = curveF[d + 1] - cyq;
      const q3 = curveF[d + 2] - cxq, q4 = curveF[d + 3] - cyq;
      const d2 = ((bandF[e] | 0) + 2) * 4;
      const q5 = curveF[d2] - cxq, q6 = curveF[d2 + 1] - cyq;
      const q7 = curveF[d2 + 2] - cxq, q8 = curveF[d2 + 3] - cyq;
      const rx = horiz ? [q1, q3, q5, q7] : [q2, q4, q6, q8];
      const ry = horiz ? [q2, q4, q6, q8] : [q1, q3, q5, q7];
      if (Math.max(rx[0], rx[1], rx[2], rx[3]) * pxa < -0.5) continue;
      solveCubicBisect(ry[0], ry[1], ry[2], ry[3], rx[0], rx[1], rx[2], rx[3], rs, tsv);
      const cyc = cubicCoeff(ry[0], ry[1], ry[2], ry[3]);
      for (let j = 0; j < 3; j++) {
        if (tsv[j] < 0 || tsv[j] >= 1 || rs[j] >= 1e10 || rs[j] !== rs[j]) continue;
        const ri = rs[j] * pxa;
        // H: dY/dt < 0 ADDS. V: the reversed root convention absorbed → >= 0 ADDS.
        const dcd = evalCD(cyc, tsv[j]);
        const sgn = horiz ? (dcd < 0 ? 1 : -1) : (dcd >= 0 ? 1 : -1);
        const cv = sgn * clamp01(ri + 0.5);
        if (Math.abs(ri) < 1) {
          const t = tsv[j], u = 1 - t;
          const dxc = 3 * ((q3 - q1) * u * u + (q5 - q3) * 2 * u * t + (q7 - q5) * t * t) * pxx;
          const dyc = 3 * ((q4 - q2) * u * u + (q6 - q4) * 2 * u * t + (q8 - q6) * t * t) * pxy;
          exRec(horiz, dxc, dyc, horiz ? ri : 0, horiz ? 0 : ri);
        }
        if (horiz) { xcov += cv; xwgt = Math.max(xwgt, clamp01(1 - Math.abs(ri) * 2)); }
        else { ycov += cv; ywgt = Math.max(ywgt, clamp01(1 - Math.abs(ri) * 2)); }
      }
    }
    off += nCubic;
    // ---- ARCS ----
    for (let i = 0; i < nArc; i++) {
      const e = entry(i);
      if (bandF[e + 1] * pxa < brk) break;
      const d = ((bandF[e] | 0) + 1) * 4;
      const acx = curveF[d], acy = curveF[d + 1], arx = curveF[d + 2], ary = curveF[d + 3];
      const d2 = ((bandF[e] | 0) + 2) * 4;
      const th0 = curveF[d2], th1 = curveF[d2 + 1], phi = curveF[d2 + 2];
      const sp = Math.sin(phi), cp = Math.cos(phi);
      // H solves y(θ) = cy: A = sp·rx, B = cp·ry, C = −(cy − cyq).
      // V solves x(θ) = cx: A = cp·rx, B = −sp·ry, C = −(cx − cxq).
      const A = horiz ? sp * arx : cp * arx;
      const B = horiz ? cp * ary : -sp * ary;
      const C = horiz ? -(acy - cyq) : -(acx - cxq);
      const Rlen = Math.hypot(A, B);
      const arcDir = th1 >= th0 ? 1 : -1;
      if (Rlen <= 1e-10) continue;
      const ratio = C / Rlen;
      if (Math.abs(ratio) >= 0.99999) continue;
      const ang = Math.atan2(B, A), b2 = Math.acos(Math.max(-1, Math.min(1, ratio)));
      for (const th of [ang + b2, ang - b2]) {
        if (!arcInRange(th, th0, th1)) continue;
        const ct = Math.cos(th), st = Math.sin(th);
        const axr = cp * arx, bxr = sp * ary, ayr = sp * arx, byr = cp * ary;
        const p0 = acx + axr * ct - bxr * st, p1 = acy + ayr * ct + byr * st;
        const ddx = -axr * st - bxr * ct, ddy = -ayr * st + byr * ct;
        const ri = (horiz ? (p0 - cxq) : (p1 - cyq)) * pxa;
        const dslope = horiz ? ddy : ddx;
        const sgn = arcDir * (horiz ? (dslope < 0 ? 1 : -1) : (dslope >= 0 ? 1 : -1));
        const cv = sgn * clamp01(ri + 0.5);
        if (Math.abs(ri) < 1) {
          exRec(horiz, ddx * pxx, ddy * pxy,
                horiz ? ri : (p0 - cxq) * pxx,
                horiz ? (p1 - cyq) * pxy : ri);
        }
        if (horiz) { xcov += cv; xwgt = Math.max(xwgt, clamp01(1 - Math.abs(ri) * 2)); }
        else { ycov += cv; ywgt = Math.max(ywgt, clamp01(1 - Math.abs(ri) * 2)); }
      }
    }
  }
  const wsum = Math.max(xwgt + ywgt, 1 / 65536);
  let cov = Math.max(Math.abs(xcov * xwgt + ycov * ywgt) / wsum, Math.min(Math.abs(xcov), Math.abs(ycov)));
  // exact-edge merge (fillLinear tail + renderFill): one straight edge near the pixel →
  // exact half-plane area, oriented by the blended cov.
  let exNx = exHnx, exNy = exHny, exD = exHd, exCode = 0;
  if (exOther || exNH > 1 || exNV > 1) exCode = -1;
  else if (exNH === 1 && exNV === 1) {
    const l1 = Math.hypot(exHnx, exHny), l2 = Math.hypot(exVnx, exVny), pp = l1 * l2;
    const crs = Math.abs(exHnx * exVny - exHny * exVnx);
    const same = crs <= 0.174 * pp && Math.abs(Math.abs(exHd) * l2 - Math.abs(exVd) * l1) <= 0.35 * pp;
    if (!same) exCode = -1;
    else {
      exCode = 1;
      if (Math.abs(exVd) * l1 < Math.abs(exHd) * l2) { exNx = exVnx; exNy = exVny; exD = exVd; }
    }
  } else if (exNH === 1) exCode = 1;
  else if (exNV === 1) { exNx = exVnx; exNy = exVny; exD = exVd; exCode = 1; }
  if (exCode === 1) {
    const L = Math.max(Math.hypot(exNx, exNy), 1e-9);
    const ec = exactBoxCov(exNx / L, exNy / L, exD / L);
    cov = Math.abs(ec - cov) <= Math.abs((1 - ec) - cov) ? ec : 1 - ec;
  }
  if (evenOdd) {
    const f = (cov * 0.5) % 1;
    return 1 - Math.abs(1 - f * 2);
  }
  return Math.min(1, Math.max(0, cov));
}
