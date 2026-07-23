// lbBuildCore.js — the PURE, GL-free Loop-Blinn mesh construction for a whole
// bundle. This is the "LB equivalent of createBundle": given a bundle's parsed
// curve + meta buffers it triangulates every shape ONCE, with no time budget, no
// partial/resume slicing, and no cross-frame cache. It is safe to run in a Web
// Worker (no `gl`, no `document`, no renderer context `R`) — all it touches are
// the pure builders in loopBlinn.js (which only import seg.js / cdt.js /
// polyRoots.js). The main thread then uploads the packed vertex buffers to GL.
//
// It is also the synchronous fallback the renderer uses where Workers are
// unavailable (native / headless). Because it is the ONE place the per-shape
// route (fast-earcut vs CDT vs Slug) is decided, the worker and the fallback can
// never drift. Mirrors the per-shape body of morphDraw.js `_ensureLbMeshes`.

import {
  curveRangeToContours,
  buildLoopBlinnMesh,
  buildLoopBlinnCDT,
  dropDegenerateFaces,
  packLoopBlinnMesh,
  LB_MAX_VERTS_PER_MESH,
  LB_MAX_VERTS_PER_BUNDLE,
} from './loopBlinn.js';
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_RQUAD } from '../primitives/seg.js';
import { splitCubicCusps } from '../svg/cubicCusp.js';

// A shape that isn't served analytically renders via Slug. Callers store this
// sentinel per shape so the draw path knows to skip it in the LB pass and let
// the Slug fill cover it. Same shape the renderer has always used.
export const SLUG = { slug: true };

/** @typedef {{ raw: Array, packed: Array, hasReal: boolean, hasSlug: boolean, overBudget: boolean }} LbBundleBuildResult */

// One shape's curves are >4000 float-segments: a CDT of it can eat seconds even
// off the main thread, and the analytic win is irrelevant at that vertex count —
// render it Slug permanently. (Matches the `_ensureLbMeshes` complexity gate.)
const MONSTER_SEG_FLOATS = 4000;

// --- pure fill-route predicates (moved here from morphDraw.js so the worker can
//     import them without the GL module; re-exported for morphDraw). ---

// --- build-time coverage guard -------------------------------------------
//
// A mesh that cannot cover its own shape is missing paint, and nothing
// downstream can recover it: the fragment shader only ever SUBTRACTS coverage.
// buildLoopBlinnMesh can return such a mesh while reporting fallback=[] and
// hasConcave=false, so the accept sites took it on trust — Ghostscript_Tiger
// shape 11 arrived with 27 verts, two SUB-PIXEL cubic hulls and no interior at
// all, for a 21896 em^2 shape, and rendered as nothing (12% of the tiger's black
// ink). Shapes 5 and 14 arrived with 6 verts and no fill geometry whatsoever.
//
// "No interior triangles" is NOT a usable proxy for this: a squircle's fill is
// carried legitimately by its curve-hull pieces, and rejecting on that alone
// under-filled it (ink 0.595 of Slug). So compare AREAS instead, and only reject
// when even a deliberate OVER-estimate of what the mesh paints falls short — a
// mesh that passes can never have been wrongly rejected.

/**
 * Exact area enclosed by a set of closed contours, via Green's theorem
 * (A = ½∮(x dy − y dx)), each segment integrated in CLOSED FORM off its
 * power-basis coefficients. No flattening: an em-bounded polygonal
 * approximation would be no bound at all once the mesh is reused at any zoom.
 * Validated to 0.0000% against a dense reference on lines, quads, cubics and
 * S-curves. Returns NaN for a segment kind it cannot integrate, which makes the
 * guard opt out rather than guess.
 */
export function contourAreaExact(contours) {
  let A = 0;
  for (const c of contours) {
    for (const sg of c) {
      const P = [sg.p1, sg.p2, sg.p3, sg.p4];
      let n;
      if (sg.type === SEG_LINE) n = 1;
      else if (sg.type === SEG_QUAD || sg.type === SEG_RQUAD) n = 2;
      else if (sg.type === SEG_CUBIC) n = 3;
      else return NaN;
      const px = [], py = [];
      for (let i = 0; i <= n; i++) { if (!P[i]) return NaN; px.push(P[i][0]); py.push(P[i][1]); }
      const bx = _bez2pow(px, n), by = _bez2pow(py, n);
      let acc = 0;
      for (let i = 0; i <= n; i++) for (let j = 1; j <= n; j++)
        acc += (bx[i] * j * by[j] - by[i] * j * bx[j]) / (i + j);
      A += acc / 2;
    }
  }
  return Math.abs(A);
}

function _bez2pow(b, n) {
  const C = (a, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (a - i) / (i + 1); return r; };
  const out = [];
  for (let k = 0; k <= n; k++) {
    let s2 = 0;
    for (let i = 0; i <= k; i++) s2 += ((k - i) % 2 ? -1 : 1) * C(k, i) * b[i];
    out.push(C(n, k) * s2);
  }
  return out;
}

/** Generous UPPER bound on paintable area: every interior/edge triangle plus
 *  each curve piece's WHOLE control hull (a piece paints at most its hull, and
 *  usually far less), with no discount for overlap. */
export function meshAreaUpperBound(m) {
  const triSum = (arr) => { let a = 0; if (!arr) return 0;
    for (let t = 0; t + 5 < arr.length; t += 6)
      a += Math.abs((arr[t+2]-arr[t])*(arr[t+5]-arr[t+1]) - (arr[t+4]-arr[t])*(arr[t+3]-arr[t+1])) / 2;
    return a; };
  let a = triSum(m.interior) + triSum(m.edges);
  // Curve pieces carry their triangle under DIFFERENT keys: a quad record has
  // .tri, a cubic record has .hull. Reading only .hull silently valued every
  // quad at zero, which false-rejected the squircle (6 quads, no interior) at
  // ratio 0.000 and regressed it to its historic 0.595 under-fill.
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

/** True when the mesh PROVABLY cannot cover its shape. Opts out (false) whenever
 *  the bound cannot be trusted, so it never rejects on incomplete information. */
export function meshUnderCovers(m, contours) {
  if (!m || !contours) return false;
  // Circle / strip-arc pieces paint area no triangle accounts for.
  if ((m.circles && m.circles.length) || (m.stripArcs && m.stripArcs.length)) return false;
  const want = contourAreaExact(contours);
  if (!(want > 0) || !isFinite(want)) return false;
  return meshAreaUpperBound(m) < 0.5 * want;
}

export function contoursAllStraight(contours) {
  for (const c of contours) for (const s of c) if (s.type !== SEG_LINE) return false;
  return true;
}

function ptInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
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
  const pts = contours.map((c) => { const a = []; for (const s of c) if (s.p1) a.push(s.p1); return a; });
  let topLevel = 0;
  for (let i = 0; i < contours.length; i++) {
    const p0 = pts[i][0]; if (!p0) continue;
    let nested = false;
    for (let j = 0; j < contours.length; j++) if (j !== i && pts[j].length > 2 && ptInPoly(p0[0], p0[1], pts[j])) { nested = true; break; }
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
export function buildLbShape(contours, transSolid, evenodd) {
  if (!contours) return null;
  // Split any cubic at its cusp BEFORE the route decision, so both the fast-mesh and the CDT path
  // see cusp-free cubics (either would otherwise veto a cusp to Slug — cubicLoop treats a cusp as a
  // degenerate self-loop). This is the STATIC bundle builder; the morph path calls
  // buildLoopBlinnMesh / buildLoopBlinnCDT DIRECTLY (morphDraw), so it never reaches here and its
  // poses keep matched topology. That is exactly why the split is NOT at parse (it would change the
  // segment count and desync morph correspondence) and NOT in buildRims (morph poses build with the
  // same isStatic=true flag). See svg/cubicCusp.js.
  contours = contours.map(splitCubicCusps);
  // Curved / translucent-solid / multi-contour / disjoint → proper Loop-Blinn
  // CDT partition (with a convex single-contour earcut fast path first).
  if (!contoursAllStraight(contours) || transSolid || contours.length > 1 || hasDisjointContours(contours)) {
    if (!transSolid && contours.length === 1) {
      // FAST PATH: single-contour convex curved shape (circle/pill/convex icon) —
      // 15-37× cheaper than CDT. buildLoopBlinnMesh flags a concave curve or a
      // loop/cusp; either → fall through to CDT.
      let m = null;
      try { m = buildLoopBlinnMesh(contours, true, evenodd ? 'evenodd' : 'nonzero'); } catch { m = null; }
      if (m && !m.fallback.length && !m.hasConcave) { dropDegenerateFaces(m); return { raw: m, pk: packLoopBlinnMesh(m) }; }
    }
    let cdt = null;
    try { cdt = buildLoopBlinnCDT(contours, {
      fillRule: evenodd ? 'evenodd' : 'nonzero',
      transSolid,
    }); } catch { cdt = null; }
    if (cdt && !cdt.fallback.length) { dropDegenerateFaces(cdt); return { raw: cdt, pk: packLoopBlinnMesh(cdt) }; }
    return null;   // loop/cusp/degenerate → Slug
  }
  // All-straight single-contour polygon → cheap earcut fast path.
  let mesh = null;
  try { mesh = buildLoopBlinnMesh(contours, true, evenodd ? 'evenodd' : 'nonzero'); } catch { mesh = null; }
  if (mesh && mesh.fallback.length) mesh = null;   // self-intersecting → Slug
  if (!mesh) return null;
  dropDegenerateFaces(mesh);
  return { raw: mesh, pk: packLoopBlinnMesh(mesh) };
}

/**
 * Build every shape's analytic mesh for a bundle, in ONE unbudgeted pass.
 * @param {object} input
 * @param {Float32Array} input.curveFloats    the bundle's packed curve table
 * @param {Float32Array} input.metaFloats     per-shape meta records
 * @param {number}       input.metaFloatsPerShape  meta stride
 * @param {{begin:number,end:number}[]} input.ranges  per-shape curve float ranges
 * @param {number}       input.numShapes
 * @returns {LbBundleBuildResult}
 *          Parallel per-shape arrays; each entry is a mesh/packed-buffer or the
 *          `SLUG` sentinel. `raw` is the CPU mesh (kept for parity with
 *          `_ensureLbMeshes`; the worker only transfers `packed`).
 */
export function buildLbBundle(input) {
  const { curveFloats, metaFloats: meta, metaFloatsPerShape: mst, ranges, numShapes: n } = input;
  const raw = new Array(n), packed = new Array(n);
  let hasReal = false, hasSlug = false;
  for (let s = 0; s < n; s++) {
    const r = ranges && ranges[s];
    if (!r || r.end <= r.begin || (r.end - r.begin) > MONSTER_SEG_FLOATS) {
      raw[s] = SLUG; packed[s] = SLUG; hasSlug = true; continue;
    }
    const bb = meta && mst ? s * mst : -1;
    const transSolid = bb >= 0 && meta[bb + 7] < 0.996 && Math.floor(meta[bb + 28] + 0.5) === 0
      && (mst < 36 || Math.floor(meta[bb + 35] + 0.5) === 0);
    const evenodd = !!(meta && meta[s * mst + 13] > 0.5);
    let contours = null;
    try { contours = curveRangeToContours(curveFloats, r.begin, r.end); } catch { contours = null; }
    const built = buildLbShape(contours, transSolid, evenodd);
    if (built && built.pk && !built.pk.overBudget && (built.pk.vertexCount | 0) > 0
        && (built.pk.vertexCount | 0) <= LB_MAX_VERTS_PER_MESH) {
      raw[s] = built.raw; packed[s] = built.pk; hasReal = true;
    } else { raw[s] = SLUG; packed[s] = SLUG; hasSlug = true; }
  }
  // Whole-bundle vert cap: a sheet of many mid-size shapes can still blow the
  // GPU buffer / mem budget even when each shape alone is fine.
  if (hasReal) {
    let nV = 0;
    for (let s = 0; s < n; s++) if (packed[s] && packed[s].vertexCount) nV += packed[s].vertexCount;
    if (nV > LB_MAX_VERTS_PER_BUNDLE) {
      if (typeof console !== 'undefined') {
        console.warn('[mantle] LB mesh budget: bundle has ' + nV + ' verts (cap '
          + LB_MAX_VERTS_PER_BUNDLE + ') — rendering via Slug.');
      }
      for (let s = 0; s < n; s++) { raw[s] = SLUG; packed[s] = SLUG; }
      return { raw, packed, hasReal: false, hasSlug: true, overBudget: true };
    }
  }
  return { raw, packed, hasReal, hasSlug, overBudget: false };
}
