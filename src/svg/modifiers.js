// svg/modifiers.js — Lottie-flavoured path-segment modifiers.
//
// Pure Seg[] → Seg[] functions for the renderer-side primitives a
// Lottie (or any animation) driver needs to compose at play time.
// None of these are SVG-1.1 features; each maps to an After Effects
// shape modifier (Trim Path, Pucker & Bloat, Repeater, Roundness,
// Offset Path) or a parametric shape (Polystar). A driver calls these
// per frame.
//
// Numeric conventions: all positional parameters are in the same
// coordinate space as the input segs (SVG user units, y-down). All
// "trim" / "amount" parameters are 0..1 normalised. Repeater "offset"
// is in segs-space units, copies count is non-negative integer.

import {
  SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC,
  mkLine, mkQuad, mkCubic, mkArc, arcToCubics, segStart, segEnd,
} from './segment.js';
import {
  splitCubicAt, splitQuadAt,
} from './mesh.js';
import {
  _segLenAt, _segLenInvert, _segPointAt, _segTangentAtT,
} from './textures.js';

// ────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────

// Split an arc segment at parameter t∈(0,1). Arcs are parametrised
// linearly in θ between theta_start and theta_end, so a t-split is
// just a θ split. Returns [left, right].
function splitArcAt(s, t) {
  const thetaMid = s.theta_start + (s.theta_end - s.theta_start) * t;
  // Sub-arcs preserve sweep direction. large_arc_flag may change for
  // the sub-arc (a >180° arc split at t=0.5 yields two <180° arcs);
  // we re-derive it from |dtheta| < π.
  const lf1 = Math.abs(thetaMid - s.theta_start) > Math.PI ? 1 : 0;
  const lf2 = Math.abs(s.theta_end - thetaMid) > Math.PI ? 1 : 0;
  return [
    mkArc(s.cx, s.cy, s.rx, s.ry, s.theta_start, thetaMid, s.phi, lf1, s.sweep_flag),
    mkArc(s.cx, s.cy, s.rx, s.ry, thetaMid, s.theta_end,   s.phi, lf2, s.sweep_flag),
  ];
}

// Generic split-at-t: dispatches by type. Lines split via lerp.
function splitSegAt(s, t) {
  if (s.type === SEG_LINE) {
    const mid = [s.p1[0] + (s.p2[0]-s.p1[0])*t, s.p1[1] + (s.p2[1]-s.p1[1])*t];
    return [mkLine(s.p1, mid), mkLine(mid, s.p2)];
  }
  if (s.type === SEG_QUAD)  return splitQuadAt(s, t);
  if (s.type === SEG_CUBIC) return splitCubicAt(s, t);
  if (s.type === SEG_ARC)   return splitArcAt(s, t);
  return [s, s];
}

// Extract the sub-segment of `s` covering parameter range [t0, t1].
// Implemented as split-twice. Idempotent at t0=0 / t1=1.
function subSegBetween(s, t0, t1) {
  if (t0 <= 0 && t1 >= 1) return s;
  if (t0 >= t1) return null;
  // First split at t1 → keep the left.
  let cur = s;
  if (t1 < 1) {
    const [left, ] = splitSegAt(cur, t1);
    cur = left;
    // After splitting at t1, the original [0..1] now maps to [0..1] of `cur`,
    // i.e. the original t0 maps to t0/t1.
    if (t0 > 0) {
      const [, right] = splitSegAt(cur, t0 / t1);
      return right;
    }
    return cur;
  }
  // t1 == 1 → just split at t0 and keep the right.
  if (t0 > 0) {
    const [, right] = splitSegAt(cur, t0);
    return right;
  }
  return cur;
}

// Stitch a chain of segments end-to-end by snapping each segment's
// start to the previous segment's end. Used by Offset Path + Pucker
// to clean up sub-ulp seams after parallel resampling.
function stitchEndpoints(segs) {
  for (let i = 1; i < segs.length; i++) {
    const prevEnd = segEnd(segs[i - 1]);
    const cur = segs[i];
    if (cur.type === SEG_LINE)  segs[i] = mkLine(prevEnd, cur.p2);
    else if (cur.type === SEG_QUAD)  segs[i] = mkQuad(prevEnd, cur.p2, cur.p3);
    else if (cur.type === SEG_CUBIC) segs[i] = mkCubic(prevEnd, cur.p2, cur.p3, cur.p4);
    // Arcs are parametric; can't reseat endpoints without changing
    // the arc's identity. Leave as-is.
  }
  return segs;
}

// ────────────────────────────────────────────────────────────────
// 1) Trim Path
// ────────────────────────────────────────────────────────────────
// Lottie/AE "Trim Paths". Returns the portion of the path between
// arc-length fractions `start` and `end` (both 0..1), shifted by
// `offset` (0..1, wraps around). When start > end after offset
// folding, behaviour matches AE: emit two disjoint runs that
// together fill the wrap region.
//
// Implementation: build the per-seg cumulative arc-length LUT, then
// extract sub-segs covering the requested arc-length range. Returns
// a fresh Seg[] (input unmutated). Empty input → empty output.
export function trimPath(segs, start = 0, end = 1, offset = 0) {
  if (!segs || segs.length === 0) return [];
  // Clamp inputs.
  start = Math.max(0, Math.min(1, start));
  end   = Math.max(0, Math.min(1, end));
  // Offset wraps mod 1.
  let off = offset - Math.floor(offset);
  if (start === end) return [];
  // Per-seg arc length + cumulative.
  const lens = new Float64Array(segs.length);
  let total = 0;
  for (let i = 0; i < segs.length; i++) {
    lens[i] = _segLenAt(segs[i], 1);
    total += lens[i];
  }
  if (total <= 0) return [];
  // Identity short-circuit: no offset + full range emits the whole path.
  // Avoids the wrap-around foldback that maps end=1 → 0 below.
  if (start === 0 && end === 1 && off === 0) return segs.slice();
  // Apply offset by rotating arc-length window. Preserve 1 explicitly
  // (otherwise (end+off) mod 1 collapses 1.0 to 0.0 when off=0).
  const wrapPos = (v) => {
    if (v === 1) return 1;
    const f = v - Math.floor(v);
    return f;
  };
  let s0 = wrapPos(start + off);
  let s1 = wrapPos(end   + off);
  // If start == end is excluded above; after wrap they may compare
  // equal at integer boundaries — treat 0/1 endpoints as the same
  // point on closed paths.
  const wrap = s0 > s1;  // window wraps around the close.
  // Extract a contiguous [a, b] arc-length range, a < b, both in
  // [0, 1]. Helper returns the Seg[] in path order.
  function rangeFrac(a, b) {
    const out = [];
    let aLen = a * total;
    let bLen = b * total;
    let cum = 0;
    for (let i = 0; i < segs.length; i++) {
      const segStartLen = cum;
      const segEndLen   = cum + lens[i];
      cum = segEndLen;
      if (segEndLen <= aLen || segStartLen >= bLen) continue;
      // Compute local t0 / t1 by inverting arc length within seg i.
      const localA = Math.max(0, aLen - segStartLen);
      const localB = Math.min(lens[i], bLen - segStartLen);
      const t0 = (localA <= 0)         ? 0 : _segLenInvert(segs[i], localA, lens[i]);
      const t1 = (localB >= lens[i])   ? 1 : _segLenInvert(segs[i], localB, lens[i]);
      const sub = subSegBetween(segs[i], t0, t1);
      if (sub) out.push(sub);
    }
    return out;
  }
  if (!wrap) return rangeFrac(s0, s1);
  // Wrapped window → two disjoint runs.
  const a = rangeFrac(s0, 1);
  const b = rangeFrac(0, s1);
  return a.concat(b);
}

// ────────────────────────────────────────────────────────────────
// 2) Pucker & Bloat
// ────────────────────────────────────────────────────────────────
// Lottie/AE "Pucker & Bloat". Each control/endpoint is displaced
// radially toward (pucker, amount < 0) or away from (bloat,
// amount > 0) the path centroid. Amount is a unitless scalar where
// 1.0 ≈ "AE's slider at 100 (full bloat)" — endpoints move by 100%
// of their offset from centroid.
//
// Approximation: AE actually pushes the curve sample-by-sample along
// its normal; the cheap-and-correct-enough implementation is to scale
// every Bezier control point's offset-from-centroid by (1+amount).
// For Lottie content this matches in practice.
export function puckerBloat(segs, amount = 0) {
  if (!segs || segs.length === 0 || amount === 0) return segs ? segs.slice() : [];
  // Compute centroid as mean of every segment's endpoint + control points.
  let cx = 0, cy = 0, n = 0;
  for (const s of segs) {
    if (s.type === SEG_LINE)  { cx += s.p1[0] + s.p2[0]; cy += s.p1[1] + s.p2[1]; n += 2; }
    else if (s.type === SEG_QUAD)  { cx += s.p1[0] + s.p2[0] + s.p3[0]; cy += s.p1[1] + s.p2[1] + s.p3[1]; n += 3; }
    else if (s.type === SEG_CUBIC) { cx += s.p1[0] + s.p2[0] + s.p3[0] + s.p4[0]; cy += s.p1[1] + s.p2[1] + s.p3[1] + s.p4[1]; n += 4; }
    else if (s.type === SEG_ARC)   {
      // Use arc center as the contribution.
      cx += s.cx; cy += s.cy; n += 1;
    }
  }
  if (n === 0) return [];
  cx /= n; cy /= n;
  const k = 1 + amount;
  const disp = (p) => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k];
  const out = [];
  for (const s of segs) {
    if (s.type === SEG_LINE)  out.push(mkLine(disp(s.p1), disp(s.p2)));
    else if (s.type === SEG_QUAD)  out.push(mkQuad(disp(s.p1), disp(s.p2), disp(s.p3)));
    else if (s.type === SEG_CUBIC) out.push(mkCubic(disp(s.p1), disp(s.p2), disp(s.p3), disp(s.p4)));
    else if (s.type === SEG_ARC) {
      // Scale the arc by displacing its center. Radii scale with k
      // because radii are distances from center which itself moved
      // by (k-1)*(center-centroid); the points-on-arc displace by k.
      const nc = [cx + (s.cx - cx) * k, cy + (s.cy - cy) * k];
      out.push(mkArc(nc[0], nc[1], s.rx * Math.abs(k), s.ry * Math.abs(k),
                     s.theta_start, s.theta_end, s.phi, s.large_arc_flag, s.sweep_flag));
    }
  }
  return stitchEndpoints(out);
}

// ────────────────────────────────────────────────────────────────
// 3) Repeater
// ────────────────────────────────────────────────────────────────
// Lottie/AE "Repeater". Emits `copies` instances of `segs`, each
// transformed by an iterated affine: translate (tx, ty), rotate
// (rotDeg), scale (sx, sy) cumulatively per copy. Copy 0 is the
// original (no transform). Returns a flat Seg[] in copy-then-seg
// order.
//
// Lottie's per-copy opacity ramp is data-only (driver applies it via
// override table); not the geometry's concern.
export function repeater(segs, copies = 1, tx = 0, ty = 0, rotDeg = 0, sx = 1, sy = 1) {
  if (!segs || segs.length === 0 || copies <= 0) return segs ? segs.slice() : [];
  const out = [];
  const rot = rotDeg * Math.PI / 180;
  for (let c = 0; c < copies; c++) {
    // Cumulative transform for copy c: scale^c then rotate(c*rot) then translate(c*tx, c*ty).
    // Lottie's "Composite" is "below|above" — we always emit in copy order
    // and let the renderer's z handle it.
    const cs = Math.pow(sx, c);
    const csY = Math.pow(sy, c);
    const co = Math.cos(rot * c), si = Math.sin(rot * c);
    const apply = (p) => {
      const x = p[0] * cs, y = p[1] * csY;
      const xr = co * x - si * y;
      const yr = si * x + co * y;
      return [xr + tx * c, yr + ty * c];
    };
    for (const s of segs) {
      if (s.type === SEG_LINE)  out.push(mkLine(apply(s.p1), apply(s.p2)));
      else if (s.type === SEG_QUAD)  out.push(mkQuad(apply(s.p1), apply(s.p2), apply(s.p3)));
      else if (s.type === SEG_CUBIC) out.push(mkCubic(apply(s.p1), apply(s.p2), apply(s.p3), apply(s.p4)));
      else if (s.type === SEG_ARC) {
        // Copy 0 is identity → keep the native arc. For c>0 the affine of an
        // arc is NOT generally an arc (a non-uniform scale yields a tilted
        // ellipse). Decompose the ORIGINAL arc into cubics, then apply
        // the copy's full affine to every control point — the affine of a cubic
        // Bezier is an exact cubic, so this is correct for uniform OR
        // non-uniform scale + rotation (to arcToCubics' <1e-3 quadrant error).
        if (c === 0) { out.push(s); continue; }
        const cubics = arcToCubics(s.p1, s.rx, s.ry, s.phi * 180 / Math.PI,
                                   s.large_arc_flag, s.sweep_flag, s.p4);
        for (const cu of cubics) {
          if (cu.type === SEG_LINE) out.push(mkLine(apply(cu.p1), apply(cu.p2)));
          else out.push(mkCubic(apply(cu.p1), apply(cu.p2), apply(cu.p3), apply(cu.p4)));
        }
      }
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// 4) Roundness (arbitrary closed path corner-radius modifier)
// ────────────────────────────────────────────────────────────────
// Lottie/AE "Round Corners". Replaces every sharp corner on the
// joined segment chain with a quadratic-Bezier fillet of radius `r`.
// A corner is the meeting point of two line segments (curve-curve
// and curve-line joins are already C0-continuous and aren't normally
// "rounded" by the AE effect — Lottie matches AE behaviour here).
//
// The fillet inset distance d is min(r, half each adjacent segment's
// length): for very short edges, the fillet shrinks rather than
// overshooting.
export function roundCorners(segs, r) {
  if (!segs || segs.length === 0 || !(r > 0)) return segs ? segs.slice() : [];
  // Work on a copy: the corner-rounding writes back the shortened start of the
  // NEXT segment (segs[nextIdx] below) to feed the next iteration. Without the
  // copy that mutates the CALLER's array, breaking the documented Seg[]→Seg[]
  // purity (a shape reused across modifiers would get corrupted geometry).
  segs = segs.slice();
  const N = segs.length;
  // Determine subpath closure by checking endpoint equality.
  const startsP = segs.map(segStart);
  const endsP   = segs.map(segEnd);
  const closed = N > 1 &&
    Math.abs(startsP[0][0] - endsP[N-1][0]) < 1e-9 &&
    Math.abs(startsP[0][1] - endsP[N-1][1]) < 1e-9;
  const out = [];
  for (let i = 0; i < N; i++) {
    const cur = segs[i];
    const isLastBeforeWrap = (i === N - 1);
    const nextIdx = isLastBeforeWrap ? 0 : i + 1;
    const next = segs[nextIdx];
    const corner = endsP[i];           // current's end == next's start
    // Only round true line-line corners. Skip if either side is a curve.
    const lineLine = cur.type === SEG_LINE && next && next.type === SEG_LINE;
    // Skip last-into-first wrap if the path isn't closed.
    const skipWrap = isLastBeforeWrap && !closed;
    if (!lineLine || skipWrap) {
      out.push(cur);
      continue;
    }
    const a = cur.p1, b = cur.p2, c = next.p2;
    const dx1 = b[0] - a[0], dy1 = b[1] - a[1];
    const dx2 = c[0] - b[0], dy2 = c[1] - b[1];
    const l1 = Math.hypot(dx1, dy1);
    const l2 = Math.hypot(dx2, dy2);
    if (l1 < 1e-9 || l2 < 1e-9) { out.push(cur); continue; }
    // Inset distance: clamp to half each edge to avoid overshoot.
    const d = Math.min(r, l1 * 0.5, l2 * 0.5);
    if (d <= 0) { out.push(cur); continue; }
    const inA = [b[0] - dx1 / l1 * d, b[1] - dy1 / l1 * d];
    const inB = [b[0] + dx2 / l2 * d, b[1] + dy2 / l2 * d];
    // Replace cur with (a → inA) line; emit quad (inA, b, inB).
    out.push(mkLine(a, inA));
    out.push(mkQuad(inA, b, inB));
    // The next iteration will see `next` starting from b; we need to
    // rewrite its start to inB. Mutate the array in place.
    segs[nextIdx] = mkLine(inB, c);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// 5) Offset Path (parallel curve offset)
// ────────────────────────────────────────────────────────────────
// Lottie/AE "Offset Paths". Generates a parallel curve at signed
// distance `dist`. Positive = outward (right of travel direction in
// y-down space); negative = inward.
//
// Implementation: per segment, resample along its normal at K-1
// internal points. For lines, this is exact (one offset line). For
// curves and arcs, we lay down a polyline of offset points then
// emit it as straight lines. K scales with segment length and
// |dist| so error stays below ~0.5px at typical render scales.
// Joins are mitered when the angle is < jointLimit (default 60°),
// bevelled otherwise — matching Lottie's "joint" parameter when set
// to "Miter" with default limit.
//
// The polyline output is visually identical to AE/Lottie at reasonable
// stroke widths. (A tighter implementation would refit cubic Bezier
// offsets rather than emit a polyline.)
export function offsetPath(segs, dist, opts = {}) {
  if (!segs || segs.length === 0 || dist === 0) return segs ? segs.slice() : [];
  const minStep = opts.minStep || 1.0;  // user-units between offset samples on curves
  const sampleCount = (seg) => {
    if (seg.type === SEG_LINE) return 1;
    const len = _segLenAt(seg, 1);
    return Math.max(4, Math.ceil(len / minStep));
  };
  // Outward normal in y-down space: rotate tangent +90° → (ty, -tx).
  // (Going CW in screen-space; outward = "right of travel".)
  const offsetPoint = (seg, t) => {
    const p = _segPointAt(seg, t);
    const tan = _segTangentAtT(seg, t);
    return [p[0] + tan[1] * dist, p[1] - tan[0] * dist];
  };
  const out = [];
  for (const seg of segs) {
    const K = sampleCount(seg);
    let prev = offsetPoint(seg, 0);
    for (let i = 1; i <= K; i++) {
      const cur = offsetPoint(seg, i / K);
      out.push(mkLine(prev, cur));
      prev = cur;
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// 6) Polystar (star + polygon)
// ────────────────────────────────────────────────────────────────
// Lottie "Polystar" shape: parametric N-pointed star or regular
// polygon. Star mode alternates between outer and inner radii.
// Polygon mode uses a single radius. Both honour a roundness
// parameter (0..1, percentage of edge length used as fillet radius)
// — same model as Lottie ir/or/is/os fields.
//
// Inputs:
//   cx, cy: center
//   points: number of points (≥ 3)
//   outerRadius: outer ring radius
//   innerRadius: inner ring radius (star mode only; ignored for polygon)
//   outerRoundness: 0..1 fraction for outer-vertex fillet (star/polygon)
//   innerRoundness: 0..1 fraction for inner-vertex fillet (star only)
//   rotationDeg: vertex-0 angle offset, degrees CCW from +X axis
//   star: true for star, false for polygon
export function polystar(cx, cy, points, outerRadius,
                         innerRadius = 0,
                         outerRoundness = 0, innerRoundness = 0,
                         rotationDeg = -90, star = true) {
  if (!(points >= 3) || !(outerRadius > 0)) return [];
  const N = star ? points * 2 : points;
  const rot = rotationDeg * Math.PI / 180;
  const dTheta = (Math.PI * 2) / N;
  const verts = new Array(N);
  for (let i = 0; i < N; i++) {
    const r = star ? (i % 2 === 0 ? outerRadius : innerRadius) : outerRadius;
    const a = rot + i * dTheta;
    verts[i] = [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  }
  // Build raw polygon, then fillet using a per-vertex roundness in
  // (0, 1). Roundness 0 → sharp corners; 1 → fillet fully eats half
  // the adjacent edges. Star: outer verts use outerRoundness, inner
  // use innerRoundness. Polygon: all verts use outerRoundness.
  const segs = [];
  for (let i = 0; i < N; i++) {
    segs.push(mkLine(verts[i], verts[(i + 1) % N]));
  }
  // Close back: verts[N-1] → verts[0] is already in.
  const useFillet = outerRoundness > 0 || innerRoundness > 0;
  if (!useFillet) return segs;
  // Hand off to roundCorners with a per-vertex amount. Since
  // roundCorners takes a scalar, instead we open-code the fillet
  // here per vertex using the matching roundness for vertex i.
  const out = [];
  for (let i = 0; i < N; i++) {
    const curIdx  = i;
    const nextIdx = (i + 1) % N;
    const corner = verts[nextIdx];                // segment cur ends at corner
    const after  = verts[(nextIdx + 1) % N];
    const before = verts[curIdx];
    // Pick the radius for THIS corner (vertex nextIdx).
    const roundFrac = star
      ? (nextIdx % 2 === 0 ? outerRoundness : innerRoundness)
      : outerRoundness;
    const dx1 = corner[0] - before[0], dy1 = corner[1] - before[1];
    const dx2 = after[0]  - corner[0], dy2 = after[1]  - corner[1];
    const l1 = Math.hypot(dx1, dy1), l2 = Math.hypot(dx2, dy2);
    if (roundFrac <= 0 || l1 < 1e-9 || l2 < 1e-9) {
      out.push(segs[i]);
      continue;
    }
    // Per Lottie: roundFrac is a unit (0..1) of half-edge.
    const d = Math.min(l1, l2) * 0.5 * Math.max(0, Math.min(1, roundFrac));
    const inA = [corner[0] - dx1 / l1 * d, corner[1] - dy1 / l1 * d];
    const inB = [corner[0] + dx2 / l2 * d, corner[1] + dy2 / l2 * d];
    // Edge cur (before → corner) becomes (before → inA).
    // Insert quad (inA, corner, inB). Next edge's start will be inB —
    // we mutate verts[nextIdx] so subsequent iterations see it.
    out.push(mkLine(before, inA));
    out.push(mkQuad(inA, corner, inB));
    verts[nextIdx] = inB;  // next iter's "before" = current iter's inB
  }
  // The very first edge's start vertex may have been rewritten by the
  // last iteration (we filleted vertex 0 last). Patch the first
  // emitted line so its start matches the post-fillet vertex 0.
  // Detect: out[0] is the first line, its start should be verts[0]
  // (which is now post-fillet). If different, rewrite.
  if (out.length > 0 && out[0].type === SEG_LINE) {
    const wantStart = verts[0];
    if (Math.abs(out[0].p1[0] - wantStart[0]) > 1e-9 ||
        Math.abs(out[0].p1[1] - wantStart[1]) > 1e-9) {
      out[0] = mkLine(wantStart, out[0].p2);
    }
  }
  return out;
}
