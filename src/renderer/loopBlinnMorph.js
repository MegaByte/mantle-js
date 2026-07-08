// loopBlinnMorph.js — GPU-resident Loop-Blinn morph. Builds the LB topology
// ONCE from two matched endpoint shapes and lerps everything on the GPU: the
// vertex shader (loopBlinnMorph.vert.glsl) interpolates control points by a
// `uT` uniform and RECOMPUTES the per-curve klmn implicit (cubics) and
// straight-edge normals (strips) every frame — so an animated morph reuses one
// static mesh with ZERO CPU rebuild.
//
// Only valid when src↔dst share LB topology: same earcut triangulation, same
// per-curve classification (quad/cubic counts + hull shapes), no loop/cusp
// fallback and no Bezout-fallback cubic (those can't be recomputed cheaply in
// the VS). `build()` returns null in any of those cases so the caller falls
// back to the CPU shapeMorph. Classification is also assumed STABLE across the
// whole [0,1] sweep (a curve that flips convexity or passes through a cusp
// mid-morph can glitch at that t) — true for bounded deforms, matching the
// CPU refresh's fixed-topology assumption.

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

// Interim: the signed (Kokojima) + stroke morph builders here don't carry the
// rational-quadratic implicit (kind 5) the static/fast LB path uses for arcs, so
// convert each arc rquad to a cubic on the way in. Every rquad is already ≤90°,
// so one interpolating cubic per piece matches the old arcToCubics quality
// exactly. This local conversion dies with the Kokojima path (see
// [[lb-cdt-proper-fill]]); the primary LB path renders arcs natively.
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

// Lean morph VBO: 10 floats / vertex. Solid fill only (paint via uColor).
//   loc0 aPosSrc vec2  (0)   em-space position at t=0
//   loc1 aPosDst vec2  (2)   em-space position at t=1
//   loc2 aFlags  vec2  (4)   (kind, sign)
//   loc3 aParam  vec4  (6)   quad:(u,v,_,_) · cubic:(primTexel,ctrlIdx,_,_)
//                            · strip:(primTexel,dilate,outwardSign,_)
//   kind: 0 interior · 1 quad · 2 cubic-klmn · 3 edge-strip.
const PRIM_TEX_W = 512;            // primData texel width
const QUAD_UV = [0, 0, 0.5, 0, 1, 1];
// Cubic: fixed 4-control-point fan (always 2 tris) — robust to hull degeneracy
// since k,l,m are affine, so any triangulation of the control quad interpolates
// identically (a collinear control point just yields a zero-area triangle).
// Strip: 6 verts (2 tris); each entry = [endpoint (0=p1,1=p2), dilate flag].
const STRIP = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];

/**
 * FAST path: the additive 1-pass-direct morph. Reuses the static LB tiling
 * (earcut interior + classified curve crescents), so it's only valid when src↔
 * dst share topology AND per-curve classification (no convex↔concave flip, no
 * inflection-count change, no triangle fold, no loop/cusp). Returns null in any
 * of those cases → the dispatcher falls back to the SIGNED path.
 */

// Emit the GPU-morph VBO (+ prim texels) from two topology-matched LB meshes
// (src @ t=0, dst @ t=1). Shared by the earcut FAST path and the CDT holed path
// (buildCDTMorph). Position lerps per vertex; cubic klmn / strip normals
// recompute in the VS; quad/rquad texcoords are position-independent.
// Build ONE build-once GPU mesh for a CLASSIFICATION-STABLE morph interval:
// the earcut additive fast path (opaque non-holed) else the CDT partition
// (curved holes / translucency / fast-path bail). Returns { mode:'fast', vbo,
// vertexCount, prim, primW, primH } or null if the interval isn't stable (a
// curve flips convex↔concave / gains an inflection / becomes a loop-cusp within
// it, or structure mismatch). `forceSigned` skips the additive path → CDT (for
// translucent fills — the additive path needs coverage to compose under OVER,
// exact only at α=1, whereas the CDT is a non-overlapping partition, exact at
// any α). The signed 2-pass Kokojima path this hybrid once used is gone.
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
// sub-intervals, each a build-once GPU mesh selected + t-remapped at draw time
// (drawLoopBlinnMorph / _renderMorphCovRT). The builder itself is the oracle:
// buildStableMorph(@a,@b) is non-null iff [a,b] is stable, so a coarse scan +
// bisection locates every flip time. Each interval's baked sign/topology is taken
// a small MARGIN inside it (build range [tLoB,tHiB]) — the exact flip is a
// STRAIGHT configuration where the sign is ambiguous — while its geometry spans
// the full draw range [tLo,tHi]: the draw remaps t into [tLoB,tHiB] UNCLAMPED, so
// the linear VS lerp EXTRAPOLATES to the exact shape across the seam (no frozen
// frame). The margin is capped at ¼ the interval width so that extrapolation
// stays bounded (localT ∈ [-0.5,1.5]) and never folds the reused triangulation.
// Returns { segments:[{tLo,tHi,tLoB,tHiB,...meshFields}] } or null (genuine
// loop/cusp, too many changes, or a non-monotone interval that fails the interior
// stability guard → Slug).
// PAIR-side interval split: the same flip-partition algorithm with the PARTITION
// PAIR as both the stability oracle and the builder — a flip morph becomes
// t-segmented pair meshes (each sub-interval reproduces the global lerp
// exactly), retiring the legacy path for the flip class. Returns
// [{tLo,tHi,tLoB,tHiB,pair}] or null (no flips found / too many / unstable).
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



/**
 * Build the GPU morph for two matched contour sets. A classification-STABLE
 * morph returns ONE mesh { mode:'fast', vbo, vertexCount, prim, primW, primH }.
 * A classification-CHANGING morph (a curve flips convex↔concave, gains an
 * inflection, …) can't use a single build-once mesh — its baked sign/topology
 * would be wrong past the change — so it's INTERVAL-SPLIT into stable pieces and
 * returned as { segments:[…], mode:'fast', vertexCount }, which the draw path
 * selects + t-remaps per frame (still 1-pass, still GPU-resident, zero shader
 * change). Returns null only for a genuine loop/cusp, too many changes, or
 * structure mismatch → the caller routes those to Slug. `forceSigned` skips the
 * additive fast path → CDT (translucent fills).
 */


// PROPER-LB morph for CURVED-HOLED shapes (rings, glyph counters): build the CDT
// topology once from src (holes removed at build time) and lerp positions in the
// VS — the same GPU-resident 1-pass path the earcut fast morph uses, but with
// holes handled correctly, so it REPLACES the signed 2-pass (Kokojima) path for
// this class. Arcs stay native (rational quads, kind 5 — no _noRQuad). Returns
// null (→ caller routes to Slug) for structure mismatch, cubic curve
// triangles, or a classification-changing morph. Because the CDT is a
// NON-overlapping partition, its 1-pass-direct composite is exact at any α — so
// it serves BOTH curved holes AND translucent fills (this is why it replaced the
// signed 2-pass path for translucency too, not just holes).


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
