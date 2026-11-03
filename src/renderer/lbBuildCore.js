// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Pure Loop-Blinn construction shared by workers and main-thread preparation.
// Build per-shape meshes or record a decline reason, then pack the worker wire
// representation. No GL context or DOM is required.

import {
  curveRangeToContours,
  setPreferBezout,
  getPreferBezout,
  buildLoopBlinnMesh,
  buildLoopBlinnCDT,
  refreshLoopBlinnMesh,
  dropDegenerateFaces,
  packLoopBlinnMesh,
  translateLoopBlinnRaw,
  LB_MAX_VERTS_PER_MESH,
  LB_MAX_VERTS_PER_BUNDLE,
  setLbShapeMemoryBudget,
  getLbShapeMemoryBudget,
  lbRawMinVertexBytes,
} from './loopBlinn.js';
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_RQUAD, mkLine, mkQuad } from '../primitives/seg.js';
import { orient2d } from '../geom/predicates.js';
import { mantleDebugHook } from '../core/diagnostics.js';
import { splitCubicCusps } from '../svg/cubicCusp.js';
import { circleFromContours, ellipseFromContours } from '../geom/shapeRecognize.js';
import { cubicDegreeReduce } from '../geom/lbCubicMath.js';
import {
  extractAnnuli,
  lbFrameOrigin,
  translateContours,
  _setKeyOrigin,
  closeOpenContours,
  segPt,
} from '../geom/lbContour.js';
import { cutPinches, straightenCollinearCurves } from './lbFastResolve.js';

let _lbSwallowed = false;
function _lbSwallow(where, ex) {
  if (_lbSwallowed) return;
  _lbSwallowed = true;
  const msg = String((ex && ex.stack) || (ex && ex.message) || ex);
  // eslint-disable-next-line no-console
  console.warn(
    '[mantle] Loop-Blinn build failed in ' +
      where +
      ' and fell back to Slug. ' +
      'This is silent by design (the fallback is correct), so it is reported once:\n' +
      msg,
  );
}

// A shape that isn't served analytically renders via Slug. Callers store this
// sentinel per shape so the draw path knows to skip it in the LB pass and let
// the Slug fill cover it. Same shape the renderer has always used.
export const SLUG = { slug: true };

/// WHY a shape has no analytic mesh.

/// So the cause travels with the answer. The codes are small integers because they cross the worker
/// boundary as one Uint8Array beside the meshes; the packed sentinels carry the same value so a
/// main-thread reader needs no second array.
export const SLUG_WHY = Object.freeze({
  REAL: 0, // not a sentinel at all -- this row has its mesh
  DECLINED: 1, // the builder ATTEMPTED it and could not serve it (loop, cusp, degenerate, CDT fallback)
  NO_GEOMETRY: 2, // nothing to build from: no curve range, or an empty one
  /// RESERVED, and nothing emits it. It names a shape never attempted for exceeding a
  /// curve-float complexity gate, which the renderer does not have: the progressive build bounds
  /// build TIME directly by posting each shape as it is finished. The number stays reserved so a
  /// code that crosses the worker boundary never means two different things, and so an older
  /// build's `why` array still reads correctly.
  TOO_COMPLEX: 3,
  OVER_BUDGET: 4, // built, then refused by a per-mesh or whole-bundle vertex cap
  NOT_BUILT: 5, // nobody asked: a time budget ran out, or a build gate skipped the row
  OVER_MEMORY: 6, // refused by the CALLER'S per-shape memory budget; `memWants` says how much it wanted
});
const _SLUGS = (() => {
  const out = [];
  for (const k of Object.keys(SLUG_WHY))
    out[SLUG_WHY[k]] = Object.freeze({ slug: true, why: SLUG_WHY[k] });
  return out;
})();
/// The Slug sentinel for one cause. Singletons, so a per-shape array of them costs nothing.
export function slugFor(why) {
  return _SLUGS[why | 0] || SLUG;
}

/// Split a built bundle's per-shape outcomes into what each one MEANS.
///
/// `bundle._lbSlugWhy` is the per-shape cause array both build paths fill. Without it a caller can
/// only count entries that are not a mesh, which is the conflation above. Pure and GL-free so a
/// test can check the split without a renderer.
export function lbMeshCensus(bundle) {
  const out = {
    real: 0,
    declined: 0,
    noGeometry: 0,
    tooComplex: 0,
    overBudget: 0,
    notBuilt: 0,
    overMemory: 0,
    unknown: 0,
  };
  const meshes = bundle && bundle._lbMeshes;
  if (!meshes) return out;
  const why = bundle._lbSlugWhy || null;
  for (let s = 0; s < meshes.length; s++) {
    const m = meshes[s];
    if (m && !m.slug && (m.vertexCount | 0) > 0) {
      out.real++;
      continue;
    }
    // The sentinel's own code first: the main thread keeps it, and it cannot disagree with itself.
    const w = m && m.why !== undefined ? m.why : why ? why[s] : undefined;
    switch (w) {
      case SLUG_WHY.DECLINED:
        out.declined++;
        break;
      case SLUG_WHY.NO_GEOMETRY:
        out.noGeometry++;
        break;
      case SLUG_WHY.TOO_COMPLEX:
        out.tooComplex++;
        break;
      case SLUG_WHY.OVER_BUDGET:
        out.overBudget++;
        break;
      case SLUG_WHY.NOT_BUILT:
        out.notBuilt++;
        break;
      case SLUG_WHY.OVER_MEMORY:
        out.overMemory++;
        break;
      // A build that predates the cause array, or a shape still building. Counted on its own rather
      // than folded into declines -- guessing is what this exists to stop.
      default:
        out.unknown++;
        break;
    }
  }
  return out;
}

/// The same split for a MORPH bundle's pair build (lbMorphCore's buildMorphBundle), plus the
/// declined shapes' own causes: `pairWhy` counts each distinct cause the pair builder reported
/// ('face-degenerate', 'unmapped-vertex', ...). `bundle._morphSlugWhy` / `_morphPairWhy` are what
/// the build handed back; `real` is a shape the build did not send to Slug -- it has its pair mesh,
/// or it has no fill to mesh. A bundle whose build has not reported counts every shape as unknown.
export function lbMorphCensus(bundle) {
  const out = { real: 0, declined: 0, noGeometry: 0, notBuilt: 0, unknown: 0, pairWhy: {} };
  const n = bundle ? bundle.numShapes | 0 : 0;
  const why = (bundle && bundle._morphSlugWhy) || null,
    pw = (bundle && bundle._morphPairWhy) || null;
  for (let s = 0; s < n; s++) {
    switch (why ? why[s] : undefined) {
      case SLUG_WHY.REAL:
        out.real++;
        break;
      case SLUG_WHY.DECLINED: {
        out.declined++;
        const c = (pw && pw[s]) || '(no cause)';
        out.pairWhy[c] = (out.pairWhy[c] | 0) + 1;
        break;
      }
      case SLUG_WHY.NO_GEOMETRY:
        out.noGeometry++;
        break;
      case SLUG_WHY.NOT_BUILT:
        out.notBuilt++;
        break;
      default:
        out.unknown++;
        break;
    }
  }
  return out;
}

export function packLbMeshForWire(pk) {
  return pk && !pk.slug && !pk.overBudget && (pk.vertexCount | 0) > 0
    ? {
        verts: pk.verts,
        vertexCount: pk.vertexCount,
        hasBezout: !!pk.hasBezout,
        hasCubicChain: !!pk.hasCubicChain,
        prim: !!pk.prim,
        kindMask: pk.kindMask | 0,
      }
    : null;
}

/** @typedef {{ raw: Array, packed: Array, why: Uint8Array, memWants: {shape:number,bytes:number}[], hasReal: boolean, hasSlug: boolean, overBudget: boolean }} LbBundleBuildResult */

/// Fold a STREAMED build back into the whole-bundle wire array the non-streamed path returns.
///
/// The worker posts each shape exactly ONCE: a shape that went out in a batch is deliberately absent
/// from the final message's tail, because its vertex buffer was transferred with that batch. So the
/// two halves are complementary and both are required — a batch the main thread fails to keep is a
/// mesh gone for good, and folding without it yields a Slug sentinel in its place. That is a silent
/// downgrade (the picture stays right, the analytic route quietly shrinks), so the loss is COUNTED
/// rather than left to be inferred: `missing` is the number of shapes no half ever reported, and on a
/// healthy build it is always zero.
///
/// Extracted here, in the GL-free core, so the fold can be tested without a renderer.
export function foldStreamedBuild(staged, tail, numShapes) {
  const n = numShapes | 0;
  const wire = new Array(n);
  for (let s = 0; s < n; s++) wire[s] = staged && staged[s] !== undefined ? staged[s] : undefined;
  if (tail && tail.shapes) {
    for (let i = 0; i < tail.shapes.length; i++) wire[tail.shapes[i] | 0] = tail.meshes[i];
  }
  let missing = 0;
  // `undefined` means nobody reported it; `null` is the wire's own Slug marker, which is a real answer.
  for (let s = 0; s < n; s++)
    if (wire[s] === undefined) {
      wire[s] = null;
      missing++;
    }
  return { wire, missing };
}

/// Pack a built mesh, unless the caller's per-shape MEMORY budget already rules it out.
///
/// The builder's half of the budget, and the reason it exists here as well as in the packer: this
/// is asked against the RAW mesh, before a single byte of vertex stream is allocated, so a refusal
/// costs nothing. `lbRawMinVertexBytes` is a LOWER bound on what the pack would produce, so a mesh
/// that passes here can still be refused by the packer's exact count -- and a mesh refused here
/// could never have fitted.
function _packWithinBudget(mesh, reuse) {
  const cap = getLbShapeMemoryBudget();
  if (cap < Infinity) {
    const floorBytes = lbRawMinVertexBytes(mesh);
    if (floorBytes > cap) {
      return {
        verts: new Float32Array(0),
        vertexCount: 0,
        fallback: mesh.fallback || [],
        hasBezout: false,
        hasCubicChain: false,
        kindMask: 0,
        overBudget: true,
        overMemory: true,
        wantBytes: floorBytes,
      };
    }
  }
  return packLoopBlinnMesh(mesh, reuse);
}

/**
 * Exact area enclosed by a set of closed contours, via Green's theorem
 * (A = ½∮(x dy − y dx)), each segment integrated in CLOSED FORM off its
 * power-basis coefficients. No flattening: an em-bounded polygonal
 * approximation would be no bound at all once the mesh is reused at any zoom.
 * Validated to 0.0000% against a dense reference on lines, quads, cubics and
 * S-curves. Returns NaN for a segment kind it cannot integrate, which makes the
 * guard opt out rather than guess.
 *
 * every CONTOUR IS CLOSED HERE, and that is not a nicety. Green's theorem is a LOOP integral: the
 * per-segment terms carry the coordinates themselves and only telescope to an area once the path
 * returns to where it started. Fed an OPEN contour the sum would keep whatever the missing closing
 * chord would have contributed, which is proportional to the POSITION — so the same shape would
 * report a different area depending on where it was laid out.
 *
 * A closing chord is what the FILL RULE does with an open subpath anyway (SVG fills it as if
 * closed), and on an already-closed contour the chord has zero length and contributes exactly zero
 * — so no closed shape's area moves by a bit.
 */
export function contourAreaExact(contours) {
  let A = 0;
  for (const c of contours) {
    let first = null,
      last = null;
    for (const sg of c) {
      const P = [sg.p1, sg.p2, sg.p3, sg.p4];
      let n;
      if (sg.type === SEG_LINE) n = 1;
      else if (sg.type === SEG_QUAD || sg.type === SEG_RQUAD) n = 2;
      else if (sg.type === SEG_CUBIC) n = 3;
      else return NaN;
      const px = [],
        py = [];
      for (let i = 0; i <= n; i++) {
        if (!P[i]) return NaN;
        px.push(P[i][0]);
        py.push(P[i][1]);
      }
      if (!first) first = P[0];
      last = P[n];
      const bx = _bez2pow(px, n),
        by = _bez2pow(py, n);
      let acc = 0;
      for (let i = 0; i <= n; i++)
        for (let j = 1; j <= n; j++) acc += (bx[i] * j * by[j] - by[i] * j * bx[j]) / (i + j);
      A += acc / 2;
    }
    // the closing chord, as a LINE segment's own term: (x0*y1 - x1*y0) / 2
    if (first && last) A += (last[0] * first[1] - first[0] * last[1]) / 2;
  }
  return Math.abs(A);
}

function _bez2pow(b, n) {
  const C = (a, k) => {
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (a - i)) / (i + 1);
    return r;
  };
  const out = [];
  for (let k = 0; k <= n; k++) {
    let s2 = 0;
    for (let i = 0; i <= k; i++) s2 += ((k - i) % 2 ? -1 : 1) * C(k, i) * b[i];
    out.push(C(n, k) * s2);
  }
  return out;
}

/** Generous UPPER bound on paintable area: every interior/edge triangle plus
 *  each curve piece's whole control hull (a piece paints at most its hull, and
 *  usually far less), with no discount for overlap. */
export function meshAreaUpperBound(m) {
  const triSum = (arr) => {
    let a = 0;
    if (!arr) return 0;
    for (let t = 0; t + 5 < arr.length; t += 6)
      a +=
        Math.abs(
          (arr[t + 2] - arr[t]) * (arr[t + 5] - arr[t + 1]) -
            (arr[t + 4] - arr[t]) * (arr[t + 3] - arr[t + 1]),
        ) / 2;
    return a;
  };
  let a = triSum(m.interior); // `edges` are records of a straight boundary, not triangles: it rides the faces, and read as coordinates they made this NaN

  for (const list of [m.quads, m.cubics]) {
    if (!list) continue;
    for (const rec of list) {
      if (!rec) continue;
      if (rec.hull) a += triSum(rec.hull);
      if (rec.tri) a += triSum(rec.tri);
    }
  }
  return a;
}

/** A fast (earcut/rim) mesh is usable only when it has no fallback segment, no concave curve piece and can cover its
 *  shape. ONE predicate for both build paths -- the worker's buildLbShape and the main thread's _ensureLbMeshes -- which
 *  each kept their own copy and had drifted: only the main thread asked meshUnderCovers. */
export function fastMeshAccepted(m, contours) {
  return !!(m && !m.fallback.length && !m.hasConcave && !meshUnderCovers(m, contours));
}

/*
* A CDT / partition-carve mesh is usable when it has no fallback segment. ONE predicate for both
 * build paths, for the same reason `fastMeshAccepted` is one: the worker's buildLbShape and the
 * main thread's _ensureLbMeshes kept their own copies of the fast-path rule and drifted, and only
 * one of them asked.
 *

 */
export function cdtMeshAccepted(cdt) {
  return !!cdt && !cdt.fallback.length;
}

/** True when the mesh PROVABLY cannot cover its shape. Opts out (false) whenever
 *  the bound cannot be trusted, so it never rejects on incomplete information. */
export function meshUnderCovers(m, contours) {
  if (!m || !contours) return false;
  // Circle / ANNULUS / strip-arc pieces paint area no triangle accounts for.

  if (
    (m.circles && m.circles.length) ||
    (m.annuli && m.annuli.length) ||
    (m.stripArcs && m.stripArcs.length)
  )
    return false;
  const want = contourAreaExact(contours);
  if (!(want > 0) || !isFinite(want)) return false;
  return meshAreaUpperBound(m) < 0.5 * want;
}

export function contoursHaveCubic(contours) {
  for (const c of contours) for (const s of c) if (s.type === SEG_CUBIC) return true;
  return false;
}

/// Would this shape build as a RECOGNIZED PRIMITIVE -- one analytic distance, no mesh?
///
/// Asked by a build path that has been told to skip this shape: the per-shape policy passes over a
/// row by CURVE TYPE, but it takes a primitive whatever it says about the types, because a primitive
/// is not a Loop-Blinn result and wins at every size. So a skipped row gets the recognizers and
/// nothing else -- a contour scan each -- and builds normally when one of them fires, which keeps
/// the mesh byte-identical to the ungated build rather than reconstructing it here.
///
/// The same three questions buildLoopBlinnCDT asks first, in the same order and after the same cusp
/// split, so the answer cannot disagree with what the build would actually produce.
export function contoursArePrimitive(contours, evenodd) {
  if (!contours || !contours.length) return false;
  let cs = null;
  try {
    cs = contours.map(splitCubicCusps);
  } catch {
    return false;
  }
  try {
    if (circleFromContours(cs) || ellipseFromContours(cs)) return true;
    const ann = extractAnnuli(cs, evenodd ? 'evenodd' : 'nonzero');
    return !!(ann && ann.annuli.length && !ann.rest.length);
  } catch {
    return false;
  }
}

export function contoursAllStraight(contours) {
  for (const c of contours) for (const s of c) if (s.type !== SEG_LINE) return false;
  return true;
}

function isFourSidedContour(contours) {
  if (contours.length !== 1) return false;
  let sides = 0;
  for (const s of contours[0]) {
    if (s.type !== SEG_LINE) return false;
    if (s.p1[0] !== s.p2[0] || s.p1[1] !== s.p2[1]) {
      if (++sides > 4) return false;
    }
  }
  return sides === 4;
}

function ptInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0],
      yi = pts[i][1],
      xj = pts[j][0],
      yj = pts[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Multi-contour shapes whose secondary contours are DISJOINT fill regions (not
// nested holes) — a colon's two dots, a pause icon's two bars. The earcut path
// wrongly SUBTRACTS a disjoint region; CDT winding inside-removal fills each
// correctly, so route these to CDT. A shape is disjoint iff it has >1 top-level
// contour (one not nested inside any other).
export function hasDisjointContours(contours) {
  if (!contours || contours.length < 2) return false;
  const pts = contours.map((c) => {
    const a = [];
    for (const s of c) if (s.p1) a.push(s.p1);
    return a;
  });
  let topLevel = 0;
  for (let i = 0; i < contours.length; i++) {
    const p0 = pts[i][0];
    if (!p0) continue;
    let nested = false;
    for (let j = 0; j < contours.length; j++)
      if (j !== i && pts[j].length > 2 && ptInPoly(p0[0], p0[1], pts[j])) {
        nested = true;
        break;
      }
    if (!nested && ++topLevel > 1) return true;
  }
  return false;
}

// The signed-2-pass classifier shared with the morph path: a holed shape needs
// CDT only if a curve's concave crescent could over-fill a hole. Polygon holes
// stay on the cheap 1-pass path.
export function hasCurvedHoles(sc, dc) {
  const multi = sc.length > 1 || (dc ? dc.length > 1 : false);
  return multi && !(contoursAllStraight(sc) && (!dc || contoursAllStraight(dc)));
}

// Build ONE shape's analytic mesh from its contours. Returns `{ raw, pk }` (mesh
// object + packed vertex buffer) on success, or `null` when the shape must fall
// back to Slug (loop/cusp/degenerate/CDT-fallback). `transSolid` = translucent
// solid fill (needs a non-overlapping CDT partition); `evenodd` = fill rule.
export function buildLbShape(contours, transSolid, evenodd, opts) {
  if (!contours) return null;
  // ── BUILD IN THE SHAPE'S own FRAME ──────────────────────────────────────────
  // The same drawing moved sideways must build the same mesh, and it did not: 40 identical 0.5 px
  // bars 4 px apart read -6.67% net ink below x = 16 em and +23.33% at or above, flipping at float64
  // binades. The cause is not a tolerance. The mesh is stored in FLOAT32, so the resolution every
  // decision is taken at is one ulp of the ABSOLUTE coordinate — 1.2e-7 at the origin, 1.9e-6 at
  // x = 16, 6.1e-5 at x = 1000 — and the geometry makes exact TIES. Traced on the bar: it is 0.5 px
  // by 6 px, an aspect of 12, which puts a face's depth to its own wall at exactly THREE times its
  // depth to the near wall — precisely the bar `ownD > nearD * 3` in lbInteriorSplit's own-line
  // block, so the float32 ulp is what decides which side of it the face lands on. At x = 10 the
  // difference is +3.2e-7 and at x = 16.25 it is -6.4e-7: one face is clipped to the near wall, the
  // other is not, and the two bars carry different boundary lines for the rest of the build. (The
  // tie is the FIXTURE's proportions, not a general property of a centroid — which is why real art
  // sees this as scattered last-bit differences rather than one systematic flip.)
  //
  // Widening the bar only moves the flip point and exact predicates change nothing, because the
  // noise is the STORAGE FORMAT rather than the arithmetic. What removes it is building at the
  // shape's own origin — the same bits for every placement — and translating the finished mesh
  // back.
  const frame9 = lbFrameOrigin(contours);
  const ox9 = frame9 ? frame9[0] : 0,
    oy9 = frame9 ? frame9[1] : 0;
  const moved9 = ox9 !== 0 || oy9 !== 0;
  let raw9 = _buildLbRaw(
    moved9 ? translateContours(contours, -ox9, -oy9) : contours,
    transSolid,
    evenodd,
    opts,
  );
  if (!raw9) return null;
  if (moved9) {
    raw9 = translateLoopBlinnRaw(raw9, ox9, oy9);
    // The key origin is module state every later caller reads; leave it describing the shape the
    // caller handed us, not the temporary one this build ran in.
    _setKeyOrigin(contours);
  }
  // ONE PACK, on the mesh as the caller will see it. (Packing the local mesh as well would double
  // the pack cost of every shape for a buffer nobody reads.)
  //
  return { raw: raw9, pk: _packWithinBudget(raw9, opts && opts.reusePk) };
}

/// Where a quad PROPERLY crosses a line (inside both, on parameters, 1e-9 in from the ends): { t, x, y } for the first root found, or null.
function quadLineCrossing(q, l) {
  const P = 1e-9;
  if (
    Math.max(l.p1[0], l.p2[0]) < Math.min(q.p1[0], q.p2[0], q.p3[0]) ||
    Math.min(l.p1[0], l.p2[0]) > Math.max(q.p1[0], q.p2[0], q.p3[0]) ||
    Math.max(l.p1[1], l.p2[1]) < Math.min(q.p1[1], q.p2[1], q.p3[1]) ||
    Math.min(l.p1[1], l.p2[1]) > Math.max(q.p1[1], q.p2[1], q.p3[1])
  )
    return null;
  const dx = l.p2[0] - l.p1[0],
    dy = l.p2[1] - l.p1[1];
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 0)) return null;
  // the quad's signed distance to the line, in Bernstein form: d0 (1-t)^2 + 2 d1 t (1-t) + d2 t^2
  const dist = (p) => dx * (p[1] - l.p1[1]) - dy * (p[0] - l.p1[0]);
  const d0 = dist(q.p1),
    d1 = dist(q.p2),
    d2 = dist(q.p3);
  const m = Math.max(Math.abs(d0), Math.abs(d1), Math.abs(d2));
  if (m === 0) return null; // the quad lies on the line's carrier: overlap, not a crossing
  const a = (d0 - 2 * d1 + d2) / m,
    bq = (2 * (d1 - d0)) / m,
    c = d0 / m;
  const roots = [];
  if (a === 0) {
    if (bq !== 0) roots.push(-c / bq);
  } else {
    const disc = bq * bq - 4 * a * c;
    if (disc > 0) {
      const sq = Math.sqrt(disc);
      const qv = -0.5 * (bq + (bq >= 0 ? sq : -sq));
      roots.push(qv / a);
      if (qv !== 0) roots.push(c / qv);
    }
  }
  for (const t of roots) {
    if (!(t > P && t < 1 - P)) continue;
    const u = 1 - t;
    const x = u * u * q.p1[0] + 2 * u * t * q.p2[0] + t * t * q.p3[0];
    const y = u * u * q.p1[1] + 2 * u * t * q.p2[1] + t * t * q.p3[1];
    const sp = ((x - l.p1[0]) * dx + (y - l.p1[1]) * dy) / len2;
    if (sp > P && sp < 1 - P) return { t, x, y };
  }
  return null;
}

/// A STREAM HAS NO ROUTE TO DECLINE TO. A static shape whose quad crosses a line goes to its cover quad; a lightweight stream's cover quad is the geometry of its last full update, so a declined section
/// leaves a hole in the frame (a road band whose edge curve overshoots its far cap by a few pixels, on every frame the road bends). Cut the outline where the curve meets the line instead: both take the
/// crossing as a vertex, the contour then returns to it, and cutPinches parts it into its loops. Winding is additive over them, so the fill is the same, and each loop is an outline no route miscounts.
/// Crossings inside one contour only (a loop has to close at the vertex). Returns the contours with every such crossing cut, or null when one remains.
function cutQuadLineCrossings(contours) {
  let out = contours;
  // (each pass cuts one crossing, and a curve and a line cross at most twice)
  for (let pass = 0; pass < 32; pass++) {
    let found = false;
    next: for (let ci = 0; ci < out.length; ci++) {
      const c = out[ci];
      for (let i = 0; i < c.length; i++) {
        const q = c[i];
        if (q.type !== SEG_QUAD) continue;
        for (let k = 0; k < c.length; k++) {
          const l = c[k];
          if (l.type !== SEG_LINE) continue;
          const X = quadLineCrossing(q, l);
          if (!X) continue;
          const u = 1 - X.t,
            p = [X.x, X.y];
          const A = mkQuad(q.p1, [u * q.p1[0] + X.t * q.p2[0], u * q.p1[1] + X.t * q.p2[1]], p),
            B = mkQuad(p, [u * q.p2[0] + X.t * q.p3[0], u * q.p2[1] + X.t * q.p3[1]], q.p3);
          const L0 = mkLine(l.p1, p),
            L1 = mkLine(p, l.p2);
          if (q.subStart) A.subStart = true;
          if (l.subStart) L0.subStart = true;
          const cut = [];
          for (let j = 0; j < c.length; j++) {
            if (j === i) cut.push(A, B);
            else if (j === k) cut.push(L0, L1);
            else cut.push(c[j]);
          }
          out = out.slice();
          out[ci] = cut;
          found = true;
          break next;
        }
      }
    }
    if (!found) break;
  }
  out = cutPinches(out).filter((c) => !collinearContour(c));
  return out.length && !curveCrossesStraight(out) ? out : null;
}

/// Whether a quadratic or rational-quad (arc) segment PROPERLY crosses a straight segment of the outline (anywhere in the interiors of both, a
/// sign change of the quad's side of the line at a point inside the line). The partition splits the crossing of two straight
/// constraints and of the hull chords a cubic puts down, but a quad's own CURVE crossing a line is not among them: it keeps
/// the fast rim's winding, which cannot count that crossing, and fills the wrong side (440 and 1705 interior pixels in the
/// audit's repros). Such an outline is declined to the exact route (Slug). Shared endpoints and tangent touches are not
/// crossings. All tests are on parameters (dimensionless, 1e-9 inside the ends), so the answer is the same at every scale.
export function curveCrossesStraight(contours) {
  const quads = [],
    lines = [],
    others = [];
  for (const c of contours)
    for (const s of c) {
      if (s.type === SEG_QUAD) quads.push(s);
      else if (s.type === SEG_LINE) lines.push(s);
      else if (s.type === SEG_RQUAD) others.push(s); // a cubic crossing a line is built right (audit f9; tiger #104, #120, #225)
    }
  if (!lines.length || !(quads.length || others.length)) return false;
  for (const q of quads) for (const l of lines) if (quadLineCrossing(q, l)) return true;
  // A rational quad (an arc) has no closed form here: follow it in 48 pieces. A piece crossing the line inside both
  // (parameters 1e-6 in from the ends, the flattening's own resolution) is a crossing; a curve leaving the line's end is not.
  const PF = 1e-6,
    NP = 48;
  const lbox = lines.map((l) => [
    Math.min(l.p1[0], l.p2[0]),
    Math.min(l.p1[1], l.p2[1]),
    Math.max(l.p1[0], l.p2[0]),
    Math.max(l.p1[1], l.p2[1]),
  ]);
  for (const cv of others) {
    const pts = new Array(NP + 1);
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (let i = 0; i <= NP; i++) {
      const p = segPt(cv, i / NP);
      pts[i] = p;
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    for (let k = 0; k < lines.length; k++) {
      const b = lbox[k];
      if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
      const l = lines[k];
      const dx = l.p2[0] - l.p1[0],
        dy = l.p2[1] - l.p1[1];
      const len2 = dx * dx + dy * dy;
      if (!(len2 > 0)) continue;
      // the side of the line at each sample; a sample exactly ON the line is skipped, so the flip is read between the samples around it
      let prev = dx * (pts[0][1] - l.p1[1]) - dy * (pts[0][0] - l.p1[0]),
        pi = 0;
      for (let i = 1; i <= NP; i++) {
        const cur = dx * (pts[i][1] - l.p1[1]) - dy * (pts[i][0] - l.p1[0]);
        if (cur === 0) continue;
        if ((prev < 0 && cur > 0) || (prev > 0 && cur < 0)) {
          const h = prev / (prev - cur);
          const t = (pi + h * (i - pi)) / NP;
          const x = pts[pi][0] + h * (pts[i][0] - pts[pi][0]),
            y = pts[pi][1] + h * (pts[i][1] - pts[pi][1]);
          const sp = ((x - l.p1[0]) * dx + (y - l.p1[1]) * dy) / len2;
          if (t > PF && t < 1 - PF && sp > PF && sp < 1 - PF) return true;
        }
        prev = cur;
        pi = i;
      }
    }
  }
  return false;
}

/// Every vertex of an all-straight contour exactly on the line through its first two distinct vertices.
function collinearContour(c) {
  let a = null,
    b = null;
  for (const s of c) {
    if (s.type !== SEG_LINE) return false;
    for (const p of [s.p1, s.p2]) {
      if (!a) a = p;
      else if (!b) {
        if (p[0] !== a[0] || p[1] !== a[1]) b = p;
      } else if (orient2d(a, b, p) !== 0) return false;
    }
  }
  return true;
}

/// One contour with every degree-reducible cubic replaced by the exact quadratic it already is.
/// Returns the same array when nothing reduces, so the common case allocates nothing.
function reduceDegreeCubics(c) {
  let out = null;
  for (let i = 0; i < c.length; i++) {
    const s = c[i];
    if (!s || s.type !== SEG_CUBIC) {
      if (out) out.push(s);
      continue;
    }
    const Q = cubicDegreeReduce([s.p1, s.p2, s.p3, s.p4]);
    if (!Q) {
      if (out) out.push(s);
      continue;
    }
    if (!out) out = c.slice(0, i);
    out.push({ type: SEG_QUAD, p1: s.p1, p2: Q, p3: s.p4 });
  }
  return out || c;
}

/// The route decision and the build itself, in whatever frame the caller hands it. Returns the raw
/// mesh, unpacked — `buildLbShape` above owns the frame and the pack.
function _buildLbRaw(contours, transSolid, evenodd, opts) {
  // Closed as SVG fills a path, before any route sees it (lbContour.js closeOpenContours).
  contours = closeOpenContours(contours);
  // A curve whose control points are on its chord has no crescent and no straight-edge strip: nothing but rows meant for a neighbor ramps its edge, and
  // the outer half of the edge is not painted (e.g. `Q90 25 80 50` on the line from 100,0, against the same path written with `L`).
  // It stays on the partition. An authored polygon's fast route reads a long thin side worse (several px^2 of error on a 5 by 100 strip).
  const authored9 = contours;
  contours = contours.map(straightenCollinearCurves);
  const straightened9 = contours.some((c, i) => c !== authored9[i]);
  // A straight contour whose vertices all lie on one line has no interior under either rule (`M a L b`, a default black fill
  // on a stroked line). Its winding is zero on both sides, but its edges would still each carry a ramp, a hairline of half
  // coverage drawn where the path fills nothing. If nothing else is left, the cover route draws the nothing.
  contours = contours.filter((c) => !collinearContour(c));
  if (!contours.length) return null;
  // Four-sided outlines need the non-overlapping partition at AA corners.
  // Zero-length closure records do not count as sides.
  const needsPartition = transSolid || isFourSidedContour(contours);
  const forceCdt9 = !!(opts && opts.forceCdt);
  // The fast mesh's crack-healing ramp. ON everywhere but a stream that declared its bands opaque and
  // convex (`bundle._lbStreamRamp = false`), a documented divergence it takes for per-frame speed.
  const ramp9 = !(opts && opts.ramp === false);

  contours = contours.map(splitCubicCusps);
  // ...and degree-reduce a cubic that is a QUADRATIC in cubic clothing, for the same reason and in
  // the same place: before the route decision, so every route sees the same segment.
  //
  // Why it belongs here. `buildRims` (lbFastMesh.js) reduces too — a cubic with
  // C3 = -P0 + 3P1 - 3P2 + P3 == 0 makes cubicKLMN bail to a Bezout crescent whose coverage is
  // wrong for this class, and a corner-control squircle then draws only its interior diamond. The
  // PARTITION does not reduce on its own: `cubicDegreeReduce` is called from lbFastMesh,
  // cpatchImplicit and cpatchMorphCert and from nowhere in lbPartition. Unreduced, the same squircle
  // would be exact through the fast path and lose ink through the partition — and which one a shape
  // got would be decided by `contoursHaveCubic`, i.e. by WHICH BUILD PATH ANSWERED.
  // Reducing here fixes the partition AND makes the gate agree with itself: a shape whose cubics
  // are all reducible is not a cubic shape, so it takes the fast path either way.
  //
  // STATIC only, by construction: this is the static bundle builder (see above), and a morph pair
  // must keep each segment's KIND identical across poses.
  contours = contours.map(reduceDegreeCubics);
  // ...and cut a contour that returns to a vertex it already passed through into its loops.
  // Three triangles sharing an apex, written as one subpath, drew as ONE of them on every route here: the
  // rim touches itself at the apex and the nesting and fill-side tests read the other two as holes.
  // Winding is additive over the loops, so the fill is unchanged under either rule; a shape with no such
  // contour gets the same array back and is untouched.
  contours = cutPinches(contours);
  // A quad crossing a line is not counted by any route below (see curveCrossesStraight): decline to Slug. A stream has no Slug to decline to (cutQuadLineCrossings).
  let cutCrossing9 = false;
  if (curveCrossesStraight(contours)) {
    contours = opts && opts.fastCorrect ? cutQuadLineCrossings(contours) : null;
    if (!contours) return null;
    cutCrossing9 = true;
  }
  // THE CORRECT FAST BUILD, for a caller that asks (`opts.fastCorrect`: the lightweight stream, which
  // rebuilds every moved shape every frame). buildLoopBlinnMesh with `correct` draws a concave, disjoint
  // or multi-contour outline right against exact coverage (lbFastResolve.js) for about two thirds of the
  // partition's cost, and declines what it
  // cannot draw -- a crossing outline, a loop -- to the route below. Two classes keep the static route:
  //   - a translucent solid, which needs the non-overlapping partition (see above);
  //   - a single straight contour, which the route below already builds on the fast path, reusing last
  //     frame's triangulation while its rim structure holds.
  // A cubic shape takes it too: the correct build splits a cubic only for what its crescent needs.
  if (
    opts &&
    opts.fastCorrect &&
    !forceCdt9 &&
    !needsPartition &&
    !cutCrossing9 &&
    !(contours.length === 1 && contoursAllStraight(contours))
  ) {
    let m = null;
    try {
      m = buildLoopBlinnMesh(contours, ramp9, evenodd ? 'evenodd' : 'nonzero', false, true);
    } catch (ex) {
      _lbSwallow('buildLoopBlinnMesh (correct)', ex);
      m = null;
    }
    if (m && !m.fallback.length && !meshUnderCovers(m, contours)) {
      m._route = 'fast-correct';
      return m;
    }
  }
  // Curved / translucent-solid / multi-contour / disjoint → proper Loop-Blinn
  // CDT partition (with a convex single-contour earcut fast path first).
  if (
    straightened9 ||
    !contoursAllStraight(contours) ||
    needsPartition ||
    contours.length > 1 ||
    hasDisjointContours(contours)
  ) {
    if (!needsPartition && !straightened9 && contours.length === 1) {
      let m = null;
      if (
        !forceCdt9 &&
        (!contoursHaveCubic(contours) || mantleDebugHook('__LB_CUBIC_FASTPATH') === true)
      ) {
        try {
          m = buildLoopBlinnMesh(contours, ramp9, evenodd ? 'evenodd' : 'nonzero', true);
        } catch (ex) {
          _lbSwallow('buildLoopBlinnMesh (partition retry)', ex);
          m = null;
        }
      }
      if (fastMeshAccepted(m, contours)) {
        dropDegenerateFaces(m);
        return m;
      }
    }
    let cdt = null;
    try {
      cdt = buildLoopBlinnCDT(contours, {
        fillRule: evenodd ? 'evenodd' : 'nonzero',
        transSolid: needsPartition,
      });
    } catch (ex) {
      _lbSwallow('buildLoopBlinnCDT', ex);
      cdt = null;
    }
    if (cdtMeshAccepted(cdt)) {
      dropDegenerateFaces(cdt);
      return cdt;
    }

    if (!forceCdt9 && !needsPartition && contours.length === 1 && contoursHaveCubic(contours)) {
      let m2 = null;
      try {
        m2 = buildLoopBlinnMesh(contours, ramp9, evenodd ? 'evenodd' : 'nonzero', true);
      } catch (ex) {
        _lbSwallow('buildLoopBlinnMesh (cubic fallback)', ex);
        m2 = null;
      }
      if (fastMeshAccepted(m2, contours)) {
        dropDegenerateFaces(m2);
        return m2;
      }
    }
    return null; // loop/cusp/degenerate → Slug
  }
  // All-straight single-contour polygon → cheap earcut fast path.
  //
  // `opts.prev` is the caller's previous raw mesh for this shape, when it has one. Reusing its
  // triangulation is the fixed-topology streaming win (refreshLoopBlinnMesh skips the O(n log n)
  // earcut and rebuilds from a rim-structure fingerprint, falling back to a full build on a miss),
  // and it is the same route — not a second answer — so it belongs inside the one route decision
  // rather than beside it. `opts.forceCdt` is setLoopBlinnMeshOpts' debug knob.
  let mesh = null,
    refreshed9 = false;
  try {
    if (forceCdt9) mesh = null;
    else if (opts && opts.prev && opts.prev._topo) {
      mesh = refreshLoopBlinnMesh(opts.prev, contours, evenodd ? 'evenodd' : 'nonzero');
      refreshed9 = true;
    } else mesh = buildLoopBlinnMesh(contours, ramp9, evenodd ? 'evenodd' : 'nonzero');
  } catch (ex) {
    _lbSwallow('buildLoopBlinnMesh', ex);
    mesh = null;
  }
  // A refreshed mesh REUSES a previous triangulation, so a caller keying a content cache must not
  // publish it: the next shape with the same bytes would inherit this one's topology.
  if (mesh && refreshed9) mesh._lbRefreshed = true;
  if (mesh && mesh.fallback.length) mesh = null; // self-intersecting → Slug
  if (!mesh) {
    // A straight single contour the fast rim cannot thread is a SELF-CROSSING outline (pentagram,
    // bowtie), and the partition splits the crossing constraints at their intersection and
    // winding-deletes to the exact fill — so it renders through LB instead of dropping to Slug.
    // The main thread's copy of this route has the same retry, so the shape is analytic
    // from either builder.
    let cdt9 = null;
    try {
      cdt9 = buildLoopBlinnCDT(contours, { fillRule: evenodd ? 'evenodd' : 'nonzero' });
    } catch (ex) {
      _lbSwallow('buildLoopBlinnCDT (straight retry)', ex);
      cdt9 = null;
    }
    if (cdtMeshAccepted(cdt9) && cdt9.interior && cdt9.interior.length) mesh = cdt9;
  }
  if (!mesh) return null;
  dropDegenerateFaces(mesh);
  return mesh;
}

/**
 * Build every shape's analytic mesh for a bundle, in ONE unbudgeted pass.
 * @param {object} input
 * @param {Float32Array} input.curveFloats    the bundle's packed curve table
 * @param {Float32Array} input.metaFloats     per-shape meta records
 * @param {number}       input.metaFloatsPerShape  meta stride
 * @param {{begin:number,end:number}[]} input.ranges  per-shape curve float ranges
 * @param {number}       input.numShapes
 * @param {boolean}      [input.preferBezout]  phase-1 Bezout preference for this build
 * @param {((s:number, pk:any)=>void)} [input.onShape]  called as each shape is finalized
 * @param {Uint8Array|null} [input.skip]  1 = the caller's per-shape policy can never draw this row
 * @param {number}       [input.shapeMemBytes]  per-shape packed-vertex budget; absent/0 ⇒ no limit
 * @returns {LbBundleBuildResult}
 *          Parallel per-shape arrays; each entry is a mesh/packed-buffer or the
 *          `SLUG` sentinel. `raw` is the CPU mesh (kept for parity with
 *          `_ensureLbMeshes`; the worker only transfers `packed`).
 */
export function buildLbBundle(input) {
  // Phase-1 Bezout preference arrives with the build input (structured-cloned into the
  // worker); set it for the whole bundle build and restore after, so a caller that does
  // not pass it is byte-identical to before.
  const _pbPrev = getPreferBezout();
  setPreferBezout(!!(input && input.preferBezout));
  // The per-shape MEMORY budget travels the same way and for the same reason: the build runs in a
  // worker, and a main-thread module setting would never arrive there -- the worker would keep
  // packing streams the caller has said it cannot afford while the main thread reported the limit.
  const _mbPrev = getLbShapeMemoryBudget();
  setLbShapeMemoryBudget(input && input.shapeMemBytes);
  try {
    return _buildLbBundleInner(input);
  } finally {
    setPreferBezout(_pbPrev);
    setLbShapeMemoryBudget(_mbPrev);
  }
}

function _buildLbBundleInner(input) {
  const { curveFloats, metaFloats: meta, metaFloatsPerShape: mst, ranges, numShapes: n } = input;
  /// Called with each shape the moment it is finalized, for a caller that draws meshes as they
  /// become ready instead of waiting for the whole bundle (the worker's streaming build). Absent by
  /// default, so a caller that does not pass one runs exactly the loop it always ran.
  const onShape = typeof input.onShape === 'function' ? input.onShape : null;
  /// Rows the caller's per-shape policy can never give their mesh to (lbShapePolicy
  /// lbBuildSkipMask). Absent by default, so a caller that passes none runs the loop it always ran.
  const skip = input.skip || null;
  const raw = new Array(n),
    packed = new Array(n);
  /// Per shape, WHY it has no mesh (SLUG_WHY). Crosses the worker boundary as one Uint8Array.
  const why = new Uint8Array(n);
  /// Every shape the MEMORY budget turned away, and how many bytes it asked for. A budget that
  /// declines silently is the failure this repo keeps re-finding, so the refusal is a reportable
  /// number and not a log line: the bundle can say which shape wanted what.
  /// @type {{shape:number, bytes:number}[]}
  const memWants = [];
  const slug = (s, w) => {
    why[s] = w;
    raw[s] = packed[s] = slugFor(w);
  };
  let hasReal = false,
    hasSlug = false;
  for (let s = 0; s < n; s++) {
    const r = ranges && ranges[s];
    if (!r || r.end <= r.begin) {
      slug(s, SLUG_WHY.NO_GEOMETRY);
      hasSlug = true;
      if (onShape) onShape(s, packed[s]);
      continue;
    }
    const bb = meta && mst ? s * mst : -1;
    const transSolid =
      bb >= 0 &&
      meta[bb + 7] < 0.996 &&
      Math.floor(meta[bb + 28] + 0.5) === 0 &&
      (mst < 36 || Math.floor(meta[bb + 35] + 0.5) === 0);
    const evenodd = !!(meta && meta[s * mst + 13] > 0.5);
    let contours = null;
    try {
      contours = curveRangeToContours(curveFloats, r.begin, r.end);
    } catch (ex) {
      _lbSwallow('curveRangeToContours', ex);
      contours = null;
    }
    // A row the policy passes over draws its cover quad, and a cover quad is what a Slug sentinel
    // gets it -- so the mesh would be discarded on every draw. Skip the build, but not the
    // recognizers: a primitive is taken whatever the policy says about curve types. NOT_BUILT, not
    // DECLINED: nothing attempted this shape, and the decline statistic has to keep saying so.
    if (skip && skip[s] && !contoursArePrimitive(contours, evenodd)) {
      slug(s, SLUG_WHY.NOT_BUILT);
      hasSlug = true;
      if (onShape) onShape(s, packed[s]);
      continue;
    }
    const built = buildLbShape(contours, transSolid, evenodd);
    if (
      built &&
      built.pk &&
      !built.pk.overBudget &&
      (built.pk.vertexCount | 0) > 0 &&
      (built.pk.vertexCount | 0) <= LB_MAX_VERTS_PER_MESH
    ) {
      raw[s] = built.raw;
      packed[s] = built.pk;
      hasReal = true;
    } else if (built && built.pk && built.pk.overMemory) {
      // The CALLER'S budget, not ours, and it says how much it wanted -- OVER_BUDGET would blame
      // the built-in vertex caps for a limit the app set.
      slug(s, SLUG_WHY.OVER_MEMORY);
      memWants.push({ shape: s, bytes: built.pk.wantBytes | 0 });
      hasSlug = true;
    } else {
      // A real decline only when the builder returned nothing. A pack it produced and a cap then
      // refused is a budget answer, and reporting it as a decline blames the partition for a limit.
      slug(s, built && built.pk ? SLUG_WHY.OVER_BUDGET : SLUG_WHY.DECLINED);
      hasSlug = true;
    }
    if (onShape) onShape(s, packed[s]);
  }
  // Whole-bundle vert cap: a sheet of many mid-size shapes can still blow the
  // GPU buffer / mem budget even when each shape alone is fine.
  if (hasReal) {
    let nV = 0;
    for (let s = 0; s < n; s++) if (packed[s] && packed[s].vertexCount) nV += packed[s].vertexCount;
    if (nV > LB_MAX_VERTS_PER_BUNDLE) {
      if (typeof console !== 'undefined') {
        console.warn(
          '[mantle] LB mesh budget: bundle has ' +
            nV +
            ' verts (cap ' +
            LB_MAX_VERTS_PER_BUNDLE +
            ') — rendering via Slug.',
        );
      }
      for (let s = 0; s < n; s++) slug(s, SLUG_WHY.OVER_BUDGET);
      return { raw, packed, why, memWants, hasReal: false, hasSlug: true, overBudget: true };
    }
  }
  return { raw, packed, why, memWants, hasReal, hasSlug, overBudget: false };
}
