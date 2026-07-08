// lbFastMesh.js — the additive fast-path builder: contour rims (on-curve
// points + crescent hulls), corner caps, earcut of the rim polygon, and the
// assemble step that turns rim triangles into the interior/quads/cubics mesh,
// plus crack healing and the self-overlap union pre-pass. This is the cheap
// convex/simple-shape route; the exact exact partition and the CDT
// orchestrator live in loopBlinn.js and call into these pieces.
import { earcut } from './lbEarcut.js';
import { bezoutCubicImplicit, cubicKLMN, cubicSignKLMN, cubicInflections, cubicLoop, splitCubic, splitCubicMulti, cubicHull, cubicSign } from './lbCubicMath.js';
import { _kox, _koy, _koScale, _setKeyOrigin, circleFromContours, extractAnnuli, emitCircleSector, pointInPoly, chordRing, calibrateInterior, sideInFill, segTangents, segPt, edgeEndMeta } from './lbContour.js';
import { splitInteriorByCurve, _healCand } from './lbInteriorSplit.js';
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_RQUAD } from '../primitives/seg.js';
import { unionPaths } from '../svg/pathBoolean/union.js';

// Cover-tightening subdivision per inflection-free cubic piece. 1 = the bare
// control hull. Values >1 shrink the implicit-covered slivers toward the curve
// (less fragment overdraw) BUT add a crescent boundary at each split point —
// under the single-pass OVER route those adjacent AA ramps conflate into a
// faint seam. Must stay 1 so the route stays seam-clean; the convex control
// hull is already tight for the inflection-split single-bulge pieces.
const CUBIC_COVER_SUBDIV = 1;

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
export function buildRims(contours) {
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
    const interiorSign = calibrateInterior(segs, inFill);
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
          quads.push({ tri: new Float32Array([s.p1[0], s.p1[1], s.p2[0], s.p2[1], s.p3[0], s.p3[1]]), sign, w });
          addChordArc(s.p1, s.p2, s.p3, sign, w); }   // interior triangles on this chord ramp at the arc
        continue;
      }
      // cubic
      const P0 = [s.p1, s.p2, s.p3, s.p4];
      if (cubicLoop(P0)) { rim.push(s.p1); fallback.push(s); continue; }   // loop/cusp → Slug
      // Split at inflections (each piece single-bulge), then subdivide each
      // piece further: a sub-piece's de Casteljau control hull hugs the curve
      // tighter than the parent's, so the implicit-covered region shrinks to
      // thin slivers near the curve (the rim threads the split points, so the
      // inner crescent fills flat). Same exact implicit per sub-piece → less
      // fragment overdraw on bulged curves.
      const infPieces = splitCubicMulti(P0, cubicInflections(P0));
      const pieces = [];
      for (const ip of infPieces) {
        let cur = ip;
        for (let k = 0; k < CUBIC_COVER_SUBDIV - 1; k++) {
          const [l, r] = splitCubic(cur, 1 / (CUBIC_COVER_SUBDIV - k));
          pieces.push(l); cur = r;
        }
        pieces.push(cur);
      }
      rim.push(s.p1);
      for (const P of pieces) {
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
          // `cp` (the 4 sub-piece control points) is retained only for the GPU
          // morph builder, which recomputes klmn per-frame from lerped control
          // points; the static pack path ignores it.
          cubics.push({ hull: new Float32Array(verts), klmn: new Float32Array(tc), sign, cp: P });
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


// CONVEX-corner caps (kind 8): at a junction whose tangents turn convexly, the exterior
// wedge beyond BOTH tangent spans is owned by nobody — crescents are span-clipped, strips
// span their edge, interior is inside — so boundary pixels there render hard while Slug
// ramps them (the '?' hook joints, glyph terminals, the N's acute notch tip). One small
// scale-blind quad per junction carries both tangent half-planes; the fragment paints the
// two-line box coverage on {fA>0 ∧ fB>0} and discards elsewhere, completing the pixel
// partition. REFLEX junctions need no cap: both neighbours paint the wedge and direct-OVER
// of their coverages, 1−(1−a)(1−b), IS the union truth.
export function buildCornerCaps2(contours) {
  const caps = [];
  const rings = contours.map(chordRing);
  const inFill = p => { let c = 0; for (const r of rings) if (pointInPoly(p[0], p[1], r)) c++; return (c & 1) === 1; };
  for (const segs of contours) {
    const n = segs.length;
    if (n < 2) continue;
    const interiorSign = calibrateInterior(segs, inFill);
    const tg = segs.map(segTangents);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (segs[i].type === SEG_LINE || segs[j].type === SEG_LINE) continue;   // kind-10 owns line corners
      const tA = tg[i].t1, tB = tg[j].t0, p = tg[i].end;
      const LA = Math.hypot(tA[0], tA[1]) || 1, LBt = Math.hypot(tB[0], tB[1]) || 1;
      const ax = tA[0] / LA, ay = tA[1] / LA, bx = tB[0] / LBt, by = tB[1] / LBt;
      if ((ax * by - ay * bx) * interiorSign <= 0.02) continue;   // reflex / truly-straight (shallow convex joints still gap without a cap)
      const s = interiorSign > 0 ? 1 : -1;
      const nA = [ay * s, -ax * s], nB = [by * s, -bx * s];       // outward tangent normals
      // Curvature fit per side: within the cap's ~2px a high-curvature arc peels off its
      // tangent, so a tangent-line f misreads arc-outside points as "inside" and the cap
      // discards its own turf. Fit f_arc ≈ f_tan − (κ/2)·t², κ = 2·dev/ts² from a sample
      // 10% along the segment (empirical — no orientation gymnastics; lines give κ=0).
      const sampA = segPt(segs[i], 0.9), sampB = segPt(segs[j], 0.1);
      const devA = nA[0] * (sampA[0] - p[0]) + nA[1] * (sampA[1] - p[1]);
      const tsA = -ax * (sampA[0] - p[0]) - ay * (sampA[1] - p[1]);
      const kA = Math.abs(tsA) > 1e-9 ? 2 * devA / (tsA * tsA) : 0;
      const devB = nB[0] * (sampB[0] - p[0]) + nB[1] * (sampB[1] - p[1]);
      const tsB = bx * (sampB[0] - p[0]) + by * (sampB[1] - p[1]);
      const kB = Math.abs(tsB) > 1e-9 ? 2 * devB / (tsB * tsB) : 0;
      caps.push({ p, nA, cA: nA[0] * p[0] + nA[1] * p[1], nB, cB: nB[0] * p[0] + nB[1] * p[1], kA, kB });
    }
  }
  return caps;
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
export function assemble(r, coords, tris, holeStarts, ramp) {
  const sub = subdivideBoundaryTris(coords, tris, r.edges);
  // Interior triangles that touch a boundary feature become ramped pieces (curveCov at arcs,
  // kind-0 line ramps at straight edges); the rest stay solid. Gated by `ramp` — STATIC
  // builds opt in (text quality); the streaming road build/refresh stays off (its per-frame
  // guard outcomes would churn vertex counts). curveTris ride the `quads` array.
  const split = splitInteriorByCurve(interiorFromTris(sub.coords, sub.tris), interiorEdgesFromTris(sub.coords, sub.tris, r.edges), r.chordArcs, r.vertexArcs, ramp, r.edges);
  const quads = split.curveTris.length ? r.quads.concat(split.curveTris) : r.quads;
  return {
    interior: split.solid,
    interiorEdges: split.solidEdges,
    interiorEdges2: split.solidEdges2,
    interiorEdges3: split.solidEdges3,
    quads, cubics: r.cubics, edges: r.edges, fallback: r.fallback,
    hasConcave: r.hasConcave,   // any concave curve → caller must use the CDT path

    // Cached triangulation topology for fixed-topology streaming (refresh).
    // `turns` is the per-vertex rim turn-sign fingerprint (see buildRims) — the
    // refresh reuses `tris` only when it matches, so a curve flip OR a slot
    // teleport (which both alter the rim's convex/reflex structure) rebuilds.
    // `ramped` keeps refresh output consistent with how the mesh was built.
    _topo: { tris, holeStarts, rimLens: rimLens(r.rims), turns: r.turns, ramped: !!ramp },
  };
}


// SELF-OVERLAPPING OUTLINES (Museo 300 'a': the counter's chords CROSS the outer
// contour) render fine in Slug (pure winding) but shred the LB partition — crossing
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
  const crossQ = (p, q, a, b) => {
    const d1 = (q[0] - p[0]) * (a[1] - p[1]) - (q[1] - p[1]) * (a[0] - p[0]);
    const d2 = (q[0] - p[0]) * (b[1] - p[1]) - (q[1] - p[1]) * (b[0] - p[0]);
    const d3 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const d4 = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  const K9 = 8;
  const flat9 = (sg) => {
    const pts9 = [];
    for (let t = 0; t <= K9; t++) {
      const tt = t / K9, u = 1 - tt;
      if (sg.type === SEG_LINE) pts9.push([sg.p1[0] + (sg.p2[0] - sg.p1[0]) * tt, sg.p1[1] + (sg.p2[1] - sg.p1[1]) * tt]);
      else if (sg.type === SEG_CUBIC) pts9.push([
        u * u * u * sg.p1[0] + 3 * u * u * tt * sg.p2[0] + 3 * u * tt * tt * sg.p3[0] + tt * tt * tt * sg.p4[0],
        u * u * u * sg.p1[1] + 3 * u * u * tt * sg.p2[1] + 3 * u * tt * tt * sg.p3[1] + tt * tt * tt * sg.p4[1]]);
      else {
        const w9 = sg.type === SEG_RQUAD ? sg.w : 1;
        const a9 = u * u, b9 = 2 * w9 * u * tt, c9 = tt * tt, den9 = a9 + b9 + c9;
        pts9.push([(a9 * sg.p1[0] + b9 * sg.p2[0] + c9 * sg.p3[0]) / den9, (a9 * sg.p1[1] + b9 * sg.p2[1] + c9 * sg.p3[1]) / den9]);
      }
    }
    return pts9;
  };
  const segsAll9 = [];
  let ci9 = 0;
  for (const c of contours) { ci9++; for (const sg of c) {
    const pN = sg.type === SEG_LINE ? sg.p2 : sg.type === SEG_CUBIC ? sg.p4 : sg.p3;
    let x0 = Math.min(sg.p1[0], pN[0]), x1 = Math.max(sg.p1[0], pN[0]);
    let y0 = Math.min(sg.p1[1], pN[1]), y1 = Math.max(sg.p1[1], pN[1]);
    if (sg.type !== SEG_LINE) {
      for (const cp of [sg.p2, sg.p3]) if (cp) { x0 = Math.min(x0, cp[0]); x1 = Math.max(x1, cp[0]); y0 = Math.min(y0, cp[1]); y1 = Math.max(y1, cp[1]); }
    }
    segsAll9.push({ sg, ci: ci9, a: sg.p1, b: pN, x0, x1, y0, y1, poly: null });
  } }
  let crossing = false;
  // x-sweep: sorted by x0, the inner scan stops at the first j whose x0 exceeds
  // SI.x1 — pair enumeration drops from N²/2 to N·overlap (a tumbleweed-class
  // shape at crash-morph build time spent ~1s here as flat N²).
  segsAll9.sort((a9, b9) => a9.x0 - b9.x0);
  outer:
  for (let i = 0; i < segsAll9.length; i++) {
    const SI = segsAll9[i];
    for (let j = i + 1; j < segsAll9.length; j++) {
      const SJ = segsAll9[j];
      if (SJ.x0 > SI.x1) break;
      if (SI.y1 < SJ.y0 || SJ.y1 < SI.y0) continue;
      if (share(SI.a, SJ.a) || share(SI.a, SJ.b) || share(SI.b, SJ.a) || share(SI.b, SJ.b)) continue;
      if (SI.ci !== SJ.ci && crossQ(SI.a, SI.b, SJ.a, SJ.b)) { crossing = true; break outer; }
      if (!SI.poly) SI.poly = flat9(SI.sg);
      if (!SJ.poly) SJ.poly = flat9(SJ.sg);
      for (let u9 = 1; u9 < SI.poly.length; u9++) for (let v9 = 1; v9 < SJ.poly.length; v9++)
        if (crossQ(SI.poly[u9 - 1], SI.poly[u9], SJ.poly[v9 - 1], SJ.poly[v9])) { crossing = true; break outer; }
    }
  }
  if (!crossing) return contours;
  let flat;
  try { flat = unionPaths([{ segs: contours.flat(), fillRule: fillRule || 'nonzero' }]); }
  catch { flat = null; }
  if (!flat || !flat.length) return null;
  const out = [];
  let cur = [];
  const endOf = (sg) => sg.type === SEG_LINE ? sg.p2 : sg.type === SEG_CUBIC ? sg.p4 : sg.p3;
  for (const sg of flat) {
    if (cur.length && !share(endOf(cur[cur.length - 1]), sg.p1)) { out.push(cur); cur = []; }
    cur.push(sg);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function buildLoopBlinnMesh(contours, ramp) {
  _healCand.length = 0;
  _setKeyOrigin(contours);
  const circ = circleFromContours(contours);
  if (circ) return { interior: new Float32Array(0), interiorEdges: null, quads: [], cubics: [], edges: [], fallback: [], circles: [circ], _topo: null };
  const _ann = extractAnnuli(contours, undefined);
  if (_ann.annuli.length && !_ann.rest.length) return { interior: new Float32Array(0), interiorEdges: null, quads: [], cubics: [], edges: [], fallback: [], annuli: _ann.annuli, _topo: null };
  contours = resolveSelfOverlap(contours, 'nonzero');
  if (!contours) return null;   // crossing outline → the caller's Slug fallback
  const r = buildRims(contours);
  const { coords, holeStarts } = flattenRims(r.rims);
  const tris = earcut(coords, holeStarts.length ? holeStarts : null);
  const mesh = assemble(r, coords, tris, holeStarts, ramp);
  mesh.caps = ramp ? buildCornerCaps2(contours) : [];   // convex-corner wedge caps (static only)
  mesh.curveStrips = !!ramp;                            // thin-crescent exterior AA strips (static only)
  if (ramp) healCracks(mesh);                           // static: heal interior↔crescent T-junctions
  return mesh;
}

// PROPER Loop-Blinn fill (p1000-loop §3.1, Fig 3/7) — the robust triangulation
// the earcut+threading fast path can't do: triangulate ALL control points
// (on-curve + off-curve) with the contour edges AND per-curve control triangles
// preserved as constraints, remove triangles whose centroid is outside the fill
// (holes fall out — no coverage buffer, no hole tessellation), then classify the
// survivors into solid interior + curve triangles (convex keep f<0 / concave keep
// f>0 via sign). Because each curve triangle is CONSTRAINED, the interior abuts
// its control legs, not the chord — so there's no over-cover to subtract. Handles

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
  const QT_STD = [0, 0, 0, 0.5, 0, 0, 1, 1, 0];
  const vset = [];
  const seen = new Set();
  const addV = (x, y) => { const k = Math.round((x - _kox) * _koScale) * 262144 + Math.round((y - _koy) * _koScale);
    if (!seen.has(k)) { seen.add(k); vset.push([x, y]); } };
  // Only SUBDIVISION MIDPOINTS can be T-vertices (original CDT vertices are shared
  // exactly by construction) — the creators (processTri corner cuts, chordPiece
  // splits) register candidates, collapsing the healer's scan from every mesh
  // vertex (~24% of the whole build) to a few dozen points.
  if (_healCand.length) { for (const P9 of _healCand) addV(P9[0], P9[1]); }
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
    const sIn = Array.from(interior);
    const work = [];
    for (let t = 0, e = 0, e2 = 0; t < sIn.length; t += 6, e += 9, e2 += 12) {
      work.push({ P: [[sIn[t], sIn[t + 1]], [sIn[t + 2], sIn[t + 3]], [sIn[t + 4], sIn[t + 5]]],
                  e: E ? Array.from(E.slice(e, e + 9)) : null,
                  e2: E2 ? Array.from(E2.slice(e2, e2 + 12)) : null,
                  e3: E3 ? Array.from(E3.slice(e2, e2 + 12)) : null });
    }
    const out = [];
    let guard = work.length * 8;
    while (work.length) {
      const w = work.pop();
      const sp = guard-- > 0 ? splitPt(w.P[0], w.P[1], w.P[2]) : null;
      if (!sp) { out.push(w); continue; }
      const { ei, V } = sp;
      const Pa = w.P[ei], Pb = w.P[(ei + 1) % 3], Pc = w.P[(ei + 2) % 3];
      work.push({ P: [Pa, V, Pc], e: w.e, e2: w.e2, e3: w.e3 });
      work.push({ P: [V, Pb, Pc], e: w.e, e2: w.e2, e3: w.e3 });
    }
    const nI = new Float32Array(out.length * 6);
    const nE = E ? new Float32Array(out.length * 9) : null;
    const nE2 = E2 ? new Float32Array(out.length * 12) : null;
    const nE3 = E3 ? new Float32Array(out.length * 12) : null;
    for (let i = 0; i < out.length; i++) {
      const w = out[i];
      nI.set([w.P[0][0], w.P[0][1], w.P[1][0], w.P[1][1], w.P[2][0], w.P[2][1]], i * 6);
      if (nE && w.e) nE.set(w.e, i * 9);
      if (nE2 && w.e2) nE2.set(w.e2, i * 12);
      if (nE3 && w.e3) nE3.set(w.e3, i * 12);
    }
    mesh.interior = nI;
    if (nE) mesh.interiorEdges = nE;
    if (nE2) mesh.interiorEdges2 = nE2;
    if (nE3) mesh.interiorEdges3 = nE3;
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
