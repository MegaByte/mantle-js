// lbPartition.js — the exact-partition builder (Loop-Blinn 2005):
// control points ARE triangulation vertices and hull edges ARE constraints,
// so every CDT face is either plain interior or (a piece of) a curve hull —
// the partition is exact by construction. The morph pair builder
// (lbPartitionPair via loopBlinn.js) derives its DST endpoint from this mesh by
// provenance transform, so the emitted provenance records (hulls9,
// cubicRecs9, steiner9) are part of the contract.
import { SEG_LINE, SEG_CUBIC, SEG_RQUAD } from '../primitives/seg.js';
import { constrainedTriangulate } from './cdt.js';
import { bezoutCubicImplicit, evalBezout, cubicKLMN, cubicSignKLMN, cubicLoop, splitCubicMulti, cubicHull, partitionCubicSplitTs, uvInHull, cubicSign, cubicPt } from './lbCubicMath.js';
import { _kox, _koy, _koScale, _setKeyOrigin, rayWinding, rayWindingDir, calibrateInterior, segTangents, edgeEndMeta, fatArc } from './lbContour.js';
import { splitInteriorByCurve, _healCand } from './lbInteriorSplit.js';
import { selfOrientRows, buildCornerCaps2, interiorEdgesFromTriPoints } from './lbFastMesh.js';

// ---- EXACT-PARTITION builder (Loop-Blinn 2005): control points ARE triangulation
// vertices and hull edges ARE constraints, so every CDT face is either plain
// interior or (a piece of) a curve hull — the partition is exact by
// construction. One exact side-bit per SEGMENT (not per face) orients the
// curve pieces. No claims matching, no adoption, no post-hoc face splitting,
// no T-junction healing — those exist to patch the overlay model this
// replaces. Quads + lines only (the game-art common case); callers fall back
// to the legacy builder for cubics/rquads.
export function buildLoopBlinnPartition(contours, opts) {
  _healCand.length = 0;
  _setKeyOrigin(contours);
  const allSegs = contours.flat();
  if (!allSegs.length) return null;
  const evenodd = !!(opts && opts.fillRule === 'evenodd');
  // exact fill test over the REAL curves (same construction as the legacy path)
  let _xa = Infinity, _xb = -Infinity, _ya = Infinity, _yb = -Infinity;
  for (const sg of allSegs) for (const P of [sg.p1, sg.p2, sg.p3]) if (P) {
    if (P[0] < _xa) _xa = P[0]; if (P[0] > _xb) _xb = P[0];
    if (P[1] < _ya) _ya = P[1]; if (P[1] > _yb) _yb = P[1];
  }
  const _eps = Math.max(_xb - _xa, _yb - _ya, 1e-6) * 1e-5;
  const inkAt = evenodd
    ? (x, y) => (rayWinding(allSegs, x, y + _eps) & 1) === 1
    : (x, y) => rayWinding(allSegs, x, y + _eps) !== 0;

  const pts = [];
  const idxOf = new Map();
  const key = (p) => Math.round((p[0] - _kox) * _koScale) * 2097152 + Math.round((p[1] - _koy) * _koScale);
  const add = (p) => { const k = key(p); let i = idxOf.get(k); if (i === undefined) { i = pts.length; idxOf.set(k, i); pts.push([p[0], p[1]]); } return i; };
  const constraints = [];
  const hulls = [];        // { a, c, b, sign } per curved seg (w=1 integral quads)
  const constraintsOnly9 = new Set();   // hull idx → INVISIBLE boundary (both sides ink): solid fill, no AA payload
  const steiner9 = [];     // crossing-splitter insertions + their parent coords (morph pair correspondence)
  const edges = [];        // straight-edge kind-0/10 payloads (same shape the pack expects)
  const stripArcs = [];    // kind-9 exterior strips per arc (pack plans them)
  const fallback9 = [];   // loop/cusp segs → the caller's per-shape Slug fallback
  let blendTier9 = false; // audit-marginal (fur): pieces keep BLEND compositing
  const cubicRecs = [];   // per fan-tri cubic hull records: { vis, P(2x3 or 4), rows(K/L/M)|F, sign }
  const cubics = [];      // mesh.cubics output (kind 2/4)

  let contourIdx9 = -1;
  for (const segs of contours) {
    contourIdx9++;
    if (!segs.length) continue;
    let interiorSign = calibrateInterior(segs, (pp) => inkAt(pp[0], pp[1]));
    // VERIFY the calibration with a direct probe: pick the longest LINE seg and
    // test a point just inside its interior-side normal. A wrong sign here put
    // every kind-10 strip on the INK side of straight edges — the G's crossbar
    // lost its entire outside partial row (Slug 166 vs LB 255, 646 px>0.3 at
    // 2.5×) while the inside double-blended.
    {
      let bi9 = -1, bl9 = 0;
      for (let si9 = 0; si9 < segs.length; si9++) {
        const s8 = segs[si9];
        if (s8.type !== SEG_LINE) continue;
        const l8 = Math.hypot(s8.p2[0] - s8.p1[0], s8.p2[1] - s8.p1[1]);
        if (l8 > bl9) { bl9 = l8; bi9 = si9; }
      }
      if (bi9 >= 0 && bl9 > 1e-9) {
        const s8 = segs[bi9];
        const ex8 = s8.p2[0] - s8.p1[0], ey8 = s8.p2[1] - s8.p1[1];
        const mx8 = (s8.p1[0] + s8.p2[0]) / 2, my8 = (s8.p1[1] + s8.p2[1]) / 2;
        // interior side of the edge = +interiorSign × left-normal
        const off8 = Math.min(bl9 * 0.25, 0.01 * Math.max(_xb - _xa, _yb - _ya));
        const nx8 = (-ey8 / bl9) * interiorSign, ny8 = (ex8 / bl9) * interiorSign;
        const inIn8 = inkAt(mx8 + nx8 * off8, my8 + ny8 * off8);
        const inOut8 = inkAt(mx8 - nx8 * off8, my8 - ny8 * off8);
        if (!inIn8 && inOut8) interiorSign = -interiorSign;
      }
    }
    const outwardSign = -interiorSign;
    const tg = segs.map(segTangents);
    for (let si = 0; si < segs.length; si++) {
      const s9 = segs[si];
      if (s9.type === SEG_LINE) {
        const la9 = add(s9.p1), lb9 = add(s9.p2);
        // zero-length closing lines (importers emit them) collapse to a SELF-LOOP
        // constraint that corrupts the CDT (the leaf: interior vanished entirely)
        if (la9 === lb9) continue;
        constraints.push([la9, lb9]);
        const ex = s9.p2[0] - s9.p1[0], ey = s9.p2[1] - s9.p1[1], L = Math.hypot(ex, ey);
        if (L > 1e-9) edges.push({ p1: s9.p1, p2: s9.p2, nx: (-ey / L) * outwardSign, ny: (ex / L) * outwardSign, out: outwardSign, ci9: contourIdx9, si9: si,
          e1: edgeEndMeta(segs, tg, si, 0, interiorSign), e2: edgeEndMeta(segs, tg, si, 1, interiorSign) });
        continue;
      }
      if (s9.type === SEG_CUBIC) {
        const P0 = [s9.p1, s9.p2, s9.p3, s9.p4];
        // loop/cusp cubics: same treatment as the legacy path — the seg joins
        // the per-shape Slug fallback list and its chord becomes a constraint
        // so the interior triangulation stays closed. The rest of the shape
        // stays on this builder.
        if (cubicLoop(P0)) { fallback9.push(s9); constraints.push([add(s9.p1), add(s9.p4)]); continue; }
        // near-line cubic → line edge (same gate as the legacy path)
        {
          const chx9 = s9.p4[0] - s9.p1[0], chy9 = s9.p4[1] - s9.p1[1];
          const ch29 = chx9 * chx9 + chy9 * chy9;
          if (ch29 > 1e-18) {
            const d19 = Math.abs((s9.p2[0] - s9.p1[0]) * chy9 - (s9.p2[1] - s9.p1[1]) * chx9);
            const d29 = Math.abs((s9.p3[0] - s9.p1[0]) * chy9 - (s9.p3[1] - s9.p1[1]) * chx9);
            if (Math.max(d19, d29) < 2e-3 * ch29) {
              constraints.push([add(s9.p1), add(s9.p4)]);
              const L9 = Math.sqrt(ch29);
              edges.push({ p1: s9.p1, p2: s9.p4, nx: (-chy9 / L9) * outwardSign, ny: (chx9 / L9) * outwardSign, out: outwardSign, ci9: contourIdx9, si9: si, flat9: 'cubic',
                e1: edgeEndMeta(segs, tg, si, 0, interiorSign), e2: edgeEndMeta(segs, tg, si, 1, interiorSign) });
              continue;
            }
          }
        }
        // FAT-BULGE pieces (tangent turn ≳100°: the leaf's half-oval cubics):
        // the cubic implicit's OTHER branch crosses their big hulls and pieces
        // stop painting mid-face (cut corners / slashes). SUBDIVIDE at t=½
        // until each sub-piece turns ≲100° — small hulls are single-branch.
        // subdivision via the SHARED plan (partitionCubicSplitTs) — the morph pair
        // builder applies these exact t-values to the destination endpoint.
        const plan9 = partitionCubicSplitTs(P0);
        const pieces9 = [];
        {
          const cut9 = splitCubicMulti(P0, plan9.ts);
          let prev9 = 0;
          for (let pi9 = 0; pi9 < cut9.length; pi9++) {
            const tEnd9 = pi9 < plan9.ts.length ? plan9.ts[pi9] : 1;
            const wasFat9 = plan9.fatTs.has(prev9) || plan9.fatTs.has(tEnd9);
            pieces9.push([cut9[pi9], wasFat9]);
            prev9 = tEnd9;
          }
        }
        let pieceIdx9 = -1;
        for (const [P, wasSplit9] of pieces9) {
          pieceIdx9++;
          let invisCubic9 = false;
          // exact side-bit: is the ctrl side of THIS single-bulge piece ink?
          // Probe along the curve NORMAL at t=½, at a distance relative to the
          // CHORD (not the ctrl sag): near-flat sub-pieces have ctrl-mid ≈ ON
          // the curve, so a sag-scaled probe landed within fp of the boundary
          // and tied randomly (the subdivided leaf shattered into ±wedges).
          const cm9 = cubicPt(P, 0.5);
          const ctrlMid9 = [(P[1][0] + P[2][0]) / 2, (P[1][1] + P[2][1]) / 2];
          let ccx9 = false;
          {
            const tx9 = (P[1][0] - P[0][0]) + 2 * (P[2][0] - P[1][0]) + (P[3][0] - P[2][0]);
            const ty9 = (P[1][1] - P[0][1]) + 2 * (P[2][1] - P[1][1]) + (P[3][1] - P[2][1]);
            let nx9 = -ty9, ny9 = tx9;
            const nl9 = Math.hypot(nx9, ny9);
            const chord9 = Math.hypot(P[3][0] - P[0][0], P[3][1] - P[0][1]);
            if (nl9 > 1e-12 && chord9 > 1e-12) {
              if (nx9 * (ctrlMid9[0] - cm9[0]) + ny9 * (ctrlMid9[1] - cm9[1]) < 0) { nx9 = -nx9; ny9 = -ny9; }
              const off9 = 0.05 * chord9;
              ccx9 = inkAt(cm9[0] + (nx9 / nl9) * off9, cm9[1] + (ny9 / nl9) * off9);
              // INVISIBLE BOUNDARY (both sides ink — a same-wound nested contour
              // under nonzero): same rule as the quad branch; the pieces fill
              // SOLID, no crescent frame (one-sided coverage is wrong there).
              if (ccx9 && inkAt(cm9[0] - (nx9 / nl9) * off9, cm9[1] - (ny9 / nl9) * off9)) invisCubic9 = true;
            }
          }
          const hull9 = cubicHull(P);
          const hi9 = hull9.map((h9) => add(P[h9]));
          for (let k9 = 0; k9 < hi9.length; k9++) constraints.push([hi9[k9], hi9[(k9 + 1) % hi9.length]]);
          // the fan DIAGONAL is a klmn patch boundary (k,l,m are affine per fan
          // tri, not across the quad) — constrain it or the CDT picks the other
          // diagonal and faces straddle patches (the leaf shear).
          if (hi9.length === 4) constraints.push([hi9[0], hi9[2]]);
          // klmn + the legacy frame-health gate (degenerate frames → exact Bezout).
          // Split descendants (fat/near-circular parents) go STRAIGHT to Bezout:
          // their klmn frames pass the health gate yet degenerate off-curve — the
          // implicit's other branches shredded the leaf even at 90° pieces, and
          // the legacy path renders the same shapes 12/16 on Bezout.
          let klmn9 = wasSplit9 ? null : cubicKLMN(P);
          if (klmn9) {
            const h0 = hull9[0], h1 = hull9[1], h2 = hull9[2];
            const e1x = P[h1][0] - P[h0][0], e1y = P[h1][1] - P[h0][1];
            const e2x = P[h2][0] - P[h0][0], e2y = P[h2][1] - P[h0][1];
            const det9 = e1x * e2y - e1y * e2x;
            if (Math.abs(det9) < 1e-12) klmn9 = null;
            else {
              const g9 = (arr) => {
                const d19 = arr[h1] - arr[h0], d29 = arr[h2] - arr[h0];
                return [(d19 * e2y - d29 * e1y) / det9, (d29 * e1x - d19 * e2x) / det9];
              };
              const kb9 = (arr) => (arr[h0] + arr[h1] + arr[h2]) / 3;
              const gk = g9(klmn9.k), gl = g9(klmn9.l), gm = g9(klmn9.m);
              const kc = kb9(klmn9.k), lc = kb9(klmn9.l), mc = kb9(klmn9.m);
              const gfx = 3 * kc * kc * gk[0] - (gl[0] * mc + lc * gm[0]);
              const gfy = 3 * kc * kc * gk[1] - (gl[1] * mc + lc * gm[1]);
              const diag9 = Math.hypot(e1x, e1y) + Math.hypot(e2x, e2y);
              if (Math.hypot(gfx, gfy) * diag9 < 1e-3) klmn9 = null;
            }
          }
          const sign9 = klmn9 ? cubicSignKLMN(P, klmn9, ccx9) : 0;
          const F9 = klmn9 ? null : bezoutCubicImplicit(P);
          const sgn9 = klmn9 ? sign9 : cubicSign(P, F9, ccx9);
          const htris9 = hull9.length === 3 ? [[0, 1, 2]] : [[0, 1, 2], [0, 2, 3]];
          const pid9 = cubicRecs.length;   // piece id: fan tris of one piece share a frame
          for (const tr9 of htris9) {
            cubicRecs.push({
              pid: pid9, ci9: contourIdx9, si9: si, pi9: pieceIdx9, invis9: invisCubic9,
              vis: [hi9[tr9[0]], hi9[tr9[1]], hi9[tr9[2]]],
              pts: [P[hull9[tr9[0]]], P[hull9[tr9[1]]], P[hull9[tr9[2]]]],
              rows: klmn9 ? [
                [klmn9.k[hull9[tr9[0]]], klmn9.l[hull9[tr9[0]]], klmn9.m[hull9[tr9[0]]]],
                [klmn9.k[hull9[tr9[1]]], klmn9.l[hull9[tr9[1]]], klmn9.m[hull9[tr9[1]]]],
                [klmn9.k[hull9[tr9[2]]], klmn9.l[hull9[tr9[2]]], klmn9.m[hull9[tr9[2]]]],
              ] : null,
              F: F9, sign: sgn9, cp: P,
            });
          }
        }
        continue;
      }
      // quad/rquad: ctrl is a vertex; hull edges are constraints (the Loop-Blinn paper's key move)
      const w9q = s9.type === SEG_RQUAD ? (s9.w || 1) : 1;
      const a = add(s9.p1), c = add(s9.p2), b = add(s9.p3);
      // near-flat arcs (sag ≪ chord) produce degenerate hulls: no usable frame,
      // no strip geometry — binary boundaries with no AA anywhere ('a' bowl-top).
      // Demote to a LINE edge: sub-LSB positional error, full kind-10/cap AA.
      let flat9 = a === c || c === b;
      if (!flat9) {
        const chx9 = s9.p3[0] - s9.p1[0], chy9 = s9.p3[1] - s9.p1[1];
        const chL9 = Math.hypot(chx9, chy9);
        if (chL9 > 1e-12) {
          const sag9 = Math.abs((s9.p2[0] - s9.p1[0]) * (chy9 / chL9) - (s9.p2[1] - s9.p1[1]) * (chx9 / chL9));
          if (sag9 < 0.004 * chL9) flat9 = true;
        }
      }
      if (flat9) {
        constraints.push([a, b]);
        const ex9 = s9.p3[0] - s9.p1[0], ey9 = s9.p3[1] - s9.p1[1], L9 = Math.hypot(ex9, ey9);
        if (L9 > 1e-9) edges.push({ p1: s9.p1, p2: s9.p3, nx: (-ey9 / L9) * outwardSign, ny: (ex9 / L9) * outwardSign, out: outwardSign, ci9: contourIdx9, si9: si, flat9: 'arc',
          e1: edgeEndMeta(segs, tg, si, 0, interiorSign), e2: edgeEndMeta(segs, tg, si, 1, interiorSign) });
        continue;
      }
      // the FULL hull boundary is constrained — the hull triangle is then bounded
      // by exactly its three edges, so no outside face can cross into it (an
      // unconstrained chord let interior faces poke past the curve: '0' 4→901px).
      constraints.push([a, c], [c, b], [a, b]);
      // ONE exact side-bit for the whole segment: is the ctrl side of the curve
      // ink? Probe the curve midpoint nudged toward the ctrl point.
      const dmid9 = 2 + 2 * w9q;
      const qmx = (s9.p1[0] + 2 * w9q * s9.p2[0] + s9.p3[0]) / dmid9;
      const qmy = (s9.p1[1] + 2 * w9q * s9.p2[1] + s9.p3[1]) / dmid9;
      let nx9 = s9.p2[0] - qmx, ny9 = s9.p2[1] - qmy;
      const nl9 = Math.hypot(nx9, ny9);
      let sign;
      if (nl9 < 1e-9) sign = 1;
      else {
        const off9 = Math.min(0.25 * nl9, 0.02 * Math.max(_xb - _xa, _yb - _ya));
        const inkCtrl = inkAt(qmx + (nx9 / nl9) * off9, qmy + (ny9 / nl9) * off9);
        // INVISIBLE BOUNDARY (both sides ink): a same-wound nested contour under
        // NONZERO contributes no edge — winding is ≠0 on BOTH sides of its curve.
        // Any one-sided crescent here is wrong by construction (one side always
        // ramps/discards → a white lune band bit into the qring's solid disc).
        // The hull paints as SOLID interior and the seg carries no AA payload
        // (no strip; the constraint stays so the partition is still bounded).
        if (inkCtrl && inkAt(qmx - (nx9 / nl9) * off9, qmy - (ny9 / nl9) * off9)) {
          constraintsOnly9.add(hulls.length);   // pass-1 skips membership for this hull
          hulls.push({ a: [s9.p1[0], s9.p1[1]], c: [s9.p2[0], s9.p2[1]], b: [s9.p3[0], s9.p3[1]], ai: a, ci: c, bi: b, sign: 1, w: w9q, si9: si, invis9: true,
            fat: fatArc(s9.p1[0], s9.p1[1], s9.p2[0], s9.p2[1], s9.p3[0], s9.p3[1]), ci9: contourIdx9 });
          continue;
        }
        // standard frame: ctrl side = f_raw > 0; sliver side = f_raw < 0.
        // paint the ink side: ink on ctrl side → sign -1 (paint f_raw>0);
        // ink on sliver side → sign +1 (paint f_raw<0).
        sign = inkCtrl ? -1 : 1;
      }
      hulls.push({ a: [s9.p1[0], s9.p1[1]], c: [s9.p2[0], s9.p2[1]], b: [s9.p3[0], s9.p3[1]], ai: a, ci: c, bi: b, sign, w: w9q, si9: si,
        fat: fatArc(s9.p1[0], s9.p1[1], s9.p2[0], s9.p2[1], s9.p3[0], s9.p3[1]), ci9: contourIdx9 });
      stripArcs.push({ tri: new Float32Array([s9.p1[0], s9.p1[1], s9.p2[0], s9.p2[1], s9.p3[0], s9.p3[1]]), sign, w: w9q, ci9: contourIdx9, si9: si });
    }
  }
  if (!pts.length) return null;
  // PROPER-HOLED shapes (glyph counters: '0', 'o', '8' waists): an OPPOSITE-
  // wound contour nested in another = the classic nonzero hole, which the
  // legacy path is pixel-tuned for (including self-pinch waists this
  // classification drops). Bail to it. SAME-wound nesting (the Raindrops
  // droplet's evenodd ring) and coincident-edge composites (tiled regions)
  // are exactly the classes the overlay model shredded — they stay here.
  {
    let hasDup9 = false;
    {
      const em9 = new Set();
      outer9: for (const c9 of contours) for (const sg9 of c9) {
        if (sg9.type !== SEG_LINE) continue;
        const k9 = key(sg9.p1) + '|' + key(sg9.p2), r9 = key(sg9.p2) + '|' + key(sg9.p1);
        if (em9.has(r9) || em9.has(k9)) { hasDup9 = true; break outer9; }
        em9.add(k9);
      }
    }
    if (!hasDup9 && contours.length > 1) {
      const info9 = contours.map((c9) => {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, ar9 = 0;
        for (const sg9 of c9) {
          const P9 = sg9.p1, Q9 = sg9.type === SEG_LINE ? sg9.p2 : sg9.p3;
          ar9 += P9[0] * Q9[1] - Q9[0] * P9[1];
          for (const R9 of [sg9.p1, sg9.p2, sg9.p3]) if (R9) {
            if (R9[0] < x0) x0 = R9[0]; if (R9[0] > x1) x1 = R9[0];
            if (R9[1] < y0) y0 = R9[1]; if (R9[1] > y1) y1 = R9[1];
          }
        }
        return { bb: [x0, y0, x1, y1], w: Math.sign(ar9) };
      });
      // ≥2 opposite-wound counters nested in ONE outer ('8', 'B', '%') → the
      // waist between counters is a MULTI-boundary pinch (a pixel crossed by
      // two independent boundaries needs composed coverage; one face carries
      // one frame) — the legacy additive stack renders those; bail. SINGLE
      // counters ('0', 'o', 'a', 'd') render BETTER here (the '0' at 0.05 vs
      // the legacy path's 4px audit residue).
      for (let i9 = 0; i9 < info9.length; i9++) {
        let counters9 = 0;
        for (let j9 = 0; j9 < info9.length; j9++) {
          if (i9 === j9) continue;
          const A9 = info9[i9].bb, B9 = info9[j9].bb;
          if (!(B9[0] >= A9[0] && B9[1] >= A9[1] && B9[2] <= A9[2] && B9[3] <= A9[3] && info9[j9].w !== 0 && info9[j9].w === -info9[i9].w)) continue;
          counters9++;
          // THIN RING (counter within ~6% of the outer on every side — the
          // MuseoSans-300 '0'): the band is thinner than the split machinery's
          // reach and interior faces leak past the outer curve (7px 1.00).
          // The legacy path's audit handles this outlier at 4px; bail.
          const ow9 = A9[2] - A9[0], oh9 = A9[3] - A9[1];
          const m9 = 0.10 * Math.max(ow9, oh9);
          // curve bands only: the leak class is CURVE frames drifting in a thin
          // band. Pure-line frames (picture frames, diagonal frames) are exact
          // via the kind-0/edge machinery and stay here.
          if (B9[0] - A9[0] < m9 && B9[1] - A9[1] < m9 && A9[2] - B9[2] < m9 && A9[3] - B9[3] < m9) {
            let curved9 = false;
            outer8: for (const c8 of contours) for (const s8 of c8) { if (s8.type !== SEG_LINE) { curved9 = true; break outer8; } }
            if (curved9) return null;
          }
        }
        // ≥2 counters alone is fine ('B', double-storey 'g' measure clean here) —
        // the failing shape is the PINCH: two counters so close that the outer
        // contour's waist between them is a multi-boundary pixel ('8'). Bail
        // only when two counters of this outer approach within ~6% of its size.
        if (counters9 >= 2) {
          const cbs9 = [];
          for (let j9 = 0; j9 < info9.length; j9++) {
            if (j9 === i9) continue;
            const A9 = info9[i9].bb, B9 = info9[j9].bb;
            if (B9[0] >= A9[0] && B9[1] >= A9[1] && B9[2] <= A9[2] && B9[3] <= A9[3] && info9[j9].w === -info9[i9].w) cbs9.push(B9);
          }
          const g9 = 0.06 * Math.max(info9[i9].bb[2] - info9[i9].bb[0], info9[i9].bb[3] - info9[i9].bb[1]);
          for (let a9 = 0; a9 < cbs9.length; a9++) for (let b9 = a9 + 1; b9 < cbs9.length; b9++) {
            const P9 = cbs9[a9], Q9 = cbs9[b9];
            const gx9 = Math.max(P9[0], Q9[0]) - Math.min(P9[2], Q9[2]);
            const gy9 = Math.max(P9[1], Q9[1]) - Math.min(P9[3], Q9[3]);
            if (Math.max(gx9, gy9) < g9) return null;
          }
        }
      }
    }
  }
  // COINCIDENT-EDGE composites (abutting cell subpaths): a straight edge whose
  // exact reverse appears in another subpath is INTERNAL — not a boundary. It
  // stays a CDT constraint, but must carry no AA payload (edge rows/strips/caps
  // were dipping every shared grout line to ~0.7 coverage).
  {
    const seen9 = new Map();
    for (let i9 = 0; i9 < edges.length; i9++) {
      const e9 = edges[i9];
      const k9 = key(e9.p1) + '|' + key(e9.p2), r9 = key(e9.p2) + '|' + key(e9.p1);
      if (seen9.has(r9)) { edges[seen9.get(r9)] = null; edges[i9] = null; }
      else seen9.set(k9, i9);
    }
    let w9 = 0;
    for (let i9 = 0; i9 < edges.length; i9++) if (edges[i9]) edges[w9++] = edges[i9];
    edges.length = w9;
  }
  // CROSSING CONSTRAINTS: cubic hull perimeters include long closing chords
  // (kappa circle quadrants → a diamond through an evenodd ring's band) that
  // properly cross other hull edges — a CDT cannot honor both and drops faces
  // around the crossing (the cubicRing wedge slashes). Split every properly-
  // crossing pair at the intersection, same as the legacy path. CUBIC-ONLY:
  // quad/rquad hull edges never properly cross (their shapes were green before
  // this existed) and the split points broke rquad-ring exactness (arcRing).
  for (let pass9 = 0; pass9 < (cubicRecs.length ? 4 : 0); pass9++) {
    let split9 = false;
    outer9:
    for (let i9 = 0; i9 < constraints.length; i9++) {
      const [a9, b9] = constraints[i9];
      const A9 = pts[a9], B9 = pts[b9];
      for (let j9 = i9 + 1; j9 < constraints.length; j9++) {
        const [c9, d9] = constraints[j9];
        if (c9 === a9 || c9 === b9 || d9 === a9 || d9 === b9) continue;
        const C9 = pts[c9], D9 = pts[d9];
        const r9x = B9[0] - A9[0], r9y = B9[1] - A9[1], s9x = D9[0] - C9[0], s9y = D9[1] - C9[1];
        const den9 = r9x * s9y - r9y * s9x;
        if (Math.abs(den9) < 1e-18) continue;
        const t9 = ((C9[0] - A9[0]) * s9y - (C9[1] - A9[1]) * s9x) / den9;
        const u9 = ((C9[0] - A9[0]) * r9y - (C9[1] - A9[1]) * r9x) / den9;
        if (t9 <= 1e-9 || t9 >= 1 - 1e-9 || u9 <= 1e-9 || u9 >= 1 - 1e-9) continue;
        const X9 = [A9[0] + t9 * r9x, A9[1] + t9 * r9y];
        const xi9 = pts.length; pts.push(X9);
        // provenance for the morph pair: the DST twin of this Steiner point is
        // the intersection of the SAME two constraints on the dst endpoint
        // (parents recorded by coordinate; cascading splits resolve in order)
        steiner9.push({ pt: X9, pa: [A9[0], A9[1]], pb: [B9[0], B9[1]], pc: [C9[0], C9[1]], pd: [D9[0], D9[1]] });
        constraints[i9] = [a9, xi9]; constraints.push([xi9, b9]);
        constraints[j9] = [c9, xi9]; constraints.push([xi9, d9]);
        split9 = true;
        break outer9;
      }
    }
    if (!split9) break;
  }
  let cdtRes = null;
  try { cdtRes = constrainedTriangulate(pts, constraints); } catch { cdtRes = null; }
  if (!cdtRes || !cdtRes.tris || !cdtRes.tris.length) return null;

  // hull membership via a small grid over hull bboxes
  const cell = Math.max((_xb - _xa + _yb - _ya) / 64, 1e-6);
  const hGrid = new Map();
  const hullByVerts = new Map();
  hulls.forEach((h, hi) => hullByVerts.set([h.ai, h.ci, h.bi].sort((x9, y9) => x9 - y9).join(','), hi));
  const cubicByVerts = new Map();
  cubicRecs.forEach((r9, ri9) => cubicByVerts.set([...r9.vis].sort((x9, y9) => x9 - y9).join(','), ri9));
  const cubicGrid = new Map();
  cubicRecs.forEach((r9, ri9) => {
    const xs9 = r9.pts.map((P9) => P9[0]), ys9 = r9.pts.map((P9) => P9[1]);
    const x09 = Math.floor(Math.min(...xs9) / cell), x19 = Math.floor(Math.max(...xs9) / cell);
    const y09 = Math.floor(Math.min(...ys9) / cell), y19 = Math.floor(Math.max(...ys9) / cell);
    for (let cy9 = y09; cy9 <= y19; cy9++) for (let cx9 = x09; cx9 <= x19; cx9++) {
      const k9 = cx9 * 262147 + cy9; let l9 = cubicGrid.get(k9); if (!l9) cubicGrid.set(k9, l9 = []); l9.push(ri9);
    }
  });
  // affine barycentric row interpolation over a cubic fan tri
  const cubicRowsAt = (r9, px9, py9) => {
    const A9 = r9.pts[0], B9 = r9.pts[1], C9 = r9.pts[2];
    const v0x = B9[0] - A9[0], v0y = B9[1] - A9[1], v1x = C9[0] - A9[0], v1y = C9[1] - A9[1];
    const den9 = v0x * v1y - v0y * v1x;
    if (Math.abs(den9) < 1e-18) return null;
    const v2x = px9 - A9[0], v2y = py9 - A9[1];
    const w1 = (v2x * v1y - v2y * v1x) / den9, w2 = (v0x * v2y - v0y * v2x) / den9, w0 = 1 - w1 - w2;
    return [
      w0 * r9.rows[0][0] + w1 * r9.rows[1][0] + w2 * r9.rows[2][0],
      w0 * r9.rows[0][1] + w1 * r9.rows[1][1] + w2 * r9.rows[2][1],
      w0 * r9.rows[0][2] + w1 * r9.rows[1][2] + w2 * r9.rows[2][2],
    ];
  };

  // ---- THIN-CHANNEL mutual clip -----------------------------------------
  // A face inside boundary A's hull can extend across a DIFFERENT boundary B
  // that comes close (the '8' waist, thin glyph rings, the '?' hook's stroke
  // channel). One face carries one frame, so A's coverage paints straight
  // across B's curve. Clip such member faces to B's INK side — the clip edge
  // is exact geometry hidden under B's own AA band; the dropped side is B's
  // air. Candidates come from the grids; adjacent boundaries (shared curve
  // endpoints) are exempt (their curves join smoothly).
  const flatCurve9 = (kind9, i9) => {
    const out9 = [];
    if (kind9 === 0) {
      const h9 = hulls[i9], w9 = h9.w || 1;
      for (let k9 = 0; k9 <= 8; k9++) {
        const t9 = k9 / 8, u9 = 1 - t9;
        const a9 = u9 * u9, b9 = 2 * w9 * u9 * t9, c9 = t9 * t9, den9 = a9 + b9 + c9;
        out9.push([(a9 * h9.a[0] + b9 * h9.c[0] + c9 * h9.b[0]) / den9, (a9 * h9.a[1] + b9 * h9.c[1] + c9 * h9.b[1]) / den9]);
      }
    } else {
      const P9 = cubicRecs[i9].cp;
      for (let k9 = 0; k9 <= 8; k9++) {
        const t9 = k9 / 8, u9 = 1 - t9;
        out9.push([
          u9 * u9 * u9 * P9[0][0] + 3 * u9 * u9 * t9 * P9[1][0] + 3 * u9 * t9 * t9 * P9[2][0] + t9 * t9 * t9 * P9[3][0],
          u9 * u9 * u9 * P9[0][1] + 3 * u9 * u9 * t9 * P9[1][1] + 3 * u9 * t9 * t9 * P9[2][1] + t9 * t9 * t9 * P9[3][1],
        ]);
      }
    }
    return out9;
  };
  const inkSideF9 = (kind9, i9, x9, y9) => {
    if (kind9 === 0) {
      const h9 = hulls[i9];
      const t9 = uvIn(h9, x9, y9);
      if (!t9) return 0;
      const f9 = (h9.w || 1) !== 1 ? (t9[0] * t9[0] - t9[1] * t9[2]) : (t9[0] * t9[0] - t9[1]);
      return h9.sign * f9;
    }
    const r9 = cubicRecs[i9];
    if (r9.rows) { const rr9 = cubicRowsAt(r9, x9, y9); return rr9 ? r9.sign * (rr9[0] * rr9[0] * rr9[0] - rr9[1] * rr9[2]) : 0; }
    return r9.sign * evalBezout(r9.F, x9, y9);
  };
  const endKeys9 = (kind9, i9) => kind9 === 0
    ? [key(hulls[i9].a), key(hulls[i9].b)]
    : [key(cubicRecs[i9].cp[0]), key(cubicRecs[i9].cp[3])];
  // Clip a polygon to the candidate's ink side using its flattened curve.
  // Only segments whose bbox touches the polygon's participate (the curve is
  // locally monotone through a small face, so 1-3 near-parallel half-planes).
  const clipToInk9 = (poly9, kind9, i9) => {
    const pl9 = flatCurve9(kind9, i9);
    let x09 = Infinity, x19 = -Infinity, y09 = Infinity, y19 = -Infinity;
    for (const P9 of poly9) { if (P9[0] < x09) x09 = P9[0]; if (P9[0] > x19) x19 = P9[0]; if (P9[1] < y09) y09 = P9[1]; if (P9[1] > y19) y19 = P9[1]; }
    const pad9 = 1e-9 + 0.05 * Math.max(x19 - x09, y19 - y09);
    let out9 = poly9, touched9 = false;
    for (let k9 = 0; k9 + 1 < pl9.length && out9.length; k9++) {
      const [px9, py9] = pl9[k9], [qx9, qy9] = pl9[k9 + 1];
      if (Math.max(px9, qx9) < x09 - pad9 || Math.min(px9, qx9) > x19 + pad9 ||
          Math.max(py9, qy9) < y09 - pad9 || Math.min(py9, qy9) > y19 + pad9) continue;
      const ex9 = qx9 - px9, ey9 = qy9 - py9;
      const el9 = Math.hypot(ex9, ey9);
      if (el9 < 1e-12) continue;
      // the SEGMENT itself must cross the polygon (or end inside): pure hull
      // overlap without a curve crossing must not cut (the thick '0' lost
      // whole band faces to the cut line's INFINITE extension)
      {
        let touch9 = false;
        const inP9 = (x9, y9) => {
          let in8 = false;
          for (let a9 = 0, b9 = out9.length - 1; a9 < out9.length; b9 = a9++) {
            const Ax9 = out9[a9][0], Ay9 = out9[a9][1], Bx9 = out9[b9][0], By9 = out9[b9][1];
            if ((Ay9 > y9) !== (By9 > y9) && x9 < Ax9 + (y9 - Ay9) / (By9 - Ay9) * (Bx9 - Ax9)) in8 = !in8;
          }
          return in8;
        };
        if (inP9(px9, py9) || inP9(qx9, qy9)) touch9 = true;
        else for (let a9 = 0, b9 = out9.length - 1; a9 < out9.length && !touch9; b9 = a9++) {
          const Ax9 = out9[a9][0], Ay9 = out9[a9][1], Bx9 = out9[b9][0], By9 = out9[b9][1];
          const d19 = (qx9 - px9) * (Ay9 - py9) - (qy9 - py9) * (Ax9 - px9);
          const d29 = (qx9 - px9) * (By9 - py9) - (qy9 - py9) * (Bx9 - px9);
          const d39 = (Bx9 - Ax9) * (py9 - Ay9) - (By9 - Ay9) * (px9 - Ax9);
          const d49 = (Bx9 - Ax9) * (qy9 - Ay9) - (By9 - Ay9) * (qx9 - Ax9);
          if (((d19 > 0) !== (d29 > 0)) && ((d39 > 0) !== (d49 > 0))) touch9 = true;
        }
        if (!touch9) continue;
      }
      const mx9 = (px9 + qx9) / 2, my9 = (py9 + qy9) / 2;
      // keep-side by the candidate's OWN implicit at both offsets (exact for
      // Bezout, locally exact for klmn/quad frames near their curve): winding
      // probes can tie inside sub-pixel channels. Winding remains the tiebreak
      // when the frame can't decide.
      // hug the curve: the frame's SIGN is exact arbitrarily close to it, and a
      // probe wider than the channel can read the same on both sides.
      const off9 = Math.min(el9, pad9) * 0.05 + 1e-9;
      const lx9 = mx9 - (ey9 / el9) * off9, ly9 = my9 + (ex9 / el9) * off9;
      const rx9 = mx9 + (ey9 / el9) * off9, ry9 = my9 - (ex9 / el9) * off9;
      const fL9 = inkSideF9(kind9, i9, lx9, ly9);
      const fR9 = inkSideF9(kind9, i9, rx9, ry9);
      let keep9;
      if (fL9 < 0 !== fR9 < 0) keep9 = fL9 < 0 ? 1 : -1;
      else {
        const iL9 = inkAt(lx9, ly9), iR9 = inkAt(rx9, ry9);
        if (iL9 === iR9) continue;
        keep9 = iL9 ? 1 : -1;
      }
      const side9 = (x9, y9) => keep9 * (ex9 * (y9 - py9) - ey9 * (x9 - px9));
      const nxt9 = [];
      for (let v9 = 0; v9 < out9.length; v9++) {
        const Pc9 = out9[v9], Qc9 = out9[(v9 + 1) % out9.length];
        const sP9 = side9(Pc9[0], Pc9[1]), sQ9 = side9(Qc9[0], Qc9[1]);
        if (sP9 >= 0) nxt9.push(Pc9);
        if ((sP9 >= 0) !== (sQ9 >= 0)) {
          const tt9 = sP9 / (sP9 - sQ9);
          nxt9.push([Pc9[0] + (Qc9[0] - Pc9[0]) * tt9, Pc9[1] + (Qc9[1] - Pc9[1]) * tt9]);
        }
      }
      out9 = nxt9;
      touched9 = true;
    }
    return touched9 ? out9 : null;   // null = untouched (emit the original)
  };
  // Emit a member face, clipped against every nearby foreign boundary.
  const emitClipped9 = (kind9, own9, A9, B9, C9, emit9) => {
    const x09 = Math.min(A9[0], B9[0], C9[0]), x19 = Math.max(A9[0], B9[0], C9[0]);
    const y09 = Math.min(A9[1], B9[1], C9[1]), y19 = Math.max(A9[1], B9[1], C9[1]);
    const cands9 = new Set();
    for (let cy9 = Math.floor(y09 / cell); cy9 <= Math.floor(y19 / cell); cy9++)
      for (let cx9 = Math.floor(x09 / cell); cx9 <= Math.floor(x19 / cell); cx9++) {
        const k9 = cx9 * 262147 + cy9;
        const lq9 = hGrid.get(k9); if (lq9) for (const i9 of lq9) cands9.add(i9 * 2);
        const lc9 = cubicGrid.get(k9); if (lc9) for (const i9 of lc9) cands9.add(i9 * 2 + 1);
      }
    const ownKeys9 = endKeys9(kind9, own9);
    let poly9 = [[A9[0], A9[1]], [B9[0], B9[1]], [C9[0], C9[1]]];
    let any9 = false;
    for (const enc9 of cands9) {
      const ck9 = enc9 & 1, ci9 = enc9 >> 1;
      if (ck9 === (kind9 === 0 ? 0 : 1) && ci9 === own9) continue;
      if (ck9 === 1 && kind9 === 1 && cubicRecs[ci9].pid === cubicRecs[own9].pid) continue;
      // SAME-CONTOUR channels only (the '?' hook: one contour's two sides).
      // Cross-contour overlaps (glyph rings, the droplet) are handled exactly
      // by the membership tiers + split machinery and the clip only hurt them.
      // Cross-shape channels are painter's-order territory, unreachable by any
      // per-shape builder.
      const ownCi9 = kind9 === 0 ? hulls[own9].ci9 : cubicRecs[own9].ci9;
      const candCi9 = ck9 === 0 ? hulls[ci9].ci9 : cubicRecs[ci9].ci9;
      if (ownCi9 !== candCi9) continue;
      const ek9 = endKeys9(ck9, ci9);
      {
        // ADJACENT boundaries (shared curve endpoint) are exempt ONLY at a
        // SMOOTH join — the chain continues through and the curves can't form
        // a channel there. At a TIP the outline doubles back, the away-tangents
        // point the same way, and the two adjacent sides must clip each other.
        const sh9 = (ek9[0] === ownKeys9[0] || ek9[0] === ownKeys9[1]) ? ek9[0]
                  : (ek9[1] === ownKeys9[0] || ek9[1] === ownKeys9[1]) ? ek9[1] : -1;
        if (sh9 !== -1) {
          const away9 = (kk9, ii9, atKey9) => {
            let P0, P1, P2;
            if (kk9 === 0) {
              const h9 = hulls[ii9];
              if (key(h9.a) === atKey9) { P0 = h9.a; P1 = h9.c; P2 = h9.b; }
              else { P0 = h9.b; P1 = h9.c; P2 = h9.a; }
            } else {
              const cp9 = cubicRecs[ii9].cp;
              if (key(cp9[0]) === atKey9) { P0 = cp9[0]; P1 = cp9[1]; P2 = cp9[2]; }
              else { P0 = cp9[3]; P1 = cp9[2]; P2 = cp9[1]; }
            }
            let dx9 = P1[0] - P0[0], dy9 = P1[1] - P0[1];
            if (dx9 * dx9 + dy9 * dy9 < 1e-18) { dx9 = P2[0] - P0[0]; dy9 = P2[1] - P0[1]; }
            const L9 = Math.hypot(dx9, dy9) || 1;
            return [dx9 / L9, dy9 / L9];
          };
          const a19 = away9(kind9 === 0 ? 0 : 1, own9, sh9);
          const a29 = away9(ck9, ci9, sh9);
          // FAT (±2 both-sides) owners keep the blanket exemption: their beyond-side
          // ramp CO-OPERATES with the neighbour at a tip (the droplet's point lost
          // 148px when clipped). Thin ±1 owners (whisker cubics) get the tangent
          // test: a tip-join means the sides run parallel and MUST clip.
          if (kind9 === 0 && hulls[own9].fat && (hulls[own9].w || 1) === 1) continue;
          if (a19[0] * a29[0] + a19[1] * a29[1] < -0.5) continue;   // smooth chain → exempt
          // tip/corner join → fall through: the candidate MAY clip
        }
      }
      // the candidate must GENUINELY overlap this face — its own hull tri must
      // contain a face point (a channel/waist). Grid-grazed neighbours whose
      // frames are extrapolated garbage here were clipping legit ink.
      {
        // DEEP overlap only: the face CENTROID must sit barycentrically inside
        // the candidate's tri with margin. Grazing overlaps (adjacent serration
        // bumps) reached the fp-variant winding fallbacks and flipped a piece
        // across translations (the position-independence smoke); barycentric
        // margins are translation-invariant, so this gate is offset-stable.
        const T9 = ck9 === 0 ? [hulls[ci9].a, hulls[ci9].c, hulls[ci9].b] : cubicRecs[ci9].pts;
        const gx9 = (A9[0] + B9[0] + C9[0]) / 3, gy9 = (A9[1] + B9[1] + C9[1]) / 3;
        {
          const dn9 = (T9[1][0] - T9[0][0]) * (T9[2][1] - T9[0][1]) - (T9[1][1] - T9[0][1]) * (T9[2][0] - T9[0][0]);
          if (Math.abs(dn9) < 1e-18) continue;
          const w19 = ((gx9 - T9[0][0]) * (T9[2][1] - T9[0][1]) - (gy9 - T9[0][1]) * (T9[2][0] - T9[0][0])) / dn9;
          const w29 = ((T9[1][0] - T9[0][0]) * (gy9 - T9[0][1]) - (T9[1][1] - T9[0][1]) * (gx9 - T9[0][0])) / dn9;
          const w09 = 1 - w19 - w29;
          if (Math.min(w09, w19, w29) < 0.02) continue;
        }
      }
      // WHOLE-FACE verdict first: a face lying entirely on the candidate's AIR
      // side never has the candidate's curve CROSSING it, so the segment clip
      // (rightly gated on crossings after the '0'-ring infinite-line overcut)
      // never fires — yet every sample of the face is air by the neighbour
      // that genuinely bounds the ink there (the whisker faces beyond the far
      // side). The overlap gate above already anchors the face to the
      // candidate's hull, so the frame evaluation is in its valid zone.
      {
        // SPAN GUARD: the frame is only trustworthy inside the candidate's own
        // fan tri — at a V-tip (the droplet's point) the arms diverge and the
        // far face corners read garbage-air, dropping legit ink (148px at the
        // drop tip). Whole-face verdicts require the WHOLE face inside the
        // candidate's tri; otherwise only the crossing-gated segment clip runs.
        const T9 = ck9 === 0 ? [hulls[ci9].a, hulls[ci9].c, hulls[ci9].b] : cubicRecs[ci9].pts;
        const inT9 = (px9, py9) => {
          const s1 = (T9[1][0] - T9[0][0]) * (py9 - T9[0][1]) - (T9[1][1] - T9[0][1]) * (px9 - T9[0][0]);
          const s2 = (T9[2][0] - T9[1][0]) * (py9 - T9[1][1]) - (T9[2][1] - T9[1][1]) * (px9 - T9[1][0]);
          const s3 = (T9[0][0] - T9[2][0]) * (py9 - T9[2][1]) - (T9[0][1] - T9[2][1]) * (px9 - T9[2][0]);
          return (s1 >= -1e-9 && s2 >= -1e-9 && s3 >= -1e-9) || (s1 <= 1e-9 && s2 <= 1e-9 && s3 <= 1e-9);
        };
        let allIn9 = true;
        for (const P9 of poly9) if (!inT9(P9[0], P9[1])) { allIn9 = false; break; }
        if (allIn9) {
          let pos9 = 0, neg9 = 0;
          for (const P9 of poly9) {
            const f9 = inkSideF9(ck9, ci9, P9[0], P9[1]);
            if (f9 > 1e-6) pos9++; else if (f9 < -1e-6) neg9++;
          }
          // fp-noise-proof epsilons: 1e-12 flipped verdicts across translations
          // (the position-independence smoke: 33q vs 32q at offset 0.0312)
          if (pos9 === poly9.length) poly9 = [];
          if (!poly9.length) return;
          if (neg9 === poly9.length) continue;   // wholly on the candidate's ink side
        }
      }
      const res9 = clipToInk9(poly9, ck9, ci9);
      if (res9 === null) continue;
      any9 = true;
      poly9 = res9;
      if (!poly9.length) return;
    }
    if (!any9) { emit9(A9, B9, C9); return; }
    for (let v9 = 1; v9 + 1 < poly9.length; v9++) emit9(poly9[0], poly9[v9], poly9[v9 + 1]);
  };


  hulls.forEach((h, hi) => {
    const xs = [h.a[0], h.c[0], h.b[0]], ys = [h.a[1], h.c[1], h.b[1]];
    const x0 = Math.floor(Math.min(...xs) / cell), x1 = Math.floor(Math.max(...xs) / cell);
    const y0 = Math.floor(Math.min(...ys) / cell), y1 = Math.floor(Math.max(...ys) / cell);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const k = cx * 262147 + cy; let l = hGrid.get(k); if (!l) hGrid.set(k, l = []); l.push(hi);
    }
  });
  const inTri9 = (px, py, A, C, B) => {
    const s1 = (C[0] - A[0]) * (py - A[1]) - (C[1] - A[1]) * (px - A[0]);
    const s2 = (B[0] - C[0]) * (py - C[1]) - (B[1] - C[1]) * (px - C[0]);
    const s3 = (A[0] - B[0]) * (py - B[1]) - (A[1] - B[1]) * (px - B[0]);
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  };
  // standard-frame uv of a point in a hull (affine barycentric)
  const uvIn = uvInHull;   // module-level (shared with the morph pair transform)

  const interior = [];
  const hullEdgeOf = new Map();   // face-edge key → hull idx, filled by pass 1 (hull members)
  const hullVertOf = new Map();   // vertex idx → hull idx (junction fans share only a vertex)
  const ekey9 = (i9, j9) => i9 < j9 ? i9 * 2097152 + j9 : j9 * 2097152 + i9;
  const pushInt = (A9, B9, C9) => { interior.push(A9[0], A9[1], B9[0], B9[1], C9[0], C9[1]); };
  const quads = [];
  const plain9 = [];   // pass-2 queue: faces not inside any hull
  for (const t of cdtRes.tris) {
    const A = pts[t[0]], B = pts[t[1]], C = pts[t[2]];
    const cx = (A[0] + B[0] + C[0]) / 3, cy = (A[1] + B[1] + C[1]) / 3;
    // cubic hull membership: exact fan-tri vertex match, else containment with
    // barycentric row adoption (subdivided hulls); Bezout F needs no rows.
    {
      const cvk9 = [t[0], t[1], t[2]].sort((x9, y9) => x9 - y9).join(',');
      const cri9 = cubicByVerts.get(cvk9);
      if (cri9 !== undefined && cubicRecs[cri9].invis9) { pushInt(A, B, C); continue; }
      if (cri9 !== undefined) {
        const r9 = cubicRecs[cri9];
        emitClipped9(1, cri9, A, B, C, (Pa9, Pb9, Pc9) => {
          if (r9.rows) {
            const ra9 = cubicRowsAt(r9, Pa9[0], Pa9[1]), rb9 = cubicRowsAt(r9, Pb9[0], Pb9[1]), rc9 = cubicRowsAt(r9, Pc9[0], Pc9[1]);
            if (!ra9 || !rb9 || !rc9) return;
            cubics.push({ hull: new Float32Array([Pa9[0], Pa9[1], Pb9[0], Pb9[1], Pc9[0], Pc9[1]]),
              klmn: new Float32Array([...ra9, ...rb9, ...rc9]), sign: r9.sign, cp: r9.cp, _ri9: cri9 });
          } else cubics.push({ hull: new Float32Array([Pa9[0], Pa9[1], Pb9[0], Pb9[1], Pc9[0], Pc9[1]]), F: r9.F, sign: r9.sign, _ri9: cri9 });
        });
        continue;
      }
      const cl9 = cubicGrid.get(Math.floor(cx / cell) * 262147 + Math.floor(cy / cell));
      let hit9 = -1;
      // tiered resolution (thin shapes have OVERLAPPING hulls from both sides):
      // whole-face containment with fp slack, SMALLEST fan tri wins; centroid
      // first-wins only as the fallback.
      if (cl9) {
        let bestAr9 = Infinity;
        for (const ri9 of cl9) {
          const r9 = cubicRecs[ri9];
          if (!inTri9(cx, cy, r9.pts[0], r9.pts[1], r9.pts[2])) continue;
          const ar9 = Math.abs((r9.pts[1][0] - r9.pts[0][0]) * (r9.pts[2][1] - r9.pts[0][1]) - (r9.pts[1][1] - r9.pts[0][1]) * (r9.pts[2][0] - r9.pts[0][0]));
          const sl9 = 1e-7 * (ar9 + 1e-12);
          const inE9 = (px9, py9) => {
            const s1 = (r9.pts[1][0] - r9.pts[0][0]) * (py9 - r9.pts[0][1]) - (r9.pts[1][1] - r9.pts[0][1]) * (px9 - r9.pts[0][0]);
            const s2 = (r9.pts[2][0] - r9.pts[1][0]) * (py9 - r9.pts[1][1]) - (r9.pts[2][1] - r9.pts[1][1]) * (px9 - r9.pts[1][0]);
            const s3 = (r9.pts[0][0] - r9.pts[2][0]) * (py9 - r9.pts[2][1]) - (r9.pts[0][1] - r9.pts[2][1]) * (px9 - r9.pts[2][0]);
            return (s1 >= -sl9 && s2 >= -sl9 && s3 >= -sl9) || (s1 <= sl9 && s2 <= sl9 && s3 <= sl9);
          };
          if (!inE9(A[0], A[1]) || !inE9(B[0], B[1]) || !inE9(C[0], C[1])) continue;
          if (ar9 < bestAr9) { bestAr9 = ar9; hit9 = ri9; }
        }
        // fallback: centroid-only, SMALLEST containing rec wins — first-wins
        // picked an overlapping neighbour's frame for subdivided faces and the
        // wrong-frame side read beyond-curve (cov→0: the leaf's white zones).
        if (hit9 < 0) {
          let ba9 = Infinity;
          for (const ri9 of cl9) {
            const r9 = cubicRecs[ri9];
            if (!inTri9(cx, cy, r9.pts[0], r9.pts[1], r9.pts[2])) continue;
            const ar9 = Math.abs((r9.pts[1][0] - r9.pts[0][0]) * (r9.pts[2][1] - r9.pts[0][1]) - (r9.pts[1][1] - r9.pts[0][1]) * (r9.pts[2][0] - r9.pts[0][0]));
            if (ar9 < ba9) { ba9 = ar9; hit9 = ri9; }
          }
        }
      }
      if (hit9 >= 0 && cubicRecs[hit9].invis9) { pushInt(A, B, C); continue; }
      if (hit9 >= 0) {
        const r9 = cubicRecs[hit9];
        let emitted9 = false;
        emitClipped9(1, hit9, A, B, C, (Pa9, Pb9, Pc9) => {
          if (r9.rows) {
            const ra9 = cubicRowsAt(r9, Pa9[0], Pa9[1]), rb9 = cubicRowsAt(r9, Pb9[0], Pb9[1]), rc9 = cubicRowsAt(r9, Pc9[0], Pc9[1]);
            if (!ra9 || !rb9 || !rc9) return;
            cubics.push({ hull: new Float32Array([Pa9[0], Pa9[1], Pb9[0], Pb9[1], Pc9[0], Pc9[1]]),
              klmn: new Float32Array([...ra9, ...rb9, ...rc9]), sign: r9.sign, cp: r9.cp, _ri9: hit9 });
            emitted9 = true;
          } else { cubics.push({ hull: new Float32Array([Pa9[0], Pa9[1], Pb9[0], Pb9[1], Pc9[0], Pc9[1]]), F: r9.F, sign: r9.sign, _ri9: hit9 }); emitted9 = true; }
        });
        continue;
      }
    }
    // hull membership. Hulls OVERLAP across contours (a glyph's outer hull can
    // contain the whole counter hull), so first-containing-wins misassigns the
    // frame ('0': counter faces adopted the OUTER hull's sign). Resolution order:
    // (1) exact vertex-index match (the pure hull face), (2) whole-face
    // containment with the SMALLEST hull winning (tightest frame).
    let hin = -1;
    {
      const vs9 = [t[0], t[1], t[2]].sort((x9, y9) => x9 - y9).join(',');
      const byIdx9 = hullByVerts.get(vs9);
      if (byIdx9 !== undefined) hin = byIdx9;
      else {
        let bestArea9 = Infinity;
        const cellList = hGrid.get(Math.floor(cx / cell) * 262147 + Math.floor(cy / cell));
        if (cellList) for (const hi of cellList) {
          const h = hulls[hi];
          if (!inTri9(cx, cy, h.a, h.c, h.b)) continue;
          // vertex containment with relative slack: subdivided-face verts sit ON
          // hull edges and fp puts them ±1e-12 outside (strict reject → unclaimed
          // faces → droplet holes).
          const sl9 = 1e-7 * (Math.abs((h.c[0] - h.a[0]) * (h.b[1] - h.a[1]) - (h.c[1] - h.a[1]) * (h.b[0] - h.a[0])) + 1e-12);
          const inE9 = (px9, py9) => {
            const s1 = (h.c[0] - h.a[0]) * (py9 - h.a[1]) - (h.c[1] - h.a[1]) * (px9 - h.a[0]);
            const s2 = (h.b[0] - h.c[0]) * (py9 - h.c[1]) - (h.b[1] - h.c[1]) * (px9 - h.c[0]);
            const s3 = (h.a[0] - h.b[0]) * (py9 - h.b[1]) - (h.a[1] - h.b[1]) * (px9 - h.b[0]);
            return (s1 >= -sl9 && s2 >= -sl9 && s3 >= -sl9) || (s1 <= sl9 && s2 <= sl9 && s3 <= sl9);
          };
          if (!inE9(A[0], A[1]) || !inE9(B[0], B[1]) || !inE9(C[0], C[1])) continue;
          // among containing hulls (thin rings: a face sits inside BOTH the
          // inner and outer arc's hull), the face belongs to the arc whose
          // CHORD is nearest — smallest-area picked the INNER hull for outer-
          // band faces and painted past the outer curve (thin-ring '0' 7px).
          const mx9 = (h.a[0] + h.b[0]) / 2, my9 = (h.a[1] + h.b[1]) / 2;
          const d9 = (mx9 - cx) * (mx9 - cx) + (my9 - cy) * (my9 - cy);
          if (d9 < bestArea9) { bestArea9 = d9; hin = hi; }
        }
        // nothing passed whole-face containment (fp-shifted verts after CDT
        // recovery): centroid-only first-wins — the original behaviour — as the
        // safety net; unclaimed-face fallout is worse than a rare frame mismatch.
        if (hin < 0 && cellList) for (const hi of cellList) {
          const h = hulls[hi];
          if (inTri9(cx, cy, h.a, h.c, h.b)) { hin = hi; break; }
        }
      }
    }
    if (hin >= 0 && constraintsOnly9.has(hin)) {
      // INVISIBLE boundary (both sides ink): the hull region is plain solid.
      pushInt(A, B, C);
      continue;
    }
    if (hin >= 0) {
      const h = hulls[hin];
      const t0 = uvIn(h, A[0], A[1]), t1 = uvIn(h, B[0], B[1]), t2 = uvIn(h, C[0], C[1]);
      if (t0 && t1 && t2) {
        // _fat: the HULL's fatness (the ring/±2 pairing criterion) — with the exact
        // per-segment sign, ±2 both-sides = saturate the ink side + ramp the other:
        // the outside AA band that closes the 0.3-level seam class.
        emitClipped9(0, hin, A, B, C, (Pa9, Pb9, Pc9) => {
          const ta9 = uvIn(h, Pa9[0], Pa9[1]), tb9 = uvIn(h, Pb9[0], Pb9[1]), tc9 = uvIn(h, Pc9[0], Pc9[1]);
          if (!ta9 || !tb9 || !tc9) return;
          quads.push({ tri: new Float32Array([Pa9[0], Pa9[1], Pb9[0], Pb9[1], Pc9[0], Pc9[1]]), sign: h.sign, w: h.w || 1, _fat: (h.w || 1) === 1 ? !!h.fat : undefined, _hi9: hin,
            tc: new Float32Array([ta9[0], ta9[1], ta9[2], tb9[0], tb9[1], tb9[2], tc9[0], tc9[1], tc9[2]]) });
        });
        hullEdgeOf.set(ekey9(t[0], t[1]), hin); hullEdgeOf.set(ekey9(t[1], t[2]), hin); hullEdgeOf.set(ekey9(t[2], t[0]), hin);
        for (const vi9 of t) if (!hullVertOf.has(vi9)) hullVertOf.set(vi9, hin);
        continue;
      }
    }
    plain9.push([t, A, B, C, cx, cy]);
  }
  // ---- pass 2: plain faces. Faces sharing an edge with a HULL MEMBER adopt
  // that hull's frame (structural adjacency — index-key chord lookup missed
  // subdivided hulls); oversized adoptees fan-split; the rest classify by
  // exact probes.
  for (const [t, A, B, C, cx, cy] of plain9) {
    // Unclaimed face: 4 exact probes (centroid + vert→centroid midpoints).
    // All-ink → plain interior. All-air → dropped (razor air wedges between
    // consecutive hull edges at seam vertices — single-ray ties painted them
    // solid). MIXED → the face STRADDLES the outline outside any hull (the seam
    // wedge between consecutive arcs): attach it to the NEAREST hull's frame —
    // barycentric tc extrapolates cleanly and curveCov supplies the ramp, the
    // face's own boundary acts as the clip (the legacy tangent-clip-extension
    // equivalent; without this every seam-adjacent boundary pixel lost its
    // outside AA — the partition path's 0.3-level seam class).
    {
      // each probe casts its OWN ray direction: with one shared axis ray, a
      // razor face hugging a boundary tied the SAME way at all four probes
      // (correlated) and went solid past the outer curve (thin-ring '0').
      const inkD9 = (x9, y9, k9) => {
        const w9 = k9 === 0 ? rayWinding(allSegs, x9, y9 + _eps)
          : k9 === 1 ? rayWindingDir(allSegs, x9, y9, 0.9271838545667874, 0.37460659341591207)
          : k9 === 2 ? rayWindingDir(allSegs, x9, y9, -0.29552020666133955, 0.9553364891256061)
          : rayWindingDir(allSegs, x9, y9, 0.6216099682706644, -0.7833269096274834);
        return evenodd ? (w9 & 1) === 1 : w9 !== 0;
      };
      let ink9 = inkD9(cx, cy, 0) ? 1 : 0;
      ink9 += inkD9((A[0] + cx) / 2, (A[1] + cy) / 2, 1) ? 1 : 0;
      ink9 += inkD9((B[0] + cx) / 2, (B[1] + cy) / 2, 2) ? 1 : 0;
      ink9 += inkD9((C[0] + cx) / 2, (C[1] + cy) / 2, 3) ? 1 : 0;
      if (ink9 >= 4) { pushInt(A, B, C); continue; }
      if (ink9 === 0) continue;
      // mixed: nearest hull by chord-midpoint distance (grid cells first, global fallback)
      let best9 = -1, bd9 = Infinity;
      const scanH9 = (hi9) => {
        const h9 = hulls[hi9];
        const mx9 = (h9.a[0] + h9.b[0]) / 2, my9 = (h9.a[1] + h9.b[1]) / 2;
        const d9 = (mx9 - cx) * (mx9 - cx) + (my9 - cy) * (my9 - cy);
        if (d9 < bd9) { bd9 = d9; best9 = hi9; }
      };
      const cl9 = hGrid.get(Math.floor(cx / cell) * 262147 + Math.floor(cy / cell));
      if (cl9) for (const hi9 of cl9) scanH9(hi9);
      if (best9 < 0) for (let hi9 = 0; hi9 < hulls.length; hi9++) scanH9(hi9);
      if (best9 >= 0 && constraintsOnly9.has(best9)) { if (ink9 >= 2) pushInt(A, B, C); continue; }
      if (best9 >= 0) {
        const h9 = hulls[best9];
        const t09 = uvIn(h9, A[0], A[1]), t19 = uvIn(h9, B[0], B[1]), t29 = uvIn(h9, C[0], C[1]);
        if (t09 && t19 && t29) {
          // both-sides always: the straddler face carries the boundary RAMP on
          // whichever side it pokes (its own extent is the clip; ±1 discarded the
          // outside half of every shallow-arc boundary pixel → binary edges).
          quads.push({ tri: new Float32Array([A[0], A[1], B[0], B[1], C[0], C[1]]), sign: h9.sign, w: h9.w || 1, _fat: (h9.w || 1) === 1 ? true : undefined, _hi9: best9,
            tc: new Float32Array([t09[0], t09[1], t09[2], t19[0], t19[1], t19[2], t29[0], t29[1], t29[2]]) });
          continue;
        }
      }
      if (ink9 >= 2) pushInt(A, B, C);
    }
  }
  // Band post-pass: split large interior faces at the arcs' AA band and adopt
  // near-curve pieces. The splitter is builder-agnostic (flat tris + arc
  // records in), so the partition path can share it without re-deriving gates.
  // Cubic channel self-audit: sample each piece's paint verdict (centroid + 3
  // vert-mids) against exact winding. If >15% of samples mispaint, the shape
  // needs composed coverage that this builder cannot express and draws via Slug.
  if (cubics.length) {
    let bad9 = 0, tot9 = 0;
    for (const c9 of cubics) {
      const H9 = c9.hull;
      const gx9 = (H9[0] + H9[2] + H9[4]) / 3, gy9 = (H9[1] + H9[3] + H9[5]) / 3;
      const den9 = (H9[2] - H9[0]) * (H9[5] - H9[1]) - (H9[3] - H9[1]) * (H9[4] - H9[0]);
      for (const [px9, py9] of [[gx9, gy9],
        [(H9[0] + gx9) / 2, (H9[1] + gy9) / 2], [(H9[2] + gx9) / 2, (H9[3] + gy9) / 2], [(H9[4] + gx9) / 2, (H9[5] + gy9) / 2],
        [(H9[0] + H9[2]) / 2 * 0.7 + gx9 * 0.3, (H9[1] + H9[3]) / 2 * 0.7 + gy9 * 0.3],
        [(H9[2] + H9[4]) / 2 * 0.7 + gx9 * 0.3, (H9[3] + H9[5]) / 2 * 0.7 + gy9 * 0.3],
        [(H9[4] + H9[0]) / 2 * 0.7 + gx9 * 0.3, (H9[5] + H9[1]) / 2 * 0.7 + gy9 * 0.3],
        [H9[0] * 0.85 + gx9 * 0.15, H9[1] * 0.85 + gy9 * 0.15],
        [H9[2] * 0.85 + gx9 * 0.15, H9[3] * 0.85 + gy9 * 0.15],
        [H9[4] * 0.85 + gx9 * 0.15, H9[5] * 0.85 + gy9 * 0.15]]) {
        let f9;
        if (c9.klmn) {
          if (Math.abs(den9) < 1e-18) continue;
          const w19 = ((px9 - H9[0]) * (H9[5] - H9[1]) - (py9 - H9[1]) * (H9[4] - H9[0])) / den9;
          const w29 = ((H9[2] - H9[0]) * (py9 - H9[1]) - (H9[3] - H9[1]) * (px9 - H9[0])) / den9;
          const w09 = 1 - w19 - w29;
          const T9 = c9.klmn;
          const k9 = w09 * T9[0] + w19 * T9[3] + w29 * T9[6], l9 = w09 * T9[1] + w19 * T9[4] + w29 * T9[7], m9 = w09 * T9[2] + w19 * T9[5] + w29 * T9[8];
          f9 = c9.sign * (k9 * k9 * k9 - l9 * m9);
        } else f9 = c9.sign * evalBezout(c9.F, px9, py9);
        if (f9 > -1e-9 && f9 < 1e-9) continue;   // on the ramp: no verdict
        tot9++;
        // ONLY over-paint is a defect: a piece painting AIR is wrong wherever
        // it happens, but NOT-painting ink is fine — an overlapping neighbour
        // covers it (the crescent's fat pair reads 'under' all over its
        // overlap zone and was false-flagged to Slug).
        if (f9 < 0 && !inkAt(px9, py9)) bad9++;
      }
    }
    if (tot9 >= 8 && bad9 > 0 && bad9 * 100 > tot9 * 2) return null;
    // AUDIT-MARGINAL shapes (some over-paint, under the Slug gate): their
    // pieces genuinely CO-COVER pixels (thin fur), where single-owner depth
    // under-paints and the blend union was accidentally right — mark them to
    // keep BLEND compositing (the pack folds the flag into the kind fraction;
    // the VS drops their pieces to the interior tier).
    blendTier9 = bad9 > 0;
  }

    // DEPTH-CARVE EXPERIMENT: whole interior faces (no band splitting, no
    // healing) — the hull pieces + strips carve them via the depth test.
    // CORNER-AWARE interior rows: run the row-attachment machinery with EMPTY
    // arc maps — no band splitting happens, but every face gets its nearest
    // fitting boundary line PLUS the corner's second/third lines (the
    // kind-0 box-combine payload). Under the depth-claim cascade the interior
    // is the JUNCTION WEDGE's owner (pieces' spans end at the corner), and
    // multi-row box coverage is exactly the corner-combined truth there —
    // a single row paints 1.0 where the reference ramps, and single-owner
    // compositing turns that same gap into holes.
    // opts.plainRows skips the corner-row attachment pass. SEGMENT morph
    // pairs build at mid-morph lerped endpoints, where near-flip geometry
    // degenerates the corner classification — they take plain rows on both
    // endpoints; statics and plain (t=0/1) pairs keep the full pass.
    const rowsPlan9 = (opts && opts.plainRows)
      ? { solid: new Float32Array(interior),
          solidEdges: selfOrientRows(interiorEdgesFromTriPoints(new Float32Array(interior), edges), interior),
          solidEdges2: null, solidEdges3: null }
      : splitInteriorByCurve(
        new Float32Array(interior),
        selfOrientRows(interiorEdgesFromTriPoints(new Float32Array(interior), edges), interior),
        new Map(), new Map(), true, edges);
    const meshD9 = {
      interior: rowsPlan9.solid instanceof Float32Array ? rowsPlan9.solid : new Float32Array(rowsPlan9.solid),
      interiorEdges: rowsPlan9.solidEdges instanceof Float32Array ? rowsPlan9.solidEdges : new Float32Array(rowsPlan9.solidEdges),
      interiorEdges2: rowsPlan9.solidEdges2 ? new Float32Array(rowsPlan9.solidEdges2) : null,
      interiorEdges3: rowsPlan9.solidEdges3 ? new Float32Array(rowsPlan9.solidEdges3) : null,
      quads, cubics, edges, fallback: fallback9,
      caps: buildCornerCaps2(contours),
      curveStrips: true, stripArcs, _topo: null,
      _blendTier9: blendTier9,   // audit-marginal: the pack keeps these shapes on blend compositing
      hulls9: hulls,   // per-seg hull recs: the morph pair transform reframes tc against the DST hulls
      cubicRecs9: cubicRecs,   // per-fan-tri cubic recs (cp + provenance) for the pair transform
      steiner9,        // crossing-splitter Steiner points + parent coords
    };
    meshD9._route = 'partition-carve';
    return meshD9;
}
