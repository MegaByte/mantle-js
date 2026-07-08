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
  packLoopBlinnMesh,
} from './loopBlinn.js';
import { SEG_LINE } from '../primitives/seg.js';

// A shape that isn't served analytically renders via Slug. Callers store this
// sentinel per shape so the draw path knows to skip it in the LB pass and let
// the Slug fill cover it. Same shape the renderer has always used.
export const SLUG = { slug: true };

// One shape's curves are >4000 float-segments: a CDT of it can eat seconds even
// off the main thread, and the analytic win is irrelevant at that vertex count —
// render it Slug permanently. (Matches the `_ensureLbMeshes` complexity gate.)
const MONSTER_SEG_FLOATS = 4000;

// --- pure fill-route predicates (moved here from morphDraw.js so the worker can
//     import them without the GL module; re-exported for morphDraw). ---

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
  // Curved / translucent-solid / multi-contour / disjoint → proper Loop-Blinn
  // CDT partition (with a convex single-contour earcut fast path first).
  if (!contoursAllStraight(contours) || transSolid || contours.length > 1 || hasDisjointContours(contours)) {
    if (!transSolid && contours.length === 1) {
      // FAST PATH: single-contour convex curved shape (circle/pill/convex icon) —
      // 15-37× cheaper than CDT. buildLoopBlinnMesh flags a concave curve or a
      // loop/cusp; either → fall through to CDT.
      let m = null;
      try { m = buildLoopBlinnMesh(contours, true); } catch { m = null; }
      if (m && !m.fallback.length && !m.hasConcave) return { raw: m, pk: packLoopBlinnMesh(m) };
    }
    let cdt = null;
    try { cdt = buildLoopBlinnCDT(contours, { fillRule: evenodd ? 'evenodd' : 'nonzero' }); } catch { cdt = null; }
    if (cdt && !cdt.fallback.length) return { raw: cdt, pk: packLoopBlinnMesh(cdt) };
    return null;   // loop/cusp/degenerate → Slug
  }
  // All-straight single-contour polygon → cheap earcut fast path.
  let mesh = null;
  try { mesh = buildLoopBlinnMesh(contours, true); } catch { mesh = null; }
  if (mesh && mesh.fallback.length) mesh = null;   // self-intersecting → Slug
  if (!mesh) return null;
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
 * @returns {{ raw: Array, packed: Array, hasReal: boolean, hasSlug: boolean }}
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
    if (built) { raw[s] = built.raw; packed[s] = built.pk; hasReal = true; }
    else { raw[s] = SLUG; packed[s] = SLUG; hasSlug = true; }
  }
  return { raw, packed, hasReal, hasSlug };
}
