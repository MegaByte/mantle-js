// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _strokeCurveRef.mjs — the CURVE twin of _strokeShapeRef.mjs (not a test on its own).
//
// * quadSeg: a port of _strokeMath.glsl's strokeQuadAccum + strokeCapsJoinsDash for a QUADRATIC
//   segment, as shipped ('fixed') and under the alternative rules it is held against ('buttPastEnd', 'miterClipClamp', 'base'), plus
//   mutations. Quads are the whole of the curve rule that matters: strokeQuadAccum,
//   strokeCubicAccum and strokeArcAccum differ only in how they find the closest point and all
//   three hand the caps, the joins and the dash gate to the one strokeCapsJoinsDash. A quad's
//   closest point is a root of a CUBIC, so the port solves it in closed form and the measurements
//   are not confounded by a Newton residual.
// * svgInsideCurve: the exact SVG 2 stroke shape (https://www.w3.org/TR/svg-strokes/, "Computing
//   the shape of the stroke") of a chain of quadratic Beziers — the swept perpendicular for the
//   body, the cap shapes, and the line join shapes (bevel / round sector / miter kite /
//   miter-clip's clipped kite). The spec's `arcs` join between CURVED segments is a different
//   construction (arcsRegion below), so svgInsideCurve takes joinStyle 4 as miter-clip, which is
//   what SVG 2 itself says to do when both curvatures are zero.
// * makeCurveCases / pixelsCurve: the seeded random poly-quads and their pixel grids, including
//   the fold-back curves that run behind their own start plane.
// * arcsRegion / rendererArcsReach: the SVG 2 arcs join region between curved segments, and the
//   region the renderer actually paints there — for the reach study in strokeCurveJoinSvgShapeSmoke.
import { sub, dot, len, norm, crs, coverageTail } from './_strokeShapeRef.mjs';

export { sub, dot, len, norm, crs, coverageTail };
export const add = (p, q) => [p[0] + q[0], p[1] + q[1]];
export const mul = (p, k) => [p[0] * k, p[1] * k];
export const perp = (p) => [-p[1], p[0]];

// ---- rules -------------------------------------------------------------------------------------
// Each 'pre*' rule is an alternative the shader rejects, kept as a control the checks must tell apart from 'fixed'.
// 'fixed'   as shipped.
// 'buttPastEnd' a free butt end's plane cuts only the pixels PAST the end (the curve branch applies it
//           only when the closest-point parameter is under 1e-4).
// 'miterClipClamp' miter-clip caps the along-tangent extent instead of clipping at the miter limit; a
//           miter past its limit keeps the round shoulder; an arcs join past the limit bevels.
// 'wedgeVertexDrop' outside the join wedge a miter / miter-clip / arcs vertex DROPS, but only when the
//           encoder made this side's neighbour reach finite (next to a free end); everywhere else
//           the radial fall-through stands and the join keeps the full halfW disc.
// 'squareCapFrontDrop' a SQUARE cap DROPS the whole segment when the pixel is in FRONT of its cap plane. The
//           cap branch runs under `t < 1e-4`, a parameter-space gate that admits a closest point at
//           t in (0, 1e-4) as well as one exactly at the endpoint, and there the pixel is genuinely
//           interior: `a` is a rounding away from zero and a negative `a` throws the segment away.
// 'roundBevelDisc' outside the join wedge a ROUND join keeps the full halfW disc and a BEVEL join keeps
//           the disc bounded only by its chord; at the END vertex both DROP instead of ending in a
//           butt end, while miter / miter-clip / arcs take the line branch's butt end there.
// 'base'    all of them at once.
// mutations: 'noLocality' (the butt-end plane with no locality test — it cuts a curve's own body where it
//           folds back), 'tGate' (the butt-end plane gated in PARAMETER space, the scale-dependent form),
//           'noMiterClipLine' (the miter-clip clip line dropped), 'roundPastLimit' (a miter past its limit
//           draws round), 'bevelArcs' (an arcs join past the limit bevels instead of clipping),
//           'dropWedge' (the curve wedge as a hard DROP instead of the butt-end SDF — the same
//           membership, without the ramp across the plane), 'legacyRoots' (the naive degenerate-branch
//           cubic solver, which loses the interior root of every near-straight quad — a mutation of
//           the INSTRUMENT, not of the shader, kept so that failure stays measurable),
//           'noAlongLo' (drops the `along >= 0` LOWER bound on the join wedge's along-tangent
//           extent, which the line branch has no twin of; test/strokeCurveSolverRefSmoke.mjs shows
//           why the bound stays. The line branch needs
//           no such bound because it reaches its vertex branch only when tRaw is outside [0, 1],
//           which IS along > 0; the curve branch's gate is the closest-point PARAMETER, and the two
//           are the same statement only for an exact solver. The bound is what stops an inexact one
//           — the cubic's 9-sample seed — from taking a wrong-basin t ~ 0 into the join and
//           painting the distance to the TANGENT LINE AT THE VERTEX far from the vertex: without
//           it every under-paint stays and the centers painted outside SVG 2 on cubics double.)
const RULES = {
  fixed: {},
  buttPastEnd: { buttPastEnd: true },
  miterClipClamp: { miterClipClamp: true },
  wedgeVertexDrop: { wedgeVertexDrop: true },
  roundBevelDisc: { roundBevelDisc: true },
  squareCapFrontDrop: { squareCapFrontDrop: true },
  base: {
    buttPastEnd: true,
    miterClipClamp: true,
    wedgeVertexDrop: true,
    roundBevelDisc: true,
    squareCapFrontDrop: true,
  },
  noLocality: { noLocality: true },
  tGate: { tGate: true },
  noMiterClipLine: { noMiterClipLine: true },
  roundPastLimit: { roundPastLimit: true },
  bevelArcs: { bevelArcs: true },
  noArcsCut: { noArcsCut: true },
  dropWedge: { dropWedge: true },
  legacyRoots: { legacyRoots: true },
  noAlongLo: { noAlongLo: true },
};

// ---- exact closest point on a quadratic (the shader's quadClosestT, in double) -------------------
/**
 * The real roots of a3 t^3 + a2 t^2 + a1 t + a0, by the shader's route: Cardano, or the QUADRATIC
 * form when the cubic term has collapsed, and then Newton on every candidate.
 *
 * The degenerate branch has two traps, and either one costs this reference far more under-paint
 * than the rule it is built to measure.
 *
 *   * THE NAIVE QUADRATIC FORMULA CANCELS. This branch is entered precisely when a3 is negligible,
 *     which is the regime where 4*a2*a0 is negligible against a1^2 — so sqrt(disc) == |a1| to the
 *     last bit and one of (-a1 +- s) / (2 a2) is 0/0-shaped: every significant digit cancels, and
 *     dividing the noise by a tiny a2 returns anything at all. _strokeMath.glsl's quadClosestT does
 *     NOT do this; it takes the stable pair qq = -0.5 (a1 + sign(a1) sqrt(disc)), roots qq/a2 and
 *     a0/qq, and so does this.
 *   * THE BRANCH MUST NOT RETURN BEFORE THE POLISH. The Newton polish (polishRoots) runs on both
 *     paths' exits, so a canceled root is repaired.
 *
 * Why it matters: a quad whose control point is the MIDPOINT of its endpoints is a straight line
 * exactly, and a3 = 2|A|^2 with A = p0 - 2 p1 + p2 — the rounding error of p0 + p2, not zero. So
 * every such segment takes this branch; losing its interior root reports the START VERTEX as the
 * closest point where the true foot is mid-body. strokeCapsJoinsDash then runs its JOIN branch on a
 * body pixel and hands back the radial distance to the vertex instead of the perpendicular
 * distance to the segment, and the pixel scores as an under-paint against SVG 2 that the shader
 * does not have. Named case: p0 = (-1.6046321417360476, 3.2226007648648602),
 * p2 = (-40.184196928121, 31.78161301832219), query (-6.779670519032516, -0.19840689264237876) —
 * true t 0.044249188 at distance 5.8286; the naive form answers t = 0 at 6.2036, and halfW is 6.
 *
 * The shipped shader is NOT affected and is shown so: its own quadClosestT, cut out of
 * src/shaders/generated/mantle.frag.glsl and run as float32, answers 0.0442492 on that input
 * (test/strokeCurveSolverRefSmoke.mjs compiles the shader text and checks it).
 */
export function realRootsCubic(a3, a2, a1, a0) {
  const out = [];
  if (Math.abs(a3) < 1e-14 * Math.max(Math.abs(a2), Math.abs(a1), Math.abs(a0), 1e-300)) {
    if (Math.abs(a2) > 1e-300) {
      const disc = a1 * a1 - 4 * a2 * a0;
      if (disc >= 0) {
        // the shader's stable pair, NOT (-a1 +- sqrt(disc)) / (2 a2)
        const s = Math.sqrt(disc),
          qq = -0.5 * (a1 + (a1 >= 0 ? s : -s));
        out.push(qq / a2);
        if (Math.abs(qq) > 1e-300) out.push(a0 / qq);
      }
    } else if (Math.abs(a1) > 1e-300) out.push(-a0 / a1);
    return polishRoots(out, a3, a2, a1, a0); // ...and this branch gets the polish too
  }
  const p = a2 / a3,
    q = a1 / a3,
    r = a0 / a3;
  const pp = q - (p * p) / 3,
    qq = (2 * p * p * p) / 27 - (p * q) / 3 + r,
    shift = -p / 3;
  const disc = (qq * qq) / 4 + (pp * pp * pp) / 27;
  if (disc > 0) {
    const s = Math.sqrt(disc),
      u = -qq / 2 + s,
      v = -qq / 2 - s;
    out.push(Math.cbrt(u) + Math.cbrt(v) + shift);
  } else {
    const rr = Math.sqrt(Math.max((-pp * pp * pp) / 27, 0));
    const phi = Math.acos(Math.min(1, Math.max(-1, -qq / (2 * Math.max(rr, 1e-300)))));
    const m = 2 * Math.sqrt(Math.max(-pp / 3, 0));
    out.push(
      m * Math.cos(phi / 3) + shift,
      m * Math.cos((phi + 2 * Math.PI) / 3) + shift,
      m * Math.cos((phi + 4 * Math.PI) / 3) + shift,
    );
  }
  return polishRoots(out, a3, a2, a1, a0);
}
// polish: Cardano through the depressed form loses digits even in float64, and the quadratic
// branch's second root is worse still (see realRootsCubic). The shader does one Newton step on
// every candidate; this reference is meant to be exact, so it runs four.
function polishRoots(out, a3, a2, a1, a0) {
  return out.map((t0) => {
    let t = t0;
    for (let k = 0; k < 4; k++) {
      const f = ((a3 * t + a2) * t + a1) * t + a0,
        df = (3 * a3 * t + 2 * a2) * t + a1;
      if (Math.abs(df) < 1e-300) break;
      t -= f / df;
    }
    return Number.isFinite(t) ? t : t0;
  });
}
/** The naive degenerate-branch solver, kept only so the `legacyRoots` mutation can measure what it costs. */
export function legacyRealRootsCubic(a3, a2, a1, a0) {
  const out = [];
  if (Math.abs(a3) < 1e-14 * Math.max(Math.abs(a2), Math.abs(a1), Math.abs(a0), 1e-300)) {
    if (Math.abs(a2) > 1e-300) {
      const disc = a1 * a1 - 4 * a2 * a0;
      if (disc >= 0) {
        const s = Math.sqrt(disc);
        out.push((-a1 + s) / (2 * a2), (-a1 - s) / (2 * a2));
      }
    } else if (Math.abs(a1) > 1e-300) out.push(-a0 / a1);
    return out;
  }
  return realRootsCubic(a3, a2, a1, a0);
}
/** Every parameter in [0,1] where the quadratic A t^2 + B t + C is PERPENDICULAR to the origin. */
export function quadPerpParams(A, B, C, legacy = false) {
  const a3 = 2 * dot(A, A),
    a2 = 3 * dot(A, B);
  const a1 = dot(B, B) + 2 * dot(A, C),
    a0 = dot(B, C);
  return (legacy ? legacyRealRootsCubic : realRootsCubic)(a3, a2, a1, a0).filter(
    (t) => t >= 0 && t <= 1,
  );
}
/** The shader's quadClosestT: the nearest of the in-range roots and the two endpoints. */
export function quadClosestT(A, B, C, legacy = false) {
  let bt = 0,
    bs = Infinity;
  const at = (t) => {
    const q = [(A[0] * t + B[0]) * t + C[0], (A[1] * t + B[1]) * t + C[1]];
    return dot(q, q);
  };
  for (const t of [0, 1, ...quadPerpParams(A, B, C, legacy)]) {
    const tt = Math.min(1, Math.max(0, t)),
      d2 = at(tt);
    if (d2 < bs) {
      bs = d2;
      bt = tt;
    }
  }
  return bt;
}

// ---- the segment record -------------------------------------------------------------------------
/** Signed centerline curvature of a quad at t=0 / t=1 (src/svg/textures.js segEndpointCurvature). */
export function quadCurvature(p0, p1, p2, atStart) {
  const d1 = atStart ? mul(sub(p1, p0), 2) : mul(sub(p2, p1), 2);
  const d2 = mul([p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]], 2);
  const m = len(d1);
  if (!(m > 1e-12)) return 0;
  return crs(d1, d2) / (m * m * m);
}
/** The encoder's per-segment records for a chain of quads (each [p0, p1, p2]). */
export function quadSegs(Q, closed) {
  const m = Q.length,
    segs = Q.map(([p0, p1, p2]) => ({ p0, p1, p2 }));
  const tS = segs.map((s) => norm(sub(s.p1, s.p0))),
    tE = segs.map((s) => norm(sub(s.p2, s.p1)));
  segs.forEach((s, i) => {
    const prev = closed ? (i - 1 + m) % m : i - 1,
      next = closed ? (i + 1) % m : i + 1;
    s.freeStart = prev < 0;
    s.freeEnd = next >= m;
    // the encoder's join reach (src/svg/textures.js): FINITE only when the neighbor is itself a
    // free end, and _strokeMath.glsl's `ourTerritory` drop is gated on that being under 1e8.
    s.startPrevReach =
      prev >= 0 && (closed ? false : prev === 0) ? len(sub(segs[prev].p2, segs[prev].p0)) : 1e9;
    s.endNextReach =
      next < m && (closed ? false : next === m - 1) ? len(sub(segs[next].p2, segs[next].p0)) : 1e9;
    s.inTan = prev < 0 ? [0, 0] : tE[prev];
    s.outTan = next >= m ? [0, 0] : tS[next];
    s.tanStart = tS[i];
    s.tanEnd = tE[i];
    s.kSS = quadCurvature(s.p0, s.p1, s.p2, true);
    s.kSE = quadCurvature(s.p0, s.p1, s.p2, false);
    s.kPE = prev < 0 ? 0 : quadCurvature(segs[prev].p0, segs[prev].p1, segs[prev].p2, false);
    s.kNS = next >= m ? 0 : quadCurvature(segs[next].p0, segs[next].p1, segs[next].p2, true);
  });
  return segs;
}

// ---- the shader's curve branch --------------------------------------------------------------
// perpDistToArc (_strokeMath.glsl): distance to the osculating circle of signed curvature kappa
// tangent to `tan` at the vertex; the +-halfW band around it is the SVG 2 arcs edge pair.
export function perpDistToArc(q, tan, kappa) {
  const L = perp(tan);
  if (Math.abs(kappa) < 1e-6) return Math.abs(dot(q, L));
  const R = 1 / kappa,
    CC = mul(L, R);
  return Math.abs(len(sub(q, CC)) - Math.abs(R));
}
// The bevel chord as an AA distance: coverage crosses 0.5 at the chord joining the two outer
// offset points. tA / tB are the two tangents in path order.
function bevelChord(q, tA, tB, halfW) {
  const sd = crs(tA, tB) >= 0 ? 1 : -1;
  const nA = [sd * tA[1], -sd * tA[0]],
    nB = [sd * tB[1], -sd * tB[0]];
  const nb = add(nA, nB),
    bl = len(nb);
  if (!(bl > 1e-4)) return -Infinity;
  const bis = mul(nb, 1 / bl);
  return halfW + dot(q, bis) - halfW * dot(nA, bis);
}

/**
 * One quadratic segment's contribution for pixel center `c`: the port of strokeQuadAccum, whose
 * whole body is finding the closest point and handing it to capsJoinsDash. Returns { d, g } — the
 * effective distance and the body normal (null when a cap, a join or an end plane rewrote the
 * distance, which is when the shader zeroes gradOut).
 */
// `cap` is the START cap and `endCap` the END one (meta slot 46's asymmetric pair); each free end
// takes its own, as strokeCapsJoinsDash's startCap / endCap arguments do.
export function quadSeg(rule, c, s, halfW, cap, joinStyle, miterLimit, endCap = cap) {
  const A = [s.p0[0] - 2 * s.p1[0] + s.p2[0], s.p0[1] - 2 * s.p1[1] + s.p2[1]];
  const B = mul(sub(s.p1, s.p0), 2),
    C = sub(s.p0, c);
  const t = quadClosestT(A, B, C, !!RULES[rule]?.legacyRoots);
  const qv = [(A[0] * t + B[0]) * t + C[0], (A[1] * t + B[1]) * t + C[1]];
  let dStart = B;
  if (dot(dStart, dStart) < 1e-18) dStart = sub(s.p2, s.p0);
  let dEnd = [2 * A[0] + B[0], 2 * A[1] + B[1]];
  if (dot(dEnd, dEnd) < 1e-18) dEnd = sub(s.p2, s.p0);
  return capsJoinsDash(
    rule,
    c,
    t,
    len(qv),
    qv,
    s.p0,
    s.p2,
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

/**
 * The port of _strokeMath.glsl's strokeCapsJoinsDash — the caps, the joins and the free butt end's
 * plane, shared by the quad, the cubic and the arc exactly as the one GLSL function is. The three
 * accumulators differ only in how they find the closest point, which is what the cubic and arc checks measure.
 *
 * `t` is the closest-point parameter, `thisD` its distance, `qv` the closest point MINUS the query
 * (the shader's own sign, used only for the body normal); p0 / p2 are the endpoints and dStart /
 * dEnd the endpoint derivatives; `s` carries the encoder's per-segment record.
 */
export function capsJoinsDash(
  rule,
  c,
  t,
  thisD0,
  qv,
  p0,
  p2,
  dStart,
  dEnd,
  s,
  halfW,
  cap,
  endCap,
  joinStyle,
  miterLimit,
) {
  const R = RULES[rule];
  if (!R) throw new Error(`unknown rule ${rule}`);
  const ml = Math.max(miterLimit, 1);
  let thisD = thisD0,
    drop = false;
  const body = t >= 1e-4 && t <= 1 - 1e-4 && thisD > 1e-12;
  let grad = body && qv ? [-qv[0] / thisD, -qv[1] / thisD] : null;
  const tanS = norm(dStart),
    tanE = norm(dEnd);

  // ---- the join wedge, shared by both vertices -------------------------------------------------
  // `q` is the pixel relative to the vertex; `own` this segment's OUTWARD direction there and
  // `other` the neighbor's, pointing away from the vertex. tSelf / tOther are the same two tangents
  // in PATH order, which is the sign perpDistToArc's osculating center depends on; tA / tB are the
  // incoming and outgoing tangents in path order, for the bevel chord.
  const vertex = (q, own, other, tSelf, tOther, tA, tB, kSelf, kOther) => {
    const cosBetween = dot(own, other);
    const sinHalf = 0.5 * Math.hypot(own[0] - other[0], own[1] - other[1]); // half the distance between the unit vectors (no absolute floor)
    const cosHalf = Math.sqrt(Math.max(0.5 * (1 + cosBetween), 0));
    const miterLen = halfW / sinHalf;
    const fits = miterLen <= halfW * miterLimit;
    const along = dot(q, own);
    const arcJoin = joinStyle === 4;
    const perpThis = arcJoin ? perpDistToArc(q, tSelf, kSelf) : len(sub(q, mul(own, along)));
    const perpOther = arcJoin ? perpDistToArc(q, tOther, kOther) : Math.abs(dot(q, perp(tOther)));
    // The cut at the reach the pads assume (see _strokeMath.glsl): the two arcs bands meet again on
    // the far side of their circles, and a near-reversal's clipped kite runs on BACKWARDS from the
    // vertex, and nothing else in this branch bounds either.
    const cut = R.noArcsCut ? -Infinity : halfW + len(q) - halfW * Math.sqrt(ml * ml + 1);
    if (R.miterClipClamp) {
      // the 'miterClipClamp' rule: miter-clip CLAMPS miterLen to the limit and bounds the along-tangent extent
      // by the clamped value; a miter past its limit draws nothing (the radial distance stands, so
      // the join is a round shoulder); arcs bevels past the limit.
      let mLen = miterLen;
      if (joinStyle === 3) mLen = Math.min(mLen, halfW * miterLimit);
      else if (joinStyle === 0 && !fits) mLen = -1;
      if (arcJoin && !fits) {
        thisD = Math.max(thisD, bevelChord(q, tA, tB, halfW));
        return;
      }
      if (mLen >= 0 && mLen <= halfW * miterLimit && along >= 0 && along <= mLen * cosHalf)
        thisD = Math.min(thisD, Math.max(perpThis, perpOther));
      return;
    }
    // shipped: the LINE branch's rule (_coverage.glsl), segment for segment.
    if (joinStyle === 0 && !fits && !R.roundPastLimit)
      thisD = Math.max(thisD, bevelChord(q, tA, tB, halfW));
    const capAlong = fits ? miterLen * cosHalf : 0;
    // the `along >= 0` lower bound the LINE branch has no twin of — it stays ('noAlongLo' in the rule table)
    if ((R.noAlongLo || along >= 0) && along <= capAlong) {
      thisD = Math.min(
        thisD,
        arcJoin ? Math.max(perpThis, perpOther, cut) : Math.max(perpThis, perpOther),
      );
    } else if ((joinStyle === 3 || (arcJoin && !R.bevelArcs)) && !fits) {
      // the join region cut by the line perpendicular to the bisector at miterLimit * halfW from
      // the vertex (SVG 2: "clip any part of the line join region that extends past the miter
      // limit"). The tip direction is own + other, which does not cancel at a near-reversal.
      let d = Math.max(perpThis, perpOther, cut);
      const tip = add(own, other),
        tl = len(tip);
      if (tl > 1e-4 && !R.noMiterClipLine) d = Math.max(d, halfW + dot(q, tip) / tl - halfW * ml);
      thisD = d;
    } else if (arcJoin && R.bevelArcs && !fits) {
      thisD = Math.max(thisD, bevelChord(q, tA, tB, halfW));
    }
  };

  if (t < 1e-4) {
    const q = sub(c, p0);
    if (s.freeStart) {
      if (cap === 0) thisD = Math.max(thisD, halfW + dot(q, [-tanS[0], -tanS[1]]));
      else if (cap === 2) {
        // the square cap is a UNION with the body, so its branch may only ever LOWER thisD.
        // `a` is how far past the cap plane the pixel lies; at a < 0 it is in FRONT of the plane,
        // inside this segment's own body, which thisD already measures. Dropping there discarded
        // the whole segment.
        const a = dot(q, [-tanS[0], -tanS[1]]);
        if (a < 0) {
          if (R.squareCapFrontDrop) drop = true;
        } else thisD = Math.min(thisD, Math.max(len(add(q, mul(tanS, a))), a));
      }
    } else if (joinStyle === 1) {
      if (dot(q, s.inTan) < 0) {
        // OUTSIDE THE JOIN WEDGE A ROUND JOIN IS A BUTT END TOO, as miter, miter-clip and arcs are
        // ('roundBevelDisc' keeps round and bevel on the full halfW disc, which the line branch does not
        // either). A round join is the bevel triangle plus the circular SECTOR between the two outer
        // offset normals, not a disc.
        const butt = Math.min(thisD, len(q));
        thisD = R.roundBevelDisc ? butt : Math.max(butt, halfW + dot(q, [-tanS[0], -tanS[1]]));
      }
    } else if (joinStyle === 2) {
      const behind = dot(q, s.inTan) < 0;
      if (behind && !R.roundBevelDisc)
        thisD = Math.max(Math.min(thisD, len(q)), halfW + dot(q, [-tanS[0], -tanS[1]]));
      else thisD = Math.max(behind ? len(q) : thisD, bevelChord(q, s.inTan, tanS, halfW));
    } else if (dot(q, s.inTan) < 0) {
      // outside the join wedge this end is a BUTT end, the line branch's rule. 'wedgeVertexDrop' makes it
      // a DROP gated on the encoder's neighbour reach, which is finite only next to a free end.
      if (R.wedgeVertexDrop) {
        if (s.startPrevReach < 1e8) drop = true;
        vertex(q, [-tanS[0], -tanS[1]], s.inTan, tanS, s.inTan, s.inTan, tanS, s.kSS, s.kPE);
      } else if (R.dropWedge) drop = true;
      else thisD = Math.max(thisD, halfW + dot(q, [-tanS[0], -tanS[1]]));
    } else {
      vertex(q, [-tanS[0], -tanS[1]], s.inTan, tanS, s.inTan, s.inTan, tanS, s.kSS, s.kPE);
    }
  }
  if (t > 1 - 1e-4) {
    const q = sub(c, p2);
    if (s.freeEnd) {
      if (endCap === 0) thisD = Math.max(thisD, halfW + dot(q, tanE));
      else if (endCap === 2) {
        const a = dot(q, tanE); // see the start twin
        if (a < 0) {
          if (R.squareCapFrontDrop) drop = true;
        } else thisD = Math.min(thisD, Math.max(len(sub(q, mul(tanE, a))), a));
      }
    } else if (joinStyle === 1) {
      // The end-vertex twin: a BUTT end, not a hard DROP. The drop reaches the same
      // membership (the half-disc it keeps is inside this segment's own body) but loses the ramp
      // across the plane, which is the square cap's and the butt end's lesson and the curve wedge's for the other three joins.
      if (dot(q, s.outTan) > 0) {
        if (R.roundBevelDisc) drop = true;
        else thisD = Math.max(Math.min(thisD, len(q)), halfW + dot(q, tanE));
      }
    } else if (joinStyle === 2) {
      if (dot(q, s.outTan) > 0) {
        if (R.roundBevelDisc) drop = true;
        else thisD = Math.max(Math.min(thisD, len(q)), halfW + dot(q, tanE));
      } else thisD = Math.max(thisD, bevelChord(q, tanE, s.outTan, halfW));
    } else if (dot(q, s.outTan) > 0) {
      if (R.wedgeVertexDrop) {
        if (s.endNextReach < 1e8) drop = true;
        vertex(q, tanE, [-s.outTan[0], -s.outTan[1]], tanE, s.outTan, tanE, s.outTan, s.kSE, s.kNS);
      } else if (R.dropWedge) drop = true;
      else thisD = Math.max(thisD, halfW + dot(q, tanE));
    } else {
      vertex(q, tanE, [-s.outTan[0], -s.outTan[1]], tanE, s.outTan, tanE, s.outTan, s.kSE, s.kNS);
    }
  }
  // ---- (curves): a free butt end's plane cuts the pixels just INSIDE it too ----------------
  // The cap branch above only runs when the CLOSEST POINT is the endpoint, so without this only the
  // outer half of the end's AA ramp exists and the pixels just inside paint solid. The line branch
  // applies the plane to every body hit; a curve cannot, because it can fold back behind its own
  // start plane and the term would erase the returning arm. The locality test is the butt end's own
  // extent: the end plane bounds the stroke only across the cap segment |lateral| <= halfW, which is
  // exactly where the swept perpendicular at t=0 reaches.
  if (!R.buttPastEnd && !drop && t > 1e-4 && t < 1 - 1e-4) {
    let endD = -Infinity;
    // aOut is how far the pixel lies BEYOND the plane; on a body hit near a butt end it is negative
    // (the pixel is in front of the plane) and halfW + aOut is the ramp the line branch already
    // paints. TWO locality tests, both needed:
    //   aOut <= 0    the term may only LOWER the coverage of a pixel the shape already contains, so
    //                membership at d <= halfW cannot move — the invariant the line fix has for free
    //                (a line's body hit is always in front of its own end plane, a curve's is not);
    //   |lateral| <= halfW   the end plane bounds the stroke only across the butt segment itself,
    //                which is where the swept perpendicular at t=0 reaches. Past it the plane is not
    //                the boundary, and a fold-back arm crossing in front of the plane would take a
    //                hairline of partial coverage straight across its body.
    const term = (q, tan) => {
      const aOut = -dot(q, tan);
      if (R.noLocality) return halfW + aOut;
      if (R.tGate) return -Infinity; // handled below, in parameter space
      if (aOut > 0 || Math.abs(dot(q, perp(tan))) > halfW) return -Infinity;
      return halfW + aOut;
    };
    if (s.freeStart && cap === 0) {
      const q = sub(c, p0);
      endD = Math.max(endD, term(q, tanS));
      // 'tGate': the locality test the shipped cap branches already use — a tolerance on the
      // PARAMETER, whose width in em is 1e-4 of the curve's own length and so in pixels depends on
      // how long the curve is and how far the view is zoomed in.
      if (R.tGate && t < 1e-4) endD = Math.max(endD, halfW - dot(q, tanS));
    }
    if (s.freeEnd && endCap === 0) {
      const q = sub(c, p2);
      endD = Math.max(endD, term(q, [-tanE[0], -tanE[1]]));
      if (R.tGate && t > 1 - 1e-4) endD = Math.max(endD, halfW + dot(q, tanE));
    }
    if (endD > thisD) {
      thisD = endD;
      grad = null;
    }
  }
  if (drop) return { d: Infinity, g: null };
  return { d: thisD, g: grad };
}

export function minDistCurve(rule, c, segs, halfW, cap, joinStyle, miterLimit, endCap = cap) {
  let minD = 1e30,
    grad = [0, 0];
  for (const s of segs) {
    const r = quadSeg(rule, c, s, halfW, cap, joinStyle, miterLimit, endCap);
    if (r.d < minD) {
      minD = r.d;
      grad = r.g || [0, 0];
    }
  }
  return { minD, grad };
}
export function coverageCurve(rule, c, segs, halfW, cap, joinStyle, miterLimit, endCap = cap) {
  const { minD, grad } = minDistCurve(rule, c, segs, halfW, cap, joinStyle, miterLimit, endCap);
  return coverageTail(minD, grad, halfW);
}

// ---- the exact SVG 2 stroke shape of a chain of quads -------------------------------------------
const inTri = (q, A, B, C) => {
  const s1 = crs(sub(B, A), sub(q, A)),
    s2 = crs(sub(C, B), sub(q, B)),
    s3 = crs(sub(A, C), sub(q, C));
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
};
/**
 * SVG 2's stroke shape: "all points that lie on the line perpendicular to the subpath at that
 * distance and which are within distance stroke-width/2 of the point on the subpath", plus the cap
 * shapes at the two free ends and the line join shape at each interior vertex. `segs` is quadSegs'
 * output. joinStyle 4 (arcs) is taken as miter-clip, which is what SVG 2 does when both curvatures
 * are zero; arcsRegion covers the curved case.
 */
export function svgInsideCurve(c, segs, closed, halfW, cap, joinStyle, miterLimit, endCap = cap) {
  const m = segs.length;
  for (const s of segs) {
    // ---- body ----
    const A = [s.p0[0] - 2 * s.p1[0] + s.p2[0], s.p0[1] - 2 * s.p1[1] + s.p2[1]];
    const B = mul(sub(s.p1, s.p0), 2),
      C = sub(s.p0, c);
    for (const t of quadPerpParams(A, B, C)) {
      const q = [(A[0] * t + B[0]) * t + C[0], (A[1] * t + B[1]) * t + C[1]];
      if (len(q) <= halfW) return true;
    }
  }
  if (!closed) {
    // ---- caps ----
    for (const [V, out, k] of [
      [segs[0].p0, mul(segs[0].tanStart, -1), cap],
      [segs[m - 1].p2, segs[m - 1].tanEnd, endCap],
    ]) {
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
      // bevel U sector
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

// ---- the case set --------------------------------------------------------------------------------
/**
 * Seeded random chains of quadratic Beziers. `bend` is the turn from the incoming leg to the
 * outgoing one WITHIN a segment, so a large bend folds the curve back behind its own start plane —
 * which is the case the butt-end plane's locality test exists for. `foldy` cases force that.
 */
export function makeCurveCases(seed0 = 0x2c17, count = 300) {
  let seed = seed0;
  const rnd = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const cases = [];
  for (let i = 0; i < count; i++) {
    const halfW = pick([1, 2.5, 6]);
    const foldy = i % 4 === 0; // a quarter of the set folds back hard
    const closed = !foldy && rnd() < 0.25;
    const nSeg = closed ? 2 + Math.floor(rnd() * 2) : 1 + Math.floor(rnd() * 3);
    const Q = [];
    let P = [0, 0],
      dir = rnd() * Math.PI * 2;
    for (let k = 0; k < nSeg; k++) {
      const L1 = halfW * pick([0.4, 1, 2.5, 6]),
        L2 = halfW * pick([0.4, 1, 2.5, 6]);
      const bend = foldy
        ? (rnd() < 0.5 ? 1 : -1) * (Math.PI * (0.55 + 0.4 * rnd()))
        : (rnd() - 0.5) * 2 * (Math.PI * 0.75);
      const p1 = [P[0] + L1 * Math.cos(dir), P[1] + L1 * Math.sin(dir)];
      dir += bend;
      const p2 = [p1[0] + L2 * Math.cos(dir), p1[1] + L2 * Math.sin(dir)];
      Q.push([P, p1, p2]);
      P = p2;
      dir += (rnd() - 0.5) * 2 * ((Math.PI * 170) / 180); // the tangent break at the join
    }
    if (closed) {
      // close the chain back to the origin
      const p1 = [P[0] + (rnd() - 0.5) * 4 * halfW, P[1] + (rnd() - 0.5) * 4 * halfW];
      Q.push([P, p1, [0, 0]]);
    }
    const segs = quadSegs(Q, closed);
    const joinStyle = Math.floor(rnd() * 5),
      capStyle = closed ? 0 : Math.floor(rnd() * 3);
    const miterLimit = pick([1, 1.5, 2, 4, 10]);
    const pastLimit = segs.some((s, k) => {
      if (s.freeStart) return false;
      const own = mul(s.tanStart, -1);
      return 1 / Math.sqrt(Math.max(1e-12, 0.5 * (1 - dot(own, s.inTan)))) > miterLimit;
    });
    cases.push({
      Q,
      segs,
      closed,
      halfW,
      cap: capStyle,
      joinStyle,
      miterLimit,
      foldy,
      pastLimit,
      off: [rnd() * 0.9, rnd() * 0.9],
    });
  }
  return cases;
}
export const pixelsCurve = (cs) => {
  const ml = Math.max(cs.miterLimit, 1);
  const reach = cs.halfW * Math.sqrt(ml * ml + 1) + 2,
    out = [];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [a, b, d] of cs.Q)
    for (const p of [a, b, d]) {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
  for (let py = Math.floor(y0 - reach); py <= Math.ceil(y1 + reach); py++)
    for (let px = Math.floor(x0 - reach); px <= Math.ceil(x1 + reach); px++)
      out.push([px + cs.off[0], py + cs.off[1]]);
  return out;
};

// ---- SVG 2's `arcs` join between CURVED segments, and what the renderer paints there --------------
//
// SVG 2: "find the circles that are tangent to the stroke edges at P1 and P2 with the same curvature
// as the edges at those points... Extend the stroke edges using these circles (or a line, in the
// case of zero curvature). If the two circles (or circle and line) do not intersect, fall through to
// miter-clip. If the two circles (or circle and line) intersect, the line join region is defined by
// the lines that connect P with P1 and P2 and the arcs defined by the circles (or arc and line)
// between the closest intersection point to P, and P1 and P2. Next calculate the miter limit...
// Clip any part of the line join region that extends past the miter limit."
//
// Both edges' circles are CONCENTRIC with the centerline's osculating circle (the offset of a circle
// is a circle about the same center), so the circle through P1 has center (1/kappa) * perp(tA) and
// radius |P1 - center| — which is exactly the band _strokeMath.glsl's perpDistToArc measures.

/** The edge circle at P1 = halfW * nA: { line: true, n, d } for zero curvature, else { c, r }. */
export function edgeCircle(tA, nA, kappa, halfW) {
  const P1 = mul(nA, halfW);
  if (Math.abs(kappa) < 1e-12) return { line: true, p: P1, t: tA };
  const c = mul(perp(tA), 1 / kappa);
  return { c, r: len(sub(P1, c)), p: P1 };
}
/** Intersections of two edge extensions (circle/circle, circle/line or line/line). */
export function edgeIntersections(a, b) {
  const out = [];
  if (a.line && b.line) {
    const d = crs(a.t, b.t);
    if (Math.abs(d) < 1e-12) return out;
    const w = sub(b.p, a.p);
    out.push(add(a.p, mul(a.t, crs(w, b.t) / d)));
    return out;
  }
  if (a.line || b.line) {
    const L = a.line ? a : b,
      C = a.line ? b : a;
    const w = sub(L.p, C.c),
      h = dot(w, L.t);
    const perpD2 = dot(w, w) - h * h,
      disc = C.r * C.r - perpD2;
    if (disc < 0) return out;
    const s = Math.sqrt(disc);
    out.push(add(L.p, mul(L.t, -h + s)), add(L.p, mul(L.t, -h - s)));
    return out;
  }
  const d = sub(b.c, a.c),
    D = len(d);
  if (D < 1e-12 || D > a.r + b.r || D < Math.abs(a.r - b.r)) return out;
  const x = (D * D + a.r * a.r - b.r * b.r) / (2 * D);
  const h2 = a.r * a.r - x * x;
  if (h2 < 0) return out;
  const h = Math.sqrt(h2),
    u = mul(d, 1 / D),
    v = perp(u);
  const base = add(a.c, mul(u, x));
  out.push(add(base, mul(v, h)), sub(base, mul(v, h)));
  return out;
}
/**
 * The SVG 2 arcs join region's boundary, relative to the vertex, as a dense polyline (the two
 * radial segments, the two extended edges out to the closest intersection). `null` when the
 * construction falls through to miter-clip.
 */
export function arcsRegion(tA, tB, kEdgeA, kEdgeB, halfW, samples = 4000) {
  const k0 = crs(tA, tB);
  if (Math.abs(k0) < 1e-12 && dot(tA, tB) > 0) return null;
  const sd = k0 >= 0 ? 1 : -1;
  const nA = [sd * tA[1], -sd * tA[0]],
    nB = [sd * tB[1], -sd * tB[0]];
  const A = edgeCircle(tA, nA, kEdgeA, halfW),
    B = edgeCircle(tB, nB, kEdgeB, halfW);
  const hits = edgeIntersections(A, B);
  if (!hits.length) return null;
  let Qp = hits[0];
  for (const h of hits) if (len(h) < len(Qp)) Qp = h;
  // walk each edge from its P forward (A in +tA, B in -tB) to Q
  const walk = (E, target, fwd) => {
    const pts = [];
    if (E.line) {
      const s = dot(sub(target, E.p), E.t);
      for (let i = 0; i <= samples; i++) pts.push(add(E.p, mul(E.t, (s * i) / samples)));
      return pts;
    }
    const a0 = Math.atan2(E.p[1] - E.c[1], E.p[0] - E.c[0]);
    const a1 = Math.atan2(target[1] - E.c[1], target[0] - E.c[0]);
    // the sweep direction is the one whose tangent at P matches the edge direction
    const tanAt = (a) => {
      const raw = [-Math.sin(a), Math.cos(a)];
      return raw;
    };
    const ccw = dot(tanAt(a0), fwd) >= 0;
    let da = a1 - a0;
    if (ccw) {
      while (da <= 0) da += 2 * Math.PI;
    } else {
      while (da >= 0) da -= 2 * Math.PI;
    }
    for (let i = 0; i <= samples; i++) {
      const a = a0 + (da * i) / samples;
      pts.push(add(E.c, [E.r * Math.cos(a), E.r * Math.sin(a)]));
    }
    return pts;
  };
  return {
    Q: Qp,
    nA,
    nB,
    edgeA: walk(A, Qp, tA),
    edgeB: walk(B, Qp, mul(tB, -1)),
    P1: mul(nA, halfW),
    P2: mul(nB, halfW),
  };
}
/**
 * How far SVG 2's arcs join region reaches from the vertex, in half-widths, AFTER the spec's miter
 * limit clip. `null` when the construction falls through to miter-clip (whose reach is the proven
 * sqrt(miterLimit^2 + 1)). The maximum is on the boundary, so the boundary is what is walked.
 */
export function svgArcsReach(tA, tB, kEdgeA, kEdgeB, halfW, miterLimit) {
  const reg = arcsRegion(tA, tB, kEdgeA, kEdgeB, halfW);
  if (!reg) return null;
  const nb = add(reg.nA, reg.nB);
  if (len(nb) < 1e-9) return null;
  const bis = norm(nb),
    m = Math.max(miterLimit, 1) * halfW;
  let best = halfW; // the two radial edges P->P1, P->P2
  const take = (p) => {
    if (dot(p, bis) <= m) best = Math.max(best, len(p));
  };
  for (const p of reg.edgeA) take(p);
  for (const p of reg.edgeB) take(p);
  // and the clip chord itself: where each edge crosses dot(q, bis) = m
  for (const edge of [reg.edgeA, reg.edgeB])
    for (let i = 1; i < edge.length; i++) {
      const a = dot(edge[i - 1], bis) - m,
        b = dot(edge[i], bis) - m;
      if (a === 0 || a < 0 === b < 0) continue;
      const u = a / (a - b);
      best = Math.max(best, len(add(edge[i - 1], mul(sub(edge[i], edge[i - 1]), u))));
    }
  return best / halfW;
}
/**
 * Is `q` (relative to the join vertex) inside the region the RENDERER paints for an arcs join
 * between two curved segments? The union of the two segments' branches of strokeCapsJoinsDash, with
 * the `ourTerritory` drop inactive (the encoder only makes it finite next to a free end), which is
 * the worst case for reach. `rule` selects 'fixed' or 'miterClipClamp'.
 */
export function rendererArcsContains(q, tA, tB, kA, kB, halfW, miterLimit, rule = 'fixed') {
  const ml = Math.max(miterLimit, 1);
  if (len(q) <= halfW) return true; // the radial fall-through both rules keep
  const dA = perpDistToArc(q, tA, kA),
    dB = perpDistToArc(q, tB, kB);
  if (Math.max(dA, dB) > halfW) return false;
  if (rule === 'fixed' && len(q) > halfW * Math.sqrt(ml * ml + 1)) return false; // the cut
  // (own, other): the outgoing segment at its start vertex, then the incoming one at its end vertex
  for (const [own, other] of [
    [mul(tB, -1), tA],
    [tA, mul(tB, -1)],
  ]) {
    const cosBetween = dot(own, other);
    const sinHalf = 0.5 * Math.hypot(own[0] - other[0], own[1] - other[1]); // half the distance between the unit vectors (no absolute floor)
    const cosHalf = Math.sqrt(Math.max(0.5 * (1 + cosBetween), 0));
    const miterLen = halfW / sinHalf,
      fits = miterLen <= halfW * miterLimit;
    const along = dot(q, own);
    if (rule === 'miterClipClamp') {
      if (!fits) continue; // bevels: inside the halfW disc
      if (along >= 0 && along <= miterLen * cosHalf) return true;
      continue;
    }
    if (fits) {
      if (along >= 0 && along <= miterLen * cosHalf) return true;
    } else {
      const tip = add(own, other),
        tl = len(tip);
      if (tl <= 1e-4) return true;
      if (halfW + dot(q, tip) / tl - halfW * ml <= halfW) return true;
    }
  }
  return false;
}
/** The farthest the renderer's arcs region reaches from the vertex, in half-widths. */
export function rendererArcsReach(
  tA,
  tB,
  kA,
  kB,
  halfW,
  miterLimit,
  rule = 'fixed',
  nA = 3000,
  nR = 17,
) {
  let best = 0;
  const band = (t, k) => {
    const pts = [];
    if (Math.abs(k) < 1e-9) {
      const n = perp(t);
      for (let i = 0; i <= nA; i++) {
        const s = ((i / nA) * 2 - 1) * halfW * 400;
        for (let j = 0; j <= nR; j++) pts.push(add(mul(t, s), mul(n, ((j / nR) * 2 - 1) * halfW)));
      }
      return pts;
    }
    const R = 1 / k,
      C = mul(perp(t), R),
      aR = Math.abs(R);
    for (let i = 0; i < nA; i++) {
      const a = (i / nA) * 2 * Math.PI,
        u = [Math.cos(a), Math.sin(a)];
      for (let j = 0; j <= nR; j++) pts.push(add(C, mul(u, aR + ((j / nR) * 2 - 1) * halfW)));
    }
    return pts;
  };
  for (const [t, k] of [
    [tA, kA],
    [tB, kB],
  ])
    for (const q of band(t, k))
      if (len(q) > best && rendererArcsContains(q, tA, tB, kA, kB, halfW, miterLimit, rule))
        best = len(q);
  return best / halfW;
}
