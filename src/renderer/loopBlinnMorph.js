// loopBlinnMorph.js — GPU-resident Loop-Blinn morph builders. Each builds the
// LB topology ONCE from two matched endpoint shapes and lets the GPU lerp
// everything: the morph-pair vertex shader interpolates control points by a
// `uT` uniform and RECOMPUTES the per-curve implicit frames every frame — so
// an animated morph reuses one static mesh with ZERO CPU rebuild.
//
// Exports: buildEarcutPair (cheap pair for the single-contour opaque class),
// segmentPartitionPairMorph (t-segmented partition pairs for classification-
// flipping morphs) and buildMorphStroke (GPU-resident stroke coverage). Each
// is only valid when src↔dst share structure (same triangulation / per-curve
// classification / segment counts) and returns null otherwise, so the caller
// falls back to the partition pair or Slug.

import { buildLoopBlinnPartitionPair, buildLoopBlinnMesh, refreshLoopBlinnMesh } from './loopBlinn.js';

// EARCUT pair — the morph twin of the STATIC earcut fast path, in the same
// places the static route uses it (single-contour, opaque-composable): build
// the src with the static earcut builder and the dst with the static
// fixed-topology REFRESH. When the refresh reuses the src triangulation
// verbatim (same tris array ⇒ rim structure + turn signs matched) the two
// meshes are structurally identical and pack into the same dual-stream pair
// VBO as the partition pair — 2-4× cheaper to build, fewer vertices to draw.
// Any structure drift (re-triangulation, count change, loop/cusp, Bezout)
// returns null → the partition pair takes it.
export function buildEarcutPair(srcContours, dstContours) {
  if (!srcContours || srcContours.length !== 1 || !dstContours || dstContours.length !== 1) return null;
  let src = null, dst = null;
  try {
    src = buildLoopBlinnMesh(srcContours, true);
    // Whole-shape circle/ellipse SDF records (kind 7): pair by building the dst
    // mesh independently — record geometry is synthesized (six verts per record
    // on each side, no seg-point provenance needed). The pair VS lerps aC3
    // (centre, radius) and aC0 (ry, cosφ, sinφ) linearly, which reproduces the
    // control-point-lerped contour EXACTLY when the two contours are SAME-PHASE
    // (corresponding on-curve points at matching angles) and, for ellipses,
    // same-φ (cos/sin do not lerp as a rotation). Any mismatch → null, and the
    // partition pair serves the morph as generic crescents + bands instead.
    if (src && src.circles && src.circles.length) {
      let dstC = null;
      try { dstC = buildLoopBlinnMesh(dstContours, true); } catch { dstC = null; }
      if (!dstC || !dstC.circles || dstC.circles.length !== src.circles.length) return null;
      const cs = src.circles[0], cd = dstC.circles[0];
      if ((cs.rx != null) !== (cd.rx != null)) return null;
      if (cs.rx != null && Math.abs((cs.phi || 0) - (cd.phi || 0)) > 1e-6) return null;
      const unit9 = (p, c) => {
        let vx = p[0] - c.cx, vy = p[1] - c.cy;
        if (c.rx != null) {
          const co = Math.cos(c.phi || 0), si = Math.sin(c.phi || 0);
          const qx = (vx * co + vy * si) / Math.max(c.rx, 1e-12);
          const qy = (-vx * si + vy * co) / Math.max(c.ry, 1e-12);
          vx = qx; vy = qy;
        }
        const L = Math.hypot(vx, vy);
        return L > 1e-12 ? [vx / L, vy / L] : null;
      };
      const sc9 = srcContours[0], dc9 = dstContours[0];
      if (sc9.length !== dc9.length) return null;
      for (let i = 0; i < sc9.length; i++) {
        const us = unit9(sc9[i].p1, cs), ud = unit9(dc9[i].p1, cd);
        if (!us || !ud || Math.abs(us[0] - ud[0]) + Math.abs(us[1] - ud[1]) > 2e-3) return null;
      }
      return { src, dst: dstC };
    }
    dst = src ? refreshLoopBlinnMesh(src, dstContours) : null;
  } catch { return null; }
  if (!src || !dst || !src._topo || !dst._topo) return null;
  if (dst._topo.tris !== src._topo.tris) return null;          // re-triangulated → correspondence lost
  if (src.fallback.length || dst.fallback.length) return null; // loop/cusp → Slug/partition
  if (src.hasConcave || dst.hasConcave) return null;           // the static route's own earcut gate
  if (src.quads.length !== dst.quads.length || src.cubics.length !== dst.cubics.length
      || src.edges.length !== dst.edges.length || src.interior.length !== dst.interior.length) return null;
  for (const c of src.cubics) if (!c.klmn) return null;        // Bezout pieces don't lerp
  for (const c of dst.cubics) if (!c.klmn) return null;
  return { src, dst };
}
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_RQUAD, mkCubic } from '../primitives/seg.js';

// The stroke morph builder here doesn't carry the rational-quadratic implicit
// (kind 5) the LB fill path uses for arcs, so convert each arc rquad to a
// cubic on the way in. Every rquad is already ≤90°, so one interpolating
// cubic per piece is sub-pixel accurate. The LB fill path renders arcs
// natively.
function rquadToCubic(rq) {
  const P0 = rq.p1, P1 = rq.p2, P2 = rq.p3, w = rq.w;
  const at = t => { const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t * w, c = t * t, d = a + b + c;
    return [(a * P0[0] + b * P1[0] + c * P2[0]) / d, (a * P0[1] + b * P1[1] + c * P2[1]) / d]; };
  const Qa = at(1 / 3), Qb = at(2 / 3);
  const c1 = [(-5 * P0[0] + 18 * Qa[0] - 9 * Qb[0] + 2 * P2[0]) / 6, (-5 * P0[1] + 18 * Qa[1] - 9 * Qb[1] + 2 * P2[1]) / 6];
  const c2 = [(2 * P0[0] - 9 * Qa[0] + 18 * Qb[0] - 5 * P2[0]) / 6, (2 * P0[1] - 9 * Qa[1] + 18 * Qb[1] - 5 * P2[1]) / 6];
  return mkCubic(P0, c1, c2, P2);
}
const _noRQuad = contours => contours && contours.map(c => c.map(s => s.type === SEG_RQUAD ? rquadToCubic(s) : s));

const PRIM_TEX_W = 512;            // primData texel width (buildMorphStroke's data texture)
const QUAD_UV = [0, 0, 0.5, 0, 1, 1];
const STRIP = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];

// Lerp two matched contour sets to parameter t (linear control-point interp;
// carries seg type + rquad weight). Because the morph VS lerps positions
// LINEARLY, interpolating the endpoint shapes at an interior t and re-lerping a
// sub-interval reproduces the global lerp EXACTLY — the basis of interval-split.
function lerpContours(sc, dc, t) {
  if (t <= 0) return sc;
  if (t >= 1) return dc;
  const u = 1 - t, lp = (a, b) => [a[0] * u + b[0] * t, a[1] * u + b[1] * t];
  return sc.map((cs, ci) => cs.map((ss, si) => {
    const ds = dc[ci][si], o = { type: ss.type, p1: lp(ss.p1, ds.p1) };
    if (ss.w != null) o.w = ss.w;
    if (ss.p2) o.p2 = lp(ss.p2, ds.p2);
    if (ss.p3) o.p3 = lp(ss.p3, ds.p3);
    if (ss.p4) o.p4 = lp(ss.p4, ds.p4);
    return o;
  }));
}

const MORPH_SEG_MAX = 6;      // > this many classification changes in one morph → Slug
const SEG_MARGIN = 0.04;      // bake each interval's sign a margin inside it (see below)

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
  const build = (a, b) => { builds9++; return buildLoopBlinnPartitionPair(lerpContours(sc, dc, a), lerpContours(sc, dc, b), fillRule, { plainDstRows: true }); };
  const ok = (a, b) => { if (builds9 > BUILD_CAP9) return false; try { return !!build(a, b); } catch { return false; } };
  const N = 24, flips = [];
  let failCells = 0;
  for (let i = 0; i < N; i++) {
    const a = i / N, b = (i + 1) / N;
    if (ok(a, b)) continue;
    // permanently-unservable shapes fail EVERY cell — cap the bisection work
    if (++failCells > MORPH_SEG_MAX || builds9 > BUILD_CAP9) return null;
    let lo = a, hi = b;
    for (let k = 0; k < 12; k++) { const m = (lo + hi) / 2; if (ok(a, m)) lo = m; else hi = m; }
    const f = (lo + hi) / 2;
    if (!flips.length || f - flips[flips.length - 1] > 0.02) flips.push(f);
  }
  if (builds9 > BUILD_CAP9) return null;
  if (!flips.length || flips.length + 1 > MORPH_SEG_MAX) return null;
  const bp = [0, ...flips, 1], segs = [];
  for (let i = 0; i < bp.length - 1; i++) {
    const tLo = bp[i], tHi = bp[i + 1], w = tHi - tLo, m = Math.min(SEG_MARGIN, w * 0.25);
    const tLoB = i === 0 ? tLo : tLo + m;
    const tHiB = i === bp.length - 2 ? tHi : tHi - m;
    if (!(tHiB > tLoB)) return null;
    let pair = null;
    try { pair = build(tLoB, tHiB); } catch { pair = null; }
    const mid = (tLoB + tHiB) / 2;
    if (!pair || !ok(tLoB, mid) || !ok(mid, tHiB)) return null;
    segs.push({ tLo, tHi, tLoB, tHiB, pair });
  }
  return segs;
}

// ── STROKE coverage mesh ──────────────────────────
// Per outline SEGMENT, emit a band quad (6 verts) covering its stroke
// neighborhood; the stroke VS lerps the segment's control points by uT and the
// frag ANALYTICALLY distance-fields the morphed curve (closest-point via Newton
// on the curve param — no flattening), MAX-unioned → stroke coverage with ZERO
// per-frame curve upload (the GPU-resident stroke). Plus a miter-wedge primitive
// per interior join (when joinStyle=miter) and butt/square/round cap logic.
// Every segment is degree-elevated to a cubic so one (P0..P3) hull is uniform:
//   line  (a,b)   → (a, a+⅓(b−a), a+⅔(b−a), b)
//   quad  (a,c,b) → (a, a+⅔(c−a), b+⅔(c−b), b)
// (both reproduce the SAME curve, so the distance field is exact for them).
// Returns { vbo, vertexCount, prim, primW, primH } or null when src↔dst don't
// share segment structure (the morph route then leaves the shape on Slug).
function elevateToCubic(seg) {
  if (seg.type === SEG_CUBIC) return [seg.p1, seg.p2, seg.p3, seg.p4];
  if (seg.type === SEG_QUAD) {
    const a = seg.p1, c = seg.p2, b = seg.p3;
    return [a, [a[0] + 2 / 3 * (c[0] - a[0]), a[1] + 2 / 3 * (c[1] - a[1])],
               [b[0] + 2 / 3 * (c[0] - b[0]), b[1] + 2 / 3 * (c[1] - b[1])], b];
  }
  const a = seg.p1, b = seg.p2;
  return [a, [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3],
             [a[0] + 2 * (b[0] - a[0]) / 3, a[1] + 2 * (b[1] - a[1]) / 3], b];
}
const _strokeClose = (a, b) => Math.abs(a[0] - b[0]) <= 1e-3 && Math.abs(a[1] - b[1]) <= 1e-3;
export function buildMorphStroke(srcContoursRaw, dstContoursRaw, opts) {
  const srcContours = _noRQuad(srcContoursRaw), dstContours = _noRQuad(dstContoursRaw);
  if (!srcContours || !dstContours || srcContours.length !== dstContours.length) return null;
  // Pre-elevate every segment (src + dst) to a cubic; validate matched structure.
  const elev = [];   // per contour: { S:[cubic…], D:[cubic…], closed }
  let nSeg = 0;
  for (let c = 0; c < srcContours.length; c++) {
    const sc = srcContours[c], dc = dstContours[c];
    if (!sc || !dc || sc.length !== dc.length || !sc.length) return null;
    const S = [], D = [];
    for (let s = 0; s < sc.length; s++) {
      if (sc[s].type !== dc[s].type) return null;
      S.push(elevateToCubic(sc[s])); D.push(elevateToCubic(dc[s])); nSeg++;
    }
    // Closed when the last segment's endpoint meets the first's start (src AND dst).
    const closed = _strokeClose(S[S.length - 1][3], S[0][0]) && _strokeClose(D[D.length - 1][3], D[0][0]);
    elev.push({ S, D, closed });
  }
  if (!nSeg) return null;
  // ONE band per segment (6 texels): own cubic (4) + prevP2 src/dst (1) + nextP1
  // src/dst (1). The frag's strokeCapsJoinsDash port handles caps + miter/round/
  // bevel joins analytically from the morphed neighbour tangents — no separate
  // join/cap primitives. Free-end flags ride the VBO.
  const PW = PRIM_TEX_W, texelCount = nSeg * 6;
  const PH = Math.max(1, Math.ceil(Math.max(1, texelCount) / PW));
  const prim = new Float32Array(PW * PH * 4);
  const v = new Float32Array(nSeg * 6 * 4);   // 6 verts × (primBase, corner, segFlags, contourStart)
  const CORNERS = [0, 1, 2, 0, 2, 3];
  let o = 0, texel = 0;
  const setTexel = (idx, a, b, c, d) => { const w = idx * 4; prim[w] = a; prim[w + 1] = b; prim[w + 2] = c; prim[w + 3] = d; };
  const put = (base, ci, flags, cStart) => { v[o] = base; v[o + 1] = ci; v[o + 2] = flags; v[o + 3] = cStart; o += 4; };
  for (const { S, D, closed } of elev) {
    const n = S.length;
    const contourStart = texel;   // texel base of this contour's first segment (dash phase resets here per subpath, matching Slug)
    for (let s = 0; s < n; s++) {
      const Sc = S[s], Dc = D[s], base = texel;
      const freeStart = !closed && s === 0, freeEnd = !closed && s === n - 1;
      // Neighbour control points giving the join tangents (dummy = own endpoint at
      // a free end → inTan/outTan inert, the frag takes the cap branch there).
      const Ps = freeStart ? Sc[0] : S[(s - 1 + n) % n][2];   // prevP2.src
      const Pd = freeStart ? Dc[0] : D[(s - 1 + n) % n][2];   // prevP2.dst
      const Ns = freeEnd ? Sc[3] : S[(s + 1) % n][1];         // nextP1.src
      const Nd = freeEnd ? Dc[3] : D[(s + 1) % n][1];         // nextP1.dst
      setTexel(base,     Sc[0][0], Sc[0][1], Sc[1][0], Sc[1][1]);
      setTexel(base + 1, Sc[2][0], Sc[2][1], Sc[3][0], Sc[3][1]);
      setTexel(base + 2, Dc[0][0], Dc[0][1], Dc[1][0], Dc[1][1]);
      setTexel(base + 3, Dc[2][0], Dc[2][1], Dc[3][0], Dc[3][1]);
      setTexel(base + 4, Ps[0], Ps[1], Pd[0], Pd[1]);
      setTexel(base + 5, Ns[0], Ns[1], Nd[0], Nd[1]);
      texel += 6;
      const flags = (freeStart ? 1 : 0) | (freeEnd ? 2 : 0);
      for (const ci of CORNERS) put(base, ci, flags, contourStart);
    }
  }
  return { vbo: v, vertexCount: nSeg * 6, prim, primW: PW, primH: PH };
}
