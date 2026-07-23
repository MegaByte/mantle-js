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
import { _kox, _koy, _koScale, _setKeyOrigin, rayWinding, rayWindingDir, buildSegWindingTree, treeWinding, calibrateInterior, verifyInteriorSign, segTangents, edgeEndMeta, fatArc } from './lbContour.js';
import { splitInteriorByCurve, _healCand } from './lbInteriorSplit.js';
import { selfOrientRows, interiorEdgesFromTriPoints, interiorChainsFromTris, subdivideBoundaryTriPoints } from './lbFastMesh.js';
// ---- EXACT-PARTITION builder (Loop-Blinn 2005): control points ARE triangulation
// vertices and hull edges ARE constraints, so every CDT face is either plain
// interior or (a piece of) a curve hull — the partition is exact by
// construction. One exact side-bit per SEGMENT (not per face) orients the
// curve pieces. No claims matching, no adoption, no post-hoc face splitting,
// no T-junction healing — those exist to patch the overlay model this
// replaces. Quads + lines only (the game-art common case); callers fall back
// to the legacy builder for cubics/rquads.
// Apex-tangent supporting-line clip for a Bezout cubic crescent (3-point hull) that
// over-paints air beyond its arc. The sub-piece is inflection-free (the builder splits
// at inflections) → convex, so the tangent at the curve apex (t=½) is a SUPPORTING line:
// the whole arc lies on the chord side of it. Clipping the hull to that side removes the
// beyond-apex region — where the Bezout resultant's spurious branch paints air — with NO
// under-fill (the arc is kept). Returns fan triangles ([[x,y]×3]) of the clipped hull;
// null if the hull is entirely on the keep side (over-paint is in the apex lens, clip
// can't help); [] if it clips away to nothing.
function apexTangentClip(hull, cp) {
  if (!cp || cp.length !== 4) return null;
  const t = 0.5, u = 0.5;
  const ax = u*u*u*cp[0][0] + 3*u*u*t*cp[1][0] + 3*u*t*t*cp[2][0] + t*t*t*cp[3][0];
  const ay = u*u*u*cp[0][1] + 3*u*u*t*cp[1][1] + 3*u*t*t*cp[2][1] + t*t*t*cp[3][1];
  let tx = 3*(u*u*(cp[1][0]-cp[0][0]) + 2*u*t*(cp[2][0]-cp[1][0]) + t*t*(cp[3][0]-cp[2][0]));
  let ty = 3*(u*u*(cp[1][1]-cp[0][1]) + 2*u*t*(cp[2][1]-cp[1][1]) + t*t*(cp[3][1]-cp[2][1]));
  const tl = Math.hypot(tx, ty); if (tl < 1e-9) return null;
  let nx = -ty / tl, ny = tx / tl;
  const cmx = (cp[0][0]+cp[3][0])/2, cmy = (cp[0][1]+cp[3][1])/2;
  if (nx*(cmx-ax) + ny*(cmy-ay) < 0) { nx = -nx; ny = -ny; }   // normal → chord (keep) side
  const sd = (px, py) => nx*(px-ax) + ny*(py-ay);
  const poly = [[hull[0],hull[1]],[hull[2],hull[3]],[hull[4],hull[5]]];
  let anyOut = false; const out = [];
  for (let i = 0; i < 3; i++) {
    const A = poly[i], B = poly[(i+1)%3], dA = sd(A[0],A[1]), dB = sd(B[0],B[1]);
    if (dA < 0) anyOut = true;
    if (dA >= 0) out.push(A);
    if ((dA >= 0) !== (dB >= 0)) { const w = dA / (dA - dB); out.push([A[0]+w*(B[0]-A[0]), A[1]+w*(B[1]-A[1])]); }
  }
  if (!anyOut) return null;
  const removed = [];
  for (let i = 0; i < 3; i++) if (sd(poly[i][0], poly[i][1]) < 0) removed.push(poly[i]);
  if (out.length < 3) return { tris: [], removed };
  const tris = [];
  for (let i = 1; i < out.length - 1; i++) tris.push([out[0], out[i], out[i+1]]);
  return { tris, removed };
}

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
  // Winding tree: the side-bit probes below call inkAt once per curved segment, which made
  // the whole build O(N^2) through the linear rayWinding on segment-heavy shapes. The tree
  // answers each probe in O(log N + near) with IDENTICAL results (near segments use the
  // same exact solvers; far runs collapse to their chords — see windingTree.js). Null below
  // the cutoff, where the linear walk wins.
  const _wTree = buildSegWindingTree(allSegs);
  const _windAt = _wTree
    ? (x, y) => treeWinding(_wTree, x, y + _eps)
    : (x, y) => rayWinding(allSegs, x, y + _eps);
  const inkAt = evenodd
    ? (x, y) => (_windAt(x, y) & 1) === 1
    : (x, y) => _windAt(x, y) !== 0;

  const pts = [];
  const idxOf = new Map();
  const key = (p) => Math.round((p[0] - _kox) * _koScale) * 2097152 + Math.round((p[1] - _koy) * _koScale);
  const add = (p) => { const k = key(p); let i = idxOf.get(k); if (i === undefined) { i = pts.length; idxOf.set(k, i); pts.push([p[0], p[1]]); } return i; };
  const constraints = [];
  const hulls = [];        // { a, c, b, sign } per curved seg (w=1 integral quads)
  const constraintsOnly9 = new Set();   // hull idx → INVISIBLE boundary (both sides ink): solid fill, no AA payload
  const steiner9 = [];     // crossing-splitter insertions + their parent coords (morph pair correspondence)
  const edges = [];        // straight-edge kind-0/10 payloads (same shape the pack expects)
  const stripArcs = [];    // CDT fat-ring arcs (pack plans kind-12 bands from these)
  const fallback9 = [];   // loop/cusp segs → the caller's per-shape Slug fallback
  let hasCurve9 = false;  // any quad/rquad/cubic seg → keeps the crossing-split cubic-only (arcRing safety)
  let blendTier9 = false; // audit-marginal (fur): pieces keep BLEND compositing
  const cubicRecs = [];   // per fan-tri cubic hull records: { vis, P(2x3 or 4), rows(K/L/M)|F, sign }
  const cubics = [];      // mesh.cubics output (kind 2/4)

  let contourIdx9 = -1;
  for (const segs of contours) {
    contourIdx9++;
    if (!segs.length) continue;
    let interiorSign = calibrateInterior(segs, (pp) => inkAt(pp[0], pp[1]));
    // VERIFY the calibration with a direct travel-frame probe. A wrong sign here put
    // every kind-10 strip on the INK side of straight edges — the G's crossbar lost its
    // entire outside partial row (Slug 166 vs LB 255, 646 px>0.3 at 2.5×) while the
    // inside double-blended. Originally line-only; generalized to any seg type (secant
    // tangents) because LINE-LESS contours — glyph bowls like the '8' — were never
    // verified, and their kind-12 bands inherited inverted normals/corner types.
    interiorSign = verifyInteriorSign(segs, (pp) => inkAt(pp[0], pp[1]), interiorSign);
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
        hasCurve9 = true;
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
          //
          // Distance is 0.01·chord, NOT 0.05: a chord-fraction probe OVERSHOOTS a
          // fill thinner than the offset, reads the far side, and flips the crescent
          // sign — the whole crescent then paints AIR and the self-audit declines the
          // shape to Slug. Thin fills (tiger fur) were the dominant decline; 0.01
          // clears the boundary fp-tie yet stays inside the thinnest real fills
          // (tiger 107→113 shapes on LB, corpus otherwise unchanged). Point-winding
          // (inkAt) here beats the contour-global sideInFill the fast mesh uses —
          // that trusts interiorSign, which is miscalibrated on some shapes (Salmon).
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
              const off9 = 0.01 * chord9;
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
              // Kind-12 end meta: real at contour-segment ends; type-0 stub at split joints.
              e1: pieceIdx9 === 0 ? edgeEndMeta(segs, tg, si, 0, interiorSign)
                : { nN: [0, 0], k: 0, type: 0, curve: true, tsign: 1, qn: true, turn: 0 },
              e2: pieceIdx9 === pieces9.length - 1 ? edgeEndMeta(segs, tg, si, 1, interiorSign)
                : { nN: [0, 0], k: 0, type: 0, curve: true, tsign: 1, qn: true, turn: 0 },
              a: P[0], b: P[3],
              na: (() => {
                const u = (x, y) => { const L = Math.hypot(x, y); return L > 1e-12 ? [x / L, y / L] : null; };
                return u(P[1][0] - P[0][0], P[1][1] - P[0][1])
                  || u(P[2][0] - P[0][0], P[2][1] - P[0][1])
                  || u(P[3][0] - P[0][0], P[3][1] - P[0][1]);
              })(),
              nb: (() => {
                const u = (x, y) => { const L = Math.hypot(x, y); return L > 1e-12 ? [x / L, y / L] : null; };
                const tB = u(P[3][0] - P[2][0], P[3][1] - P[2][1])
                  || u(P[3][0] - P[1][0], P[3][1] - P[1][1])
                  || u(P[3][0] - P[0][0], P[3][1] - P[0][1]);
                return tB ? [-tB[0], -tB[1]] : null;
              })(),
            });
          }
        }
        continue;
      }
      // quad/rquad: ctrl is a vertex; hull edges are constraints (the Loop-Blinn paper's key move)
      hasCurve9 = true;
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
      // e1/e2: kind-12 band end metadata (neighbour normal/curvature/type per end).
      stripArcs.push({ tri: new Float32Array([s9.p1[0], s9.p1[1], s9.p2[0], s9.p2[1], s9.p3[0], s9.p3[1]]), sign, w: w9q, ci9: contourIdx9, si9: si,
        e1: edgeEndMeta(segs, tg, si, 0, interiorSign), e2: edgeEndMeta(segs, tg, si, 1, interiorSign) });
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
          // A counter within roughly 10% of the outer boundary on every side
          // is thinner than the split machinery's reach; interior faces can
          // leak past the outer curve, so retain the fallback route.
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
        // ≥2 counters alone is fine ('B', double-storey 'g'). A PINCH waist ('8')
        // used to bail on a bbox-% gap heuristic; that is gone — kind-12 must own
        // the multi-boundary pixel (near-antiparallel partition + honesty radius)
        // without falling back to Slug. Thin-ring bail above stays: that failure
        // is interior leak, not corner coverage.
      }
    }
  }
  // COINCIDENT-EDGE composites (abutting cell subpaths): a straight edge whose
  // exact reverse appears in another subpath is INTERNAL — not a boundary. It
  // stays a CDT constraint, but must carry no AA payload (edge rows/bands
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
  // crossing pair at the intersection, same as the fast path. Fires for CUBIC
  // shapes (hull closing chords) and for ALL-STRAIGHT shapes (self-crossing
  // outlines — pentagram/bowtie — whose contour edges genuinely cross; these are
  // pure contour constraints so there are no quad/rquad hull edges to disturb).
  // Quad/rquad shapes stay excluded: their hull edges never properly cross and the
  // split points broke rquad-ring exactness (arcRing).
  // Split EVERY properly-crossing pair found per sweep (a constraint that
  // splits moves to the next i — its halves get re-scanned next pass).
  // The old one-split-per-pass restart made this O(passes·C²) AND capped
  // TOTAL splits at the pass count (8): shapes with more crossings (dense
  // cubic closing-chords, complex self-crossing outlines) left crossings
  // unsplit, and the CDT dropped faces around them with no fallback.
  for (let pass9 = 0; pass9 < ((cubicRecs.length || !hasCurve9) ? 32 : 0); pass9++) {
    let nSplit9 = 0;
    for (let i9 = 0; i9 < constraints.length; i9++) {
      const [a9, b9] = constraints[i9];
      const A9 = pts[a9], B9 = pts[b9];
      // Constraint i9's bbox, hoisted out of the inner scan: two segments whose
      // AABBs are disjoint cannot cross, so the reject below skips the intersection
      // math (2 divisions) for the vast majority of pairs on segment-heavy shapes —
      // an exact filter, so the SAME crossings are found in the SAME order.
      const ax09 = A9[0] < B9[0] ? A9[0] : B9[0], ax19 = A9[0] < B9[0] ? B9[0] : A9[0];
      const ay09 = A9[1] < B9[1] ? A9[1] : B9[1], ay19 = A9[1] < B9[1] ? B9[1] : A9[1];
      for (let j9 = i9 + 1; j9 < constraints.length; j9++) {
        const [c9, d9] = constraints[j9];
        if (c9 === a9 || c9 === b9 || d9 === a9 || d9 === b9) continue;
        const C9 = pts[c9], D9 = pts[d9];
        if (ax19 < (C9[0] < D9[0] ? C9[0] : D9[0]) || (C9[0] < D9[0] ? D9[0] : C9[0]) < ax09
          || ay19 < (C9[1] < D9[1] ? C9[1] : D9[1]) || (C9[1] < D9[1] ? D9[1] : C9[1]) < ay09) continue;
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
        nSplit9++;
        break;   // constraint i9 changed — its halves re-scan next pass
      }
    }
    if (!nSplit9) break;
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

  // ---- THIN-CHANNEL whole-face AIR drop ---------------------------------
  // A member face can lie entirely on a nearby SAME-CONTOUR boundary's AIR side
  // (whisker faces beyond a thin channel's far wall: the '8' waist, thin glyph
  // rings, the '?' hook). emitClipped9 drops such faces using the exact
  // per-boundary implicit inkSideF9. (The old partial chord clip that reshaped
  // STRADDLING faces — flatCurve9/clipToInk9 — flattened the boundary to a fixed
  // 8 em-space chords, a scale-bounded approximation with no device error bound;
  // it was inert under the shipping PART_CHAIN route and is removed.)
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
  // Emit a member face, dropping it when it lies WHOLLY on a nearby same-contour
  // boundary's air side.
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
    const poly9 = [[A9[0], A9[1]], [B9[0], B9[1]], [C9[0], C9[1]]];
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
          // (caught by the position-independence smoke)
          if (pos9 === poly9.length) return;   // face wholly on this boundary's AIR side → drop
          // neg9 === length (wholly ink) or a straddle: this candidate does not
          // drop the face — keep scanning the rest.
        }
      }
    }
    emit9(A9, B9, C9);
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

  let interior = [];
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
              klmn: new Float32Array([...ra9, ...rb9, ...rc9]), sign: r9.sign, cp: r9.cp, _ri9: cri9,
              e1: r9.e1, e2: r9.e2, a: r9.a, b: r9.b, na: r9.na, nb: r9.nb });
          } else cubics.push({ hull: new Float32Array([Pa9[0], Pa9[1], Pb9[0], Pb9[1], Pc9[0], Pc9[1]]), F: r9.F, sign: r9.sign, cp: r9.cp, _ri9: cri9,
              e1: r9.e1, e2: r9.e2, a: r9.a, b: r9.b, na: r9.na, nb: r9.nb });
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
              klmn: new Float32Array([...ra9, ...rb9, ...rc9]), sign: r9.sign, cp: r9.cp, _ri9: hit9,
              e1: r9.e1, e2: r9.e2, a: r9.a, b: r9.b, na: r9.na, nb: r9.nb });
            emitted9 = true;
          } else { cubics.push({ hull: new Float32Array([Pa9[0], Pa9[1], Pb9[0], Pb9[1], Pc9[0], Pc9[1]]), F: r9.F, sign: r9.sign, cp: r9.cp, _ri9: hit9,
              e1: r9.e1, e2: r9.e2, a: r9.a, b: r9.b, na: r9.na, nb: r9.nb }); emitted9 = true; }
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
        emitClipped9(0, hin, A, B, C, (Pa9, Pb9, Pc9) => {
          const ta9 = uvIn(h, Pa9[0], Pa9[1]), tb9 = uvIn(h, Pb9[0], Pb9[1]), tc9 = uvIn(h, Pc9[0], Pc9[1]);
          if (!ta9 || !tb9 || !tc9) return;
          // Fatness for tip-clip exemption lives on the hull (`h.fat`); pack
          // uses live fatArc for ring vs bbox — no per-quad `_fat` stamp.
          quads.push({ tri: new Float32Array([Pa9[0], Pa9[1], Pb9[0], Pb9[1], Pc9[0], Pc9[1]]), sign: h.sign, w: h.w || 1, _hi9: hin,
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
          // Straddler face carries the boundary ramp on whichever side it pokes
          // (extent is the clip). Kind-12 owns exterior AA when bands are present.
          quads.push({ tri: new Float32Array([A[0], A[1], B[0], B[1], C[0], C[1]]), sign: h9.sign, w: h9.w || 1, _hi9: best9,
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
    // DROP near-degenerate cubic pieces (hull collapsed toward a POINT). Such a
    // sub-sliver covers ~0 arc length, so removing it leaves no crack — but its
    // implicit is numerically unstable at ~0 extent, so it emits spurious f<0 samples.
    // Kept in the mesh those become an over-paint that GROWS with zoom (a degenerate
    // triangle's area scales with the reuse scale); left in the audit they FALSELY
    // decline the whole shape to Slug (1st_Fish: 3 collapsed pieces → 2 lost shapes).
    // Extent, NOT area (a long thin crescent has tiny area yet is visible), below a
    // sub-pixel fraction of the shape. Mutating the const array drops them from the
    // returned mesh too, so they never render at any zoom.
    //
    // STATIC ONLY. A morph PAIR builds its dst cubics one-to-one against THIS src's
    // cubics (buildLoopBlinnPartitionPair), and a piece that is degenerate at the SRC
    // pose can grow into a real crescent at the DST pose — dropping it here would
    // desync the pair and under-fill the dst end of the morph. Morph builds (they pass
    // plainRows for transient mid-frames or skipCurveInterior for the pair) keep EVERY
    // piece to preserve the src↔dst correspondence; a genuinely-degenerate over-paint
    // there still declines via the audit below (→ correct Slug morph).
    if (!(opts && (opts.plainRows || opts.skipCurveInterior))) {
      let _dx0 = Infinity, _dy0 = Infinity, _dx1 = -Infinity, _dy1 = -Infinity;
      for (const c9 of cubics) { const h9 = c9.hull;
        for (let k9 = 0; k9 < 6; k9 += 2) {
          if (h9[k9] < _dx0) _dx0 = h9[k9]; if (h9[k9] > _dx1) _dx1 = h9[k9];
          if (h9[k9 + 1] < _dy0) _dy0 = h9[k9 + 1]; if (h9[k9 + 1] > _dy1) _dy1 = h9[k9 + 1];
        } }
      const _diag9 = Math.hypot(_dx1 - _dx0, _dy1 - _dy0) || 1;
      // 0.3% of the shape diagonal: a hull with EVERY edge below this is collapsed
      // toward a point (sub-pixel at sane zoom, ~0 arc length). Verified to drop only
      // spurious sub-slivers — corpus over/drop unchanged at 1× and 4× resolution, real
      // pieces (Salmon) untouched — while recovering falsely-declined shapes.
      // globalThis.__LB_MIN_EDGE is a test hook (lbDegenerateCubicDropSmoke A/Bs it);
      // 0 disables the drop. Nullish, so an explicit 0 is honoured.
      const _mef9 = (typeof globalThis !== 'undefined' && globalThis.__LB_MIN_EDGE != null) ? globalThis.__LB_MIN_EDGE : 3e-3;
      const _minEdge9 = _mef9 * _diag9;
      const _kept9 = cubics.filter((c9) => {
        const H9 = c9.hull;
        const e019 = Math.hypot(H9[2] - H9[0], H9[3] - H9[1]);
        const e129 = Math.hypot(H9[4] - H9[2], H9[5] - H9[3]);
        const e209 = Math.hypot(H9[0] - H9[4], H9[1] - H9[5]);
        return Math.max(e019, e129, e209) >= _minEdge9;
      });
      if (_kept9.length !== cubics.length) { cubics.length = 0; for (const c9 of _kept9) cubics.push(c9); }
    }
    // Sample each cubic piece's paint verdict (centroid + vert-mids) against exact
    // winding: a piece painting AIR (f<0 && !inkAt) is a defect. Factored so the
    // apex clip below can RE-audit the clipped pieces. Returns per-piece bad marks too.
    const scanCubics9 = (cubs) => {
      let bad = 0, tot = 0; const badSet = new Set();
      for (const c9 of cubs) {
        const H9 = c9.hull;
        const gx9 = (H9[0] + H9[2] + H9[4]) / 3, gy9 = (H9[1] + H9[3] + H9[5]) / 3;
        const den9 = (H9[2] - H9[0]) * (H9[5] - H9[1]) - (H9[3] - H9[1]) * (H9[4] - H9[0]);
        let pb = 0;
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
          tot++;
          // ONLY over-paint is a defect: a piece painting AIR is wrong wherever it
          // happens, but NOT-painting ink is fine — an overlapping neighbour covers it.
          if (f9 < 0 && !inkAt(px9, py9)) { bad++; pb++; }
        }
        if (pb > 0) badSet.add(c9);
      }
      return { bad, tot, badSet };
    };
    let { bad: bad9, tot: tot9, badSet: badSet9 } = scanCubics9(cubics);
    // APEX-TANGENT CLIP (static only, OPT-IN via __LB_APEX_CLIP): when a shape would
    // decline, clip each over-painting BEZOUT crescent to the chord side of its arc's apex
    // tangent (a supporting line for the convex sub-piece) — removing the beyond-apex region
    // where the resultant's spurious branch paints air, with no under-fill. RE-audit; keep
    // the shape only if the clip removed ALL over-paint (else decline, as before — no
    // over-paint ever ships). Selective (only over-painting pieces) so clean shapes /
    // glyphs are byte-identical. Morph builds (plainRows/skipCurveInterior) are excluded:
    // clipping the src changes piece count and would desync the pair.
    //
    // Recovers the fat-poke decline class (tiger 163→154) and is over-paint-correct at 1×
    // and 4×. DEFAULT-ON but CONVEX-ONLY (the clip below skips a piece whose removed region
    // is INK): an air-bordering clip has no adjacent face to crack, so it is T-junction-free
    // (tiger forced-LB drop 30→32 at 4× vs 30→49 clipping concave too). __LB_APEX_CLIP===false
    // disables it (the smoke A/Bs that); concave over-painters still decline.
    if (tot9 >= 8 && bad9 > 0 && !(opts && (opts.plainRows || opts.skipCurveInterior))
        && (typeof globalThis === 'undefined' || globalThis.__LB_APEX_CLIP !== false)) {
      let ok = true; const kept9 = [];
      for (const c9 of cubics) {
        if (!badSet9.has(c9)) { kept9.push(c9); continue; }
        if (c9.klmn) { ok = false; break; }   // klmn clip needs per-vertex interp — not yet
        const clip9 = apexTangentClip(c9.hull, c9.cp);
        if (clip9 === null) { ok = false; break; }   // over-paint is in the apex lens; clip can't help
        // The clip is T-JUNCTION-FREE only when the removed region is AIR (a convex
        // crescent — its control edges border nothing): then no adjacent face gets a
        // clip vertex mid-edge. If the removed region is INK (concave), a neighbouring
        // interior face abuts the clip → a crack; decline instead (no half-fix).
        if (clip9.removed.some((v) => inkAt(v[0], v[1]))) { ok = false; break; }
        for (const tr9 of clip9.tris) kept9.push({ hull: new Float32Array([tr9[0][0], tr9[0][1], tr9[1][0], tr9[1][1], tr9[2][0], tr9[2][1]]), F: c9.F, sign: c9.sign, cp: c9.cp, _ri9: c9._ri9 });
      }
      if (ok) {
        const rescan9 = scanCubics9(kept9);
        if (!(rescan9.tot >= 8 && rescan9.bad > 0)) { cubics.length = 0; for (const c9 of kept9) cubics.push(c9); bad9 = 0; }
      }
    }
    // ANY air over-paint declines to Slug (see history: the 2% tolerance shipped visible
    // ant/Broccoli slivers). tot9>=8 keeps the noise floor.
    if (tot9 >= 8 && bad9 > 0) return null;
    // AUDIT-MARGINAL shapes (some over-paint, under the Slug gate): their pieces genuinely
    // CO-COVER pixels (thin fur) — keep BLEND compositing (folded into the kind fraction).
    blendTier9 = bad9 > 0;
  }

    // DEPTH-CARVE interior: kind-0 solids + hull crescents + kind-12 bands.
    // Chord-adjacent interior faces must ramp by the arc (font bowls): bare
    // solids paint 1.0 just inside the chord while AAC is ~50%. Pass hull
    // chords into splitInteriorByCurve (same as fast-mesh) so those faces
    // become kind-5 curveTris.
    //
    // plainRows: no corner-row pass (segment morph mid-frames).
    // skipCurveInterior: corner rows with EMPTY arc maps — morph pairs
    // transform quads via hull `_hi9`, and fill-side curveTris have no hull,
    // so appending them makes pair build return null → Slug (lbHoleParity).
    // Split corner triangles carrying ≥2 STRAIGHT boundary edges so every edge
    // gets its own inner ramp (both the chain and line-row branches pack one
    // ramp/chain per face). Skipped for the morph opts (their pair build depends
    // on a fixed src↔dst vertex correspondence). See subdivideBoundaryTriPoints.
    if (!(opts && (opts.plainRows || opts.skipCurveInterior)))
      interior = subdivideBoundaryTriPoints(interior, edges);
    // A translucent solid must use the non-overlapping partition, but a simple
    // convex contour does not need analytic interior chains. Its curve bands
    // already provide AA, while running a chain kernel over the large interior
    // faces is substantially more expensive. Keep chains for every shape with
    // a reflex corner, concave curve, hole, or non-static build.
    const simpleConvexTranslucent9 = !!(opts && opts.transSolid)
      && contours.length === 1
      && cubicRecs.length === 0
      && hulls.some((h9) => !h9.invis9)
      && hulls.every((h9) => h9.invis9 || (h9.sign || 1) >= 0)
      && edges.every((e9) => (!e9.e1 || e9.e1.turn >= -1e-6) && (!e9.e2 || e9.e2.turn >= -1e-6))
      && stripArcs.every((a9) => (!a9.e1 || a9.e1.turn >= -1e-6) && (!a9.e2 || a9.e2.turn >= -1e-6));
    let rowsPlan9;
    if (opts && opts.plainRows) {
      rowsPlan9 = { solid: new Float32Array(interior),
          solidEdges: selfOrientRows(interiorEdgesFromTriPoints(new Float32Array(interior), edges), interior),
          solidEdges2: null, solidEdges3: null, curveTris: [] };
    } else if (opts && opts.skipCurveInterior) {
      rowsPlan9 = splitInteriorByCurve(
        new Float32Array(interior),
        selfOrientRows(interiorEdgesFromTriPoints(new Float32Array(interior), edges), interior),
        new Map(), new Map(), true, edges);
    } else if (globalThis.__LB_PART_CHAIN !== false && hulls.length && !simpleConvexTranslucent9) {
      // PURE-STRAIGHT shapes (no curve hulls — HUD rects, straight glyphs like
      // E/H/L/T) skip the chain route and take the line-row ramp path below: the
      // chain kernel leaves a rectangle's horizontal edges solid-to-boundary
      // (a translucent over-fill ring), while the ramp path — with the corner
      // subdivision above — matches Slug to within a corner pixel. The chain
      // route stays the default only where it earns its keep, on curves.
      // ANALYTIC CHAINS for the partition interior: faces carry
      // their local rim chains instead of line rows + chord curveTris. The rim
      // here = straight edges + hull pseudo-edges with ONE orientation rule:
      // outward normal = perp toward the hull's REMAINING vertex (convex chord
      // a-b -> toward ctrl; concave legs a-ctrl, ctrl-b -> toward b, a — the
      // concave rim detours through ctrl, so the legs ARE the boundary).
      // A hull's chain boundary = the 2-piece CURVE polyline a→m→b, m = the
      // on-curve midpoint (a+2wc+b)/(2+2w) — approximates the true boundary to
      // sagitta/4, resolution-independent, correct in BOTH regimes that the
      // simpler choices break: the CHORD halves coverage at deep-sagitta bows
      // (a box just inside a deep chord can't see the curve: truth 1.0), and
      // the LEGS over-fill the curve's own AA band at shallow bows (a pixel
      // whose center is inside-chord but whose box straddles the curve gets no
      // crescent fragment to reject it). Outward normal: toward ctrl for
      // convex (ctrl outside fill), away for concave — the fill side of the
      // CURVE, one rule for both signs.
      /** @type {Array<{p1:number[], p2:number[], nx:number, ny:number, c?:number[]}>} */
      const chainEdges9 = edges.slice();
      const pushPE9 = (P1, P2, T, toward, ctrl) => {
        const dx = P2[0] - P1[0], dy = P2[1] - P1[1], L = Math.hypot(dx, dy);
        if (L < 1e-9) return;
        let nx = -dy / L, ny = dx / L;
        const side = nx * (T[0] - P1[0]) + ny * (T[1] - P1[1]);
        if ((side > 0) !== toward) { nx = -nx; ny = -ny; }
        // `c` (when present) makes this pseudo-edge a real QUADRATIC for the
        // conic chain path; the normal still describes the chord, which is all
        // the ordering/orientation logic uses.
        chainEdges9.push(ctrl ? { p1: P1, p2: P2, nx, ny, c: ctrl } : { p1: P1, p2: P2, nx, ny });
      };
      // rational-quad point at t (de Casteljau with weight w)
      const qAt9 = (a, c, b, w, t) => {
        const u = 1 - t, den = u * u + 2 * u * t * w + t * t;
        return [(u * u * a[0] + 2 * u * t * w * c[0] + t * t * b[0]) / den,
                (u * u * a[1] + 2 * u * t * w * c[1] + t * t * b[1]) / den];
      };
      for (const h9 of hulls) {
        if (h9.invis9 || globalThis.__LB_PART_NOHULL === true) continue;
        const w9 = h9.w || 1;
        const m9 = qAt9(h9.a, h9.c, h9.b, w9, 0.5);
        const toward9 = (h9.sign || 1) >= 0;   // convex: outward = toward ctrl
        // Bound polyline error by the hull sagitta. Power-of-two subdivision
        // keeps neighbouring pieces stable under small geometry changes.
        const mx9 = (h9.a[0] + h9.b[0]) / 2, my9 = (h9.a[1] + h9.b[1]) / 2;
        const sag9 = Math.hypot(m9[0] - mx9, m9[1] - my9);
        const conicHull9 = globalThis.__LB_CONIC === true && Math.abs(w9 - 1) < 1e-3;
        // Exact conic integration needs less subdivision, but the CDT still
        // needs enough on-curve points to keep each face's chain local.
        const tol9 = globalThis.__LB_HULL_TOL || (conicHull9 ? 0.002 : 0.00025);
        let n9 = 2;
        while (n9 < (globalThis.__LB_HULL_CAP || 64) && sag9 / (n9 * n9) > tol9) n9 *= 2;
        // Conic mode carries each integral quadratic sub-arc's control point;
        // rational quadratics stay on the polyline path.
        const conic9 = conicHull9;
        const subC9 = (u, v) => {
          const w0 = (1 - u) * (1 - v), w1 = u * (1 - v) + v * (1 - u), w2 = u * v;
          return [w0 * h9.a[0] + w1 * h9.c[0] + w2 * h9.b[0],
                  w0 * h9.a[1] + w1 * h9.c[1] + w2 * h9.b[1]];
        };
        let prev9 = h9.a;
        for (let i9 = 1; i9 <= n9; i9++) {
          const nxt9 = i9 === n9 ? h9.b : qAt9(h9.a, h9.c, h9.b, w9, i9 / n9);
          pushPE9(prev9, nxt9, h9.c, toward9, conic9 ? subC9((i9 - 1) / n9, i9 / n9) : null);
          prev9 = nxt9;
        }
      }
      const coords9 = [], tris9 = [];
      for (let i9 = 0; i9 + 1 < interior.length; i9 += 2) { coords9.push([interior[i9], interior[i9 + 1]]); tris9.push(tris9.length); }
      const ch9 = interiorChainsFromTris(coords9, tris9, chainEdges9);
      rowsPlan9 = { solid: new Float32Array(interior), solidEdges: null, solidEdges2: null, solidEdges3: null, curveTris: [], chains9: ch9 };
    } else {
      const chordArcs9 = new Map(), vertexArcs9 = new Map();
      const ck9 = (p) => Math.round((p[0] - _kox) * _koScale) * 2097152 + Math.round((p[1] - _koy) * _koScale);
      for (const h9 of hulls) {
        if (h9.invis9) continue;
        const arc9 = { a: h9.a, ctrl: h9.c, b: h9.b, sign: h9.sign, w: h9.w || 1 };
        const ka9 = ck9(h9.a), kb9 = ck9(h9.b);
        chordArcs9.set(ka9 < kb9 ? ka9 + '|' + kb9 : kb9 + '|' + ka9, arc9);
        let la9 = vertexArcs9.get(ka9); if (!la9) vertexArcs9.set(ka9, la9 = []); la9.push(arc9);
        let lb9 = vertexArcs9.get(kb9); if (!lb9) vertexArcs9.set(kb9, lb9 = []); lb9.push(arc9);
      }
      rowsPlan9 = splitInteriorByCurve(
        new Float32Array(interior),
        selfOrientRows(interiorEdgesFromTriPoints(new Float32Array(interior), edges), interior),
        chordArcs9, vertexArcs9, true, edges);
      if (rowsPlan9.curveTris && rowsPlan9.curveTris.length)
        for (const ct9 of rowsPlan9.curveTris) quads.push(ct9);
    }
    const meshD9 = {
      interior: rowsPlan9.solid instanceof Float32Array ? rowsPlan9.solid : new Float32Array(rowsPlan9.solid),
      interiorChainA: rowsPlan9.chains9 ? rowsPlan9.chains9.chainA : undefined,
      interiorChainB: rowsPlan9.chains9 ? rowsPlan9.chains9.chainB : undefined,
      interiorChainC: rowsPlan9.chains9 ? rowsPlan9.chains9.chainC : undefined,
      interiorChainD: rowsPlan9.chains9 ? rowsPlan9.chains9.chainD : undefined,
      interiorChainE: rowsPlan9.chains9 ? rowsPlan9.chains9.chainE : undefined,
      interiorHasChain2: rowsPlan9.chains9 ? rowsPlan9.chains9.hasChain2 : undefined,
      interiorEdges: rowsPlan9.solidEdges == null ? null : (rowsPlan9.solidEdges instanceof Float32Array ? rowsPlan9.solidEdges : new Float32Array(rowsPlan9.solidEdges)),
      interiorEdges2: rowsPlan9.solidEdges2 ? new Float32Array(rowsPlan9.solidEdges2) : null,
      interiorEdges3: rowsPlan9.solidEdges3 ? new Float32Array(rowsPlan9.solidEdges3) : null,
      quads, cubics, edges, fallback: fallback9,
      stripArcs, _topo: null,
      _blendTier9: blendTier9,   // audit-marginal: the pack keeps these shapes on blend compositing
      hulls9: hulls,   // per-seg hull recs: the morph pair transform reframes tc against the DST hulls
      cubicRecs9: cubicRecs,   // per-fan-tri cubic recs (cp + provenance) for the pair transform
      steiner9,        // crossing-splitter Steiner points + parent coords
    };
    meshD9._route = 'partition-carve';
    return meshD9;
}
