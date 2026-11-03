// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { snapBoundaryNodes, spatialBoundaryCells } from '../core/localPolynomialPaint.js';

import { CP_BLOCK_TEXELS, CP_MORPH_C_FLOATS } from './cpatchLayout.js';
export { CP_BLOCK_TEXELS, CP_MORPH_C_FLOATS } from './cpatchLayout.js';

import { certifySimplePolynomialPaint, packSimplePolynomialPaint } from './cpatchSimpleArea.js';
// Pack CPatch cells into the24-float shared fill vertex layout.
// Vertex aC3.xy stores the cell's (first,count) constraint-block range.
// Each constraint uses CP_BLOCK_TEXELS RGBA32F texels: implicit coefficients,
// kind/sign, bounds, seam data and optional native arc parameters.

import {
  convertContourSplit,
  replayContour,
  translatePatches,
  loopSignedArea,
  framePatch,
} from './cpatchConvert.js';
import { traceKeyHash } from './cpatchTrace.js';
import {
  convexQuadraticSign,
  segImplicitPacked,
  packedEval,
  packedEvalF32,
  segTightBBox,
  segImplicit,
  K_IMPL,
  K_PK,
} from '../geom/cpatchImplicit.js';
import {
  patchCoverHull,
  patchCoverLines,
  gridSplitPatch,
  insideContour,
  insideRule,
  interiorPoint,
  patchBBox,
  segAffMin,
  patchLeaksInBox,
} from './cpatchConvert.js';
import {
  segPt,
  segRev,
  segStart,
  segEnd,
  CPK_LINE,
  CPK_QUAD,
  K_COMP,
  K_FRAME,
} from '../geom/cpatchImplicit.js';
import { pathToCycles, groupContours, bridgeHoles } from '../geom/cpatchGraph.js';
// cpatchCov and this module import each other. Access shared bindings only
// inside functions so both import orders finish initialization before use.
import {
  shapeUnderCovers,
  arcEndFlags,
  markSeamCorners,
  markSeamEnds,
  K_SEAMEND,
} from './cpatchCov.js';
import { resolveSelfOverlap } from './shapeResolve.js';
import {
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  SEG_RQUAD,
  mkLine,
  mkQuad,
  mkCubic,
  mkRQuad,
} from '../primitives/seg.js';
import { mantleDebugHook } from '../core/diagnostics.js';
// A patch's morph corner bits (cpatchCov.arcEndFlags), one per curve. A function, so nothing reads the other module at
// load (see the note on the cpatchCov import).
/// A straight seam's six-plus-two leg numbers in the order its row stores them (texels 1, 2, 4): end 0's own leg (x, y) and
/// other leg x; the other leg y and end 1's own leg; end 1's other leg. ends = markSeamEnds' [end0, end1], each null or
/// [ownx, owny, othx, othy].
export function seamLegs(ends) {
  const a = ends[0] || [0, 0, 0, 0],
    b = ends[1] || [0, 0, 0, 0];
  return [a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]];
}
const arcFlagsOf = (p) => p.curves.map((_, i) => arcEndFlags(p, i));

export { groupContours, bridgeHoles } from '../geom/cpatchGraph.js';

// Must match CP_STREAM_TAG in the CPatch coverage and vertex shaders.
export const CPATCH_STREAM_TAG = 14;
export const LB_STRIDE = 24;
// The cut bit marks seams independently of their line, quadratic or cubic kind.
const CPK_CUT_BIT = 8;

const CP_BLOCK_FLOATS = CP_BLOCK_TEXELS * 4;

/// How finely the kernel's cover hull follows the curves. Not the patch's validity cover.
export const CP_KERNEL_HULL_SAMPLES = 16;

// Sample count shared with the hull-row gate's coverage diagnostics.
export const CP_HULL_ROW_SAMPLES = 6;
/// The packer's own record of the hull-row gate, per patch: whether this patch kept its fencing
/// rows. Read by the CPU coverage model (cpatchCov) and by probes/cpatchGate; carried on a Symbol
/// so a patch's enumerable fields do not change.
export const K_ROWS = Symbol('cp.rows');
/// A patch packed in its contour's frame points at the world patch onPatches handed out, so a
/// decision the packer records on it reaches the readers of that one.
const K_WORLD = Symbol('cp.world');
/// A hard cover-hull bound: it fences the cover quad's dilation without clipping the patch's own
/// AA band. Must match the kraw > 13.5 test in _cpatchCoverage.glsl.
const CPK_HULL_BOUND = 14;
const CPK_HULL_HARD = 16;

///
/// "nothing ACROSS" IS ASKED OF THE SHAPE, not of this contour's patches: the front end hands a shape over as groups
/// of cycles packed one at a time, so the far side of a stretch can be another group's patch (in text, consulting only
/// this contour's seams would leave pixels under-painted where both sides ramp). A stretch becomes
/// outline only where points just across it -- at a quarter, a half and three quarters of each piece between the
/// shape's own vertices on the line -- are outside the shape by its own fill rule (`fill`, from packShapeFrom); a
/// caller that passes none splits nothing.
///
const SEAM_COLINEAR_REL = 1e-3,
  SEAM_GAP_REL = 2e-2;
export function splitPartialSeams(patches, fill) {
  if (!fill || !fill.curves || !fill.curves.length) return patches;
  // every cut is a candidate far piece -- a straight one may be packed as a curve whose control points are collinear --
  // and only the straight ones are split
  const cuts = [];
  patches.forEach((p, pi) =>
    p.curves.forEach((c, ci) => {
      if (c.cut)
        cuts.push({ pi, ci, a: c.P[0], b: c.P[c.P.length - 1], P: c.P, line: c.P.length === 2 });
    }),
  );
  if (!cuts.some((c) => c.line)) return patches;
  const edits = new Map(); // patch index -> Map(curve index -> pieces)
  for (const S of cuts) {
    if (!S.line) continue;
    const dx = S.b[0] - S.a[0],
      dy = S.b[1] - S.a[1],
      L2 = dx * dx + dy * dy;
    if (!(L2 > 0)) continue;
    const L = Math.sqrt(L2),
      tol = SEAM_COLINEAR_REL * L;
    const lo = [Math.min(S.a[0], S.b[0]) - tol, Math.min(S.a[1], S.b[1]) - tol],
      hi = [Math.max(S.a[0], S.b[0]) + tol, Math.max(S.a[1], S.b[1]) + tol];
    const off = (q) => ((q[0] - S.a[0]) * dy - (q[1] - S.a[1]) * dx) / L,
      par = (q) => ((q[0] - S.a[0]) * dx + (q[1] - S.a[1]) * dy) / L2;
    const iv = [];
    for (const T of cuts) {
      if (T.pi === S.pi) continue;
      if (
        Math.max(T.a[0], T.b[0]) < lo[0] ||
        Math.min(T.a[0], T.b[0]) > hi[0] ||
        Math.max(T.a[1], T.b[1]) < lo[1] ||
        Math.min(T.a[1], T.b[1]) > hi[1]
      )
        continue;
      if (!((T.b[0] - T.a[0]) * dx + (T.b[1] - T.a[1]) * dy < 0)) continue; // the far side runs the other way
      if (T.P.some((q) => Math.abs(off(q)) > tol)) continue;
      const ua = par(T.a),
        ub = par(T.b);
      iv.push(ua <= ub ? [ua, ub, T.a, T.b] : [ub, ua, T.b, T.a]);
    }
    iv.sort((u, v) => u[0] - v[0]);
    // the stretches of [0, 1] no far piece covers, each with the far points that bound it
    const gaps = [];
    let at = 0,
      atP = S.a;
    for (const [u0, u1, p0, p1] of iv) {
      if (u0 - at > SEAM_GAP_REL) gaps.push([at, u0, atP, p0]);
      if (u1 > at) {
        at = u1;
        atP = p1;
      }
    }
    if (1 - at > SEAM_GAP_REL) gaps.push([at, 1, atP, S.b]);
    if (!gaps.length) continue;
    // ...and only where the shape is empty across it: the side away from this patch's interior point. A gap can run
    // past a stretch the shape DOES fill across -- another group's patch, which this contour's cuts cannot see: on
    // text64's 'a' the stem's seam has the arch across its top, the bowl's top cycle across its middle, and nothing
    // across the two stretches between (the counter and the bowl's hole). So a gap is first cut where the shape's own
    // vertices lie on the seam's line, each stretch is asked on its own, and neighboring empty stretches rejoin.
    const ins = patches[S.pi].inside,
      side = ins ? Math.sign((ins[0] - S.a[0]) * dy - (ins[1] - S.a[1]) * dx) : 0;
    if (side === 0) continue;
    const nx = side > 0 ? -dy / L : dy / L,
      ny = side > 0 ? dx / L : -dx / L,
      h = SEAM_COLINEAR_REL * L;
    const empty = (u0, u1) =>
      [0.25, 0.5, 0.75].every((f) => {
        const u = u0 + (u1 - u0) * f;
        return !insideRule(
          fill.curves,
          S.a[0] + dx * u + nx * h,
          S.a[1] + dy * u + ny * h,
          !!fill.evenOdd,
        );
      });
    const verts = [];
    for (const sg of fill.curves)
      for (const q of [sg.P[0], sg.P[sg.P.length - 1]]) {
        if (Math.abs(off(q)) > tol) continue;
        const u = par(q);
        if (u > 0 && u < 1) verts.push([u, q]);
      }
    verts.sort((u, v) => u[0] - v[0]);
    const runs = [];
    for (const [u0, u1, p0, p1] of gaps) {
      const at_ = [[u0, p0], ...verts.filter(([u]) => u > u0 && u < u1), [u1, p1]];
      let run = null;
      for (let k = 0; k + 1 < at_.length; k++) {
        const [a, pa] = at_[k],
          [b, pb] = at_[k + 1];
        if (!(b > a)) continue;
        if (empty(a, b)) {
          if (run) {
            run[1] = b;
            run[3] = pb;
          } else run = [a, b, pa, pb];
        } else if (run) {
          runs.push(run);
          run = null;
        }
      }
      if (run) runs.push(run);
    }
    gaps.length = 0;
    for (const r of runs) if (r[1] - r[0] > SEAM_GAP_REL) gaps.push(r);
    if (!gaps.length) continue;
    // the pieces, S.a to S.b: the covered stretches stay seams, the gaps become outline
    // Merge gap endpoints within 1e-9 of the seam length to avoid near-zero cut edges.
    const same = (p, q) => p === q || Math.hypot(p[0] - q[0], p[1] - q[1]) <= 1e-9 * L;
    const pieces = [];
    let from = S.a;
    for (const [u0, u1, g0, g1] of gaps) {
      let a0 = u0 <= 0 ? S.a : g0,
        a1 = u1 >= 1 ? S.b : g1;
      if (same(a0, from)) a0 = from;
      if (same(a1, S.b)) a1 = S.b;
      if (a0 !== from) pieces.push({ t: 'line', P: [from, a0], cut: true });
      pieces.push({ t: 'line', P: [a0, a1], cut: false });
      from = a1;
    }
    if (from !== S.b) pieces.push({ t: 'line', P: [from, S.b], cut: true });
    let e = edits.get(S.pi);
    if (!e) edits.set(S.pi, (e = new Map()));
    e.set(S.ci, pieces);
  }
  if (!edits.size) return patches;
  return patches.map((p, pi) => {
    const e = edits.get(pi);
    if (!e) return p;
    const curves = [];
    p.curves.forEach((c, ci) => {
      if (e.has(ci)) curves.push(...e.get(ci));
      else curves.push(c);
    });
    return framePatch(curves, p.inside) || p;
  });
}

/// The arc's CROSS-CHORD STRIP: the chord's unit normal, and the arc's exact support on either
/// side of the chord's own line. Both offsets come from the same exact support the cover's planes
/// use, so the strip is tight against the arc and holds it entirely. A degenerate chord (the two
/// endpoints coincident) has no direction to give, and reports a strip nothing lies outside of.
function chordStrip(seg) {
  const a = segStart(seg),
    b = segEnd(seg);
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    L = Math.hypot(dx, dy);
  let ex = 0;
  for (const q of seg.P) {
    const u = Math.abs(q[0] - a[0]),
      v = Math.abs(q[1] - a[1]);
    if (u > ex) ex = u;
    if (v > ex) ex = v;
  }
  if (!(L > 1e-12 * ex)) return [0, 0, -1e30, 1e30];
  const nx = -dy / L,
    ny = dx / L;
  return [nx, ny, segAffMin(seg, nx, ny).m, -segAffMin(seg, -nx, -ny).m];
}
/// THE ARC'S DEGREE, TAGGED ON THE WIRE RATHER THAN INFERRED. Bit 5 of the kind says the arc has
/// THREE control points, so the kernel evaluates the curve it actually has -- the same rule the
/// stroke shaders follow, where a quadratic is a quadratic and not an elevated cubic.

/// A PROPERTY OF THE SEGMENT, asked in ONE place, so the packer and the model cannot drift.
export const arcIs3 = (seg) => seg.t === 'rquad' || seg.P.length === 3;
/// Kinds 0-17 are taken (0-5 curves, +8 cut, 14-17 hull and separator); this is bit 5, which leaves
/// 18-31 free for kinds. Must match CP_ARC3 in _cpatchCoverage.glsl.
export const CPK_ARC3 = 32;
/// The arc itself, in two texels: (P0, P1) and (P2, P3) for a cubic, or (P0, P1) and (P2, w, 0) for
/// a three-point arc, whose weight is 1 unless it is a rational quadratic. Twin of arcGeom in
/// cpatchCov, which must stay identical to it.
export function arcTexels(seg) {
  const P = seg.P;
  if (arcIs3(seg)) {
    const w = seg.t === 'rquad' && seg.w != null ? seg.w : 1;
    return [P[0][0], P[0][1], P[1][0], P[1][1], P[2][0], P[2][1], w, 0];
  }
  if (P.length >= 4)
    return [P[0][0], P[0][1], P[1][0], P[1][1], P[2][0], P[2][1], P[3][0], P[3][1]];
  // A LINE'S TWO ENDS, (P0, P1), and nothing in the second texel. Its implicit IS its line, so the kernel's linear
  // fast path reads them only where the line meets a seam at a corner (CPK_END), to find which side of the corner a
  // fragment is on.
  return [P[0][0], P[0][1], P[1][0], P[1][1], 0, 0, 0, 0];
}
const CPK_HULL_RAMP = 17;
/// A SEAM THAT CARRIES ITS COMPANION (K_COMP): added to a cut row's kind word, twice over when the
/// companion has three control points. Must match CP_COMP in _cpatchCoverage.glsl.
export const CPK_COMP = 64;
/// A HORN ARC (K_HORN): the kind word's bits 12 and 13 say it ends at its own curve's cusp at t = 0 and
/// t = 1, and bit 14 that the patch's inside is on the arc's RIGHT (the patch loop runs clockwise). Must match
/// CP_HORN in _cpatchCoverage.glsl.
export const CPK_HORN0 = 4096,
  CPK_HORN1 = 8192,
  CPK_HORN_RIGHT = 16384;
/// A morph's corners: the kind word's bits 8-11 on a morph pack's outline curves, cpatchCov.markSeamCorners'
/// four bits -- squared seam corners at the curve's start and end, where a static skirt would stop and the kernel
/// stops the patch instead, and outline corners there, past which a line's box floor does not hold. A static pack writes
/// none of them. Must match CP_END in _cpatchCoverage.glsl.
export const CPK_END = 256;
/// A complete-paint curve: bit 17 of the kind word, and bit 18 when the paint's boundary runs clockwise. The
/// run's first curve carries it for the whole run, which the kernel integrates as one area. Must match CP_AREA in
/// _cpatchCoverage.glsl.
export const CPK_AREA = 131072,
  CPK_AREA_RIGHT = 262144;
/// A hull-row group header: the largest axis-aligned box that fits INSIDE the patch's hull, and how
/// many hull rows follow. A hull plane can only take coverage off a fragment within the filter's
/// reach of it, so a fragment deeper inside than that cannot be touched by any of them -- and most
/// fragments of most patches are. One fetch and a compare then skips the whole group.
///
/// The reach is in PIXELS and the packer has no units for it, so the box is packed in em and the KERNEL
/// shrinks it by CP_AA_REACH * emPerPx. That makes the skip exact at every zoom rather than tuned
/// for one: inside the shrunken box every hard plane is satisfied and every ramped one saturates,
/// so skipping is output-identical, not an approximation.
const CPK_HULL_SKIP = 20;

const CPK_HULL_PACK = 21;
///
/// A short group is padded by repeating its last plane. The kernel min()s the four, and min is
/// idempotent, so a repeat is exactly the same answer as a shorter group -- no count, no branch,
/// and no neutral value that has to behave under a ramp.
const CPK_HULL_RAMP_PACK = 22;
// Scratch for reading a float's bits without allocating (dedup hashing).
const _fv = new Float32Array(1);
const _iv = new Uint32Array(_fv.buffer); ///
/// Content, not identity or index — the cycles a shape converts are produced by the graph front
/// end, hole grouping and bridging, so a pre-pass that wants to convert them off-thread has to
/// recognize them again afterwards without relying on either staying stable.
///
/// THE exact BITS, NOT A ROUNDING. Every coordinate, every conic weight and every hole's curves enter as their float64 bits,
/// with the conversion's own settings (cpatchConvSettings): an entry is served only to the same
/// inputs converted the same way, at any scale. A bake made from other curves -- another decode
/// precision, a re-exported asset -- misses and converts, as it always did.
const _kf = new Float64Array(1),
  _ku = new Uint32Array(_kf.buffer);
const _kb = (x) => {
  _kf[0] = x;
  return _ku[1].toString(36) + '.' + _ku[0].toString(36);
};
function _keyCurves(curves) {
  let k = ':' + curves.length;
  for (const c of curves) {
    k += '|' + c.t;
    if (c.t === 'rquad') k += 'w' + _kb(c.w == null ? 1 : c.w);
    for (const p of c.P) k += ',' + _kb(p[0]) + ',' + _kb(p[1]);
  }
  return k;
}
export function cpatchConvKey(curves, holes, settings = '') {
  let k = settings + (holes ? 'h' + holes.length : 'n') + _keyCurves(curves);
  if (holes) for (const h of holes) k += '#' + _keyCurves(h);
  return k;
}
/// The settings a conversion reads that its curves do not carry, as a key prefix. The pooled build
/// and the packer compute it from the same fields, so a conversion made under one set is never served
/// to a build under another (a bake made at another maxCurves misses instead of replaying).
export function cpatchConvSettings(o = {}) {
  const _ov = mantleDebugHook('__CP_OPTS') || null;
  return (
    'm' +
    (o.maxCurves || (_ov && _ov.maxCurves) || 8) +
    't' +
    (o.tolPx != null ? _kb(+o.tolPx) : 'a') +
    'i' +
    (o.interiorN != null ? o.interiorN : 'd') +
    's' +
    (o.search || 'full') +
    (_ov ? 'o' + JSON.stringify(_ov) : '') +
    '/'
  );
}
/// A SHAPE's key, for what the graph front end makes of it: every contour's exact curves, contour by
/// contour (a flattened list could not tell two shapes that split the same curves differently apart).
export function cpatchShapeKey(list, prefix = '') {
  let k = prefix + list.length;
  for (const c of list) k += '/' + _keyCurves(c);
  return k;
}

/// Per-vertex OFFSET DIRECTION for a convex cover polygon, so the vertex shader can push the
/// cover out by a fixed number of DEVICE PIXELS.
///
/// The cover only decides which fragments are GENERATED -- every one is still tested against the
/// patch's own implicits and cut half-spaces -- so growing it cannot over-fill. It has to be big
/// enough for two things:
///
///   (a) the AA RAMP. Coverage below 1/2 lives OUTSIDE the patch's geometric boundary, so a cover
///       tight to that boundary rasterizes only the inner half of every edge ramp and the shape
///       comes out uniformly thin. This is not a crack: it is a systematic under-count on every
///       boundary pixel, and it is the whole of the straight-edge AA error (16-gon mean coverage
///       error 0.0382 -> 0.0155, against Slug's 0.0149).
///   (b) a RASTERIZATION CRACK: two patches that share a cut compute that shared edge from
///       separately derived vertices, and where those disagree in the last bits the pixels along
///       the seam land in neither polygon and are never shaded. It shows as a one-pixel diagonal
///       running from the point where the cuts converge.
///
/// A dilation expressed as a FRACTION OF THE PATCH cannot do either job, because the requirement
/// is in pixels and the patch's size in pixels is not known until it is drawn: 1% of a 100px cell
/// is half a pixel and 1% of a 10px cell is nothing, and the same cell zoomed out is smaller still.
/// A CPatch decomposition of a curved shape makes many small cells, which is exactly why the error
/// grew with curvature. So the offset is applied in the vertex shader, in px, as it is for every
/// other dilated kind -- this only has to say WHICH WAY.
///
/// It rides aTC.xy, which CPatch otherwise leaves empty, because that is one of the few PER-VERTEX
/// slots the compact unified stream carries. aC0..aC3 are not: there they are a per-CURVE block in
/// a data texture, deduplicated BY CONTENT, so all three vertices of a patch triangle resolve to
/// one entry and a per-vertex value written there both fails to arrive and defeats the dedup.
///
/// Direction = the angle bisector of the two incident edges' outward normals, scaled by
/// 1/cos(half-angle). That is the standard polygon offset: it moves every EDGE out by exactly the
/// requested distance, where a radial push from the centroid would move a long thin cell's long
/// edges by almost nothing. Capped, since the scale diverges at a degenerate spike.
/// `edgeW[i]`, when given, scales edge i's dilation, where edge i runs from poly[i] to poly[i+1]: a
/// reach is per edge, not per polygon, and the per-vertex offset is solved for the two incident
/// edges' reaches. The fan's seam-only growth is the one caller (see FAN_S).
export function coverOffsetDirs(poly, box, edgeW) {
  const n = poly.length;
  if (!poly || n < 3) return null;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i],
      b = poly[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sgn = area < 0 ? -1 : 1; // outward normal of edge a->b, for this winding
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i + n - 1) % n],
      cur = poly[i],
      next = poly[(i + 1) % n];
    const e1x = cur[0] - prev[0],
      e1y = cur[1] - prev[1];
    const e2x = next[0] - cur[0],
      e2y = next[1] - cur[1];
    const l1 = Math.hypot(e1x, e1y) || 1,
      l2 = Math.hypot(e2x, e2y) || 1;
    if (edgeW) {
      // Per-edge reaches, solved exactly: the vertex moves to where the two offset edge lines
      // meet (n1.D = w1, n2.D = w2), which is the bisector-over-cosine form when w1 = w2 and,
      // unlike it, moves each edge by exactly its own reach when they differ.
      const w1 = edgeW[(i + n - 1) % n];
      const w2 = edgeW[i];
      // Both reaches zero: the vertex does not move, and the solve below has no line to meet.
      if (w1 === 0 && w2 === 0) {
        out.push([0, 0]);
        continue;
      }
      const n1x = sgn * (e1y / l1),
        n1y = -sgn * (e1x / l1);
      const n2x = sgn * (e2y / l2),
        n2y = -sgn * (e2x / l2);
      const det = n1x * n2y - n1y * n2x;
      let dx, dy;
      if (Math.abs(det) < 1e-6) {
        dx = (n1x + n2x) * 0.5 * (w1 + w2) * 0.5;
        dy = (n1y + n2y) * 0.5 * (w1 + w2) * 0.5;
        if (Math.hypot(dx, dy) < 1e-9) {
          dx = n2x * w2;
          dy = n2y * w2;
        }
      } else {
        dx = (w1 * n2y - w2 * n1y) / det;
        dy = (w2 * n1x - w1 * n2x) / det;
      }
      const cap = 4 * Math.max(w1, w2),
        dl = Math.hypot(dx, dy);
      if (dl > cap) {
        dx *= cap / dl;
        dy *= cap / dl;
      } // a spike: capped as before
      out.push([dx, dy]);
      continue;
    }
    // A box edge is not dilated. A cell's cover is its grid box clipped to the patch's cover hull,
    // so its edges have two origins, and only one of them wants growing:
    //
    //   HULL edge  — the patch's own outline. The AA ramp lives OUTSIDE it, and a cover tight to
    //                it generates only the ramp's inner half. This must grow.
    //   BOX  edge  — an internal grid cut. The neighboring cell continues the shape across it,
    //                and the fragment test gives every fragment exactly ONE owning cell, so
    //                everything grown past a box edge is rasterized, shaded far enough to fail
    //                that test, and thrown away. Pure overdraw, and on a fine grid a small cell is
    //                mostly dilation — which is why the cost scaled with cell count.
    //
    const BOX_W = mantleDebugHook('__CP_BOX_W') ?? 0.34;
    // ...and only the LO sides overshoot. The ownership test is half-open, [lo, hi): a fragment
    // centered exactly on a seam belongs to the cell whose LO edge is that seam, and it is only
    // that cell the rasterizer can drop it from. Growing the HI side as well makes both cells
    // cover the seam band, so both run the fragment shader there and one result is thrown away —
    // which is why a 0.5px overshoot on every edge cost 5.70ms -> 8.90ms on arc, undoing the grid
    // win. Lo-only closes the crack with exactly one cell covering each seam.
    const onBoxSide = (a, b) => {
      if (!box) return 0;
      const e = 1e-6 * (Math.abs(box[2] - box[0]) + Math.abs(box[3] - box[1]));
      if (Math.abs(a[0] - box[0]) < e && Math.abs(b[0] - box[0]) < e) return 1; // lo x
      if (Math.abs(a[1] - box[1]) < e && Math.abs(b[1] - box[1]) < e) return 1; // lo y
      if (Math.abs(a[0] - box[2]) < e && Math.abs(b[0] - box[2]) < e) return 2; // hi x
      if (Math.abs(a[1] - box[3]) < e && Math.abs(b[1] - box[3]) < e) return 2; // hi y
      return 0; // a hull edge
    };

    const HULL_W = mantleDebugHook('__CP_HULL_W') ?? 1;
    const wOf = (side) => (side === 0 ? HULL_W : side === 1 ? BOX_W : 0);
    const w1 = wOf(onBoxSide(prev, cur)),
      w2 = wOf(onBoxSide(cur, next));
    const n1x = w1 * sgn * (e1y / l1),
      n1y = -w1 * sgn * (e1x / l1);
    const n2x = w2 * sgn * (e2y / l2),
      n2y = -w2 * sgn * (e2x / l2);
    let bx = n1x + n2x,
      by = n1y + n2y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-9) {
      out.push([n2x, n2y]);
      continue;
    } // 180 degree turn: either normal will do
    bx /= bl;
    by /= bl;
    const c = Math.max(bx * n1x + by * n1y, 0.25); // 1/cos, capped at 4x for a spike
    out.push([bx / c, by / c]);
  }
  return out;
}

// Static finite convex arcs: a closed loop with one monotone tangent turn.
// Endpoint support planes also reject repeated/overlapping cycles. Polynomial
// quadratics turn monotonically between their two nonzero handles.
export function convexQuadraticContour(curves) {
  if (
    curves.length < 3 ||
    curves.length > 16 ||
    curves.some(
      (c) =>
        c.cut ||
        !((c.t === 'line' && c.P.length === 2) || (c.t === 'quad' && c.P.length === 3)) ||
        c.P.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1])),
    )
  )
    return 0;
  const side = loopSignedArea(curves) > 0 ? 1 : -1;
  const tangents = [],
    points = curves.flatMap((c) => c.P);
  const span = Math.max(
    Math.max(...points.map((p) => p[0])) - Math.min(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1])) - Math.min(...points.map((p) => p[1])),
  );
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
  let turn = 0;
  for (let i = 0; i < curves.length; i++) {
    const P = curves[i].P,
      end = P[P.length - 1],
      next = curves[(i + 1) % curves.length].P[0];
    if (end[0] !== next[0] || end[1] !== next[1]) return 0;
    const a = [P[1][0] - P[0][0], P[1][1] - P[0][1]],
      b = [end[0] - P[P.length - 2][0], end[1] - P[P.length - 2][1]];
    if (!(Math.hypot(...a) > 0 && Math.hypot(...b) > 0)) return 0;
    const cr = side * cross(a, b),
      dot = a[0] * b[0] + a[1] * b[1];
    const round = 64 * Number.EPSILON * Math.hypot(...a) * Math.hypot(...b);
    if (cr < -round || dot < -round || (P.length === 3 && !(cr > round))) return 0;
    turn += Math.atan2(cr, dot);
    tangents.push([a, b]);
    for (const [ep, t] of [
      [P[0], a],
      [end, b],
    ])
      for (const q of points) {
        const d = [q[0] - ep[0], q[1] - ep[1]],
          v = side * cross(t, d);
        const round = 64 * Number.EPSILON * Math.hypot(...t) * span;
        if (v < -round) return 0;
      }
  }
  for (let i = 0; i < tangents.length; i++) {
    const a = tangents[i][1],
      b = tangents[(i + 1) % tangents.length][0],
      cr = side * cross(a, b),
      dot = a[0] * b[0] + a[1] * b[1];
    const round = 16 * Number.EPSILON * (Math.abs(a[0] * b[1]) + Math.abs(a[1] * b[0]));
    if (cr < -round || (cr <= round && dot <= 0)) return 0;
    turn += Math.atan2(Math.max(0, cr), dot);
  }
  return Math.abs(turn - 2 * Math.PI) <= 64 * Number.EPSILON * curves.length ? side : 0;
}

// An exact whole-loop certificate makes the sampled under-coverage survey
// redundant only when it describes the original authored boundary. Arrangement
// cycles, subdivisions, implicit closing edges and holes retain the survey.
export function certifiedWholeQuadraticShape(contours, patches) {
  if (contours?.length !== 1 || patches?.length !== 1) return false;
  const source = contours[0],
    curves = patches[0].curves;
  if (!source?.length || !curves || source.length !== curves.length) return false;
  const side = convexQuadraticContour(curves);
  if (!side || !curves.every((c) => c._convexEnd === side)) return false;
  return sameQuadraticBoundary(source, curves);
}

function sameQuadraticBoundary(source, curves) {
  if (!source || source.length !== curves.length) return false;
  const equal = (a, b, reverse) => {
    if (a.cut || a.t !== b.t || a.P.length !== b.P.length) return false;
    return a.P.every((q, i) => {
      const p = b.P[reverse ? b.P.length - 1 - i : i];
      return q[0] === p[0] && q[1] === p[1];
    });
  };
  for (let start = 0; start < curves.length; start++) {
    for (const reverse of [false, true]) {
      if (
        source.every((c, i) =>
          equal(c, curves[(start + (reverse ? -i : i) + curves.length) % curves.length], reverse),
        )
      )
        return true;
    }
  }
  return false;
}
export function packCPatchContour(curves, baseBlock = 0, opts = {}) {
  // GRID 1 — ONE COVER PER PATCH, no cell split.
  //
  // Everything the split needed — the ownership box, the box-edge overshoot rules — is kept, and
  // morph segments use the same path, but they default to 1 as well: by default nothing SPLITS.
  //
  // A SPLIT DROPS NO PIXELS. Ownership opens a cell's side to infinity when the neighboring cell
  // was dropped, so the cover handed to the rasterizer must span that inherited strip too, or the
  // strip belongs to a cell that rasterizes nothing (a horizontal run of wholly interior pixels at
  // 0.000, while a CPU model of the fragment test finds no uncovered point -- the decision right
  // and the geometry wrong).
  //
  // gridSplitPatch therefore computes ownership, the drawn polygon AND the constraint list over the
  // same extended region, out to the cover hull, and grids 1, 2 and 4 agree on every case of the
  // route render, the AA ramp at arc apexes included. The remaining difference between them is speed.
  // __CP_GRID (under __MANTLE_DEBUG__) lets a probe build two bundles on ONE renderer with different
  // grids (cpatchOpts is a renderer option, and a renderer per arm is what makes an A/B unmeasurable here).
  const _dbgGrid = mantleDebugHook('__CP_GRID');
  const GRID = _dbgGrid != null ? _dbgGrid : opts.grid != null ? opts.grid : 1;
  const GRID_AA = opts.gridAaPx != null ? opts.gridAaPx : 1.5;
  // See the emission below: 0 = the cover polygon is the only bound, 1 = the bridging planes, 2 =
  // every plane the model clips, 3 = every plane but the bridging ones. Rows are emitted only for
  // the patches the exact per-patch gate names (patchLeaksInBox, below).
  const HULL_ROWS =
    mantleDebugHook('__CP_HULL_ROWS') != null
      ? mantleDebugHook('__CP_HULL_ROWS')
      : opts.hullRows != null
        ? opts.hullRows
        : 2;

  const HULL_ROW_SAMPLES =
    mantleDebugHook('__CP_HULL_ROW_SAMPLES') != null
      ? mantleDebugHook('__CP_HULL_ROW_SAMPLES')
      : opts.hullRowSamples != null
        ? opts.hullRowSamples
        : CP_HULL_ROW_SAMPLES;
  // Collect mode: record which curves WOULD be converted and return an empty shape, so a caller
  // can learn the cycle list by running the real pipeline rather than reimplementing the graph
  // extraction, hole grouping and bridging that decide it. The stub carries no texels, so the
  // block cursor does not move and the walk continues undisturbed.
  const areaSourceMatches =
    !Object.hasOwn(opts, 'quadraticAreaSource') ||
    !!(opts.quadraticAreaSource && sameQuadraticBoundary(opts.quadraticAreaSource, curves));
  const areaOrientation =
    areaSourceMatches && GRID === 1 && !opts.record && !opts.follow && !opts.holes?.length
      ? convexQuadraticContour(curves)
      : 0;
  const areaPatch = areaOrientation
    ? framePatch(curves.map((c) => ({ t: c.t, P: c.P, _src: c._src, _convexEnd: areaOrientation })))
    : null;
  if (opts.collect) {
    if (!areaPatch) opts.collect.push({ curves, holes: opts.holes || null });
    return {
      texels: [],
      verts: [],
      vertexCount: 0,
      kindMask: 0,
      dropped: 0,
      unresolved: 0,
      cells: 0,
      allSeam: 0,
    };
  }
  // A PRECOMPUTED CONVERSION, when the caller has already done it — which is how the pooled
  // build hands back work done on a worker. convertContour is the expensive half of this
  // function by a wide margin; packing what it returns is not.
  // Not when a tape is involved. A cached conversion was produced without `record` or `follow`,
  // so handing it to a caller that asked for either would silently answer a different question.
  const taped = !!(opts.record || opts.follow);
  const key =
    !taped && (opts.convCache || opts.traces || opts.traceOut)
      ? cpatchConvKey(curves, opts.holes, cpatchConvSettings(opts))
      : null;
  const cachedRaw = key && opts.convCache ? opts.convCache.get(key) : undefined;
  // An area patch must never be reused by a different shape that has holes or
  // multiple cycles. Old private cache entries decline that shortcut too.
  const cached =
    !areaPatch && cachedRaw?.patches?.some((p) => p.curves.some((c) => c._convexEnd))
      ? undefined
      : cachedRaw;
  // A certified convex loop is already one complete patch. It needs no search
  // or conversion worker; trace recording/replay retains its original contract.
  let conv =
    areaPatch && !opts.traces && !opts.traceOut
      ? { patches: [areaPatch], stats: { unresolved: 0 } }
      : cached;
  // A baked trace replays the search's decisions on this geometry with no search at all -- see
  // replayContour and cpatchTrace.js. Keyed by the same geometry string the cache uses, hashed,
  // so a bake made from other curves (another decode precision, a re-exported asset) misses and
  // the contour converts as before; a trace that fits reproduces the search's patches exactly.
  // `opts.traceOut` is the other direction: a Map to fill with this build's traces, for baking.
  if (conv === undefined && key && opts.traces) {
    const tr = opts.traces.get(traceKeyHash(key)) || opts.traces.get(key);
    let r = null;
    // WHY A TRACE DID NOT FIT, on request. The catch below is a deliberate fallback -- a bake made
    // from other curves should convert as before -- but it swallows a THROW just as readily as a
    // genuine misfit, and the two are not the same finding: a TypeError in cutCandidates would
    // stop every recorded trace from replaying and read as "the bake does not match". Set
    // __CP_MISFIT_WHY to have the reason printed instead of inferred.
    const _st = {};
    if (tr) {
      try {
        r = replayContour(curves, tr, { stats: _st });
      } catch (e) {
        r = null;
        _st.fail = 'threw ' + e.message;
      }
    }
    if (tr && !r && globalThis.__CP_MISFIT_WHY)
      console.log('cpatch misfit: ' + (_st.fail || '(no reason recorded)'));
    if (r) conv = r;
    if (opts.traceStats) {
      const k = tr ? (r ? 'hits' : 'misfits') : 'misses';
      opts.traceStats[k] = (opts.traceStats[k] | 0) + 1;
    }
  }
  if (conv === undefined) {
    const trace = key && opts.traceOut ? [] : null;
    // __CP_OPTS is the two-bundles-on-one-renderer hook (see convertContour). It is consulted
    // for the DEFAULT here rather than merged over the caller: an explicit cpatchOpts still wins,
    // but a probe can vary a setting the packer would otherwise pin to its own default -- without
    // which two arms varying maxCurves would silently get the same decomposition.
    const _ov = mantleDebugHook('__CP_OPTS') || null;
    // SPLIT WHERE THE CONTOUR IS LARGE (convertContourSplit): the same pieces the pool
    // dispatches, so this thread, node, a bake and the pool all reach one decomposition.
    conv = convertContourSplit(curves, {
      maxCurves: opts.maxCurves || (_ov && _ov.maxCurves) || 8,
      // Only when the caller set one. Passing a flat default here overrides defaultTolPx, and
      // defaultTolPx is what scales the bar to the contour's own extent -- a flat default would hold
      // every shape packed through here to a fixed bar no matter its size, and the same drawing at
      // eight times the scale would come out with more patches. Undefined means "decide it from the
      // geometry", which is the whole point of having a default.
      tolPx: opts.tolPx != null ? opts.tolPx : undefined,
      // Interior-check resolution. Raising it costs one denser grid per ACCEPTED
      // patch and rejects patches a coarser grid passes; 0 disables the check.
      interiorN: opts.interiorN,
      follow: opts.follow || null,
      record: opts.record || null,
      holes: opts.holes || null,
      trace,
      // 'full' by default: on the pooled path the presets are 5-10% apart in wall time (the pool
      // is critical-path bound) while 'fast' costs +7% curve references on every frame. 'fast'
      // is for a build with no workers, where its serial -20% is real. cpatchOpts.search sets it.
      search: opts.search || 'full',
    });
    // A conversion that ran in a frame of its own needs its frame in the trace: its cut lines are in
    // a frame the replay would not otherwise know about, so an entry would only misfit and be
    // reconverted -- the same conversion twice. The trace carries the frame (every conversion runs in
    // its contour's frame and opens with a `frame` record, which replayContour consumes), so every
    // conversion bakes. A trace that still does not fit the runtime's geometry
    // misfits the way any other does, which is a miss and a conversion, not a wrong answer.
    // The first contour of a key keeps it -- see the note below.
    if (trace && conv && !opts.traceOut.has(key)) opts.traceOut.set(key, trace);
  }
  if (!conv) return null; // a refused follow tape
  // ONE CONVERSION PER KEY, ON every ROUTE: a serial build (whose caller passes a fresh map) keeps
  // what it converted, so a later contour of the same key reuses it as the pool's map does. The key
  // is the exact inputs (see cpatchConvKey), so "the same key" is the same contour converted the same
  // way.
  if (!areaPatch && key && opts.convCache && cached === undefined && !opts.convCache.has(key))
    opts.convCache.set(key, conv);
  let { patches } = conv;
  patches = splitPartialSeams(patches, opts.shapeFill);
  if (areaPatch) patches = [areaPatch];
  const { stats } = conv;

  // In the contour's frame: the choice compares sums of distances, so a move of
  // the contour must not be able to reorder two near-equal candidates by rounding.
  //
  if (mantleDebugHook('__CP_COMP_ON') === 1) {
    const outl = [];
    for (const p of patches) for (const c of p.curves) if (!c.cut) outl.push(c);
    if (outl.length) {
      let fx = Infinity,
        fy = Infinity;
      for (const c of curves)
        for (const q of c.P) {
          if (q[0] < fx) fx = q[0];
          if (q[1] < fy) fy = q[1];
        }
      const F = [Math.fround(fx), Math.fround(fy)];
      const NS = 16;
      const local = (g) => ({ t: g.t, w: g.w, P: g.P.map((q) => [q[0] - F[0], q[1] - F[1]]) });
      const samp = (g) => {
        const L = local(g),
          a = new Float64Array(2 * NS + 2);
        for (let k = 0; k <= NS; k++) {
          const q = segPt(L, k / NS);
          a[2 * k] = q[0];
          a[2 * k + 1] = q[1];
        }
        return a;
      };
      const boxOf = (a) => {
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        for (let k = 0; k < a.length; k += 2) {
          x0 = Math.min(x0, a[k]);
          x1 = Math.max(x1, a[k]);
          y0 = Math.min(y0, a[k + 1]);
          y1 = Math.max(y1, a[k + 1]);
        }
        return [x0, y0, x1, y1];
      };
      // the distance from (x, y) to a sampled curve's polyline
      const toPoly = (a, x, y) => {
        let d2 = Infinity;
        for (let k = 0; k + 3 < a.length; k += 2) {
          const ax = a[k],
            ay = a[k + 1],
            ex = a[k + 2] - ax,
            ey = a[k + 3] - ay,
            l2 = ex * ex + ey * ey;
          const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0;
          const dx = ax + u * ex - x,
            dy = ay + u * ey - y;
          d2 = Math.min(d2, dx * dx + dy * dy);
        }
        return Math.sqrt(d2);
      };
      const oPts = outl.map(samp),
        oBox = oPts.map(boxOf);
      for (const p of patches) {
        let comp = null;
        const own = new Set(p.curves);
        for (const S of p.curves) {
          if (!S.cut) continue;
          const sp = samp(S),
            sb = boxOf(sp);
          let len = 0;
          for (let k = 2; k < sp.length; k += 2)
            len += Math.hypot(sp[k] - sp[k - 2], sp[k + 1] - sp[k - 1]);
          // A curve further from the seam than half the seam's length cannot run along it.
          const lim = 0.5 * len;
          let best = null,
            bestM = Infinity;
          for (let i = 0; i < outl.length; i++) {
            if (own.has(outl[i])) continue;
            const b = oBox[i];
            const dx = Math.max(0, sb[0] - b[2], b[0] - sb[2]),
              dy = Math.max(0, sb[1] - b[3], b[1] - sb[3]);
            if (dx * dx + dy * dy > lim * lim) continue;
            let m = 0;
            for (let k = 0; k < sp.length && m < bestM; k += 2)
              m += toPoly(oPts[i], sp[k], sp[k + 1]);
            if (m < bestM) {
              bestM = m;
              best = outl[i];
            }
          }
          if (best) (comp || (comp = new Map())).set(S, best);
        }
        if (comp) p[K_COMP] = comp;
      }
    }
  }
  let O = [0, 0];
  // An explicit origin (a morph's span frame, which a probe holds a static pack to) is taken as given.
  if (Array.isArray(opts.kernelFrame))
    O = [Math.fround(opts.kernelFrame[0]), Math.fround(opts.kernelFrame[1])];
  else if (patches.length && opts.kernelFrame !== false) {
    let x0 = Infinity,
      y0 = Infinity;
    for (const c of curves)
      for (const q of c.P) {
        if (q[0] < x0) x0 = q[0];
        if (q[1] < y0) y0 = q[1];
      }
    if (Number.isFinite(x0) && Number.isFinite(y0)) O = [Math.fround(x0), Math.fround(y0)];
  }
  for (const p of patches) p[K_FRAME] = O;
  markSeamEnds(patches);
  if (opts.onPatches) opts.onPatches(patches, opts.holes || null);
  // The kernel evaluates in this contour's frame. Its texels are packed relative to
  // O, the corner of the contour's control-point box rounded to float32, which every vertex carries
  // in aC2.zw; the vertex stage hands the fragment its em position minus O. The kernel runs in
  // float32, and in world coordinates a contour at y = 1e5 had its fragment position quantized to
  // 1/128 of a unit and its affine coefficients canceling terms of that size, so a pixel whose
  // center lies within a hundredth of a pixel of a hard hull plane or a cut read the other side:
  // noAaArcRow__FAR drew 6 pixels off by half at y = 1e5 and none with the same patches moved
  // exactly to the origin. em - O is exact in the vertex stage (both are float32 and close: Sterbenz)
  // and small, so the interpolated position is as good as the origin's. The constraints move with
  // the patches, as the conversion frame's do (translatePatches); only the cover vertices go back
  // to world coordinates, for the rasterizer. The CPU model and every other onPatches reader see
  // the world patches above.
  // `kernelFrame: false` packs in world em; `kernelFrame: [x, y]` packs in that frame, which is how a
  // probe holds a static pack against a morph span's (see morphKernelFrame).
  if (O[0] !== 0 || O[1] !== 0) {
    const local = translatePatches(patches, O);
    if (!local) return null;
    // A seam's companion points at its contour's curves: the same curves, moved.
    const moved = new Map();
    patches.forEach((p, i) => p.curves.forEach((c, k) => moved.set(c, local[i].curves[k])));
    patches.forEach((p, i) => {
      if (p[K_COMP])
        local[i][K_COMP] = new Map([...p[K_COMP]].map(([S, C]) => [moved.get(S), moved.get(C)]));
      if (p[K_SEAMEND])
        local[i][K_SEAMEND] = new Map([...p[K_SEAMEND]].map(([S, E]) => [moved.get(S), E]));
      local[i][K_WORLD] = p;
    });
    patches = local;
  }
  // A contour that bounds nothing converts to nothing, and that is a success, not a failure:
  // returning null here would sink the whole shape (packCPatchShape is all-or-nothing) over a
  // sliver cycle the graph front end emitted.
  if (!patches.length)
    return {
      texels: new Float32Array(0),
      verts: new Float32Array(0),
      vertexCount: 0,
      cpatch: true,
      kindMask: 1 << CPATCH_STREAM_TAG,
      patches: 0,
      dropped: 0,
      cells: 0,
      kinds: {},
      unresolved: 0,
      allSeam: 0,
    };
  const texels = [],
    verts = [];
  const kinds = {};
  let dropped = 0,
    cells = 0;
  // Seams that packed a companion: the kernel compiles the companion's code only for a bundle with one.
  let compN = 0;
  // Counted here, where the patches still exist: see the note at the return.
  let allSeam = 0;
  for (const p of patches) {
    if (!p.curves.length) continue;
    let all = true;
    for (const sg of p.curves)
      if (!(sg && sg.cut)) {
        all = false;
        break;
      }
    if (all) allSeam++;
  }
  //
  const runPool = opts.dedup === false ? null : new Map();

  const sharedPk = new Map(),
    sharedOf = new Map();
  {
    const canon = (P) => {
      const a = P[0],
        z = P[P.length - 1];
      return a[0] < z[0] || (a[0] === z[0] && a[1] < z[1]);
    };
    const keyOf = (P) =>
      (canon(P) ? P : P.slice().reverse()).map((q) => q[0] + ',' + q[1]).join(';');
    for (const p of patches)
      for (const c of p.curves)
        if (c.cut && c.P.length >= 3 && canon(c.P)) {
          const pk = c[K_PK] !== undefined ? c[K_PK] : segImplicitPacked(c);
          if (pk) sharedPk.set(keyOf(c.P), pk);
        }
    for (const p of patches)
      for (const c of p.curves)
        if (c.cut && c.P.length >= 3 && !canon(c.P)) {
          const pk = sharedPk.get(keyOf(c.P));
          if (pk) sharedOf.set(c, pk);
        }
  }

  let _onlyIdx9 = -1;
  const _only9 = mantleDebugHook('__CP_ONLY_PATCH');
  for (const p of patches) {
    _onlyIdx9++;
    // SKIP THE GEOMETRY, NOT THE BOOKKEEPING. Skipping the whole body also skips the block
    // accounting, and the one patch left then carries another patch's block index -- which reads
    // as a constraint count of eight where the patch has three, and makes the isolation a lie.
    const _skipGeom9 = _only9 !== undefined && _onlyIdx9 !== (_only9 | 0);

    const hull0 = patchCoverHull(p.curves, 0);
    if (!hull0 && !p.obb) {
      dropped++;
      continue;
    }
    const parts = [];
    if (GRID > 1) {
      const cs = gridSplitPatch(p, GRID, GRID_AA);
      // c.poly is the cell CLIPPED TO THE COVER HULL, not the raw cell rectangle.
      if (cs)
        for (const c of cs)
          parts.push({ poly: c.poly, idx: c.curves, box: c.ownBox || c.box, raw: c.box });
    }
    if (!parts.length) {
      let hull = hull0 || p.obb.corners;
      // DROP A VERTEX WHOSE EDGE TO THE NEXT IS DEGENERATE, by patchCoverLines' own test. Consecutive
      // curves share an endpoint that the two sides reach by different routes, so the control hull can carry the same
      // point twice a few ulps apart. patchCoverLines skips that zero-length edge and its plane list comes back one
      // short, the per-edge kinds below then fail to line up, and the patch falls back to a 1.5px skirt on every edge --
      // seams and bridges included.
      if (hull.length > 3) {
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        for (const q of hull) {
          x0 = Math.min(x0, q[0]);
          x1 = Math.max(x1, q[0]);
          y0 = Math.min(y0, q[1]);
          y1 = Math.max(y1, q[1]);
        }
        const eps = 1e-12 * Math.max(x1 - x0, y1 - y0);
        const kept = hull.filter((a, k) => {
          const b = hull[(k + 1) % hull.length];
          return !(Math.hypot(b[0] - a[0], b[1] - a[1]) < eps);
        });
        if (kept.length >= 3) hull = kept;
      }

      let edgeW = null,
        edgeK = null;
      {
        // From the same hull the polygon came from. patchCoverLines returns one plane per hull
        // EDGE, so the correspondence below (`hl.length === hull.length`) only holds if both are
        // built at the same sample count.
        const hl = patchCoverLines(p.curves, 0);
        if (hl && hl.length === hull.length) {
          edgeW = new Array(hull.length);
          edgeK = new Array(hull.length);
          for (let k = 0; k < hull.length; k++) {
            edgeK[k] = hl[k][3];

            // A SEAM WEARS NO SKIRT. Skirting seams as well as outline edges is slower and worse on every
            // measure at once (more wrong-solid pixels, more ink painted outside, more AA error), so it is
            // not a trade.
            const seamReach = mantleDebugHook('__CP_SEAM_W') ?? 0;

            const outlineReach = mantleDebugHook('__CP_OUTLINE_W') ?? 0.4715;
            // THE REACH FOLLOWS THE INK, not the kernel's kind. A cut in the same line as an outline arc makes the
            // plane kind 1, and a seam's reach is zero -- so the arc's AA band had no geometry and every pixel whose
            // center sat just outside it would never be shaded.
            const outlineHere = hl[k].outlineAlong === true;

            const bridgeReach =
              mantleDebugHook('__CP_BRIDGE_W') != null
                ? +mantleDebugHook('__CP_BRIDGE_W')
                : outlineReach;
            edgeW[k] = outlineHere
              ? outlineReach
              : hl[k][3] === 0
                ? bridgeReach
                : hl[k][3] === 1
                  ? seamReach
                  : outlineReach;
          }
        }
      }
      parts.push({ poly: hull, idx: p.curves.map((_, i) => i), edgeW, edgeK });
    }

    let ok = true;
    for (const part of parts) {
      const mark = texels.length; // rollback point on a dedup hit
      let first = baseBlock + texels.length / CP_BLOCK_FLOATS;
      let hullRows = 0;
      //
      // The MODEL does not have this hole -- patchCoverage clips patchCoverLines directly -- so
      // without these rows it would report no spill while the renderer painted some. A model that
      // clips a different bound from the renderer is not a model of it, so the two agree here.
      //
      // 1 = the BRIDGING planes only (h[3] === 0): the ones no curve or cut runs along, which bound
      // nothing but the constraints' extension past a corner and have no AA band to keep, so they
      // clip undilated. That is where the leak is. 2 = every plane, which is exactly what the model
      // clips. Rows are cheap here because one quad serves one patch, so this is a handful of
      // blocks on the patches that need them.
      // ...AND only ON A PATCH WHOSE CONSTRAINTS REACH PAST ITS own HULL. The rows exist to fence
      // the cover quad's dilation, and a patch whose half-spaces already close outside the hull has
      // nothing to fence -- there the rows are pure per-fragment cost. A SAMPLED test of that is
      // unsafe at any sampling: even five points along each edge drop rows that interior pixels
      // depend on. The gate below is exact.
      let needRows = true,
        skipBox = null;

      if (HULL_ROWS) {
        try {
          needRows = p.curves.every((c) => c._convexEnd) ? false : patchLeaksInBox(p);
        } catch {
          needRows = true;
        }
      }
      const hullMark = texels.length;
      // A SEAM FOR MEASUREMENT, and the only record of this decision that survives the packer: the
      // wire says how many rows a patch got, not which patch was exempted or at what bar. The CPU
      // coverage model reads it (see K_ROWS in cpatchCov) so it can fence exactly the patches the
      // kernel will, instead of every patch or none. Under a Symbol, so nothing walking a patch's
      // own fields -- the scale probe, the morph snapshots -- sees a new key.
      p[K_ROWS] = !!(HULL_ROWS && needRows);
      if (p[K_WORLD]) p[K_WORLD][K_ROWS] = p[K_ROWS]; // for the onPatches readers (cpatchCov)
      if (HULL_ROWS && needRows) {
        // The inscribed box, found by shrinking the hull's own bbox toward its centroid until every
        // corner is inside. Conservative by construction -- a box that is too small only skips
        // fewer fragments -- and a dozen point-in-convex tests at pack time.
        const hq = patchCoverHull(p.curves, HULL_ROW_SAMPLES);
        if (hq && hq.length >= 3) {
          let cx3 = 0,
            cy3 = 0;
          for (const q of hq) {
            cx3 += q[0];
            cy3 += q[1];
          }
          cx3 /= hq.length;
          cy3 /= hq.length;
          const bq = patchBBox(p.curves);
          const inHull = (x, y) => {
            for (let k = 0; k < hq.length; k++) {
              const a = hq[k],
                b = hq[(k + 1) % hq.length];
              const cr = (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]);
              const cc = (b[0] - a[0]) * (cy3 - a[1]) - (cx3 - a[0]) * (b[1] - a[1]);
              if (cr * cc < 0) return false;
            }
            return true;
          };
          let loS = 0,
            hiS = 1;
          for (let it = 0; it < 12; it++) {
            const m = (loS + hiS) * 0.5;
            const x0 = cx3 + (bq[0] - cx3) * m,
              x1 = cx3 + (bq[2] - cx3) * m;
            const y0 = cy3 + (bq[1] - cy3) * m,
              y1 = cy3 + (bq[3] - cy3) * m;
            if (inHull(x0, y0) && inHull(x1, y0) && inHull(x1, y1) && inHull(x0, y1)) loS = m;
            else hiS = m;
          }
          if (loS > 0) {
            const x0 = cx3 + (bq[0] - cx3) * loS,
              x1 = cx3 + (bq[2] - cx3) * loS;
            const y0 = cy3 + (bq[1] - cy3) * loS,
              y1 = cy3 + (bq[3] - cy3) * loS;
            skipBox = [x0, y0, x1, y1];
          }
        }

        const hl = patchCoverLines(p.curves, HULL_ROW_SAMPLES);
        if (!hl) {
          ok = false;
          break;
        }
        const hard = [],
          ramp = [];
        for (const h of hl) {
          if (HULL_ROWS === 1 && h[3] !== 0) continue;

          if (HULL_ROWS === 3 && h[3] === 0) continue;
          (h[3] === 2 ? ramp : hard).push(h);
        }
        // The hard ones, FOUR TO A BLOCK. See CPK_HULL_PACK: a hull plane is one texel, and a
        // seven-texel block each would cost the kernel a loop iteration and a kind dispatch per plane.
        for (let g = 0; g < hard.length; g += 4) {
          const q = [];
          for (let k2 = 0; k2 < 4; k2++) {
            const h = hard[g + k2];
            q.push(
              h
                ? [h[0], h[1], h[2], h[3] === 0 ? CPK_HULL_HARD : CPK_HULL_BOUND]
                : [0, 0, 1, CPK_HULL_HARD],
            ); // neutral: step(0, 1) is 1
          }
          texels.push(q[0][0], q[0][1], q[0][2], CPK_HULL_PACK);
          texels.push(q[1][0], q[1][1], q[1][2], q[0][3]);
          texels.push(q[2][0], q[2][1], q[2][2], q[1][3]);
          texels.push(q[3][0], q[3][1], q[3][2], q[2][3]);
          texels.push(q[3][3], 0, 0, 0);
          texels.push(0, 0, 0, 0);
          texels.push(0, 0, 0, 0);
          hullRows++;
        }
        // ...AND THE RAMPED ONES FOUR TO A BLOCK TOO. See CPK_HULL_RAMP_PACK. Layout, per block:
        //   texel 0  (a0, b0, c0, kind)      texel 1  (a1, b1, c1, s0_0)
        //   texel 2  (a2, b2, c2, s1_0)      texel 3  (a3, b3, c3, s0_1)
        //   texel 4  (s1_1, s0_2, s1_2, s0_3)
        //   texel 5  (s1_3, spanBits, 0, 0)  texel 6  (unused)
        // `spanBits` is one bit per plane: set where the plane carries its arc's span and must
        // bound hard outside it, clear where it ramps everywhere along itself. THE KERNEL DOES NOT
        // read the bits: a plane with no span carries (-1e30, 1e30), which no
        // fragment is outside of, so every plane takes the same span test and nothing is decoded.
        for (let g = 0; g < ramp.length; g += 4) {
          const q = [];
          for (let k2 = 0; k2 < 4; k2++) q.push(ramp[Math.min(g + k2, ramp.length - 1)]);
          const sp = q.map((h) => (h.length > 5 ? [h[4], h[5], 1] : [-1e30, 1e30, 0]));
          const bits = sp[0][2] + 2 * sp[1][2] + 4 * sp[2][2] + 8 * sp[3][2];
          texels.push(q[0][0], q[0][1], q[0][2], CPK_HULL_RAMP_PACK);
          texels.push(q[1][0], q[1][1], q[1][2], sp[0][0]);
          texels.push(q[2][0], q[2][1], q[2][2], sp[0][1]);
          texels.push(q[3][0], q[3][1], q[3][2], sp[1][0]);
          texels.push(sp[1][1], sp[2][0], sp[2][1], sp[3][0]);
          texels.push(sp[3][1], bits, 0, 0);
          texels.push(0, 0, 0, 0);
          hullRows++;
        }

        if (false && skipBox && hullRows > 0) {
          const hdr = [
            0,
            0,
            0,
            CPK_HULL_SKIP,
            skipBox[0],
            skipBox[1],
            skipBox[2],
            skipBox[3],
            hullRows,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
          ];
          texels.splice(hullMark, 0, ...hdr);
          hullRows++;
        }
      }

      // A cubic that ends at its own curve's cusp: a zero-length handle there, exactly -- P0 = P1 or
      // P2 = P3. Its algebraic curve has a cusp at that end, the extension past it comes back beside the arc, and
      // near the tip the implicit's sign is the cusp's, not the arc's: across the arc it need not change. The kernel
      // takes the arc's own side there instead, so it needs to know which end, and which side of the arc's direction
      // is the patch's inside -- exact, from the patch loop's signed area. The same curve going on through the cusp
      // (a notch: the loop's next curve has the same implicit) is not flagged; there the implicit is right.
      const ncv = p.curves.length;
      const pkOf = (c) =>
        sharedOf.get(c) || (c[K_PK] !== undefined ? c[K_PK] : segImplicitPacked(c));
      const samePk = (u, v) =>
        !!u &&
        !!v &&
        u.kind === v.kind &&
        u.a.every((r, i) => r.every((x, j) => x === v.a[i][j])) &&
        u.c.every((x, i) => x === v.c[i]);
      const loopRight = loopSignedArea(p.curves) < 0;
      const hornOf = (ci, pk) => {
        const A = p.curves[ci];
        if (A.cut || A.t !== 'cubic' || A.P.length !== 4 || ncv < 2) return 0;
        const P = A.P,
          z0 = P[0][0] === P[1][0] && P[0][1] === P[1][1],
          z1 = P[2][0] === P[3][0] && P[2][1] === P[3][1];
        const through = (n) => !!n && !n.cut && samePk(pkOf(n), pk);
        const h0 = z0 && !through(p.curves[(ci - 1 + ncv) % ncv]),
          h1 = z1 && !through(p.curves[(ci + 1) % ncv]);
        return (h0 ? CPK_HORN0 : 0) + (h1 ? CPK_HORN1 : 0);
      };
      for (const ci of part.idx) {
        const seg = p.curves[ci];
        // ONE path for every curve type: four texels of affine coefficients plus a
        // kind tag. Lines, quadratics, rational quadratics, klmn cubics and Bezout
        // cubics differ only in which products the kernel forms.
        // The converter's own form when it left one: a patch converted in its contour's frame carries
        // the constraints that were validated there (cpatchConvert's unframePatches), which a fresh
        // derivation from the curve's control points is not, for a curve too short to pin one down.
        const pk =
          sharedOf.get(seg) || (seg[K_PK] !== undefined ? seg[K_PK] : segImplicitPacked(seg));
        if (!pk) {
          ok = false;
          break;
        }
        const kind = seg.cut ? CPK_CUT_BIT + pk.kind : pk.kind;
        kinds[kind] = (kinds[kind] | 0) + 1;
        // The sign comes from packedEval, the exact function the shader evaluates.
        // Taken from a differently-ordered barycentric it flips a curve and clips
        // the region silently.
        const sg =
          seg._convexEnd && seg.t === 'quad'
            ? convexQuadraticSign(seg, pk)
            : packedEvalF32(pk, p.inside[0], p.inside[1]) >= 0
              ? 1
              : -1;
        // A line carries its sign in its own coefficients. The kernel reads the sign from
        // texel 1, and a line's implicit needs nothing else from that texel -- so folding the
        // sign in here lets a line be evaluated from ONE texel instead of two. Exact: negating
        // a plane negates its evaluation. `pk` is shared (the morph packer caches it), so scale
        // on the way out rather than mutating it.
        const s0 = pk.kind === CPK_LINE && sg < 0 ? -1 : 1;
        // A SEAM'S COMPANION (see K_COMP above) rides in texels 4-6, which no cut reads: its box
        // where the strip would be and its arc where the cut's own would be, flagged in the kind
        // word as CPK_COMP (a cubic) or twice that (three control points).
        const comp = seg.cut && p[K_COMP] ? p[K_COMP].get(seg) : null;
        if (comp) compN++;
        const sEnds0 = seg.cut && p[K_SEAMEND] ? p[K_SEAMEND].get(seg) || null : null;
        const sEnds =
          sEnds0 && !comp && (seg.P.length === 2 ? pk.kind === CPK_LINE : pk.kind === CPK_QUAD)
            ? sEnds0
            : null;
        texels.push(
          s0 * pk.a[0][0],
          s0 * pk.a[0][1],
          s0 * pk.a[0][2],
          kind +
            (arcIs3(seg) ? CPK_ARC3 : 0) +
            (comp ? CPK_COMP * (arcIs3(comp) ? 2 : 1) : 0) +
            hornOf(ci, pk) +
            (!seg.cut && loopRight ? CPK_HORN_RIGHT : 0) +
            (seg._convexEnd ? CPK_AREA + (seg._convexEnd < 0 ? CPK_AREA_RIGHT : 0) : 0) +
            (sEnds ? CPK_END * ((sEnds[0] ? 1 : 0) + (sEnds[1] ? 2 : 0)) : 0),
        );
        // A straight seam's outline legs ride the xyz of texels 1, 2 and 4, which a line never reads: a morph's blend
        // carries xyz of every texel as a polynomial in the pose, so a pose's legs reach the kernel exactly. (w stays whatever
        // the row's w is.) Order: end 0's own and other leg, then end 1's.
        const lg = sEnds && seg.P.length === 2 ? seamLegs(sEnds) : null;
        texels.push(
          lg ? lg[0] : pk.a[1][0],
          lg ? lg[1] : pk.a[1][1],
          lg ? lg[2] : pk.a[1][2],
          s0 < 0 ? 1 : sg,
        );
        // A quadratic seam's outline ends ride texel 2, which a quadratic's implicit never reads: the four legs'
        // angles (own and other at its start, own and other at its end).
        if (sEnds && pk.kind === CPK_QUAD && seg.P.length === 3) {
          const ang = (e, j) => (e ? Math.atan2(e[j + 1], e[j]) : 0);
          texels.push(ang(sEnds[0], 0), ang(sEnds[0], 2), ang(sEnds[1], 0), ang(sEnds[1], 2));
        } else if (lg) texels.push(lg[3], lg[4], lg[5], pk.c[0]);
        else texels.push(pk.a[2][0], pk.a[2][1], pk.a[2][2], pk.c[0]);

        const bb = segTightBBox(seg);
        const st = comp ? segTightBBox(comp) : chordStrip(seg);
        // A straight seam's outline ends ride where its strip and arc tail would: a line never reads either.
        if (lg) {
          const g = arcTexels(seg);
          texels.push(bb[0], bb[1], bb[2], bb[3]);
          texels.push(lg[6], lg[7], 0, 0);
          texels.push(g[0], g[1], g[2], g[3], 0, 0, 0, 0);
        } else {
          if (pk.kind !== 4) {
            texels.push(bb[0], bb[1], bb[2], bb[3]);
            texels.push(st[0], st[1], st[2], st[3]);
          } else {
            texels.push(pk.a[3][0], pk.a[3][1], pk.a[3][2], pk.c[1]);
            texels.push(st[0], st[1], st[2], st[3]);
          }
          texels.push(...arcTexels(comp || seg));
        }
      }
      if (!ok) break;
      if (runPool) {
        let h = 2166136261 >>> 0;
        for (let q = mark; q < texels.length; q++) {
          _fv[0] = texels[q];
          h = Math.imul(h ^ (_iv[0] & 0xff), 16777619) >>> 0;
          h = Math.imul(h ^ ((_iv[0] >>> 8) & 0xff), 16777619) >>> 0;
          h = Math.imul(h ^ ((_iv[0] >>> 16) & 0xff), 16777619) >>> 0;
          h = Math.imul(h ^ ((_iv[0] >>> 24) & 0xff), 16777619) >>> 0;
        }
        const key = h * 64 + (texels.length - mark); // length disambiguates cheaply
        const hit = runPool.get(key);
        if (hit !== undefined) {
          // VERIFY before reusing: a hash collision would silently hand this cell
          // someone else's coefficients, which renders as a wrong region, not a crash.
          const n = texels.length - mark;
          let same = true;
          const at = (hit - baseBlock) * CP_BLOCK_FLOATS;
          for (let q = 0; q < n; q++)
            if (texels[at + q] !== texels[mark + q]) {
              same = false;
              break;
            }
          if (same) {
            texels.length = mark;
            first = hit;
          }
        } else runPool.set(key, first);
      }
      // Every fragment of this cell evaluates all of its curves, so this distribution IS the
      // fragment cost — one entry per CELL, which is the unit that matters. (Per VERTEX,
      // collapsing equal-valued runs to recover cells would under-count badly.)
      if (globalThis.__CP_CURVE_HIST) globalThis.__CP_CURVE_HIST.push(part.idx.length);

      let OB = null;
      if (p.obb && p.obb.lines && p.obb.lines.length === 4) {
        const L = p.obb.lines;
        OB = [L[0][0], L[0][1], -L[0][2], L[1][2], -L[2][2], L[3][2]];
      }
      const c = part.poly;
      // A TIGHT HULL PLUS AN EXTERIOR RING, rather than one hull dilated bodily outward.

      // Same construction here. The fan is emitted undilated, and each hull edge that carries an
      // AA band (edgeW > 0 -- a seam carries none) gets a quad from the edge to the edge pushed out
      // by its own reach. The inner
      // pair has zero offset, so the ring welds to the hull exactly and cannot crack.
      // THE HULL TEST IS LINEAR, SO THE INTERPOLATOR CAN DO IT FOR FREE.
      //
      // A cover-hull plane row asks `dot(n, p) + c >= 0` per fragment, and that is an AFFINE
      // function of position -- exactly the class a rasterizer reproduces exactly when it
      // interpolates a varying. Six of them per patch is six texel fetches and two loop iterations
      // to recompute, every fragment, a number the hardware would hand over for nothing.
      //
      // What stops a single varying carrying it is that distance to a convex POLYGON is min over
      // its edges, which is not affine. So the geometry is made per-EDGE: the annulus
      // between the hull and its offset is tiled by one band per edge plus a bevel wedge at each
      // vertex, so every fragment lies in exactly one band and the only distance it needs is to
      // THAT band's edge -- which is affine, and therefore exact under interpolation.
      //
      // aTC.z carries it, in pixels: +BIG on the interior fan (no hull constraint), 0 on the band's
      // inner rim (on the hull) and -reach on its outer rim. CPatch never wrote that slot and the
      // LB vertex stage already forwards aTC to vTC, so it costs no attribute and no varying.
      const order = [];
      for (let k = 1; k + 1 < c.length; k++) order.push(0, k, k + 1);
      cells++;
      const BIG = 1e3; // "no hull constraint here", in pixels
      const emit = [];
      const areaWhole =
        hullRows === 0 &&
        part.idx.length === p.curves.length &&
        p.curves.every((s) => s._convexEnd);
      // THE FAN GROWS ACROSS SEAMS only (__CP_FAN_SEAM, in the vertex stage's 1.5px unit; 0.1 by default). A crack can
      // only open between two patches deriving the same seam from different vertices: an outline edge welds to its own
      // With the seam the only weighted edge, a vertex it shares with the outline slides ALONG the outline, never out of it.
      // 0.1 already closes seam cracks, so the smallest is the setting.
      const FAN_S =
        mantleDebugHook('__CP_FAN_SEAM') != null ? +mantleDebugHook('__CP_FAN_SEAM') : 0.1;
      const fanSeamDirs =
        FAN_S > 0 && part.edgeK && part.edgeK.length === c.length
          ? coverOffsetDirs(
              c,
              part.box,
              part.edgeK.map((kd, k) => (kd === 1 && !(part.edgeW && part.edgeW[k] > 0) ? 1 : 0)),
            )
          : null;
      if (areaWhole) {
        const xs = c.map((v) => v[0]),
          ys = c.map((v) => v[1]);
        const lo = [Math.min(...xs), Math.min(...ys)],
          hi = [Math.max(...xs), Math.max(...ys)];
        const box = [
          [lo[0], lo[1]],
          [hi[0], lo[1]],
          [hi[0], hi[1]],
          [lo[0], hi[1]],
        ];
        const dirs = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ];
        for (const k of [0, 1, 2, 0, 2, 3]) emit.push([box[k], dirs[k], 2 * BIG]);
      } else {
        // A CORNER A SEAM SLIDES KEEPS ITS PLACE ON THE OUTLINE TOO. The slide closes the seam, and it has to run its full length: it reaches across the seam by the
        // sine of their angle, so a shorter slide at a sharp corner opened the seam (a dart's seam read 0 along 41 solid pixels). The outline's edge between the two
        // unslid corners is then an edge of the fan, vertex for vertex, and the skirt welds to that and stops at its own corner: welded to the slid corner instead, it
        // ran past its end into its neighbor's, where both kernels paint. Two triangles on one line with different ends round differently, and a pixel center exactly on
        // that line lands in neither, so the slid stretch is split off rather than left to share the line. A polygon with no slid outline corner is the plain fan.
        const nC = c.length,
          slideAt = (k) => {
            const g = fanSeamDirs && fanSeamDirs[k];
            return g && (g[0] || g[1]) ? [g[0] * FAN_S, g[1] * FAN_S] : null;
          };
        const wears = (k) => !!(part.edgeW && part.edgeW[k] > 0);
        const ring = [];
        let split = false;
        for (let k = 0; k < nC; k++) {
          const k1 = (k + 1) % nC,
            s0 = slideAt(k),
            s1 = slideAt(k1),
            w = wears(k);
          ring.push([c[k], s0 || [0, 0], BIG]);
          if (w && s0) {
            ring.push([c[k], [0, 0], BIG]);
            split = true;
          }
          if (w && s1) {
            ring.push([c[k1], [0, 0], BIG]);
            split = true;
          }
        }
        if (!split)
          for (const k of order)
            emit.push(ring.length === nC ? ring[k] : [c[k], slideAt(k) || [0, 0], BIG]);
        else {
          // From the middle, so every outline edge is the edge of a triangle with area: a fan from a corner gives the two edges beside it to no triangle of their own.
          let mx = 0,
            my = 0;
          for (const q of c) {
            mx += q[0];
            my += q[1];
          }
          const mid = [[mx / nC, my / nC], [0, 0], BIG];
          for (let j = 0; j < ring.length; j++)
            emit.push(mid, ring[j], ring[(j + 1) % ring.length]);
        }
      }
      if (!areaWhole) {
        const nC = c.length,
          eW = part.edgeW;
        let area2 = 0;
        for (let k = 0; k < nC; k++) {
          const a2 = c[k],
            b2 = c[(k + 1) % nC];
          area2 += a2[0] * b2[1] - b2[0] * a2[1];
        }
        const sg2 = area2 < 0 ? -1 : 1;
        const nrm = [];
        for (let k = 0; k < nC; k++) {
          const a2 = c[k],
            b2 = c[(k + 1) % nC];
          const ex = b2[0] - a2[0],
            ey = b2[1] - a2[1],
            L2 = Math.hypot(ex, ey) || 1;
          const w = eW ? eW[k] : 1;
          nrm.push([sg2 * (ey / L2) * w, -sg2 * (ex / L2) * w, w]);
        }
        // THE SKIRT IS A MITER-JOINED OFFSET QUAD PER EDGE, which is what makes its own plane the
        // right one for every fragment in it AND leaves no corner uncovered.
        //
        // A bands-plus-wedges form has two defects. A wedge triangle blends two planes' distances
        // across itself, so the value a fragment reads there is neither plane's; and where a ZERO-REACH
        // edge (a seam, since seams wear no skirt) meets an outline edge, the corner closure is a
        // triangle with two identical vertices -- zero area, drawing nothing -- so the corner is a hole.
        //
        // A miter quad fixes both at once. Its outer corner is the point where the two adjacent
        // OFFSET lines cross, so it lies exactly on this edge's offset line: its distance is
        // -reach_k with no em-space quantity anywhere, and the whole quad carries one plane's exact
        // affine distance. Consecutive quads share that corner, so the annulus is tiled rather than
        // patched. And a zero-reach neighbor is not a special case: its offset line IS its hull
        // edge, so the crossing slides onto the hull and the skirt tapers to nothing at the seam,
        // which is exactly where it should stop.
        //
        // Solved, not approximated: the outer corner d satisfies d.u_prev = w_prev and d.u_k = w_k
        // for the two outward unit normals, one 2x2 system per corner. Parallel normals (a
        // straight-through corner) are the singular case and fall back to this edge's own normal.
        const uo = [],
          W = [];
        for (let k = 0; k < nC; k++) {
          const w = nrm[k][2];
          W.push(w);
          uo.push(
            w > 0
              ? [nrm[k][0] / w, nrm[k][1] / w]
              : (() => {
                  const a2 = c[k],
                    b2 = c[(k + 1) % nC];
                  const ex = b2[0] - a2[0],
                    ey = b2[1] - a2[1],
                    L2 = Math.hypot(ex, ey) || 1;
                  return [sg2 * (ey / L2), -sg2 * (ex / L2)];
                })(),
          );
        }
        //
        //     cap    frame     wrong solid   painted outside   AA over0.3
        //     4.0    2.70          52             104             371
        //     1.5    2.70          11              55             339
        //     1.05   2.20           6              42             332
        //
        // Monotone in all four, so there is no trade to balance: the tight cap is simply right.
        const MCAP = mantleDebugHook('__CP_MITER_CAP') ?? 1.05;
        const CP_SQUARE_MIN = 2.1;
        //
        // ...BUT NOT WHERE IT THINS THE SKIRT. Against a seam at a SHARP corner the exact miter point runs far
        // out along the seam line, and capped to 1.05 reach it lies nearly along the edge: the quad tapers from the full
        // reach at the far end to almost nothing at the corner, and the AA band along the whole edge loses its outer
        // pixels -- centers a fraction of a pixel outside the hull that no fragment reaches.
        // There the corner squares off instead: this edge's own normal times its reach, so the band
        // keeps its full depth to the corner and stops on the corner's perpendicular, short of where the outline turns
        // onto the neighbor's arc.
        const corner = (j1, j2, cur) => {
          const a = uo[j1],
            b = uo[j2],
            w1 = W[j1],
            w2 = W[j2];
          const det = a[0] * b[1] - a[1] * b[0];
          if (!(Math.abs(det) > 1e-7)) return [b[0] * w2, b[1] * w2];
          let dx = (w1 * b[1] - w2 * a[1]) / det,
            dy = (-w1 * b[0] + w2 * a[0]) / det;
          const L = Math.hypot(dx, dy),
            cap = MCAP * Math.max(w1, w2, 1e-9);
          if (L > cap && (w1 === 0 || w2 === 0)) return [uo[cur][0] * W[cur], uo[cur][1] * W[cur]];
          // ...AND BETWEEN TWO OUTLINE EDGES THE same, once the cap would leave less than half the band.
          // Capped, the corner keeps w * cap / L of this edge's reach, so past L = 2.1 w (a corner under about 57 degrees)
          // it holds under half and the AA band starves toward the vertex.
          if (L > CP_SQUARE_MIN * Math.max(w1, w2, 1e-9))
            return [uo[cur][0] * W[cur], uo[cur][1] * W[cur]];
          if (L > cap) {
            dx *= cap / L;
            dy *= cap / L;
          }
          return [dx, dy];
        };
        for (let k = 0; k < nC; k++) {
          const w = W[k];
          if (!(w > 0)) continue; // a seam wears no skirt; its neighbors taper to it
          const a2 = c[k],
            b2 = c[(k + 1) % nC],
            z = [0, 0];
          const dA = corner((k + nC - 1) % nC, k, k),
            dB = corner(k, (k + 1) % nC, k);
          const dz = -1.5 * w; // both outer corners lie on this edge's offset line
          // AND THE PLANE'S own NORMAL, because the offset direction is no longer parallel to it.
          // A band's outer rim would move straight out along the normal, so the kernel could recover
          // the normal by normalizing the interpolated offset. A MITER corner moves along the bisector
          // instead, so that recovery is wrong by the miter angle -- which is an AA error. Carried explicitly, equal
          // on all four vertices, so there is nothing to interpolate.
          // THE INNER RIM IS THE FAN'S EDGE, VERTEX FOR VERTEX, unslid at both ends (see the fan above).
          emit.push([a2, z, 0], [b2, z, 0], [b2, dB, dz]);
          emit.push([a2, z, 0], [b2, dB, dz], [a2, dA, dz]);
        }
      }
      for (const [pos, dir, hz] of _skipGeom9 ? [] : emit) {
        const v = new Array(LB_STRIDE).fill(0);
        // The cover in the contour's frame too: the vertex stage adds O back for paint and projects
        // from the frame, so the rasterized cover meets the seams the kernel cuts in it. In world coordinates it
        // would be rounded where the contour sits, a sixteenth of a unit at 1e6.
        v[0] = pos[0];
        v[1] = pos[1];
        v[17] = O[0];
        v[18] = O[1]; // aC2.zw → the kernel's frame (see O above)
        v[2] = dir[0];
        v[3] = dir[1]; // aTC.xy → px-space cover dilation direction
        v[4] = hz; // aTC.z → signed distance to the hull, in pixels
        // aC1 + aC2.xy → the patch's oriented box, on every vertex: it bounds the primitive, so it
        // applies to the fan exactly as it does to the skirt.
        if (OB) {
          v[11] = OB[0];
          v[12] = OB[1];
          v[13] = OB[2];
          v[14] = OB[3];
          v[15] = OB[4];
          v[16] = OB[5];
        }
        v[5] = CPATCH_STREAM_TAG;
        v[6] = 1;
        // THE CELL'S own BOX, so the fragment can decide which cell OWNS it.
        //
        // Covers are dilated (1.5px for the AA ramp, +1% to close a rasterization crack), so
        // neighboring cells shade the same fragments — overlap by construction, ~3px of it. That
        // is invisible at alpha 1 and doubles every overlap below it, and it is what forced the
        // depth claim. The decomposition itself does not overlap: gridSplitPatch cuts on a COMMON
        // grid, so a half-open test against this box tiles exactly and cannot crack the way two
        // separately-derived cut edges did.
        //
        // Rides aC0 because CPatch leaves it empty and, in the compact stream, the block aC0..aC3
        // live in is already per-cell (it carries this cell's first/count). Zeroes mean "no box"
        // — an ungridded patch is one cell and owns everything its constraints admit.
        if (part.box) {
          v[7] = part.box[0];
          v[8] = part.box[1];
          v[9] = part.box[2];
          v[10] = part.box[3];
        }
        // aC3 → cCen = (first, blocks).
        v[19] = first;
        v[20] = hullRows + part.idx.length;
        verts.push(...v);
      }
    }
    if (!ok) {
      dropped++;
      continue;
    }
  }
  if (!verts.length) return null;
  return {
    texels: new Float32Array(texels),
    verts: new Float32Array(verts),
    vertexCount: verts.length / LB_STRIDE,
    cpatch: true,
    kindMask: 1 << CPATCH_STREAM_TAG,
    hasQuadraticArea: !!areaPatch,
    hasCubicArea: false,
    patches: patches.length,
    dropped,
    cells,
    kinds,
    // Patches the converter could not validate. Surfaced because a row carrying
    // these still passes a 15% ink gate while painting a visible wedge of
    // over-fill — which is what the cubic N=3 case did until AA caught it.
    unresolved: (stats && stats.unresolved) | 0,
    // PATCHES WITH nothing THAT CAN RAMP, and the ones an outline can reach.

    // AND A HARD STEP IS exact FOR MOST OF THEM, which is the bound this count exists to make
    // visible. The outline is OUTSIDE the patch, so a pixel the patch paints can only be partly
    // covered by the shape if the outline reaches within the filter's own half-diagonal
    // (CP_AA_REACH, 0.7072 px) of that pixel's center -- and the center is inside the patch, so the
    // outline must come within that of the patch itself. An all-seam patch the outline cannot reach
    // paints 1.0 on pixels the shape covers whole, and 1.0 is the right answer.

    allSeam,
    comp: compN,
  };
}

/// Group a shape's contours into (outer, holes) by NESTING DEPTH, even-odd style: a
/// contour inside an odd number of others is a hole, and it belongs to the innermost
/// contour containing it. Depth rather than orientation, because real art does not
/// reliably wind holes the other way — and a wrongly-classified hole is either a
/// filled hole or a vanished shape, both loud.
///
/// Containment is tested with one point per contour against a flattened outline. That
/// point is a curve endpoint, so it is on the boundary of its own contour and strictly
/// inside or outside every other — the ambiguous case does not arise here.
/// `evenOdd` selects the FILL RULE, and the two disagree on real art:
///
///   EVEN-ODD  nesting parity alone — a contour inside an odd number of others is a
///             hole, whatever direction it winds.
///   NONZERO   direction decides — a nested contour is a hole only when it winds
///             OPPOSITE to the contour containing it. Two nested contours winding the
///             same way are both filled, and even-odd would wrongly punch a hole.
///
/// Handling only one rule is not a subset of handling both: each paints regions the
/// Pack a whole shape (its contours) into ONE mesh, concatenating both planes and
/// keeping (first, count) absolute across contours.
/// Do these cycles fill what the contours fill?
///
/// The arrangement's cycles are a boundary for the shape's fill, so their own nonzero winding
/// should agree with the contours' everywhere. A pentagram's four cycles do not -- they fill its
/// center, which is the case resolveSelfOverlap exists for. A contour that merely touches itself
/// gives cycles that agree exactly, and resolving those makes them worse.
///
/// The cycles are read by their nonzero winding (insideContour is built on rowSpans, which sweeps a
/// winding number); the contours are read under the shape's own fill rule (insideRule).
export function cyclesReproduceFill(list, cy, evenOdd, allowEmpty = false) {
  // THE GAP THAT COUNTS AS OPEN, against the art's own size rather than in world units -- the
  // same contour at 1/16 scale must be closed or open at both sizes, or this oracle answers a
  // different question about the same shape.
  let ext = 0;
  {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const c of list)
      if (c)
        for (const s of c)
          for (const q of s.P) {
            if (q[0] < x0) x0 = q[0];
            if (q[0] > x1) x1 = q[0];
            if (q[1] < y0) y0 = q[1];
            if (q[1] > y1) y1 = q[1];
          }
    if (x1 >= x0) ext = Math.max(x1 - x0, y1 - y0);
  }
  const gapEps = 1e-6 * ext;
  const closed = [];
  for (const c of list) {
    if (!c || !c.length) continue;
    for (const s of c) closed.push(s);
    const a = segPt(c[0], 0),
      b = segPt(c[c.length - 1], 1);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > gapEps) closed.push({ t: 'line', P: [b, a] });
  }
  const cyc = [];
  for (const c of cy) for (const s of c) cyc.push(s);
  if (!closed.length || (!cyc.length && !allowEmpty)) return false;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of closed)
    for (const q of s.P) {
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[1] > y1) y1 = q[1];
    }
  if (!(x1 > x0) || !(y1 > y0)) return false;
  const pad = 0.02 * Math.max(x1 - x0, y1 - y0);
  x0 -= pad;
  x1 += pad;
  y0 -= pad;
  y1 += pad;
  const G = 48;
  let bad = 0;
  for (let j = 0; j < G; j++) {
    const y = y0 + ((y1 - y0) * (j + 0.5)) / G;
    for (let i = 0; i < G; i++) {
      const x = x0 + ((x1 - x0) * (i + 0.5)) / G;

      if (insideRule(closed, x, y, evenOdd) !== insideContour(cyc, x, y)) bad++;
    }
  }
  // A boundary sample can land either side of an edge, so this is not asked to be exact -- only
  // to tell "the same region" from "the center of a star".
  return bad <= G * G * 0.004;
}

function packLegacyCPatchShape(contours, baseBlock = 0, opts = {}) {
  const dbgGrid = mantleDebugHook('__CP_GRID'),
    grid = dbgGrid ?? opts.grid ?? 1;
  // __CP_NO_AREA = 1 (a debug hook): no complete-paint area, so a polynomial shape takes the seam path -- the one the seam
  // rules and their smokes exist for.
  const noArea = mantleDebugHook('__CP_NO_AREA') === 1;
  // Static trace hints do not change a complete-paint certificate; bake and live builds must agree.
  if (!noArea && grid === 1 && !opts.record && !opts.follow && !opts.holes?.length) {
    const cert = certifySimplePolynomialPaint(contours, !!opts.evenOdd);
    if (cert) {
      if (opts.collect)
        return {
          texels: [],
          verts: [],
          vertexCount: 0,
          kindMask: 0,
          dropped: 0,
          unresolved: 0,
          cells: 0,
          allSeam: 0,
        };
      return packSimplePolynomialPaint(cert, baseBlock, opts);
    }
  }

  // Area is one complete paint, not independent area pieces. Only the single
  // original certified loop may take it; extracted faces retain CPatch.
  opts = {
    ...opts,
    quadraticAreaSource:
      !noArea && contours?.length === 1 && convexQuadraticContour(contours[0]) ? contours[0] : null,
  };

  const state = {};
  if (opts.graph !== false) {
    const viaGraph = packShapeFrom(contours, baseBlock, opts, true, state);
    if (viaGraph) return viaGraph;
    if (state.selfIntersect) return null;
  }
  return packShapeFrom(contours, baseBlock, opts, false, state);
}

// Extracted cycles take the complete-paint area when each pair of consecutive curves meets at one graph node, whose two
// computed coordinates differ only by the intersection solver's rounding: the node's coordinate is then shared exactly, and
// the whole-paint certificate (exact closure, injectivity, pairwise separation, nesting) runs on the snapped cycles. A gap
// beyond CYCLE_NODE_ULPS units of the paint's largest coordinate is a different node: the cycles decline.
const CYCLE_NODE_ULPS = 4096;
function certifyExtractedCycles(cycles) {
  let cm = 0;
  for (const loop of cycles)
    for (const c of loop) for (const q of c.P) cm = Math.max(cm, Math.abs(q[0]), Math.abs(q[1]));
  if (!(cm > 0) || !Number.isFinite(cm)) return null;
  const tol = CYCLE_NODE_ULPS * Number.EPSILON * cm;
  const snapped = cycles.map((loop) => loop.map((c) => ({ ...c, P: c.P.map((q) => q.slice()) })));
  for (const loop of snapped) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i].P[loop[i].P.length - 1],
        z = loop[(i + 1) % loop.length].P[0];
      if (a[0] === z[0] && a[1] === z[1]) continue;
      if (!(Math.hypot(a[0] - z[0], a[1] - z[1]) <= tol)) return null;
      z[0] = a[0];
      z[1] = a[1];
    }
  }
  return certifySimplePolynomialPaint(snapped, false, { nodeJoints: true });
}

function packShapeFrom(contours, baseBlock, opts, useGraph, state) {
  const parts = [];
  let blockCursor = baseBlock,
    nTex = 0,
    nVert = 0;
  // Resolve crossings and extract fill-scored cycles before decomposing contours.

  // Falls back to the raw contours whenever the graph yields nothing, so a path the
  // front end cannot handle still converts from its contours rather than disappearing.
  let list = contours || [];
  // Extracted cycles already encode the authored fill rule; group them as
  // a nonzero region to avoid applying even-odd parity twice.
  let listEvenOdd = !!opts.evenOdd;

  const ckey =
    useGraph && list.length && opts.cycleCache
      ? cpatchShapeKey(list, 'c' + (opts.evenOdd ? 'e' : 'n'))
      : null;
  const chit = ckey ? opts.cycleCache.get(ckey) : undefined;
  if (chit) {
    if (chit.union)
      return packShapeFrom(chit.list, baseBlock, { ...opts, graph: false }, false, state);
    list = chit.list;
    if (chit.cycles) listEvenOdd = false;
  } else if (useGraph && list.length) {
    let cy = null;

    const gkey =
      !opts.record && !opts.follow && (opts.traces || opts.traceOut)
        ? 'g' + traceKeyHash(cpatchShapeKey(list))
        : null;
    const gIn = gkey && opts.traces ? opts.traces.get(gkey) : null;
    const gOut = gkey && opts.traceOut && !gIn ? [] : null;
    try {
      cy = pathToCycles(list, !!opts.evenOdd, gIn ? gIn.cuts : null, gOut);
    } catch {
      cy = null;
    }
    if (gOut && gOut.length) opts.traceOut.set(gkey, { cuts: gOut });
    // When extraction adds cycles or segments, check the resulting fill.
    // A failed comparison requires self-overlap resolution; unresolved shapes decline.

    // Compare extracted cycles with the authored fill before using them.
    const nSeg = (l) => {
      let n = 0;
      for (const c of l) n += c.length;
      return n;
    };
    if (
      cy &&
      cy.length &&
      (cy.length > list.length || nSeg(cy) > nSeg(list)) &&
      !cyclesReproduceFill(list, cy, !!opts.evenOdd)
    ) {
      const toSeg = (c) =>
        c.t === 'line'
          ? mkLine(c.P[0], c.P[1])
          : c.t === 'quad'
            ? mkQuad(c.P[0], c.P[1], c.P[2])
            : c.t === 'cubic'
              ? mkCubic(c.P[0], c.P[1], c.P[2], c.P[3])
              : mkRQuad(c.P[0], c.P[1], c.P[2], c.w == null ? 1 : c.w);
      const fromSeg = (g) =>
        g.type === SEG_LINE
          ? { t: 'line', P: [g.p1, g.p2] }
          : g.type === SEG_QUAD
            ? { t: 'quad', P: [g.p1, g.p2, g.p3] }
            : g.type === SEG_CUBIC
              ? { t: 'cubic', P: [g.p1, g.p2, g.p3, g.p4] }
              : g.type === SEG_RQUAD
                ? { t: 'rquad', P: [g.p1, g.p2, g.p3], w: g.w }
                : null;
      let simple = null;
      try {
        simple = resolveSelfOverlap(
          list.map((c) => c.map(toSeg)),
          opts.evenOdd ? 'evenodd' : 'nonzero',
        );
      } catch {
        simple = null;
      }
      const back =
        simple && simple.map((c) => c.map(fromSeg).filter(Boolean)).filter((c) => c.length >= 2);
      if (back && back.length) {
        if (ckey) opts.cycleCache.set(ckey, { list: back, union: true });
        return packShapeFrom(back, baseBlock, { ...opts, graph: false }, false, state);
      }
      if (state) state.selfIntersect = true;
      return null; // unresolved → Slug draws it
    }
    // No cycles at all: the arrangement found the winding zero everywhere, as under a contour drawn twice in opposite
    // directions or twice under even-odd. Decomposing the raw contours would fill what the arrangement just canceled.
    if (
      cy &&
      !cy.length &&
      !opts.record &&
      !opts.follow &&
      cyclesReproduceFill(list, cy, !!opts.evenOdd, true)
    ) {
      return {
        texels: [],
        verts: [],
        vertexCount: 0,
        kindMask: 0,
        dropped: 0,
        unresolved: 0,
        cells: 0,
        allSeam: 0,
      };
    }
    if (cy && cy.length) {
      // Require empty interior points of authored holes to remain empty.
      // Extracted faces need not preserve a nested-contour hole count.
      let keep = true;
      try {
        const cyc = [];
        for (const c of cy) for (const sg of c) cyc.push(sg);
        const closed = [];
        let _ext = 0;
        {
          let x0 = Infinity,
            y0 = Infinity,
            x1 = -Infinity,
            y1 = -Infinity;
          for (const c of list)
            if (c)
              for (const sg of c)
                for (const q of sg.P) {
                  if (q[0] < x0) x0 = q[0];
                  if (q[0] > x1) x1 = q[0];
                  if (q[1] < y0) y0 = q[1];
                  if (q[1] > y1) y1 = q[1];
                }
          if (x1 >= x0) _ext = Math.max(x1 - x0, y1 - y0);
        }
        const _gapEps = 1e-6 * _ext; // an open gap, against the art's size, not in world units
        for (const c of list) {
          if (!c || !c.length) continue;
          for (const sg of c) closed.push(sg);
          const a0 = segPt(c[0], 0),
            b0 = segPt(c[c.length - 1], 1);
          if (Math.hypot(a0[0] - b0[0], a0[1] - b0[1]) > _gapEps)
            closed.push({ t: 'line', P: [b0, a0] });
        }
        for (const g of groupContours(list, !!opts.evenOdd)) {
          for (const h of g.holes) {
            const q = interiorPoint(h);
            if (!q) continue;
            // Use the authored fill rule to distinguish empty holes from filled overlaps.
            if (insideRule(closed, q[0], q[1], !!opts.evenOdd)) continue;
            if (insideContour(cyc, q[0], q[1])) {
              keep = false;
              break;
            }
          }
          if (!keep) break;
        }
        // ...and the region as a whole, which is the test the resolver gate above already asks.
        if (keep) keep = cyclesReproduceFill(list, cy, !!opts.evenOdd);
      } catch {
        keep = false;
      }
      if (keep) {
        list = cy;
        listEvenOdd = false;
      }
    }
    if (ckey) opts.cycleCache.set(ckey, { list, cycles: list === cy });
  }
  if (opts._onNormalizedBoundary) opts._onNormalizedBoundary(list, listEvenOdd);
  // Extracted cycles that pass the complete-paint certificate are one area, not decomposed patches.
  if (
    useGraph &&
    list !== contours &&
    !listEvenOdd &&
    !opts.record &&
    !opts.follow &&
    !opts.holes?.length &&
    (opts.grid ?? 1) === 1 &&
    mantleDebugHook('__CP_GRID') == null &&
    mantleDebugHook('__CP_NO_AREA') !== 1 &&
    !mantleDebugHook('__CP_NO_CYCLE_AREA')
  ) {
    let cert = certifyExtractedCycles(list);
    // The arrangement's crossing search can lose a crossing beside a shared vertex, or one the implicit's composition meets as a
    // double root, in some copies of a drawing and not others. Where the cycles do not certify, search again for those too and
    // certify the result: a paint that does is one area (the certificate proves the cycles simple and nested), a paint that does not
    // keeps the decomposition the first search chose, untouched.
    if (!cert) {
      let wide = null;
      try {
        wide = pathToCycles(contours, !!opts.evenOdd, null, null, true);
      } catch {
        wide = null;
      }
      if (wide && wide.length) cert = certifyExtractedCycles(wide);
    }
    if (cert) {
      if (opts._onCertifiedBoundary) opts._onCertifiedBoundary(cert);
      if (opts.collect)
        return {
          texels: [],
          verts: [],
          vertexCount: 0,
          kindMask: 0,
          dropped: 0,
          unresolved: 0,
          cells: 0,
          allSeam: 0,
        };
      return packSimplePolynomialPaint(cert, baseBlock, opts);
    }
  }
  // Collect patches across the complete shape for the coverage guard.
  // Disable it during record/follow replay, where unilateral refusal would
  // break pose correspondence, or when the caller supplies its own guard.
  const guarding = opts.coverGuard !== false && !opts.record && !opts.follow;
  const seen = guarding ? [] : null;
  const userOnPatches = opts.onPatches;
  const gOpts = guarding
    ? {
        ...opts,
        onPatches: (ps, holes) => {
          for (const p of ps) seen.push(p);
          if (userOnPatches) userOnPatches(ps, holes);
        },
      }
    : opts;
  // THE SHAPE'S own FILL, for splitPartialSeams: the artwork's contours, closed, under the artwork's rule.
  const shapeFill = { curves: [], evenOdd: !!opts.evenOdd };
  for (const c of contours || []) {
    if (!c || !c.length) continue;
    for (const sg of c) shapeFill.curves.push(sg);
    const a = c[0].P[0],
      z = c[c.length - 1].P[c[c.length - 1].P.length - 1];
    if (a[0] !== z[0] || a[1] !== z[1]) shapeFill.curves.push({ t: 'line', P: [z, a] });
  }
  const groups = groupContours(list, listEvenOdd);
  for (const g of groups) {
    // Bridge holes away FIRST; only fall back to the constraint path if no bridge
    // can be routed, so a shape is never lost to a failed bridge.
    const bridged = g.holes.length ? bridgeHoles(g.outer, g.holes) : g.outer;
    const c = bridged || g.outer;
    const m = packCPatchContour(
      c,
      blockCursor,
      bridged ? { ...gOpts, shapeFill } : { ...gOpts, holes: g.holes, shapeFill },
    );
    if (!m) return null; // all-or-nothing: a partial shape under-fills
    parts.push(m);
    blockCursor += m.texels.length / CP_BLOCK_FLOATS;
    nTex += m.texels.length;
    nVert += m.verts.length;
  }
  if (!parts.length) return null;
  // Compare coverage with the authored contours and fill rule,
  // independently of the cycles selected by the arrangement.
  if (guarding && seen.length && !certifiedWholeQuadraticShape(contours, seen)) {
    let refuse = false;
    try {
      refuse = shapeUnderCovers(contours || [], seen, !!opts.evenOdd);
    } catch {
      refuse = false;
    }
    if (refuse) {
      if (state) state.underCovered = true;
      if (opts.report) opts.report.underCovered = true;
      return null;
    }
  }
  const texels = new Float32Array(nTex),
    verts = new Float32Array(nVert);
  let to = 0,
    vo = 0,
    unresolved = 0,
    cells = 0,
    dropped = 0,
    allSeam = 0,
    comp = 0;
  for (const m of parts) {
    texels.set(m.texels, to);
    to += m.texels.length;
    verts.set(m.verts, vo);
    vo += m.verts.length;
    unresolved += m.unresolved;
    cells += m.cells;
    dropped += m.dropped;
    allSeam += m.allSeam | 0;
    comp += m.comp | 0;
  }
  return {
    texels,
    verts,
    vertexCount: verts.length / LB_STRIDE,
    cpatch: true,
    kindMask: 1 << CPATCH_STREAM_TAG,
    hasQuadraticArea: parts.some((m) => m.hasQuadraticArea !== false),
    hasCubicArea: parts.some((m) => m.hasCubicArea !== false),
    unresolved,
    cells,
    dropped,
    allSeam,
    comp,
  };
}

/// PLAN one segment of a morph: the cells, and the vertex stream, ONCE for the whole span.

/// The cells can be fixed instead of abandoned. Both decisions a cell makes are read at one pose
/// and both survive the span with the geometry's MOTION folded into their margins (see
/// gridSplitPatch), and the cover is the union of the span's two ends — every intermediate pose's
/// control points are convex combinations of theirs, so its patch is inside it. What comes out is
/// fixed for the segment: the same cells, the same curve lists, the same triangles.
///
/// Returns null when any patch cannot be split or packed, and the caller keeps its engine.
///
/// THE SPAN HAS ONE KERNEL FRAME, `opts.frame`: the patches come in relative to it, the
/// blocks are packed relative to it, and every cover vertex carries it in aC2.zw as a static pack's does.
/// It is fixed for the segment -- the blend rebuilds each texel as a polynomial in the pose, and a
/// constant translation keeps it one -- and absent, it is the origin (world em).
export function planCPatchMorphSegment(patchesLo, patchesHi, baseBlock, opts = {}) {
  if (!patchesLo || !patchesHi || patchesLo.length !== patchesHi.length) return null;
  const GRID = opts.grid != null ? opts.grid : 1; // see the sweep above
  const O = opts.frame || [0, 0];

  const GRID_AA = opts.gridAaPx != null ? opts.gridAaPx : 1.5;
  const cells = [];
  const verts = [];
  const bounds = [];
  let block = 0;
  for (let pi = 0; pi < patchesLo.length; pi++) {
    const lo = patchesLo[pi],
      hi = patchesHi[pi];
    if (!lo || !hi || lo.curves.length !== hi.curves.length) return null;
    bounds.push(lo.curves.map((c, ci) => morphArcBounds(c, hi.curves[ci])));
    // How far anything in this patch can move across the span. A Bezier's points are convex
    // combinations of its control points, so no point of it moves further than the furthest
    // control point does.
    let movePx = 0;
    const both = [];
    for (let c = 0; c < lo.curves.length; c++) {
      const P = lo.curves[c].P,
        Q = hi.curves[c].P;
      if (P.length !== Q.length) return null;
      for (let k = 0; k < P.length; k++) {
        movePx = Math.max(movePx, Math.hypot(Q[k][0] - P[k][0], Q[k][1] - P[k][1]));
      }
      both.push(lo.curves[c], hi.curves[c]);
    }
    // CONTROL POINTS, not samples: this cover spans two poses and must contain every one between
    // them, and the certificate has no room for the chord sagitta a sampled hull leaves.
    const cover = patchCoverHull(both, 0),
      coverLines = patchCoverLines(both, 0);
    /** @type {Array<{poly:number[][],idx:number[],box?:number[],raw?:number[]}>} */
    let parts = null;
    if (GRID > 1 && cover && coverLines) {
      const cs = gridSplitPatch(lo, GRID, GRID_AA, { movePx, cover, coverLines });
      if (cs && cs.length)
        parts = cs.map((c) => ({
          poly: c.poly,
          idx: c.curves,
          box: c.ownBox || c.box,
          raw: c.box,
        }));
    }
    // No usable split: the whole union cover as one part, carrying every curve.
    if (!parts) {
      const hull = cover || (lo.obb && lo.obb.corners);
      if (!hull || hull.length < 3) return null;
      parts = [{ poly: hull, idx: lo.curves.map((_, i) => i) }];
    }
    for (const part of parts) {
      const first = baseBlock + block;
      cells.push({ pi, idx: part.idx, first, at: block * CP_BLOCK_FLOATS });
      block += part.idx.length;
      const c = part.poly,
        dirs = coverOffsetDirs(c, part.box);
      for (let k = 1; k + 1 < c.length; k++) {
        for (const j of [0, k, k + 1]) {
          const v = new Array(LB_STRIDE).fill(0);
          v[0] = c[j][0];
          v[1] = c[j][1]; // the cover in the span's frame, as a static pack's
          v[17] = O[0];
          v[18] = O[1]; // aC2.zw -> the span's kernel frame
          v[5] = CPATCH_STREAM_TAG;
          v[6] = 1;
          v[2] = dirs[j][0];
          v[3] = dirs[j][1]; // aTC.xy -> px-space cover dilation direction
          // aTC.z -> "no hull plane here". The kernel reads vTC.z as this fragment's
          // signed distance, in pixels, to its patch's hull, and takes exactBoxCov of it: that is the
          // static packer's skirt, whose rim sits at 0 and whose fan carries +1e3. This emission is
          // the older DILATED cover, which never had a skirt and left the slot 0 -- which the kernel
          // reads as "every fragment sits on the hull" and caps at exactBoxCov(n, 0) = 0.5. That cap,
          // on every fragment of every patch, is why a posed morph drew nothing darker than
          // mid-gray. What bounds a morph patch is its constraints, which the certificate has proved
          // leak-free across the span inside the cover, and the cover itself.
          v[4] = 1e3;
          // the cell's own box — see the static emit above for why it exists
          if (part.box) {
            v[7] = part.box[0];
            v[8] = part.box[1];
            v[9] = part.box[2];
            v[10] = part.box[3];
          }
          v[19] = first;
          v[20] = part.idx.length;
          verts.push(...v);
        }
      }
    }
  }
  if (!cells.length || !verts.length) return null;
  // A MORPH'S CORNERS, per patch and curve, from the segment's first pose: the corners its static cover would
  // draw, which this cover -- the span's dilated hull -- does not (see CPK_END).
  const endFlags = patchesLo.map((p) => {
    markSeamCorners([p]);
    return arcFlagsOf(p);
  });
  // A morph's straight seams' outline ends: which ends arm, frozen from the segment's first pose like the corners
  // above (the kind word is not blended); the legs themselves are packed per pose (packCPatchMorphFrame).
  markSeamEnds(patchesLo);
  const seamArm = patchesLo.map((p) =>
    p.curves.map((c) => {
      const e = c.cut && c.P.length === 2 && p[K_SEAMEND] ? p[K_SEAMEND].get(c) : null;
      return e ? (e[0] ? 1 : 0) + (e[1] ? 2 : 0) : 0;
    }),
  );
  return {
    cells,
    bounds,
    endFlags,
    seamArm,
    verts: new Float32Array(verts),
    vertexCount: verts.length / LB_STRIDE,
    frame: O,
    cpatch: true,
    kindMask: 1 << CPATCH_STREAM_TAG,
    curveBlocks: block,
    patches: patchesLo.length,
  };
}

/// WHAT AN ARC'S BOUNDS ARE UNDER A MORPH, for the span between two poses of it.
///
/// A static block carries the arc's tight box (texel 3) and its cross-chord strip (texel 4). Neither
/// is polynomial in the pose -- a box is a min over the arc's extremes, a strip's normal is a
/// normalized chord -- so neither survives the GPU blend, which rebuilds every texel as a quadratic
/// from three packed poses (cpatchMorphBlend). What the blend DOES carry exactly is anything linear
/// or constant, and there is a bound of each kind that holds at every pose of the span:

function morphArcBounds(a, b) {
  const ba = segTightBBox(a),
    bb = segTightBBox(b);
  const box = [
    Math.min(ba[0], bb[0]),
    Math.min(ba[1], bb[1]),
    Math.max(ba[2], bb[2]),
    Math.max(ba[3], bb[3]),
  ];
  if (a.P.length === 2) {
    const kx = a.P[0][0] <= a.P[1][0] === b.P[0][0] <= b.P[1][0];
    const ky = a.P[0][1] <= a.P[1][1] === b.P[0][1] <= b.P[1][1];
    return { line: true, box, poseX: kx, poseY: ky, strip: [0, 0, 0, 0] };
  }
  const e0 = segStart(a),
    e1 = segEnd(a),
    f0 = segStart(b),
    f1 = segEnd(b);
  const dx = e1[0] + f1[0] - (e0[0] + f0[0]),
    dy = e1[1] + f1[1] - (e0[1] + f0[1]),
    L = Math.hypot(dx, dy);
  // A chord that closes on itself has no normal to give, and a strip nothing lies outside of is
  // what chordStrip reports for it too.
  let strip = [0, 0, -1e30, 1e30];
  if (L > 0) {
    const nx = -dy / L,
      ny = dx / L;
    strip = [
      nx,
      ny,
      Math.min(segAffMin(a, nx, ny).m, segAffMin(b, nx, ny).m),
      Math.max(-segAffMin(a, -nx, -ny).m, -segAffMin(b, -nx, -ny).m),
    ];
  }
  return { line: false, box, strip };
}

/// A BETTER PACKING FOR THE IN-FILL BLEND, derived rather than guessed.
///
/// A morph segment's coefficients are degree 2 in t, so the obvious way to blend them in the fill
/// kernel is to store three poses and Lagrange between them: 3x the fetches, 3x the memory. That
/// is more than the structure actually needs, and probes/_cpatchTexelDegree.mjs measures which
/// slots move how fast:
///
///     a*.x deg 1    a*.y deg 1    a*.z deg 2    kind deg 0    sg deg 0    c0/c1 deg 2
///
/// x and y come from Xm/Ym, which are linear in the control points and so linear in t once the
/// conditioning is frozen; only z carries a cross product. A row is read as A = dot(e.xy, p) + e.z,
/// so
///
///     A(u) = (x0 + u x1) px + (y0 + u y1) py + (z0 + u z1 + u^2 z2)
///          = [x0 px + y0 py + z0] + u [x1 px + y1 py + z1] + u^2 z2
///          =        P0(p)         + u        P1(p)         + u^2 z2
///
/// The u^2 term is a SCALAR — nothing quadratic ever touches p. So a row needs TWO affine
/// functionals and one constant, not three poses:
///
///     kind     static   three poses   P0/P1/z2
///     line          1             3          2
///     quad          2             6          4
///     rquad         3             9          6
///     bez           4            12          9
///
/// Layout: per row, [P0.xyz, z2] and [P1.xyz, extra], with kind and sg in the two spare `extra`
/// slots (both constant in t) and one further texel carrying c0/c1's three coefficients each.

/// A curve appears in every cell that could not rule it out, so its packed form is derived ONCE
/// per patch curve and copied into each slot that wants it — the derivation is a resultant, the
/// copy is one block.
export function packCPatchMorphFrame(patches, plan, out) {
  if (!plan) return null;
  // A MORPH'S CORNERS ARE THE SEGMENT'S, decided once from its first pose (planCPatchMorphSegment): the GPU blend carries a
  // block's kind word unblended from that pose, so a pose packed here must carry the same bits.
  const endF = plan.endFlags || null,
    seamArm = plan.seamArm || null;
  if (seamArm) markSeamEnds(patches);
  const texels =
    out && out.texels && out.texels.length === plan.curveBlocks * CP_BLOCK_FLOATS
      ? out.texels
      : new Float32Array(plan.curveBlocks * CP_BLOCK_FLOATS);
  const cache = new Map();
  const derive = (pi, ci) => {
    const key = pi * 64 + ci;
    let v = cache.get(key);
    if (v === undefined) {
      const p = patches[pi],
        seg = p.curves[ci];
      const pk = segImplicitPacked(seg);
      // THE STATIC PACKER'S SIGN, packedEvalF32 -- the float32 evaluation the kernel does.
      v = pk
        ? {
            pk,
            seg,
            kind: seg.cut ? CPK_CUT_BIT + pk.kind : pk.kind,
            sg: packedEvalF32(pk, p.inside[0], p.inside[1]) >= 0 ? 1 : -1,
            right: loopSignedArea(p.curves) < 0,
          }
        : null;
      cache.set(key, v);
    }
    return v;
  };
  //
  // So: texels 0-2, texel 3 of a Bezout cubic, the arc (5-6) and the degree bit are the static
  // packer's own values at this pose -- linear or quadratic in it, which the blend reproduces (rows
  // 5 and 6 carry their w through its C plane) -- and the box and strip are the span's bounds from
  // the segment plan (see morphArcBounds): a line's own box where its endpoints keep their order,
  // a union where they do not, both constant or linear over the span.
  for (const cell of plan.cells) {
    let ti = cell.at;
    const pb = plan.bounds && plan.bounds[cell.pi];
    for (const ci of cell.idx) {
      const d = derive(cell.pi, ci);
      if (!d || !pb || !pb[ci]) return null; // caller keeps the pose it had
      const { pk, seg, kind, sg } = d,
        bd = pb[ci];
      const s0 = pk.kind === CPK_LINE && sg < 0 ? -1 : 1; // see the static packer
      texels[ti] = s0 * pk.a[0][0];
      texels[ti + 1] = s0 * pk.a[0][1];
      texels[ti + 2] = s0 * pk.a[0][2];
      const arm = seg.cut && seamArm && seamArm[cell.pi] ? seamArm[cell.pi][ci] | 0 : 0;
      texels[ti + 3] =
        kind +
        (arcIs3(seg) ? CPK_ARC3 : 0) +
        (!seg.cut && d.right ? CPK_HORN_RIGHT : 0) +
        CPK_END * ((endF && endF[cell.pi] ? endF[cell.pi][ci] | 0 : 0) + arm);
      // The pose's outline legs for an armed straight seam, in the xyz of texels 1, 2 and 4 -- see seamLegs.
      const lg = arm
        ? seamLegs(
            (patches[cell.pi][K_SEAMEND] && patches[cell.pi][K_SEAMEND].get(seg)) || [null, null],
          )
        : null;
      texels[ti + 4] = lg ? lg[0] : pk.a[1][0];
      texels[ti + 5] = lg ? lg[1] : pk.a[1][1];
      texels[ti + 6] = lg ? lg[2] : pk.a[1][2];
      texels[ti + 7] = s0 < 0 ? 1 : sg;
      texels[ti + 8] = lg ? lg[3] : pk.a[2][0];
      texels[ti + 9] = lg ? lg[4] : pk.a[2][1];
      texels[ti + 10] = lg ? lg[5] : pk.a[2][2];
      texels[ti + 11] = pk.c[0];
      if (pk.kind === 4) {
        texels[ti + 12] = pk.a[3][0];
        texels[ti + 13] = pk.a[3][1];
        texels[ti + 14] = pk.a[3][2];
        texels[ti + 15] = pk.c[1];
      } else if (seg.cut) {
        // A morph's seam is not bounded to its span: the kernel stands a seam down past the reach of its
        // box, and a morph's layout ends seams at shared barycentric vertices the static decomposition never makes -- past
        // their spans the seams are what closes the corners there (cpatchMorphExactSmoke: a pixel outside the turning
        // blob painted 0.52, 153 off by more than 32/255). An unbounded box keeps every step.
        texels[ti + 12] = -1e30;
        texels[ti + 13] = -1e30;
        texels[ti + 14] = 1e30;
        texels[ti + 15] = 1e30;
      } else if (bd.line) {
        const P = seg.P,
          u = bd.box;
        texels[ti + 12] = bd.poseX ? Math.min(P[0][0], P[1][0]) : u[0];
        texels[ti + 13] = bd.poseY ? Math.min(P[0][1], P[1][1]) : u[1];
        texels[ti + 14] = bd.poseX ? Math.max(P[0][0], P[1][0]) : u[2];
        texels[ti + 15] = bd.poseY ? Math.max(P[0][1], P[1][1]) : u[3];
      } else {
        texels[ti + 12] = bd.box[0];
        texels[ti + 13] = bd.box[1];
        texels[ti + 14] = bd.box[2];
        texels[ti + 15] = bd.box[3];
      }
      texels[ti + 16] = lg ? lg[6] : bd.strip[0];
      texels[ti + 17] = lg ? lg[7] : bd.strip[1];
      texels[ti + 18] = lg ? 0 : bd.strip[2];
      texels[ti + 19] = lg ? 0 : bd.strip[3];
      const g = arcTexels(seg);
      for (let k = 0; k < 8; k++) texels[ti + 20 + k] = g[k];
      ti += CP_BLOCK_FLOATS;
    }
  }
  return {
    texels,
    verts: plan.verts,
    vertexCount: plan.vertexCount,
    kindMask: plan.kindMask,
    curveBlocks: plan.curveBlocks,
    patches: plan.patches,
  };
}

/// Scalars the C plane carries per block: the u and u^2 terms of the w of texels 2 and 3 (c0 and c1,
/// quadratic) and of texels 5 and 6 (the arc's P1.y and P3.y, linear). Two texels.
export function packCPatchMorphPlanes(snapA, snapH, snapB, blocks, baseBlock) {
  // Plane A and plane B are one block each; the C plane is CP_MORPH_C_FLOATS scalars a block, for
  // the w of the texels whose w moves: 2 and 3 (C0 and C1, degree 2 in u) and, since a morph block
  // carries its arc, 5 and 6 (P1.y and P3.y, degree 1). Every other w -- kind, sign, a bound -- is
  // constant over the span, which is what plane A's verbatim w reproduces.
  const out = new Float32Array(blocks * (CP_BLOCK_FLOATS * 2 + CP_MORPH_C_FLOATS));
  const cAt = blocks * CP_BLOCK_FLOATS * 2;
  for (let k = 0; k < 3; k++) {
    const snap = k === 0 ? snapA : k === 1 ? snapH : snapB;
    for (const e of snap) {
      if (!e || !e.pack) continue;
      const off = (e.first - baseBlock) * CP_BLOCK_FLOATS,
        tx = e.pack.texels;
      for (let b = 0; b * CP_BLOCK_FLOATS < tx.length; b++) {
        const src = b * CP_BLOCK_FLOATS,
          blk = ((off / CP_BLOCK_FLOATS) | 0) + b;
        for (let r = 0; r < CP_BLOCK_TEXELS; r++) {
          const x = tx[src + r * 4],
            y = tx[src + r * 4 + 1],
            z = tx[src + r * 4 + 2],
            w = tx[src + r * 4 + 3];
          const a = blk * CP_BLOCK_FLOATS + r * 4,
            bIdx = blocks * CP_BLOCK_FLOATS + blk * CP_BLOCK_FLOATS + r * 4;
          // Where this row's w lives in the C plane, if it moves: rows 2/3 in the block's first
          // texel, rows 5/6 in its second, each as (u term, u^2 term).
          const cw = r === 2 ? 0 : r === 3 ? 2 : r === 5 ? 4 : r === 6 ? 6 : -1;
          const cI = cAt + blk * CP_MORPH_C_FLOATS + cw;
          if (k === 0) {
            // u = 0: plane A verbatim, and B/C seeded
            out[a] = x;
            out[a + 1] = y;
            out[a + 2] = z;
            out[a + 3] = w;
            out[bIdx] = -x;
            out[bIdx + 1] = -y; // x1 = xB - xA, completed at k = 2
            out[bIdx + 2] = -3 * z;
            out[bIdx + 3] = 2 * z;
            if (cw >= 0) {
              out[cI] = -3 * w;
              out[cI + 1] = 2 * w;
            }
          } else if (k === 1) {
            // u = 1/2 contributes only to the quadratics
            out[bIdx + 2] += 4 * z;
            out[bIdx + 3] += -4 * z;
            if (cw >= 0) {
              out[cI] += 4 * w;
              out[cI + 1] += -4 * w;
            }
          } else {
            // u = 1
            out[bIdx] += x;
            out[bIdx + 1] += y;
            out[bIdx + 2] += -z;
            out[bIdx + 3] += 2 * z;
            if (cw >= 0) {
              out[cI] += -w;
              out[cI + 1] += 2 * w;
            }
          }
        }
      }
    }
  }
  return out;
}
export function packCPatchShape(contours, baseBlock = 0, opts = {}) {
  if (opts._preparedStaticProgram !== true) return packLegacyCPatchShape(contours, baseBlock, opts);
  const prepared = packPreparedCPatchShape(contours, baseBlock, opts);
  // Only the auto policy may decline a paint the static program cannot certify. A pinned CPatch must draw every shape
  // (rational quadratics, uncertified cycles), so it takes the general pack.
  if (prepared === null && opts.autoPolicy !== true)
    return packLegacyCPatchShape(contours, baseBlock, opts);
  return prepared;
}
function packPreparedCPatchShape(contours, baseBlock, opts) {
  let count = 0,
    controls = 0,
    x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const loop of contours) {
    count += loop.length;
    if (count > 316) return null;
    for (const curve of loop) {
      if (!Array.isArray(curve.P)) return null;
      controls += curve.P.length;
      if (controls > 1024) return null;
      for (const p of curve.P) {
        if (
          !p ||
          !Number.isFinite(p[0]) ||
          !Number.isFinite(p[1]) ||
          !Number.isFinite(Math.fround(p[0])) ||
          !Number.isFinite(Math.fround(p[1]))
        )
          return null;
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
      }
    }
  }
  // Translation changes the origin, not the kernel's coordinate unit.
  const bound = [((x1 - x0) / 128) * (1 + 2 ** -16), ((y1 - y0) / 128) * (1 + 2 ** -16)];
  if (!bound.every((x) => Number.isFinite(x) && x > 0)) return null;
  if (opts.record || opts.follow || opts.traces || opts.traceOut) return null;
  if (contours.some((loop) => loop.some((c) => !['line', 'quad', 'cubic'].includes(c.t))))
    return null;
  // The bundle pool's collect stage needs no contour conversion jobs for this route.
  if (opts.collect)
    return {
      texels: [],
      verts: [],
      vertexCount: 0,
      kindMask: 0,
      dropped: 0,
      unresolved: 0,
      cells: 0,
      allSeam: 0,
    };
  const whole = certifySimplePolynomialPaint(contours, !!opts.evenOdd);
  if (whole) {
    const area = packSimplePolynomialPaint(whole, baseBlock, opts);
    area._cpAdmission = { kind: 'native-whole-area' };
    return area;
  }
  const authoredLimit = contours.some((loop) => loop.some((curve) => curve.t === 'cubic'))
    ? 256
    : 64;
  let cert =
    count > authoredLimit
      ? certifySimplePolynomialPaint(contours, !!opts.evenOdd, { localProgramCertificate: true })
      : null;
  if (!cert) {
    let boundary = null,
      rule = false,
      acceptedCertificate = null;
    packLegacyCPatchShape(contours, baseBlock, {
      ...opts,
      collect: [],
      coverGuard: false,
      _onNormalizedBoundary: (list, r) => {
        boundary = list;
        rule = r;
      },
      _onCertifiedBoundary: (c) => {
        acceptedCertificate = c;
      },
    });
    if (acceptedCertificate) {
      const area = packSimplePolynomialPaint(acceptedCertificate, baseBlock, opts);
      area._cpAdmission = { kind: 'native-whole-area' };
      return area;
    }
    const snapped = boundary && snapBoundaryNodes(boundary);
    cert =
      snapped &&
      certifySimplePolynomialPaint(snapped, rule, {
        nodeJoints: true,
        localProgramCertificate: true,
      });
  }
  if (!cert) return null;
  const points = cert.curves.flatMap((c) => c.P),
    xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const cells = spatialBoundaryCells(cert.curves, bounds, bound);
  if (!cells) return null;
  const blocks = [],
    vertices = [];
  let cursor = 0;
  for (const cell of cells) {
    const origin = [Math.fround(cell.box[0]), Math.fround(cell.box[1])],
      first = baseBlock + cursor / 28;
    const area = packSimplePolynomialPaint({ curves: cell.local.program }, first, {
      areaFrame: origin,
      areaBounds: cell.box,
    });
    blocks.push(area.texels);
    cursor += area.texels.length;
    for (let at = 0; at < area.verts.length; at += 24) area.verts[at + 4] = 3000;
    vertices.push(...area.verts);
  }
  const texels = new Float32Array(cursor);
  let at = 0;
  for (const block of blocks) {
    texels.set(block, at);
    at += block.length;
  }
  const verts = new Float32Array(vertices);
  return {
    texels,
    verts,
    vertexCount: verts.length / 24,
    cpatch: true,
    cpatchAreaOnly: false,
    kindMask: 1 << 14,
    hasQuadraticArea: true,
    hasCubicArea: cert.curves.some((c) => c.t === 'cubic'),
    cells: cells.length,
    dropped: 0,
    unresolved: 0,
    allSeam: 0,
    comp: 0,
    kinds: {},
    _cpAdmission: { kind: 'spatial-static-polynomial', support: bound, kernelBounds: bounds },
  };
}
