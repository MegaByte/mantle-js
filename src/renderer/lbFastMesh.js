// lbFastMesh.js — the additive fast-path builder: contour rims (on-curve
// points + crescent hulls), earcut of the rim polygon, and the
// assemble step that turns rim triangles into the interior/quads/cubics mesh,
// plus crack healing and the self-overlap union pre-pass. This is the cheap
// convex/simple-shape route; the exact exact partition and the CDT
// orchestrator live in loopBlinn.js and call into these pieces.
import { earcut } from './lbEarcut.js';
import { bezoutCubicImplicit, cubicKLMN, cubicSignKLMN, cubicInflections, cubicLoop, splitCubic, splitCubicMulti, cubicHull, cubicSign, cubicDegreeReduce } from './lbCubicMath.js';
import { _kox, _koy, _koScale, _setKeyOrigin, circleFromContours, ellipseFromContours, extractAnnuli, emitCircleSector, pointInPoly, chordRing, calibrateInterior, verifyInteriorSign, sideInFill, segTangents, segPt, edgeEndMeta } from './lbContour.js';
import { splitInteriorByCurve, _healCand } from './lbInteriorSplit.js';
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_RQUAD } from '../primitives/seg.js';
import { unionPaths } from '../svg/pathBoolean/union.js';
import { intersectSegments } from '../svg/pathBoolean/intersect/index.js';

// Cover-tightening subdivision per inflection-free cubic piece. 1 = the bare
// control hull. Values >1 shrink the implicit-covered slivers toward the curve
// (less fragment overdraw) BUT add a crescent boundary at each split point —
// under the single-pass OVER route those adjacent AA ramps conflate into a
// faint seam. Must stay 1 so the route stays seam-clean; the convex control
// hull is already tight for the inflection-split single-bulge pieces.
// Max ADAPTIVE splits per inflection-free cubic piece (2^depth sub-pieces).
const CUBIC_COVER_MAX_DEPTH = 3;
// Split while the control polygon deviates from its chord by more than this fraction of
// the chord length. A Loop-Blinn cover hull is only sound when it contains just ONE
// branch of the piece's implicit k³−lm; a FAT hull swallows a second branch, the sign
// flips inside it, and the crescent fills out toward the convex hull — measured as a
// real over-fill (ink vs Slug) on fat convex cubics.
const CUBIC_COVER_FLATNESS = 0.08;
// A cubic cover hull is NOT dilated to reach the arc's AA band: any centroid-dilation
// factor is RELATIVE while the AA band is an absolute ~1px, so it starves as the shape
// shrinks on screen. Static meshes instead carry a cubic exterior RING (planned in
// lbPack, extruded 1.5px in the vertex shader with klm following the exact affine
// gradient), which spans the band at any scale. Morph meshes have no rings and keep the
// undilated hull + a per-fragment end-tangent clip so neighbours tile.
const _unit = (x, y) => { const L = Math.hypot(x, y); return L > 1e-12 ? [x / L, y / L] : null; };


/// Recursively halve an inflection-free cubic piece until its control polygon is flat
/// enough that its cover hull holds a single implicit branch. Shallow cubics pass
/// on the first test and emit one piece.
function subdivideFlat(P, depth, out) {
  const ax = P[3][0] - P[0][0], ay = P[3][1] - P[0][1];
  const L = Math.hypot(ax, ay);
  if (L < 1e-12) { out.push(P); return; }
  // perpendicular deviation of the two control points from the chord
  const d1 = Math.abs((P[1][0] - P[0][0]) * ay - (P[1][1] - P[0][1]) * ax) / L;
  const d2 = Math.abs((P[2][0] - P[0][0]) * ay - (P[2][1] - P[0][1]) * ax) / L;
  // NOTE: do NOT also split on degeneracy (klmn === null ⇒ kind-4 Bezout). d1≈0 is a
  // PROJECTIVE INVARIANT: halving a degenerate piece yields two degenerate halves, so the
  // recursion runs to the cap without ever clearing hasBezout.
  const fat = Math.max(d1, d2) > CUBIC_COVER_FLATNESS * L;
  if (depth >= CUBIC_COVER_MAX_DEPTH || !fat) { out.push(P); return; }
  const [l, r] = splitCubic(P, 0.5);
  subdivideFlat(l, depth + 1, out);
  subdivideFlat(r, depth + 1, out);
}

/* buildLoopBlinnMesh (defined below) builds the additive Loop-Blinn mesh for one
 * shape's contours (em space):
 *   @param  contours  Array<Array<Seg>> — closed subpaths; [outer, ...holes].
 *   @returns { interior:Float32Array (xy/vert, TRIANGLES),
 *              quads:Array<{tri,sign}>, cubics:Array<{hull,F,sign}>,
 *              fallback:Array<Seg> (loop/cusp → Slug) } — em-space; F is the
 *   exact normalized-frame Bezout implicit.
 */
// orient each interior row so the face centroid reads INSIDE — shared by the
// carve build and the morph pair transform (one code path).
export function selfOrientRows(rows8, interior) {
  if (!rows8) return rows8;
  for (let i8 = 0; i8 * 9 < rows8.length; i8++) {
    const o8 = i8 * 9;
    const nx8 = rows8[o8], ny8 = rows8[o8 + 1], c8 = rows8[o8 + 2];
    if (nx8 === 0 && ny8 === 0) continue;
    const b8 = i8 * 6;
    const cx8 = (interior[b8] + interior[b8 + 2] + interior[b8 + 4]) / 3;
    const cy8 = (interior[b8 + 1] + interior[b8 + 3] + interior[b8 + 5]) / 3;
    if (c8 - nx8 * cx8 - ny8 * cy8 < 0) for (let k8 = 0; k8 < 9; k8++) rows8[o8 + k8] = -rows8[o8 + k8];
  }
  return rows8;
}

// Build the rims + curve regions + edges for a set of contours (everything
// EXCEPT the earcut triangulation). Shared by buildLoopBlinnMesh (which then
// earcuts) and refreshLoopBlinnMesh (which reuses a cached triangulation when
// the rim STRUCTURE is unchanged — fixed-topology streaming, no earcut).
export function buildRims(contours, isStatic) {
  // even-odd fill test from the on-curve rings (used only for the one-per-
  // contour interior calibration now, not per edge/curve).
  const rings = contours.map(chordRing);
  const inFill = p => { let c = 0; for (const r of rings) if (pointInPoly(p[0], p[1], r)) c++; return (c & 1) === 1; };

  const quads = [], cubics = [], fallback = [], rims = [], edges = [], chordArcs = new Map(), vertexArcs = new Map();
  const chordKey = (p) => Math.round((p[0] - _kox) * _koScale) * 2097152 + Math.round((p[1] - _koy) * _koScale);   // numeric (must match the (x,y) form)
  const addChordArc = (a, ctrl, b, sign, w) => { const ka = chordKey(a), kb = chordKey(b), arc = { a, ctrl, b, sign, w };
    chordArcs.set(ka < kb ? ka + '|' + kb : kb + '|' + ka, arc);
    // vertexArcs holds ALL arcs at an on-curve point (a seam vertex has two) so the
    // interior ramp can pick the wedge-correct one, not last-write-wins.
    let la = vertexArcs.get(ka); if (!la) vertexArcs.set(ka, la = []); la.push(arc);
    let lb = vertexArcs.get(kb); if (!lb) vertexArcs.set(kb, lb = []); lb.push(arc); };
  // Any CONCAVE curve (bulging into the fill) means the earcut-rim mesh mis-threads
  // it (the chord polygon crosses the notch, which additive crescents can't carve
  // back out). Callers route such shapes to the CDT partition instead; a shape with
  // only convex curves renders correctly — and far cheaper — through this mesh.
  let hasConcave = false;
  for (const segs of contours) {
    const rim = [];
    // The fill is on a CONSTANT side of a closed directed boundary (winding
    // doesn't change around a ring), so calibrate the interior side ONCE per
    // contour with a single inFill probe — then edge outward-normals AND curve
    // concavity are O(1)/segment (a local cross-product side test), instead of
    // an O(total-points) inFill PER edge/curve which made the whole build O(n²).
    // interiorSign = +1 ⇒ fill is on the left-perp (-dy,dx) side of the
    // traversal direction; −1 ⇒ right side. outwardSign = −interiorSign.
    // verifyInteriorSign pins the TRAVEL-FRAME convention with a direct probe —
    // calibrateInterior's ctrl-side answer is unverified on line-less contours
    // (glyph bowls), which inverted the band/cap-strip end metadata.
    const interiorSign = verifyInteriorSign(segs, inFill, calibrateInterior(segs, inFill));
    const outwardSign = -interiorSign;
    const tg = segs.map(segTangents);   // per-segment tangents for the kind-10 end metadata
    for (let si = 0; si < segs.length; si++) {
      const s = segs[si];
      if (s.type === SEG_LINE) {
        rim.push(s.p1);
        const ex = s.p2[0] - s.p1[0], ey = s.p2[1] - s.p1[1];
        const L = Math.hypot(ex, ey);
        if (L > 1e-9) {
          const px = -ey / L, py = ex / L;             // left-perpendicular
          edges.push({ p1: s.p1, p2: s.p2, nx: px * outwardSign, ny: py * outwardSign, out: outwardSign,
            e1: edgeEndMeta(segs, tg, si, 0, interiorSign), e2: edgeEndMeta(segs, tg, si, 1, interiorSign) });
        }
        continue;
      }
      if (s.type === SEG_QUAD || s.type === SEG_RQUAD) {
        const concave = sideInFill(s.p1, s.p3, s.p2, interiorSign);   // chord p1→p3, ctrl p2
        if (concave) hasConcave = true;
        rim.push(s.p1); if (concave) rim.push(s.p2);
        // A CONVEX circular arc renders its crescent as an exact circular-SDF SECTOR
        // (kind 6): co-circular sectors share the field AND tile (shared radial edge),
        // so the ≤90°-split / adjacent-arc seams stop MAX-undercounting. Concave
        // circular arcs (hole boundaries) and non-circular curves keep the rquad/quad
        // control-triangle crescent.
        if (s.type === SEG_RQUAD && s.circle && !concave) emitCircleSector(quads, s.circle, s.p1, s.p3, 1);
        else { const w = s.type === SEG_RQUAD ? s.w : 1, sign = concave ? -1 : 1;
          const q9 = { tri: new Float32Array([s.p1[0], s.p1[1], s.p2[0], s.p2[1], s.p3[0], s.p3[1]]), sign, w };
          // Kind-12 unified-band end metadata (static quads / rquads): the same
          // neighbour normal/curvature/type payload the kind-10 edge strip carries, so
          // the packer can emit one chained band per arc instead of strip+cap.
          if (isStatic && (s.type === SEG_QUAD || s.type === SEG_RQUAD) && !concave) {
            q9.e1 = edgeEndMeta(segs, tg, si, 0, interiorSign);
            q9.e2 = edgeEndMeta(segs, tg, si, 1, interiorSign);
          }
          quads.push(q9);
          addChordArc(s.p1, s.p2, s.p3, sign, w); }   // interior triangles on this chord ramp at the arc
        continue;
      }
      // cubic
      const P0 = [s.p1, s.p2, s.p3, s.p4];
      // DEGREE REDUCTION: a cubic with a vanishing leading coefficient is a quadratic.
      // klmn reports d1 = d2 = 0, cubicKLMN bails, and the kind-4 Bezout crescent renders
      // it WRONG (a corner-control squircle drew only its interior diamond, ink 0.595).
      // Emit the exact kind-1 quadratic instead — also cheaper, and it carries the
      // tangent/corner partition that cubic crescents don't have.
      // MORPH/STREAM CONSTRAINT: a morph lerps control points across ONE baked mesh, so a
      // segment's curve KIND must be identical on both sides — degree-reducing a cubic to a
      // quadratic on one side only would invalidate the pair (lbPartitionPair requires
      // matching cp lengths). Likewise the refresh path reuses a fixed topology. So both
      // this and the adaptive split are STATIC-only; ramp === true marks the static build.
      const Qr = isStatic ? cubicDegreeReduce(P0) : null;
      if (Qr) {
        const concaveQ = sideInFill(s.p1, s.p4, Qr, interiorSign);
        if (concaveQ) hasConcave = true;
        rim.push(s.p1); if (concaveQ) rim.push(Qr);
        const signQ = concaveQ ? -1 : 1;
        quads.push({ tri: new Float32Array([s.p1[0], s.p1[1], Qr[0], Qr[1], s.p4[0], s.p4[1]]), sign: signQ, w: 1 });
        addChordArc(s.p1, Qr, s.p4, signQ, 1);
        continue;
      }
      if (cubicLoop(P0)) { rim.push(s.p1); fallback.push(s); continue; }   // loop/cusp → Slug
      // Split at inflections (each piece single-bulge), then subdivide each
      // piece further: a sub-piece's de Casteljau control hull hugs the curve
      // tighter than the parent's, so the implicit-covered region shrinks to
      // thin slivers near the curve (the rim threads the split points, so the
      // inner crescent fills flat). Same exact implicit per sub-piece → less
      // fragment overdraw on bulged curves.
      const infPieces = splitCubicMulti(P0, cubicInflections(P0));
      const pieces = [];
      for (const ip of infPieces) { if (isStatic) subdivideFlat(ip, 0, pieces); else pieces.push(ip); }
      rim.push(s.p1);
      const stubE = { nN: [0, 0], k: 0, type: 0, curve: true, tsign: 1, qn: true, turn: 0 };
      for (let pi = 0; pi < pieces.length; pi++) {
        const P = pieces[pi];
        const cmP = [(P[1][0] + P[2][0]) / 2, (P[1][1] + P[2][1]) / 2];
        const cc = sideInFill(P[0], P[3], cmP, interiorSign);
        if (cc) hasConcave = true;
        if (cc) { rim.push(P[1]); rim.push(P[2]); }
        if (P !== pieces[pieces.length - 1]) rim.push(P[3]);   // interior split point
        const hull = cubicHull(P), htris = hull.length === 3 ? [[0, 1, 2]] : [[0, 1, 2], [0, 2, 3]];
        const klmn = cubicKLMN(P);
        if (klmn) {
          // Cheap Loop-Blinn path: per-vertex (k,l,m) interpolated; f = k³−lm.
          const sign = cubicSignKLMN(P, klmn, cc);
          const verts = [], tc = [];
          for (const tri of htris) for (const hi of tri) {
            const idx = hull[hi], cp = P[idx];
            verts.push(cp[0], cp[1]);
            tc.push(klmn.k[idx], klmn.l[idx], klmn.m[idx]);
          }
          // The hull is NOT dilated. A static mesh gets a cubic exterior RING (lbPack plans one
          // quad per hull edge; the vertex shader extrudes it 1.5px with klm carried by the exact
          // affine gradient), which spans the AA band at any screen scale — a relative centroid
          // dilation would starve as the shape shrank (see the module header). na/nb/a/b below
          // are the end-tangent clip planes, used only when a piece has NO ring (morph meshes),
          // where they trim the hull to its own span.
          // `cp` (the 4 sub-piece control points) is retained only for the GPU
          // morph builder, which recomputes klmn per-frame from lerped control
          // points; the static pack path ignores it.
          const tA = _unit(P[1][0]-P[0][0], P[1][1]-P[0][1]) || _unit(P[2][0]-P[0][0], P[2][1]-P[0][1]) || _unit(P[3][0]-P[0][0], P[3][1]-P[0][1]);
          const tB = _unit(P[3][0]-P[2][0], P[3][1]-P[2][1]) || _unit(P[3][0]-P[1][0], P[3][1]-P[1][1]) || _unit(P[3][0]-P[0][0], P[3][1]-P[0][1]);
          // Kind-12 end metadata: real neighbour meta at the contour-segment ends;
          // interior split joints span-clip (type 0 stub).
          const e1 = (isStatic && pi === 0) ? edgeEndMeta(segs, tg, si, 0, interiorSign) : stubE;
          const e2 = (isStatic && pi === pieces.length - 1) ? edgeEndMeta(segs, tg, si, 1, interiorSign) : stubE;
          cubics.push({ hull: new Float32Array(verts), klmn: new Float32Array(tc), sign, cp: P,
                        na: tA, nb: tB ? [-tB[0], -tB[1]] : null, a: P[0], b: P[3], e1, e2 });
        } else {
          // Degenerate (cusp / d1≈0) → exact Bezout det.
          const F = bezoutCubicImplicit(P);
          const sign = cubicSign(P, F, cc);
          const verts = [];
          for (const tri of htris) for (const hi of tri) { const cp = P[hull[hi]]; verts.push(cp[0], cp[1]); }
          cubics.push({ hull: new Float32Array(verts), F, sign });
        }
      }
    }
    rims.push(rim);
  }
  return { rims, quads, cubics, edges, fallback, hasConcave, chordArcs, vertexArcs, turns: rims.map(rimTurns) };
}




// Per-vertex turn-sign (convex/reflex) fingerprint of a closed rim polygon, in
// rim order. The cached earcut triangulation only stays valid while the rim's
// convex/reflex structure is unchanged: a streamed shape that DEFORMS
// continuously (a morph, or the road scrolling within a band) keeps this
// pattern, but one that TELEPORTS — e.g. a ring-buffer road slot reassigned to
// a different depth band when scroll crosses a group boundary — flips vertex
// turn signs, so its stale triangulation no longer tiles the new polygon
// (under-fill / "wrong wedges"). refreshLoopBlinnMesh rebuilds on a mismatch.
// The sign is the NORMALIZED turn sine, so it's scale-invariant and treats
// near-collinear vertices (a nearly-straight road) as 0 — stable across frames.
function rimTurns(rim) {
  const n = rim.length, out = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const a = rim[(i - 1 + n) % n], b = rim[i], c = rim[(i + 1) % n];
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
    const den = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const sn = den > 1e-12 ? (ux * vy - uy * vx) / den : 0;
    out[i] = sn > 1e-3 ? 1 : sn < -1e-3 ? -1 : 0;
  }
  return out;
}

// Compare two rim turn-sign fingerprints (per-contour arrays). Equal ⇒ the
// cached triangulation may be reused; differ ⇒ the rim's convex/reflex
// structure changed (curve flip or slot teleport) → rebuild.
export function turnsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (!x || !y || x.length !== y.length) return false;
    for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return false;
  }
  return true;
}

// Flatten rims (outer first, then holes) into one coords array + hole-start
// indices. Triangle indices point back into `coords`.
export function flattenRims(rims) {
  const coords = [], holeStarts = [];
  for (const p of rims[0]) coords.push(p);
  for (let i = 1; i < rims.length; i++) { holeStarts.push(coords.length); for (const p of rims[i]) coords.push(p); }
  return { coords, holeStarts };
}

// Classify rims by CONTAINMENT, not by index.
//
// flattenRims assumes rims[0] is the outer contour and every later rim is a HOLE
// of it. That is only true for a single solid with holes. A path holding several
// DISJOINT solids — a dotted i, a %, a colon, or the two lobes a resolved
// self-intersection produces — then has its second solid triangulated as a hole
// and it does not render AT ALL (measured: two separated blobs in one path, the
// second entirely missing; the bowtie filling {left, top} instead of
// {left, right}).
//
// Even nesting depth is solid, odd is a hole, and each hole belongs to the
// DEEPEST solid that contains it — the standard even-odd nesting rule, which
// also gets a hole-inside-a-hole (an island) right. Containment is decided by
// majority vertex vote so a rim that TOUCHES another at a point or shares a
// vertex is not misread by a single ambiguous sample.
export function groupRims(rims) {
  const n = rims.length;
  if (n <= 1) return [{ outer: 0, holes: [] }];
  const inside = (ri, rj) => {                     // is rim ri inside rim rj?
    const pts = rims[ri], poly = rims[rj];
    let hit = 0, tot = 0;
    for (const p of pts) { tot++; if (pointInPoly(p[0], p[1], poly)) hit++; }
    return tot > 0 && hit * 2 > tot;
  };
  const contains = [];                             // contains[i] = rims containing i
  for (let i = 0; i < n; i++) {
    contains[i] = [];
    for (let j = 0; j < n; j++) if (j !== i && inside(i, j)) contains[i].push(j);
  }
  const groups = [];
  const idxOf = new Map();
  for (let i = 0; i < n; i++) if ((contains[i].length & 1) === 0) {   // even depth → solid
    idxOf.set(i, groups.length);
    groups.push({ outer: i, holes: [] });
  }
  for (let i = 0; i < n; i++) if ((contains[i].length & 1) === 1) {   // odd depth → hole
    // parent = the containing SOLID with the greatest depth (the innermost one)
    let best = -1, bestD = -1;
    for (const j of contains[i]) {
      if ((contains[j].length & 1) !== 0) continue;                   // holes cannot parent
      if (contains[j].length > bestD) { bestD = contains[j].length; best = j; }
    }
    if (best >= 0 && idxOf.has(best)) groups[idxOf.get(best)].holes.push(i);
  }
  return groups;
}

// Lay the rims out component-by-component: each solid immediately followed by
// its own holes. Same {coords, holeStarts} shape the callers already hand to
// `assemble`, plus the per-component spans needed to triangulate.
//
// Split from the triangulation on purpose: the streaming refresh path REUSES a
// cached triangulation and must not be made to earcut just to learn the layout
// (that cache is the road's per-frame win).
export function layoutRims(rims) {
  const groups = groupRims(rims);
  const coords = [], holeStarts = [], spans = [];
  for (const g of groups) {
    const base = coords.length;
    const localHoles = [];
    for (const p of rims[g.outer]) coords.push(p);
    for (const h of g.holes) {
      holeStarts.push(coords.length);
      localHoles.push(coords.length - base);
      for (const p of rims[h]) coords.push(p);
    }
    spans.push({ base, count: coords.length - base, localHoles });
  }
  return { coords, holeStarts, spans };
}

// Triangulate each solid component separately so each keeps its own hole list,
// then concatenate with the component's base index applied.
export function triangulateLayout(coords, spans) {
  const tris = [];
  for (const sp of spans) {
    const local = coords.slice(sp.base, sp.base + sp.count);
    const t = earcut(local, sp.localHoles.length ? sp.localHoles : null);
    for (let k = 0; k < t.length; k++) tris.push(t[k] + sp.base);
  }
  return tris;
}
function interiorFromTris(coords, tris) {
  const interior = new Float32Array(tris.length * 2);
  let w = 0;
  for (let t = 0; t < tris.length; t++) { const p = coords[tris[t]]; interior[w++] = p[0]; interior[w++] = p[1]; }
  return interior;
}
// Per-interior-VERTEX straight boundary-edge line (nx, ny, c) — the SAME line
// for all 3 verts of a triangle that has a straight boundary edge, 0 otherwise.
// The fragment ramps kind-0 coverage across this line (the INNER half of the
// edge AA: clamp(½ − f/fwidth), f = signed distance, +outside), while the
// outward strip supplies the outer half — so straight edges AA with no interior
// inset (which distorted corners). A triangle with two boundary edges keeps the
// first; the other is still outer-AA'd by its strip. Curve/internal edges → 0.
function interiorEdgesFromTris(coords, tris, edges) {
  const out = new Float32Array(tris.length * 3);
  if (!edges || !edges.length) return out;
  const key = (p) => Math.round((p[0] - _kox) * _koScale) * 2097152 + Math.round((p[1] - _koy) * _koScale);   // numeric (must match the (x,y) form)
  const map = new Map();
  for (const e of edges) { const line = [e.nx, e.ny, e.nx * e.p1[0] + e.ny * e.p1[1]]; map.set(key(e.p1) + '|' + key(e.p2), line); map.set(key(e.p2) + '|' + key(e.p1), line); }
  for (let t = 0; t < tris.length; t += 3) {
    const a = coords[tris[t]], b = coords[tris[t + 1]], c = coords[tris[t + 2]];
    const ka = key(a), kb = key(b), kc = key(c);
    const line = map.get(ka + '|' + kb) || map.get(kb + '|' + kc) || map.get(kc + '|' + ka);
    if (!line) continue;
    for (let k = 0; k < 3; k++) { const w = (t + k) * 3; out[w] = line[0]; out[w + 1] = line[1]; out[w + 2] = line[2]; }
  }
  return out;
}
// Same per-vertex boundary-edge line, but for RAW interior-triangle points (the
// CDT path stores its interior triangles as a flat [x0,y0,x1,y1,x2,y2,…] array,
// not indices). Gives CDT-routed shapes' straight edges the analytic AA ramp the
// earcut mesh already had — otherwise those edges alias (the pill's flat sides).
export function interiorEdgesFromTriPoints(interior, edges) {
  const out = new Float32Array((interior.length / 2) * 3);
  if (!edges || !edges.length) return out;
  const key = (x, y) => Math.round((x - _kox) * _koScale) * 2097152 + Math.round((y - _koy) * _koScale);   // numeric: string keys were a top build allocator
  const map = new Map();
  for (const e of edges) { const line = [e.nx, e.ny, e.nx * e.p1[0] + e.ny * e.p1[1]];
    map.set(key(e.p1[0], e.p1[1]) + '|' + key(e.p2[0], e.p2[1]), line);
    map.set(key(e.p2[0], e.p2[1]) + '|' + key(e.p1[0], e.p1[1]), line); }
  for (let t = 0; t < interior.length; t += 6) {
    const ka = key(interior[t], interior[t + 1]), kb = key(interior[t + 2], interior[t + 3]), kc = key(interior[t + 4], interior[t + 5]);
    const line = map.get(ka + '|' + kb) || map.get(kb + '|' + kc) || map.get(kc + '|' + ka);
    if (!line) continue;
    const o = (t / 2) * 3;
    for (let k = 0; k < 3; k++) { out[o + k * 3] = line[0]; out[o + k * 3 + 1] = line[1]; out[o + k * 3 + 2] = line[2]; }
  }
  return out;
}
export function rimLens(rims) { return rims.map(r => r.length); }

// ── ANALYTIC POLY-CLIP CHAINS ────────────────────────────────────────────────
// For each COARSE interior triangle (no shatter/heal/tag), build the LOCAL
// outline chain it needs: its straight boundary side + the outline-adjacent
// straight edges at that side's endpoints, as an ordered 4-point polyline
// directed FILL-ON-LEFT. The kind-0 fragment clips this chain to the pixel box
// and shoelaces the fill polygon — exact coverage for edges, stems, convex AND
// reflex corners, tips, and junctions with NO corner-type tag and NO proximity
// gate (span falls out of clipping segments to the box; validated in
// probes/_polyClip.mjs at 0.5/255 vs supersampling). Returns per-VERTEX arrays
// (the same chain replicated across a triangle's 3 verts), stride 4:
//   chainA = P0.xy,P1.xy → aC3      chainB = P2.xy,P3.xy → aC0
// A solid interior triangle (no straight side) gets all-zero → 0 segments → 1.
// Arcs a face may touch and still take the analytic path: one chain rides
// aC3/aC0/aTC, a second rides aC1/aC2. There is no third slot.
const __LB_MAX_ARCS = 2;
// Exact conic chains remain available for quality/performance probes. They are
// disabled in production because their broad fragment cost outweighs their
// mixed AA benefit on the audited glyph and real-asset corpus.

export function interiorChainsFromTris(coords, tris, edges) {
  const conicOn = globalThis.__LB_CONIC === true;
  const chainA = new Float32Array(tris.length * 4);   // P0, P1
  const chainB = new Float32Array(tris.length * 4);   // P2, P3
  const chainC = new Float32Array(tris.length * 4);   // P4, P5
  const chainD = new Float32Array(tris.length * 4);   // CHAIN 2: Q0, Q1 → aC1
  const chainE = new Float32Array(tris.length * 4);   // CHAIN 2: Q2, Q3 → aC2
  const badFaces = new Uint8Array((tris.length / 3) | 0);   // faces neither chain can serve
  let incomplete = false, hasChain2 = false;          // see the coverage check below
  if (!edges || !edges.length) return { chainA, chainB, chainC, chainD, chainE, incomplete, hasChain2, badFaces };
  const key = (x, y) => Math.round((x - _kox) * _koScale) * 2097152 + Math.round((y - _koy) * _koScale);
  const sideMap = new Map();                     // "kA|kB" → edge (both dirs)
  const vertEdges = new Map();                   // vkey → [edges]
  for (const e of edges) {
    const k1 = key(e.p1[0], e.p1[1]), k2 = key(e.p2[0], e.p2[1]);
    sideMap.set(k1 + '|' + k2, e); sideMap.set(k2 + '|' + k1, e);
    let a = vertEdges.get(k1); if (!a) vertEdges.set(k1, a = []); a.push(e);
    let b = vertEdges.get(k2); if (!b) vertEdges.set(k2, b = []); b.push(e);
  }
  // orient an edge so FILL is on the LEFT of A→B (leftN·outwardNormal < 0).
  const orientLeft = (e) => {
    const dx = e.p2[0] - e.p1[0], dy = e.p2[1] - e.p1[1];
    return (-dy * e.nx + dx * e.ny) < 0 ? [e.p1, e.p2] : [e.p2, e.p1];
  };
  const kk = (p) => key(p[0], p[1]);
  // preceding/following outline REACH at a chain end (fill-left orientation).
  // A single neighbour point is not enough once curve polylines densify: the
  // neighbour is one SHORT piece, the chain's reach shrinks below the box
  // distance, fragments past it miss, and forceInside paints solid (the A
  // regression at 0.004em density). So WALK outward, absorbing consecutive
  // pieces until ~REACH em of span or the outline turns past TURN rad —
  // the emitted chord-of-walk errs by its sagitta ≈ span·turn/8 ≤ ~0.25px.
  // The absorbed edges are reported so the leftover bookkeeping counts them
  // as spanned (mutating points without that corrupted l's accounting).
  // R_REACH bounds a walk's SPAN, and with R_TURN it bounds the emitted
  // chord-of-walk error at span·turn/8. At 0.02/0.45 that is 0.00113em — four
  // times coarser than the hull polyline pieces feeding it, so the walk chord,
  // not the polyline, was the accuracy floor (raising density past ~0.00025
  // stopped helping because of this). Swept on the bowl set at fixed density:
  //   0.015→12.60/36 · 0.012→12.01/37 · 0.010→11.80/37 (min) · 0.008→12.20/41
  //   0.006→12.44/44 — and longer is worse still (0.04→21.35, 0.06→23.64):
  // a longer walk swallows more curve into one chord. Shorter than 0.01 loses
  // reach faster than it gains chord accuracy. 0.01 is the measured optimum on
  // BOTH routes (it also returns the default set to its 10.83/69 best).
  const R_REACH = globalThis.__LB_R_REACH || 0.01, R_TURN = globalThis.__LB_R_TURN || 0.45, R_HOPS = globalThis.__LB_R_HOPS || 8;
  // Walk outward emitting a POLYLINE: one point per ≤R_TURN chord, plus a real
  // point at a sharper bend when the chord walked so far is a MICRO segment
  // (≤R_MICRO em). Stopping AT such a bend left the chain end mid-outline with
  // a noise-direction terminal segment — at q's stem–bowl junction the 0.002em
  // micro-flat became the terminal chord, and the shader's ends-on-border
  // extension continued its direction straight across the stem ink (a
  // fabricated boundary). Crossing the bend with an emitted corner point is
  // EXACT for chainBoxCov. Long chords keep the old stop-at-bend behavior —
  // their tangent extension is representative, and eagerly crossing every bend
  // measured worse (A's counter tip 0.44→0.62: the spent slots and absorbed
  // edges perturb window/chain-2 bookkeeping for no phantom removed).
  // Returns [{pt, ek}] chunks in walk order (ek = edges absorbed since the
  // previous emitted point), so a caller trimming points to its slot budget
  // can keep the spanned-edge bookkeeping exact per kept point.
  const R_MICRO = 0.005;
  const walkOut = (vk0, exclude, backward, maxPts = 1) => {
    let vk = vk0, cur = null, span = 0, turn = 0, chordSpan = 0, pdx = 0, pdy = 0;
    const seen = new Set();
    let ek = new Set();
    const out = [];
    for (let h = 0; h < R_HOPS; h++) {
      let next = null, edge = null, from = null;
      for (const e of vertEdges.get(vk) || []) {
        if (exclude.has(e) || seen.has(e)) continue;
        const [A, B] = orientLeft(e);
        if (backward ? kk(B) === vk : kk(A) === vk) { next = backward ? A : B; from = backward ? B : A; edge = e; break; }
      }
      if (!next) break;
      const dx = next[0] - from[0], dy = next[1] - from[1], L = Math.hypot(dx, dy);
      if (L > 1e-12) {
        if (cur) {                                       // accumulate turning past the first hop
          const dot = (pdx * dx + pdy * dy) / L;
          turn += Math.acos(Math.max(-1, Math.min(1, dot)));
          if (turn > R_TURN) {
            // bend: cross it only when the walked chord is micro (its direction
            // would fabricate the terminal extension); else stop at the corner
            if (chordSpan > R_MICRO || out.length + 1 >= maxPts) break;
            out.push({ pt: cur, ek });
            ek = new Set(); turn = 0; chordSpan = 0;
          }
        }
        pdx = dx / L; pdy = dy / L; span += L; chordSpan += L;
      }
      seen.add(edge); ek.add(edge); cur = next; vk = kk(next);
      if (span >= R_REACH) break;
    }
    if (cur) out.push({ pt: cur, ek });
    return out.length ? out : null;
  };
  const precede = (vk, exclude, maxPts) => walkOut(vk, exclude, true, maxPts);
  const follow = (vk, exclude, maxPts) => walkOut(vk, exclude, false, maxPts);
  // Link fill-left oriented sides into ONE connected chain: start = a side whose
  // A is no other side's B, then follow B→A. Returns the ordered point list.
  const orderChain = (ss) => {
    if (!ss.length) return [];
    const ends = new Set(ss.map((s) => kk(s[1])));
    let start = ss.find((s) => !ends.has(kk(s[0]))) || ss[0];
    const ordered = [start]; const used = new Set([start]); let cur = start;
    while (ordered.length < ss.length) {
      const nx = ss.find((s) => !used.has(s) && kk(s[0]) === kk(cur[1]));
      if (!nx) break; ordered.push(nx); used.add(nx); cur = nx;
    }
    const out = [ordered[0][0]]; for (const s of ordered) out.push(s[1]);
    return out;
  };
  // The DISCONNECTED outline ARCS this face touches: every outline edge incident
  // to any of its vertices, grouped transitively by shared endpoints, each group
  // ordered fill-left. A face reaching two arcs needs TWO chains — one ordered
  // chain cannot represent both, and a fragment near the second arc would fall
  // off the first and hit the miss path (see the region proof in `assemble`).
  // Edges a face's fragments can REACH: vertex-incident ones (the CDT
  // guarantees nearby outline shares a vertex — for CDT points) PLUS any edge
  // within R_NEAR of the triangle. Vertex incidence alone was a valid proxy
  // until curve-polyline densification introduced NON-CDT points: A's counter
  // tip pokes into a face that shares no vertex with it, the face was declared
  // complete, and its fragments painted solid over the hole tip (the 0.004
  // density regression, mechanism #4).
  const R_NEAR = 0.006;
  const segSegNear = (a1, a2, b1, b2, r) => {
    const d2 = (p, q1, q2) => { const dx = q2[0] - q1[0], dy = q2[1] - q1[1];
      const L2 = dx * dx + dy * dy || 1e-30;
      const t = Math.max(0, Math.min(1, ((p[0] - q1[0]) * dx + (p[1] - q1[1]) * dy) / L2));
      const cx = q1[0] + t * dx - p[0], cy = q1[1] + t * dy - p[1];
      return cx * cx + cy * cy; };
    const rr = r * r;
    return d2(a1, b1, b2) <= rr || d2(a2, b1, b2) <= rr || d2(b1, a1, a2) <= rr || d2(b2, a1, a2) <= rr;
  };
  const touchedFor = (K, own, P) => {
    const es = new Set(own);
    for (const vk of K) for (const e of vertEdges.get(vk) || []) es.add(e);
    for (const e of edges) {
      if (es.has(e)) continue;
      for (let s2 = 0; s2 < 3; s2++) {
        if (segSegNear(e.p1, e.p2, P[s2], P[(s2 + 1) % 3], R_NEAR)) { es.add(e); break; }
      }
    }
    return [...es];
  };
  const ekeyOf = (e) => kk(e.p1) + '|' + kk(e.p2);
  // undirected edge keys a point-chain actually spans (degenerate pads excluded)
  const chainEdgeKeys = (pl) => {
    const s = new Set();
    for (let i = 0; i + 1 < pl.length; i++) {
      const a = kk(pl[i]), b = kk(pl[i + 1]);
      if (a === b) continue;
      s.add(a + '|' + b); s.add(b + '|' + a);
    }
    return s;
  };
  // split an edge set into connected runs (shared endpoints, transitively)
  const groupRuns = (list) => {
    if (!list.length) return [];
    const parent = list.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const a1 = kk(a.p1), a2 = kk(a.p2), b1 = kk(b.p1), b2 = kk(b.p2);
      if (a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2) {
        const ra = find(i), rb = find(j); if (ra !== rb) parent[ra] = rb;
      }
    }
    const byRoot = new Map();
    list.forEach((e, i) => { const r = find(i); let g = byRoot.get(r); if (!g) byRoot.set(r, g = []); g.push(e); });
    return [...byRoot.values()];
  };
  const runNearCen = (runs, cen) => {   // the run this face's fragments can actually reach
    let best = runs[0], bd = Infinity;
    for (const r of runs) {
      let d = Infinity;
      for (const e of r) for (const p of [e.p1, e.p2]) {
        const dx = p[0] - cen[0], dy = p[1] - cen[1]; d = Math.min(d, dx * dx + dy * dy);
      }
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  };
  // Window n points of a run around the face — full resolution NEAR the face
  // (n−2 central points, where accuracy matters), and the two END points reach
  // outward by the same span/turn walk as pre/post (dense polylines otherwise
  // shrink a point-counted window's REACH below box distance → miss → solid;
  // that was A's 0.77 regression at 0.004em density, in its third disguise).
  // Returns the covered ORIGINAL edge keys so leftover bookkeeping counts the
  // decimated pieces as spanned.
  const nearWindow = (pts, n, cen) => {
    const allKeys = () => {
      const ks = new Set();
      for (let i = 0; i + 1 < pts.length; i++) { const a = kk(pts[i]), b = kk(pts[i + 1]); ks.add(a + '|' + b); ks.add(b + '|' + a); }
      return ks;
    };
    if (pts.length <= n) return { pts, keys: allKeys() };
    let best = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i][0] - cen[0], dy = pts[i][1] - cen[1], d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    const nc = n - 2;                                       // central full-res points
    const lo = Math.max(0, Math.min(pts.length - nc, best - (nc >> 1)));
    const hi = lo + nc - 1;
    const walkList = (idx, dir) => {
      let span = 0, turn = 0, i = idx, pdx = 0, pdy = 0, first = true;
      for (;;) {
        const j = i + dir;
        if (j < 0 || j >= pts.length) break;
        const dx = pts[j][0] - pts[i][0], dy = pts[j][1] - pts[i][1], L = Math.hypot(dx, dy);
        if (L > 1e-12) {
          if (!first) {
            const dot = (pdx * dx + pdy * dy) / L;
            turn += Math.acos(Math.max(-1, Math.min(1, dot)));
            if (turn > R_TURN) break;
          }
          pdx = dx / L; pdy = dy / L; span += L; first = false;
        }
        i = j;
        if (span >= R_REACH) break;
      }
      return i;
    };
    const pLo = walkList(lo, -1), pHi = walkList(hi, +1);
    const out = [];
    if (pLo < lo) out.push(pts[pLo]);
    for (let i = lo; i <= hi; i++) out.push(pts[i]);
    if (pHi > hi) out.push(pts[pHi]);
    const keys = new Set();
    for (let i = pLo; i < pHi; i++) { const a = kk(pts[i]), b = kk(pts[i + 1]); keys.add(a + '|' + b); keys.add(b + '|' + a); }
    return { pts: out, keys };
  };
  for (let t = 0; t < tris.length; t += 3) {
    const P = [coords[tris[t]], coords[tris[t + 1]], coords[tris[t + 2]]];
    const K = [kk(P[0]), kk(P[1]), kk(P[2])];
    // ALL outline sides of this face, oriented fill-left, with their edge object.
    const sides = []; const own = new Set();
    for (let s = 0; s < 3; s++) { const e = sideMap.get(K[s] + '|' + K[(s + 1) % 3]);
      if (e && !own.has(e)) { own.add(e); sides.push(orientLeft(e)); } }
    const cen = [(P[0][0] + P[1][0] + P[2][0]) / 3, (P[0][1] + P[1][1] + P[2][1]) / 3];
    const touched = touchedFor(K, own, P);
    if (!touched.length) continue;                // true deep interior → all-zero → 1
    const walked = new Set();                     // edges absorbed by reach walks — count as spanned
    let pts, conicFace = false;
    if (sides.length) {
      // CHAIN 1: order this face's own sides, then extend each end along the
      // outline. The walks may emit MULTIPLE points (bend crossings); the
      // packed chain holds 5 points (aC3/aC0/aTC.yz — P5 is never emitted), so
      // allocate the spare slots between the two walks and trim the tails
      // farthest from the face when both want more than fit.
      const chain = orderChain(sides);
      const budget = Math.max(0, 5 - chain.length);
      const preL = budget ? precede(kk(chain[0]), own, budget) : null;
      const postL = budget ? follow(kk(chain[chain.length - 1]), own, budget) : null;
      const d2cen = (p) => { const dx = p[0] - cen[0], dy = p[1] - cen[1]; return dx * dx + dy * dy; };
      // Floor: each side keeps its NEAREST point (the pre-bend behavior — a
      // stripped side loses all reach and its fragments miss → solid). Spare
      // slots go to bend-crossing extras, nearest-to-face first, prefix order.
      let nPre = 0, nPost = 0;
      if (preL && budget >= 1 && (budget >= 2 || !postL)) nPre = 1;
      if (postL && budget >= 1 && (budget >= 2 || !preL)) nPost = 1;
      let spare = budget - nPre - nPost;
      while (spare > 0) {
        const da = preL && nPre < preL.length ? d2cen(preL[nPre].pt) : Infinity;
        const db = postL && nPost < postL.length ? d2cen(postL[nPost].pt) : Infinity;
        if (da === Infinity && db === Infinity) break;
        if (da <= db) nPre++; else nPost++;
        spare--;
      }
      pts = [];
      for (let i = nPre - 1; i >= 0; i--) pts.push(preL[i].pt);   // farthest first
      for (const q of chain) pts.push(q);
      for (let i = 0; i < nPost; i++) pts.push(postL[i].pt);
      for (let i = 0; i < nPre; i++) for (const e of preL[i].ek) walked.add(ekeyOf(e));
      for (let i = 0; i < nPost; i++) for (const e of postL[i].ek) walked.add(ekeyOf(e));
      // CONIC CHAIN: when this face's boundary is at most TWO pieces and any of
      // them is a real curve, pack it as two quadratic Béziers instead of four
      // line segments — the arc is then represented EXACTLY (no sagitta to
      // trade against reach). Five slots hold [P0,C0,P1,C1,P2], the same layout,
      // so only the sentinel changes. A straight-heavy face keeps all four of
      // its line segments and is untouched.
    } else {
      // NO outline side of its own (all three edges internal diagonals) — the
      // old code left this all-zero, so every fragment missed and filled solid.
      // Its vertices still sit on the outline, so serve it from its largest run.
      const runs = groupRuns(touched);
      let best = runs[0];
      for (const r of runs) if (r.length > best.length) best = r;
      const w1 = nearWindow(orderChain(best.map(orientLeft)), 5, cen);
      pts = w1.pts.map((p) => p.slice());
      for (const k of w1.keys) walked.add(k);
    }
    const conicHere = conicOn && (globalThis.__LB_CONIC_OWN !== true || sides.length > 0);
    if (conicHere && pts.length >= 2) {
      // Two conic segments hold THREE on-curve points, so WINDOW the chain to
      // the 3 consecutive points nearest the face rather than gating on its
      // length. Gating on pts.length ≤ 3 never fired — the reach walks push
      // almost every chain past it, and conic mode was dead (0 of 103 faces).
      const ctrlFor = (a, b) => {
        const e = sideMap.get(kk(a) + '|' + kk(b));
        return e && e.c ? [e.c[0], e.c[1]]
                        : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];   // straight → cross term 0
      };
      let anyCurve = false;
      for (let i = 0; i + 1 < pts.length; i++) {
        const e = sideMap.get(kk(pts[i]) + '|' + kk(pts[i + 1]));
        if (e && e.c) anyCurve = true;
      }
      if (anyCurve) {
        const PW = pts.slice();
        while (PW.length < 3) PW.push(PW[PW.length - 1]);     // degenerate 2nd conic
        let lo = 0;
        if (PW.length > 3) {                                // window nearest the face
          let bd = Infinity;
          for (let i = 0; i + 2 < PW.length; i++) {
            const dx = PW[i + 1][0] - cen[0], dy = PW[i + 1][1] - cen[1], d = dx * dx + dy * dy;
            if (d < bd) { bd = d; lo = i; }
          }
        }
        const A = PW[lo], B = PW[lo + 1], C = PW[lo + 2];
        // A face with NO outline side of its own is already served from a
        // WINDOWED run — a reach compromise — and conic HALVES its segment count
        // (2 pieces vs 4). Where the chosen window does not actually pass near
        // the face, that costs more reach than exact integration buys: the box
        // misses and paints solid/empty. b's 183 sits on exactly such a face (it
        // vanishes when conic is limited to own-side faces, max 183 -> 37) while
        // e's 124 does not. Gate ONLY the no-own-side case on the window being
        // genuinely local; own-side faces keep conic unconditionally.
        let useConic = true;
        if (!sides.length) {
          const segD2c = (a, b, q) => {
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const L2 = dx * dx + dy * dy || 1e-30;
            const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2));
            const cx = a[0] + t * dx - q[0], cy = a[1] + t * dy - q[1];
            return cx * cx + cy * cy;
          };
          let d2 = Infinity;
          for (const V of P) d2 = Math.min(d2, segD2c(A, B, V), segD2c(B, C, V));
          // Swept on the bowl set: 0.0005/0.001/0.0015 all → 9.77/42 (flat
          // optimum), 0.003 → 10.00/43, 0.03 → 10.05/46 (ungated). Restricting
          // it much further approaches own-sides-only, which is far worse
          // (21.13/198) — no-own-side faces DO want conic, just a local window.
          const th = globalThis.__LB_CONIC_NEAR || 0.001;
          if (d2 > th * th) useConic = false;
        }
        if (useConic) {
          pts = [A, ctrlFor(A, B), B, ctrlFor(B, C), C];
          conicFace = true;
        }
        if (globalThis.__CONIC_STATS) globalThis.__CONIC_STATS.conic++;
      }
    }
    // CHAIN 2 = the touched edges chain 1 does NOT span (4 pts → aC1/aC2). This
    // is NOT just "the second arc": a face can touch ONE arc that runs longer
    // than chain 1's 5-point window (H f4 reaches the bottom-left corner that
    // way), and those fragments miss exactly the same. Take the leftover run
    // nearest the face — the one its fragments can actually reach.
    const c1keys = chainEdgeKeys(pts);
    const rem = touched.filter((e) => !c1keys.has(ekeyOf(e)) && !walked.has(ekeyOf(e)));
    let pts2 = null, leftover = rem;
    if (rem.length) {
      // CROSS-CHAIN SPLICE: a leftover run can genuinely TERMINATE at a junction
      // vertex whose outline continuation is spanned by chain 1 (stem–bowl
      // junctions). Left as a chain end, the shader's ends-on-border extension
      // fabricates a tangent boundary across real ink there and min() carves it
      // (q's 240-vs-96). Extend the run past both termini along the actual
      // outline BEFORE windowing, so the junction corner becomes an interior
      // point of the chain. Direction comes from fill-left edge orientation
      // (endpoint matching flipped the side in the first attempt); the walks
      // must be the bend-crossing kind — a single-point splice measured WORSE
      // (144→173: its chord cut the junction corner), and the bend-crossing
      // alone without the splice left the 144 in place. Only the composition
      // fixes it (measured: 144 → 75).
      const runPts = orderChain(runNearCen(groupRuns(rem), cen).map(orientLeft));
      const remSet = new Set(rem);
      if (runPts.length) {
        const fol2 = follow(kk(runPts[runPts.length - 1]), remSet, 4);
        if (fol2) for (const c of fol2) runPts.push(c.pt);
        const pre2 = precede(kk(runPts[0]), remSet, 4);
        if (pre2) for (let i = 0; i < pre2.length; i++) runPts.unshift(pre2[i].pt);
      }
      // CHAIN 2 MUST BOUND THE FILL FROM OUTSIDE. The shader min()s chain 2 in
      // as an UPPER bound on the local fill, which is sound only while chain 2's
      // polyline lies on or outside the true boundary. Over a CURVED edge the
      // polyline is the CHORD, which for a convex arc lies strictly INSIDE the
      // fill — the wrong side — so it carves a sagitta out of every arc it
      // touches. That error is bounded in EM, so in PIXELS it grows without
      // limit as you zoom: on the 8-segment quad ellipse the under-covered pixel
      // count goes 40 → 154 between a 40px and a 160px raster, while the fix
      // below holds 0 → 2.
      //
      // Which side the chord already sits on is decided PER EDGE by where the
      // control point falls. runPts is fill-left oriented, so for a→b the fill
      // is left and cross(b−a, c−a) > 0 puts the control point INSIDE the fill:
      //   concave (control inside)  → the chord is already OUTSIDE the arc, so
      //                               it is a valid bound; hulling it would swap
      //                               it to the wrong side and stop it carving.
      //   convex  (control outside) → the chord cuts into the fill; walk the
      //                               control polygon a→c→b instead. A Bézier
      //                               lies within its control hull, so that is
      //                               on or outside the arc at every scale.
      //
      // Chain 2 has four slots and no sentinel, so it cannot carry the curve
      // exactly, and no two-point segment through a and b can lie outside a
      // convex arc — the control point is the minimal guaranteed outer bound,
      // and the slot it costs is real.
      //
      // Keep this paired with the exact quadArcSide miss path in _boxCov.glsl.
      // Either correction alone leaves the surviving chord model dominant.
      const hullRun = [];
      for (let i = 0; i < runPts.length; i++) {
        hullRun.push(runPts[i]);
        if (i + 1 >= runPts.length) break;
        const a2 = runPts[i], b2 = runPts[i + 1];
        const e2 = sideMap.get(kk(a2) + '|' + kk(b2));
        if (!e2 || !e2.c) continue;
        const cr2 = (b2[0] - a2[0]) * (e2.c[1] - a2[1]) - (b2[1] - a2[1]) * (e2.c[0] - a2[0]);
        if (cr2 < 0) hullRun.push([e2.c[0], e2.c[1]]);       // convex → chord is inside
      }
      const w2 = nearWindow(hullRun, 4, cen);
      pts2 = w2.pts.map((p) => p.slice());
      const c2keys = chainEdgeKeys(pts2);
      leftover = rem.filter((e) => !c2keys.has(ekeyOf(e)) && !w2.keys.has(ekeyOf(e)));
    }
    // Anything still unspanned would miss and fill solid → this face is not
    // analytically representable, and the whole mesh takes the shatter path.
    if (leftover.length) {
      incomplete = true;
      badFaces[(t / 3) | 0] = 1;
      if (globalThis.__CHAIN_DEBUG) {
        // distance of each leftover edge to this triangle (em) — how far away
        // the unrepresentable geometry actually is
        const segPt = (a, b, q) => { const dx = b[0] - a[0], dy = b[1] - a[1];
          const L2 = dx * dx + dy * dy || 1e-30;
          const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2));
          return Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy)); };
        let dMin = Infinity;
        for (const e of leftover) {
          let d = Infinity;
          for (let s2 = 0; s2 < 3; s2++) { const A2 = P[s2], B2 = P[(s2 + 1) % 3];
            d = Math.min(d, segPt(A2, B2, e.p1), d = segPt(A2, B2, e.p2), segPt(e.p1, e.p2, A2), segPt(e.p1, e.p2, B2)); }
          dMin = Math.min(dMin, d);
        }
        (globalThis.__leftoverDbg || (globalThis.__leftoverDbg = [])).push(+dMin.toFixed(4));
      }
    }
    while (pts.length < 6) pts.push(pts[pts.length - 1]);   // pad → degenerate segs (inert)
    if (globalThis.__CHAIN_DEBUG) { const D = (globalThis.__chainDbg || (globalThis.__chainDbg = [])); D.push({ nSides: sides.length, tri: [P[0], P[1], P[2]].map((p) => p.slice()), cen, pts: pts.slice(0, 5).map((p) => p.slice()), pts2: pts2 ? pts2.map((p) => p.slice()) : null, nRegions: groupRuns(touched).length }); D.nTris = tris.length / 3; }
    const q = pts2 || [];
    while (q.length && q.length < 4) q.push(q[q.length - 1]);   // pad → inert segs
    if (pts2) hasChain2 = true;
    for (let k = 0; k < 3; k++) {
      const o = (t + k) * 4;
      chainA[o] = pts[0][0]; chainA[o + 1] = pts[0][1]; chainA[o + 2] = pts[1][0]; chainA[o + 3] = pts[1][1];
      chainB[o] = pts[2][0]; chainB[o + 1] = pts[2][1]; chainB[o + 2] = pts[3][0]; chainB[o + 3] = pts[3][1];
      chainC[o] = pts[4][0]; chainC[o + 1] = pts[4][1];
      // P5 is never read by the shader — reuse it to carry the per-face MODE
      // sentinel (3 = conic, else the straight chain's 2) through healCracks'
      // existing 12-float rows without new plumbing.
      chainC[o + 2] = conicFace ? 3.0 : 2.0; chainC[o + 3] = 0.0;
      if (q.length) {   // all-zero when absent → every segment degenerate → cov 1 → min() no-op
        chainD[o] = q[0][0]; chainD[o + 1] = q[0][1]; chainD[o + 2] = q[1][0]; chainD[o + 3] = q[1][1];
        chainE[o] = q[2][0]; chainE[o + 1] = q[2][1]; chainE[o + 2] = q[3][0]; chainE[o + 3] = q[3][1];
      }
    }
  }
  return { chainA, chainB, chainC, chainD, chainE, incomplete, hasChain2, badFaces };
}


// ── PAYLOAD-REGION COMPACTION ────────────────────────────────────────────────
// Junction-heavy shapes shatter into thousands of kind-0 faces whose LINE
// PAYLOADS are identical (a 'Y' fork: 4968 faces, 4111 sharing ONE payload —
// each independent clip plus the watertight T-crack healing multiplies faces).
// A kind-0 fragment's coverage depends ONLY on its payload lines, never on the
// face's shape, so merging each edge-connected same-payload region and
// re-triangulating its union polygon is OUTPUT-EXACT: same painted region,
// same coverage function, same depth tier. Boundary loop vertices are all
// kept (no simplification), so watertightness against neighbouring regions is
// preserved — their T-vertices already sit on our boundary as loop vertices.
//
// Every step validates by area (loops vs faces, triangles vs faces); any
// anomaly (open loop, pinched figure-8 the walker braided, earcut residue)
// falls back to the component's ORIGINAL faces. Only meshes past a face-count
// floor are touched, so typical shapes stay byte-identical.
// ── SLIVER / DEGENERATE FACE SWEEP ───────────────────────────────────────────
// Junction-heavy shapes shatter into thousands of interior faces: at an
// X-crossing or a multi-stem fork every boundary edge is clipped independently,
// then the watertight T-crack healer splits every face at every neighbour's
// mid-edge vertex — a cascade. Measured 'X' (18 straight segments): 28 CDT faces
// → 84 after the split loop → 756 after healing, of which 1101/1180 were SLIVERS
// (perimeter²/area > 500) clustered on ~19 distinct edges — a small region
// re-covered a hundred-fold by near-coincident hairline triangles. All the same
// payload, so they render correctly (MAX blend) but cost 3 verts each.
//
// Two removable classes, both output-EXACT:
//   (1) DEGENERATE — |area| < 2e-9 em² (~2e-3 px² even at a 1000px em). Paints
//       nothing; can't open a crack (a T-crack is an UNSPLIT neighbour vertex,
//       and removing a ~zero-area triangle introduces none).
//   (2) REDUNDANT SLIVER — a thin small face (height < HEIGHT_EPS em, area <
//       AREA_CAP) whose sample points are ALL inside another KEPT face. Since a
//       kind-0 fragment's coverage depends only on its payload lines, not the
//       triangle, and every point it covered stays covered by the overlapping
//       neighbour, dropping it is exact and provably crack-free. The coverage
//       guard is what makes it safe to remove a face with real (if sub-pixel)
//       area: a sole-coverer sliver at a genuine thin junction fails the guard
//       and is kept.
// Genuine thin features (hairline stems) never appear as interior triangles —
// they are rendered by the curve/stroke path — and would fail the area/height
// gates anyway (min font stroke ≈ 0.03 em). Only meshes past a face-count floor
// are swept, so ordinary glyphs are untouched (byte-identical). STATIC paths
// only; morph pairs build both endpoints through their own entry points and must
// keep matched topology.
export function dropDegenerateFaces(mesh) {
  const I = mesh.interior, E = mesh.interiorEdges;
  if (!I || !E) return;
  // Analytic-chain meshes are coarse (no heal shards) and this rebuild does not
  // carry the chain rows — dropping/reordering faces here would pair faces with
  // other faces' chains (the healCracks bug shape). Skip them.
  if (mesh.interiorChainA) return;
  const nF = (I.length / 6) | 0;
  if (nF < 64) return;   // trivial meshes never carry heal shards; skip the scan
  const E2 = mesh.interiorEdges2, E3 = mesh.interiorEdges3;
  const AREA_EPS = 2e-9;       // degenerate (paints nothing)
  const AREA_CAP = 1e-5;       // sliver candidates only — never a fat feature
  const HEIGHT_EPS = 5e-4;     // sliver thickness (2·area/longestEdge), em
  const keep = new Uint8Array(nF).fill(1);
  // pass 1: mark degenerate + thin sliver CANDIDATES; build a grid of the faces
  // that will definitely survive (non-candidates) for the coverage guard.
  const cand = [];             // sliver-candidate face indices
  let dropped = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let f = 0; f < nF; f++) {
    const t = f * 6;
    const ax = I[t], ay = I[t + 1], bx = I[t + 2], by = I[t + 3], cx = I[t + 4], cy = I[t + 5];
    if (ax < minX) minX = ax; if (ay < minY) minY = ay; if (ax > maxX) maxX = ax; if (ay > maxY) maxY = ay;
    if (bx < minX) minX = bx; if (by < minY) minY = by; if (bx > maxX) maxX = bx; if (by > maxY) maxY = by;
    if (cx < minX) minX = cx; if (cy < minY) minY = cy; if (cx > maxX) maxX = cx; if (cy > maxY) maxY = cy;
    const area = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) * 0.5;
    if (area < AREA_EPS) { keep[f] = 0; dropped++; continue; }
    if (area < AREA_CAP) {
      const e1 = Math.hypot(bx - ax, by - ay), e2 = Math.hypot(cx - bx, cy - by), e3 = Math.hypot(ax - cx, ay - cy);
      const maxE = Math.max(e1, e2, e3);
      if (maxE > 1e-12 && 2 * area / maxE < HEIGHT_EPS) cand.push(f);
    }
  }
  // pass 2: GREEDY containment drop for sliver candidates. Seed a point-location
  // grid with the guaranteed survivors (non-candidate kept faces), then visit
  // candidates fattest-first: a candidate is redundant iff a SINGLE kept face
  // CONTAINS all three of its vertices — and since a triangle is convex, that
  // face then contains the whole candidate (its convex hull). This is the exact,
  // rigorous coverage test (a per-point "covered by SOME face" test is not: two
  // faces could cover two corners each yet leave an interior pocket). The kept
  // set only grows, so a dropped face stays inside a kept face — no gap can open.
  // A lone sole-coverer sliver is contained in no other face, so it is kept.
  if (cand.length) {
    const span = Math.max(maxX - minX, maxY - minY, 1e-9);
    const gs = Math.max(span / Math.max(Math.ceil(Math.sqrt(nF)), 1), 1e-9);
    const gk = (cxi, cyi) => cxi * 262147 + cyi;
    const grid = new Map();
    const isCand = new Uint8Array(nF);
    for (const f of cand) isCand[f] = 1;
    const addToGrid = (f) => {
      const t = f * 6;
      const bx0 = Math.min(I[t], I[t + 2], I[t + 4]), bx1 = Math.max(I[t], I[t + 2], I[t + 4]);
      const by0 = Math.min(I[t + 1], I[t + 3], I[t + 5]), by1 = Math.max(I[t + 1], I[t + 3], I[t + 5]);
      for (let cyi = Math.floor(by0 / gs); cyi <= Math.floor(by1 / gs); cyi++)
        for (let cxi = Math.floor(bx0 / gs); cxi <= Math.floor(bx1 / gs); cxi++) {
          let l = grid.get(gk(cxi, cyi)); if (!l) grid.set(gk(cxi, cyi), l = []); l.push(f);
        }
    };
    for (let f = 0; f < nF; f++) if (keep[f] && !isCand[f]) addToGrid(f);
    const ptInFace = (px, py, f) => {
      const t = f * 6, ax = I[t], ay = I[t + 1], bx = I[t + 2], by = I[t + 3], cx = I[t + 4], cy = I[t + 5];
      const tol = 1e-11;
      const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
      const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
      return (s1 >= -tol && s2 >= -tol && s3 >= -tol) || (s1 <= tol && s2 <= tol && s3 <= tol);
    };
    // Is the whole candidate F contained in one kept face? Scan kept faces whose
    // cell holds F's centroid (a containing face necessarily covers the centroid).
    const containedInKept = (f) => {
      const t = f * 6, ax = I[t], ay = I[t + 1], bx = I[t + 2], by = I[t + 3], cx = I[t + 4], cy = I[t + 5];
      const gx = (ax + bx + cx) / 3, gy = (ay + by + cy) / 3;
      const l = grid.get(gk(Math.floor(gx / gs), Math.floor(gy / gs)));
      if (!l) return false;
      for (const g of l) {
        if (g === f) continue;
        if (ptInFace(ax, ay, g) && ptInFace(bx, by, g) && ptInFace(cx, cy, g)) return true;
      }
      return false;
    };
    const areaOf = (f) => { const t = f * 6; return Math.abs((I[t + 2] - I[t]) * (I[t + 5] - I[t + 1]) - (I[t + 3] - I[t + 1]) * (I[t + 4] - I[t])) * 0.5; };
    cand.sort((a, b) => areaOf(b) - areaOf(a));   // fattest first
    for (const f of cand) {
      if (containedInKept(f)) {
        keep[f] = 0; dropped++;
      } else {
        addToGrid(f);
      }
    }
  }
  if (!dropped) return;
  const nI = new Float32Array((nF - dropped) * 6);
  const nE = new Float32Array((nF - dropped) * 9);
  const nE2 = E2 ? new Float32Array((nF - dropped) * 12) : null;
  const nE3 = E3 ? new Float32Array((nF - dropped) * 12) : null;
  let w = 0;
  for (let f = 0; f < nF; f++) {
    if (!keep[f]) continue;
    const t = f * 6, e = f * 9, e2 = f * 12, wt = w * 6, we = w * 9, we2 = w * 12;
    for (let i = 0; i < 6; i++) nI[wt + i] = I[t + i];
    for (let i = 0; i < 9; i++) nE[we + i] = E[e + i];
    if (nE2) for (let i = 0; i < 12; i++) nE2[we2 + i] = E2[e2 + i];
    if (nE3) for (let i = 0; i < 12; i++) nE3[we2 + i] = E3[e2 + i];
    w++;
  }
  mesh.interior = nI;
  mesh.interiorEdges = nE;
  if (nE2) mesh.interiorEdges2 = nE2;
  if (nE3) mesh.interiorEdges3 = nE3;
}
// Split any interior triangle carrying ≥2 straight boundary edges into a
// centroid fan so every piece has ≤1 boundary edge. interiorEdgesFromTris packs
// ONE inner-ramp line per triangle, so a corner/lone triangle with two or three
// boundary edges would leave the extra edge(s) with only the outward strip's
// half — one-sided AA (fill solid to the edge, Slug ramps both sides). The fan
// (ABG, BCG, CAG at centroid G) gives each original edge its own triangle so the
// inner ramp fires on all of them → two-sided AA matching Slug. Curve/internal
// edges are untouched. Runs per assemble (cheap, O(tris)); the cached _topo keeps
// the ORIGINAL tris so streaming refresh re-subdivides deterministically.
function subdivideBoundaryTris(coords, tris, edges) {
  if (!edges || !edges.length) return { coords, tris };
  const key = (p) => Math.round((p[0] - _kox) * _koScale) * 2097152 + Math.round((p[1] - _koy) * _koScale);   // numeric (must match the (x,y) form)
  const bset = new Set();
  for (const e of edges) { const a = key(e.p1), b = key(e.p2); bset.add(a + '|' + b); bset.add(b + '|' + a); }
  const coords2 = coords.slice();
  const tris2 = [];
  for (let t = 0; t < tris.length; t += 3) {
    const ia = tris[t], ib = tris[t + 1], ic = tris[t + 2];
    const a = coords[ia], b = coords[ib], c = coords[ic];
    const ka = key(a), kb = key(b), kc = key(c);
    let n = 0;
    if (bset.has(ka + '|' + kb)) n++;
    if (bset.has(kb + '|' + kc)) n++;
    if (bset.has(kc + '|' + ka)) n++;
    if (n >= 2) {
      const ig = coords2.length;
      coords2.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3]);
      tris2.push(ia, ib, ig, ib, ic, ig, ic, ia, ig);
    } else {
      tris2.push(ia, ib, ic);
    }
  }
  return { coords: coords2, tris: tris2 };
}
// Flat per-vertex sibling of subdivideBoundaryTris, for the PARTITION interior —
// which stores its plain STRAIGHT faces as a flat x,y,x,y,x,y,… array (6 floats/
// tri), NOT indexed coords+tris. The partition never runs assemble(), so it lost
// the boundary-tri split: a corner triangle carrying two straight boundary edges
// (e.g. either half of an axis-aligned rectangle's earcut) packs ONE inner-ramp
// line, leaving its second edge SOLID to the boundary — invisible on opaque fills
// (interior clamps) but a bright ~1px over-fill ring on TRANSLUCENT ones (HUD slot
// backgrounds). Splitting such a tri into a centroid fan (ABG, BCG, CAG) gives
// each original edge its own sub-tri so the inner ramp fires on all of them. Only
// STRAIGHT boundary edges count (the partition's `interior` holds no curve faces),
// so glyph bowls are untouched. Deterministic → no morph vertex-count churn.
export function subdivideBoundaryTriPoints(interior, edges) {
  if (!edges || !edges.length || !interior || interior.length < 6) return interior;
  const key = (x, y) => Math.round((x - _kox) * _koScale) * 2097152 + Math.round((y - _koy) * _koScale);
  const bset = new Set();
  for (const e of edges) { const a = key(e.p1[0], e.p1[1]), b = key(e.p2[0], e.p2[1]); bset.add(a + '|' + b); bset.add(b + '|' + a); }
  const out = [];
  for (let t = 0; t + 5 < interior.length; t += 6) {
    const ax = interior[t], ay = interior[t + 1], bx = interior[t + 2], by = interior[t + 3], cx = interior[t + 4], cy = interior[t + 5];
    const ka = key(ax, ay), kb = key(bx, by), kc = key(cx, cy);
    let n = 0;
    if (bset.has(ka + '|' + kb)) n++;
    if (bset.has(kb + '|' + kc)) n++;
    if (bset.has(kc + '|' + ka)) n++;
    if (n >= 2) {
      const gx = (ax + bx + cx) / 3, gy = (ay + by + cy) / 3;
      out.push(ax, ay, bx, by, gx, gy,  bx, by, cx, cy, gx, gy,  cx, cy, ax, ay, gx, gy);
    } else {
      out.push(ax, ay, bx, by, cx, cy);
    }
  }
  return out;
}
export function assemble(r, coords, tris, holeStarts, ramp) {
  const sub = subdivideBoundaryTris(coords, tris, r.edges);
  // Interior triangles that touch a boundary feature become ramped pieces (curveCov at arcs,
  // kind-0 line ramps at straight edges); the rest stay solid. Gated by `ramp` — STATIC
  // builds opt in (text quality); the streaming road build/refresh stays off (its per-frame
  // guard outcomes would churn vertex counts). curveTris ride the `quads` array.
  // ANALYTIC POLY-CLIP interior (opt-in, Phase 1 = straight glyphs): COARSE
  // triangles (no shatter/heal/tag), each carrying its local outline chain; the
  // kind-0 fragment clips it exactly (probes/_polyClip.mjs). Pure-straight glyphs
  // have no arcs so r.quads is empty — no crescent double-cover; curve
  // compositing is Phase 2.
  if (globalThis.__EDGE_TAP && r.edges && r.edges.length) globalThis.__EDGE_TAP.push(r.edges.map((e) => ({ p1: e.p1, p2: e.p2 })));
  // The proven-general path (boundary shatter + kind-10 ramps). The analytic
  // chain path below returns this whenever its validity precondition fails.
  const splitPath = () => {
    const split = splitInteriorByCurve(interiorFromTris(sub.coords, sub.tris), interiorEdgesFromTris(sub.coords, sub.tris, r.edges), r.chordArcs, r.vertexArcs, ramp, r.edges);
    const quads = split.curveTris.length ? r.quads.concat(split.curveTris) : r.quads;
    return {
      interior: split.solid,
      interiorEdges: split.solidEdges,
      interiorEdges2: split.solidEdges2,
      interiorEdges3: split.solidEdges3,
      quads, cubics: r.cubics, edges: r.edges, fallback: r.fallback,
      hasConcave: r.hasConcave,
      _topo: { tris, holeStarts, rimLens: rimLens(r.rims), turns: r.turns, ramped: !!ramp },
    };
  };
  // NOTE: the POLYCLIP analytic-interior route lived here and was DELETED
  // (2026-07-20). Measured across every flag combination it changed NOTHING on
  // glyphs — same vertex count, same AA — with PART_CHAIN either on or off, so it
  // was not merely preempted by the partition route; its branch was never reached
  // for that content. Its only measurable effect anywhere was making the icon
  // corpus slightly WORSE (2.74 -> 2.78 mean). The vertex reduction once credited
  // to it belongs to PART_CHAIN (5592 -> 3999, -28%, at better accuracy) and
  // already ships. The historic "1.109 mean / 2418 verts" figure is not
  // reproducible in this tree.
  // `hasConcave` (any concave curve → caller must use the CDT path) and the
  // cached `_topo` for fixed-topology streaming refresh both ride splitPath():
  // `turns` is the per-vertex rim turn-sign fingerprint (see buildRims) — the
  // refresh reuses `tris` only when it matches, so a curve flip OR a slot
  // teleport (which both alter the rim's convex/reflex structure) rebuilds.
  return splitPath();
}


// Self-overlapping outlines render fine in Slug's winding evaluation but break
// the LB partition when inner and outer contour chords cross: crossing
// chords are crossing CDT CONSTRAINTS (curve contact is irrelevant: measured 26%
// separation with full corruption). Same-contour pairs compare flattened polylines
// (deep-concave chord sag is benign); different-contour pairs trigger on chord
// crossing itself. Returns the union-resolved contours when the path boolean can
// resolve them, null (→ per-shape Slug fallback) when it can't. Callers run this
// AFTER circle/annulus extraction — thin rings legitimately have cross-contour sag.
export function resolveSelfOverlap(contours, fillRule) {
  // Rational arcs (ellipses/lenses/rings) legitimately produce chord-sag geometry the
  // crossing tests misread, and their overlap pathologies aren't the TT-quad abutment
  // class this exists for — skip them (their own SDF/annulus machinery applies).
  for (const c of contours) for (const sg of c) if (sg.type === SEG_RQUAD) return contours;
  const share = (p, q) => Math.abs(p[0] - q[0]) < 1e-12 && Math.abs(p[1] - q[1]) < 1e-12;
  // EXACT self-intersection detection — no flattening.
  //
  // This used to flatten every segment to K9=8 straight samples and run a strict
  // crossing test over the sub-segments. That is scale-bounded sampling standing
  // in for a geometric fact, and it failed both ways: it MISSES a crossing that
  // falls between samples on a curved segment, and a crossing landing exactly ON
  // a sample gives a zero determinant that the strict test reads as "no
  // crossing". The bowtie `M20 20 L108 108 L108 20 L20 108 Z` crosses at (64,64)
  // = t 4/8 on both diagonals, so it was reported non-self-intersecting, left
  // unresolved, and meshed from the raw outline — 8192 of 8320 pixels wrong.
  //
  // The path-boolean pipeline already carries an exact intersection kernel for
  // every type pair (line/quad/cubic/arc), which is what the union step itself
  // uses. Use it here too: one source of truth, exact at any scale.
  //
  // Callers reach this only after the share() guard drops segments meeting at a
  // shared endpoint, so ANY intersection that survives is a genuine self-
  // intersection — including an endpoint of one segment lying on another
  // (a T-junction), which the old strict test also missed.
  const segsAll9 = [];
  let ci9 = 0;
  for (const c of contours) { ci9++; for (const sg of c) {
    const pN = sg.type === SEG_LINE ? sg.p2 : sg.type === SEG_CUBIC ? sg.p4 : sg.p3;
    let x0 = Math.min(sg.p1[0], pN[0]), x1 = Math.max(sg.p1[0], pN[0]);
    let y0 = Math.min(sg.p1[1], pN[1]), y1 = Math.max(sg.p1[1], pN[1]);
    if (sg.type !== SEG_LINE) {
      for (const cp of [sg.p2, sg.p3]) if (cp) { x0 = Math.min(x0, cp[0]); x1 = Math.max(x1, cp[0]); y0 = Math.min(y0, cp[1]); y1 = Math.max(y1, cp[1]); }
    }
    segsAll9.push({ sg, ci: ci9, a: sg.p1, b: pN, x0, x1, y0, y1 });
  } }
  // Scale-relative tolerance for "this hit IS the shared endpoint".
  //
  // An ABSOLUTE 1e-7 was too tight: the solver returns a join hit within a few
  // 1e-7 of the vertex at tiger-scale coordinates (~690), so three of shape 11's
  // joins were read as self-crossings. A false crossing is not harmless — it
  // sends a healthy shape through unionPaths, which can return a degenerate
  // boundary (see the collapse guard below).
  //
  // Measured headroom on that shape: false hits sit 2.9e-7..6.6e-7 from the
  // vertex (~1.5e-9 relative), genuine crossings 1.5-1.8 UNITS (~4e-3 relative).
  // 1e-6 * diag lands three orders clear of both — the same scaling chained()
  // already uses further down, and for the same reason.
  let jx0 = Infinity, jy0 = Infinity, jx1 = -Infinity, jy1 = -Infinity;
  for (const S9 of segsAll9) {
    if (S9.x0 < jx0) jx0 = S9.x0; if (S9.x1 > jx1) jx1 = S9.x1;
    if (S9.y0 < jy0) jy0 = S9.y0; if (S9.y1 > jy1) jy1 = S9.y1;
  }
  const jointEps = 1e-6 * (Math.hypot(jx1 - jx0, jy1 - jy0) || 1);
  let crossing = false;
  // x-sweep: sorted by x0, the inner scan stops at the first j whose x0 exceeds
  // SI.x1 — pair enumeration drops from N²/2 to N·overlap (flat N² spends
  // whole seconds on organic many-hundred-segment shapes).
  segsAll9.sort((a9, b9) => a9.x0 - b9.x0);
  outer:
  for (let i = 0; i < segsAll9.length; i++) {
    const SI = segsAll9[i];
    for (let j = i + 1; j < segsAll9.length; j++) {
      const SJ = segsAll9[j];
      if (SJ.x0 > SI.x1) break;
      if (SI.y1 < SJ.y0 || SJ.y1 < SI.y0) continue;
      // Segments that MEET at a shared vertex are not thereby self-intersecting —
      // but they may still CROSS somewhere else, and skipping the pair outright
      // misses that. The S-cubic `M16 64 C16 16 112 112 112 64 Z` is exactly this:
      // its curve and its closing chord share BOTH endpoints and also cross at
      // (64,64), so the blanket skip declared it simple. It then kept ONE
      // interiorSign for a boundary whose fill side flips at the crossing, and the
      // chord rim over-filled the concave lobe — 1272 of 1621 px, max 1.00, at
      // every scale from 16 to 512.
      //
      // With exact intersections available, filter precisely: ignore hits that
      // land ON a shared endpoint, count everything else.
      const shared = [];
      if (share(SI.a, SJ.a)) shared.push(SI.a);
      if (share(SI.a, SJ.b)) shared.push(SI.a);
      if (share(SI.b, SJ.a)) shared.push(SI.b);
      if (share(SI.b, SJ.b)) shared.push(SI.b);
      let hits;
      try { hits = intersectSegments(SI.sg, SJ.sg); } catch { hits = null; }
      if (!hits || !hits.length) continue;
      for (const h of hits) {
        let atShared = false;
        for (const sp of shared)
          if (Math.abs(h.x - sp[0]) < jointEps && Math.abs(h.y - sp[1]) < jointEps) { atShared = true; break; }
        if (!atShared) { crossing = true; break outer; }
      }
    }
  }
  if (!crossing) return contours;
  let flat;
  try { flat = unionPaths([{ segs: contours.flat(), fillRule: fillRule || 'nonzero' }]); }
  catch { flat = null; }
  if (!flat || !flat.length) return null;
  // THE UNION MUST NOT LOSE THE SHAPE.
  //
  // unionPaths can return a degenerate boundary for a genuinely self-intersecting
  // input: Ghostscript_Tiger shape 11 — a 34-segment stripe enclosing 21896 em^2,
  // with two real self-crossings — comes back as TWO segments enclosing ZERO
  // area, under both fill rules. Handing that on is silent catastrophe: buildRims
  // gets 2 points, triangulateLayout returns 0 triangles, and the shape renders
  // as nothing at all (it was 12% of the tiger's black ink).
  //
  // A failed resolve is already an understood outcome here — `!flat.length`
  // returns null and the caller falls back to Slug, which is correct, just
  // slower. A collapsed resolve is the same failure and gets the same answer.
  // The test is for COLLAPSE, not for precision: a self-union legitimately
  // changes area (a bowtie's union differs from its signed area), so this only
  // fires when essentially nothing survives relative to the input's own extent.
  {
    // Compare the union's area against the INPUT's, both by the same
    // endpoint-shoelace so the metric cancels. An absolute floor does not work:
    // tiger shape 11 collapses to EXACTLY zero, but shape 20 collapses to 0.3 of
    // 2366 em^2 (0.013% survives) — a partial collapse that any fixed epsilon
    // scaled to the bbox waves through, and it is the same failure.
    //
    // 5% is deliberately far below anything legitimate. A self-union CAN shrink
    // the area honestly, because a signed traversal double-counts overlap: a path
    // doubled back on itself has |signed| = 2x its union, a tripled one 3x. So the
    // honest floor is ~1/3, and 5% only ever fires on a genuine collapse.
    const eo9 = (sg) => sg.type === SEG_LINE ? sg.p2 : sg.type === SEG_CUBIC ? sg.p4 : sg.p3;
    const shoe = (list) => { let A2 = 0;
      for (const sg of list) { const a2 = sg.p1, b2 = eo9(sg); A2 += a2[0] * b2[1] - b2[0] * a2[1]; }
      return Math.abs(A2) / 2; };
    const inA = shoe(contours.flat());
    if (inA > 0 && shoe(flat) < 0.05 * inA) return null;   // collapsed -> Slug
  }
  const out = [];
  let cur = [];
  const endOf = (sg) => sg.type === SEG_LINE ? sg.p2 : sg.type === SEG_CUBIC ? sg.p4 : sg.p3;
  // SPLITTING THE UNION OUTPUT NEEDS A GEOMETRIC TOLERANCE, not share()'s 1e-12.
  //
  // unionPaths concatenates its boundary cycles into one flat list and marks a
  // new cycle by DISCONTINUITY, so this split has to tell "same point" from "new
  // cycle". Consecutive segments WITHIN a cycle meet at points computed by
  // different routes — a y-monotone split parameter on one side, an intersection
  // solve on the other — so they agree only to solver precision. Measured on the
  // S-cubic: a genuine mid-cycle join was off by 2.2e-6, which 1e-12 read as a
  // break, cutting 2 real cycles into 3 contours (two of them open). A real cycle
  // break in the same shape is 85 UNITS, so there are ~7 orders of headroom;
  // scale the epsilon to the geometry rather than picking an absolute.
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const sg of flat) {
    for (const p of [sg.p1, endOf(sg)]) {
      if (p[0] < bx0) bx0 = p[0]; if (p[0] > bx1) bx1 = p[0];
      if (p[1] < by0) by0 = p[1]; if (p[1] > by1) by1 = p[1];
    }
  }
  const diag = Math.hypot(bx1 - bx0, by1 - by0) || 1;
  const eps = 1e-6 * diag;
  const chained = (p, q) => Math.abs(p[0] - q[0]) <= eps && Math.abs(p[1] - q[1]) <= eps;
  for (const sg of flat) {
    if (cur.length && !chained(endOf(cur[cur.length - 1]), sg.p1)) { out.push(cur); cur = []; }
    cur.push(sg);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function buildLoopBlinnMesh(contours, ramp = true, fillRule) {
  _healCand.length = 0;
  _setKeyOrigin(contours);
  const circ = circleFromContours(contours);
  if (circ) return { interior: new Float32Array(0), interiorEdges: null, quads: [], cubics: [], edges: [], fallback: [], circles: [circ], _topo: null };
  // Kappa-cubic / coarse-quad full ellipses → one elliptical-SDF disc (kind 7).
  // Same salient win as circles: no high-κ cubic crescent spikes at the tips.
  const ell = ellipseFromContours(contours);
  if (ell) return { interior: new Float32Array(0), interiorEdges: null, quads: [], cubics: [], edges: [], fallback: [], circles: [ell], _topo: null };
  const _ann = extractAnnuli(contours, undefined);
  if (_ann.annuli.length && !_ann.rest.length) return { interior: new Float32Array(0), interiorEdges: null, quads: [], cubics: [], edges: [], fallback: [], annuli: _ann.annuli, _topo: null };
  // The caller's fill rule decides how a self-crossing resolves — an evenodd
  // pentagram keeps its centre hole; hardcoding nonzero filled it solid
  // (diverging from Slug, whose walk honors the rule).
  contours = resolveSelfOverlap(contours, fillRule || 'nonzero');
  if (!contours) return null;   // crossing outline → the caller's Slug fallback
  const r = buildRims(contours, !!ramp);
  const { coords, holeStarts, spans } = layoutRims(r.rims);
  const tris = triangulateLayout(coords, spans);
  const mesh = assemble(r, coords, tris, holeStarts, ramp);
  // Snapshot whole-arc crescents BEFORE healing. healCracks splits hulls and
  // stamps `tc` on children; pack needs the pre-heal arcs for kind-12 bands.
  // Named bandArcs (not stripArcs): stripArcs enables CDT fat-ring mode.
  if (ramp) mesh.bandArcs = mesh.quads.filter((q) => !q.circle && !q.tc)
    .map((q) => ({ tri: q.tri, sign: q.sign, w: q.w, e1: q.e1, e2: q.e2 }));
  if (ramp) healCracks(mesh);                           // static: heal interior↔crescent T-junctions
  return mesh;
}

// Mutual T-junction healer across the interior mesh AND the crescent hulls: the
// in-split patcher only heals solid-vs-solid, but fan/corner cuts also land ON
// CHORD edges — T-junctions against crescent faces that rasterize as pixel cracks
// along the chord (faint interior lines / lone unfilled pixels on large glyphs,
// alignment-dependent). Splitting a crescent lerps its texcoords — affine over the
// control triangle, so coverage is bit-exact.
export function healCracks(mesh) {
  const interior = mesh.interior;
  if (!interior || !interior.length) return;
  const E = mesh.interiorEdges, E2 = mesh.interiorEdges2, E3 = mesh.interiorEdges3;
  const quads = mesh.quads || [];
  const QT_STD = [0, 0, 1, 0.5, 0, 1, 1, 1, 1];   // kind-5 integral frame (Ũ,Ṽ,R≡1)
  const vset = [];
  const seen = new Set();
  const addV = (x, y) => { const k = Math.round((x - _kox) * _koScale) * 262144 + Math.round((y - _koy) * _koScale);
    if (!seen.has(k)) { seen.add(k); vset.push([x, y]); } };
  // Only SUBDIVISION MIDPOINTS can be T-vertices (original CDT vertices are shared
  // exactly by construction) — the creators (processTri corner cuts, chordPiece
  // splits) register candidates, collapsing the healer's scan from every mesh
  // vertex (~24% of the whole build) to a few dozen points.
  //
  // Candidates must ALSO be vertices of the FINAL mesh: a crack is a neighbour's
  // VERTEX sitting mid-edge, so a clip point that no emitted face kept cannot be
  // one — splitting there heals nothing and cascades (a junction-heavy glyph's
  // intermediate clip points blew 972 faces up to 4968).
  if (_healCand.length) {
    const emitted9 = new Set();
    const ek9 = (x, y) => Math.round((x - _kox) * _koScale) * 262144 + Math.round((y - _koy) * _koScale);
    for (let i = 0; i < interior.length; i += 2) emitted9.add(ek9(interior[i], interior[i + 1]));
    for (const q of quads) { if (q.circle) continue; emitted9.add(ek9(q.tri[0], q.tri[1])); emitted9.add(ek9(q.tri[2], q.tri[3])); emitted9.add(ek9(q.tri[4], q.tri[5])); }
    for (const P9 of _healCand) { if (emitted9.has(ek9(P9[0], P9[1]))) addV(P9[0], P9[1]); }
  }
  else {
    for (let i = 0; i < interior.length; i += 2) addV(interior[i], interior[i + 1]);
    for (const q of quads) { if (q.circle) continue; addV(q.tri[0], q.tri[1]); addV(q.tri[2], q.tri[3]); addV(q.tri[4], q.tri[5]); }
  }
  // sorted by x: each face scans only its bbox's x-slice (binary-searched). splitPt was
  // ~30% of the whole glyph build as a full-vset scan; a spatial hash LOST to Map
  // overhead at glyph sizes — the sorted slice + bbox reject wins.
  vset.sort((A9, B9) => A9[0] - B9[0]);
  const splitPt = (A, B, C) => {
    // first vset vertex strictly inside an edge of (A,B,C); returns {ei, V} or null
    const bx0 = Math.min(A[0], B[0], C[0]) - 1e-4, bx1 = Math.max(A[0], B[0], C[0]) + 1e-4;
    const by0 = Math.min(A[1], B[1], C[1]) - 1e-4, by1 = Math.max(A[1], B[1], C[1]) + 1e-4;
    let lo9 = 0, hi9 = vset.length;
    while (lo9 < hi9) { const mid9 = (lo9 + hi9) >> 1; if (vset[mid9][0] < bx0) lo9 = mid9 + 1; else hi9 = mid9; }
    for (let vi9 = lo9; vi9 < vset.length; vi9++) {
      const V = vset[vi9];
      if (V[0] > bx1) break;
      if (V[1] < by0 || V[1] > by1) continue;
      for (let ei = 0; ei < 3; ei++) {
        const P0 = ei === 0 ? A : ei === 1 ? B : C;
        const P1 = ei === 0 ? B : ei === 1 ? C : A;
        const ex = P1[0] - P0[0], ey = P1[1] - P0[1];
        const L2 = ex * ex + ey * ey;
        if (L2 < 1e-12) continue;
        const rx = V[0] - P0[0], ry = V[1] - P0[1];
        const t = (rx * ex + ry * ey) / L2;
        if (t < 0.02 || t > 0.98) continue;
        const dx = rx - t * ex, dy = ry - t * ey;
        if (dx * dx + dy * dy > 1e-8) continue;
        return { ei, V };
      }
    }
    return null;
  };
  // 1) interior faces (parallel payload rows copied verbatim to both pieces)
  {
    // The analytic chain rows ride along too. They are PER-FACE constants (all
    // three verts hold the same points), so a split piece inherits them exactly —
    // but they must be carried, because this pass rebuilds mesh.interior from a
    // LIFO stack and so REORDERS the faces. Leaving them behind silently pairs
    // each face with another face's chain, which reads as solid over-fill.
    // Their stride is 4 floats/vert = 12/face, the same as e2/e3.
    const CH = [mesh.interiorChainA, mesh.interiorChainB, mesh.interiorChainC,
                mesh.interiorChainD, mesh.interiorChainE];
    const sIn = Array.from(interior);
    const work = [];
    for (let t = 0, e = 0, e2 = 0; t < sIn.length; t += 6, e += 9, e2 += 12) {
      work.push({ P: [[sIn[t], sIn[t + 1]], [sIn[t + 2], sIn[t + 3]], [sIn[t + 4], sIn[t + 5]]],
                  e: E ? Array.from(E.slice(e, e + 9)) : null,
                  e2: E2 ? Array.from(E2.slice(e2, e2 + 12)) : null,
                  e3: E3 ? Array.from(E3.slice(e2, e2 + 12)) : null,
                  ch: CH.map((c) => (c ? Array.from(c.slice(e2, e2 + 12)) : null)) });
    }
    const out = [];
    let guard = work.length * 8;
    while (work.length) {
      const w = work.pop();
      const sp = guard-- > 0 ? splitPt(w.P[0], w.P[1], w.P[2]) : null;
      if (!sp) { out.push(w); continue; }
      const { ei, V } = sp;
      const Pa = w.P[ei], Pb = w.P[(ei + 1) % 3], Pc = w.P[(ei + 2) % 3];
      work.push({ P: [Pa, V, Pc], e: w.e, e2: w.e2, e3: w.e3, ch: w.ch });
      work.push({ P: [V, Pb, Pc], e: w.e, e2: w.e2, e3: w.e3, ch: w.ch });
    }
    const nI = new Float32Array(out.length * 6);
    const nE = E ? new Float32Array(out.length * 9) : null;
    const nE2 = E2 ? new Float32Array(out.length * 12) : null;
    const nE3 = E3 ? new Float32Array(out.length * 12) : null;
    const nCH = CH.map((c) => (c ? new Float32Array(out.length * 12) : null));
    for (let i = 0; i < out.length; i++) {
      const w = out[i];
      nI.set([w.P[0][0], w.P[0][1], w.P[1][0], w.P[1][1], w.P[2][0], w.P[2][1]], i * 6);
      if (nE && w.e) nE.set(w.e, i * 9);
      if (nE2 && w.e2) nE2.set(w.e2, i * 12);
      if (nE3 && w.e3) nE3.set(w.e3, i * 12);
      for (let k = 0; k < 5; k++) if (nCH[k] && w.ch[k]) nCH[k].set(w.ch[k], i * 12);
    }
    mesh.interior = nI;
    if (nE) mesh.interiorEdges = nE;
    if (nE2) mesh.interiorEdges2 = nE2;
    if (nE3) mesh.interiorEdges3 = nE3;
    if (nCH[0]) mesh.interiorChainA = nCH[0];
    if (nCH[1]) mesh.interiorChainB = nCH[1];
    if (nCH[2]) mesh.interiorChainC = nCH[2];
    if (nCH[3]) mesh.interiorChainD = nCH[3];
    if (nCH[4]) mesh.interiorChainE = nCH[4];
  }
  // 2) crescent hulls (integral + rquad + adopted; circles excluded — SDF kind ignores mesh edges)
  {
    const outQ = [];
    const work = quads.slice();
    let guard = work.length * 8;
    while (work.length) {
      const q = work.pop();
      if (q.circle) { outQ.push(q); continue; }
      const A = [q.tri[0], q.tri[1]], B = [q.tri[2], q.tri[3]], C = [q.tri[4], q.tri[5]];
      const sp = guard-- > 0 ? splitPt(A, B, C) : null;
      if (!sp) { outQ.push(q); continue; }
      const { ei, V } = sp;
      const tc = q.tc ? Array.from(q.tc) : (!q.w || q.w === 1 ? QT_STD.slice() : [0, 0, 1, 0.5 * (1 / q.w), 0, 1 / q.w, 1, 1, 1]);
      const P = [A, B, C];
      const Pa = P[ei], Pb = P[(ei + 1) % 3], Pc = P[(ei + 2) % 3];
      const ta = tc.slice(ei * 3, ei * 3 + 3), tb = tc.slice(((ei + 1) % 3) * 3, ((ei + 1) % 3) * 3 + 3), tcC = tc.slice(((ei + 2) % 3) * 3, ((ei + 2) % 3) * 3 + 3);
      const exq = Pb[0] - Pa[0], eyq = Pb[1] - Pa[1];
      const tq = Math.abs(exq) > Math.abs(eyq) ? (V[0] - Pa[0]) / exq : (V[1] - Pa[1]) / eyq;
      const tv = [ta[0] + (tb[0] - ta[0]) * tq, ta[1] + (tb[1] - ta[1]) * tq, ta[2] + (tb[2] - ta[2]) * tq];
      const mk = (p0, t0, p1, t1, p2, t2) => ({ ...q, tri: new Float32Array([p0[0], p0[1], p1[0], p1[1], p2[0], p2[1]]), tc: new Float32Array([...t0, ...t1, ...t2]) });
      work.push(mk(Pa, ta, V, tv, Pc, tcC));
      work.push(mk(V, tv, Pb, tb, Pc, tcC));
    }
    mesh.quads = outQ;
  }
}
