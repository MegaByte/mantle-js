// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _strokeCubicArcRef.mjs — the CUBIC and ARC twins of _strokeCurveRef.mjs (not a test on its own).
//
// _strokeMath.glsl has three stroke accumulators and ONE cap/join/dash tail: strokeQuadAccum,
// strokeCubicAccum and strokeArcAccum differ only in how they find the closest point on the
// segment, and all three hand (t, thisD, endpoints, endpoint derivatives) to the same
// strokeCapsJoinsDash. test/_strokeCurveRef.mjs ports that tail as `capsJoinsDash` and pairs it
// with a quad's closest point, which is a root of a CUBIC and so solvable in closed form.
//
// A cubic's is a root of a QUINTIC, which Abel-Ruffini says has no radical formula. The shipped
// shader therefore SEEDS from a 9-sample grid and runs three Newton steps, and Newton converges to
// whatever basin its seed is in. This file carries both:
//
//   cubicClosestTExact    256 brackets, each bisected 50 times, plus the endpoints and the scan's
//                         own minimum as a floor (a tangency is a double root, which no sign test
//                         sees) -- the answer, not an approximation;
//   cubicClosestTShipped  the GLSL verbatim: t = k/8 for k in 0..8 by smallest d^2 (plus the
//                         16-sample refine when an endpoint derivative is degenerate), then three
//                         Newton steps clamped to [0, 1].
//
// An ARC's closest point is exact in the shader already -- distToEllipse is Inigo Quilez's
// closed-form ellipse SDF -- so arcClosestShipped IS arcClosestExact up to float32; the
// interesting part there is the in-range test and the parameter the endpoints are decided by.
//
// * cubicSeg / arcSeg: one segment's contribution, either solver, through the shared tail.
// * cubicSegs / arcSegs: the encoder's per-segment records for a chain.
// * svgInsideGeneric: the exact SVG 2 stroke shape of a chain of ANY of the three types.
// * makeCubicCases / makeArcCases: seeded chains, including the loops and cusps a seeded solver
//   is documented to get wrong.
import {
  sub,
  dot,
  len,
  norm,
  crs,
  perp,
  add,
  mul,
  capsJoinsDash,
  coverageTail,
} from './_strokeCurveRef.mjs';

export { sub, dot, len, norm, crs, perp, add, mul, coverageTail };

// ---- cubic evaluation, in the shader's coefficient form ------------------------------------------
/** cubicCoeff: (a, b, c, d) with P(t) = ((a t + b) t + c) t + d, from four control points. */
export function cubicCoeff(p0, p1, p2, p3) {
  return [-p0 + 3 * p1 - 3 * p2 + p3, 3 * p0 - 6 * p1 + 3 * p2, -3 * p0 + 3 * p1, p0];
}
export const evalC = (k, t) => ((k[0] * t + k[1]) * t + k[2]) * t + k[3];
export const evalCD = (k, t) => (3 * k[0] * t + 2 * k[1]) * t + k[2];
const evalCDD = (k, t) => 6 * k[0] * t + 2 * k[1];
const d2AtT = (cx, cy, t) => {
  const x = evalC(cx, t),
    y = evalC(cy, t);
  return x * x + y * y;
};
const fDotT = (cx, cy, t) => evalC(cx, t) * evalCD(cx, t) + evalC(cy, t) * evalCD(cy, t);

/**
 * The closest point's parameter, to float64. f(t) = P(t).P'(t) is a quintic; bracket every sign
 * change on a 256-interval scan and bisect each bracket 50 times, then take the best of those, the
 * two endpoints, and the scan's own minimum (which catches a tangency, where f does not change
 * sign and a bracket search is blind).
 */
export function cubicClosestTExact(cx, cy, N = 256) {
  let bt = 0,
    bs = d2AtT(cx, cy, 0);
  const take = (t) => {
    const d = d2AtT(cx, cy, t);
    if (d < bs) {
      bs = d;
      bt = t;
    }
  };
  take(1);
  let tp = 0,
    fp = fDotT(cx, cy, 0);
  for (let i = 1; i <= N; i++) {
    const t1 = i / N,
      f1 = fDotT(cx, cy, t1);
    take(t1);
    if (fp === 0 || fp < 0 !== f1 < 0) {
      let lo = tp,
        hi = t1,
        flo = fp;
      for (let b = 0; b < 50; b++) {
        const m = 0.5 * (lo + hi),
          fm = fDotT(cx, cy, m);
        if (flo < 0 !== fm < 0 || fm === 0) hi = m;
        else {
          lo = m;
          flo = fm;
        }
      }
      take(0.5 * (lo + hi));
    }
    tp = t1;
    fp = f1;
  }
  return bt;
}

/** _strokeMath.glsl strokeCubicAccum's shipped solver, statement for statement. */
export function cubicClosestTShipped(cx, cy) {
  let bT = 0,
    bS = Infinity;
  for (let k = 0; k <= 8; k++) {
    const t = k / 8,
      d2 = d2AtT(cx, cy, t);
    if (d2 < bS) {
      bS = d2;
      bT = t;
    }
  }
  const startVelSq = cx[2] * cx[2] + cy[2] * cy[2];
  const endVelX = cx[2] + 2 * cx[1] + 3 * cx[0],
    endVelY = cy[2] + 2 * cy[1] + 3 * cy[0];
  const endVelSq = endVelX * endVelX + endVelY * endVelY;
  if (startVelSq < 1e-9 || endVelSq < 1e-9) {
    for (let kx = 0; kx < 8; kx++) {
      const t = (2 * kx + 1) / 16,
        d2 = d2AtT(cx, cy, t);
      if (d2 < bS) {
        bS = d2;
        bT = t;
      }
    }
  }
  let t = bT;
  for (let j = 0; j < 3; j++) {
    const px = evalC(cx, t),
      py = evalC(cy, t);
    const dx = evalCD(cx, t),
      dy = evalCD(cy, t);
    const f = px * dx + py * dy;
    const df = dx * dx + dy * dy + px * evalCDD(cx, t) + py * evalCDD(cy, t);
    if (Math.abs(df) < 1e-9) break;
    t = Math.min(1, Math.max(0, t - f / df));
  }
  return t;
}

/** Signed centerline curvature of a cubic at t = 0 / t = 1 (src/svg/textures.js's rule). */
export function cubicCurvature(p0, p1, p2, p3, atStart) {
  const d1 = atStart ? mul(sub(p1, p0), 3) : mul(sub(p3, p2), 3);
  const d2 = atStart ? mul(add(sub(p0, mul(p1, 2)), p2), 6) : mul(add(sub(p1, mul(p2, 2)), p3), 6);
  const m = len(d1);
  if (!(m > 1e-12)) return 0;
  return crs(d1, d2) / (m * m * m);
}

/** The encoder's per-segment records for a chain of cubics (each [p0, p1, p2, p3]). */
export function cubicSegs(Cs, closed) {
  const m = Cs.length,
    segs = Cs.map(([p0, p1, p2, p3]) => ({ p0, p1, p2, p3, type: 'cubic' }));
  const tanAt = (s, atStart) => {
    // the encoder's rule: the handle, or the chord when the handle has no length
    const d = atStart ? sub(s.p1, s.p0) : sub(s.p3, s.p2);
    return dot(d, d) > 1e-18 ? norm(d) : norm(sub(s.p3, s.p0));
  };
  const tS = segs.map((s) => tanAt(s, true)),
    tE = segs.map((s) => tanAt(s, false));
  segs.forEach((s, i) => {
    const prev = closed ? (i - 1 + m) % m : i - 1,
      next = closed ? (i + 1) % m : i + 1;
    s.freeStart = prev < 0;
    s.freeEnd = next >= m;
    s.inTan = prev < 0 ? [0, 0] : tE[prev];
    s.outTan = next >= m ? [0, 0] : tS[next];
    s.tanStart = tS[i];
    s.tanEnd = tE[i];
    s.kSS = cubicCurvature(s.p0, s.p1, s.p2, s.p3, true);
    s.kSE = cubicCurvature(s.p0, s.p1, s.p2, s.p3, false);
    s.kPE =
      prev < 0
        ? 0
        : cubicCurvature(segs[prev].p0, segs[prev].p1, segs[prev].p2, segs[prev].p3, false);
    s.kNS =
      next >= m
        ? 0
        : cubicCurvature(segs[next].p0, segs[next].p1, segs[next].p2, segs[next].p3, true);
  });
  return segs;
}

/**
 * One cubic segment's contribution: the port of strokeCubicAccum. `solver` is 'exact' or
 * 'shipped'; the two differ only in the closest-point solver.
 */
export function cubicSeg(
  rule,
  c,
  s,
  halfW,
  cap,
  joinStyle,
  miterLimit,
  endCap = cap,
  solver = 'shipped',
) {
  const cx = cubicCoeff(s.p0[0] - c[0], s.p1[0] - c[0], s.p2[0] - c[0], s.p3[0] - c[0]);
  const cy = cubicCoeff(s.p0[1] - c[1], s.p1[1] - c[1], s.p2[1] - c[1], s.p3[1] - c[1]);
  const t = solver === 'exact' ? cubicClosestTExact(cx, cy) : cubicClosestTShipped(cx, cy);
  const qv = [evalC(cx, t), evalC(cy, t)];
  const thisD = Math.hypot(qv[0], qv[1]);
  const dStart = [evalCD(cx, 0), evalCD(cy, 0)],
    dEnd = [evalCD(cx, 1), evalCD(cy, 1)];
  return capsJoinsDash(
    rule,
    c,
    t,
    thisD,
    qv,
    s.p0,
    s.p3,
    dStart,
    dEnd,
    s,
    halfW,
    cap,
    endCap,
    joinStyle,
    miterLimit,
  );
}

// ---- arcs ----------------------------------------------------------------------------------------
export const evalArc = (cx, cy, rx, ry, phi, th) => {
  const ct = Math.cos(th),
    st = Math.sin(th),
    cp = Math.cos(phi),
    sp = Math.sin(phi);
  return [cx + cp * rx * ct - sp * ry * st, cy + sp * rx * ct + cp * ry * st];
};
export const arcDDtheta = (rx, ry, phi, th) => {
  const ct = Math.cos(th),
    st = Math.sin(th),
    cp = Math.cos(phi),
    sp = Math.sin(phi);
  return [-cp * rx * st - sp * ry * ct, -sp * rx * st + cp * ry * ct];
};
const TWO_PI = 2 * Math.PI;
const fmodT = (x, m) => x - m * Math.trunc(x / m);
export function arcInRange(t, tS, tE) {
  if (Math.abs(tE - tS) >= TWO_PI) return true;
  const dur = tE - tS;
  let d = fmodT(t - tS, TWO_PI);
  if (d < 0) d += TWO_PI;
  if (dur > 0) return d < dur;
  if (d > 0) d -= TWO_PI;
  return d > dur;
}
/** _arcMath.glsl distToEllipse: Inigo Quilez's closed-form ellipse SDF, in float64. */
export function distToEllipse(ab0, pIn) {
  const sgn = [Math.sign(pIn[0]) || 1, Math.sign(pIn[1]) || 1];
  let p = [Math.abs(pIn[0]), Math.abs(pIn[1])],
    ab = [ab0[0], ab0[1]];
  const swap = p[0] > p[1];
  if (swap) {
    p = [p[1], p[0]];
    ab = [ab[1], ab[0]];
  }
  const l = ab[1] * ab[1] - ab[0] * ab[0];
  let fq;
  if (Math.abs(l) < 1e-9 * Math.max(ab[0] * ab[0], ab[1] * ab[1])) {
    const n = norm([p[0] + 1e-20, p[1] + 1e-20]);
    fq = [ab[0] * n[0], ab[0] * n[1]];
  } else {
    const m = (ab[0] * p[0]) / l,
      m2 = m * m;
    const n = (ab[1] * p[1]) / l,
      n2 = n * n;
    const cc = (m2 + n2 - 1) / 3,
      c3 = cc * cc * cc;
    const q = c3 + m2 * n2 * 2,
      d = c3 + m2 * n2,
      g = m + m * n2;
    let co;
    if (d < 0) {
      const h = Math.acos(Math.min(1, Math.max(-1, q / c3))) / 3;
      const sS = Math.cos(h),
        tT = Math.sin(h) * Math.sqrt(3);
      const rx = Math.sqrt(Math.max(-cc * (sS + tT + 2) + m2, 0));
      const ry = Math.sqrt(Math.max(-cc * (sS - tT + 2) + m2, 0));
      co = (ry + Math.sign(l) * rx + Math.abs(g) / (rx * ry + 1e-20) - m) / 2;
    } else {
      const h = 2 * m * n * Math.sqrt(d);
      const sS = Math.sign(q + h) * Math.pow(Math.abs(q + h), 1 / 3);
      const u = Math.sign(q - h) * Math.pow(Math.abs(q - h), 1 / 3);
      const rx = -sS - u - cc * 4 + 2 * m2,
        ry = (sS - u) * Math.sqrt(3);
      const rm = Math.hypot(rx, ry);
      co = (ry / Math.sqrt(Math.max(rm - rx, 1e-20)) + (2 * g) / (rm + 1e-20) - m) / 2;
    }
    co = Math.min(1, Math.max(0, co));
    fq = [ab[0] * co, ab[1] * Math.sqrt(Math.max(1 - co * co, 0))];
  }
  const fo = swap ? [fq[1], fq[0]] : fq;
  const foot = [sgn[0] * fo[0], sgn[1] * fo[1]];
  return { d: len(sub(pIn, foot)), foot };
}

/** Signed centerline curvature of an elliptical arc at theta, in the arc's sweep direction. */
export function arcCurvature(rx, ry, th, dth) {
  const st = Math.sin(th),
    ct = Math.cos(th);
  const d1 = [-rx * st, ry * ct],
    d2 = [-rx * ct, -ry * st];
  const m = len(d1);
  if (!(m > 1e-12)) return 0;
  // dth < 0 reverses the parameter, which flips the sign of the signed curvature
  return ((dth >= 0 ? 1 : -1) * crs(d1, d2)) / (m * m * m);
}

/** The encoder's per-segment records for a chain of arcs (each { cx, cy, rx, ry, phi, th0, th1 }). */
export function arcSegs(As, closed) {
  const m = As.length,
    segs = As.map((a) => ({ ...a, type: 'arc' }));
  for (const s of segs) {
    s.p0 = evalArc(s.cx, s.cy, s.rx, s.ry, s.phi, s.th0);
    s.p1 = evalArc(s.cx, s.cy, s.rx, s.ry, s.phi, s.th1);
    const dth = s.th1 - s.th0;
    s.dStart = mul(arcDDtheta(s.rx, s.ry, s.phi, s.th0), dth);
    s.dEnd = mul(arcDDtheta(s.rx, s.ry, s.phi, s.th1), dth);
    s.tanStart = norm(s.dStart);
    s.tanEnd = norm(s.dEnd);
    // the curvature is defined in the ellipse's own frame; rotating by phi does not change it
    s.kSSraw = arcCurvature(s.rx, s.ry, s.th0, dth);
    s.kSEraw = arcCurvature(s.rx, s.ry, s.th1, dth);
  }
  segs.forEach((s, i) => {
    const prev = closed ? (i - 1 + m) % m : i - 1,
      next = closed ? (i + 1) % m : i + 1;
    s.freeStart = prev < 0;
    s.freeEnd = next >= m;
    s.inTan = prev < 0 ? [0, 0] : segs[prev].tanEnd;
    s.outTan = next >= m ? [0, 0] : segs[next].tanStart;
    s.kSS = s.kSSraw;
    s.kSE = s.kSEraw;
    s.kPE = prev < 0 ? 0 : segs[prev].kSEraw;
    s.kNS = next >= m ? 0 : segs[next].kSSraw;
  });
  return segs;
}

/** One arc segment's contribution: the port of strokeArcAccum. */
export function arcSeg(rule, c, s, halfW, cap, joinStyle, miterLimit, endCap = cap) {
  const pc = sub(c, [s.cx, s.cy]);
  const cphi = Math.cos(s.phi),
    sphi = Math.sin(s.phi);
  const pR = [pc[0] * cphi + pc[1] * sphi, -pc[0] * sphi + pc[1] * cphi];
  const ep0 = sub(s.p0, c),
    ep1 = sub(s.p1, c);
  const dE = Math.min(len(ep0), len(ep1));
  const { d: dEdge, foot } = distToEllipse([s.rx, s.ry], pR);
  const tAng = Math.atan2(foot[1] / Math.max(s.ry, 1e-9), foot[0] / Math.max(s.rx, 1e-9));
  const inRange = arcInRange(tAng, s.th0, s.th1);
  const arcD = inRange ? Math.min(dEdge, dE) : dE;
  const dth = s.th1 - s.th0;
  let tArc;
  if (inRange && dEdge <= dE) {
    let dd = fmodT(tAng - s.th0, TWO_PI);
    if (dd < 0) dd += TWO_PI;
    if (dth < 0 && dd > 0) dd -= TWO_PI;
    tArc = Math.min(1, Math.max(0, dd / dth));
  } else {
    tArc = len(ep0) <= len(ep1) ? 0 : 1;
  }
  // the closest point MINUS the query, in the arc's world frame, for the body normal
  let qv = null;
  if (inRange && dEdge <= dE && dEdge > 1e-12) {
    const fw = [foot[0] * cphi - foot[1] * sphi + s.cx, foot[0] * sphi + foot[1] * cphi + s.cy];
    qv = sub(fw, c);
  }
  return capsJoinsDash(
    rule,
    c,
    tArc,
    arcD,
    qv,
    s.p0,
    s.p1,
    s.dStart,
    s.dEnd,
    s,
    halfW,
    cap,
    endCap,
    joinStyle,
    miterLimit,
  );
}

// ---- min over a chain, and coverage ---------------------------------------------------------------
export function minDistChain(
  rule,
  c,
  segs,
  halfW,
  cap,
  joinStyle,
  miterLimit,
  endCap = cap,
  solver = 'shipped',
) {
  let minD = 1e30,
    grad = [0, 0];
  for (const s of segs) {
    const r =
      s.type === 'arc'
        ? arcSeg(rule, c, s, halfW, cap, joinStyle, miterLimit, endCap)
        : cubicSeg(rule, c, s, halfW, cap, joinStyle, miterLimit, endCap, solver);
    if (r.d < minD) {
      minD = r.d;
      grad = r.g || [0, 0];
    }
  }
  return { minD, grad };
}
/** mantle.frag.glsl's stroke coverage at one em per pixel, exact-AA on. */
export function coverageChain(
  rule,
  c,
  segs,
  halfW,
  cap,
  joinStyle,
  miterLimit,
  endCap = cap,
  solver = 'shipped',
) {
  const { minD, grad } = minDistChain(
    rule,
    c,
    segs,
    halfW,
    cap,
    joinStyle,
    miterLimit,
    endCap,
    solver,
  );
  return coverageTail(minD, grad, halfW);
}

// ---- the exact SVG 2 stroke shape of a chain of cubics or arcs ------------------------------------
const inTri = (q, A, B, C) => {
  const s1 = crs(sub(B, A), sub(q, A)),
    s2 = crs(sub(C, B), sub(q, B)),
    s3 = crs(sub(A, C), sub(q, C));
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
};
/**
 * Is `c` inside the segment's BODY -- SVG 2's swept perpendicular? A point lies on a perpendicular
 * of length halfW exactly when some INTERIOR critical point of |P(t) - c| is within halfW, so this
 * brackets every sign change of (P - c).P' and stops at the first foot that is close enough. The
 * curve lies inside its control box (an arc inside the ellipse's), so a box test rejects the far
 * pixels -- which is most of them -- before any of that runs.
 */
function bodyContains(s, c, halfW, circleRoots) {
  if (s.type === 'arc') {
    if (
      circleRoots &&
      s.rx === s.ry &&
      s.rx > 0 &&
      s.th0 !== s.th1 &&
      c[0] === s.cx &&
      c[1] === s.cy
    )
      return halfW >= s.rx;
    const r = Math.max(s.rx, s.ry);
    if (Math.abs(c[0] - s.cx) > r + halfW || Math.abs(c[1] - s.cy) > r + halfW) return false;
  } else {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const p of [s.p0, s.p1, s.p2, s.p3]) {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
    if (c[0] < x0 - halfW || c[0] > x1 + halfW || c[1] < y0 - halfW || c[1] > y1 + halfW)
      return false;
  }
  for (const t of perpParams(s, c, circleRoots)) if (len(sub(ptAt(s, t), c)) <= halfW) return true;
  return false;
}

/** Every parameter in [0,1] where the segment is PERPENDICULAR to `c`. */
function perpParams(s, c, circleRoots) {
  if (s.type === 'arc') {
    // A true circle has precisely the radial and opposite radial perpendiculars.
    // Enumerate all turns of both roots in the authored sweep. This is exact,
    // including R < halfW; an ellipse still takes the independent bracketed scan.
    if (circleRoots && s.rx === s.ry && s.rx > 0 && s.th0 !== s.th1) {
      const dx = c[0] - s.cx,
        dy = c[1] - s.cy;
      if (dx === 0 && dy === 0) return [0.5]; // every radius is perpendicular
      const angle = Math.atan2(dy, dx) - s.phi;
      const lo = Math.min(s.th0, s.th1),
        hi = Math.max(s.th0, s.th1),
        out = [];
      for (
        let k = Math.ceil((lo - angle) / Math.PI);
        k <= Math.floor((hi - angle) / Math.PI);
        k++
      ) {
        const t = (angle + k * Math.PI - s.th0) / (s.th1 - s.th0);
        if (t >= 0 && t <= 1) out.push(t);
      }
      return out;
    }
    // theta where (P(theta) - c) . dP/dtheta = 0, by a dense bracketed scan in theta
    const out = [];
    const f = (th) => {
      const p = sub(evalArc(s.cx, s.cy, s.rx, s.ry, s.phi, th), c);
      return dot(p, arcDDtheta(s.rx, s.ry, s.phi, th));
    };
    const N = 96,
      a = s.th0,
      b = s.th1;
    let tp = 0,
      fp = f(a);
    for (let i = 1; i <= N; i++) {
      const u = i / N,
        th = a + (b - a) * u,
        f1 = f(th);
      if (fp === 0 || fp < 0 !== f1 < 0) {
        let lo = tp,
          hi = u,
          flo = fp;
        for (let k = 0; k < 40; k++) {
          const mu = 0.5 * (lo + hi),
            fm = f(a + (b - a) * mu);
          if (flo < 0 !== fm < 0 || fm === 0) hi = mu;
          else {
            lo = mu;
            flo = fm;
          }
        }
        out.push(0.5 * (lo + hi));
      }
      tp = u;
      fp = f1;
    }
    return out;
  }
  const cx = cubicCoeff(s.p0[0] - c[0], s.p1[0] - c[0], s.p2[0] - c[0], s.p3[0] - c[0]);
  const cy = cubicCoeff(s.p0[1] - c[1], s.p1[1] - c[1], s.p2[1] - c[1], s.p3[1] - c[1]);
  const out = [];
  const N = 96;
  let tp = 0,
    fp = fDotT(cx, cy, 0);
  for (let i = 1; i <= N; i++) {
    const t1 = i / N,
      f1 = fDotT(cx, cy, t1);
    if (fp === 0 || fp < 0 !== f1 < 0) {
      let lo = tp,
        hi = t1,
        flo = fp;
      for (let k = 0; k < 40; k++) {
        const m = 0.5 * (lo + hi),
          fm = fDotT(cx, cy, m);
        if (flo < 0 !== fm < 0 || fm === 0) hi = m;
        else {
          lo = m;
          flo = fm;
        }
      }
      out.push(0.5 * (lo + hi));
    }
    tp = t1;
    fp = f1;
  }
  return out;
}
const ptAt = (s, t) =>
  s.type === 'arc'
    ? evalArc(s.cx, s.cy, s.rx, s.ry, s.phi, s.th0 + (s.th1 - s.th0) * t)
    : [
        evalC(cubicCoeff(s.p0[0], s.p1[0], s.p2[0], s.p3[0]), t),
        evalC(cubicCoeff(s.p0[1], s.p1[1], s.p2[1], s.p3[1]), t),
      ];

/**
 * SVG 2's stroke shape ("all points that lie on the line perpendicular to the subpath at that
 * distance and which are within distance stroke-width/2 of the point on the subpath"), plus the cap
 * shapes at the two free ends and the LINE JOIN shape at each interior vertex, for a chain of
 * cubics or of arcs. joinStyle 4 (arcs) is taken as miter-clip, as SVG 2 itself does when both
 * curvatures are zero -- the curved arcs construction is _strokeCurveRef.mjs's arcsRegion.
 */
export function svgInsideGeneric(
  c,
  segs,
  closed,
  halfW,
  cap,
  joinStyle,
  miterLimit,
  endCap = cap,
  circleRoots = true,
) {
  const m = segs.length;
  for (const s of segs) if (bodyContains(s, c, halfW, circleRoots)) return true; // ---- body ----
  if (!closed) {
    // ---- caps ----
    const last = segs[m - 1];
    const ends = [
      [segs[0].p0, mul(segs[0].tanStart, -1), cap],
      [last.type === 'arc' ? last.p1 : last.p3, last.tanEnd, endCap],
    ];
    for (const [V, out, k] of ends) {
      const q = sub(c, V),
        a = dot(q, out);
      if (k === 1 && a >= 0 && len(q) <= halfW) return true;
      if (k === 2 && a >= 0 && a <= halfW && Math.abs(dot(q, perp(out))) <= halfW) return true;
    }
  }
  const verts = closed ? segs.map((_, i) => i) : segs.map((_, i) => i).slice(1);
  for (const j of verts) {
    // ---- joins ----
    const prev = segs[(j - 1 + m) % m],
      self = segs[j];
    const tA = prev.tanEnd,
      tB = self.tanStart,
      q = sub(c, self.p0),
      k0 = crs(tA, tB);
    if (Math.abs(k0) < 1e-12 && dot(tA, tB) > 0) continue;
    const sd = k0 >= 0 ? 1 : -1;
    const nA = [sd * tA[1], -sd * tA[0]],
      nB = [sd * tB[1], -sd * tB[0]];
    const P1 = mul(nA, halfW),
      P2 = mul(nB, halfW);
    if (inTri(q, [0, 0], P1, P2)) return true; // bevel
    if (joinStyle === 2) continue;
    if (joinStyle === 1) {
      const k = crs(nA, nB);
      if (len(q) <= halfW && crs(nA, q) * k >= 0 && crs(q, nB) * k >= 0) return true;
      continue;
    }
    const ratio = 1 / Math.sqrt(Math.max(0, 0.5 * (1 - dot(mul(tA, -1), tB))));
    const nb = add(nA, nB);
    if (len(nb) < 1e-12) continue;
    const bis = norm(nb),
      P3 = mul(bis, halfW * ratio);
    if (joinStyle === 0) {
      if (ratio <= miterLimit && inTri(q, P1, P2, P3)) return true;
      continue;
    }
    if (inTri(q, P1, P2, P3) && dot(q, bis) <= Math.max(miterLimit, 1) * halfW) return true;
  }
  return false;
}

// ---- the case sets ---------------------------------------------------------------------------------
const rng = (seed0) => {
  let seed = seed0;
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Seeded chains of cubics. A sixth of the set is a LOOP (the two handles cross, so the curve
 * self-intersects) and a sixth is a CUSP (the handles are equal and opposite) — the two families a
 * seeded Newton is documented to land in the wrong basin on.
 */
export function makeCubicCases(seed0 = 0x3d19, count = 240) {
  const rnd = rng(seed0),
    pick = (a) => a[Math.floor(rnd() * a.length)];
  const cases = [];
  for (let i = 0; i < count; i++) {
    const halfW = pick([1, 2.5, 6]);
    const kind = i % 6 === 0 ? 'loop' : i % 6 === 3 ? 'cusp' : 'plain';
    const closed = kind === 'plain' && rnd() < 0.25;
    const nSeg = closed ? 2 + Math.floor(rnd() * 2) : 1 + Math.floor(rnd() * 3);
    const Cs = [];
    let P = [0, 0],
      dir = rnd() * Math.PI * 2;
    for (let k = 0; k < nSeg; k++) {
      const L = halfW * pick([1, 2.5, 6, 12]);
      let h1, h2, E;
      if (kind === 'loop') {
        // handles crossing: the curve doubles back through itself
        h1 = add(P, mul([Math.cos(dir), Math.sin(dir)], L * 2.2));
        E = add(P, mul([Math.cos(dir + 0.35), Math.sin(dir + 0.35)], L * 0.4));
        h2 = add(E, mul([Math.cos(dir + Math.PI * 0.85), Math.sin(dir + Math.PI * 0.85)], L * 2.2));
      } else if (kind === 'cusp') {
        const u = [Math.cos(dir), Math.sin(dir)];
        h1 = add(P, mul(u, L * 1.6));
        E = add(P, mul(u, L * 0.9));
        h2 = add(E, mul(u, -L * 1.6));
      } else {
        const b1 = dir + (rnd() - 0.5) * 2.2,
          b2 = dir + (rnd() - 0.5) * 2.2;
        h1 = add(P, mul([Math.cos(b1), Math.sin(b1)], L * (0.3 + rnd())));
        E = add(P, mul([Math.cos(dir), Math.sin(dir)], L));
        h2 = add(E, mul([Math.cos(b2 + Math.PI), Math.sin(b2 + Math.PI)], L * (0.3 + rnd())));
      }
      Cs.push([P, h1, h2, E]);
      P = E;
      dir += (rnd() - 0.5) * 2 * ((Math.PI * 170) / 180);
    }
    if (closed) {
      const h1 = add(P, mul([(rnd() - 0.5) * 4, (rnd() - 0.5) * 4], halfW));
      const h2 = mul([(rnd() - 0.5) * 4, (rnd() - 0.5) * 4], halfW);
      Cs.push([P, h1, h2, [0, 0]]);
    }
    const segs = cubicSegs(Cs, closed);
    cases.push({
      Cs,
      segs,
      closed,
      halfW,
      kind,
      cap: closed ? 0 : Math.floor(rnd() * 3),
      joinStyle: Math.floor(rnd() * 5),
      miterLimit: pick([1, 1.5, 2, 4, 10]),
      off: [rnd() * 0.9, rnd() * 0.9],
    });
  }
  return cases;
}

/** Seeded chains of elliptical arcs, including near-circles and half-turn sweeps. */
export function makeArcCases(seed0 = 0x7c41, count = 200) {
  const rnd = rng(seed0),
    pick = (a) => a[Math.floor(rnd() * a.length)];
  const cases = [];
  for (let i = 0; i < count; i++) {
    const halfW = pick([1, 2.5, 6]);
    const nSeg = 1 + Math.floor(rnd() * 3);
    const As = [];
    let P = [0, 0];
    for (let k = 0; k < nSeg; k++) {
      const rx = halfW * pick([1.5, 4, 10, 25]);
      const ry = rx * pick([1, 1, 0.35, 2.4]); // a third of them are true ellipses
      const phi = rnd() * Math.PI;
      const th0 = rnd() * 2 * Math.PI;
      const th1 = th0 + (rnd() < 0.5 ? 1 : -1) * (0.3 + rnd() * 2.4);
      // place the arc so its start meets the pen
      const s0 = evalArc(0, 0, rx, ry, phi, th0);
      As.push({ cx: P[0] - s0[0], cy: P[1] - s0[1], rx, ry, phi, th0, th1 });
      P = evalArc(As[k].cx, As[k].cy, rx, ry, phi, th1);
    }
    const segs = arcSegs(As, false);
    cases.push({
      As,
      segs,
      closed: false,
      halfW,
      cap: Math.floor(rnd() * 3),
      joinStyle: Math.floor(rnd() * 5),
      miterLimit: pick([1, 1.5, 2, 4, 10]),
      off: [rnd() * 0.9, rnd() * 0.9],
    });
  }
  return cases;
}

/** The pixel grid a chain needs: its control box padded by the farthest SVG 2 reaches. */
export function pixelsChain(cs) {
  const ml = Math.max(cs.miterLimit, 1);
  const reach = cs.halfW * Math.sqrt(ml * ml + 1) + 2,
    out = [];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const take = (p) => {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  };
  for (const s of cs.segs) {
    if (s.type === 'arc') {
      for (let k = 0; k <= 32; k++) take(ptAt(s, k / 32));
    } else for (const p of [s.p0, s.p1, s.p2, s.p3]) take(p);
  }
  for (let py = Math.floor(y0 - reach); py <= Math.ceil(y1 + reach); py++)
    for (let px = Math.floor(x0 - reach); px <= Math.ceil(x1 + reach); px++)
      out.push([px + cs.off[0], py + cs.off[1]]);
  return out;
}
