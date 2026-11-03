// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbPartitionPair.js — the partition morph pair: build the STATIC partition
// mesh on the SRC endpoint (lbPartition, unmodified), then derive the DST mesh by
// Provenance transform against the DST hulls with the same frame helpers,
// so topology is identical by construction and the pair packs into the
// dual-stream morph VBO (VS lerps positions/frames; t=0/1 equal the static
// renders wherever the two poses plan their cubic splits alike).
import { SEG_LINE, SEG_CUBIC, SEG_RQUAD } from '../primitives/seg.js';
import {
  bezoutCubicImplicit,
  cubicKLMN,
  cubicPt,
  cubicSignKLMN,
  cubicSubCp,
  cubicSupport9,
  evalBezout,
  splitCubicMulti,
  uvInHull,
  cubicSign,
  klmnWidestFrame9,
  cubicInflections,
  cubicSignAtPoint,
  cubicKLMNSerpentine,
} from '../geom/lbCubicMath.js';
import {
  _kox,
  _koy,
  _koScale,
  _setKeyOrigin,
  emUnitsOf,
  rayWindingExact,
  closeOpenContours,
  calibrateInterior,
  verifyInteriorSign,
  segTangents,
  edgeEndMeta,
  fatArc,
} from '../geom/lbContour.js';
import { splitInteriorByCurve } from './lbInteriorSplit.js';
import { selfOrientRows, interiorEdgesFromTriPoints } from './lbFastMesh.js';
import {
  buildLoopBlinnPartition,
  splitOverlappingQuadHullsPair9,
  cubicSplitPlan9,
  chainMid9,
  chainQuadAt9,
} from './lbPartition.js';

// ── PARTITION MORPH PAIR ──────────────────────────────────────────────────────
// One code path for morphs: build the STATIC partition mesh on the SRC endpoint
// (the unmodified builder), then derive the DST mesh by PROVENANCE TRANSFORM —
// every emitted vertex is a seg point (registered under the same quantized
// key), every frame recomputes against the DST hull with the same helpers
// (uvInHull / edgeEndMeta / interiorEdgesFromTriPoints).
// Identical topology by construction, so the pair packs into a dual-stream
// morph VBO where the VS lerps positions/frames. Cubic-bearing pairs cut both
// poses at one merged plan from the builder's own cubicSplitPlan9 (the caller
// t-segments when mid-morph drift exceeds the oracle). Returns null (caller falls back to the
// t-segmented pair or Slug) for: structure mismatch, convex↔concave flips,
// near-flat disagreement, strip-plan divergence, clip-produced (unmapped)
// vertices, circles/annuli (kind-7 SDF records have no pair transform).

/// WHY the last pair build declined — the cause travels with the answer.

/// A live ESM binding, so an importer reads the current value without an accessor. Read it
/// immediately after a null return; any later call overwrites it.
export let lbPairDeclineWhy = null;
const _bail9 = (why) => {
  lbPairDeclineWhy = why;
  return null;
};

export function buildLoopBlinnPartitionPair(srcContours, dstContours, fillRule, opts) {
  lbPairDeclineWhy = null;
  // Both poses closed as SVG fills them, before any structure is compared: a pose's closing line is a
  // segment of its own, matched with the other pose's.
  srcContours = closeOpenContours(srcContours);
  dstContours = closeOpenContours(dstContours);
  if (!srcContours || !dstContours || srcContours.length !== dstContours.length)
    return _bail9('structure');
  for (let c = 0; c < srcContours.length; c++) {
    const sc = srcContours[c],
      dc = dstContours[c];
    if (!dc || sc.length !== dc.length) return _bail9('structure');
    for (let i = 0; i < sc.length; i++) {
      if (sc[i].type !== dc[i].type) return _bail9('structure');

      if (sc[i].type === SEG_RQUAD && Math.abs((sc[i].w || 1) - (dc[i].w || 1)) > 1e-9)
        return _bail9('structure');
    }
  }
  const transient9 = !!(opts && opts.plainDstRows); // segment pairs: plain rows both endpoints
  // Overlapping quad hulls are halved on both poses before the source builds: the static build's split, which the
  // pair's builder skips (see splitOverlappingQuadHullsPair9). Everything below reads the split lists, so contour and
  // segment indices agree across the poses; vertices still key on the AUTHORED source.
  const authoredSrc9 = srcContours,
    authoredDst9 = dstContours;
  [srcContours, dstContours] = splitOverlappingQuadHullsPair9(srcContours, dstContours, fillRule);
  // ONE SPLIT PLAN PER CUBIC, AND both POSES CUT AT IT. The builder splits a cubic until nothing else of its shape is
  // inside a piece's hull and until a Bezout piece's implicit is an honest distance, and both answers depend on the
  // pose. Each pose's plan comes from the builder's own function and the two are merged: the source builds at the
  // merged cuts (a cut the source did not need only shrinks a hull, the curve is unchanged), every piece point is
  // registered at them, and the destination splits at the same parameters -- exact at every t, because a Bezier split
  // is linear in the control points and so commutes with the vertex stage's lerp.
  const plans9 = pairCubicPlans9(
    srcContours,
    dstContours,
    authoredSrc9,
    authoredDst9,
    !!(opts && opts.serpentine9),
  );
  const planOf9 = (ci, si) => plans9.get(ci + '|' + si) || { ts: [], fatTs: new Set() };
  // The destination's pieces of one cubic, cut at the merged plan (memoized: the source's chain route, the chain
  // registration and the cubic pass all read them).
  const dstPieceOf9 = new Map(); // 'ci|si' → dst pieces array
  const dstPieces9 = (ci, si) => {
    const k = ci + '|' + si;
    let pd = dstPieceOf9.get(k);
    if (!pd) {
      const sgD = dstContours[ci][si];
      pd = splitCubicMulti([sgD.p1, sgD.p2, sgD.p3, sgD.p4], planOf9(ci, si).ts);
      dstPieceOf9.set(k, pd);
    }
    return pd;
  };
  // skipCurveInterior: pair transforms quads by hull `_hi9`; fill-side curveTris
  // from the static bowl fix have none → pair would return null → Slug morph.
  // pairChains9: the interior takes the static build's analytic CHAIN route wherever that build would, and the
  // destination's chains are the source's mapped point by point (below). `chains9: false` is the row-mode build this
  // falls back to when a chain point has no destination.
  const chains9 = !(opts && opts.chains9 === false);
  // pairDstPiece9: the chain route picks a piece's chain by its shape at every t, so it reads the destination piece too.
  const src = buildLoopBlinnPartition(srcContours, {
    fillRule: fillRule || 'nonzero',
    plainRows: transient9,
    skipCurveInterior: !transient9,
    noReorient: true,
    keyContours: authoredSrc9,
    cubicPlans9: plans9,
    pairChains9: chains9,
    pairDstPiece9: (ci, si, pi) =>
      (dstContours[ci] && dstContours[ci][si] && dstContours[ci][si].type === SEG_CUBIC
        ? dstPieces9(ci, si)[pi]
        : null) || null,
  });
  if (!src || (src.fallback && src.fallback.length)) return _bail9('source-declined');
  // Circle SDF records do not have a partition-pair transform.
  for (const q of src.quads) if (/** @type {any} */ (q).circle) return _bail9('source-circle');

  // ── THE PAIR'S TWO LENGTH UNITS ──────────────────────────────────────────────
  // Every bail below tests a LENGTH, an AREA or a coordinate MATCH, and each one of those is a
  // quantity with a size: written against a constant it asks a different question of the same
  // drawing at a different size, which is the defect this builder shared with the static build
  // (see lbContour.js's `_setKeyOrigin`, where the units are defined and derived).
  //
  // A PAIR HAS TWO UNITS, not one. The SOURCE owns the key origin -- every registration and lookup
  // below is keyed against it -- so `emEps()` is the source's and stays live. The DESTINATION is a
  // second shape and may be a very different size (a pose that grows or shrinks through the morph
  // is the ordinary case, not a corner), so the dst-side tests take the dst's own units. Measuring
  // a shrinking destination in the source's units is the same mistake a flat constant makes, one
  // indirection later.
  const emD9 = emUnitsOf(authoredDst9);
  // ...AND ONE TEST THAT NEEDS NEITHER. A CROSS PRODUCT is not a length or an area to be compared
  // with the shape: |a x b| = |a| |b| sin(t), and what every cross product below guards is whether
  // its two vectors are PARALLEL -- a divisor's conditioning, or which side of a chord a control
  // mid lies on. `sin(t)` is dimensionless, so a bar on it is scale-free with nothing to calibrate,
  // and it is also the honest question: the barycentric weights a degenerate divisor produces carry
  // relative error about 2^-52 / sin(t), so 2^-52 is exactly "parallel to the last bit of float64".

  const par9 = (ax, ay, bx, by) => Math.hypot(ax, ay) * Math.hypot(bx, by) * 2 ** -52;
  // key(srcPoint) → dstPoint, same quantization the builder registered under
  _setKeyOrigin(authoredSrc9);
  const kOf = (x, y) =>
    Math.round((x - _kox) * _koScale) * 2097152 + Math.round((y - _koy) * _koScale);
  // every registration in a bucket, in order: two distinct points can share one (see mapPt).
  const map9 = new Map();
  const reg9 = (x, y, d) => {
    const k = kOf(x, y),
      l = map9.get(k),
      r = { s: [x, y], d };
    if (l) l.push(r);
    else map9.set(k, [r]);
  };
  for (let c = 0; c < srcContours.length; c++) {
    const sc = srcContours[c],
      dc = dstContours[c];
    for (let i = 0; i < sc.length; i++) {
      const sg = sc[i],
        dg = dc[i];
      reg9(sg.p1[0], sg.p1[1], dg.p1);
      if (sg.type === SEG_LINE) reg9(sg.p2[0], sg.p2[1], dg.p2);
      else if (sg.type === SEG_CUBIC) {
        // the builder cuts this cubic at its merged plan -- register every PIECE point, split the same way on both
        // endpoints
        reg9(sg.p2[0], sg.p2[1], dg.p2);
        reg9(sg.p3[0], sg.p3[1], dg.p3);
        reg9(sg.p4[0], sg.p4[1], dg.p4);
        const P0s = [sg.p1, sg.p2, sg.p3, sg.p4],
          P0d = [dg.p1, dg.p2, dg.p3, dg.p4];
        const plan = planOf9(c, i);
        if (plan.ts.length) {
          const ps = splitCubicMulti(P0s, plan.ts),
            pd = splitCubicMulti(P0d, plan.ts);
          for (let k = 0; k < ps.length; k++)
            for (let j = 0; j < 4; j++) reg9(ps[k][j][0], ps[k][j][1], pd[k][j]);
        }
      } else {
        reg9(sg.p2[0], sg.p2[1], dg.p2);
        reg9(sg.p3[0], sg.p3[1], dg.p3);
      }
    }
  }
  // The chain route's own outline points. A chain is a window onto the outline polyline, and the polyline's vertices are
  // piece ends (registered above) plus the points the builder put BETWEEN them: each cubic piece's on-curve midpoint,
  // and each quad hull's subdivision points. Each is registered against the same construction on the destination --
  // the same parameter on the same piece, by the builder's own formula, so the registration and the chain array hold
  // the same float64 value and the lookup below is by identity.
  if (src.interiorChainA) {
    for (const h of src.hulls9 || []) {
      if (h.invis9 || !(h._chainN9 > 1)) continue;
      const dg = dstContours[h.ci9][h.si9],
        w = h.w || 1,
        n = h._chainN9;
      for (let i = 1; i < n; i++) {
        const ps = chainQuadAt9(h.a, h.c, h.b, w, i / n);
        reg9(ps[0], ps[1], chainQuadAt9(dg.p1, dg.p2, dg.p3, w, i / n));
      }
    }
    for (const rec of src.cubicRecs9 || []) {
      if (!rec._chainMid9) continue;
      const cpD = dstPieces9(rec.ci9, rec.si9)[rec.pi9];
      if (cpD) reg9(rec._chainMid9[0], rec._chainMid9[1], chainMid9(cpD));
    }
  }
  // Looked up from the vertex as stored. Registration keys a point by its float64 coordinates, as the builder's add() does,
  // but the mesh hands its vertices back in Float32Arrays, and a float32 coordinate at the edge of a key bucket rounds
  // into the neighboring one. Containment and faithfulness splitting cut cubics at arbitrary parameters, so enough piece
  // points sit on a bucket edge that most smooth-cubic morphs declined on a vertex this pair HAD registered, and drew
  // through Slug. A miss therefore tries the eight neighboring buckets for the registration whose float32 image is the
  // stored vertex -- the same vertex, not merely a near one.

  // `exact` refuses that last answer: a lookup that must find this point, or report that it has none.
  const mapPt = (x, y, exact = false) => {
    const fx = Math.fround(x),
      fy = Math.fround(y);
    const same = (l) => {
      if (l)
        for (let j = l.length - 1; j >= 0; j--)
          if (Math.fround(l[j].s[0]) === fx && Math.fround(l[j].s[1]) === fy) return l[j].d;
      return null;
    };
    const own = map9.get(kOf(x, y));
    let d = same(own);
    if (d) return d;
    const kx = Math.round((x - _kox) * _koScale),
      ky = Math.round((y - _koy) * _koScale);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        d = same(map9.get((kx + dx) * 2097152 + (ky + dy)));
        if (d) return d;
      }
    if (own && !exact) return own[own.length - 1].d;
    // NOT a decline: `mapPt` answers a LOOKUP, and each caller decides what a miss means to it —
    // an interior vertex, a fan corner and a cap vertex are three different causes. Stamping here
    // would give every one of them this answer, and would leave a cause behind on a build that
    // tolerated the miss and then succeeded.
    return null;
  };

  for (const st9 of src.steiner9 || []) {
    const pa = mapPt(st9.pa[0], st9.pa[1]),
      pb = mapPt(st9.pb[0], st9.pb[1]);
    const pc = mapPt(st9.pc[0], st9.pc[1]),
      pd = mapPt(st9.pd[0], st9.pd[1]);
    if (!pa || !pb || !pc || !pd) return _bail9('steiner-unmapped');
    const rx = pb[0] - pa[0],
      ry = pb[1] - pa[1],
      sx = pd[0] - pc[0],
      sy = pd[1] - pc[1];
    const den = rx * sy - ry * sx;
    // THE TWO DST EDGES MUST still CROSS, and crossing is a question about their directions (par9).
    // A fixed bar such as 1e-18 would be 6e-23 of one shape's span squared and 1.1e-6 of a 2^-20
    // drawing's, so it would decide nothing at one size and decline the whole pair at the other.
    if (!(Math.abs(den) > par9(rx, ry, sx, sy))) return _bail9('steiner-parallel');
    const t = ((pc[0] - pa[0]) * sy - (pc[1] - pa[1]) * sx) / den;
    const u = ((pc[0] - pa[0]) * ry - (pc[1] - pa[1]) * rx) / den;
    if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9)
      return _bail9('steiner-parameter');
    reg9(st9.pt[0], st9.pt[1], [pa[0] + t * rx, pa[1] + t * ry]);
  }

  // The chain refinement's split points: each is its face's centroid, so on the destination it is the
  // centroid of the corners' images. A corner with no image is a vertex the interior map below would refuse as well.
  for (const g9 of src.centroids9 || []) {
    const pa = mapPt(g9.a[0], g9.a[1]),
      pb = mapPt(g9.b[0], g9.b[1]),
      pc = mapPt(g9.c[0], g9.c[1]);
    if (!pa || !pb || !pc) return _bail9('unmapped-vertex');
    reg9(g9.pt[0], g9.pt[1], [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3]);
  }

  // dst-side per-contour calibration — exact seg winding (the builder's own
  // inkAt semantics): chord-ring polygonization misreads probes inside THIN
  // slivers (the crescent's dst sign check false-bailed on it).
  const allSegsD = [];
  for (const dc of dstContours) for (const sg of dc) allSegsD.push(sg);
  const evenoddD = fillRule === 'evenodd';

  const inFillD = (p) => {
    const w = rayWindingExact(allSegsD, p[0], p[1]);
    return evenoddD ? (w & 1) !== 0 : w !== 0;
  };
  // VERIFIED, AS THE BUILDER VERIFIES THE SOURCE. The builder corrects calibrateInterior with a direct travel-frame
  // probe (verifyInteriorSign); this pass took the calibration alone, so wherever the two disagree the destination's
  // edge normals and band end metadata came out with the opposite sign from the source's. lbGpuMorphSmoke's outer
  // circle is the same curve in both poses and still packed every band's neighbor normals negated on the destination
  // stream, so t = 1 did not pack what the static build of that pose packs and the vertex stage mixed each normal with
  // its own negation in between. The band kernel reads those normals in its corner combine and its faint-exterior
  // discard; verified, the destination's bands are byte-identical to the static build's.
  const interiorSignD = dstContours.map((dc) =>
    verifyInteriorSign(dc, inFillD, calibrateInterior(dc, inFillD)),
  );

  // interior: pure vertex map
  const si = src.interior,
    di = new Float32Array(si.length);
  for (let i = 0; i < si.length; i += 2) {
    const mp = mapPt(si[i], si[i + 1]);
    if (!mp) return _bail9('unmapped-vertex'); // clip/Steiner vertex → bail
    di[i] = mp[0];
    di[i + 1] = mp[1];
  }
  // ...and its chains, point for point: the same window of the same outline on the destination, in the same order, so
  // the fill-left orientation each face's window was built with carries over. A chain point with no destination falls
  // back to the row-mode pair rather than guessing (a window pointing at the wrong outline clips real ink).
  let chainsD9 = null;
  if (src.interiorChainA) {
    chainsD9 = mapChains9(src, (x, y) => mapPt(x, y, true));
    if (!chainsD9)
      return buildLoopBlinnPartitionPair(authoredSrc9, authoredDst9, fillRule, {
        ...(opts || {}),
        chains9: false,
      });
  }

  // hulls → dst hulls (per-seg), with convex/concave flip + strip-plan checks
  const hullsD = new Array(src.hulls9.length);
  for (let hi = 0; hi < src.hulls9.length; hi++) {
    const h = src.hulls9[hi];
    const dg = dstContours[h.ci9][h.si9];
    const hd = {
      a: [dg.p1[0], dg.p1[1]],
      c: [dg.p2[0], dg.p2[1]],
      b: [dg.p3[0], dg.p3[1]],
      w: h.w,
      sign: h.sign,
    };
    const crossS = (h.b[0] - h.a[0]) * (h.c[1] - h.a[1]) - (h.b[1] - h.a[1]) * (h.c[0] - h.a[0]);
    const crossD =
      (hd.b[0] - hd.a[0]) * (hd.c[1] - hd.a[1]) - (hd.b[1] - hd.a[1]) * (hd.c[0] - hd.a[0]);
    if (crossS === 0 || crossD === 0 || crossS > 0 !== crossD > 0) return _bail9('quad-ctrl-flip'); // ctrl crossed the chord
    hd.fat = fatArc(hd.a[0], hd.a[1], hd.c[0], hd.c[1], hd.b[0], hd.b[1]);
    if (!!h.fat !== !!hd.fat) return _bail9('quad-strip-plan'); // pack strip plan (6 vs 15 verts) would diverge
    hullsD[hi] = hd;
  }

  // quads: mapped tris, tc reframed against the dst hull (same uvInHull)
  const quadsD = new Array(src.quads.length);
  for (let qi = 0; qi < src.quads.length; qi++) {
    const q = src.quads[qi];
    const hd = q._hi9 != null ? hullsD[q._hi9] : null;
    if (!hd) return _bail9('hull-missing');
    const T = q.tri,
      TD = new Float32Array(6),
      tcD = new Float32Array(9);
    for (let k = 0; k < 3; k++) {
      const mp = mapPt(T[2 * k], T[2 * k + 1]);
      if (!mp) return _bail9('hull-vertex-unmapped');
      TD[2 * k] = mp[0];
      TD[2 * k + 1] = mp[1];
      const uv = uvInHull(hd, mp[0], mp[1]);
      if (!uv) return _bail9('hull-uv');
      tcD[3 * k] = uv[0];
      tcD[3 * k + 1] = uv[1];
      tcD[3 * k + 2] = uv[2];
    }
    quadsD[qi] = { tri: TD, tc: tcD, sign: q.sign, w: q.w };
  }

  // edges: rebuilt from the dst segs with the same emit math + end metadata
  const dtg = dstContours.map((dc) => dc.map(segTangents));
  const edgesD = new Array(src.edges.length);
  for (let ei = 0; ei < src.edges.length; ei++) {
    const e = src.edges[ei];
    if (e.ci9 == null) return _bail9('edge-no-contour');
    const dc = dstContours[e.ci9],
      dg = dc[e.si9];
    const outD = -interiorSignD[e.ci9];
    let p1d, p2d;
    if (e.flat9 === 'arc') {
      // the SRC piece was near-flat (sag < 0.4% chord) and emitted a LINE —
      // the DST piece must agree or the pair geometry lies
      const chx = dg.p3[0] - dg.p1[0],
        chy = dg.p3[1] - dg.p1[1];
      const chL = Math.hypot(chx, chy);
      const sag =
        chL > 0
          ? Math.abs((dg.p2[0] - dg.p1[0]) * (chy / chL) - (dg.p2[1] - dg.p1[1]) * (chx / chL))
          : 0;
      if (sag >= 0.004 * chL) return _bail9('edge-sag');
      p1d = dg.p1;
      p2d = dg.p3;
    } else if (e.flat9 === 'cubic') {
      // Near-line CUBIC demotion spans p1→p4 — dg.p2 is the first CONTROL
      // point (~⅓ along the curve); building the dst edge on it would misplace
      // the straight-edge AA/strips at t→1. Same near-flat re-check as
      // the arc branch (both control points must hug the chord).
      const chx = dg.p4[0] - dg.p1[0],
        chy = dg.p4[1] - dg.p1[1];
      const chL = Math.hypot(chx, chy);
      if (chL > 0) {
        const nx9 = chy / chL,
          ny9 = -chx / chL;
        const s2 = Math.abs((dg.p2[0] - dg.p1[0]) * nx9 + (dg.p2[1] - dg.p1[1]) * ny9);
        const s3 = Math.abs((dg.p3[0] - dg.p1[0]) * nx9 + (dg.p3[1] - dg.p1[1]) * ny9);
        if (Math.max(s2, s3) >= 0.004 * chL) return _bail9('edge-sag');
      }
      p1d = dg.p1;
      p2d = dg.p4;
    } else {
      p1d = dg.p1;
      p2d = dg.p2;
    }
    const ex = p2d[0] - p1d[0],
      ey = p2d[1] - p1d[1],
      L = Math.hypot(ex, ey);
    if (!(L > 0)) return _bail9('edge-length');
    edgesD[ei] = {
      p1: p1d,
      p2: p2d,
      nx: (-ey / L) * outD,
      ny: (ex / L) * outD,
      out: outD,
      e1: edgeEndMeta(dc, dtg[e.ci9], e.si9, 0, interiorSignD[e.ci9]),
      e2: edgeEndMeta(dc, dtg[e.ci9], e.si9, 1, interiorSignD[e.ci9]),
    };
  }

  // strips: dst seg control points + end meta (kind-12 needs e1/e2 on both streams)
  const stripsD = new Array(src.stripArcs.length);
  for (let ti = 0; ti < src.stripArcs.length; ti++) {
    const sa = src.stripArcs[ti];
    if (sa.ci9 == null) return _bail9('strip-no-contour');
    const dc = dstContours[sa.ci9],
      dg = dc[sa.si9];
    stripsD[ti] = {
      tri: new Float32Array([dg.p1[0], dg.p1[1], dg.p2[0], dg.p2[1], dg.p3[0], dg.p3[1]]),
      sign: sa.sign,
      w: sa.w,
      ci9: sa.ci9,
      si9: sa.si9,
      e1: edgeEndMeta(dc, dtg[sa.ci9], sa.si9, 0, interiorSignD[sa.ci9]),
      e2: edgeEndMeta(dc, dtg[sa.ci9], sa.si9, 1, interiorSignD[sa.ci9]),
    };
  }

  // cubic pieces: rebuild each rec's frame on the DST endpoint — same split
  // plan (piece correspondence), same classifiers (cubicKLMN / bezout), klmn
  // rows read over the dst piece's own control points (dstKlmnFrame9). Bails: hull
  // point-set change, frame-mode change (klmn↔Bezout health divergence), sign flip.
  const cubicsD = new Array(src.cubics.length);
  const recsDst9 = new Map(); // rec idx → { cpD, klmnD, FD, frameD }
  // invisible-boundary recs emit NO cubic entries (their region fills solid) —
  // still verify the dst endpoint is ALSO invisible there, else the solid is a lie
  for (const rec of src.cubicRecs9 || []) {
    if (!rec.invis9) continue;
    const sgS = srcContours[rec.ci9][rec.si9],
      sgD = dstContours[rec.ci9][rec.si9];
    const plan = planOf9(rec.ci9, rec.si9);
    const piecesD = splitCubicMulti([sgD.p1, sgD.p2, sgD.p3, sgD.p4], plan.ts);
    const cpD = piecesD[rec.pi9];
    if (!cpD) return _bail9('invisible-cubic-piece');
    const cmD = [
      0.125 * cpD[0][0] + 0.375 * cpD[1][0] + 0.375 * cpD[2][0] + 0.125 * cpD[3][0],
      0.125 * cpD[0][1] + 0.375 * cpD[1][1] + 0.375 * cpD[2][1] + 0.125 * cpD[3][1],
    ];
    const ctrlMidD = [(cpD[1][0] + cpD[2][0]) / 2, (cpD[1][1] + cpD[2][1]) / 2];
    const txD = cpD[1][0] - cpD[0][0] + 2 * (cpD[2][0] - cpD[1][0]) + (cpD[3][0] - cpD[2][0]);
    const tyD = cpD[1][1] - cpD[0][1] + 2 * (cpD[2][1] - cpD[1][1]) + (cpD[3][1] - cpD[2][1]);
    let nxD = -tyD,
      nyD = txD;
    const nlD = Math.hypot(nxD, nyD);
    const chordD = Math.hypot(cpD[3][0] - cpD[0][0], cpD[3][1] - cpD[0][1]);
    // Two lengths on the dst piece: the normal about to be divided by, and the chord the ink probe's
    // offset is a fraction of. Below one float32 ulp of the dst's extent neither is a length -- the
    // two probe points are the same packed position -- which is what emEps means.
    if (nlD < emD9.eps || chordD < emD9.eps) return _bail9('invisible-cubic-degenerate');
    if (nxD * (ctrlMidD[0] - cmD[0]) + nyD * (ctrlMidD[1] - cmD[1]) < 0) {
      nxD = -nxD;
      nyD = -nyD;
    }
    const offD = 0.05 * chordD;
    if (!(
      inFillD([cmD[0] + (nxD / nlD) * offD, cmD[1] + (nyD / nlD) * offD]) &&
      inFillD([cmD[0] - (nxD / nlD) * offD, cmD[1] - (nyD / nlD) * offD])
    ))
      return _bail9('invisible-cubic-dst-ink');
  }
  // same for invisible quad hulls
  for (const h of src.hulls9 || []) {
    if (!h.invis9) continue;
    const dg = dstContours[h.ci9][h.si9];
    const wD = dg.w || 1,
      dmD = 2 + 2 * wD;
    const qmxD = (dg.p1[0] + 2 * wD * dg.p2[0] + dg.p3[0]) / dmD;
    const qmyD = (dg.p1[1] + 2 * wD * dg.p2[1] + dg.p3[1]) / dmD;
    let nxD = dg.p2[0] - qmxD,
      nyD = dg.p2[1] - qmyD;
    const nlD = Math.hypot(nxD, nyD);
    if (nlD < emD9.eps) return _bail9('invisible-quad-degenerate'); // the quad's own sagitta, in dst units (see emD9)
    const offD = 0.25 * nlD;
    if (!(
      inFillD([qmxD + (nxD / nlD) * offD, qmyD + (nyD / nlD) * offD]) &&
      inFillD([qmxD - (nxD / nlD) * offD, qmyD - (nyD / nlD) * offD])
    ))
      return _bail9('invisible-quad-dst-ink');
  }
  for (let ci = 0; ci < src.cubics.length; ci++) {
    const e = src.cubics[ci];
    if (e._ri9 == null) return _bail9('cubic-no-rec');
    const rec = src.cubicRecs9[e._ri9];
    let rd = recsDst9.get(e._ri9);
    if (!rd) {
      const cpD = dstPieces9(rec.ci9, rec.si9)[rec.pi9];
      if (!cpD) return _bail9('dst-piece-missing');
      // A bezout pair is conditioned by the source's scale on both poses. The frame
      // divides by a scale taken from its own control points — a max of absolute
      // values — and that is not linear in t: it kinks where an absolute turns and
      // again where a different control point takes over the max. The vertex stage
      // LERPS the packed coefficients, so a kink in the scale is a kink the lerp
      // cannot follow, and the two poses' coefficients are not even commensurate.

      let klmnD = null,
        FD = null;
      if (rec.rows) {
        // A serpentine whose d1 is at or below cubicKLMN's bar -- the point-symmetric S-curve, d1 = 0 exactly -- still has
        // an exact frame (cubicKLMNSerpentine, same orientation): the bar guards that function's own cancellation, not
        // the curve.
        klmnD = cubicKLMN(cpD) || cubicKLMNSerpentine(cpD);
        if (!klmnD) return _bail9('dst-klmn-frame'); // frame-health divergence → bail
      } else {
        FD = bezoutCubicImplicit(cpD, rec.F ? rec.F.s : 0);
        if (!FD) return _bail9('dst-bezout-frame');
      }
      // CLASSIFICATION must hold on the dst endpoint: recompute the side-bit
      // with the dst winding and the dst sign with the same classifiers — a
      // convex↔concave flip (or an invisible boundary becoming real) cannot be
      // expressed by a lerped frame → bail to the caller's fallback.
      // GEOMETRIC flip check first: the control-mid's SIDE of the chord must be
      // preserved — the sign classifiers are blind to a flip (the frame mirrors
      // AND the ink side swaps, so the composed sign comes out EQUAL: the flip
      // smoke's bulge-up→bulge-down cubic built a lying pair without this).
      {
        const cpS = rec.cp;
        const chSx = cpS[3][0] - cpS[0][0],
          chSy = cpS[3][1] - cpS[0][1];
        const cmSx = (cpS[1][0] + cpS[2][0]) / 2 - cpS[0][0],
          cmSy = (cpS[1][1] + cpS[2][1]) / 2 - cpS[0][1];
        const crS = chSx * cmSy - chSy * cmSx;
        const chDx = cpD[3][0] - cpD[0][0],
          chDy = cpD[3][1] - cpD[0][1];
        const cmDx = (cpD[1][0] + cpD[2][0]) / 2 - cpD[0][0],
          cmDy = (cpD[1][1] + cpD[2][1]) / 2 - cpD[0][1];
        const crD = chDx * cmDy - chDy * cmDx;
        // both ARE CROSS PRODUCTS, and the question is which SIDE of its chord each pose's control
        // mid is on -- so each is priced by its own sine (par9). Below the bar the mid is on the
        // chord to the last bit of float64 and there is no side to preserve. A shared world-unit
        // constant reads a shrinking destination as straight and a growing one as bent, which is
        // the same pair getting two different answers for no reason but where it was authored.
        if (
          Math.abs(crS) > par9(chSx, chSy, cmSx, cmSy) &&
          Math.abs(crD) > par9(chDx, chDy, cmDx, cmDy) &&
          crS > 0 !== crD > 0
        )
          return _bail9('bulge-flip');
      }
      {
        const cmD = [
          0.125 * cpD[0][0] + 0.375 * cpD[1][0] + 0.375 * cpD[2][0] + 0.125 * cpD[3][0],
          0.125 * cpD[0][1] + 0.375 * cpD[1][1] + 0.375 * cpD[2][1] + 0.125 * cpD[3][1],
        ];
        const ctrlMidD = [(cpD[1][0] + cpD[2][0]) / 2, (cpD[1][1] + cpD[2][1]) / 2];
        const txD = cpD[1][0] - cpD[0][0] + 2 * (cpD[2][0] - cpD[1][0]) + (cpD[3][0] - cpD[2][0]);
        const tyD = cpD[1][1] - cpD[0][1] + 2 * (cpD[2][1] - cpD[1][1]) + (cpD[3][1] - cpD[2][1]);
        let nxD = -tyD,
          nyD = txD;
        const nlD = Math.hypot(nxD, nyD);
        const chordD = Math.hypot(cpD[3][0] - cpD[0][0], cpD[3][1] - cpD[0][1]);
        let ccxD = false,
          bothD = false;
        const offInkD9 = 0.05; // the destination probe's offset, a fraction of the chord
        if (nlD > emD9.eps && chordD > emD9.eps) {
          // the same two dst lengths as the invisible pass
          if (nxD * (ctrlMidD[0] - cmD[0]) + nyD * (ctrlMidD[1] - cmD[1]) < 0) {
            nxD = -nxD;
            nyD = -nyD;
          }
          const offD = offInkD9 * chordD;
          ccxD = inFillD([cmD[0] + (nxD / nlD) * offD, cmD[1] + (nyD / nlD) * offD]);
          bothD = ccxD && inFillD([cmD[0] - (nxD / nlD) * offD, cmD[1] - (nyD / nlD) * offD]);
        }
        if (rec.invis9) {
          if (!bothD) return _bail9('invisible-flip');
        } else {
          if (bothD) return _bail9('invisible-flip'); // boundary became invisible → structure change
          // A serpentine destination is read where its ink probe stood, as the source was (lbPartition).
          const serpD =
            nlD > emD9.eps &&
            chordD > emD9.eps &&
            cubicInflections(cpD).some((t) => t > 1e-6 && t < 1 - 1e-6);
          const refD = serpD
            ? [
                cmD[0] + (ccxD ? 1 : -1) * (nxD / nlD) * offInkD9 * chordD,
                cmD[1] + (ccxD ? 1 : -1) * (nyD / nlD) * offInkD9 * chordD,
              ]
            : null;
          const signD =
            (refD && cubicSignAtPoint(cpD, klmnD, FD, refD)) ||
            (klmnD ? cubicSignKLMN(cpD, klmnD, ccxD) : cubicSign(cpD, FD, ccxD));
          if (signD !== rec.sign) return _bail9('sign-flip'); // classification flip → bail
        }
      }
      // klmn rows are read over the dst piece's own control points (dstKlmnFrame9), so no fan corner is looked up here
      // A BEZOUT FACE'S KEEP HALF-PLANE, ON THE DESTINATION TOO. The kernel fences a Bezout crescent past the half-plane
      // its vertices carry in aTC (lbPartition's bezoutKeepHalf9), and the vertex stage mixes aTC like everything else --
      // so a destination face with no plane would pack zeros there, and the plane drawn at t would be the SOURCE's scaled
      // by 1 - t, left where the source's arc was while the arc moved on: every Bezout crescent that moved past it would lose
      // its fragments a pixel at a time, and at t = 1 there would be no fence at all.
      //
      // THE same NORMAL ON both POSES, each at its own arc's support along it. A mixed plane is m . p <= lerp(c0, c1)
      // with m fixed, and max over the arc of m . B_t = max of a lerp of the two poses' arcs <= lerp of their maxima --
      // so the lerped plane holds the lerped arc on its keep side at every t, exactly, and still touches each pose's arc
      // at its end. Two DIFFERENT normals (each pose's own chord) mix into a plane that can cut the arc between them.
      //
      // As the static build packs it. The kernel bounds the crescent by the pixel box's share of the plane, and cuts it
      // where that share is zero, at the box filter's own reach; neither reads the plane's length nor
      // em-per-pixel, so both poses carry the static build's unit normal.
      const kS9 = rec.keep9 || null;
      const keepD = FD && kS9 ? [kS9[0], kS9[1], cubicSupport9(cpD, kS9[0], kS9[1])] : null;
      rd = { cpD, klmnD, FD, frameD: null, keepD };
      recsDst9.set(e._ri9, rd);
    }
    // transform the entry: mapped hull verts + rows/F evaluated on dst
    const H = e.hull,
      HD = new Float32Array(6);
    const bary9 = [];
    for (let k = 0; k < 3; k++) {
      const mp = mapPt(H[2 * k], H[2 * k + 1]);
      if (!mp) return _bail9('clipped-subvert-unmapped'); // clipped sub-verts → bail
      HD[2 * k] = mp[0];
      HD[2 * k + 1] = mp[1];
      bary9.push(mp);
    }
    if (e.klmn) {
      // rows at the dst verts: affine over a spanning triangle of the dst piece (see dstKlmnFrame9)
      const fr = rd.frameD || (rd.frameD = dstKlmnFrame9(rd, par9));

      if (!fr) return _bail9('face-degenerate');
      const { A: A9, B: B9, C: C9, den, R } = fr;
      const rowsAt = (px, py) => {
        const w1 = ((px - A9[0]) * (C9[1] - A9[1]) - (py - A9[1]) * (C9[0] - A9[0])) / den;
        const w2 = ((B9[0] - A9[0]) * (py - A9[1]) - (B9[1] - A9[1]) * (px - A9[0])) / den;
        const w0 = 1 - w1 - w2;
        return [
          w0 * R[0][0] + w1 * R[1][0] + w2 * R[2][0],
          w0 * R[0][1] + w1 * R[1][1] + w2 * R[2][1],
          w0 * R[0][2] + w1 * R[1][2] + w2 * R[2][2],
        ];
      };
      const kl = new Float32Array(9);
      for (let k = 0; k < 3; k++) {
        const r = rowsAt(HD[2 * k], HD[2 * k + 1]);
        kl[3 * k] = r[0];
        kl[3 * k + 1] = r[1];
        kl[3 * k + 2] = r[2];
      }
      cubicsD[ci] = { hull: HD, klmn: kl, sign: e.sign, cp: rd.cpD };
    } else {
      // `cp` rides along here for the same reason the klmn branch carries it: the
      // destination piece's control points are the only record of what curve this
      // face is meant to be, and the packer, the drift metric and anything that
      // wants to re-derive the frame all read it. The packer ignores it on a
      // Bezout face, so this is provenance, not payload.
      cubicsD[ci] = {
        hull: HD,
        F: rd.FD,
        sign: e.sign,
        cp: rd.cpD,
        keep: rd.keepD,
        inkLeft: e.inkLeft,
      };
    }
    // Kind-12 cubic ring end meta on DST (match static / SRC pack layout).
    {
      const cpD = rd.cpD;
      const stubE = { nN: [0, 0], k: 0, type: 0, curve: true, tsign: 1, qn: true, turn: 0 };
      const u = (x, y) => {
        const L = Math.hypot(x, y);
        return L > 0 ? [x / L, y / L] : null;
      };
      const tA =
        u(cpD[1][0] - cpD[0][0], cpD[1][1] - cpD[0][1]) ||
        u(cpD[2][0] - cpD[0][0], cpD[2][1] - cpD[0][1]) ||
        u(cpD[3][0] - cpD[0][0], cpD[3][1] - cpD[0][1]);
      const tB =
        u(cpD[3][0] - cpD[2][0], cpD[3][1] - cpD[2][1]) ||
        u(cpD[3][0] - cpD[1][0], cpD[3][1] - cpD[1][1]) ||
        u(cpD[3][0] - cpD[0][0], cpD[3][1] - cpD[0][1]);
      const nPie = (dstPieceOf9.get(rec.ci9 + '|' + rec.si9) || []).length || 1;
      const dc = dstContours[rec.ci9];
      cubicsD[ci].a = cpD[0];
      cubicsD[ci].b = cpD[3];
      cubicsD[ci].na = tA;
      cubicsD[ci].nb = tB ? [-tB[0], -tB[1]] : null;
      cubicsD[ci].e1 =
        rec.pi9 === 0 ? edgeEndMeta(dc, dtg[rec.ci9], rec.si9, 0, interiorSignD[rec.ci9]) : stubE;
      cubicsD[ci].e2 =
        rec.pi9 === nPie - 1
          ? edgeEndMeta(dc, dtg[rec.ci9], rec.si9, 1, interiorSignD[rec.ci9])
          : stubE;
    }
  }

  // corner-aware rows for the dst too (the same attachment pass the static
  // build runs); if the pass re-cuts dst faces differently from src the
  // topologies would diverge, so fall back to single rows in that case —
  // vertex counts must stay identical for the dual-stream VBO. SEGMENT pairs
  // (t-sliced flip morphs) skip the pass: their endpoints are mid-morph
  // lerps whose near-flip geometry degenerates the corner classification,
  // and corner-row fidelity is sub-AA on those transient frames.
  let rowsD9 = null;
  if (!chainsD9 && !(opts && opts.plainDstRows))
    try {
      const planD9 = splitInteriorByCurve(
        di,
        selfOrientRows(interiorEdgesFromTriPoints(di, edgesD), di),
        new Map(),
        new Map(),
        true,
        edgesD,
      );
      if (planD9.solid.length === di.length) rowsD9 = planD9;
    } catch {
      rowsD9 = null;
    }
  const dst = {
    interior: di,
    interiorEdges: chainsD9
      ? null
      : rowsD9
        ? rowsD9.solidEdges instanceof Float32Array
          ? rowsD9.solidEdges
          : new Float32Array(rowsD9.solidEdges)
        : selfOrientRows(interiorEdgesFromTriPoints(di, edgesD), di),
    interiorEdges2: rowsD9 && rowsD9.solidEdges2 ? new Float32Array(rowsD9.solidEdges2) : null,
    interiorEdges3: rowsD9 && rowsD9.solidEdges3 ? new Float32Array(rowsD9.solidEdges3) : null,
    ...(chainsD9 || {}),
    quads: quadsD,
    cubics: cubicsD,
    edges: edgesD,
    fallback: [],
    stripArcs: stripsD,
    _topo: null,
  };
  // MID-MORPH ORIENTATION CHECK, and why this pair type needs one.
  //
  // A drift oracle over the pair's cubics cannot be this guard: a line-only polygon -- the case
  // that fails hardest -- has no cubics for it to look at. This runs on every pair and looks at
  // the triangles themselves (pairMidFlips: every face, exactly, over the whole of [0, 1]).
  //
  // Declining is the right answer rather than a repair: the caller falls back to an engine that
  // paints the pose correctly, which beats a fast wrong picture.
  if (pairMidFlips(src, dst)) {
    // The corner-aware row pass is what flips. It re-cuts faces on each endpoint independently
    // and is checked only by COUNT, and equal counts do not mean the rows correspond -- so the
    // two meshes pair mismatched vertices and lerping those turns triangles inside out. The
    // plain-row build (which both endpoints share, `plainDstRows`) does not, and serves the same
    // morph at every t.
    //
    if (!(opts && opts.plainDstRows))
      return buildLoopBlinnPartitionPair(authoredSrc9, authoredDst9, fillRule, {
        ...(opts || {}),
        plainDstRows: true,
      });
    return _bail9('mid-flip');
  }
  // A pair is lerped vertex for vertex: both poses keep the builder's order through the packer (lbPack `_keepOrder9`),
  // whose own emission order sorts by what a pose carries, which the two need not agree on.
  /** @type {typeof src & {_keepOrder9?:boolean}} */ (src)._keepOrder9 = true;
  /** @type {typeof dst & {_keepOrder9?:boolean}} */ (dst)._keepOrder9 = true;
  return { src, dst };
}

/// The triangle a destination piece's klmn rows are read over: { A, B, C, den, R }, R being the
/// rows at A, B and C, or null when no three of the piece's control points span the plane.
///
/// k, l and m are ONE affine function of position over a whole cubic piece -- Loop-Blinn's linear
/// functionals, evaluated at the control points (over 19096 random cubics the fourth control
/// point's rows sit within 1e-13 of what the other three predict) -- so any three control points
/// that span the plane give the same rows, and which three is a question of conditioning only.
///
/// Not the source's fan triangle. The pair cuts both poses at every cut EITHER pose needs, and a
/// cut at one pose's inflection is where that pose's B' and B'' are parallel: the piece starting
/// there has its first three control points collinear by construction (the piece ending there, its
/// last three). The other pose, cut at the same parameter but off its own inflection, sees a sliver
/// the builder keeps as a fan triangle, and mapped to this pose the sliver has no area. That
/// declined the simplest morph there is, a 12-cubic ring that only scales: authored at three
/// decimals, the poses' inflections sit 2.1e-5 apart in t, both are cut, and the destination's fan
/// triangle came out with a divisor of exactly zero.
///
/// ...AND NOT EVEN WHERE IT PASSES par9. A sliver whose sine clears 2^-52 is a divisor, not a
/// basis: the face's destination vertices sit off its line, and barycentric weights near 1e9 turn
/// the last bits of the rows into the answer. On that same ring a fan triangle of sine 8.1e-16 put
/// rows 2.1% (of their scale) from the piece's own implicit, and over the 274-pair morph corpus 19
/// of 140 pairs carried destination rows 1e-4 to 3.6% from theirs. The WIDEST triangle, by area,
/// gives every point of the piece's control hull barycentric weights in [-1, 1], and a ranking of
/// areas within one piece is the same at every scale.
function dstKlmnFrame9(rd, par9) {
  return klmnWidestFrame9(rd.cpD, rd.klmnD, par9);
}

/// The destination's interior chains: the source's chain arrays (lbFastMesh interiorChainsFromTris: per vertex, chain 1
/// as P0..P4 in A.xy/A.zw/B.xy/B.zw/C.xy with C.z the face's mode sentinel, chain 2 as Q0..Q3 in D/E) with every point
/// passed through `map`. An absent chain is all zero and stays so; a point `map` cannot place makes the whole answer
/// null.
function mapChains9(src, map) {
  const A = src.interiorChainA,
    B = src.interiorChainB,
    C = src.interiorChainC,
    D = src.interiorChainD,
    E = src.interiorChainE;
  const out = {
    interiorChainA: new Float32Array(A.length),
    interiorChainB: new Float32Array(B.length),
    interiorChainC: new Float32Array(C),
    interiorChainD: D ? new Float32Array(D.length) : D,
    interiorChainE: E ? new Float32Array(E.length) : E,
    interiorHasChain2: src.interiorHasChain2,
  };
  const put = (from, to, o) => {
    const m = map(from[o], from[o + 1]);
    if (!m) return false;
    to[o] = m[0];
    to[o + 1] = m[1];
    return true;
  };
  for (let o = 0; o + 3 < A.length; o += 4) {
    if (
      A[o] ||
      A[o + 1] ||
      A[o + 2] ||
      A[o + 3] ||
      B[o] ||
      B[o + 1] ||
      B[o + 2] ||
      B[o + 3] ||
      C[o] ||
      C[o + 1]
    ) {
      if (
        !put(A, out.interiorChainA, o) ||
        !put(A, out.interiorChainA, o + 2) ||
        !put(B, out.interiorChainB, o) ||
        !put(B, out.interiorChainB, o + 2) ||
        !put(C, out.interiorChainC, o)
      )
        return null;
    }
    if (
      D &&
      E &&
      (D[o] || D[o + 1] || D[o + 2] || D[o + 3] || E[o] || E[o + 1] || E[o + 2] || E[o + 3])
    ) {
      if (
        !put(D, out.interiorChainD, o) ||
        !put(D, out.interiorChainD, o + 2) ||
        !put(E, out.interiorChainE, o) ||
        !put(E, out.interiorChainE, o + 2)
      )
        return null;
    }
  }
  return out;
}

/// The split plan a pair cuts both of its poses at, per cubic ('contour|segment' -> { ts, fatTs }): each pose's own
/// plan from the builder's cubicSplitPlan9, merged. `authored*` are the contours the vertex quanta are taken from (the
/// pair's own lists before overlapping quad hulls are halved); they default to the lists themselves. Exported so a test
/// can partition an in-between pose at the cuts the morph actually draws it with.
export function pairCubicPlans9(
  srcContours,
  dstContours,
  authoredSrc = srcContours,
  authoredDst = dstContours,
  serpentine = false,
) {
  const allSrc9 = srcContours.flat(),
    allDst9 = dstContours.flat();
  const plans9 = new Map();
  // Each pose's vertex quantum (lbContour's key bucket), for the merge below.
  const qS9 = emUnitsOf(authoredSrc).res,
    qD9 = emUnitsOf(authoredDst).res;
  for (let c = 0; c < srcContours.length; c++) {
    for (let i = 0; i < srcContours[c].length; i++) {
      const sg = srcContours[c][i],
        dg = dstContours[c][i];
      if (sg.type !== SEG_CUBIC) continue;
      const Ps = [sg.p1, sg.p2, sg.p3, sg.p4],
        Pd = [dg.p1, dg.p2, dg.p3, dg.p4];
      // `serpentine`: a cubic whose inflection MOVES -- the same count on both poses, at different
      // parameters -- is planned on both without its inflection cuts, so the piece holding the inflection is one
      // serpentine piece on both poses instead of a piece that bulges one way on one pose and the other way on the other.
      const iS = serpentine ? cubicInflections(Ps) : [],
        iD = serpentine ? cubicInflections(Pd) : [];
      const keep =
        serpentine && iS.length > 0 && iS.length === iD.length && iS.some((v, k) => v !== iD[k]);
      plans9.set(
        c + '|' + i,
        mergeCubicPlans9(
          cubicSplitPlan9(Ps, allSrc9, sg, keep),
          cubicSplitPlan9(Pd, allDst9, dg, keep),
          Ps,
          Pd,
          qS9,
          qD9,
        ),
      );
    }
  }
  return plans9;
}

/// Every cut either pose needs. A turn cut in either plan marks `fatTs`.
///
/// Except a cut the builder cannot tell from its neighbor. The two plans place the same feature at different parameters
/// wherever the poses differ -- an inflection moves as the curve does -- and taking both cuts leaves a piece between them.
/// When that piece fits inside one vertex quantum of its pose (`qS`, `qD`: lbContour's key bucket, 2^-16 of the shape,
/// so the test reads the same at every drawing size), the builder merges its ends into one vertex: its fan triangle
/// collapses, the face beside it is a sliver, and the interior chains walk a window whose edges point in whatever
/// direction float32 left them -- a chain end past such an edge carries that direction across real ink. Cut once, at the
/// first of the two: the other pose then carries its feature within a quantum of the cut, which is below what its own
/// build can represent. A merged turn cut keeps its mark on the survivor.
///
/// AND WHEN only ONE POSE CANNOT TELL THEM APART, that pose's cut goes and the other pose's stays. The
/// quantum is each pose's own, and a morph whose poses differ in size -- or in how fast the curve runs there -- puts the
/// piece inside one pose's quantum and outside the other's: 0.08 of a quantum on one pose and 2.68 on the other, on a
/// shape whose second contour grows a thousandfold. Keeping both cuts left the small pose a sliver fan triangle whose
/// float32 corners inverted it at that pose (area 3.9e-2 -> -1.6e-5), and no check looked at cubic faces. The pose that
/// loses its cut carries its feature within its own quantum of the survivor; the pose that keeps its own cut keeps it
/// exactly. Two cuts of the same pose, or shared by both, both stay: the orientation check (pairMidFlips) is the net.
function mergeCubicPlans9(a, b, Ps, Pd, qS, qD) {
  const inA = new Set(a.ts),
    inB = new Set(b.ts);
  const all = [...new Set(a.ts.concat(b.ts))].sort((x, y) => x - y),
    ts = [];
  const fatTs = new Set([...a.fatTs, ...b.fatTs]);
  const within = (P, u, v, q) => {
    const cp = cubicSubCp(P, u, v);
    for (let j = 1; j < 4; j++)
      if (Math.max(Math.abs(cp[j][0] - cp[0][0]), Math.abs(cp[j][1] - cp[0][1])) > q) return false;
    return true;
  };
  // `only(t, S, O)`: t is a cut of the pose whose plan is S and not of the other's
  const only = (t, S, O) => S.has(t) && !O.has(t);
  for (const u of all) {
    const v = ts.length ? ts[ts.length - 1] : -1;
    if (v < 0) {
      ts.push(u);
      continue;
    }
    const wS = u - v <= 1e-9 || (Ps && within(Ps, v, u, qS)),
      wD = u - v <= 1e-9 || (Pd && within(Pd, v, u, qD));
    if (wS && wD) {
      if (fatTs.has(u)) fatTs.add(v);
      continue;
    }
    if (wS || wD) {
      const [L, K] = wS ? [inA, inB] : [inB, inA]; // the pose that cannot tell them apart, and the one that can
      if (only(u, L, K)) {
        if (fatTs.has(u)) fatTs.add(v);
        continue;
      }
      if (only(v, L, K)) {
        if (fatTs.has(v)) fatTs.add(u);
        ts[ts.length - 1] = u;
        continue;
      }
    }
    ts.push(u);
  }
  return { ts, fatTs };
}

/// Does any triangle in the pair change orientation on the way between the endpoints?
/// A sign change (or a collapse to zero between two ends that are not zero) is a triangle that
/// inverts or degenerates mid-morph, which renders as a hole.
///
/// exactly, AND every FACE. A lerped triangle's signed area is a QUADRATIC in t, so its
/// extremes over [0, 1] are its two ends and, when the vertex of the parabola falls inside, that
/// point: three evaluations decide it at every t, where a sample at t = 0.5 would decide it at one.
/// The quadratic is fitted through t = 0, 1/2, 1 (exact up to the rounding of three areas). And the
/// Loop-Blinn CUBIC faces are checked too, not only interior and quad faces: a one-pose sliver of
/// mergeCubicPlans9 can invert a cubic fan triangle. A face already zero at an end is
/// still skipped: its sign is not defined there, and a fan triangle whose control points are collinear
/// on one pose is zero there by construction.
export function pairMidFlips(src, dst) {
  const area = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  // The area rounding alone can make. The faces are stored in float32, so a triangle collinear by construction -- the fan
  // triangle of a piece cut at its own inflection, which is where a moving inflection's cells cut every piece --
  // comes back with an area of either sign within what rounding each corner to float32 can do: under
  // 2 ulp(largest coordinate) * (|e1| + |e2|). An end whose area is inside that is degenerate, like an exact zero.
  const noise = (T, o) => {
    const M = Math.max(
      Math.abs(T[o]),
      Math.abs(T[o + 1]),
      Math.abs(T[o + 2]),
      Math.abs(T[o + 3]),
      Math.abs(T[o + 4]),
      Math.abs(T[o + 5]),
    );
    const ulp = M > 0 ? 2 ** (Math.floor(Math.log2(M)) - 23) : 0;
    return (
      2 *
      ulp *
      (Math.hypot(T[o + 2] - T[o], T[o + 3] - T[o + 1]) +
        Math.hypot(T[o + 4] - T[o], T[o + 5] - T[o + 1]))
    );
  };
  const flips = (S, D, o) => {
    const a0 = area(S[o], S[o + 1], S[o + 2], S[o + 3], S[o + 4], S[o + 5]);
    const a1 = area(D[o], D[o + 1], D[o + 2], D[o + 3], D[o + 4], D[o + 5]);
    if (a0 === 0 || a1 === 0) return false; // degenerate at an endpoint
    if (Math.abs(a0) <= noise(S, o) || Math.abs(a1) <= noise(D, o)) return false; // ...to the last bit of its storage
    if (a0 > 0 !== a1 > 0) return true;
    const m = [];
    for (let k = 0; k < 6; k++) m.push((S[o + k] + D[o + k]) / 2);
    const am = area(m[0], m[1], m[2], m[3], m[4], m[5]);
    if (am > 0 !== a0 > 0 || am === 0) return true;
    const c = 2 * (a0 + a1 - 2 * am),
      b = a1 - a0 - c; // a(t) = a0 + b t + c t^2
    const tv = c !== 0 ? -b / (2 * c) : -1;
    if (!(tv > 0 && tv < 1)) return false;
    const av = a0 + tv * (b + tv * c);
    return av === 0 || av > 0 !== a0 > 0;
  };
  const si = src.interior,
    di = dst.interior;
  if (si && di && si.length === di.length)
    for (let o = 0; o + 5 < si.length; o += 6) if (flips(si, di, o)) return true;
  const sq = src.quads || [],
    dq = dst.quads || [];
  for (let i = 0; i < sq.length && i < dq.length; i++) {
    const a = sq[i] && sq[i].tri,
      b = dq[i] && dq[i].tri;
    if (a && b && a.length >= 6 && b.length >= 6 && flips(a, b, 0)) return true;
  }
  const sc = src.cubics || [],
    dc = dst.cubics || [];
  for (let i = 0; i < sc.length && i < dc.length; i++) {
    const a = sc[i] && sc[i].hull,
      b = dc[i] && dc[i].hull;
    if (a && b && a.length >= 6 && b.length >= 6 && flips(a, b, 0)) return true;
  }
  return false;
}

// ── THE MID-MORPH DRIFT ORACLE ────────────────────────────────────────────────
// How far does the edge the vertex stage draws stand from the edge it is meant to
// draw, BETWEEN the endpoints?

// The answer is in fractions of a piece's own CHORD, the unit the static builder's
// faithfulness split already uses: a mesh is built once and drawn at every size, so
// there is no pixel here to measure against.

/// Distance from a point on the true curve to the zero set of `f`, by TWO estimators,
/// taking the smaller. Neither alone is honest on a Bezout face: |f| / |grad f| blows
/// up where one of the resultant's extra branches brings a singular point past the
/// sample, and walking the curve's own normal for a sign change saturates where the
/// drawn zero set is TANGENT to the curve rather than crossing it. Each is exact
/// where the other degenerates, and they agree wherever the face is well conditioned.
///
/// `lim` IS A CEILING, NOT JUST A WINDOW, and that is worth stating because a reading of exactly
/// `lim` is the one answer this function cannot defend: `best` starts there and the walk stops
/// there, so a zero set a quarter of a chord away and one five chords away both come back `lim`.
/// Every caller that compares two arms has to know whether it is reading a distance or the ceiling
/// -- `pairImplicitDrift` reports that as `out.saturated`.
///
/// `ref` SIZES THE STEPS, `lim` SIZES THE WALK. As one number, widening the window would also
/// coarsen the gradient step and the walk step, and a wider search could return a LARGER answer
/// by stepping over a thin sign change. Split, a wider window only ever searches further at the
/// same resolution. `ref` defaults to `lim`.
function driftAt9(f, px, py, nx, ny, lim, ref = lim) {
  const v0 = f(px, py);
  if (v0 === 0) return 0;
  let best = lim;
  const h = 1e-5 * ref;
  const gx = (f(px + h, py) - f(px - h, py)) / (2 * h),
    gy = (f(px, py + h) - f(px, py - h)) / (2 * h);
  const g = Math.hypot(gx, gy);
  if (g > 0) best = Math.min(best, Math.abs(v0) / g);
  const step = ref / 40;
  for (let dir = 1; dir >= -1; dir -= 2) {
    let a = 0,
      va = v0;
    // `lim * (1 + 2^-40)`, not `lim + 1e-12`: the slack exists to keep the last accumulated step
    // from falling off the end by a rounding bit, so it has to be a FRACTION of the walk it pads.
    // An absolute pad is the whole walk below 2^-20 of this shape's size and nothing above 2^20.
    for (let d = step; d <= lim * (1 + 2 ** -40); d += step) {
      const vb = f(px + nx * dir * d, py + ny * dir * d);
      if (vb > 0 !== va > 0) {
        let lo = a,
          hi = d;
        for (let k = 0; k < 20; k++) {
          const m = (lo + hi) / 2;
          if (f(px + nx * dir * m, py + ny * dir * m) > 0 === va > 0) lo = m;
          else hi = m;
        }
        best = Math.min(best, (lo + hi) / 2);
        break;
      }
      a = d;
      va = vb;
    }
  }
  return best;
}

const _mixBez9 = (A, B, u) => {
  const m = (a, b) => a + (b - a) * u;
  return {
    cx: m(A.cx, B.cx),
    cy: m(A.cy, B.cy),
    s: m(A.s, B.s),
    m00: { a: m(A.m00.a, B.m00.a), b: m(A.m00.b, B.m00.b), c: m(A.m00.c, B.m00.c) },
    m01: { a: m(A.m01.a, B.m01.a), b: m(A.m01.b, B.m01.b), c: m(A.m01.c, B.m01.c) },
    m02: { a: m(A.m02.a, B.m02.a), b: m(A.m02.b, B.m02.b), c: m(A.m02.c, B.m02.c) },
    m11a: m(A.m11a, B.m11a),
    m12: m(A.m12, B.m12),
    m22: m(A.m22, B.m22),
  };
};

/// Barycentric weights in the triangle the rasterizer actually sees — the hull with
/// its vertices lerped, which is where the lerped texcoords land.
const _bary9 = (T, px, py) => {
  const ax = T[0],
    ay = T[1],
    bx = T[2],
    by = T[3],
    cx = T[4],
    cy = T[5];
  const den = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  // NOT a decline: `_bary9` serves the drift oracle, which asks for weights at a sample point and
  // takes null for "this triangle has none". Stamping a cause here would overwrite the pair's.
  if (!(Math.abs(den) > 0)) return null;
  const w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) / den;
  const w2 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / den;
  return [1 - w1 - w2, w1, w2];
};

export function pairImplicitDrift(src, dst, uLo = 0, uHi = 1, out = null, opts = null) {
  const limFrac = opts && +opts.limFrac > 0 ? +opts.limFrac : 0.25;
  // `opts.clamp = [lo, hi]` PRICES THE CLAMP ARM: the implicit is mixed at u clamped into [lo, hi]
  // while the curve is taken at the true u. That is exactly what clamping the draw-time remap would
  // do -- positions are linear and extrapolate exactly, so the shape stays right and only the
  // implicit freezes at the build boundary. Null (the default) mixes both at the same u, which is
  // what the renderer's own callers use.
  const clamp = opts && Array.isArray(opts.clamp) && opts.clamp.length === 2 ? opts.clamp : null;
  if (out) {
    out.em = 0;
    out.frac = 0;
    out.face = -1;
    out.kind = '-';
    out.u = uLo;
    out.faces = 0;
    out.saturated = false;
  }
  const cs = src.cubics || [],
    cd = dst.cubics || [];
  const samples = 9;
  let worst = 0;
  for (let i = 0; i < cs.length && i < cd.length; i++) {
    const cS = cs[i],
      cD = cd[i];
    if (!cS.cp || !cD.cp) continue;
    const bez = !!(cS.F && cD.F);
    if (!bez && !(cS.klmn && cD.klmn)) continue;
    if (out) out.faces++;
    for (let q = 0; q <= 4; q++) {
      const u = uLo + (uHi - uLo) * (q / 4);
      const cp = cS.cp.map((p, k) => [
        p[0] + (cD.cp[k][0] - p[0]) * u,
        p[1] + (cD.cp[k][1] - p[1]) * u,
      ]);
      const chord = Math.hypot(cp[3][0] - cp[0][0], cp[3][1] - cp[0][1]);
      if (!(chord > 0)) continue;
      // The implicit's mix parameter, which is `u` unless the clamp arm is being priced.
      const uf = clamp ? Math.min(Math.max(u, clamp[0]), clamp[1]) : u;
      let f = null;
      if (bez) {
        const F = _mixBez9(cS.F, cD.F, uf);
        f = (x, y) => evalBezout(F, x, y);
      } else {
        const T = new Float64Array(6),
          K = [];
        for (let k = 0; k < 3; k++) {
          T[2 * k] = cS.hull[2 * k] + (cD.hull[2 * k] - cS.hull[2 * k]) * uf;
          T[2 * k + 1] = cS.hull[2 * k + 1] + (cD.hull[2 * k + 1] - cS.hull[2 * k + 1]) * uf;
          K.push(
            [0, 1, 2].map(
              (j) => cS.klmn[3 * k + j] + (cD.klmn[3 * k + j] - cS.klmn[3 * k + j]) * uf,
            ),
          );
        }
        f = (x, y) => {
          const w = _bary9(T, x, y);
          if (!w) return 0;
          const kk = w[0] * K[0][0] + w[1] * K[1][0] + w[2] * K[2][0];
          const ll = w[0] * K[0][1] + w[1] * K[1][1] + w[2] * K[2][1];
          const mm = w[0] * K[0][2] + w[1] * K[1][2] + w[2] * K[2][2];
          return kk * kk * kk - ll * mm;
        };
      }
      // `ref` is the reference window (a quarter chord) and sizes every step; `lim` is how far the walk may reach.
      const ref = 0.25 * chord,
        lim = limFrac * chord;
      for (let k = 0; k < samples; k++) {
        const t9 = k / (samples - 1),
          o9 = 1 - t9;
        const P = cubicPt(cp, t9);
        const dx =
          o9 * o9 * (cp[1][0] - cp[0][0]) +
          2 * o9 * t9 * (cp[2][0] - cp[1][0]) +
          t9 * t9 * (cp[3][0] - cp[2][0]);
        const dy =
          o9 * o9 * (cp[1][1] - cp[0][1]) +
          2 * o9 * t9 * (cp[2][1] - cp[1][1]) +
          t9 * t9 * (cp[3][1] - cp[2][1]);
        const L = Math.hypot(dx, dy);
        if (!(L > 0)) continue;
        const d9 = driftAt9(f, P[0], P[1], -dy / L, dx / L, lim, ref);
        if (d9 / chord > worst) {
          worst = d9 / chord;
          // A reading AT the ceiling is a non-answer, and the worst sample is the one that decides
          // the return value, so its status is the one the caller has to be told about.
          if (out) {
            out.em = d9;
            out.frac = worst;
            out.face = i;
            out.kind = bez ? 'bezout' : 'klmn';
            out.u = u;
            out.saturated = d9 >= lim * (1 - 2 ** -40);
          }
        }
      }
    }
  }
  return worst;
}
