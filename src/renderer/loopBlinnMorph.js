// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// GPU-resident Loop-Blinn morph pairs. Build topology once per interval;
// the vertex shader interpolates controls and recomputes implicit frames.
// Decline pairs whose structure or classification cannot be shared.
// Stroke geometry is handled by splitStroke.js.

import {
  buildLoopBlinnPartitionPair,
  buildLoopBlinnMesh,
  refreshLoopBlinnMesh,
} from './loopBlinn.js';
import { pairImplicitDrift, pairMidFlips } from './lbPartitionPair.js';
import * as PAIR9 from './lbPartitionPair.js';
import { cubicInflections } from '../geom/lbCubicMath.js';
import { SEG_CUBIC } from '../primitives/seg.js';
import { mantleDebugHook } from '../core/diagnostics.js';
import { circleFromContours, ellipseFromContours } from '../geom/shapeRecognize.js';

export function buildEarcutPair(srcContours, dstContours, fillRule) {
  if (!srcContours || srcContours.length !== 1 || !dstContours || dstContours.length !== 1)
    return null;
  // Line AA planes do not interpolate as points do, and additive curve rims
  // overlap under translucent paint. General pairs use the partition's mapped
  // outline chains; only the closed-form disc records use this route.
  if (!circleFromContours(srcContours) && !ellipseFromContours(srcContours)) return null;
  let src = null,
    dst = null;
  try {
    src = buildLoopBlinnMesh(srcContours, true, fillRule);
    // Whole-shape circle/ellipse SDF records (kind 7): pair by building the dst
    // mesh independently — record geometry is synthesized (six verts per record
    // on each side, no seg-point provenance needed). The pair VS lerps aC3
    // (center, radius) and aC0 (ry, cosφ, sinφ) linearly, which reproduces the
    // control-point-lerped contour exactly when the two contours are same-PHASE
    // (corresponding on-curve points at matching angles) and, for ellipses,
    // same-φ (cos/sin do not lerp as a rotation). Any mismatch → null, and the
    // partition pair serves the morph as generic crescents + bands instead.
    if (src && src.circles && src.circles.length) {
      let dstC = null;
      try {
        dstC = buildLoopBlinnMesh(dstContours, true, fillRule);
      } catch {
        dstC = null;
      }
      if (!dstC || !dstC.circles || dstC.circles.length !== src.circles.length) return null;
      let cs = src.circles[0],
        cd = dstC.circles[0];
      // A circle pairs with an ellipse as that ellipse with rx = ry = r, at the ellipse's own angle. An ellipse record
      // lerps (center, rx) and (ry, cos phi, sin phi); a circle is the ellipse of equal radii at any angle, so taking the
      // other pose's phi holds cos and sin constant and each in-between pose is the exact ellipse of the lerped radii
      // (the phase check below still has to pass). Declining sent a circle growing into an oval to the partition pair.
      if ((cs.rx != null) !== (cd.rx != null)) {
        const asEllipse9 = (c, phi) => ({ cx: c.cx, cy: c.cy, rx: c.r, ry: c.r, phi });
        if (cs.rx == null) {
          cs = asEllipse9(cs, cd.phi || 0);
          src = { ...src, circles: [cs] };
        } else {
          cd = asEllipse9(cd, cs.phi || 0);
          dstC = { ...dstC, circles: [cd] };
        }
      }
      if (cs.rx != null && Math.abs((cs.phi || 0) - (cd.phi || 0)) > 1e-6) return null;
      const unit9 = (p, c) => {
        let vx = p[0] - c.cx,
          vy = p[1] - c.cy;
        if (c.rx != null) {
          const co = Math.cos(c.phi || 0),
            si = Math.sin(c.phi || 0);
          const qx = (vx * co + vy * si) / Math.max(c.rx, 1e-12);
          const qy = (-vx * si + vy * co) / Math.max(c.ry, 1e-12);
          vx = qx;
          vy = qy;
        }
        const L = Math.hypot(vx, vy);
        return L > 1e-12 ? [vx / L, vy / L] : null;
      };
      const sc9 = srcContours[0],
        dc9 = dstContours[0];
      if (sc9.length !== dc9.length) return null;
      for (let i = 0; i < sc9.length; i++) {
        const us = unit9(sc9[i].p1, cs),
          ud = unit9(dc9[i].p1, cd);
        if (!us || !ud || Math.abs(us[0] - ud[0]) + Math.abs(us[1] - ud[1]) > 2e-3) return null;
      }
      /** @type {typeof src & {_keepOrder9?:boolean}} */ (src)._keepOrder9 = true;
      /** @type {typeof dstC & {_keepOrder9?:boolean}} */ (dstC)._keepOrder9 = true; // a pair keeps the builder's order (see buildLoopBlinnPartitionPair)
      return { src, dst: dstC };
    }
    dst = src ? refreshLoopBlinnMesh(src, dstContours, fillRule) : null;
  } catch {
    return null;
  }
  if (!src || !dst || !src._topo || !dst._topo) return null;
  if (dst._topo.tris !== src._topo.tris) return null; // re-triangulated → correspondence lost
  if (src.fallback.length || dst.fallback.length) return null; // loop/cusp → Slug/partition
  if (src.hasConcave || dst.hasConcave) return null; // the static route's own earcut gate
  if (
    src.quads.length !== dst.quads.length ||
    src.cubics.length !== dst.cubics.length ||
    src.edges.length !== dst.edges.length ||
    src.interior.length !== dst.interior.length
  )
    return null;
  for (const c of src.cubics) if (!c.klmn) return null; // Bezout pieces don't lerp
  for (const c of dst.cubics) if (!c.klmn) return null;
  // No triangle may turn inside out on the way. Everything above checks the two ENDPOINTS agree
  // -- same topology, same counts, no concavity -- and none of it looks at the mesh the vertex
  // shader actually draws at 0 < t < 1, which is a triangulation nobody built. An earcut of pose
  // A, its vertices lerped toward pose B, inverts triangles readily under rotation, and an
  // inverted triangle drops out and leaves a HOLE.

  if (pairMidFlips(src, dst)) return null; // caller falls back and paints right
  src._keepOrder9 = true;
  dst._keepOrder9 = true; // a pair keeps the builder's order (as above)
  return { src, dst };
}

// Lerp two matched contour sets to parameter t (linear control-point interp;
// carries seg type + rquad weight). Because the morph VS lerps positions
// LINEARLY, interpolating the endpoint shapes at an interior t and re-lerping a
// sub-interval reproduces the global lerp exactly — the basis of interval-split.
function lerpContours(sc, dc, t) {
  if (t <= 0) return sc;
  if (t >= 1) return dc;
  const u = 1 - t,
    lp = (a, b) => [a[0] * u + b[0] * t, a[1] * u + b[1] * t];
  return sc.map((cs, ci) =>
    cs.map((ss, si) => {
      const ds = dc[ci][si],
        o = { type: ss.type, p1: lp(ss.p1, ds.p1) };
      if (ss.w != null) o.w = ss.w;
      if (ss.p2) o.p2 = lp(ss.p2, ds.p2);
      if (ss.p3) o.p3 = lp(ss.p3, ds.p3);
      if (ss.p4) o.p4 = lp(ss.p4, ds.p4);
      return o;
    }),
  );
}

const MORPH_SEG_MAX = 6; // > this many classification changes in one morph → Slug
const SEG_MARGIN = 0.04; // bake each interval's sign a margin inside it (see below)

// INTERVAL-SPLIT a classification-CHANGING morph into classification-STABLE
// sub-intervals, each a build-once pair mesh selected + t-remapped at draw
// time. The PARTITION PAIR builder is both the stability oracle and the
// builder: buildLoopBlinnPartitionPair(@a,@b) is non-null iff [a,b] is stable,
// so a coarse scan + bisection locates every flip time, and each flip morph
// becomes t-segmented pair meshes (each sub-interval reproduces the global
// lerp exactly). Each interval's baked sign/topology is taken a small MARGIN
// inside it (build range [tLoB,tHiB]) — the exact flip is a STRAIGHT
// configuration where the sign is ambiguous — while its geometry spans the
// full draw range [tLo,tHi]: the draw remaps t into [tLoB,tHiB] UNCLAMPED, so
// the linear VS lerp EXTRAPOLATES to the exact shape across the seam (no
// frozen frame). The margin is capped at ¼ the interval width so that
// extrapolation stays bounded (localT ∈ [-0.5,1.5]) and never folds the reused
// triangulation. Returns [{tLo,tHi,tLoB,tHiB,pair}] or null (no flips found /
// too many / unstable).
export function segmentPartitionPairMorph(sc, dc, fillRule) {
  // BUILD BUDGET, two-tier: fail FAST on pervasive instability (the failCells
  // early-exit below fires within ~scan-width builds — Slug is reference-
  // exact, so a problematic morph must not buy marginal LB coverage with
  // main-thread time), and keep a hard runaway backstop sized for the
  // legitimate worst case (24-cell scan + MORPH_SEG_MAX bisections at 12
  // steps + per-segment verification).
  let builds9 = 0;
  const BUILD_CAP9 = 24 + MORPH_SEG_MAX * 12 + (MORPH_SEG_MAX + 1) * 3;
  const build = (a, b) => {
    builds9++;
    return buildLoopBlinnPartitionPair(lerpContours(sc, dc, a), lerpContours(sc, dc, b), fillRule, {
      plainDstRows: true,
    });
  };
  const ok = (a, b) => {
    if (builds9 > BUILD_CAP9) return false;
    try {
      return !!build(a, b);
    } catch {
      return false;
    }
  };
  const N = 24,
    flips = [];
  let failCells = 0;
  for (let i = 0; i < N; i++) {
    const a = i / N,
      b = (i + 1) / N;
    if (ok(a, b)) continue;
    // permanently-unservable shapes fail every cell — cap the bisection work
    if (++failCells > MORPH_SEG_MAX || builds9 > BUILD_CAP9) return null;
    let lo = a,
      hi = b;
    for (let k = 0; k < 12; k++) {
      const m = (lo + hi) / 2;
      if (ok(a, m)) lo = m;
      else hi = m;
    }
    const f = (lo + hi) / 2;
    if (!flips.length || f - flips[flips.length - 1] > 0.02) flips.push(f);
  }
  if (builds9 > BUILD_CAP9) return null;
  if (flips.length + 1 > MORPH_SEG_MAX) return null;
  if (!flips.length) return null;
  const bp = [0, ...flips, 1],
    segs = [];
  for (let i = 0; i < bp.length - 1; i++) {
    const tLo = bp[i],
      tHi = bp[i + 1],
      w = tHi - tLo,
      m = Math.min(SEG_MARGIN, w * 0.25);
    //
    // A thousandth of the span is enough to leave the degeneracy and far too little to see: the
    // pair's control points are linear in t, so the draw extrapolates back to the true endpoint
    // exactly. Only the CLASSIFICATION comes from the margin position, which is the point. A wrong
    // classification at an endpoint is easy to miss: the endpoints of a morph are exactly where
    // nothing moves, and a still frame there looks right.
    //
    const tLo0 = i === 0 ? tLo : tLo + m;
    const tHi0 = i === bp.length - 2 ? tHi : tHi - m;
    let pair = null,
      tLoB = tLo0,
      tHiB = tHi0;
    if (tHi0 > tLo0 && builds9 <= BUILD_CAP9) {
      try {
        pair = build(tLo0, tHi0);
      } catch {
        pair = null;
      }
    }
    if (!pair) {
      const mOut = Math.min(1e-3, w * 0.01);
      tLoB = i === 0 ? tLo + mOut : tLo + m;
      tHiB = i === bp.length - 2 ? tHi - mOut : tHi - m;
      if (!(tHiB > tLoB)) return null;
      try {
        pair = build(tLoB, tHiB);
      } catch {
        pair = null;
      }
    }
    const mid = (tLoB + tHiB) / 2;
    if (!pair || !ok(tLoB, mid) || !ok(mid, tHiB)) return null;
    segs.push({ tLo, tHi, tLoB, tHiB, pair });
  }
  return refineByDrift9(segs, build, () => BUILD_CAP9 - builds9);
}

const MORPH_DRIFT_FRAC = 0.002;

/// FINE t-CELLS FOR A MOVING INFLECTION).
///
/// The pair cuts both poses of a cubic at ONE set of parameters, because a Bezier split commutes with the vertex
/// stage's lerp. An inflection is a cut each pose places at its own parameter, so where it moves both are taken and the
/// piece between them bulges to opposite sides of its chord on the two poses: no pair spans that, and every coarse
/// t-cell has the same piece. But mergeCubicPlans9 drops a cut whose piece fits inside one vertex quantum of both
/// poses -- below what either pose's own build can represent -- and a cell short enough that the inflection moves less
/// than a quantum in each of its poses is exactly that case: the cell builds as an ordinary pair, exact at every t in
/// it. So the morph is cut into such cells, each as long as that allows (the largest step, found by bisection, over
/// which every moving inflection's piece stays inside both poses' quanta), and each cell must build and pass the drift
/// oracle or the morph declines.
///
/// The cost is one mesh per cell, as many cells as quanta the inflection travels: `MORPH_CELL_MAX` stops a runaway,
/// and the caller charges the cells' bytes against the per-shape memory budget (buildMorphShape).
export const MORPH_CELL_MAX = 4096;
/// Why segmentMovingInflection returned null, for the caller's decline cause.
export let movingInflectionWhy = null;
/// The cubics whose inflection MOVES between the poses: the same count on both, at different parameters. `null` when
/// some cubic gains or loses one (not this class).
export function movingInflections(sc, dc) {
  const cps = (g) => [g.p1, g.p2, g.p3, g.p4];
  const moving = [];
  for (let ci = 0; ci < sc.length; ci++)
    for (let si = 0; si < sc[ci].length; si++) {
      const a = sc[ci][si],
        b = dc[ci] && dc[ci][si];
      if (a.type !== SEG_CUBIC || !b || b.type !== SEG_CUBIC) continue;
      const iA = cubicInflections(cps(a), true),
        iB = cubicInflections(cps(b), true);
      if (iA.length !== iB.length) return null;
      if (iA.some((v, k) => v !== iB[k])) moving.push({ ci, si });
    }
  return moving;
}
export function segmentMovingInflection(sc, dc, fillRule) {
  movingInflectionWhy = null;
  const cps = (g) => [g.p1, g.p2, g.p3, g.p4];
  const moving = movingInflections(sc, dc);
  if (!moving) {
    movingInflectionWhy = 'inflection-count';
    return null;
  }
  if (!moving.length) {
    movingInflectionWhy = 'no-moving-inflection';
    return null;
  }
  // A cell fits when the pair's own merged cut plan keeps one cut per moving inflection: asked of the plan the builder
  // will use, on the poses it will build (lerpContours), so the answer is the builder's to the last bit.
  const fits = (a, b) => {
    const A = lerpContours(sc, dc, a),
      B = lerpContours(sc, dc, b),
      plans = PAIR9.pairCubicPlans9(A, B);
    for (const m of moving) {
      const ia = cubicInflections(cps(A[m.ci][m.si]), true),
        ib = cubicInflections(cps(B[m.ci][m.si]), true);
      if (ia.length !== ib.length) return false;
      const ts = (plans.get(m.ci + '|' + m.si) || { ts: [] }).ts;
      for (let k = 0; k < ia.length; k++) {
        const u = Math.min(ia[k], ib[k]),
          v = Math.max(ia[k], ib[k]);
        let n = 0;
        for (const t of ts) if (t >= u && t <= v) n++;
        if (n > 1) return false;
      }
    }
    return true;
  };
  const cells = [];
  for (let a = 0; a < 1;) {
    if (cells.length >= MORPH_CELL_MAX) {
      movingInflectionWhy = 'cells';
      return null;
    }
    let b = 1;
    if (!fits(a, 1)) {
      let lo = a,
        hi = 1;
      for (let it = 0; it < 48; it++) {
        const mid = 0.5 * (lo + hi);
        if (mid <= lo || mid >= hi) break;
        if (fits(a, mid)) lo = mid;
        else hi = mid;
      }
      if (!(lo > a)) {
        movingInflectionWhy = 'no-progress';
        return null;
      }
      b = lo;
    }
    cells.push([a, b]);
    a = b;
  }
  const segs = [];
  for (const [a, b] of cells) {
    const A = lerpContours(sc, dc, a),
      B = lerpContours(sc, dc, b);
    let pair = null;
    try {
      pair =
        buildLoopBlinnPartitionPair(A, B, fillRule) ||
        buildLoopBlinnPartitionPair(A, B, fillRule, { plainDstRows: true });
    } catch {
      pair = null;
    }
    if (!pair) {
      movingInflectionWhy = 'cell-declined';
      return null;
    }
    if (pairImplicitDrift(pair.src, pair.dst, 0, 1) > MORPH_DRIFT_FRAC) {
      movingInflectionWhy = 'drift';
      return null;
    }
    segs.push({ tLo: a, tHi: b, tLoB: a, tHiB: b, pair });
  }
  return segs;
}

// Measure sampled implicit drift over the requested pose interval, including
// extrapolation beyond the pair build interval. Options control the normal
// search window and optional implicit-parameter clamp. This diagnostic does
// not prove stable curve classification.
export function tailDrift9(pair, tLo, tHi, tLoB, tHiB, out = null, opts = null) {
  const span = tHiB - tLoB;
  if (!(span > 1e-9) || !pair || !pair.src || !pair.dst) return 0;
  try {
    return pairImplicitDrift(
      pair.src,
      pair.dst,
      (tLo - tLoB) / span,
      (tHi - tLoB) / span,
      out,
      opts,
    );
  } catch {
    return 0;
  }
}

// Subdivide a pair while sampled implicit drift exceeds the configured
// threshold. Return null when the original pair is already below it;
// declined reports excessive drift left by a build or subdivision limit.
// The caller retains the fallback for a declined result.
export function refinePairByDrift(
  sc,
  dc,
  fillRule,
  pair,
  pairOpts = null,
  maxSegs = MORPH_SEG_MAX,
) {
  const bar =
    mantleDebugHook('__LB_MORPH_DRIFT') > 0
      ? mantleDebugHook('__LB_MORPH_DRIFT')
      : MORPH_DRIFT_FRAC;
  let d0 = 0;
  try {
    d0 = pairImplicitDrift(pair.src, pair.dst, 0, 1);
  } catch {
    d0 = 0;
  }
  if (!(d0 > bar)) return null;
  let builds9 = 0;
  const CAP9 = (maxSegs + 1) * 3;
  const build = (a, b) => {
    builds9++;
    return buildLoopBlinnPartitionPair(lerpContours(sc, dc, a), lerpContours(sc, dc, b), fillRule, {
      plainDstRows: true,
      ...(pairOpts || {}),
    });
  };
  const segs = refineByDrift9(
    [{ tLo: 0, tHi: 1, tLoB: 0, tHiB: 1, pair }],
    build,
    () => CAP9 - builds9,
    maxSegs,
  );
  let worst = 0;
  for (const g of segs) {
    let d = 0;
    try {
      d = pairImplicitDrift(g.pair.src, g.pair.dst, 0, 1);
    } catch {
      d = 0;
    }
    if (d > worst) worst = d;
  }
  return { segs, declined: worst > bar };
}

function refineByDrift9(segs, build, left, maxSegs = MORPH_SEG_MAX) {
  if (!segs || !segs.length) return segs;
  const bar =
    mantleDebugHook('__LB_MORPH_DRIFT') > 0
      ? mantleDebugHook('__LB_MORPH_DRIFT')
      : MORPH_DRIFT_FRAC;
  const driftOf = (g) => {
    if (g._drift9 == null) {
      const span = g.tHiB - g.tLoB;
      const uLo = span > 1e-9 ? Math.max(0, (g.tLo - g.tLoB) / span) : 0;
      const uHi = span > 1e-9 ? Math.min(1, (g.tHi - g.tLoB) / span) : 1;
      try {
        g._drift9 = uHi > uLo ? pairImplicitDrift(g.pair.src, g.pair.dst, uLo, uHi) : 0;
      } catch {
        g._drift9 = 0;
      }
    }
    return g._drift9;
  };
  while (segs.length < maxSegs && left() >= 2) {
    let wi = -1,
      worst = bar;
    for (let i = 0; i < segs.length; i++) {
      const d = driftOf(segs[i]);
      if (d > worst) {
        worst = d;
        wi = i;
      }
    }
    if (wi < 0) break;
    const g = segs[wi],
      mid = (g.tLoB + g.tHiB) / 2;
    let a = null,
      b = null;
    try {
      a = build(g.tLoB, mid);
      b = a ? build(mid, g.tHiB) : null;
    } catch {
      a = b = null;
    }
    if (!a || !b) {
      g._drift9 = 0;
      continue;
    } // cannot split this one; leave it and look at the rest
    segs.splice(
      wi,
      1,
      { tLo: g.tLo, tHi: mid, tLoB: g.tLoB, tHiB: mid, pair: a },
      { tLo: mid, tHi: g.tHi, tLoB: mid, tHiB: g.tHiB, pair: b },
    );
  }
  return segs;
}
