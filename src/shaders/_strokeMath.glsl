// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _strokeMath.glsl — analytic stroke-DISTANCE math, shared (spliced via the
// @@STROKE_MATH@@ marker) between the Slug stroke walk and the morph stroke pass.
// The analytic closest-point + caps / joins / dasharray distance field: the closest
// point on a quad in closed form (quadClosestT), on a cubic by the descending chain
// (cubicClosestDescend, the only cubic solver); cap/join logic; dash phase. Requires @@CURVE_ARCLEN@@ (cubicCoeff / evalC / evalCD /
// slugCubicArcLen) included BEFORE this, and the includer to declare
// `uniform sampler2D uDashTex;` (dashOut).

// ---- THE STROKE EDGE RECORD ----------------------------------------------------------------------------
// The walk decides a pixel's coverage from the WINNING feature's boundary, and a distance alone does not say what that
// boundary is: where a cap, a join or a dash end wins, a ramp across the distance is exact only for an
// axis-aligned edge, and at a CORNER, where two boundaries cross the pixel, one straight edge stands in for two. The
// record says what the boundary is, in the space the walk measures (stroke space for a framed row), relative to the
// fragment, as `eP` (n, e, op) and `eQ` (n2, e2, 0): a plane is a unit outward normal n and the fragment's signed
// distance e PAST it (positive outside), the region being {p : n.p + e <= 0} about the fragment.
//   op 0  no boundary to speak of (the fragment on the centerline, or a feature with no normal): the distance's ramp
//   op 1  one plane (n, e)                         op 2  two planes, the region their INTERSECTION (a convex corner)
//   op 3  two planes, the region their UNION (the concave corner inside a join)
//   op 4  a round cap or join: the disc of radius halfW about V = -n (e + halfW), with the stroke's slab BEHIND the
//         plane through V normal to n2 (e2 = the fragment's distance past that plane); the tangent side is exact
//   op 5-8  a circular arc's annulus sector (_coverage.glsl's arc loop says what they hold)
//   op 9  the stroke's SLAB: the side (n, e) and the other side 2 halfW behind it, (-n, -e - 2 halfW) -- a stroke
//         thinner than the pixel box, both of whose sides cross it -- intersected with (n2, e2) where eQ holds a
//         plane (a cap's, a dash end's)
// _coverage.glsl strokeExactCov turns a record into the exact area of the pixel box it bounds.
/// The stroke's side along the line through V with unit direction `t`, on the fragment's side (q = fragment - V):
/// (outward normal, distance past it).
vec3 seSide(vec2 q, vec2 t, float halfW) {
  vec2 pn = vec2(-t.y, t.x);
  float s = dot(q, pn);
  return vec3(s < 0.0 ? -pn : pn, abs(s) - halfW);
}
/// seSide's record, and where the pixel box reaches past the OTHER side too -- a stroke thinner than the box -- both
/// (op 9): one side alone ran the stroke on across the other. `reach` as seAnd's.
vec4 seSlab(vec2 q, vec2 t, float halfW, float reach) {
  vec3 s = seSide(q, t, halfW);
  return vec4(s, -s.z - 2.0 * halfW > -reach ? 9.0 : 1.0);
}
/// A path's signed curvature at a point from its first and second derivatives there, cross / |d1|^3 (the
/// encoder's segEndpointCurvature), taken as cross(d1 / |d1|) / |d1|^2 so no cube leaves float32's range at 2^+-40;
/// 0 where d1 has no length, and where the cross product is under `err`, what float32 makes of it from control points
/// as far off as the derivatives were differenced from: a handle 1e-5 of a straight quad's chord, its three points
/// collinear as stored, would otherwise read a radius of 0.4 halfW from the fragment-relative rounding alone.
float seKappa(vec2 d1, vec2 d2, float err) {
  float l2 = dot(d1, d1);
  float c = d1.x * d2.y - d1.y * d2.x;
  if (!(l2 > 0.0) || abs(c) <= err) return 0.0;
  vec2 t = d1 * inversesqrt(l2);
  return (t.x * d2.y - t.y * d2.x) / l2;
}
/// seKappa's `err` for derivatives differenced from control points no farther than m from the fragment: sixteen float32
/// ulps of m on each difference, times the derivatives' size.
float seKappaErr(float m, vec2 d1, vec2 d2) { return 16.0 * 1.1920929e-7 * m * (length(d1) + length(d2)); }
/// The record INTERSECTED with the half-plane (n, e): the two planes the fragment is farthest past are kept. A plane
/// with no direction is nothing, and so is one the pixel box lies wholly inside: `reach` is how far from the fragment
/// the box reaches (the walk's aaEm), so a plane with e <= -reach cuts nothing. A union or a disc cut by a plane
/// farther out than its own boundary keeps the plane and its primary (the corner a single pixel can hold); one nearer
/// in leaves it as it is.
void seAnd(inout vec4 P, inout vec4 Q, vec2 n, float e, float reach) {
#ifdef MANTLE_STROKE_EXACT
  if (!(dot(n, n) > 0.5) || e <= -reach) return;
  if (P.w == 0.0) { P = vec4(n, e, 1.0); Q = vec4(0.0); }
  else if (P.w == 1.0) {
    if (e > P.z) { Q = vec4(P.xyz, 0.0); P = vec4(n, e, 2.0); } else { Q = vec4(n, e, 0.0); P = vec4(P.xyz, 2.0); }
  } else if (P.w == 2.0) {
    if (e > P.z) { Q = vec4(P.xyz, 0.0); P = vec4(n, e, 2.0); } else if (e > Q.z) Q = vec4(n, e, 0.0);
  } else if (P.w == 9.0) {                                  // a slab keeps its sides, and of the planes cutting it the one
    if (!(dot(Q.xy, Q.xy) > 0.5) || e > Q.z) Q = vec4(n, e, 0.0);   // the fragment is farthest past
  } else if (e > P.z) { Q = vec4(P.xyz, 0.0); P = vec4(n, e, 2.0); }
#endif
}
void seAnd(inout vec4 P, inout vec4 Q, vec3 ne, float reach) { seAnd(P, Q, ne.xy, ne.z, reach); }
/// The record, a single plane (or a bare slab's near side: the corner's union is what the pixel sees of it),
/// UNITED with the half-plane (n, e): the concave corner where a neighbor's side takes over.
/// Only where the neighbor's plane is a faithful picture of it at the fragment: the record is the WINNER's, and the
/// neighbor's own distance is never below the winner's, so a plane that puts the fragment nearer (e < P.z) has run
/// past where the neighbor is -- off its end, or where it curves away -- and unites nothing. Nor does one the pixel box
/// lies wholly outside (e >= reach).
void seOr(inout vec4 P, inout vec4 Q, vec2 n, float e, float reach) {
#ifdef MANTLE_STROKE_EXACT
  if ((P.w == 1.0 || (P.w == 9.0 && !(dot(Q.xy, Q.xy) > 0.5))) && dot(n, n) > 0.5 && e >= P.z && e < reach) {
    Q = vec4(n, e, 0.0); P = vec4(P.xyz, 3.0);
  }
#endif
}
/// A round cap or join at V (q = fragment - V), the stroke's body lying behind the plane through V normal to `u` -- or,
/// with u = 0, a dot: the whole disc. The fragment exactly at V has no normal, and no record.
void seDisc(out vec4 P, out vec4 Q, vec2 q, vec2 u, float halfW) {
#ifdef MANTLE_STROKE_EXACT
  float r = length(q);
  if (r > 0.0) { P = vec4(q / r, r - halfW, 4.0); Q = vec4(u, dot(q, u), 0.0); }
  else { P = vec4(0.0); Q = vec4(0.0); }
#else
  P = vec4(0.0); Q = vec4(0.0);
#endif
}
/// The outward normal of the band perpDistToArc measures (the circle of signed curvature `kappa` tangent to `tan` at
/// the vertex, q relative to it), on the fragment's side: the band's boundary is a circle, and this is its tangent
/// plane's normal at the fragment's foot. No cancellation: at kappa = 0 it is the straight edge's side normal.
vec2 seArcN(vec2 q, vec2 tan, float kappa) {
  vec2 L = vec2(-tan.y, tan.x);
  if (kappa == 0.0) return dot(q, L) < 0.0 ? -L : L;
  vec2 w = kappa * q - L;
  float lw = length(w);
  return lw > 0.0 ? (kappa * dot(q, q) - 2.0 * dot(q, L) < 0.0 ? -w : w) / lw : vec2(0.0);
}

// The dash pattern as a distance. Row 0 of uDashTex: .r=cycleLen .g=patternCount .b=dashOffset; pattern[k] at texel
// 1+k/4, component k%4, dashes the even entries.
//
// Returns (o, side) for path distance `dist`: o the signed path-length distance to the nearest boundary of the DASH SET
// -- negative inside a dash, positive in a gap -- and side +1 when that boundary is a dash's END (going forward leaves
// the dash), -1 when it is a dash's START. The set is the union SVG strokes: a zero-length gap joins its two dashes (no
// boundary between them), and a zero-length dash is a POINT, which `zeroDashEmpty` (both caps butt) says is nothing at
// all -- SVG draws no butt cap on a zero-length subpath, and a round or square one as a dot.

// It is not an in/out answer at the pixel's center: that would make a dash end a binary cut across the stroke, the one
// edge of a stroke with no AA -- a pixel it halves reading 0 or 1 by the rounding of its center -- and every dash end a butt
// cap whatever stroke-linecap says. strokeDashDist below turns o into the dash's SDF with its own cap.
// Authored dash units expressed in the current stroke coordinate system.

// The dash table's capacity, 15 texels of 4 (svg/bundleFinalize.js). The walks break on the row's own count.
const int DASH_MAX_ENTRIES = 60;
float strokeDashScale = 1.0;
float strokeDashCycleG = 0.0, strokeDashOnG = 0.0;   // the pattern dashOut last read: its cycle, and the length of it that is dash
float dashValue(int row, int k) {
  vec4 texel = texelFetch(uDashTex, dashAt(1 + (k >> 2), row), 0);
  int c = k & 3;
  return (c == 0) ? texel.x : (c == 1) ? texel.y : (c == 2) ? texel.z : texel.w;
}
// ---- THE SEAM OF A CLOSED DASHED CONTOUR ----------------------------------------------------------------------------------------
// A closed subpath has no caps. Dashed, the pattern runs on through its start/end seam: a dash that is on at both the end and the start is
// ONE dash, with one join at the seam vertex; a dash that is on at only one of them starts or ends there like any dash, with its cap; and where
// neither is on the vertex is in a gap. The first segment of the contour sees only the pattern from its own start, and the last only up to its
// own end, so each needs the contour's length L to know what the other sees. The encoder (svg/textures.js encodeSeg) writes it as -L in the
// free-end header field on the two segments that meet at the seam -- first: the start field, last: the end field -- which every `> 0.5` test
// still reads as joined. strokeSeamSet reads them; strokeSeamResolve then decides, per segment, whether the seam end is
//   merged  (on at both ends: the dash passes through it, so the START boundary at this end of the first segment and the END boundary at this
//            end of the last are not boundaries, and the vertex keeps its join), or
//   free    (otherwise: the end is the end of the dashes on its own side, so it is a FREE end, a cap where a dash is on and nothing where it is not --
//            exactly an open path's end, whose machinery already does it).
// "On at the end" includes a dash that ENDS exactly there, and "on at the start" one that STARTS exactly there, so the two meet. Everything is
// relative to L, the offset and the cycle: no absolute length.
float strokeSeamL = 0.0;                              // the contour's length when this segment starts or ends a closed dashed contour, else 0
bool strokeSeamFirst = false, strokeSeamLast = false; // ...and which end of it this segment is
bool strokeSeamMergeLo = false, strokeSeamMergeHi = false;   // resolved: the dash passes through this segment's start / end
float strokeSeamTol = 0.0;                            // how close to a pattern boundary a position is taken to BE on it (float32's own noise at L)
void strokeSeamSet(float hy, float hz) {
  strokeSeamFirst = hy < 0.0;
  strokeSeamLast = hz < 0.0;
  strokeSeamL = strokeSeamFirst ? -hy : (strokeSeamLast ? -hz : 0.0);
  strokeSeamMergeLo = false;
  strokeSeamMergeHi = false;
  strokeSeamTol = 0.0;
}
/// Is the pattern's dash set on just AFTER the pattern position d (in [0, cycleLen)), or just BEFORE it? A position within `tol` of a boundary is
/// taken to be that boundary; the dashes are closed on the side they extend to, [start, end) after and (start, end] before.
bool strokeSeamOn(int row, int count, float cycleLen, float d, bool after, float tol) {
  if (after) { if (d >= cycleLen - tol) d -= cycleLen; }
  else if (d <= tol) d += cycleLen;
  float accum = 0.0;
  bool on = false;
  for (int k = 0; k < DASH_MAX_ENTRIES; k++) {
    if (k >= count) break;
    float v = dashValue(row, k) * strokeDashScale;
    if ((k & 1) == 0 && v > 0.0) {
      if (after ? (d >= accum - tol && d < accum + v - tol) : (d > accum + tol && d <= accum + v + tol)) on = true;
    }
    accum += v;
  }
  return on;
}
/// Resolve this segment's seam end(s) (strokeSeamSet has read them) against the pattern: freeStart / freeEnd become true where the seam end is
/// the end of a dash on its own side, strokeSeamMergeLo / Hi where the dash passes through it. `seR` is the pixel box's reach, to leave a
/// pattern finer than the pixel (which has no edges, so no seam) alone.
void strokeSeamResolve(int dashId, float seR, inout bool freeStart, inout bool freeEnd) {
  if (dashId <= 0 || !(strokeSeamL > 0.0)) return;
  int row = dashId - 1;
  vec4 hdr = texelFetch(uDashTex, dashAt(DASH_HDR, row), 0);
  float cycleLen = hdr.r * strokeDashScale;
  int   count    = int(hdr.g + 0.5);
  float offset   = hdr.b * strokeDashScale;
  if (cycleLen <= 0.0 || count <= 0 || 2.0 * cycleLen < 1.41421356 * seR) return;
  strokeSeamTol = min(2.4e-6 * (strokeSeamL + abs(offset) + cycleLen), 1e-3 * cycleLen);
  bool onStart = strokeSeamOn(row, count, cycleLen, mod(offset, cycleLen), true, 0.0);
  bool onEnd = strokeSeamOn(row, count, cycleLen, mod(strokeSeamL + offset, cycleLen), false, strokeSeamTol);
  bool merged = onStart && onEnd;
  if (strokeSeamFirst) { if (merged) strokeSeamMergeLo = true; else freeStart = true; }
  if (strokeSeamLast) { if (merged) strokeSeamMergeHi = true; else freeEnd = true; }
}
/// One boundary at pattern position b (type -1 START, +1 END, 0 a zero-length dash), both of its images nearest `ds`
/// (ahead and behind; ds is `dist` clamped onto the subpath, d its pattern position), kept when on the subpath: the
/// nearest to `dist` so far in `best`, (distance, side, 1 for a zero-length dash), and the next nearest's distance in
/// `best2` (the coverage's edge record reads those two; the distance does not).
void dashBoundary(float b, float type, float d, float ds, float dist, float cycleLen, float sLo, float sHi, inout vec3 best,
                  inout float best2) {
  float f = b - d;
  if (f < 0.0) f += cycleLen;
  for (int r = 0; r < 2; r++) {
    float sb = ds + (r == 0 ? f : f - cycleLen);
    float delta = sb - dist;
    float side = type != 0.0 ? type : (delta >= 0.0 ? -1.0 : 1.0);
    bool onPath = type == 0.0 ? (sb >= sLo && sb <= sHi)
                : side < 0.0  ? (sb >= sLo && sb < sHi) : (sb > sLo && sb <= sHi);
    // a closed contour's seam the dash passes through has no boundary: not the START at the first segment's start, nor the END at the last one's end
    // ...and a dash that would START at the seam's end, or END at its start, has no length: nothing (float32 puts a boundary exactly there a hair inside)
    if (onPath && type != 0.0 && ((strokeSeamMergeLo && side < 0.0 && sb <= sLo + strokeSeamTol) || (strokeSeamMergeHi && side > 0.0 && sb >= sHi - strokeSeamTol)
        || (strokeSeamLast && side < 0.0 && sb >= sHi - strokeSeamTol) || (strokeSeamFirst && side > 0.0 && sb <= sLo + strokeSeamTol))) onPath = false;
    if (onPath) {
      if (abs(delta) < best.x) { best2 = best.x; best = vec3(abs(delta), side, type == 0.0 ? 1.0 : 0.0); }
      else if (abs(delta) < best2) best2 = abs(delta);
    }
  }
}
/// How far a dash CAP can reach a path distance `dist` from the dash ends around it, ignoring where the path itself
/// ends: (the path distance back to the nearest dash END at or before `dist`, forward to the nearest dash START at or
/// after it), 1e30 where the pattern has none. A dash's square or round cap extends past its end whatever the path does
/// there -- round a corner, say -- so the pieces strokeDashDist sees (the ones this segment's own span holds) are not all
/// of it. A zero-length dash is both a start and an end; `zeroDashEmpty` as dashOut's.
vec2 dashCapReach(int dashId, float dist, bool zeroDashEmpty) {
  vec2 r = vec2(1e30);
  if (dashId <= 0) return r;
  int row = dashId - 1;
  vec4 hdr = texelFetch(uDashTex, dashAt(DASH_HDR, row), 0);
  float cycleLen = hdr.r * strokeDashScale;
  int   count    = int(hdr.g + 0.5);
  float offset   = hdr.b * strokeDashScale;
  if (cycleLen <= 0.0 || count <= 0) return r;
  float d = mod(dist + offset, cycleLen);
  float accum = 0.0;
  for (int k = 0; k < DASH_MAX_ENTRIES; k++) {
    if (k >= count) break;
    float v = dashValue(row, k) * strokeDashScale;
    if ((k & 1) == 0 && (v > 0.0 || !zeroDashEmpty)) {
      float behind = mod(d - (accum + v), cycleLen);   // back from the pixel to this dash's end
      float ahead = mod(accum - d, cycleLen);          // forward to this dash's start
      r = vec2(min(r.x, behind), min(r.y, ahead));
    }
    accum += v;
  }
  return r;
}
/// `more` hands the coverage's edge record what the distance does not need: the next-nearest boundary's distance,
/// and 1 when the nearest is a zero-length dash (a dot).
vec2 dashOut(int dashId, float dist, bool zeroDashEmpty, float sLo, float sHi, out vec2 more) {
  more = vec2(1e30, 0.0);
  if (dashId <= 0) return vec2(-1e30, 0.0);
  int row = dashId - 1;
  vec4 hdr = texelFetch(uDashTex, dashAt(DASH_HDR, row), 0);
  float cycleLen = hdr.r * strokeDashScale;
  int   count    = int(hdr.g + 0.5);
  float offset   = hdr.b * strokeDashScale;
  if (cycleLen <= 0.0 || count <= 0) return vec2(-1e30, 0.0);
  float ds = clamp(dist, sLo, sHi);   // past a segment's end the dash state is the vertex's: a join is painted by the dash that covers the vertex
  float d = mod(ds + offset, cycleLen);
  float accum = 0.0;
  vec3 best = vec3(1e30, 0.0, 0.0);
  float best2 = 1e30;
  int firstCov = -1, prevCov = -1;
  bool inside = false;
  strokeDashCycleG = cycleLen;
  strokeDashOnG = 0.0;
  for (int k = 0; k < DASH_MAX_ENTRIES; k++) {
    if (k >= count) break;
    float v = dashValue(row, k) * strokeDashScale;
    int cov = (k & 1) == 0 ? 1 : 0;
    if (cov == 1) strokeDashOnG += v;
    if (v > 0.0) {
      if (d >= accum && d < accum + v) inside = cov == 1;
      if (firstCov < 0) firstCov = cov;
      // coverage changes at accum: entering a dash is its START, leaving one its END
      if (prevCov >= 0 && prevCov != cov) dashBoundary(accum, cov == 1 ? -1.0 : 1.0, d, ds, dist, cycleLen, sLo, sHi, best, best2);
      prevCov = cov;
    } else if (cov == 1 && !zeroDashEmpty) {
      dashBoundary(accum, 0.0, d, ds, dist, cycleLen, sLo, sHi, best, best2);
    }
    accum += v;
  }
  // the cycle's own seam, between its last and first positive entries
  if (firstCov >= 0 && prevCov != firstCov) dashBoundary(0.0, firstCov == 1 ? -1.0 : 1.0, d, ds, dist, cycleLen, sLo, sHi, best, best2);
  // At the END of a closed contour the state is the one just before it, not the one just after (which is the start's: a dash that starts exactly there)
  if (strokeSeamLast && ds >= sHi) inside = strokeSeamOn(row, count, cycleLen, d, false, strokeSeamTol);
  more = vec2(best2, best.z);
  if (best.x >= 1e30) return vec2(inside ? -1e30 : 1e30, 0.0);
  return vec2(inside ? -best.x : best.x, best.y);
}

///
/// The edge record: a butt or square dash end is its plane, intersected with what the record held (the side,
/// so a dash end's corner is two planes); a round one is the disc about the dash's end point with the dash's slab behind
/// it -- where the body gave the lateral direction that locates the end point (fragment = end + thisD g + o gp).
float strokeDashDist(float thisD, inout vec2 g, vec2 tanT, float halfW, int dashId, float pathDist,
                     int startCap, int endCap, float sLo, float sHi, float seR, inout vec4 eP, inout vec4 eQ) {
  vec2 more;
  vec2 os = dashOut(dashId, pathDist, startCap == 0 && endCap == 0, sLo, sHi, more);
  // A PATTERN FINER THAN THE PIXEL has no edges to ramp across: every pixel sits within half a cycle of one and read 1/2
  // whatever the duty. Its coverage is the share of the cycle that is dash -- the caps' reach added, which closes the
  // gaps altogether once it covers them. The share is a ramp's value at an offset, carried in the distance.
  float pxSz = 1.41421356 * seR;
  if (strokeDashCycleG > 0.0 && 2.0 * strokeDashCycleG < pxSz) {
    float onLen = strokeDashOnG + ((startCap != 0 ? halfW : 0.0) + (endCap != 0 ? halfW : 0.0));
    float duty = clamp(onLen / strokeDashCycleG, 0.0, 1.0);
    if (duty >= 1.0) return thisD;
    eP = vec4(0.0); eQ = vec4(0.0); g = vec2(0.0);
    return max(thisD, halfW + pxSz * (0.5 - duty));
  }
  float o = os.x;
  if (o <= -1e29) return thisD;
  vec2 gp = os.y * tanT;
  int cap = os.y < 0.0 ? startCap : endCap;
  if (cap == 1) {
    // The dash end's disc -- a dot's whole disc -- where the pixel box reaches it (deep inside a dash its end is nothing
    // to this pixel). Where the box reaches ANOTHER dash end too -- a gap or a dash shorter than the width, so two ends'
    // discs share the pixel -- their union is not this record, and the distance's ramp keeps it.
    if (o < 1e29 && o > -seR && dot(g, g) > 0.5) {
      if (more.x >= halfW + seR) seDisc(eP, eQ, thisD * g + o * gp, more.y > 0.5 ? vec2(0.0) : gp, halfW);
      else { eP = vec4(0.0); eQ = vec4(0.0); }
    } else if (o > 0.0) {
      // The dash end's disc is not the record the body or a cap left (no gradient: a pixel on the centerline, or one a
      // cap or join won): in a gap its distance is raised below, and that record would paint the cap in the gap.
      eP = vec4(0.0); eQ = vec4(0.0);
    }
    if (o > 0.0) {
      float r = length(vec2(thisD, o));
      g = (dot(g, g) > 0.5 && r > 0.0) ? (thisD * g + o * gp) / r : vec2(0.0);
      thisD = r;
    }
  } else {
    float r = cap == 2 ? o : halfW + o;
    seAnd(eP, eQ, gp, r - halfW, seR);
    if (r > thisD) { thisD = r; g = gp; }
  }
  return thisD;
}

// Perpendicular distance from q (RELATIVE to the join vertex) to an edge's
// extended centerline arc: the osculating circle of signed curvature `kappa`
// tangent to `tan` at the vertex. The ±halfW band around this arc is the SVG2
// `arcs`-join extended stroke; this reduces to the miter's perpendicular-to-tangent-line
// when kappa == 0, bit for bit (the miter-clip branch relies on it).
//
// NO THRESHOLD, AT ANY CURVATURE. The distance is | |q − R·L| − |R| | with R = 1/kappa,
// and written that way it subtracts two numbers of size |R| to get one of size |q|: float32
// loses ~|R|·2^-24 of it, which is most of it once kappa·|q| is small. A threshold such as
// `abs(kappa) < 1e-6 → straight` would guard against that cancellation, but 1e-6 PER EM is a
// statement about the drawing's units: at 2^20 every edge of radius under ~1e6 em -- a unit
// circle -- would take the straight branch, so an arcs join on large-coordinate art would draw as
// miter-clip, and at scale 1 a gentle curve just over the cut would lose several percent of |q|.
// Multiplying through by |kappa| (|q − R·L|² − R² = |q|² − 2R q·L, and |kappa|·|R| = 1):
//   d = |kappa·|q|² − 2 q·L| / (|kappa·q − L| + 1),
// which has no cancellation but the inherent one at the circle itself, is homogeneous of degree 1
// in the coordinates (kappa scales as 1/length), and is continuous through kappa = 0, where it is
// |q·L|. The exact-zero branch only keeps straight edges bit-identical to the miter.
float perpDistToArc(vec2 q, vec2 tan, float kappa) {
  vec2 L = vec2(-tan.y, tan.x);                 // left normal
  if (kappa == 0.0) return abs(dot(q, L));      // straight edge → tangent line
  return abs(kappa * dot(q, q) - 2.0 * dot(q, L)) / (length(kappa * q - L) + 1.0);
}


float strokeArcsReachFactor(float miterLimit) {
  float ml = max(miterLimit, 1.0);
  return sqrt(ml * ml + 1.0);
}


vec2 strokeUnit(vec2 d) { float l = length(d); return l > 0.0 ? d / l : d; }
/// Whether END `e` of a segment must be evaluated as an extra candidate beside the segment's own closest point, which lies
/// strictly INSIDE the segment (the caller tests that). That closest point is at most as far as the end (the end is on the
/// segment), and the end's own shape can only keep that distance or raise it unless it reaches past the tube of radius halfW
/// round the skeleton: a round cap or join is a disc inside it, a bevel a triangle inside it, a butt end a slab. Only a square
/// cap's corners and a miter's, miter-clip's or arcs join's tip are nearer. Two things break the argument and evaluate
/// every end: a dash (a cap spills round a vertex), and a free BUTT end anywhere on the segment -- it raises the distance of a pixel
/// beyond its plane, so a disc elsewhere can be nearer than the raised closest point. (A closest point AT an end is not covered:
/// that end's join wedge raises it, and the other end's disc can then paint a pixel the raised distance loses -- the
/// near-closed arc with a bevel join, test/strokeEndCandidateGpuSmoke.mjs.)
bool strokeEndCandidate(bool freeStart, bool freeEnd, int startCap, int endCap, int joinStyle, int dashId, int e) {
  if (dashId > 0 || (freeStart && startCap == 0) || (freeEnd && endCap == 0)) return true;
  bool joined = joinStyle != 1 && joinStyle != 2;
  return e == 0 ? (freeStart ? startCap == 2 : joined) : (freeEnd ? endCap == 2 : joined);
}

// Cap / join / dasharray distance modifier at a segment's endpoints. `t` is the
// closest-point param, `thisD` the closest-point distance; pStart/pEnd/dStart/
// dEnd are the endpoints + derivatives RELATIVE to the query point. inTan/outTan
// are the neighbor tangents (joins); free* gates caps-vs-joins. butt drops; square extends halfW; miter fills the wedge to the
// miter point and BEVELS past miterLimit·halfW; miter-clip fills the same wedge and past the limit
// CLIPS it at the line perpendicular to the bisector miterLimit·halfW from the vertex; arcs
// (joinStyle 4) extends each edge as an arc of its centerline curvature
// (`curv` = kSelfStart,kSelfEnd,kPrevEnd,kNextStart) and clips the same way. `gradIO` is the
// caller's boundary normal, zeroed when an end plane takes over the distance.
// Returns the (possibly dropped) min distance.
float strokeCapsJoinsDash(
    float t, float thisD, vec2 pStart, vec2 pEnd, vec2 dStart, vec2 dEnd,
    bool freeStart, bool freeEnd, int startCap, int endCap,
    int joinStyle, float miterLimit, float halfW,
    vec2 inTan, vec2 outTan,
    int dashId, float startDist, float arcLenAtT, vec4 curv, float minDIn,
    inout vec2 gradIO, vec2 tanT, float dashEnd, float seR, out vec4 eP, out vec4 eQ) {
  bool drop = false;
  bool roundEnd = false;                         // a free round end cap won: thisD is radial from the endpoint
  vec2 latV = vec2(0.0);                         // ...and the fragment's vector to the end tangent line's foot
  // The edge record: the body's own boundary to start with -- the offset curve's tangent
  // plane at the closest point -- and every cap, join and dash branch below says what its boundary is. The distance
  // (thisD) is untouched by it: the record only tells the coverage what the winner's edge looks like.
  // A stroke thinner than the pixel box has both offsets' tangent planes cross it: the slab (op 9).
  eP = (dot(gradIO, gradIO) > 0.5) ? vec4(gradIO, thisD - halfW, -thisD - halfW > -seR ? 9.0 : 1.0) : vec4(0.0);
  eQ = vec4(0.0);
  // One copy for both ends. Separate start and end branches would mirror each other exactly, and a SIMD
  // group holding pixels near both ends of one segment would run both; the end at hand is named once and the rules run
  // once, on these names:
  //   ep    the endpoint (relative to the fragment; the fragment relative to it is -ep)
  //   tOwn  this segment's path direction there, uOwn its OUTWARD direction (-tOwn at the start, tOwn at the end)
  //   tOth  the neighbor's path direction there (inTan / outTan), uOth its outward one from the vertex
  //   din, dout  the directions INTO and OUT OF the vertex along the path (the join's turn is cross(din, dout))
  //   outWedge   the fragment lies outside the join's wedge, where this end is a butt end
  // Each expression is the one a per-end branch would evaluate, operand for operand, so the result is bit for bit what
  // two branches would compute.
  if (t < 1e-4 || t > 1.0 - 1e-4) {
    bool atS = t < 1e-4;
    vec2 ep = atS ? pStart : pEnd;
    vec2 tOwn = strokeUnit(atS ? dStart : dEnd);
    vec2 uOwn = atS ? -tOwn : tOwn;
    vec2 tOth = atS ? inTan : outTan;
    vec2 uOth = atS ? inTan : -outTan;
    vec2 din = atS ? inTan : tOwn, dout = atS ? tOwn : outTan;
    bool freeV = atS ? freeStart : freeEnd;
    int capV = atS ? startCap : endCap;
    float kOwn = atS ? curv.x : curv.y, kOth = atS ? curv.z : curv.w;   // this segment's and the neighbor's κ there
    bool outWedge = atS ? dot(-ep, inTan) < 0.0 : dot(-ep, outTan) > 0.0;
    if (freeV) {
      // a butt or square cap is the slab cut by its plane (two planes at the corner); a round one is the disc
      eP = seSlab(-ep, tOwn, halfW, seR); eQ = vec4(0.0);
      float aR = dot(-ep, uOwn);
      roundEnd = capV == 1;
      if (roundEnd) latV = ep - tOwn * dot(ep, tOwn);
      if (capV == 0) seAnd(eP, eQ, uOwn, aR, seR);
      else if (capV == 2) { if (aR >= 0.0) seAnd(eP, eQ, uOwn, aR - halfW, seR); }
      else seDisc(eP, eQ, -ep, uOwn, halfW);
      if (capV == 0) {
        // BUTT CAP AS AN SDF, NOT A HARD DROP. Dropping makes the cap plane a
        // binary edge: the pixel the plane bisects gets all or nothing, where the
        // truth is a partial. The capped stroke is the INTERSECTION of the tube
        // and the half-space behind the plane, so its SDF is
        //   max(dist - halfW, aOut)   ==>   dist_eff = max(dist, halfW + aOut)
        // which is the same idiom the bevel branch below already uses. aOut is
        // how far the pixel lies BEYOND the plane (positive = outside), so a
        // pixel one unit inside reports distance halfW-1 and ramps correctly.
        float aOut = dot(-ep, uOwn);
        thisD = max(thisD, halfW + aOut);
      }
      else if (capV == 2) {
                //
        float a = dot(-ep, uOwn);
        if (a >= 0.0) { float perp = length(-ep - uOwn * a); thisD = min(thisD, max(perp, a)); }
      }
    } else if ((joinStyle == 0 || joinStyle == 3 || joinStyle == 4) && outWedge) {
      // THE JOIN WEDGE, and it is the LINE branch's rule verbatim (_coverage.glsl's
      // `ourTerritory`). SVG 2 builds a stroke from each segment's swept perpendicular plus, at
      // every join, a join shape that lies entirely in the WEDGE between the two segments'
      // perpendiculars. Outside that wedge this end is a BUTT end: the tube cut by its own end
      // plane, the same SDF the butt cap above uses. The half-disc it keeps -- length(q) <= halfW
      // AND q in front of this segment's own end plane -- is inside this segment's body, because
      // a point in front of the end plane whose closest point on the curve were the end would have
      // dot(q, tangent) <= 0. So this can only paint what SVG 2 already contains. A hard drop
      // reaches the same membership but loses the ramp across the plane.
      // The plane is a boundary only AHEAD of it. Behind it the fragment is inside this segment's body and, outside the wedge,
      // inside the neighbor's too (its plane is behind the fragment); the union is no thinner than the tube there, and a plane
      // term would read a fragment a hair behind the vertex as on the edge: half coverage at the join vertex of a long curve
      // (the end gate t < 1e-4 is 1e-4 of the segment long, so the zone grows with it).
      float aJ = dot(-ep, uOwn);
      if (aJ > 0.0) thisD = max(thisD, halfW + aJ);
      eP = seSlab(-ep, tOwn, halfW, seR); eQ = vec4(0.0);   // the butt end: its side (or slab) and its plane
      if (aJ > 0.0) seAnd(eP, eQ, uOwn, aJ, seR);
    } else if (joinStyle == 0 || joinStyle == 3) {
      float c = dot(uOwn, uOth);
      // Miter length is halfW/sin(theta/2). `c` is the cosine of the INTERIOR
      // angle between the two segments, so the half-angle identity is
      // sin(theta/2) = sqrt((1 - c)/2); the (1 + c) form gives cos(theta/2) and is
      // inverted (too short at sharp corners, unbounded at flat ones — it diverges
      // at theta=180 where the true miter is exactly halfW). See _coverage.glsl.
      // sin(theta/2) of the interior angle is HALF THE DISTANCE between the two unit vectors that bound it (|u - v| = 2 sin(theta/2)). The
      // identity sqrt((1 - cos)/2) subtracts two numbers that agree to float32 resolution near a reversal (1 - c is 0 or 6e-8 for any
      // turn within 0.02 degrees of one), and floors such as 1e-9 / 1e-6 under it would be ABSOLUTE bounds on an angle: the miter
      // ratio 1/sin(theta/2) would saturate at 3.2e4 half-widths, so a limit above that would paint a spike the spec bevels. The difference of the
      // unit vectors is exact at the scale of the vectors, so the ratio is right down to the resolution of the directions themselves,
      // and an exact reversal (sin = 0) is an infinite ratio: it exceeds every finite limit and bevels. The 1.17549435e-38 under the division is the smallest
      // NORMAL float (a guard against dividing by zero, not a tolerance: no sin(theta/2) the directions can express is near it).
      float sinHalf = 0.5 * length(uOwn - uOth);
      float miterLen = halfW / max(sinHalf, 1.17549435e-38);
      float maxMiter = halfW * miterLimit;
      float mlClip = halfW * max(miterLimit, 1.0);   // SVG 2 makes a limit under 1 an error
      bool fits = miterLen <= maxMiter;
      vec2 along = uOwn;
      float a = dot(-ep, along);
      // `a` measures ALONG THE TANGENT; miterLen is the distance to the apex
      // along the BISECTOR. Bounding one by the other over-extends every
      // shallow join. Project: alongMax = miterLen*cos(theta/2)
      // = halfW/tan(theta/2) — 0 when collinear (apex is straight out to the
      // side), halfW at a right angle, divergent at a spike (held by maxMiter).
      float cosHalfJ = sqrt(max(0.5 * (1.0 + c), 0.0));
      float perpThis  = length(-ep - along * a);
      vec2  nOth      = vec2(-tOth.y, tOth.x);
      float perpOther = abs(dot(-ep, nOth));
      // the record: the two outer sides, which meet at the miter's tip (a bevel's chord or the clip line cuts it below)
      eP = vec4(0.0); eQ = vec4(0.0);
      seAnd(eP, eQ, seSide(-ep, tOwn, halfW), seR); seAnd(eP, eQ, seSide(-ep, tOth, halfW), seR);
      // A MITER PAST ITS LIMIT IS A BEVEL (SVG 2: "Return bevel"), not the round shoulder the
      // radial distance leaves standing, as in the LINE branch: thisD at a join vertex IS the
      // radial distance, so without raising it here every over-limit curve miter would draw a
      // full halfW disc where SVG 2 draws the bevel triangle.
      if (joinStyle == 0 && !fits) {
        float cr = din.x * dout.y - din.y * dout.x;
        float sd = (cr >= 0.0) ? 1.0 : -1.0;
        vec2 nA = sd * vec2(din.y, -din.x), nB = sd * vec2(dout.y, -dout.x);
        vec2 nb = nA + nB; float bl = length(nb);
        if (bl > 1e-4) { vec2 bis = nb / bl; seAnd(eP, eQ, bis, dot(-ep, bis) - halfW * dot(nA, bis), seR);
          thisD = max(thisD, halfW + dot(-ep, bis) - halfW * dot(nA, bis)); }
        else { seAnd(eP, eQ, uOwn, dot(-ep, uOwn), seR); thisD = max(thisD, halfW + dot(-ep, uOwn)); }   // an exact reversal: a bevel of no area, a butt end
      }
      float capAlong = fits ? miterLen * cosHalfJ : 0.0;
      if (a >= 0.0 && a <= capAlong) {
        thisD = min(thisD, max(perpThis, perpOther));
      } else if (joinStyle == 3 && !fits) {
        // CLIPPED MITER, past the limit. SVG 2: "clip any part of the line join region that
        // extends past the miter limit" — the line PERPENDICULAR TO THE BISECTOR at
        // halfW * miterLimit from the vertex. Capping the ALONG-TANGENT extent instead (as
        // min(miterLen, maxMiter) then alongMax would) cuts the kite square across the tangent,
        // not square to the bisector: a different quadrilateral, and a shorter one, since the
        // clamped miterLen would also be projected by cos(theta/2) a second time. Same form as the line
        // branch in _coverage.glsl; tipDir = din - dout (the two outward directions at the
        // vertex) survives a near-reversal, where nA + nB cancels.
        vec2 tipDir = din - dout;
        float tipLen = length(tipDir);
        float dClip = max(perpThis, perpOther);
        if (tipLen > 1e-4) { dClip = max(dClip, halfW + dot(-ep, tipDir) / tipLen - mlClip);
          seAnd(eP, eQ, tipDir / tipLen, dot(-ep, tipDir) / tipLen - mlClip, seR); }

        dClip = max(dClip, halfW + length(-ep) - halfW * strokeArcsReachFactor(miterLimit));
        if (length(ep) > 0.0) seAnd(eP, eQ, -ep / length(ep), length(ep) - halfW * strokeArcsReachFactor(miterLimit), seR);
        thisD = dClip;
      }
    } else if (joinStyle == 4) {
      // SVG2 arcs: extend each edge's centerline as its osculating circle; the
      // ±halfW band is the extended stroke, and the join wedge is both bands
      // past the vertex. Reduces to miter when curvatures are 0.
      float c = dot(uOwn, uOth);
      // Miter length is halfW/sin(theta/2) -- see the miter branch.
      float sinHalf = 0.5 * length(uOwn - uOth);   // half the distance between the unit vectors, as above
      float miterLen = halfW / max(sinHalf, 1.17549435e-38);
      bool fits = miterLen <= halfW * miterLimit;
            //
      float alongA = dot(-ep, uOwn);
      float cosHalfA = sqrt(max(0.5 * (1.0 + c), 0.0));
      float perpThis  = perpDistToArc(-ep, tOwn, kOwn);
      float perpOther = perpDistToArc(-ep, tOth, kOth);
      // the record: the two bands' outer boundaries, each by its tangent plane at the fragment (circles when curved)
      eP = vec4(0.0); eQ = vec4(0.0);
      seAnd(eP, eQ, seArcN(-ep, tOwn, kOwn), perpThis - halfW, seR); seAnd(eP, eQ, seArcN(-ep, tOth, kOth), perpOther - halfW, seR);

      float dArc = max(max(perpThis, perpOther),
                       halfW + length(-ep) - halfW * strokeArcsReachFactor(miterLimit));
      // ...and the reach cut, the disc about the vertex, by its tangent plane
      if (length(ep) > 0.0) seAnd(eP, eQ, -ep / length(ep), length(ep) - halfW * strokeArcsReachFactor(miterLimit), seR);
      float capAlong = fits ? miterLen * cosHalfA : 0.0;
      if (alongA >= 0.0 && alongA <= capAlong) {
        thisD = min(thisD, dArc);
      } else if (!fits) {

        vec2 tipDir = din - dout;
        float tipLen = length(tipDir);
        float dc = dArc;
        if (tipLen > 1e-4) {
          dc = max(dc, halfW + dot(-ep, tipDir) / tipLen - halfW * max(miterLimit, 1.0));
          seAnd(eP, eQ, tipDir / tipLen, dot(-ep, tipDir) / tipLen - halfW * max(miterLimit, 1.0), seR); }
        thisD = dc;
      }
      // Between CURVED edges the region is two bands' intersection, bounded by circles, and the bodies go on outside
      // the wedge: two tangent planes are no picture of that corner. The record keeps the one plane the distance takes.
      if (kOwn != 0.0 || kOth != 0.0) eP = vec4(eP.xyz, min(eP.w, 1.0));
    } else {
      // The join wedge. This gate splits the join at the neighbor's perpendicular: this segment takes
      // the half-plane on its own side of it, the neighbor the half on the other. Those two half-planes
      // tile the plane only when the tangents are PARALLEL. At any tangent break the wedge between
      // the two perpendiculars is claimed by NEITHER, and a hairline the width of
      // that wedge runs clean across the band — wider with halfW, at every
      // resolution, on smooth-looking C1 joins nobody would think to check. Miter
      // does not show it because its own wedge branch already spans the gap.
      //
      // A round join IS the union with a disc of radius halfW at the vertex, so the
      // dropped wedge is covered by exactly that radial distance: not extra
      // coverage, the join's own definition. BEVEL's chord clip below spans the
      // same wedge and only needs to stop dropping first.
      //
      // AND OUTSIDE THAT WEDGE, ROUND AND BEVEL END IN A BUTT END TOO. SVG 2's round join is the
      // bevel triangle plus the circular SECTOR between the two outer offset normals, not a disc.
      // The half-disc the butt end keeps — length(q) <= halfW AND q in front of this segment's own
      // end plane — is inside this segment's BODY, so it cannot paint outside SVG 2; and it is an
      // SDF, not a drop, so the ramp across the plane survives.
      bool behindJoin = outWedge;
      if (behindJoin && (joinStyle == 1 || joinStyle == 2)) {       // the record: the butt end, its side and its plane
        eP = seSlab(-ep, tOwn, halfW, seR); eQ = vec4(0.0);
        if (dot(-ep, uOwn) > 0.0) seAnd(eP, eQ, uOwn, dot(-ep, uOwn), seR);
      }
      if (behindJoin && joinStyle != 1 && joinStyle != 2) drop = true;
      else if (behindJoin) thisD = dot(-ep, uOwn) > 0.0 ? max(min(thisD, length(ep)), halfW + dot(-ep, uOwn)) : min(thisD, length(ep));   // the plane only ahead of it (see the miter branch)
      else if (joinStyle == 1) {
        // the record: the join's disc, with the body whose tangent point is nearer behind its plane (the start takes
        // the neighbor's first on a tie, the end its own)
        vec2 uF = atS ? uOth : uOwn, uS = atS ? uOwn : uOth;
        vec2 uJ = dot(-ep, uF) <= dot(-ep, uS) ? uF : uS;
        seDisc(eP, eQ, -ep, uJ, halfW);
      }
      else if (joinStyle == 2) {
        // Exact bevel: clip the round corner to the bevel chord — the line joining
        // the two segments' outer offset points (hw·nA, hw·nB) — as an AA distance
        // (raise thisD so coverage crosses 0.5 at the chord), leaving the flat
        // bevel triangle. nA from the direction into the vertex, nB from the one out of it.
        float cr = din.x * dout.y - din.y * dout.x;       // turn sign → outer side
        float sd = (cr >= 0.0) ? 1.0 : -1.0;
        vec2 nA = sd * vec2(din.y, -din.x), nB = sd * vec2(dout.y, -dout.x);
        vec2 nb = nA + nB; float bl = length(nb);
        // behindJoin is false here, so the base is the closest-point
        // distance — inside the wedge this seg always has one.
        eP = vec4(0.0); eQ = vec4(0.0);     // the record: the chord, and the side it meets
        seAnd(eP, eQ, seSide(-ep, tOwn, halfW), seR); seAnd(eP, eQ, seSide(-ep, tOth, halfW), seR);
        if (bl > 1e-4) { vec2 bis = nb / bl; seAnd(eP, eQ, bis, dot(-ep, bis) - halfW * dot(nA, bis), seR);
          thisD = max(thisD, halfW + dot(-ep, bis) - halfW * dot(nA, bis)); }
        else { seAnd(eP, eQ, uOwn, dot(-ep, uOwn), seR); thisD = max(thisD, halfW + dot(-ep, uOwn)); }   // an exact reversal: a bevel of no area, a butt end
      }
    }
  }

  if (!drop && t > 1e-4 && t < 1.0 - 1e-4) {
    vec2 cpF = -thisD * gradIO;                              // the closest point, relative to the fragment
    float endD = -1e30;
    if (freeStart && startCap == 0) {
      vec2 sn = strokeUnit(dStart);
      vec2 qv = -pStart;
      float aOut = dot(qv, -sn), lat = dot(qv, vec2(-sn.y, sn.x)), kL = curv.x * lat;
      bool own = aOut <= 0.0 && length(cpF - pStart) <= 2.0 * seR - aOut && length(dStart) * t <= 2.0 * seR - aOut;
      if (own && abs(lat) <= halfW && kL <= 1.0) endD = halfW + aOut;
      // the record: the end's plane wherever it cuts the pixel BOX -- out to the box's reach past the sides, where the
      // end's corner is (a far one lies beyond the pixel box: seAnd drops it)
      if (own && abs(lat) <= halfW + seR && kL <= 1.0) seAnd(eP, eQ, -sn, aOut, seR);
    }
    if (freeEnd && endCap == 0) {
      vec2 en = strokeUnit(dEnd);
      vec2 qv = -pEnd;
      float aOut = dot(qv, en), lat = dot(qv, vec2(-en.y, en.x)), kL = curv.y * lat;
      bool own = aOut <= 0.0 && length(cpF - pEnd) <= 2.0 * seR - aOut && length(dEnd) * (1.0 - t) <= 2.0 * seR - aOut;
      if (own && abs(lat) <= halfW && kL <= 1.0) endD = max(endD, halfW + aOut);
      if (own && abs(lat) <= halfW + seR && kL <= 1.0) seAnd(eP, eQ, en, aOut, seR);
    }
    if (endD > thisD) { thisD = endD; gradIO = vec2(0.0); }
    // THE INSIDE OF A TURN (the record): near an interior end, a pixel on the turn's inner side has the neighbor's
    // side take over from this one's -- a CONCAVE corner, the union of the two sides; the neighbor's side is its
    // tangent line at the vertex. Its inner half-plane is only ever inside the stroke where it is beyond this side:
    // behind the vertex it reaches this segment's own inside first. A turn under 1/64 rad has no notch worth the
    // name (what one plane misses of it is under 1/255 of the box), and its sign is no guide to which side is inner.
    bool atEndU = freeStart || (!freeEnd && t >= 0.5);   // the interior end; of two, the nearer
    if ((eP.w == 1.0 || eP.w == 9.0) && (atEndU ? !freeEnd : !freeStart)) {
      vec2 own = strokeUnit(atEndU ? dEnd : dStart), nbU = atEndU ? outTan : inTan, qU = -(atEndU ? pEnd : pStart);
      float turn = atEndU ? own.x * nbU.y - own.y * nbU.x : nbU.x * own.y - nbU.y * own.x;
      if (abs(turn) > 1.0 / 64.0 && dot(qU, vec2(-own.y, own.x)) * turn > 0.0) {
        vec2 pnU = vec2(-nbU.y, nbU.x) * (turn > 0.0 ? 1.0 : -1.0);
        seOr(eP, eQ, pnU, dot(qU, pnU) - halfW, seR);
      }
    }
  }
  // A DASH CAP PAST A VERTEX. A dash that ends (or starts) short of an interior vertex has its own square or round cap,
  // which reaches round the corner into the next segment's territory, where this segment's join logic has dropped or
  // butted it. The cap is the dash's, so the pixel's distance to it -- across the segment's line and along the path to
  // the dash end -- is a candidate beside whatever the join says, wherever the dash end lies on this segment.
  float dSpill = 1e30;
  if (dashId > 0 && (t < 1e-4 || t > 1.0 - 1e-4)) {
    bool atSp = t < 1e-4;
    vec2 epSp = atSp ? pStart : pEnd;
    vec2 tSp = strokeUnit(atSp ? dStart : dEnd);
    int capSp = atSp ? startCap : endCap;
    float aSp = dot(-epSp, tSp);
    if (!(atSp ? freeStart : freeEnd) && capSp != 0 && (atSp ? aSp < 0.0 : aSp > 0.0)) {
      float latSp = length(-epSp - tSp * aSp);
      vec2 rSp = dashCapReach(dashId, startDist + arcLenAtT + aSp, startCap == 0 && endCap == 0);
      float oSp = atSp ? rSp.y : rSp.x;
      // (not where the dash passes through the seam and the boundary this would cap is the one at the vertex itself: there is none)
      bool seamHere = (atSp ? strokeSeamMergeLo : strokeSeamMergeHi) && abs(oSp - abs(aSp)) <= strokeSeamTol;
      if (oSp >= abs(aSp) * 0.999995 && oSp < 1e29 && !seamHere) dSpill = capSp == 2 ? max(latSp, oSp) : length(vec2(latSp, oSp));
    }
  }
  if (drop) { eP = vec4(0.0); eQ = vec4(0.0); return min(minDIn, dSpill); }
  if (dashId > 0) {
    // Past an END, the pixel's path distance carries on along the end's tangent (the same one the cap planes use):
    // the dash state is the end's, but its distance to the nearest dash boundary is from where the pixel is.
    float along = t <= 0.0 ? dot(-pStart, strokeUnit(dStart)) : t >= 1.0 ? dot(-pEnd, strokeUnit(dEnd)) : 0.0;
    // Past an end the round cap's distance is RADIAL, and `along` is already in it: a dash end's disc takes the distance
    // ACROSS the path (and its direction) with the path distance o, which carries `along` -- not the overshoot twice.
    float dIn = thisD;
    vec2 gIn = gradIO;
    if (roundEnd && along != 0.0) {
      float lat = length(latV);
      dIn = lat;
      gradIO = lat > 0.0 ? latV / lat : vec2(0.0);
    }
    float dOut = strokeDashDist(dIn, gradIO, tanT, halfW, dashId, startDist + arcLenAtT + along, startCap, endCap,
                                startDist, dashEnd, seR, eP, eQ);
    if (dOut == dIn && roundEnd && along != 0.0) gradIO = gIn;   // the dash changed nothing here
    else thisD = dOut;
  }
  // One plane only where the distance is that plane's. Where it is not -- a union the walk will not keep, a curved arcs
  // join cut to its one plane -- the edges meeting at the pixel are more than that plane, and keep the distance's ramp.
  if (eP.w == 1.0 && abs(eP.z - (thisD - halfW)) > (1.0 / 1024.0) * seR) { eP = vec4(0.0); eQ = vec4(0.0); }
  if (dSpill < thisD) { eP = vec4(0.0); eQ = vec4(0.0); gradIO = vec2(0.0); thisD = dSpill; }
  return min(minDIn, thisD);
}

/// d^2 and f = P.P' at a parameter, for the bracketed arm below. Coefficient form, query-relative.
float d2AtT(vec4 cx, vec4 cy, float t) { float x = evalC(cx, t), y = evalC(cy, t); return x * x + y * y; }

// For query-relative cubic P, stationary distance satisfies f=P·P′, a quintic.
// Solve the quadratic f′′′, then isolate roots of f′′, f′ and f in order.
// Between adjacent derivative roots the next polynomial is monotone.
// Retain roots at bracket endpoints so even-multiplicity roots are considered.

// Evaluate derivatives by level: 3=f′′′, 2=f′′, 1=f′ and 0=f.
float cdPoly(float c5, float c4, float c3, float c2, float c1, float c0, int lv, float t) {
  if (lv == 3) return (60.0 * c5 * t + 24.0 * c4) * t + 6.0 * c3;
  if (lv == 2) return ((20.0 * c5 * t + 12.0 * c4) * t + 6.0 * c3) * t + 2.0 * c2;
  if (lv == 1) return (((5.0 * c5 * t + 4.0 * c4) * t + 3.0 * c3) * t + 2.0 * c2) * t + c1;
  return ((((c5 * t + c4) * t + c3) * t + c2) * t + c1) * t + c0;
}
/// ...and `tIn`, the nearest of its INTERIOR roots -- a perpendicular foot strictly inside (0, 1) -- or -1 where there
/// is none (strokeCubicAccum); cubicClosestDescend below is it without.
float cubicClosestDescend2(vec4 cx, vec4 cy, out float tIn) {
  // Normalize shape coefficients by an exact power of two before forming
  // products and discriminants. This prevents fourth-power overflow without
  // changing roots. Choose the scale from the largest nonconstant coefficient;
  // zero and denormal shapes retain their original scale.
  vec4 cm = max(abs(cx), abs(cy));
  uint cE = min(floatBitsToUint(max(cm.x, max(cm.y, cm.z))) & 0x7F800000u, 0x7E800000u);
  float cK = cE == 0u ? 1.0 : uintBitsToFloat(0x7F000000u - cE);
  cx *= cK; cy *= cK;
  // f = P.P' as explicit quintic coefficients, from the two cubic coefficient vectors. Identical
  // to the CHEB_SEED arm's F5..F0; spelled again here so neither arm reaches into the other.
  float c5 = 3.0 * (cx.x * cx.x + cy.x * cy.x);
  float c4 = 5.0 * (cx.x * cx.y + cy.x * cy.y);
  float c3 = 4.0 * (cx.x * cx.z + cy.x * cy.z) + 2.0 * (cx.y * cx.y + cy.y * cy.y);
  float c2 = 3.0 * (cx.y * cx.z + cy.y * cy.z) + 3.0 * (cx.x * cx.w + cy.x * cy.w);
  float c1 = (cx.z * cx.z + cy.z * cy.z) + 2.0 * (cx.y * cx.w + cy.y * cy.w);
  float c0 = cx.w * cx.z + cy.w * cy.z;
  // At most five roots at the bottom level, so six slots carry every level.
  float rts[6];
  int nr = 0;
  // LEVEL 3, IN CLOSED FORM. A quadratic, solved by the numerically stable pairing (q = -(B +
  // sign(B) sqrt(disc))/2, roots q/A and C/q) rather than the textbook one, which cancels when
  // 4AC is small against B^2 -- and it is, on a nearly straight cubic.
  {
    float A = 60.0 * c5, B = 24.0 * c4, C = 6.0 * c3;
    float sc = max(abs(A), max(abs(B), abs(C)));
    if (sc > 0.0) {
      if (abs(A) <= 1e-12 * sc) {
        if (abs(B) > 1e-12 * sc) { float r = -C / B; if (r > 0.0 && r < 1.0) rts[nr++] = r; }
      } else {
        float dq = B * B - 4.0 * A * C;
        if (dq >= 0.0) {
          float sq = sqrt(dq);
          float q = -0.5 * (B + (B >= 0.0 ? sq : -sq));
          float r0 = q / A;
          float r1 = (abs(q) > 0.0) ? C / q : r0;
          float lo = min(r0, r1), hi = max(r0, r1);
          if (lo > 0.0 && lo < 1.0) rts[nr++] = lo;
          if (hi > lo && hi > 0.0 && hi < 1.0) rts[nr++] = hi;
        }
      }
    }
  }
  // And down. `rts` is ascending at every level: the brackets are scanned left to right and each
  // yields at most one root, so no sort is ever needed.
  for (int lv = 2; lv >= 0; lv--) {
    float nxt[6];
    int nn = 0;
    float lo = 0.0, flo = cdPoly(c5, c4, c3, c2, c1, c0, lv, 0.0);
    for (int i = 0; i <= 6; i++) {
      if (i > nr) break;
      float hi = (i == nr) ? 1.0 : rts[i];
      float fhi = cdPoly(c5, c4, c3, c2, c1, c0, lv, hi);
      // A root sitting exactly ON a bracket end: a sign test cannot see it, and it is a real root
      // of this level (a double root of the level below).
      if (flo == 0.0 && lo > 0.0 && nn < 6) nxt[nn++] = lo;
      if (flo * fhi < 0.0) {
        // 24 STEPS, which is the interval's own width to a part in 1.7e7 -- and a bracket is a
        // sub-interval of [0,1], so the bound is tighter than that everywhere it matters. The
        // whole point of the chain is that this bracket holds exactly ONE root, so bisection is
        // unconditional convergence rather than a search.
        float a = lo, b = hi, fa = flo;
        for (int k = 0; k < 24; k++) {
          float m = 0.5 * (a + b);
          float fm = cdPoly(c5, c4, c3, c2, c1, c0, lv, m);
          if (fa * fm <= 0.0) b = m; else { a = m; fa = fm; }
        }
        if (nn < 6) nxt[nn++] = 0.5 * (a + b);
      }
      lo = hi; flo = fhi;
    }
    nr = nn;
    for (int i = 0; i < 6; i++) rts[i] = nxt[i];
  }
  // The endpoints are candidates too. f's roots are the interior critical points of |P|^2; the
  // minimum over [0,1] can sit at an end, where f need not vanish at all.
  float d0 = d2AtT(cx, cy, 0.0), d1 = d2AtT(cx, cy, 1.0);
  float bt = (d0 <= d1) ? 0.0 : 1.0;
  float bs = min(d0, d1), bi = 1e30;
  tIn = -1.0;
  for (int i = 0; i < 6; i++) {
    if (i >= nr) break;
    float tt = clamp(rts[i], 0.0, 1.0);
    float dd = d2AtT(cx, cy, tt);
    if (dd < bs) { bs = dd; bt = tt; }
    if (rts[i] > 0.0 && rts[i] < 1.0 && dd < bi) { bi = dd; tIn = rts[i]; }
  }
  return bt;
}
float cubicClosestDescend(vec4 cx, vec4 cy) { float tIn; return cubicClosestDescend2(cx, cy, tIn); }

@@ARC_MATH@@

/// ARC stroke distance accumulator — the exact distance to an elliptical arc, so the split-stroke
/// pass can carry arcs as ARCS. Everything else on that path stores a cubic, and for a line or a
/// quad that is only a change of representation (degree elevation is exact); for an arc it is an
/// APPROXIMATION, because a circular arc has no cubic form at all — 8.9e-3 of the radius on a
/// 90-degree sweep, fixed in em and therefore unbounded in pixels as the view zooms in.
///
/// Same math as the band walk's arc branch, which is the point: one answer, two callers. `pc` is
/// the query point relative to the arc CENTER; radii/phi/th0/th1 are the arc as the encoder stores
/// it (encodeSeg's SEG_ARC texels). Endpoints are derived here rather than passed, so a caller
/// cannot disagree with the curve about where it ends.
float strokeArcAccum(vec2 pc, vec2 radii, float phi, float th0, float th1,
                     bool freeStart, bool freeEnd,
                     int startCap, int endCap,
                     int joinStyle, float miterLimit, float halfW,
                     vec2 inTan, vec2 outTan,
                     int dashId, float startDist,
                     vec4 curv, float minDIn, out vec2 gradOut, float seR, out vec4 edgeP, out vec4 edgeQ) {
  gradOut = vec2(0.0);
  float cphi = cos(phi), sphi = sin(phi);
  vec2 pR = vec2(pc.x * cphi + pc.y * sphi, -pc.x * sphi + pc.y * cphi);
  // Endpoints RELATIVE to the query point: evalArc about the origin gives the offset from the
  // center, and pc is the query in the same frame, so offset - pc is endpoint - query.
  vec2 ep0 = evalArc(0.0, 0.0, radii.x, radii.y, phi, th0) - pc;
  vec2 ep1 = evalArc(0.0, 0.0, radii.x, radii.y, phi, th1) - pc;
  float dE = min(length(ep0), length(ep1));
  vec2 foot;
  bool inRange;
  float tAng;
  float dEdge = arcClosestFoot(radii, pR, th0, th1, foot, tAng, inRange);
  if (inRange && dEdge > dE) inRange = false;
  float arcD = inRange ? min(dEdge, dE) : dE;
  // The boundary normal for exact-area AA, only when the arc BODY wins: `foot` is the closest
  // point in the ellipse's local frame, so rotating (pR - foot) back by phi is the em-space normal.
  // A normal wherever the distance is not exactly zero: the guard is against a 0 / 0, not a length (with > 1e-12, a
  // pixel that near the centerline at 2^-20 would have no normal).
  if (inRange && dEdge > 0.0) {
    vec2 gl2 = (pR - foot) / dEdge;
    gradOut = vec2(gl2.x * cphi - gl2.y * sphi, gl2.x * sphi + gl2.y * cphi);
  }
  float dth = th1 - th0;
  vec2 dStart = vec2(arcDxDtheta(radii.x, radii.y, phi, th0),
                     arcDyDtheta(radii.x, radii.y, phi, th0)) * dth;
  vec2 dEnd   = vec2(arcDxDtheta(radii.x, radii.y, phi, th1),
                     arcDyDtheta(radii.x, radii.y, phi, th1)) * dth;
  // A zero-radius arc is SVG's straight line between its ends (the encoder's half-turn of a degenerate ellipse, which
  // turns round AT its ends): its velocity there is float32's rounding of sin(pi), pointing either way, and a butt cap
  // faced it. Its ends run along its chord, as the encoder's segTangentAt says.
  if (radii.x == 0.0 || radii.y == 0.0) { dStart = ep1 - ep0; dEnd = dStart; }
  // the path's curvature at each end, for a free butt end's plane (see strokeQuadAccum): the second derivative is the
  // end's offset from the center turned back, times dth^2; a zero-radius arc is straight
  if (joinStyle != 4) curv = (radii.x == 0.0 || radii.y == 0.0) ? vec4(0.0, 0.0, curv.zw)
    : vec4(seKappa(dStart, -(ep0 + pc) * dth * dth, 0.0), seKappa(dEnd, -(ep1 + pc) * dth * dth, 0.0), curv.zw);
  float tArc;
  if (inRange) {
    float dd = hlslFmod(tAng - th0, TWO_PI);
    if (dd < 0.0) dd += TWO_PI;
    if (dth < 0.0 && dd > 0.0) dd -= TWO_PI;
    tArc = clamp(dd / dth, 0.0, 1.0);
  } else {
    tArc = (length(ep0) <= length(ep1)) ? 0.0 : 1.0;
  }
  float arcLenAtT = (dashId > 0)
    ? arcArcLen(vec4(0.0, 0.0, radii.x, radii.y), vec4(th0, th1, phi, 0.0), tArc) : 0.0;
  // the path's direction at the closest point, for a dash end's plane (strokeDashDist)
  float thT = th0 + tArc * dth;
  vec2 tanT = (dashId > 0) ? strokeUnit(vec2(arcDxDtheta(radii.x, radii.y, phi, thT), arcDyDtheta(radii.x, radii.y, phi, thT)) * dth)
                           : vec2(0.0);
  vec2 g = gradOut;
  // A zero-radius arc's parameter runs round its degenerate ellipse, (1 - cos(pi t)) / 2 of the way along its chord, and
  // the ends' tests measure along the path: the butt plane's own stretch is its speed times t, which read a pixel
  // 1 px inside a 38 px chord as 3.9 px along and left its end uncut (74/255, test/zeroRadiusArcSmoke.mjs). They take
  // the chord's own fraction there.
  float tEnd = tArc;
  if (radii.x == 0.0 || radii.y == 0.0) {
    vec2 ch = ep1 - ep0;
    float c2 = dot(ch, ch);
    if (c2 > 0.0) tEnd = clamp(-dot(ep0, ch) / c2, 0.0, 1.0);
  }
  float md = strokeCapsJoinsDash(tEnd, arcD, ep0, ep1, dStart, dEnd,
                                 freeStart, freeEnd, startCap, endCap,
                                 joinStyle, miterLimit, halfW, inTan, outTan,
                                 dashId, startDist, arcLenAtT, curv, minDIn, g, tanT,
                                 (dashId > 0) ? startDist + arcArcLen(vec4(0.0, 0.0, radii.x, radii.y), vec4(th0, th1, phi, 0.0), 1.0) : 1e30,
                                 seR, edgeP, edgeQ);
  // THE ENDS AS CANDIDATES, as strokeQuadAccum and strokeCubicAccum have them: the closest point is interior or the other end, but a pixel
  // past an end plane -- within the end cap's reach -- belongs to that end's cap too, and a near-closed arc has another
  // part of itself nearer than the end it is beside. Without them a square cap beside the arc's own body would be lost
  // (a 300-degree arc's end cap pixels short).
  if (radii.x != 0.0 && radii.y != 0.0) {
    for (int e = 0; e < 2; e++) {
      if ((e == 0 && tEnd < 1e-4) || (e == 1 && tEnd > 1.0 - 1e-4)) continue;   // the end already evaluated
      if (tEnd >= 1e-4 && tEnd <= 1.0 - 1e-4 && !strokeEndCandidate(freeStart, freeEnd, startCap, endCap, joinStyle, dashId, e)) continue;   // an interior closest point: see strokeEndCandidate
      vec2 pE = e == 0 ? ep0 : ep1, uE = e == 0 ? -strokeUnit(dStart) : strokeUnit(dEnd);
      if (!(dot(-pE, uE) > 0.0) || length(pE) > halfW * (max(miterLimit, 1.0) + 1.0) + seR) continue;
      if (joinStyle == 4 && !(e == 0 ? freeStart : freeEnd)) continue;   // an arcs join's wedge is bounded only by the nearest vertex
      vec2 gK = vec2(0.0);
      vec4 eP2, eQ2;
      float mdK = strokeCapsJoinsDash(float(e), length(pE), ep0, ep1, dStart, dEnd,
                                      freeStart, freeEnd, startCap, endCap,
                                      joinStyle, miterLimit, halfW, inTan, outTan,
                                      dashId, startDist,
                                      (dashId > 0 && e == 1) ? arcArcLen(vec4(0.0, 0.0, radii.x, radii.y), vec4(th0, th1, phi, 0.0), 1.0) : 0.0,
                                      curv, minDIn, gK, strokeUnit(e == 0 ? dStart : dEnd),
                                      (dashId > 0) ? startDist + arcArcLen(vec4(0.0, 0.0, radii.x, radii.y), vec4(th0, th1, phi, 0.0), 1.0) : 1e30,
                                      seR, eP2, eQ2);
      if (mdK < md) { md = mdK; edgeP = eP2; edgeQ = eQ2; g = gK; }
    }
  }
  gradOut = g;
  if (md >= minDIn) gradOut = vec2(0.0);              // an endpoint won; it rewrites the distance
  return md;
}

// Cubic stroke distance and endpoint cap/join/dash contributions.
// The derivative-chain solver returns the closest point and closest interior
// stationary point. Controls are relative to the query point.
// Seeded local solves cannot select the global minimum on loops or cusps.
float strokeCubicAccum(vec4 p12, vec4 p34,
                           bool freeStart, bool freeEnd,
                           int startCap, int endCap,
                           int joinStyle, float miterLimit,
                           float halfW,
                           vec2 inTan, vec2 outTan,
                           int dashId, float startDist,
                           vec4 curv, float minDIn, out vec2 gradOut, float seR, out vec4 edgeP, out vec4 edgeQ) {
  // SOLVED FROM THE NEARER END, as strokeQuadAccum is. The quintic P.P' is written from the
  // coefficients of whichever end they are taken about, and it is well conditioned only there: at the
  // far end they cancel segment-sized terms, and when that end's handle is short or ZERO its roots
  // crowd the endpoint. The descending chain's bisection would then read noise for sign near t = 1 and
  // stop short of the end gate for pixels near the cap plane -- most of a halfW off at every scale, while
  // the start is exact (test/strokeCubicZeroSpeedEndSmoke.mjs). The reversed cubic (p4, p3, p2, p1)
  // gives the end the start's conditioning; `u` is its parameter, t = 1 - u.
  bool fromEnd = dot(p34.zw, p34.zw) < dot(p12.xy, p12.xy);
  vec4 q12 = fromEnd ? vec4(p34.zw, p34.xy) : p12;
  vec4 q34 = fromEnd ? vec4(p12.zw, p12.xy) : p34;
  vec4 cx = cubicCoeff(q12.x, q12.z, q34.x, q34.z);
  vec4 cy = cubicCoeff(q12.y, q12.w, q34.y, q34.w);
  float uIn;
  float u = cubicClosestDescend2(cx, cy, uIn);
  float pxv = evalC(cx, u);
  float pyv = evalC(cy, u);
  float t = fromEnd ? 1.0 - u : u;
  float thisD = sqrt(pxv * pxv + pyv * pyv);
  // p4 itself, not the coefficient sum a + b + c + d, which rounds at the size of the coefficients (up
  // to 8x the control points) and moved the end's cap plane by it.
  vec2 pEnd = p34.zw;
  // The end directions are the encoder's: the end handle, else the
  // next handle (p3 - p2), else the chord, each taken while it is over 1e-9 of the control-point span.
  // The encoder hands this segment's NEIGHBOR its idea of each end's tangent, and the cap and join
  // planes here are built from these, so the two must mean the same direction -- the quad's rule.
  // A coincident handle (an SVG `S` continuation writes p2 == p1) needs a fallback, and Horner's
  // 3a + 2b + c at t = 1 sums segment-sized terms to get one the size of the end handle -- so a ZERO
  // end handle would come out as a rounding residue pointing anywhere, and a short one tilted
  // (test/strokeCubicEndTangentSmoke.mjs). Both ends are direct differences, as the encoder writes them. What is left is float32: a handle too short for the
  // fragment-relative coordinates to hold reads zero, and takes the next one, at any scale.
  vec2 lo4 = min(min(p12.xy, p12.zw), min(p34.xy, p34.zw)), hi4 = max(max(p12.xy, p12.zw), max(p34.xy, p34.zw));
  float dirMin = 1e-9 * max(hi4.x - lo4.x, hi4.y - lo4.y);
  vec2 dStart = 3.0 * (p12.zw - p12.xy);
  if (!(length(dStart) > dirMin)) dStart = p34.xy - p12.zw;
  if (!(length(dStart) > dirMin)) dStart = p34.zw - p12.xy;
  vec2 dEnd = 3.0 * (p34.zw - p34.xy);
  if (!(length(dEnd) > dirMin)) dEnd = p34.xy - p12.zw;
  if (!(length(dEnd) > dirMin)) dEnd = p34.zw - p12.xy;
  // the path's curvature at each end, for a free butt end's plane (see strokeQuadAccum)
  if (joinStyle != 4) {
    float m = max(max(length(p12.xy), length(p12.zw)), max(length(p34.xy), length(p34.zw)));
    vec2 a0 = 6.0 * (p12.xy - 2.0 * p12.zw + p34.xy), a1 = 6.0 * (p12.zw - 2.0 * p34.xy + p34.zw);
    curv = vec4(seKappa(dStart, a0, seKappaErr(m, dStart, a0)), seKappa(dEnd, a1, seKappaErr(m, dEnd, a1)), curv.zw);
  }
  // Body hit -> the distance gradient IS the boundary normal (see the note on
  // strokeQuadAccum). (pxv, pyv) is closest-minus-fragment, so negate.
  vec2 g = (t >= 1e-4 && t <= 1.0 - 1e-4 && thisD > 0.0)
            ? (vec2(-pxv, -pyv) / thisD) : vec2(0.0);
  // The dash distance runs from p1 whichever end was solved from, so it takes the forward coefficients.
  float arcLenAtT = (dashId > 0)
    ? slugCubicArcLen(cubicCoeff(p12.x, p12.z, p34.x, p34.z), cubicCoeff(p12.y, p12.w, p34.y, p34.w), clamp(t, 0.0, 1.0))
    : 0.0;
  // the path's direction at the closest point, for a dash end's plane (strokeDashDist)
  vec2 tanT = vec2(0.0);
  if (dashId > 0) {
    float tc = clamp(t, 0.0, 1.0);
    tanT = strokeUnit(vec2(evalCD(cubicCoeff(p12.x, p12.z, p34.x, p34.z), tc), evalCD(cubicCoeff(p12.y, p12.w, p34.y, p34.w), tc)));
    if (dot(tanT, tanT) == 0.0) tanT = strokeUnit(tc < 0.5 ? dStart : dEnd);   // a cusp at the closest point
  }
  float cT1 = 0.0, cT2 = 0.0, cD1 = 0.0, cD2 = 0.0, cU1 = 0.0, cU2 = 0.0;
  vec2 cQ1 = vec2(0.0), cQ2 = vec2(0.0), cG1 = vec2(0.0), cG2 = vec2(0.0);
  int nC = 1;
  if ((t < 1e-4 || t > 1.0 - 1e-4) && uIn >= 0.0) {
    vec2 qIn = vec2(evalC(cx, uIn), evalC(cy, uIn));
    float dIn = length(qIn);
    if (dIn > 0.0 && dIn < halfW + seR) { nC = 2; cT1 = fromEnd ? 1.0 - uIn : uIn; cD1 = dIn; cQ1 = qIn; cG1 = -qIn / dIn; cU1 = uIn; }
  } else if (t >= 1e-4 && t <= 1.0 - 1e-4) {
    for (int e = 0; e < 2; e++) {
      if (!strokeEndCandidate(freeStart, freeEnd, startCap, endCap, joinStyle, dashId, e)) continue;
      vec2 pE = e == 0 ? p12.xy : pEnd, uE = e == 0 ? -strokeUnit(dStart) : strokeUnit(dEnd);
      if (!(dot(-pE, uE) > 0.0) || length(pE) > halfW * (max(miterLimit, 1.0) + 1.0) + seR) continue;
      float tE = float(e);
      if (nC == 1) { cT1 = tE; cD1 = length(pE); cQ1 = pE; cU1 = fromEnd ? 1.0 - tE : tE; }
      else { cT2 = tE; cD2 = length(pE); cQ2 = pE; cU2 = fromEnd ? 1.0 - tE : tE; }
      nC++;
    }
  }
  if (t < 1e-4 || t > 1.0 - 1e-4) {
    // the OTHER end is a candidate too: a pixel beside a curve that folds back on itself has this end nearest and yet
    // lies in the other end's cap or join (a miter's tip at the vertex a curling segment returns to)
    float tE = t < 1e-4 ? 1.0 : 0.0;
    vec2 pE = tE == 0.0 ? p12.xy : pEnd, uE = tE == 0.0 ? -strokeUnit(dStart) : strokeUnit(dEnd);
    // (not an arcs join: its wedge is bounded only by which vertex is nearest, so a farther vertex's would paint a spike)
    if (dot(-pE, uE) > 0.0 && length(pE) <= halfW * (max(miterLimit, 1.0) + 1.0) + seR && (joinStyle != 4 || (tE == 0.0 ? freeStart : freeEnd))) {
      if (nC == 1) { cT1 = tE; cD1 = length(pE); cQ1 = pE; cU1 = fromEnd ? 1.0 - tE : tE; }
      else { cT2 = tE; cD2 = length(pE); cQ2 = pE; cU2 = fromEnd ? 1.0 - tE : tE; }
      nC++;
    }
  }
  float md = 1e30;
  float t0 = t, d0 = thisD;
  vec2 g0 = g;
  for (int k = 0; k < nC; k++) {
    float tK = k == 0 ? t0 : (k == 1 ? cT1 : cT2), dK = k == 0 ? d0 : (k == 1 ? cD1 : cD2);
    vec2 gK = k == 0 ? g0 : (k == 1 ? cG1 : cG2);
    bool endK = k > 0 && (tK == 0.0 || tK == 1.0);
    float aK = k == 0 ? arcLenAtT : ((dashId > 0) ? slugCubicArcLen(cubicCoeff(p12.x, p12.z, p34.x, p34.z), cubicCoeff(p12.y, p12.w, p34.y, p34.w), tK) : 0.0);
    vec2 tanK = tanT;
    if (k > 0) {
      tanK = vec2(0.0);
      if (dashId > 0) { tanK = endK ? strokeUnit(tK < 0.5 ? dStart : dEnd) : strokeUnit(vec2(evalCD(cubicCoeff(p12.x, p12.z, p34.x, p34.z), tK), evalCD(cubicCoeff(p12.y, p12.w, p34.y, p34.w), tK))); if (dot(tanK, tanK) == 0.0) tanK = strokeUnit(tK < 0.5 ? dStart : dEnd); }
    }
    vec4 eP2, eQ2;
    float mdK = strokeCapsJoinsDash(tK, dK, p12.xy, pEnd, dStart, dEnd,
                                    freeStart, freeEnd, startCap, endCap,
                                    joinStyle, miterLimit, halfW, inTan, outTan,
                                    dashId, startDist,
                                    aK, curv, minDIn, gK, tanK,
                                    (dashId > 0) ? startDist + slugCubicArcLen(cubicCoeff(p12.x, p12.z, p34.x, p34.z), cubicCoeff(p12.y, p12.w, p34.y, p34.w), 1.0) : 1e30,
                                    seR, eP2, eQ2);
    if (k == 0 || mdK < md) {
      md = mdK; edgeP = eP2; edgeQ = eQ2; g = gK;
      if (k > 0) { u = k == 1 ? cU1 : cU2; pxv = (k == 1 ? cQ1 : cQ2).x; pyv = (k == 1 ? cQ1 : cQ2).y; t = tK; thisD = dK; }
    }
  }
  gradOut = g;
  return md;
}

// Closed-form arc length of a quadratic Bézier over [0,t] (encoder + hit-test
// parity). p1/p2/p3 render-relative. Falls back to the chord when nearly straight.
//
float quadArcLen(vec2 p1, vec2 p2, vec2 p3, float t) {
  vec2 A = p1 - 2.0 * p2 + p3;
  vec2 B = p2 - p1;
  // Normalize before squared norms and the fourth-order discriminant.
  float lengthScale = max(max(abs(A.x), abs(A.y)), max(abs(B.x), abs(B.y)));
  if (!(lengthScale > 0.0)) return 0.0;
  A /= lengthScale; B /= lengthScale;
  float Aq = dot(A, A), Bq = 2.0 * dot(A, B), Cq = dot(B, B);
  if (Aq <= 1e-12 * Cq) return length((p3 - p1) / lengthScale) * lengthScale * t;
  float sqrtA = sqrt(Aq), disc = 4.0 * Aq * Cq - Bq * Bq;
  float ut = max(Aq * t * t + Bq * t + Cq, 0.0), sut = sqrt(ut);
  float argt = 2.0 * sqrtA * sut + 2.0 * Aq * t + Bq;
  float Ft = 2.0 * (((2.0 * Aq * t + Bq) * sut) / (4.0 * Aq)
           + ((argt > 1e-12 * (2.0 * sqrtA * sut + abs(2.0 * Aq * t + Bq))) ? (disc / (8.0 * Aq * sqrtA)) * log(argt) : 0.0));
  float su0 = sqrt(max(Cq, 0.0));
  float arg0 = 2.0 * sqrtA * su0 + Bq;
  float F0 = 2.0 * ((Bq * su0) / (4.0 * Aq)
           + ((arg0 > 1e-12 * (2.0 * sqrtA * su0 + abs(Bq))) ? (disc / (8.0 * Aq * sqrtA)) * log(arg0) : 0.0));
  return (Ft - F0) * lengthScale;
}

// exact closest-point parameter on a quadratic Bezier to the ORIGIN.

// `t` here is not only the distance parameter — the butt cap is implemented as
// "drop when t < 1e-4", so an inaccurate t moves the CAP PLANE too, which is why
// the residual clustered entirely at the two caps and not along the curve.
//
// Candidates are the in-range roots plus both endpoints; clamping a root outside
// [0,1] to the endpoint is correct, since the closest point on a segment is
// either an interior critical point or an end.
/// quadClosestT, and `tIn` the nearest of the INTERIOR perpendicular feet -- the roots strictly inside (0, 1) -- or -1
/// where there is none (strokeQuadAccum).
float quadClosestT2(vec2 A, vec2 B, vec2 C, out float tIn) {
  float a3 = 2.0 * dot(A, A);
  float a2 = 3.0 * dot(A, B);
  float a1 = dot(B, B) + 2.0 * dot(A, C);
  float a0 = dot(B, C);
  float cand[5];
  int n = 0;
  cand[0] = 0.0; cand[1] = 1.0; n = 2;
  if (abs(a3) < 1e-12 * max(abs(a2), max(abs(a1), abs(a0)))) {
    if (abs(a2) > 1e-30) {                       // degenerates to a quadratic
      float disc = a1 * a1 - 4.0 * a2 * a0;
      if (disc >= 0.0) {
        float sd = sqrt(disc);
        float qq = -0.5 * (a1 + (a1 >= 0.0 ? sd : -sd));
        cand[n++] = qq / a2;
        if (abs(qq) > 1e-30) cand[n++] = a0 / qq;
      }
    } else if (abs(a1) > 1e-30) cand[n++] = -a0 / a1;
  } else {
    float p = a2 / a3, q2 = a1 / a3, r = a0 / a3;
    float pp = q2 - p * p / 3.0;                 // depressed cubic y^3 + pp*y + qq
    float qq = (2.0 * p * p * p) / 27.0 - (p * q2) / 3.0 + r;
    float shift = -p / 3.0;
    float disc = qq * qq / 4.0 + pp * pp * pp / 27.0;
    if (disc > 0.0) {                            // one real root
      float sd = sqrt(disc);
      float u = -qq / 2.0 + sd, v = -qq / 2.0 - sd;
      float uc = sign(u) * pow(abs(u), 1.0 / 3.0);
      float vc = sign(v) * pow(abs(v), 1.0 / 3.0);
      cand[n++] = uc + vc + shift;
    } else {                                     // three real roots (trigonometric)
      float rr = sqrt(max(-pp * pp * pp / 27.0, 0.0));
      float phi = acos(clamp(-qq / (2.0 * max(rr, 1e-30)), -1.0, 1.0));
      float m = 2.0 * sqrt(max(-pp / 3.0, 0.0));
      cand[n++] = m * cos(phi / 3.0) + shift;
      cand[n++] = m * cos((phi + 6.2831853071795865) / 3.0) + shift;
      cand[n++] = m * cos((phi + 12.566370614359172) / 3.0) + shift;
    }
  }
    //
  for (int i = 2; i < 5; i++) {
    if (i >= n) break;
    float t0 = cand[i];
    float ft = ((a3 * t0 + a2) * t0 + a1) * t0 + a0;
    float df = (3.0 * a3 * t0 + 2.0 * a2) * t0 + a1;
    if (abs(df) > 1e-30) cand[i] = t0 - ft / df;
  }
  float bt = 0.0, bs = 1e30, bi = 1e30;
  tIn = -1.0;
  for (int i = 0; i < 5; i++) {
    if (i >= n) break;
    float tt = clamp(cand[i], 0.0, 1.0);
    vec2 qv = (A * tt + B) * tt + C;
    float d2 = dot(qv, qv);
    if (d2 < bs) { bs = d2; bt = tt; }
    if (i >= 2 && cand[i] > 0.0 && cand[i] < 1.0 && d2 < bi) { bi = d2; tIn = cand[i]; }
  }
  return bt;
}
float quadClosestT(vec2 A, vec2 B, vec2 C) { float tIn; return quadClosestT2(A, B, C, tIn); }

// Native quadratic stroke accumulator (NOT degree-elevated). closest-point is a
// root of Q·Q' (a cubic) — solved in CLOSED FORM; closed-form arc length.
/// `gradOut` is the EM-space unit normal of the stroke boundary at the closest
/// point, i.e. the gradient of the distance field — normalize(fragment - closest).
/// Set only when the closest point lies on the segment BODY; a cap or join
/// rewrites thisD with its own SDF and that gradient no longer applies.
///
/// A curve's OFFSET is not polynomial, which is why the stroke cannot be turned
/// into a fill. But exactBoxCov needs only the boundary NORMAL AT A POINT, and
/// that is the distance gradient — already in hand once the closest point is
/// solved. Over one pixel the curved boundary differs from its tangent line by
/// O(kappa*px^2), far below a coverage LSB at any sane curvature.
float strokeQuadAccum(vec4 p12, vec2 p3,
                      bool freeStart, bool freeEnd,
                      int startCap, int endCap,
                      int joinStyle, float miterLimit, float halfW,
                      vec2 inTan, vec2 outTan,
                      int dashId, float startDist,
                      vec4 curv, float minDIn, out vec2 gradOut, float seR, out vec4 edgeP, out vec4 edgeQ) {
  vec2 p1 = p12.xy, p2 = p12.zw;
  // Solved from the nearer end. The cubic dot(Q, Q') is well conditioned at the end its
  // coefficients are written from: at t = 0 they are small direct differences of the fragment-relative
  // points (B = 2 (p2 - p1), C = p1), and a zero start handle makes B exactly zero, so the root there is
  // exact. At t = 1 the same coefficients cancel segment-sized terms, and when the END handle is short
  // three roots crowd t = 1 (a triple root for a pixel on the cap plane of a zero handle), where Cardano
  // in float32 is only good to ~cbrt(ulp): the closest point can land short of the `t > 1 - 1e-4` end
  // gate, skipping the butt cap, so a pixel just past the end reads well inside the stroke -- at every
  // scale, for end handles from zero to 1e-2 of the chord, while the mirrored start is exact
  // (test/strokeQuadZeroSpeedEndSmoke.mjs). Solving the REVERSED quad (p3, p2, p1) when
  // the pixel is nearer p3 gives the end the start's conditioning; `u` is the reversed parameter, t = 1 - u.
  bool fromEnd = dot(p3, p3) < dot(p1, p1);
  vec2 s0 = fromEnd ? p3 : p1;
  vec2 A = p1 - 2.0 * p2 + p3;
  vec2 B = 2.0 * (p2 - s0);
  float uIn;
  float u = quadClosestT2(A, B, s0, uIn);  // exact: root of the cubic dot(Q, Q')
  vec2 q = (A * u + B) * u + s0;
  float t = fromEnd ? 1.0 - u : u;
  float thisD = length(q);
  // AN END DERIVATIVE UNDER 1e-9 OF THE SEGMENT'S CONTROL-POINT SPAN HAS NO DIRECTION: take the chord.
  // That is the encoder's rule (textures.js segTangentAt, DEG_REL), and it has to be, because the
  // encoder is what hands this segment's NEIGHBOR its idea of this end's tangent -- the join is built
  // from both sides, and each side must mean the same direction. An absolute |d|^2 < 1e-18 would be a
  // length: at 2^-20 a quad whose handle is under ~5e-4 of its own span would take the chord here while
  // the encoder takes the handle, and the butt cap and join planes at that end would turn by up to 90
  // degrees against scale 1 (test/strokeQuadTangentScaleSmoke.mjs). What is left is float32: a
  // handle too short for the fragment-relative coordinates to hold reads zero at any scale.
  vec2 lo3 = min(min(p1, p2), p3), hi3 = max(max(p1, p2), p3);
  float dirMin = 1e-9 * max(hi3.x - lo3.x, hi3.y - lo3.y);
  // Q'(0) as the encoder writes it, 2 (p2 - p1). Not B, which is Q'(0) only when the solve runs from p1: solving the
  // reversed quad (fromEnd), B is 2 (p2 - p3), the END's handle reversed, and a pixel nearer p3 whose box reaches the
  // start -- a short or folded quad -- would take the start's cap and join planes along the end's direction.
  vec2 dStart = 2.0 * (p2 - p1);
  if (!(length(dStart) > dirMin)) dStart = p3 - p1;
  // Q'(1) as the encoder writes it, 2 (p3 - p2): the same vector as 2A + B, without the cancellation. 2A + B sums
  // terms the size of the whole segment to get one the size of the end handle, so a short handle would come out
  // tilted by ~ulp(segment) / |handle| -- 5e-3 rad for a handle 1e-5 of its span, where the start (B, a direct
  // difference) is exact.
  vec2 dEnd = 2.0 * (p3 - p2);
  if (!(length(dEnd) > dirMin)) dEnd = p3 - p1;
  // the path's curvature at each end, for a free butt end's plane (strokeCapsJoinsDash); an arcs join carries its own
  if (joinStyle != 4) {
    float m = max(max(length(p1), length(p2)), length(p3));
    curv = vec4(seKappa(dStart, 2.0 * A, seKappaErr(m, dStart, 2.0 * A)), seKappa(dEnd, 2.0 * A, seKappaErr(m, dEnd, 2.0 * A)), curv.zw);
  }
  // Body hit iff the closest point is strictly interior — outside that window
  // strokeCapsJoinsDash substitutes a cap/join SDF whose gradient differs.
  vec2 g = (t >= 1e-4 && t <= 1.0 - 1e-4 && thisD > 0.0) ? (-q / thisD) : vec2(0.0);
  float arcLenAtT = (dashId > 0) ? quadArcLen(p1, p2, p3, clamp(t, 0.0, 1.0)) : 0.0;
  // the path's direction at the closest point, for a dash end's plane (strokeDashDist): Q'(t) / 2
  vec2 tanT = vec2(0.0);
  if (dashId > 0) {
    float tc = clamp(t, 0.0, 1.0);
    tanT = strokeUnit(mix(p2 - p1, p3 - p2, tc));
    if (dot(tanT, tanT) == 0.0) tanT = strokeUnit(p3 - p1);
  }
  float cT1 = 0.0, cT2 = 0.0, cD1 = 0.0, cD2 = 0.0, cU1 = 0.0, cU2 = 0.0;
  vec2 cQ1 = vec2(0.0), cQ2 = vec2(0.0), cG1 = vec2(0.0), cG2 = vec2(0.0);
  int nC = 1;
  if ((t < 1e-4 || t > 1.0 - 1e-4) && uIn >= 0.0) {
    vec2 qIn = (A * uIn + B) * uIn + s0;
    float dIn = length(qIn);
    if (dIn > 0.0 && dIn < halfW + seR) { nC = 2; cT1 = fromEnd ? 1.0 - uIn : uIn; cD1 = dIn; cQ1 = qIn; cG1 = -qIn / dIn; cU1 = uIn; }
  } else if (t >= 1e-4 && t <= 1.0 - 1e-4) {
    for (int e = 0; e < 2; e++) {
      if (!strokeEndCandidate(freeStart, freeEnd, startCap, endCap, joinStyle, dashId, e)) continue;
      vec2 pE = e == 0 ? p1 : p3, uE = e == 0 ? -strokeUnit(dStart) : strokeUnit(dEnd);
      if (!(dot(-pE, uE) > 0.0) || length(pE) > halfW * (max(miterLimit, 1.0) + 1.0) + seR) continue;
      float tE = float(e);
      if (nC == 1) { cT1 = tE; cD1 = length(pE); cQ1 = pE; cU1 = fromEnd ? 1.0 - tE : tE; }
      else { cT2 = tE; cD2 = length(pE); cQ2 = pE; cU2 = fromEnd ? 1.0 - tE : tE; }
      nC++;
    }
  }
  if (t < 1e-4 || t > 1.0 - 1e-4) {
    // the OTHER end is a candidate too: a pixel beside a curve that folds back on itself has this end nearest and yet
    // lies in the other end's cap or join (a miter's tip at the vertex a curling segment returns to)
    float tE = t < 1e-4 ? 1.0 : 0.0;
    vec2 pE = tE == 0.0 ? p1 : p3, uE = tE == 0.0 ? -strokeUnit(dStart) : strokeUnit(dEnd);
    // (not an arcs join: its wedge is bounded only by which vertex is nearest, so a farther vertex's would paint a spike)
    if (dot(-pE, uE) > 0.0 && length(pE) <= halfW * (max(miterLimit, 1.0) + 1.0) + seR && (joinStyle != 4 || (tE == 0.0 ? freeStart : freeEnd))) {
      if (nC == 1) { cT1 = tE; cD1 = length(pE); cQ1 = pE; cU1 = fromEnd ? 1.0 - tE : tE; }
      else { cT2 = tE; cD2 = length(pE); cQ2 = pE; cU2 = fromEnd ? 1.0 - tE : tE; }
      nC++;
    }
  }
  float md = 1e30;
  float t0 = t, d0 = thisD;
  vec2 g0 = g;
  for (int k = 0; k < nC; k++) {
    float tK = k == 0 ? t0 : (k == 1 ? cT1 : cT2), dK = k == 0 ? d0 : (k == 1 ? cD1 : cD2);
    vec2 gK = k == 0 ? g0 : (k == 1 ? cG1 : cG2);
    bool endK = k > 0 && (tK == 0.0 || tK == 1.0);
    float aK = k == 0 ? arcLenAtT : ((dashId > 0) ? quadArcLen(p1, p2, p3, tK) : 0.0);
    vec2 tanK = tanT;
    if (k > 0) {
      tanK = vec2(0.0);
      if (dashId > 0) { tanK = endK ? strokeUnit(mix(p2 - p1, p3 - p2, tK)) : strokeUnit(mix(p2 - p1, p3 - p2, tK)); if (dot(tanK, tanK) == 0.0) tanK = strokeUnit(tK < 0.5 ? dStart : dEnd); }
    }
    vec4 eP2, eQ2;
    float mdK = strokeCapsJoinsDash(tK, dK, p1, p3, dStart, dEnd,
                                    freeStart, freeEnd, startCap, endCap,
                                    joinStyle, miterLimit, halfW, inTan, outTan,
                                    dashId, startDist,
                                    aK, curv, minDIn, gK, tanK,
                                    (dashId > 0) ? startDist + quadArcLen(p1, p2, p3, 1.0) : 1e30,
                                    seR, eP2, eQ2);
    if (k == 0 || mdK < md) {
      md = mdK; edgeP = eP2; edgeQ = eQ2; g = gK;
      if (k > 0) { u = k == 1 ? cU1 : cU2; q = k == 1 ? cQ1 : cQ2; t = tK; thisD = dK; }
    }
  }
  gradOut = g;
  return md;
}
