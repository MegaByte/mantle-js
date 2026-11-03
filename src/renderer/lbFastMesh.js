// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbFastMesh.js — the additive fast-path builder: contour rims (on-curve
// points + crescent hulls), earcut of the rim polygon, and the
// assemble step that turns rim triangles into the interior/quads/cubics mesh,
// plus crack healing and the self-overlap union pre-pass. This is the cheap
// convex/simple-shape route; the exact exact partition and the CDT
// orchestrator live in loopBlinn.js and call into these pieces.
import { earcut } from '../geom/lbEarcut.js';
import { solveCubic } from '../svg/pathBoolean/polyRoots.js';
import { orient2d as orient2dP, incircle as incircleP } from '../geom/predicates.js';
import {
  bezoutUnfaithful,
  bezoutCubicImplicit,
  cubicKLMN,
  cubicSignKLMN,
  cubicInflections,
  cubicLoop,
  cubicLoopCuts,
  splitCubic,
  splitCubicMulti,
  cubicHull,
  cubicSign,
  cubicDegreeReduce,
  cubicChordStrip,
} from '../geom/lbCubicMath.js';
import { circleFromContours, ellipseFromContours } from '../geom/shapeRecognize.js';
import {
  _kox,
  _koy,
  _koScale,
  _setKeyOrigin,
  emSpan,
  extractAnnuli,
  emitCircleSector,
  sectorInsideFill,
  pointInPoly,
  chordRing,
  calibrateInterior,
  verifyInteriorSign,
  sideInFill,
  segTangents,
  segPt,
  edgeEndMeta,
} from '../geom/lbContour.js';
import { splitInteriorByCurve, _healCand, tjUlp } from './lbInteriorSplit.js';
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_RQUAD } from '../primitives/seg.js';
import { unionPaths } from '../svg/pathBoolean/union.js';
import { intersectSegments } from '../svg/pathBoolean/intersect/index.js';
import { mantleDebugHook } from '../core/diagnostics.js';

// Cover-tightening subdivision per inflection-free cubic piece. 1 = the bare
// control hull. Values >1 shrink the implicit-covered slivers toward the curve
// (less fragment overdraw) BUT add a crescent boundary at each split point —
// under the single-pass OVER route those adjacent AA ramps conflate into a
// faint seam. Must stay 1 so the route stays seam-clean; the convex control
// hull is already tight for the inflection-split single-bulge pieces.
// Max ADAPTIVE splits per inflection-free cubic piece (2^depth sub-pieces).
const CUBIC_COVER_MAX_DEPTH = 3;

const CUBIC_COVER_FLATNESS = 0.08;
// A cubic cover hull is NOT dilated to reach the arc's AA band: any centroid-dilation
// factor is RELATIVE while the AA band is an absolute ~1px, so it starves as the shape
// shrinks on screen. Static meshes instead carry a cubic exterior RING (planned in
// lbPack, extruded 1.5px in the vertex shader with klm following the exact affine
// gradient), which spans the band at any scale. Morph meshes have no rings and keep the
// undilated hull + a per-fragment end-tangent clip so neighbors tile.
const _unit = (x, y) => {
  const L = Math.hypot(x, y);
  return L > 0 ? [x / L, y / L] : null;
};

// PREFER BEZOUT (opt-in): use the exact Bezout implicit over klmn for cubic crescents.
//
// OFF by default: whether it pays depends on crescent SIZE, which varies by asset. Threaded
// through the build input because the build runs in a worker, where a main-thread flag would
// never arrive.
let _preferBezout = false;
export function setPreferBezout(v) {
  _preferBezout = !!v;
}
export function getPreferBezout() {
  return _preferBezout;
}

/// A Bezout crescent's keep half-plane: [nx, ny, c], painting only where n.p <= c. The same bound as
/// lbPartition's bezoutKeepHalf9 (whose comment has the measurements): the chord's normal and the
/// arc's exact support either side of the chord's line, keeping the ink side and the arc's own
/// excursion. `concave` says the ink is on the side the control points are.
function bezoutKeepHalf(P, concave) {
  const st = cubicChordStrip(P);
  if (!st) return null;
  const nx = st[0],
    ny = st[1],
    lo = st[2],
    hi = st[3],
    c0 = st[4];
  const bulgeUp = hi - c0 >= c0 - lo;
  const inkUp = concave ? bulgeUp : !bulgeUp;
  return inkUp ? [-nx, -ny, -lo] : [nx, ny, hi];
}

/// The correct build's cubic pieces. The fast builder halves every inflection-free cubic until
/// its control polygon is within 8% of its chord (subdivideFlat, up to eight pieces). That is a proxy for
/// the real condition, and a costly one for antialiasing: a flat piece's hull hugs its arc, so the exterior
/// ring extruded from the hull (a quarter pixel past it) reaches barely past the arc and the pixels just
/// outside it go unpainted, and the chain the interior faces carry grows too long for the kernel's
/// five-point window. The correct build splits a piece only for what its crescent actually needs:
///
///   - a klm crescent (f = k^3 - lm) is exact where no OTHER part of the algebraic curve enters its hull.
///     f vanishes on the whole curve, the piece and its extension to every real t, so the hull is right
///     exactly when the extension stays out of it. B(0) and B(1) are hull vertices and the curve leaves
///     the hull there, so the extension can only come in across a hull edge: each edge's line meets the
///     curve where a cubic in t vanishes, and a root outside [0, 1] whose point lies on the edge is the
///     extension coming in (extensionEntersHull). Halve until none does.
///   - a Bezout crescent ramps on |f| / |grad f|, which is a distance only where the resultant's nearest
///     zero is the arc: the partition's faithful split (lbPartition, `unfaithful9`: 5% of the chord,
///     two passes, a parameter floor of 0.08), plus the same extension test.
const CUBIC_BRANCH_MAX_DEPTH = 8;
function extensionEntersHull(P) {
  const H = cubicHull(P);
  const pts = H.map((i) => P[i]);
  const c3 = [
    P[3][0] - P[0][0] + 3 * (P[1][0] - P[2][0]),
    P[3][1] - P[0][1] + 3 * (P[1][1] - P[2][1]),
  ];
  const c2 = [3 * (P[0][0] - 2 * P[1][0] + P[2][0]), 3 * (P[0][1] - 2 * P[1][1] + P[2][1])];
  const c1 = [3 * (P[1][0] - P[0][0]), 3 * (P[1][1] - P[0][1])];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i],
      b = pts[(i + 1) % pts.length],
      ex = b[0] - a[0],
      ey = b[1] - a[1],
      L2 = ex * ex + ey * ey;
    if (!(L2 > 0)) continue;
    const nx = -ey,
      ny = ex;
    const A = nx * c3[0] + ny * c3[1],
      B = nx * c2[0] + ny * c2[1],
      C = nx * c1[0] + ny * c1[1];
    const D = nx * (P[0][0] - a[0]) + ny * (P[0][1] - a[1]);
    for (const t of solveCubic(A, B, C, D)) {
      // A root AT an end is the piece itself meeting its own hull vertex; t is a parameter, so the
      // margin is relative by construction.
      if (!(t < -1e-6 || t > 1 + 1e-6)) continue;

      const u = 1 - t,
        k0 = u * u * u,
        k1 = 3 * u * u * t,
        k2 = 3 * u * t * t,
        k3 = t * t * t;
      const px = k0 * P[0][0] + k1 * P[1][0] + k2 * P[2][0] + k3 * P[3][0],
        py = k0 * P[0][1] + k1 * P[1][1] + k2 * P[2][1] + k3 * P[3][1];
      const along = (px - a[0]) * ex + (py - a[1]) * ey;
      if (along > 1e-6 * L2 && along < L2 * (1 - 1e-6)) return true;
    }
  }
  return false;
}
/// Split an inflection-free piece as its crescent needs (see above). `span` is the piece's share of the
/// parameter range it was cut from, for the faithful split's floor.
function splitCubicForCrescent(P, out, klm, depth = 0, span = 1) {
  const need =
    depth < CUBIC_BRANCH_MAX_DEPTH &&
    ((!klm && depth < 2 && span > 0.08 && bezoutUnfaithful(P)) || extensionEntersHull(P));
  if (!need) {
    out.push(P);
    return;
  }
  const [l, r] = splitCubic(P, 0.5);
  splitCubicForCrescent(l, out, klm && !!cubicKLMN(l), depth + 1, span / 2);
  splitCubicForCrescent(r, out, klm && !!cubicKLMN(r), depth + 1, span / 2);
}

/// Recursively halve an inflection-free cubic piece until its control polygon is flat
/// enough that its cover hull holds a single implicit branch. Shallow cubics pass
/// on the first test and emit one piece.
function subdivideFlat(P, depth, out) {
  const ax = P[3][0] - P[0][0],
    ay = P[3][1] - P[0][1];
  const L = Math.hypot(ax, ay);
  if (!(L > 0)) {
    out.push(P);
    return;
  }
  // perpendicular deviation of the two control points from the chord
  const d1 = Math.abs((P[1][0] - P[0][0]) * ay - (P[1][1] - P[0][1]) * ax) / L;
  const d2 = Math.abs((P[2][0] - P[0][0]) * ay - (P[2][1] - P[0][1]) * ax) / L;
  // NOTE: do NOT also split on degeneracy (klmn === null ⇒ kind-4 Bezout). d1≈0 is a
  // Projective invariant: halving a degenerate piece yields two degenerate halves, so the
  // recursion runs to the cap without ever clearing hasBezout.
  const fat = Math.max(d1, d2) > CUBIC_COVER_FLATNESS * L;
  if (depth >= CUBIC_COVER_MAX_DEPTH || !fat) {
    out.push(P);
    return;
  }
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
    const nx8 = rows8[o8],
      ny8 = rows8[o8 + 1],
      c8 = rows8[o8 + 2];
    if (nx8 === 0 && ny8 === 0) continue;
    const b8 = i8 * 6;
    const cx8 = (interior[b8] + interior[b8 + 2] + interior[b8 + 4]) / 3;
    const cy8 = (interior[b8 + 1] + interior[b8 + 3] + interior[b8 + 5]) / 3;
    if (c8 - nx8 * cx8 - ny8 * cy8 < 0)
      for (let k8 = 0; k8 < 9; k8++) rows8[o8 + k8] = -rows8[o8 + k8];
  }
  return rows8;
}

/*
* Would the fast path accept these ALREADY-RESOLVED contours? Returns 'accept', 'cubic' (accepts,
 * but a real cubic renders better on the CDT — see contoursHaveCubic in lbBuildCore), 'concave'
 * (a curve bulges into the fill, so the earcut-rim mesh mis-threads it) or 'loop' (cusp → Slug).
 *
 * MIRRORS buildRims' four decline sites, in order, against the same interiorSign calibration.
 * Keep them adjacent and change them together; lbFastPathDeclineSmoke asserts they agree on every
 * shape in the corpus.
 *

 */
export function scanConcavity(contours, isStatic) {
  const rings = contours.map(chordRing);
  const inFill = (p) => {
    let c = 0;
    for (const r of rings) if (pointInPoly(p[0], p[1], r)) c++;
    return (c & 1) === 1;
  };
  let realCubic = false;
  for (const segs of contours) {
    const interiorSign = verifyInteriorSign(segs, inFill, calibrateInterior(segs, inFill));
    for (const s of segs) {
      if (s.type === SEG_LINE) continue;
      if (s.type === SEG_QUAD || s.type === SEG_RQUAD) {
        if (sideInFill(s.p1, s.p3, s.p2, interiorSign)) return 'concave';
        continue;
      }
      const P0 = [s.p1, s.p2, s.p3, s.p4];

      const Qr = isStatic ? cubicDegreeReduce(P0) : null;
      if (Qr) {
        if (sideInFill(s.p1, s.p4, Qr, interiorSign)) return 'concave';
        continue;
      }
      if (cubicLoop(P0)) return 'loop';
      // A real cubic, and its concavity IS decidable: buildRims tests the bulge side of each
      // INFLECTION piece, and an inflection is by definition where the bulge side changes, so a
      // piece has one. subdivideFlat then cuts those pieces further for hull tightness, but a
      // sub-piece of a single-bulge piece bulges the same way — so testing at inflection
      // granularity gives buildRims' answer without paying for the flatness split, the klmn
      // frames, the hulls or the edge metadata that make buildRims 71% of a declined build.
      for (const P of splitCubicMulti(
        P0,
        cubicInflections(P0)
          .concat(cubicLoopCuts(P0))
          .sort((a, b) => a - b),
      )) {
        const cm = [(P[1][0] + P[2][0]) / 2, (P[1][1] + P[2][1]) / 2];
        if (sideInFill(P[0], P[3], cm, interiorSign)) return 'concave';
      }
      realCubic = true;
    }
  }
  return realCubic ? 'cubic' : 'accept';
}

// Build the rims + curve regions + edges for a set of contours (everything
// EXCEPT the earcut triangulation). Shared by buildLoopBlinnMesh (which then
// earcuts) and refreshLoopBlinnMesh (which reuses a cached triangulation when
// the rim STRUCTURE is unchanged — fixed-topology streaming, no earcut).
export function buildRims(contours, isStatic, exact = null) {
  // even-odd fill test from the on-curve rings (used only for the one-per-
  // contour interior calibration, not per edge/curve). `exact` (the `correct` build, from
  // resolveFastContours) supplies the fill test on the outline itself and each contour's fill side.
  const rings = exact ? null : contours.map(chordRing);
  const inFill = exact
    ? exact.inFill
    : (p) => {
        let c = 0;
        for (const r of rings) if (pointInPoly(p[0], p[1], r)) c++;
        return (c & 1) === 1;
      };

  const quads = [],
    cubics = [],
    fallback = [],
    rims = [],
    edges = [],
    chordArcs = new Map(),
    vertexArcs = new Map();
  // THE OUTLINE AS CHAINS (the `correct` build only): the interior's antialiasing then comes from the
  // analytic chain faces (interiorChainsFromTris, the static partition's route) instead of the curve
  // ramp -- the ramp cannot follow a cubic (its implicit has other branches off the piece) and does
  // not ramp the faces beside a concave curve's control edges, so those faces would paint a flat 1.0
  // through the inner half of the edge. A line is its own chain; a quadratic is its polyline at the partition's
  // density (sagitta within span/4096 of the curve), and so is each cubic piece (the partition takes
  // a -> B(1/2) -> b there, but its Bezout crescents own the band inside the chord; this builder's
  // flat klmn pieces leave it to the chain). Every chain edge carries the contour's outward normal.
  const chainEdges = exact ? [] : null;
  const chainTol = exact ? emSpan() * 2 ** -12 : 0;
  const pushChain = (P, Q, outwardSign) => {
    const dx = Q[0] - P[0],
      dy = Q[1] - P[1],
      L = Math.hypot(dx, dy);
    if (!(L > 0)) return;
    chainEdges.push({ p1: P, p2: Q, nx: (-dy / L) * outwardSign, ny: (dx / L) * outwardSign });
  };
  const chordKey = (p) =>
    Math.round((Math.fround(p[0]) - _kox) * _koScale) * 2097152 +
    Math.round((Math.fround(p[1]) - _koy) * _koScale); // numeric (must match the (x,y) form)
  const addChordArc = (a, ctrl, b, sign, w) => {
    const ka = chordKey(a),
      kb = chordKey(b),
      arc = { a, ctrl, b, sign, w };
    chordArcs.set(ka < kb ? ka + '|' + kb : kb + '|' + ka, arc);
    // vertexArcs holds ALL arcs at an on-curve point (a seam vertex has two) so the
    // interior ramp can pick the wedge-correct one, not last-write-wins.
    let la = vertexArcs.get(ka);
    if (!la) vertexArcs.set(ka, (la = []));
    la.push(arc);
    let lb = vertexArcs.get(kb);
    if (!lb) vertexArcs.set(kb, (lb = []));
    lb.push(arc);
  };

  let hasConcave = false;
  let ci = -1;
  for (const segs of contours) {
    ci++;
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
    const interiorSign =
      exact && exact.sides[ci]
        ? exact.sides[ci]
        : verifyInteriorSign(segs, inFill, calibrateInterior(segs, inFill));
    const outwardSign = -interiorSign;
    const tg = segs.map(segTangents); // per-segment tangents for the kind-10 end metadata
    for (let si = 0; si < segs.length; si++) {
      const s = segs[si];
      if (s.type === SEG_LINE) {
        rim.push(s.p1);
        const ex = s.p2[0] - s.p1[0],
          ey = s.p2[1] - s.p1[1];
        const L = Math.hypot(ex, ey);
        if (L > 0) {
          // a zero-length edge only: an absolute 1e-9 dropped every edge at 2^-20
          const px = -ey / L,
            py = ex / L; // left-perpendicular
          edges.push({
            p1: s.p1,
            p2: s.p2,
            nx: px * outwardSign,
            ny: py * outwardSign,
            out: outwardSign,
            e1: edgeEndMeta(segs, tg, si, 0, interiorSign),
            e2: edgeEndMeta(segs, tg, si, 1, interiorSign),
          });
          if (chainEdges)
            chainEdges.push({ p1: s.p1, p2: s.p2, nx: px * outwardSign, ny: py * outwardSign });
        }
        continue;
      }
      if (s.type === SEG_QUAD || s.type === SEG_RQUAD) {
        const concave = sideInFill(s.p1, s.p3, s.p2, interiorSign); // chord p1→p3, ctrl p2
        if (concave) hasConcave = true;
        rim.push(s.p1);
        if (concave) rim.push(s.p2);
        if (chainEdges) {
          const w = s.type === SEG_RQUAD ? s.w || 1 : 1;
          const at = (t) => {
            const u = 1 - t,
              d = u * u + 2 * u * t * w + t * t;
            return [
              (u * u * s.p1[0] + 2 * u * t * w * s.p2[0] + t * t * s.p3[0]) / d,
              (u * u * s.p1[1] + 2 * u * t * w * s.p2[1] + t * t * s.p3[1]) / d,
            ];
          };
          const m = at(0.5),
            sag = Math.hypot(m[0] - (s.p1[0] + s.p3[0]) / 2, m[1] - (s.p1[1] + s.p3[1]) / 2);
          // AT MOST SIXTEEN SEGMENTS (the partition's density, capped). Each segment is chain work in every
          // face beside it, and past the face kernel's five-point window a finer chain buys little.
          let n = 2;
          while (n < 16 && sag / (n * n) > chainTol) n *= 2;
          let prev = s.p1;
          for (let i = 1; i <= n; i++) {
            const nx = i === n ? s.p3 : at(i / n);
            pushChain(prev, nx, outwardSign);
            prev = nx;
          }
        }
        // A convex circular arc renders its crescent as an exact circular-SDF SECTOR
        // (kind 6): co-circular sectors share the field AND tile (shared radial edge),
        // so the ≤90°-split / adjacent-arc seams stop MAX-undercounting. Concave
        // circular arcs (hole boundaries) and non-circular curves keep the rquad/quad
        // control-triangle crescent.
        // only WHERE ITS WEDGE IS INK (sectorInsideFill): elsewhere the crescent below is exact and the sector is not.
        if (
          s.type === SEG_RQUAD &&
          s.circle &&
          !concave &&
          sectorInsideFill(contours, s, s.circle, s.p1, s.p3, inFill)
        ) {
          emitCircleSector(quads, s.circle, s.p1, s.p3, 1);
        } else {
          const w = s.type === SEG_RQUAD ? s.w : 1,
            sign = concave ? -1 : 1;
          const q9 = {
            tri: new Float32Array([s.p1[0], s.p1[1], s.p2[0], s.p2[1], s.p3[0], s.p3[1]]),
            sign,
            w,
          };
          // Kind-12 unified-band end metadata (static quads / rquads): the same
          // neighbor normal/curvature/type payload the kind-10 edge strip carries, so
          // the packer can emit one chained band per arc instead of strip+cap.
          if (isStatic && (s.type === SEG_QUAD || s.type === SEG_RQUAD) && !concave) {
            q9.e1 = edgeEndMeta(segs, tg, si, 0, interiorSign);
            q9.e2 = edgeEndMeta(segs, tg, si, 1, interiorSign);
          }
          quads.push(q9);
          addChordArc(s.p1, s.p2, s.p3, sign, w);
        } // interior triangles on this chord ramp at the arc
        continue;
      }
      // cubic
      const P0 = [s.p1, s.p2, s.p3, s.p4];
      // Degree reduction: a cubic with a vanishing leading coefficient is a quadratic.
      // klmn reports d1 = d2 = 0, cubicKLMN bails, and the kind-4 Bezout crescent renders
      // it WRONG (a corner-control squircle draws only its interior diamond).
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
        rim.push(s.p1);
        if (concaveQ) rim.push(Qr);
        const signQ = concaveQ ? -1 : 1;
        quads.push({
          tri: new Float32Array([s.p1[0], s.p1[1], Qr[0], Qr[1], s.p4[0], s.p4[1]]),
          sign: signQ,
          w: 1,
        });
        addChordArc(s.p1, Qr, s.p4, signQ, 1);
        continue;
      }
      if (cubicLoop(P0)) {
        rim.push(s.p1);
        fallback.push(s);
        continue;
      } // loop/cusp → Slug
      // Split at inflections (each piece single-bulge), then subdivide each
      // piece further: a sub-piece's de Casteljau control hull hugs the curve
      // tighter than the parent's, so the implicit-covered region shrinks to
      // thin slivers near the curve (the rim threads the split points, so the
      // inner crescent fills flat). Same exact implicit per sub-piece → less
      // fragment overdraw on bulged curves.
      // Inflections AND the loop's in-span double point(s) — see cubicLoopCuts. A
      // segment holding PART of a loop is not caught by the cubicLoop() decline above
      // (that needs both roots in span) and would otherwise keep an interior double
      // point, across which the implicit flips sign.
      const infPieces = splitCubicMulti(
        P0,
        cubicInflections(P0)
          .concat(cubicLoopCuts(P0))
          .sort((a, b) => a - b),
      );
      const pieces = [];
      for (const ip of infPieces) {
        if (exact) splitCubicForCrescent(ip, pieces, !_preferBezout && !!cubicKLMN(ip));
        else if (isStatic) subdivideFlat(ip, 0, pieces);
        else pieces.push(ip);
      }
      rim.push(s.p1);
      const stubE = { nN: [0, 0], k: 0, type: 0, curve: true, tsign: 1, qn: true, turn: 0 };
      for (let pi = 0; pi < pieces.length; pi++) {
        const P = pieces[pi];
        const cmP = [(P[1][0] + P[2][0]) / 2, (P[1][1] + P[2][1]) / 2];
        const cc = sideInFill(P[0], P[3], cmP, interiorSign);
        if (cc) hasConcave = true;
        if (cc) {
          rim.push(P[1]);
          rim.push(P[2]);
        }
        if (P !== pieces[pieces.length - 1]) rim.push(P[3]); // interior split point
        if (chainEdges) {
          const at = (t) => {
            const u = 1 - t,
              k0 = u * u * u,
              k1 = 3 * u * u * t,
              k2 = 3 * u * t * t,
              k3 = t * t * t;
            return [
              k0 * P[0][0] + k1 * P[1][0] + k2 * P[2][0] + k3 * P[3][0],
              k0 * P[0][1] + k1 * P[1][1] + k2 * P[2][1] + k3 * P[3][1],
            ];
          };

          const m = at(0.5),
            sag = Math.hypot(m[0] - (P[0][0] + P[3][0]) / 2, m[1] - (P[0][1] + P[3][1]) / 2);
          let n = 2;
          while (n < 4 && sag / (n * n) > chainTol) n *= 2;
          let prev = P[0];
          for (let i = 1; i <= n; i++) {
            const nx = i === n ? P[3] : at(i / n);
            pushChain(prev, nx, outwardSign);
            prev = nx;
          }
        }
        const hull = cubicHull(P),
          htris =
            hull.length === 3
              ? [[0, 1, 2]]
              : [
                  [0, 1, 2],
                  [0, 2, 3],
                ];
        const klmn = _preferBezout ? null : cubicKLMN(P);
        if (klmn) {
          // Cheap Loop-Blinn path: per-vertex (k,l,m) interpolated; f = k³−lm.
          const sign = cubicSignKLMN(P, klmn, cc);
          const verts = [],
            tc = [];
          for (const tri of htris)
            for (const hi of tri) {
              const idx = hull[hi],
                cp = P[idx];
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
          const tA =
            _unit(P[1][0] - P[0][0], P[1][1] - P[0][1]) ||
            _unit(P[2][0] - P[0][0], P[2][1] - P[0][1]) ||
            _unit(P[3][0] - P[0][0], P[3][1] - P[0][1]);
          const tB =
            _unit(P[3][0] - P[2][0], P[3][1] - P[2][1]) ||
            _unit(P[3][0] - P[1][0], P[3][1] - P[1][1]) ||
            _unit(P[3][0] - P[0][0], P[3][1] - P[0][1]);
          // Kind-12 end metadata: real neighbor meta at the contour-segment ends;
          // interior split joints span-clip (type 0 stub).
          const e1 = isStatic && pi === 0 ? edgeEndMeta(segs, tg, si, 0, interiorSign) : stubE;
          const e2 =
            isStatic && pi === pieces.length - 1
              ? edgeEndMeta(segs, tg, si, 1, interiorSign)
              : stubE;
          cubics.push({
            hull: new Float32Array(verts),
            klmn: new Float32Array(tc),
            sign,
            cp: P,
            na: tA,
            nb: tB ? [-tB[0], -tB[1]] : null,
            a: P[0],
            b: P[3],
            e1,
            e2,
          });
        } else {
          // Degenerate (cusp / d1≈0) → exact Bezout det.
          // A cubic whose four control points coincide has no implicit -- it is a point, encloses
          // nothing, and bezoutCubicImplicit says so rather than conditioning against a constant.
          // Skipping it drops no ink and keeps the rest of the shape on this builder.
          const F = bezoutCubicImplicit(P);
          if (!F) continue;
          const sign = cubicSign(P, F, cc);
          const verts = [];
          for (const tri of htris)
            for (const hi of tri) {
              const cp = P[hull[hi]];
              verts.push(cp[0], cp[1]);
            }

          cubics.push(
            exact
              ? { hull: new Float32Array(verts), F, sign, keep: bezoutKeepHalf(P, cc) }
              : { hull: new Float32Array(verts), F, sign },
          );
        }
      }
    }
    rims.push(rim);
  }
  return {
    rims,
    quads,
    cubics,
    edges,
    fallback,
    hasConcave,
    chordArcs,
    vertexArcs,
    chainEdges,
    turns: rims.map(rimTurns),
  };
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
  const n = rim.length,
    out = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const a = rim[(i - 1 + n) % n],
      b = rim[i],
      c = rim[(i + 1) % n];
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      vx = c[0] - b[0],
      vy = c[1] - b[1];
    const den = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const sn = den > 0 ? (ux * vy - uy * vx) / den : 0; // den is a product of LENGTHS: a zero test, not 1e-12
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
    const x = a[i],
      y = b[i];
    if (!x || !y || x.length !== y.length) return false;
    for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return false;
  }
  return true;
}

// Flatten rims (outer first, then holes) into one coords array + hole-start
// indices. Triangle indices point back into `coords`.
export function flattenRims(rims) {
  const coords = [],
    holeStarts = [];
  for (const p of rims[0]) coords.push(p);
  for (let i = 1; i < rims.length; i++) {
    holeStarts.push(coords.length);
    for (const p of rims[i]) coords.push(p);
  }
  return { coords, holeStarts };
}

// Classify rims by CONTAINMENT, not by index.

// Even nesting depth is solid, odd is a hole, and each hole belongs to the
// DEEPEST solid that contains it — the standard even-odd nesting rule, which
// also gets a hole-inside-a-hole (an island) right. Containment is decided by
// majority vertex vote so a rim that TOUCHES another at a point or shares a
// vertex is not misread by a single ambiguous sample.
export function groupRims(rims) {
  const n = rims.length;
  if (n <= 1) return [{ outer: 0, holes: [] }];
  const inside = (ri, rj) => {
    // is rim ri inside rim rj?
    const pts = rims[ri],
      poly = rims[rj];
    let hit = 0,
      tot = 0;
    for (const p of pts) {
      tot++;
      if (pointInPoly(p[0], p[1], poly)) hit++;
    }
    return tot > 0 && hit * 2 > tot;
  };
  const contains = []; // contains[i] = rims containing i
  for (let i = 0; i < n; i++) {
    contains[i] = [];
    for (let j = 0; j < n; j++) if (j !== i && inside(i, j)) contains[i].push(j);
  }
  const groups = [];
  const idxOf = new Map();
  for (let i = 0; i < n; i++)
    if ((contains[i].length & 1) === 0) {
      // even depth → solid
      idxOf.set(i, groups.length);
      groups.push({ outer: i, holes: [] });
    }
  for (let i = 0; i < n; i++)
    if ((contains[i].length & 1) === 1) {
      // odd depth → hole
      // parent = the containing SOLID with the greatest depth (the innermost one)
      let best = -1,
        bestD = -1;
      for (const j of contains[i]) {
        if ((contains[j].length & 1) !== 0) continue; // holes cannot parent
        if (contains[j].length > bestD) {
          bestD = contains[j].length;
          best = j;
        }
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
  const coords = [],
    holeStarts = [],
    spans = [];
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
///
/// Reached from earcut's triangulation by LAWSON FLIPS: a triangulation whose every non-rim edge is locally
/// Delaunay is the constrained Delaunay triangulation, so earcut's faces are flipped (exact orientation and
/// in-circle predicates) until none is illegal. An incremental CDT (cdt.js) builds the same faces up to
/// cocircular ties; on a streamed band's few-vertex rims the flips cost a fifth less of the whole build
/// (24 road bands: 1.99 -> 1.60 ms a frame, the same edge pixels).
export function triangulateLayoutFlip(coords, spans) {
  const tris = [];
  for (const sp of spans) {
    const local = coords.slice(sp.base, sp.base + sp.count);
    const t = earcut(local, sp.localHoles.length ? sp.localHoles : null);
    const n = sp.count,
      T = [];
    for (let k = 0; k + 2 < t.length; k += 3) {
      let a = t[k],
        b = t[k + 1],
        c = t[k + 2];
      const o = orient2dP(local[a], local[b], local[c]);
      if (o < 0) {
        const x = b;
        b = c;
        c = x;
      }
      T.push([a, b, c, o !== 0]);
    }
    // Rim edges are the constraints: consecutive vertices of each ring, both ways.
    const starts = [0, ...sp.localHoles, n],
      rim = new Set();
    for (let r = 0; r + 1 < starts.length; r++)
      for (let i = starts[r]; i < starts[r + 1]; i++) {
        const j = i + 1 < starts[r + 1] ? i + 1 : starts[r];
        rim.add(i * n + j);
        rim.add(j * n + i);
      }
    const edgeTri = new Map(); // directed edge a->b (a*n+b) -> triangle index
    const setTri = (ti) => {
      const [a, b, c] = T[ti];
      edgeTri.set(a * n + b, ti);
      edgeTri.set(b * n + c, ti);
      edgeTri.set(c * n + a, ti);
    };
    for (let ti = 0; ti < T.length; ti++) setTri(ti);
    const stack = [];
    for (let ti = 0; ti < T.length; ti++) {
      const [a, b, c] = T[ti];
      stack.push([a, b], [b, c], [c, a]);
    }
    let guard = 64 * (T.length + 1) * (T.length + 1);
    while (stack.length && guard-- > 0) {
      const [a, b] = stack.pop();
      if (rim.has(a * n + b)) continue;
      const t1 = edgeTri.get(a * n + b),
        t2 = edgeTri.get(b * n + a);
      if (t1 === undefined || t2 === undefined) continue;
      if (!T[t1][3] || !T[t2][3]) continue; // a zero-area face (coincident points): leave it
      const A = T[t1],
        B = T[t2];
      const c = A[0] !== a && A[0] !== b ? A[0] : A[1] !== a && A[1] !== b ? A[1] : A[2];
      const d = B[0] !== a && B[0] !== b ? B[0] : B[1] !== a && B[1] !== b ? B[1] : B[2];
      // t1 holds a->b, so it is (a, b, c) CCW; the neighbor across it holds b->a: (b, a, d).
      if (!(incircleP(local[a], local[b], local[c], local[d]) > 0)) continue;
      if (!(
        orient2dP(local[c], local[a], local[d]) > 0 && orient2dP(local[d], local[b], local[c]) > 0
      ))
        continue;
      for (const [x, y] of [
        [a, b],
        [b, c],
        [c, a],
        [b, a],
        [a, d],
        [d, b],
      ])
        edgeTri.delete(x * n + y);
      T[t1] = [c, a, d, true];
      T[t2] = [d, b, c, true];
      setTri(t1);
      setTri(t2);
      stack.push([a, d], [d, b], [b, c], [c, a]);
    }
    for (const [a, b, c] of T) tris.push(a + sp.base, b + sp.base, c + sp.base);
  }
  return tris;
}
function interiorFromTris(coords, tris) {
  const interior = new Float32Array(tris.length * 2);
  let w = 0;
  for (let t = 0; t < tris.length; t++) {
    const p = coords[tris[t]];
    interior[w++] = p[0];
    interior[w++] = p[1];
  }
  return interior;
}
// Per-interior-VERTEX straight boundary-edge line (nx, ny, c) — the same line
// for all 3 verts of a triangle that has a straight boundary edge, 0 otherwise.
// The fragment ramps kind-0 coverage across this line (the INNER half of the
// edge AA: clamp(½ − f/fwidth), f = signed distance, +outside), while the
// outward strip supplies the outer half — so straight edges AA with no interior
// inset (which distorted corners). A triangle with two boundary edges keeps the
// first; the other is still outer-AA'd by its strip. Curve/internal edges → 0.
function interiorEdgesFromTris(coords, tris, edges) {
  const out = new Float32Array(tris.length * 3);
  if (!edges || !edges.length) return out;
  const key = (p) =>
    Math.round((Math.fround(p[0]) - _kox) * _koScale) * 2097152 +
    Math.round((Math.fround(p[1]) - _koy) * _koScale); // numeric (must match the (x,y) form)
  const map = new Map();
  for (const e of edges) {
    const line = [e.nx, e.ny, e.nx * e.p1[0] + e.ny * e.p1[1]];
    map.set(key(e.p1) + '|' + key(e.p2), line);
    map.set(key(e.p2) + '|' + key(e.p1), line);
  }
  for (let t = 0; t < tris.length; t += 3) {
    const a = coords[tris[t]],
      b = coords[tris[t + 1]],
      c = coords[tris[t + 2]];
    const ka = key(a),
      kb = key(b),
      kc = key(c);
    const line = map.get(ka + '|' + kb) || map.get(kb + '|' + kc) || map.get(kc + '|' + ka);
    if (!line) continue;
    for (let k = 0; k < 3; k++) {
      const w = (t + k) * 3;
      out[w] = line[0];
      out[w + 1] = line[1];
      out[w + 2] = line[2];
    }
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
  const key = (x, y) =>
    Math.round((Math.fround(x) - _kox) * _koScale) * 2097152 +
    Math.round((Math.fround(y) - _koy) * _koScale); // numeric: string keys would be a top build allocator
  const map = new Map();
  for (const e of edges) {
    const line = [e.nx, e.ny, e.nx * e.p1[0] + e.ny * e.p1[1]];
    map.set(key(e.p1[0], e.p1[1]) + '|' + key(e.p2[0], e.p2[1]), line);
    map.set(key(e.p2[0], e.p2[1]) + '|' + key(e.p1[0], e.p1[1]), line);
  }
  for (let t = 0; t < interior.length; t += 6) {
    const ka = key(interior[t], interior[t + 1]),
      kb = key(interior[t + 2], interior[t + 3]),
      kc = key(interior[t + 4], interior[t + 5]);
    const line = map.get(ka + '|' + kb) || map.get(kb + '|' + kc) || map.get(kc + '|' + ka);
    if (!line) continue;
    const o = (t / 2) * 3;
    for (let k = 0; k < 3; k++) {
      out[o + k * 3] = line[0];
      out[o + k * 3 + 1] = line[1];
      out[o + k * 3 + 2] = line[2];
    }
  }
  return out;
}
export function rimLens(rims) {
  return rims.map((r) => r.length);
}

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

/// `inkAt(x, y)` (optional): the shape's exact fill test. Given it, an edge marked `line9` -- a LINE, whose
/// chord is itself -- takes its fill side from the fill beside it instead of from the face's centroid.
/// `holdTouched` (a morph pair): chain 2 holds the run a face actually touches when the run fits, rather than a window around the centroid that a walked
/// extension can push off it, and a chord is sided by its own normal. A face reported bad then really exceeds its two chains, which the morph route reads as its decline.
export function interiorChainsFromTris(coords, tris, edges, inkAt = null, holdTouched = false) {
  const chainA = new Float32Array(tris.length * 4); // P0, P1
  const chainB = new Float32Array(tris.length * 4); // P2, P3
  const chainC = new Float32Array(tris.length * 4); // P4, P5
  const chainD = new Float32Array(tris.length * 4); // CHAIN 2: Q0, Q1 → aC1
  const chainE = new Float32Array(tris.length * 4); // CHAIN 2: Q2, Q3 → aC2
  const badFaces = new Uint8Array((tris.length / 3) | 0); // faces neither chain can serve
  let incomplete = false,
    hasChain2 = false,
    hasCubicChain = false; // see the coverage check below
  if (!edges || !edges.length)
    return {
      chainA,
      chainB,
      chainC,
      chainD,
      chainE,
      incomplete,
      hasChain2,
      hasCubicChain,
      badFaces,
    };
  const key = (x, y) =>
    Math.round((Math.fround(x) - _kox) * _koScale) * 2097152 +
    Math.round((Math.fround(y) - _koy) * _koScale);
  // kA → Map(kB → edge), both directions. A two-level NUMERIC map, not "kA|kB" strings: the keys are integers already, and
  // building a string per lookup is a noticeable share of the partition build's update time on streamed geometry. Same pairs,
  // same last-write-wins, so the same edge comes back for every query.
  const sideMap = new Map();
  const sideSet = (a, b, e) => {
    let m = sideMap.get(a);
    if (!m) sideMap.set(a, (m = new Map()));
    m.set(b, e);
  };
  const sideGet = (a, b) => {
    const m = sideMap.get(a);
    return m === undefined ? undefined : m.get(b);
  };
  const vertEdges = new Map(); // vkey → [edges]
  for (const e of edges) {
    const k1 = key(e.p1[0], e.p1[1]),
      k2 = key(e.p2[0], e.p2[1]);
    sideSet(k1, k2, e);
    sideSet(k2, k1, e);
    let a = vertEdges.get(k1);
    if (!a) vertEdges.set(k1, (a = []));
    a.push(e);
    let b = vertEdges.get(k2);
    if (!b) vertEdges.set(k2, (b = []));
    b.push(e);
  }
  // WHICH SIDE OF A STRAIGHT EDGE IS INK, next to this face: +1 left of p1->p2, -1 right, 0 when the
  // probe cannot say (ink on both sides or neither). Asked at the edge point NEAREST the face, a hair
  // off each side, so a self-crossing outline -- whose edges change sides at every crossing -- answers
  // for the part of the edge the face sees. Memoized per face: orientLeft asks about the same edge
  // for the face's sides, both reach walks and the leftover run.
  let _sideCen = null;
  const _sideMemo = new Map();
  const lineFillSide = (e, cen) => {
    if (cen !== _sideCen) {
      _sideCen = cen;
      _sideMemo.clear();
    }
    let v = _sideMemo.get(e);
    if (v !== undefined) return v;
    const dx = e.p2[0] - e.p1[0],
      dy = e.p2[1] - e.p1[1],
      L2 = dx * dx + dy * dy,
      L = Math.sqrt(L2);
    v = 0;
    if (L2 > 0) {
      const t = Math.max(
        0.05,
        Math.min(0.95, ((cen[0] - e.p1[0]) * dx + (cen[1] - e.p1[1]) * dy) / L2),
      );
      const qx = e.p1[0] + t * dx,
        qy = e.p1[1] + t * dy,
        o = 1e-3 * L,
        ox = (-dy / L) * o,
        oy = (dx / L) * o;
      const inkL = inkAt(qx + ox, qy + oy),
        inkR = inkAt(qx - ox, qy - oy);
      v = inkL === inkR ? 0 : inkL ? 1 : -1;
    }
    _sideMemo.set(e, v);
    return v;
  };
  // Orient an edge so FILL is on the LEFT of A→B.

  const orientLeft = (e, cen) => {
    // A LINE's fill side is exact from the fill itself (`inkAt`, straight outlines only; see lbPartition).
    if (inkAt && e.line9 && cen) {
      const sd = lineFillSide(e, cen);
      if (sd) return sd > 0 ? [e.p1, e.p2] : [e.p2, e.p1];
    }
    const dx = e.p2[0] - e.p1[0],
      dy = e.p2[1] - e.p1[1];
    // A curve's chord knows its own side (the piece's normal); the asking face's centroid, far from the chord, can name the wrong one, and a chain read backwards is the complement of its ink.
    if (cen && !e.ownSide9) {
      const cr = dx * (cen[1] - e.p1[1]) - dy * (cen[0] - e.p1[0]);
      const scale = Math.hypot(dx, dy) * (Math.hypot(cen[0] - e.p1[0], cen[1] - e.p1[1]) || 1);
      // Only when the centroid is decisively off the line; one that lies on it says nothing.
      if (scale > 0 && Math.abs(cr) > 1e-9 * scale) return cr > 0 ? [e.p1, e.p2] : [e.p2, e.p1];
    }
    return -dy * e.nx + dx * e.ny < 0 ? [e.p1, e.p2] : [e.p2, e.p1];
  };

  const kkCache = new Map();
  const kk = (p) => {
    let v = kkCache.get(p);
    if (v === undefined) {
      v = key(p[0], p[1]);
      kkCache.set(p, v);
    }
    return v;
  };
  //
  // Taken against the geometry's own extent, with the coefficient unchanged, so an em-sized glyph
  // gets exactly the value these are tuned to and everything else gets the same test.
  // `coords` is a list of [x, y] pairs on both callers.
  let _cx0 = Infinity,
    _cy0 = Infinity,
    _cx1 = -Infinity,
    _cy1 = -Infinity;
  for (const q of coords) {
    if (!q) continue;
    if (q[0] < _cx0) _cx0 = q[0];
    if (q[0] > _cx1) _cx1 = q[0];
    if (q[1] < _cy0) _cy0 = q[1];
    if (q[1] > _cy1) _cy1 = q[1];
  }
  const R_EXT = _cx1 >= _cx0 ? Math.max(_cx1 - _cx0, _cy1 - _cy0) || 1 : 1;
  const R_REACH = (mantleDebugHook('__LB_R_REACH') || 0.01) * R_EXT,
    R_TURN = mantleDebugHook('__LB_R_TURN') || 0.45,
    R_HOPS = mantleDebugHook('__LB_R_HOPS') || 8;

  const R_MICRO = 0.005 * R_EXT;
  const walkOut = (vk0, exclude, backward, maxPts = 1, cen = null) => {
    let vk = vk0,
      cur = null,
      span = 0,
      turn = 0,
      chordSpan = 0,
      pdx = 0,
      pdy = 0;
    const seen = new Set();
    let ek = new Set();
    const out = [];
    for (let h = 0; h < R_HOPS; h++) {
      let next = null,
        edge = null,
        from = null;
      for (const e of vertEdges.get(vk) || []) {
        if (exclude.has(e) || seen.has(e)) continue;
        const [A, B] = orientLeft(e, cen);
        if (backward ? kk(B) === vk : kk(A) === vk) {
          next = backward ? A : B;
          from = backward ? B : A;
          edge = e;
          break;
        }
      }
      if (!next) break;
      const dx = next[0] - from[0],
        dy = next[1] - from[1],
        L = Math.hypot(dx, dy);
      if (L > 1e-12 * R_EXT) {
        if (cur) {
          // accumulate turning past the first hop
          const dot = (pdx * dx + pdy * dy) / L;
          turn += Math.acos(Math.max(-1, Math.min(1, dot)));
          if (turn > R_TURN) {
            // bend: cross it only when the walked chord is micro (its direction
            // would fabricate the terminal extension); else stop at the corner
            if (chordSpan > R_MICRO || out.length + 1 >= maxPts) break;
            out.push({ pt: cur, ek });
            ek = new Set();
            turn = 0;
            chordSpan = 0;
          }
        }
        pdx = dx / L;
        pdy = dy / L;
        span += L;
        chordSpan += L;
      }
      seen.add(edge);
      ek.add(edge);
      cur = next;
      vk = kk(next);
      if (span >= R_REACH) break;
    }
    if (cur) out.push({ pt: cur, ek });
    return out.length ? out : null;
  };
  // The walks carry the same centroid: an extension oriented by a different rule than the face's
  // own sides reverses part of one chain.
  const precede = (vk, exclude, maxPts, cen) => walkOut(vk, exclude, true, maxPts, cen);
  const follow = (vk, exclude, maxPts, cen) => walkOut(vk, exclude, false, maxPts, cen);
  // Link fill-left oriented sides into ONE connected chain: start = a side whose
  // A is no other side's B, then follow B→A. Returns the ordered point list.
  const orderChain = (ss) => {
    if (!ss.length) return [];
    const ends = new Set(ss.map((s) => kk(s[1])));
    let start = ss.find((s) => !ends.has(kk(s[0]))) || ss[0];
    const ordered = [start];
    const used = new Set([start]);
    let cur = start;
    while (ordered.length < ss.length) {
      const nx = ss.find((s) => !used.has(s) && kk(s[0]) === kk(cur[1]));
      if (!nx) break;
      ordered.push(nx);
      used.add(nx);
      cur = nx;
    }
    const out = [ordered[0][0]];
    for (const s of ordered) out.push(s[1]);
    return out;
  };
  // The DISCONNECTED outline ARCS this face touches: every outline edge incident
  // to any of its vertices, grouped transitively by shared endpoints, each group
  // ordered fill-left. A face reaching two arcs needs TWO chains — one ordered
  // chain cannot represent both, and a fragment near the second arc would fall
  // off the first and hit the miss path (see the region proof in `assemble`).
  // Edges a face's fragments can REACH: vertex-incident ones (the CDT
  // guarantees nearby outline shares a vertex — for CDT points) PLUS any edge
  // within R_NEAR of the triangle. Vertex incidence alone is not enough once
  // curve-polyline densification adds NON-CDT points: a glyph's counter tip can
  // poke into a face that shares no vertex with it, and a face declared complete
  // would paint solid over the hole tip.
  // How far a face looks for outline it must bound. A face finding nothing gets an all-zero chain
  // and chainBoxCov then returns 1 -- correct for a deep interior face and wrong for a face at the
  // boundary, which is where sub-pixel over-coverage would come from (a sliver whose chain 1 and
  // chain 2 are both all zero reading 1.0 where the path covers a few percent).
  const R_NEAR = (mantleDebugHook('__LB_R_NEAR') || 0.006) * R_EXT; // an em-tuned length; see R_REACH above
  const segSegNear = (a1, a2, b1, b2, r) => {
    const d2 = (p, q1, q2) => {
      const dx = q2[0] - q1[0],
        dy = q2[1] - q1[1];
      const L2 = dx * dx + dy * dy || 1e-30;
      const t = Math.max(0, Math.min(1, ((p[0] - q1[0]) * dx + (p[1] - q1[1]) * dy) / L2));
      const cx = q1[0] + t * dx - p[0],
        cy = q1[1] + t * dy - p[1];
      return cx * cx + cy * cy;
    };
    const rr = r * r;
    return (
      d2(a1, b1, b2) <= rr || d2(a2, b1, b2) <= rr || d2(b1, a1, a2) <= rr || d2(b2, a1, a2) <= rr
    );
  };

  const touchGrid = (() => {
    if (edges.length < 256) return null;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const e of edges)
      for (const q of [e.p1, e.p2]) {
        if (q[0] < x0) x0 = q[0];
        if (q[0] > x1) x1 = q[0];
        if (q[1] < y0) y0 = q[1];
        if (q[1] > y1) y1 = q[1];
      }
    if (!(Number.isFinite(x0) && Number.isFinite(x1) && Number.isFinite(y0) && Number.isFinite(y1)))
      return null;
    const cs = Math.max(R_NEAR, (x1 - x0) / 512, (y1 - y0) / 512) || 1;
    const nx = Math.ceil((x1 - x0) / cs) + 1,
      ny = Math.ceil((y1 - y0) / cs) + 1;
    const cx = (x) => Math.floor((x - x0) / cs),
      cy = (y) => Math.floor((y - y0) / cs);
    const cells = new Array(nx * ny);
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const ia = cx(Math.min(e.p1[0], e.p2[0])),
        ib = cx(Math.max(e.p1[0], e.p2[0]));
      const ja = cy(Math.min(e.p1[1], e.p2[1])),
        jb = cy(Math.max(e.p1[1], e.p2[1]));
      for (let j = ja; j <= jb; j++)
        for (let k = ia; k <= ib; k++) {
          const c = j * nx + k;
          (cells[c] || (cells[c] = [])).push(i);
        }
    }
    return { cells, cx, cy, nx, ny, stamp: new Int32Array(edges.length).fill(-1), face: 0 };
  })();
  const touchedFor = (K, own, P) => {
    const es = new Set(own);
    for (const vk of K) for (const e of vertEdges.get(vk) || []) es.add(e);
    const test = (e) => {
      if (es.has(e)) return;
      for (let s2 = 0; s2 < 3; s2++) {
        if (segSegNear(e.p1, e.p2, P[s2], P[(s2 + 1) % 3], R_NEAR)) {
          es.add(e);
          break;
        }
      }
    };
    if (!touchGrid) {
      for (const e of edges) test(e);
      return [...es];
    }
    const g = touchGrid,
      face = g.face++;
    // A NaN corner leaves these ranges NaN and the loops empty -- as the scan finds nothing: every NaN comparison is false.
    const ia = Math.max(0, g.cx(Math.min(P[0][0], P[1][0], P[2][0]) - R_NEAR) - 1);
    const ib = Math.min(g.nx - 1, g.cx(Math.max(P[0][0], P[1][0], P[2][0]) + R_NEAR) + 1);
    const ja = Math.max(0, g.cy(Math.min(P[0][1], P[1][1], P[2][1]) - R_NEAR) - 1);
    const jb = Math.min(g.ny - 1, g.cy(Math.max(P[0][1], P[1][1], P[2][1]) + R_NEAR) + 1);
    const cand = [];
    for (let j = ja; j <= jb; j++)
      for (let k = ia; k <= ib; k++) {
        const list = g.cells[j * g.nx + k];
        if (list)
          for (const i of list)
            if (g.stamp[i] !== face) {
              g.stamp[i] = face;
              cand.push(i);
            }
      }
    cand.sort((a, b) => a - b);
    for (const i of cand) test(edges[i]);
    return [...es];
  };
  // An edge's undirected key is a constant of the edge; the leftover bookkeeping asks for it once
  // per touched edge per face, so it is built once per edge instead.
  const ekeyCache = new Map();
  const ekeyOf = (e) => {
    let s = ekeyCache.get(e);
    if (s === undefined) {
      s = kk(e.p1) + '|' + kk(e.p2);
      ekeyCache.set(e, s);
    }
    return s;
  };
  // undirected edge keys a point-chain actually spans (degenerate pads excluded)
  const chainEdgeKeys = (pl) => {
    const s = new Set();
    for (let i = 0; i + 1 < pl.length; i++) {
      const a = kk(pl[i]),
        b = kk(pl[i + 1]);
      if (a === b) continue;
      s.add(a + '|' + b);
      s.add(b + '|' + a);
    }
    return s;
  };
  // split an edge set into connected runs (shared endpoints, transitively)
  const groupRuns = (list) => {
    if (!list.length) return [];
    const parent = list.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };

    const firstAt = new Map();
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const k1 = kk(e.p1),
        j1 = firstAt.get(k1);
      if (j1 === undefined) firstAt.set(k1, i);
      else {
        const ra = find(i),
          rb = find(j1);
        if (ra !== rb) parent[ra] = rb;
      }
      const k2 = kk(e.p2),
        j2 = firstAt.get(k2);
      if (j2 === undefined) firstAt.set(k2, i);
      else {
        const ra = find(i),
          rb = find(j2);
        if (ra !== rb) parent[ra] = rb;
      }
    }
    const byRoot = new Map();
    list.forEach((e, i) => {
      const r = find(i);
      let g = byRoot.get(r);
      if (!g) byRoot.set(r, (g = []));
      g.push(e);
    });
    return [...byRoot.values()];
  };
  const runNearCen = (runs, cen) => {
    // the run this face's fragments can actually reach
    let best = runs[0],
      bd = Infinity;
    for (const r of runs) {
      let d = Infinity;
      for (const e of r)
        for (const p of [e.p1, e.p2]) {
          const dx = p[0] - cen[0],
            dy = p[1] - cen[1];
          d = Math.min(d, dx * dx + dy * dy);
        }
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    return best;
  };
  // Window n points of a run around the face — full resolution NEAR the face
  // (n−2 central points, where accuracy matters), and the two END points reach
  // outward by the same span/turn walk as pre/post (dense polylines otherwise
  // shrink a point-counted window's REACH below box distance → miss → solid).
  // Returns the covered ORIGINAL edge keys so leftover bookkeeping counts the
  // decimated pieces as spanned.
  const nearWindow = (pts, n, cen) => {
    const allKeys = () => {
      const ks = new Set();
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = kk(pts[i]),
          b = kk(pts[i + 1]);
        ks.add(a + '|' + b);
        ks.add(b + '|' + a);
      }
      return ks;
    };
    if (pts.length <= n) return { pts, keys: allKeys() };
    let best = 0,
      bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i][0] - cen[0],
        dy = pts[i][1] - cen[1],
        d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const nc = n - 2; // central full-res points
    const lo = Math.max(0, Math.min(pts.length - nc, best - (nc >> 1)));
    const hi = lo + nc - 1;
    const walkList = (idx, dir) => {
      let span = 0,
        turn = 0,
        i = idx,
        pdx = 0,
        pdy = 0,
        first = true;
      for (;;) {
        const j = i + dir;
        if (j < 0 || j >= pts.length) break;
        const dx = pts[j][0] - pts[i][0],
          dy = pts[j][1] - pts[i][1],
          L = Math.hypot(dx, dy);
        if (L > 1e-12 * R_EXT) {
          if (!first) {
            const dot = (pdx * dx + pdy * dy) / L;
            turn += Math.acos(Math.max(-1, Math.min(1, dot)));
            if (turn > R_TURN) break;
          }
          pdx = dx / L;
          pdy = dy / L;
          span += L;
          first = false;
        }
        i = j;
        if (span >= R_REACH) break;
      }
      return i;
    };
    const pLo = walkList(lo, -1),
      pHi = walkList(hi, +1);
    const out = [];
    if (pLo < lo) out.push(pts[pLo]);
    for (let i = lo; i <= hi; i++) out.push(pts[i]);
    if (pHi > hi) out.push(pts[pHi]);
    const keys = new Set();
    for (let i = pLo; i < pHi; i++) {
      const a = kk(pts[i]),
        b = kk(pts[i + 1]);
      keys.add(a + '|' + b);
      keys.add(b + '|' + a);
    }
    return { pts: out, keys };
  };
  // A cubic chain's window: the arc W (fill-left) and ONE straight neighbor from the chain it replaces,
  // after it (mode 4: A C1 C2 B X) or before it (mode 5: X A C1 C2 B), whichever runs nearer the face centroid.
  const cubicWindow = (ptsIn, W, cenW) => {
    const kA = kk(W[0]),
      kB = kk(W[3]);
    const iA = ptsIn.findIndex((p) => kk(p) === kA),
      iB = ptsIn.findIndex((p) => kk(p) === kB);
    const Xn = iB >= 0 && iB + 1 < ptsIn.length && kk(ptsIn[iB + 1]) !== kB ? ptsIn[iB + 1] : null;
    const Xp = iA >= 1 && kk(ptsIn[iA - 1]) !== kA ? ptsIn[iA - 1] : null;
    const segD2 = (a, b) => {
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        L2 = dx * dx + dy * dy || 1e-30;
      const u = Math.max(0, Math.min(1, ((cenW[0] - a[0]) * dx + (cenW[1] - a[1]) * dy) / L2));
      return (a[0] + u * dx - cenW[0]) ** 2 + (a[1] + u * dy - cenW[1]) ** 2;
    };
    const useNext = Xn && (!Xp || segD2(W[3], Xn) <= segD2(Xp, W[0]));
    if (useNext || !Xp) return { pts: [W[0], W[1], W[2], W[3], useNext ? Xn : W[3]], mode: 4 };
    return { pts: [Xp, W[0], W[1], W[2], W[3]], mode: 5 };
  };
  for (let t = 0; t < tris.length; t += 3) {
    const P = [coords[tris[t]], coords[tris[t + 1]], coords[tris[t + 2]]];
    const K = [kk(P[0]), kk(P[1]), kk(P[2])];
    // ALL outline sides of this face, oriented fill-left, with their edge object.
    const cen = [(P[0][0] + P[1][0] + P[2][0]) / 3, (P[0][1] + P[1][1] + P[2][1]) / 3];
    const sides = [];
    const own = new Set();
    for (let s = 0; s < 3; s++) {
      const e = sideGet(K[s], K[(s + 1) % 3]);
      if (e && !own.has(e)) {
        own.add(e);
        sides.push(orientLeft(e, cen));
      }
    }
    const touched = touchedFor(K, own, P);
    if (!touched.length) {
      // A face that finds NO outline gets an all-zero chain, and chainBoxCov reads that as deep
      // interior and returns a flat 1. Right for a face in the middle of the ink, wrong for one at
      // the boundary -- which is where the sub-pixel over-coverage comes from. Opt-in trace so the
      // two can be told apart by measurement rather than assumed.
      if (typeof globalThis !== 'undefined' && globalThis.__lbChainTrace) {
        const cx0 = (P[0][0] + P[1][0] + P[2][0]) / 3,
          cy0 = (P[0][1] + P[1][1] + P[2][1] + 0) / 3;
        const ar =
          Math.abs(
            (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[1][1] - P[0][1]) * (P[2][0] - P[0][0]),
          ) / 2;
        let near = Infinity;
        for (const e of edges) {
          const dx2 = e.p2[0] - e.p1[0],
            dy2 = e.p2[1] - e.p1[1],
            L22 = dx2 * dx2 + dy2 * dy2 || 1e-30;
          const tt = Math.max(
            0,
            Math.min(1, ((cx0 - e.p1[0]) * dx2 + (cy0 - e.p1[1]) * dy2) / L22),
          );
          const qx = e.p1[0] + tt * dx2 - cx0,
            qy = e.p1[1] + tt * dy2 - cy0;
          near = Math.min(near, Math.hypot(qx, qy));
        }
        (globalThis.__lbChainEmpty || (globalThis.__lbChainEmpty = [])).push({
          cx: cx0,
          cy: cy0,
          ar,
          near,
          nEdges: edges.length,
        });
      }
      continue; // true deep interior → all-zero → 1
    }
    const walked = new Set(); // edges absorbed by reach walks — count as spanned
    let pts;
    if (sides.length) {
      // CHAIN 1: order this face's own sides, then extend each end along the
      // outline. The walks may emit MULTIPLE points (bend crossings); the
      // packed chain holds 5 points (aC3/aC0/aTC.yz — P5 is never emitted), so
      // allocate the spare slots between the two walks and trim the tails
      // farthest from the face when both want more than fit.
      const chain = orderChain(sides);
      const budget = Math.max(0, 5 - chain.length);
      const preL = budget ? precede(kk(chain[0]), own, budget, cen) : null;
      const postL = budget ? follow(kk(chain[chain.length - 1]), own, budget, cen) : null;
      const d2cen = (p) => {
        const dx = p[0] - cen[0],
          dy = p[1] - cen[1];
        return dx * dx + dy * dy;
      };
      // Floor: each side keeps its NEAREST point (the pre-bend behavior — a
      // stripped side loses all reach and its fragments miss → solid). Spare
      // slots go to bend-crossing extras, nearest-to-face first, prefix order.
      let nPre = 0,
        nPost = 0;
      if (preL && budget >= 1 && (budget >= 2 || !postL)) nPre = 1;
      if (postL && budget >= 1 && (budget >= 2 || !preL)) nPost = 1;
      let spare = budget - nPre - nPost;
      while (spare > 0) {
        const da = preL && nPre < preL.length ? d2cen(preL[nPre].pt) : Infinity;
        const db = postL && nPost < postL.length ? d2cen(postL[nPost].pt) : Infinity;
        if (da === Infinity && db === Infinity) break;
        if (da <= db) nPre++;
        else nPost++;
        spare--;
      }
      pts = [];
      for (let i = nPre - 1; i >= 0; i--) pts.push(preL[i].pt); // farthest first
      for (const q of chain) pts.push(q);
      for (let i = 0; i < nPost; i++) pts.push(postL[i].pt);
      for (let i = 0; i < nPre; i++) for (const e of preL[i].ek) walked.add(ekeyOf(e));
      for (let i = 0; i < nPost; i++) for (const e of postL[i].ek) walked.add(ekeyOf(e));
    } else {
      // NO outline side of its own (all three edges internal diagonals) — left
      // all-zero, every fragment would miss and the triangle would fill solid.
      // Its vertices still sit on the outline, so serve it from its largest run.
      const runs = groupRuns(touched);
      let best = runs[0];
      for (const r of runs) if (r.length > best.length) best = r;
      const w1 = nearWindow(orderChain(best.map((e) => orientLeft(e, cen))), 5, cen);
      pts = w1.pts.map((p) => p.slice());
      for (const k of w1.keys) walked.add(k);
    }
    // CHAIN 2 = the touched edges chain 1 does NOT span (4 pts → aC1/aC2). This
    // is NOT just "the second arc": a face can touch ONE arc that runs longer
    // than chain 1's 5-point window (H f4 reaches the bottom-left corner that
    // way), and those fragments miss exactly the same. Take the leftover run
    // nearest the face — the one its fragments can actually reach.
    const c1keys = chainEdgeKeys(pts);
    const rem = touched.filter((e) => !c1keys.has(ekeyOf(e)) && !walked.has(ekeyOf(e)));
    let pts2 = null,
      leftover = rem,
      cubic2 = false,
      cand2 = null,
      straight2 = null;
    if (rem.length) {
      const runPts = orderChain(runNearCen(groupRuns(rem), cen).map((e) => orientLeft(e, cen)));
      const touched2 = runPts.slice();
      const remSet = new Set(rem);
      if (runPts.length) {
        const fol2 = follow(kk(runPts[runPts.length - 1]), remSet, 4, cen);
        if (fol2) for (const c of fol2) runPts.push(c.pt);
        const pre2 = precede(kk(runPts[0]), remSet, 4, cen);
        if (pre2) for (let i = 0; i < pre2.length; i++) runPts.unshift(pre2[i].pt);
      }
      // CHAIN 2 BOUNDS THE FILL FROM OUTSIDE: the shader min()s it in as an upper bound, sound where its polyline lies
      // on or outside the boundary -- a line, a concave piece's chords -- and not over a convex piece, whose chords cut
      // into the fill; that piece is carried as its arc where a face can take it (below, and chain 1's window).
      let w2 = nearWindow(runPts, 4, cen);
      if (holdTouched && touched2.length >= 2 && touched2.length <= 4) {
        const hold = touched2.slice();
        let i0 = runPts.indexOf(touched2[0]) - 1,
          i1 = i0 + 1 + touched2.length;
        while (hold.length < 4 && (i0 >= 0 || i1 < runPts.length)) {
          if (i1 < runPts.length) hold.push(runPts[i1++]);
          else hold.unshift(runPts[i0--]);
        }
        const ks = new Set();
        for (let i = 0; i + 1 < hold.length; i++) {
          const a = kk(hold[i]),
            b = kk(hold[i + 1]);
          ks.add(a + '|' + b);
          ks.add(b + '|' + a);
        }
        w2 = { pts: hold, keys: ks };
      }
      pts2 = w2.pts.map((p) => p.slice());
      const c2keys = chainEdgeKeys(pts2);
      leftover = rem.filter((e) => !c2keys.has(ekeyOf(e)) && !w2.keys.has(ekeyOf(e)));
      // CHAIN 2 ALONG A CONCAVE PIECE: its half-chords lie on the air side, an upper bound that is not
      // tight. The piece nearest the face is the candidate for an arc; where it goes is decided below, with chain 1.
      let best2 = null,
        bd2 = Infinity;
      for (let s2 = 0; s2 + 1 < pts2.length; s2++) {
        const a = pts2[s2],
          b = pts2[s2 + 1];
        if (kk(a) === kk(b)) continue;
        const e = sideGet(kk(a), kk(b));
        if (!e || !e.cp) continue;
        const dx = b[0] - a[0],
          dy = b[1] - a[1],
          L2 = dx * dx + dy * dy || 1e-30;
        const u = Math.max(0, Math.min(1, ((cen[0] - a[0]) * dx + (cen[1] - a[1]) * dy) / L2));
        const d = (a[0] + u * dx - cen[0]) ** 2 + (a[1] + u * dy - cen[1]) ** 2;
        // The arc is fill-left already; the chain must run its way, or the chain's own orientation is the suspect one.
        if (d < bd2) {
          bd2 = d;
          best2 = { cp: e.cp, agree: kk(a) === kk(e.cp[0]) || kk(b) === kk(e.cp[3]) };
        }
      }
      if (best2 && best2.agree) {
        cand2 = best2.cp;
        straight2 = pts2.map((p) => p.slice());
      }
    }
    // Anything still unspanned would miss and fill solid → this face is not
    // analytically representable, and the whole mesh takes the shatter path.
    if (leftover.length) {
      incomplete = true;
      badFaces[(t / 3) | 0] = 1;
      if (globalThis.__CHAIN_DEBUG) {
        // distance of each leftover edge to this triangle (em) — how far away
        // the unrepresentable geometry actually is
        const segPt = (a, b, q) => {
          const dx = b[0] - a[0],
            dy = b[1] - a[1];
          const L2 = dx * dx + dy * dy || 1e-30;
          const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2));
          return Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy));
        };
        let dMin = Infinity;
        for (const e of leftover) {
          let d = Infinity;
          for (let s2 = 0; s2 < 3; s2++) {
            const A2 = P[s2],
              B2 = P[(s2 + 1) % 3];
            d = Math.min(
              d,
              segPt(A2, B2, e.p1),
              (d = segPt(A2, B2, e.p2)),
              segPt(e.p1, e.p2, A2),
              segPt(e.p1, e.p2, B2),
            );
          }
          dMin = Math.min(dMin, d);
        }
        (globalThis.__leftoverDbg || (globalThis.__leftoverDbg = [])).push(+dMin.toFixed(4));
      }
    }
    // Cubic chain. A chain segment that is one of a cubic piece's half-chords a -> m -> b (its edge
    // carries the piece, lbPartition) is replaced, with its twin, by the piece's ARC: five slots hold the cubic's four
    // points and one straight neighbor, after it (mode 4: A C1 C2 B X) or before it (mode 5: X A C1 C2 B), whichever
    // runs nearer the face. The half-chords of a concave piece lie on its air side, so no polyline through the piece's
    // points is exact there; the arc is (cubicChainBoxCov). The window is shorter than the straight chain's -- the
    // edges it drops stay counted as spanned (chain 2 was chosen above), and the arc's end continues along its own
    // tangent, which is the outline's where the neighbor joins smoothly.
    let cubicMode = 0,
      chain1Cp = null;
    if (pts.length >= 2) {
      let best = null,
        bd = Infinity;
      for (let s2 = 0; s2 < 4 && s2 + 1 < pts.length; s2++) {
        const a = pts[s2],
          b = pts[s2 + 1];
        if (kk(a) === kk(b)) continue;
        const e = sideGet(kk(a), kk(b));
        if (!e || !e.cp) continue;
        const dx = b[0] - a[0],
          dy = b[1] - a[1],
          L2 = dx * dx + dy * dy || 1e-30;
        const u = Math.max(0, Math.min(1, ((cen[0] - a[0]) * dx + (cen[1] - a[1]) * dy) / L2));
        const d = (a[0] + u * dx - cen[0]) ** 2 + (a[1] + u * dy - cen[1]) ** 2;
        // The arc is fill-left (the piece's own ink probe); the chain must run its way, meeting the arc's start or
        // end where the arc does, or the chain's orientation -- taken from the face's centroid -- is the suspect one.
        if (d < bd) {
          bd = d;
          best = { cp: e.cp, agree: kk(a) === kk(e.cp[0]) || kk(b) === kk(e.cp[3]) };
        }
      }
      if (best && best.agree) {
        const w = cubicWindow(pts, best.cp, cen);
        pts = w.pts;
        cubicMode = w.mode;
        hasCubicChain = true;
        chain1Cp = best.cp;
      }
    }

    const pol2 = mantleDebugHook('__LB_CUBIC_CHAIN2');
    if (cand2 && cand2 !== chain1Cp && pol2 !== false) {
      const kP = new Set([kk(cand2[0]), kk(cand2[3])]);
      // every point of chain 2 is the piece's own: its ends, or the midpoint its two half-chords share
      const within = pts2.every((p) => {
        if (kP.has(kk(p))) return true;
        const e1 = sideGet(kk(p), kk(cand2[0])),
          e2 = sideGet(kk(p), kk(cand2[3]));
        return !!(e1 && e1.cp === cand2) || !!(e2 && e2.cp === cand2);
      });
      const outerOk = cubicMode === 0;
      const old = pts.filter((p, i) => i === 0 || kk(p) !== kk(pts[i - 1]));
      const w =
        outerOk && old.length <= 4 && pol2 !== 'piece' ? cubicWindow(straight2, cand2, cen) : null;

      const kW = w
        ? new Set(
            w.pts
              .filter((_, i) => (w.mode === 4 ? i !== 1 && i !== 2 : i !== 2 && i !== 3))
              .map(kk),
          )
        : null;
      const holds =
        !!w &&
        straight2.every(
          (p) =>
            kW.has(kk(p)) ||
            (() => {
              const e1 = sideGet(kk(p), kk(cand2[0])),
                e2 = sideGet(kk(p), kk(cand2[3]));
              return !!(e1 && e1.cp === cand2) || !!(e2 && e2.cp === cand2);
            })(),
        );
      if (holds) {
        pts = w.pts;
        cubicMode = w.mode;
        pts2 = old.map((p) => p.slice());
        hasCubicChain = true;
      } else if (within && pol2 !== 'swap') {
        pts2 = cand2.map((p) => p.slice());
        cubic2 = true;
        hasCubicChain = true;
      }
    }
    while (pts.length < 6) pts.push(pts[pts.length - 1]); // pad → degenerate segs (inert)
    if (globalThis.__CHAIN_DEBUG) {
      const D = globalThis.__chainDbg || (globalThis.__chainDbg = []);
      D.push({
        nSides: sides.length,
        tri: [P[0], P[1], P[2]].map((p) => p.slice()),
        cen,
        pts: pts.slice(0, 5).map((p) => p.slice()),
        pts2: pts2 ? pts2.map((p) => p.slice()) : null,
        nRegions: groupRuns(touched).length,
      });
      D.nTris = tris.length / 3;
    }
    const q = pts2 || [];
    while (q.length && q.length < 4) q.push(q[q.length - 1]); // pad → inert segs
    if (pts2) hasChain2 = true;
    for (let k = 0; k < 3; k++) {
      const o = (t + k) * 4;
      chainA[o] = pts[0][0];
      chainA[o + 1] = pts[0][1];
      chainA[o + 2] = pts[1][0];
      chainA[o + 3] = pts[1][1];
      chainB[o] = pts[2][0];
      chainB[o + 1] = pts[2][1];
      chainB[o + 2] = pts[3][0];
      chainB[o + 3] = pts[3][1];
      chainC[o] = pts[4][0];
      chainC[o + 1] = pts[4][1];
      // P5 is never read by the shader — reuse it to carry the per-face MODE
      // sentinel (4 / 5 = a cubic and a line, 6 two cubics, else the straight
      // chain's 2) and whether chain 2 is one cubic (P5.y = 1)
      // through healCracks' existing 12-float rows without new plumbing.
      chainC[o + 2] = cubicMode || 2.0;
      chainC[o + 3] = cubic2 ? 1.0 : 0.0;
      if (q.length) {
        // all-zero when absent → every segment degenerate → cov 1 → min() no-op
        chainD[o] = q[0][0];
        chainD[o + 1] = q[0][1];
        chainD[o + 2] = q[1][0];
        chainD[o + 3] = q[1][1];
        chainE[o] = q[2][0];
        chainE[o + 1] = q[2][1];
        chainE[o + 2] = q[3][0];
        chainE[o + 3] = q[3][1];
      }
    }
  }
  return { chainA, chainB, chainC, chainD, chainE, incomplete, hasChain2, hasCubicChain, badFaces };
}

//
// Two removable classes, both output-exact:
//   (1) DEGENERATE — |area| < 2e-9 em² (~2e-3 px² even at a 1000px em). Paints
//       nothing; can't open a crack (a T-crack is an UNSPLIT neighbor vertex,
//       and removing a ~zero-area triangle introduces none).
//   (2) REDUNDANT SLIVER — a thin small face (height < HEIGHT_EPS em, area <
//       AREA_CAP) whose sample points are ALL inside another KEPT face. Since a
//       kind-0 fragment's coverage depends only on its payload lines, not the
//       triangle, and every point it covered stays covered by the overlapping
//       neighbor, dropping it is exact and provably crack-free. The coverage
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
  const I = mesh.interior,
    E = mesh.interiorEdges;
  if (!I || !E) return;
  // Analytic-chain meshes are coarse (no heal shards) and this rebuild does not
  // carry the chain rows — dropping/reordering faces here would pair faces with
  // other faces' chains (the mismatch healCracks guards against). Skip them.
  if (mesh.interiorChainA) return;
  const nF = (I.length / 6) | 0;
  if (nF < 64) return; // trivial meshes never carry heal shards; skip the scan
  const E2 = mesh.interiorEdges2,
    E3 = mesh.interiorEdges3;

  let dx0 = Infinity,
    dy0 = Infinity,
    dx1 = -Infinity,
    dy1 = -Infinity;
  for (let q = 0; q + 1 < I.length; q += 2) {
    if (I[q] < dx0) dx0 = I[q];
    if (I[q] > dx1) dx1 = I[q];
    if (I[q + 1] < dy0) dy0 = I[q + 1];
    if (I[q + 1] > dy1) dy1 = I[q + 1];
  }
  const diag = Math.hypot(dx1 - dx0, dy1 - dy0) || 1;
  const AREA_EPS = 1.234e-15 * diag * diag; // degenerate (paints nothing)
  const AREA_CAP = 6.171e-12 * diag * diag; // sliver candidates only — never a fat feature
  const HEIGHT_EPS = 3.928e-7 * diag; // sliver thickness (2·area/longestEdge)
  const keep = new Uint8Array(nF).fill(1);
  // pass 1: mark degenerate + thin sliver CANDIDATES; build a grid of the faces
  // that will definitely survive (non-candidates) for the coverage guard.
  const cand = []; // sliver-candidate face indices
  let dropped = 0;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let f = 0; f < nF; f++) {
    const t = f * 6;
    const ax = I[t],
      ay = I[t + 1],
      bx = I[t + 2],
      by = I[t + 3],
      cx = I[t + 4],
      cy = I[t + 5];
    if (ax < minX) minX = ax;
    if (ay < minY) minY = ay;
    if (ax > maxX) maxX = ax;
    if (ay > maxY) maxY = ay;
    if (bx < minX) minX = bx;
    if (by < minY) minY = by;
    if (bx > maxX) maxX = bx;
    if (by > maxY) maxY = by;
    if (cx < minX) minX = cx;
    if (cy < minY) minY = cy;
    if (cx > maxX) maxX = cx;
    if (cy > maxY) maxY = cy;
    const area = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) * 0.5;
    if (area < AREA_EPS) {
      keep[f] = 0;
      dropped++;
      continue;
    }
    if (area < AREA_CAP) {
      const e1 = Math.hypot(bx - ax, by - ay),
        e2 = Math.hypot(cx - bx, cy - by),
        e3 = Math.hypot(ax - cx, ay - cy);
      const maxE = Math.max(e1, e2, e3);
      if (maxE > diag * 2 ** -24 && (2 * area) / maxE < HEIGHT_EPS) cand.push(f); // an edge below one float32 ulp of the mesh is not an edge
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
    const span = Math.max(maxX - minX, maxY - minY, diag * 2 ** -24);
    const gs = Math.max(span / Math.max(Math.ceil(Math.sqrt(nF)), 1), span * 2 ** -24);
    const gk = (cxi, cyi) => cxi * 262147 + cyi;
    const grid = new Map();
    const isCand = new Uint8Array(nF);
    for (const f of cand) isCand[f] = 1;
    const addToGrid = (f) => {
      const t = f * 6;
      const bx0 = Math.min(I[t], I[t + 2], I[t + 4]),
        bx1 = Math.max(I[t], I[t + 2], I[t + 4]);
      const by0 = Math.min(I[t + 1], I[t + 3], I[t + 5]),
        by1 = Math.max(I[t + 1], I[t + 3], I[t + 5]);
      for (let cyi = Math.floor(by0 / gs); cyi <= Math.floor(by1 / gs); cyi++)
        for (let cxi = Math.floor(bx0 / gs); cxi <= Math.floor(bx1 / gs); cxi++) {
          let l = grid.get(gk(cxi, cyi));
          if (!l) grid.set(gk(cxi, cyi), (l = []));
          l.push(f);
        }
    };
    for (let f = 0; f < nF; f++) if (keep[f] && !isCand[f]) addToGrid(f);
    const ptInFace = (px, py, f) => {
      const t = f * 6,
        ax = I[t],
        ay = I[t + 1],
        bx = I[t + 2],
        by = I[t + 3],
        cx = I[t + 4],
        cy = I[t + 5];
      // A cross product of coordinates of this mesh's size, so its noise floor is that size
      // squared -- not an absolute 1e-11, which is every face's whole area at 2^-20.
      const tol = diag * diag * 2 ** -48;
      const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
      const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
      return (s1 >= -tol && s2 >= -tol && s3 >= -tol) || (s1 <= tol && s2 <= tol && s3 <= tol);
    };
    // Is the whole candidate F contained in one kept face? Scan kept faces whose
    // cell holds F's centroid (a containing face necessarily covers the centroid).
    const containedInKept = (f) => {
      const t = f * 6,
        ax = I[t],
        ay = I[t + 1],
        bx = I[t + 2],
        by = I[t + 3],
        cx = I[t + 4],
        cy = I[t + 5];
      const gx = (ax + bx + cx) / 3,
        gy = (ay + by + cy) / 3;
      const l = grid.get(gk(Math.floor(gx / gs), Math.floor(gy / gs)));
      if (!l) return false;
      for (const g of l) {
        if (g === f) continue;
        if (ptInFace(ax, ay, g) && ptInFace(bx, by, g) && ptInFace(cx, cy, g)) return true;
      }
      return false;
    };
    const areaOf = (f) => {
      const t = f * 6;
      return (
        Math.abs(
          (I[t + 2] - I[t]) * (I[t + 5] - I[t + 1]) - (I[t + 3] - I[t + 1]) * (I[t + 4] - I[t]),
        ) * 0.5
      );
    };
    cand.sort((a, b) => areaOf(b) - areaOf(a)); // fattest first
    for (const f of cand) {
      if (containedInKept(f)) {
        keep[f] = 0;
        dropped++;
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
    const t = f * 6,
      e = f * 9,
      e2 = f * 12,
      wt = w * 6,
      we = w * 9,
      we2 = w * 12;
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
  const key = (p) =>
    Math.round((Math.fround(p[0]) - _kox) * _koScale) * 2097152 +
    Math.round((Math.fround(p[1]) - _koy) * _koScale); // numeric (must match the (x,y) form)
  const bset = new Set();
  for (const e of edges) {
    const a = key(e.p1),
      b = key(e.p2);
    bset.add(a + '|' + b);
    bset.add(b + '|' + a);
  }
  const coords2 = coords.slice();
  const tris2 = [];
  for (let t = 0; t < tris.length; t += 3) {
    const ia = tris[t],
      ib = tris[t + 1],
      ic = tris[t + 2];
    const a = coords[ia],
      b = coords[ib],
      c = coords[ic];
    const ka = key(a),
      kb = key(b),
      kc = key(c);
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
  const key = (x, y) =>
    Math.round((Math.fround(x) - _kox) * _koScale) * 2097152 +
    Math.round((Math.fround(y) - _koy) * _koScale);
  const bset = new Set();
  for (const e of edges) {
    const a = key(e.p1[0], e.p1[1]),
      b = key(e.p2[0], e.p2[1]);
    bset.add(a + '|' + b);
    bset.add(b + '|' + a);
  }
  const out = [];
  for (let t = 0; t + 5 < interior.length; t += 6) {
    const ax = interior[t],
      ay = interior[t + 1],
      bx = interior[t + 2],
      by = interior[t + 3],
      cx = interior[t + 4],
      cy = interior[t + 5];
    const ka = key(ax, ay),
      kb = key(bx, by),
      kc = key(cx, cy);
    let n = 0;
    if (bset.has(ka + '|' + kb)) n++;
    if (bset.has(kb + '|' + kc)) n++;
    if (bset.has(kc + '|' + ka)) n++;
    if (n >= 2) {
      const gx = (ax + bx + cx) / 3,
        gy = (ay + by + cy) / 3;
      out.push(ax, ay, bx, by, gx, gy, bx, by, cx, cy, gx, gy, cx, cy, ax, ay, gx, gy);
    } else {
      out.push(ax, ay, bx, by, cx, cy);
    }
  }
  return out;
}
export function assemble(r, coords, tris, holeStarts, ramp) {
  // (The correct build's chain faces are taken below from the triangulation as it is: the centroid fan
  // this computes is for the line-row ramp, one line per face, which the chain faces do not use.)
  const sub =
    r.chainEdges && !r.fallback.length ? null : subdivideBoundaryTris(coords, tris, r.edges);
  // Interior triangles that touch a boundary feature become ramped pieces (curveCov at arcs,
  // kind-0 line ramps at straight edges); the rest stay solid. Gated by `ramp` — STATIC
  // builds opt in (text quality); the streaming road build/refresh stays off (its per-frame
  // guard outcomes would churn vertex counts). curveTris ride the `quads` array.
  // Analytic poly-clip interior (opt-in, straight glyphs): COARSE triangles (no
  // shatter/heal/tag), each carrying its local outline chain; the kind-0 fragment
  // clips it exactly. Pure-straight glyphs have no arcs so r.quads is empty — no
  // crescent double-cover.
  if (globalThis.__EDGE_TAP && r.edges && r.edges.length)
    globalThis.__EDGE_TAP.push(r.edges.map((e) => ({ p1: e.p1, p2: e.p2 })));
  // THE `correct` BUILD: coarse faces, each carrying its local outline chain (see buildRims'
  // chainEdges) -- no boundary shatter, no curve ramp. Chain rows are per-face constants.
  if (r.chainEdges && !r.fallback.length) {
    const interior = interiorFromTris(coords, tris),
      cc = [],
      tt = [];
    for (let i = 0; i + 1 < interior.length; i += 2) {
      cc.push([interior[i], interior[i + 1]]);
      tt.push(tt.length);
    }
    // The chain faces are built by lbFastResolve's rimChainsFromTris: interiorChainsFromTris's construction, face for
    // face and float for float, specialized to this input.
    const ch = rimChainsFromTris(cc, tt, r.chainEdges);
    return {
      interior,
      interiorEdges: null,
      interiorEdges2: null,
      interiorEdges3: null,
      interiorChainA: ch.chainA,
      interiorChainB: ch.chainB,
      interiorChainC: ch.chainC,
      interiorChainD: ch.hasChain2 ? ch.chainD : undefined,
      interiorChainE: ch.hasChain2 ? ch.chainE : undefined,
      interiorHasChain2: ch.hasChain2,
      quads: r.quads,
      cubics: r.cubics,
      edges: r.edges,
      fallback: r.fallback,
      hasConcave: r.hasConcave,
      _topo: { tris, holeStarts, rimLens: rimLens(r.rims), turns: r.turns, ramped: false },
    };
  }
  // The proven-general path (boundary shatter + kind-10 ramps). The analytic
  // chain path below returns this whenever its validity precondition fails.
  const splitPath = () => {
    // Doomed meshes do not get shattered. Every caller that can receive a concave or
    // fallback-carrying fast mesh discards it and rebuilds on the CDT (lbBuildCore, morphDraw,
    // loopBlinnMorph all gate on exactly this), so the interior split below is thrown away with
    // it. Returning the unsplit mesh is the same geometry, minus the ramping the caller was
    // never going to see.
    if (r.hasConcave || r.fallback.length)
      return {
        interior: interiorFromTris(sub.coords, sub.tris),
        interiorEdges: null,
        interiorEdges2: null,
        interiorEdges3: null,
        quads: r.quads,
        cubics: r.cubics,
        edges: r.edges,
        fallback: r.fallback,
        hasConcave: r.hasConcave,
        _topo: { tris, holeStarts, rimLens: rimLens(r.rims), turns: r.turns, ramped: false },
      };
    const split = splitInteriorByCurve(
      interiorFromTris(sub.coords, sub.tris),
      interiorEdgesFromTris(sub.coords, sub.tris, r.edges),
      r.chordArcs,
      r.vertexArcs,
      ramp,
      r.edges,
    );
    const quads = split.curveTris.length ? r.quads.concat(split.curveTris) : r.quads;
    return {
      interior: split.solid,
      interiorEdges: split.solidEdges,
      interiorEdges2: split.solidEdges2,
      interiorEdges3: split.solidEdges3,
      quads,
      cubics: r.cubics,
      edges: r.edges,
      fallback: r.fallback,
      hasConcave: r.hasConcave,
      _topo: { tris, holeStarts, rimLens: rimLens(r.rims), turns: r.turns, ramped: !!ramp },
    };
  };

  return splitPath();
}
// resolveSelfOverlap moved to shapeResolve.js — making a contour set simple is a fact about the
// geometry, and CPatch needs the same operation. Re-exported so existing importers are unaffected.
import { resolveSelfOverlap } from './shapeResolve.js';
import { resolveFastContours, cutPinches, rimChainsFromTris } from './lbFastResolve.js';
export { resolveSelfOverlap };

/// `correct` asks for a mesh that is right against exact coverage for ANY outline the builder takes.
/// The outline is resolved first (lbFastResolve.js): curves whose hulls overlap are
/// subdivided, pieces with no side halved, cusps split, pinched contours cut, collinear curves made
/// lines, non-boundary contours dropped, and each contour's fill side taken from the outline itself. A
/// shape that still cannot be drawn this way (a crossing outline, a loop) comes back DECLINED (fallback
/// non-empty, `declined` set) for the caller's correct route. The interior is then the constrained
/// Delaunay triangulation of the rims with analytic chain faces (buildRims' chainEdges), and a Bezout
/// crescent carries its keep half-plane. Off, the build is what it has always been.
export function buildLoopBlinnMesh(
  contours,
  ramp = true,
  fillRule,
  bailOnDecline = false,
  correct = false,
) {
  _healCand.length = 0;
  _setKeyOrigin(contours);
  const circ = circleFromContours(contours);
  if (circ)
    return {
      interior: new Float32Array(0),
      interiorEdges: null,
      quads: [],
      cubics: [],
      edges: [],
      fallback: [],
      circles: [circ],
      _topo: null,
    };
  // Kappa-cubic / coarse-quad full ellipses → one elliptical-SDF disc (kind 7).
  // Same salient win as circles: no high-κ cubic crescent spikes at the tips.
  const ell = ellipseFromContours(contours);
  if (ell)
    return {
      interior: new Float32Array(0),
      interiorEdges: null,
      quads: [],
      cubics: [],
      edges: [],
      fallback: [],
      circles: [ell],
      _topo: null,
    };
  // THE CALLER'S FILL RULE, not undefined. extractAnnuli consults it in exactly one place -- under
  // evenodd two same-WOUND concentric circles are an annulus, under nonzero they are not -- so
  // passing undefined made this path structurally unable to see an even-odd annulus, while
  // buildLoopBlinnCDT (which passes opts.fillRule) sees it. Two builders settling the same
  // question about the same SDF primitive and disagreeing. `fillRule` is this function's own
  // parameter and is already used for resolveSelfOverlap a few lines below.
  const _ann = extractAnnuli(contours, fillRule);
  if (_ann.annuli.length && !_ann.rest.length)
    return {
      interior: new Float32Array(0),
      interiorEdges: null,
      quads: [],
      cubics: [],
      edges: [],
      fallback: [],
      annuli: _ann.annuli,
      _topo: null,
    };
  // The caller's fill rule decides how a self-crossing resolves — an evenodd
  // pentagram keeps its center hole; hardcoding nonzero filled it solid
  // (diverging from Slug, whose walk honors the rule).
  let exact = null;
  if (correct) {
    // resolveFastContours FIRST: when no two pieces' hulls overlap or touch, the outline cannot cross
    // or meet itself, and resolveSelfOverlap (the exact intersection kernel over every bbox-overlapping
    // pair) returns it unchanged (checked over the corpus, raw and warped, both rules: 13,530 of 13,530)
    // -- so it runs only when the resolver declines, and the resolver then answers for what it made.
    let rs = resolveFastContours(contours, fillRule || 'nonzero', !!ramp);
    if (rs.decline) {
      const c2 = resolveSelfOverlap(contours, fillRule || 'nonzero');
      if (!c2) return null; // crossing outline → the caller's fallback
      rs = resolveFastContours(c2, fillRule || 'nonzero', !!ramp, true);
    }
    if (rs.decline)
      return {
        interior: new Float32Array(0),
        interiorEdges: null,
        quads: [],
        cubics: [],
        edges: [],
        fallback: [true],
        hasConcave: false,
        _topo: null,
        declined: rs.decline,
      };
    contours = rs.contours;
    exact = { sides: rs.sides, inFill: rs.inFill };
  } else {
    const resolved = resolveSelfOverlap(contours, fillRule || 'nonzero');
    if (!resolved) return null; // crossing outline → the caller's Slug fallback
    // A resolved crossing can come back PINCHED (an even-odd pentagram: its spikes as contours that pass
    // through a crossing vertex twice), which draws wrong or right by float luck (_starev: exact at its
    // authored coordinates, 5,250 pixels wrong moved 0.1%). Cut into loops. Only a set the
    // resolver changed is cut, so an outline it passes through keeps its topology exactly.
    contours = resolved === contours ? resolved : cutPinches(resolved);
  }
  // Cheap decline. buildRims is 71% of the cost of a build that gets thrown away, and every
  // verdict it reaches is a local side test that `scanConcavity` has already done for free by
  // this point (the preamble above, not the scan, is what a decline actually costs). Callers that
  // discard a declined mesh pass `bailOnDecline` and get the verdict without the mesh; the
  // streaming refresh path does not, because it uses the mesh either way.
  if (bailOnDecline) {
    const v = scanConcavity(contours, !!ramp);
    if (v !== 'accept' && v !== 'cubic')
      return {
        interior: new Float32Array(0),
        interiorEdges: null,
        quads: [],
        cubics: [],
        edges: [],
        fallback: v === 'loop' ? [true] : [],
        hasConcave: v === 'concave',
        _topo: null,
        declined: v,
      };
  }
  const r = buildRims(contours, !!ramp, exact);
  // A rim point equal to the one before it (a cubic whose control point sits on its end) is ONE vertex: the
  // triangulation would otherwise carry a zero-area face there, and the flips cannot cross one.
  if (correct)
    r.rims = r.rims.map((rim) =>
      rim.length < 2
        ? rim
        : rim.filter((p, i) => {
            const q = rim[(i + rim.length - 1) % rim.length];
            return p[0] !== q[0] || p[1] !== q[1];
          }),
    );
  const { coords, holeStarts, spans } = layoutRims(r.rims);
  const tris = correct ? triangulateLayoutFlip(coords, spans) : triangulateLayout(coords, spans);
  const mesh = assemble(r, coords, tris, holeStarts, ramp);

  if (ramp)
    mesh.bandArcs = mesh.quads
      .filter((q) => !q.circle && !q.tc)
      .map((q) => ({ tri: q.tri, sign: q.sign, w: q.w, e1: q.e1, e2: q.e2 }));
  // The correct build heals only a mesh with cubic crescents. Its interior is a triangulation of the rim
  // polygons with no added points, so the only T-junctions a crescent can meet come from a cubic hull
  // (a control point on another piece's hull edge).
  if (ramp && (!correct || mesh.cubics.length)) healCracks(mesh); // static: heal interior↔crescent T-junctions
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
  const E = mesh.interiorEdges,
    E2 = mesh.interiorEdges2,
    E3 = mesh.interiorEdges3;
  const quads = mesh.quads || [];
  const QT_STD = [0, 0, 1, 0.5, 0, 1, 1, 1, 1]; // kind-5 integral frame (Ũ,Ṽ,R≡1)
  const vset = [];
  const seen = new Set();
  const addV = (x, y) => {
    const k =
      Math.round((Math.fround(x) - _kox) * _koScale) * 262144 +
      Math.round((Math.fround(y) - _koy) * _koScale);
    if (!seen.has(k)) {
      seen.add(k);
      vset.push([x, y]);
    }
  };
  // Only SUBDIVISION MIDPOINTS can be T-vertices (original CDT vertices are shared
  // exactly by construction) — the creators (processTri corner cuts, chordPiece
  // splits) register candidates, collapsing the healer's scan from every mesh
  // vertex (~24% of the whole build) to a few dozen points.
  //
  // Candidates must ALSO be vertices of the FINAL mesh: a crack is a neighbor's
  // VERTEX sitting mid-edge, so a clip point that no emitted face kept cannot be
  // one — splitting there heals nothing and cascades (a junction-heavy glyph's
  // intermediate clip points blew 972 faces up to 4968).
  if (_healCand.length) {
    const emitted9 = new Set();
    const ek9 = (x, y) =>
      Math.round((Math.fround(x) - _kox) * _koScale) * 262144 +
      Math.round((Math.fround(y) - _koy) * _koScale);
    for (let i = 0; i < interior.length; i += 2) emitted9.add(ek9(interior[i], interior[i + 1]));
    for (const q of quads) {
      if (q.circle) continue;
      emitted9.add(ek9(q.tri[0], q.tri[1]));
      emitted9.add(ek9(q.tri[2], q.tri[3]));
      emitted9.add(ek9(q.tri[4], q.tri[5]));
    }
    for (const P9 of _healCand) {
      if (emitted9.has(ek9(P9[0], P9[1]))) addV(P9[0], P9[1]);
    }
  } else {
    for (let i = 0; i < interior.length; i += 2) addV(interior[i], interior[i + 1]);
    for (const q of quads) {
      if (q.circle) continue;
      addV(q.tri[0], q.tri[1]);
      addV(q.tri[2], q.tri[3]);
      addV(q.tri[4], q.tri[5]);
    }
  }
  // sorted by x: each face scans only its bbox's x-slice (binary-searched). As a full-vset
  // scan splitPt would be a large share of a glyph build, and a spatial hash loses to Map
  // overhead at glyph sizes — the sorted slice + bbox reject wins.
  vset.sort((A9, B9) => A9[0] - B9[0]);
  const splitPt = (A, B, C) => {
    const w9 = Math.max(A[0], B[0], C[0]) - Math.min(A[0], B[0], C[0]);
    const h9 = Math.max(A[1], B[1], C[1]) - Math.min(A[1], B[1], C[1]);
    const pad9 = 1e-4 * (w9 + h9);
    const bx0 = Math.min(A[0], B[0], C[0]) - pad9,
      bx1 = Math.max(A[0], B[0], C[0]) + pad9;
    const by0 = Math.min(A[1], B[1], C[1]) - pad9,
      by1 = Math.max(A[1], B[1], C[1]) + pad9;
    let lo9 = 0,
      hi9 = vset.length;
    while (lo9 < hi9) {
      const mid9 = (lo9 + hi9) >> 1;
      if (vset[mid9][0] < bx0) lo9 = mid9 + 1;
      else hi9 = mid9;
    }
    for (let vi9 = lo9; vi9 < vset.length; vi9++) {
      const V = vset[vi9];
      if (V[0] > bx1) break;
      if (V[1] < by0 || V[1] > by1) continue;
      for (let ei = 0; ei < 3; ei++) {
        const P0 = ei === 0 ? A : ei === 1 ? B : C;
        const P1 = ei === 0 ? B : ei === 1 ? C : A;
        const ex = P1[0] - P0[0],
          ey = P1[1] - P0[1];
        const L2 = ex * ex + ey * ey;
        {
          const u9 = tjUlp(P0, P1);
          if (!(L2 > u9 * u9)) continue;
        }
        const rx = V[0] - P0[0],
          ry = V[1] - P0[1];
        const t = (rx * ex + ry * ey) / L2;
        if (t < 0.02 || t > 0.98) continue;
        const dx = rx - t * ex,
          dy = ry - t * ey;
        // The same true-T-junction gate as the patchers in lbInteriorSplit: a shared point differs by float32
        // rounding, one ulp of the coordinates. A share of the edge's length grabs a vertex that is merely near a
        // long edge and bends the edge through it: on a polygon 500 to 1, a vertex 2.3 units from a 30000-unit edge
        // took everything between them, 3% of the fill.
        const g9 = tjUlp(P0, P1, V);
        if (dx * dx + dy * dy > g9 * g9) continue;
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
    const CH = [
      mesh.interiorChainA,
      mesh.interiorChainB,
      mesh.interiorChainC,
      mesh.interiorChainD,
      mesh.interiorChainE,
    ];
    const sIn = Array.from(interior);
    const work = [];
    for (let t = 0, e = 0, e2 = 0; t < sIn.length; t += 6, e += 9, e2 += 12) {
      work.push({
        P: [
          [sIn[t], sIn[t + 1]],
          [sIn[t + 2], sIn[t + 3]],
          [sIn[t + 4], sIn[t + 5]],
        ],
        e: E ? Array.from(E.slice(e, e + 9)) : null,
        e2: E2 ? Array.from(E2.slice(e2, e2 + 12)) : null,
        e3: E3 ? Array.from(E3.slice(e2, e2 + 12)) : null,
        ch: CH.map((c) => (c ? Array.from(c.slice(e2, e2 + 12)) : null)),
      });
    }
    const out = [];
    let guard = work.length * 8;
    while (work.length) {
      const w = work.pop();
      const sp = guard-- > 0 ? splitPt(w.P[0], w.P[1], w.P[2]) : null;
      if (!sp) {
        out.push(w);
        continue;
      }
      const { ei, V } = sp;
      const Pa = w.P[ei],
        Pb = w.P[(ei + 1) % 3],
        Pc = w.P[(ei + 2) % 3];
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
      if (q.circle) {
        outQ.push(q);
        continue;
      }
      const A = [q.tri[0], q.tri[1]],
        B = [q.tri[2], q.tri[3]],
        C = [q.tri[4], q.tri[5]];
      const sp = guard-- > 0 ? splitPt(A, B, C) : null;
      if (!sp) {
        outQ.push(q);
        continue;
      }
      const { ei, V } = sp;
      const tc = q.tc
        ? Array.from(q.tc)
        : !q.w || q.w === 1
          ? QT_STD.slice()
          : [0, 0, 1, 0.5 * (1 / q.w), 0, 1 / q.w, 1, 1, 1];
      const P = [A, B, C];
      const Pa = P[ei],
        Pb = P[(ei + 1) % 3],
        Pc = P[(ei + 2) % 3];
      const ta = tc.slice(ei * 3, ei * 3 + 3),
        tb = tc.slice(((ei + 1) % 3) * 3, ((ei + 1) % 3) * 3 + 3),
        tcC = tc.slice(((ei + 2) % 3) * 3, ((ei + 2) % 3) * 3 + 3);
      const exq = Pb[0] - Pa[0],
        eyq = Pb[1] - Pa[1];
      const tq = Math.abs(exq) > Math.abs(eyq) ? (V[0] - Pa[0]) / exq : (V[1] - Pa[1]) / eyq;
      const tv = [
        ta[0] + (tb[0] - ta[0]) * tq,
        ta[1] + (tb[1] - ta[1]) * tq,
        ta[2] + (tb[2] - ta[2]) * tq,
      ];
      const mk = (p0, t0, p1, t1, p2, t2) => ({
        ...q,
        tri: new Float32Array([p0[0], p0[1], p1[0], p1[1], p2[0], p2[1]]),
        tc: new Float32Array([...t0, ...t1, ...t2]),
      });
      work.push(mk(Pa, ta, V, tv, Pc, tcC));
      work.push(mk(V, tv, Pb, tb, Pc, tcC));
    }
    mesh.quads = outQ;
  }
}
