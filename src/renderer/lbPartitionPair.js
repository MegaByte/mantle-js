// lbPartitionPair.js — the partition morph pair: build the STATIC partition
// mesh on the SRC endpoint (lbPartition, unmodified), then derive the DST mesh by
// PROVENANCE TRANSFORM against the DST hulls with the same frame helpers,
// so topology is identical by construction and the pair packs into the
// dual-stream morph VBO (VS lerps positions/frames; t=0/1 byte-identical
// to the static renders). partitionPairMidError is the mid-morph drift oracle
// callers use to split the t-range for cubic-bearing pairs.
import { SEG_LINE, SEG_CUBIC, SEG_RQUAD } from '../primitives/seg.js';
import { bezoutCubicImplicit, cubicKLMN, cubicSignKLMN, splitCubicMulti, partitionCubicSplitTs, uvInHull, cubicSign, cubicPt } from './lbCubicMath.js';
import { _kox, _koy, _koScale, _setKeyOrigin, rayWinding, calibrateInterior, segTangents, edgeEndMeta, fatArc } from './lbContour.js';
import { splitInteriorByCurve } from './lbInteriorSplit.js';
import { selfOrientRows, interiorEdgesFromTriPoints } from './lbFastMesh.js';
import { buildLoopBlinnPartition } from './lbPartition.js';

// ── PARTITION MORPH PAIR ──────────────────────────────────────────────────────
// One code path for morphs: build the STATIC partition mesh on the SRC endpoint
// (the unmodified builder), then derive the DST mesh by PROVENANCE TRANSFORM —
// every emitted vertex is a seg point (registered under the same quantized
// key), every frame recomputes against the DST hull with the same helpers
// (uvInHull / edgeEndMeta / interiorEdgesFromTriPoints).
// Identical topology by construction, so the pair packs into a dual-stream
// morph VBO where the VS lerps positions/frames and t=0/1 are byte-identical
// to the static partition renders. Cubic-bearing pairs transform through the
// shared partitionCubicSplitTs plan (the caller t-segments when mid-morph
// drift exceeds the oracle). Returns null (caller falls back to the
// t-segmented pair or Slug) for: structure mismatch, convex↔concave flips,
// near-flat disagreement, strip-plan divergence, clip-produced (unmapped)
// vertices, circles/annuli (kind-7 SDF records have no pair transform).
export function buildLoopBlinnPartitionPair(srcContours, dstContours, fillRule, opts) {
  if (!srcContours || !dstContours || srcContours.length !== dstContours.length) return null;
  for (let c = 0; c < srcContours.length; c++) {
    const sc = srcContours[c], dc = dstContours[c];
    if (!dc || sc.length !== dc.length) return null;
    for (let i = 0; i < sc.length; i++) {
      if (sc[i].type !== dc[i].type) return null;

      if (sc[i].type === SEG_RQUAD && Math.abs((sc[i].w || 1) - (dc[i].w || 1)) > 1e-9) return null;
    }
  }
  const transient9 = !!(opts && opts.plainDstRows);   // segment pairs: plain rows BOTH endpoints
  // skipCurveInterior: pair transforms quads by hull `_hi9`; fill-side curveTris
  // from the static bowl fix have none → pair would return null → Slug morph.
  const src = buildLoopBlinnPartition(srcContours, {
    fillRule: fillRule || 'nonzero', plainRows: transient9, skipCurveInterior: !transient9,
  });
  if (!src || (src.fallback && src.fallback.length)) return null;
  // Circle SDF records do not have a partition-pair transform.
  for (const q of src.quads) if (/** @type {any} */ (q).circle) return null;

  // key(srcPoint) → dstPoint, same quantization the builder registered under
  _setKeyOrigin(srcContours);
  const kOf = (x, y) => Math.round((x - _kox) * _koScale) * 2097152 + Math.round((y - _koy) * _koScale);
  const map9 = new Map();
  for (let c = 0; c < srcContours.length; c++) {
    const sc = srcContours[c], dc = dstContours[c];
    for (let i = 0; i < sc.length; i++) {
      const sg = sc[i], dg = dc[i];
      map9.set(kOf(sg.p1[0], sg.p1[1]), dg.p1);
      if (sg.type === SEG_LINE) map9.set(kOf(sg.p2[0], sg.p2[1]), dg.p2);
      else if (sg.type === SEG_CUBIC) {
        // the builder subdivides at partitionCubicSplitTs — register every PIECE
        // point under the same plan applied to BOTH endpoints (the shared plan
        // is exactly why it was factored out)
        map9.set(kOf(sg.p2[0], sg.p2[1]), dg.p2);
        map9.set(kOf(sg.p3[0], sg.p3[1]), dg.p3);
        map9.set(kOf(sg.p4[0], sg.p4[1]), dg.p4);
        const P0s = [sg.p1, sg.p2, sg.p3, sg.p4], P0d = [dg.p1, dg.p2, dg.p3, dg.p4];
        const plan = partitionCubicSplitTs(P0s);
        if (plan.ts.length) {
          const ps = splitCubicMulti(P0s, plan.ts), pd = splitCubicMulti(P0d, plan.ts);
          for (let k = 0; k < ps.length; k++)
            for (let j = 0; j < 4; j++) map9.set(kOf(ps[k][j][0], ps[k][j][1]), pd[k][j]);
        }
      }
      else { map9.set(kOf(sg.p2[0], sg.p2[1]), dg.p2); map9.set(kOf(sg.p3[0], sg.p3[1]), dg.p3); }
    }
  }
  const mapPt = (x, y) => map9.get(kOf(x, y)) || null;

  // STEINER correspondence: each crossing-splitter insertion maps to the
  // intersection of the SAME two constraints on the dst endpoint. Parents are
  // seg points (or earlier Steiner points — recorded in insertion order, so
  // resolution cascades). The dst constraints must still PROPERLY cross; a
  // vanished crossing means the topology changed between endpoints → bail.
  for (const st9 of (src.steiner9 || [])) {
    const pa = mapPt(st9.pa[0], st9.pa[1]), pb = mapPt(st9.pb[0], st9.pb[1]);
    const pc = mapPt(st9.pc[0], st9.pc[1]), pd = mapPt(st9.pd[0], st9.pd[1]);
    if (!pa || !pb || !pc || !pd) return null;
    const rx = pb[0] - pa[0], ry = pb[1] - pa[1], sx = pd[0] - pc[0], sy = pd[1] - pc[1];
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-18) return null;
    const t = ((pc[0] - pa[0]) * sy - (pc[1] - pa[1]) * sx) / den;
    const u = ((pc[0] - pa[0]) * ry - (pc[1] - pa[1]) * rx) / den;
    if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null;
    map9.set(kOf(st9.pt[0], st9.pt[1]), [pa[0] + t * rx, pa[1] + t * ry]);
  }

  // dst-side per-contour calibration — EXACT seg winding (the builder's own
  // inkAt semantics): chord-ring polygonization misreads probes inside THIN
  // slivers (the crescent's dst sign check false-bailed on it).
  const allSegsD = [];
  for (const dc of dstContours) for (const sg of dc) allSegsD.push(sg);
  const evenoddD = fillRule === 'evenodd';
  const inFillD = (p) => {
    const w = rayWinding(allSegsD, p[0], p[1]);
    return evenoddD ? (w & 1) !== 0 : w !== 0;
  };
  const interiorSignD = dstContours.map((dc) => calibrateInterior(dc, inFillD));

  // interior: pure vertex map
  const si = src.interior, di = new Float32Array(si.length);
  for (let i = 0; i < si.length; i += 2) {
    const mp = mapPt(si[i], si[i + 1]);
    if (!mp) return null;                       // clip/Steiner vertex → bail
    di[i] = mp[0]; di[i + 1] = mp[1];
  }

  // hulls → dst hulls (per-seg), with convex/concave flip + strip-plan checks
  const hullsD = new Array(src.hulls9.length);
  for (let hi = 0; hi < src.hulls9.length; hi++) {
    const h = src.hulls9[hi];
    const dg = dstContours[h.ci9][h.si9];
    const hd = { a: [dg.p1[0], dg.p1[1]], c: [dg.p2[0], dg.p2[1]], b: [dg.p3[0], dg.p3[1]], w: h.w, sign: h.sign };
    const crossS = (h.b[0] - h.a[0]) * (h.c[1] - h.a[1]) - (h.b[1] - h.a[1]) * (h.c[0] - h.a[0]);
    const crossD = (hd.b[0] - hd.a[0]) * (hd.c[1] - hd.a[1]) - (hd.b[1] - hd.a[1]) * (hd.c[0] - hd.a[0]);
    if (crossS === 0 || crossD === 0 || (crossS > 0) !== (crossD > 0)) return null;   // ctrl crossed the chord
    hd.fat = fatArc(hd.a[0], hd.a[1], hd.c[0], hd.c[1], hd.b[0], hd.b[1]);
    if (!!h.fat !== !!hd.fat) return null;      // pack strip plan (6 vs 15 verts) would diverge
    hullsD[hi] = hd;
  }

  // quads: mapped tris, tc reframed against the dst hull (same uvInHull)
  const quadsD = new Array(src.quads.length);
  for (let qi = 0; qi < src.quads.length; qi++) {
    const q = src.quads[qi];
    const hd = q._hi9 != null ? hullsD[q._hi9] : null;
    if (!hd) return null;
    const T = q.tri, TD = new Float32Array(6), tcD = new Float32Array(9);
    for (let k = 0; k < 3; k++) {
      const mp = mapPt(T[2 * k], T[2 * k + 1]);
      if (!mp) return null;
      TD[2 * k] = mp[0]; TD[2 * k + 1] = mp[1];
      const uv = uvInHull(hd, mp[0], mp[1]);
      if (!uv) return null;
      tcD[3 * k] = uv[0]; tcD[3 * k + 1] = uv[1]; tcD[3 * k + 2] = uv[2];
    }
    quadsD[qi] = { tri: TD, tc: tcD, sign: q.sign, w: q.w };
  }

  // edges: rebuilt from the dst segs with the same emit math + end metadata
  const dtg = dstContours.map((dc) => dc.map(segTangents));
  const edgesD = new Array(src.edges.length);
  for (let ei = 0; ei < src.edges.length; ei++) {
    const e = src.edges[ei];
    if (e.ci9 == null) return null;
    const dc = dstContours[e.ci9], dg = dc[e.si9];
    const outD = -interiorSignD[e.ci9];
    let p1d, p2d;
    if (e.flat9 === 'arc') {
      // the SRC piece was near-flat (sag < 0.4% chord) and emitted a LINE —
      // the DST piece must agree or the pair geometry lies
      const chx = dg.p3[0] - dg.p1[0], chy = dg.p3[1] - dg.p1[1];
      const chL = Math.hypot(chx, chy);
      const sag = chL > 1e-12 ? Math.abs((dg.p2[0] - dg.p1[0]) * (chy / chL) - (dg.p2[1] - dg.p1[1]) * (chx / chL)) : 0;
      if (sag >= 0.004 * chL) return null;
      p1d = dg.p1; p2d = dg.p3;
    } else if (e.flat9 === 'cubic') {
      // Near-line CUBIC demotion spans p1→p4 — dg.p2 is the first CONTROL
      // point (~⅓ along the curve); building the dst edge on it misplaced
      // the straight-edge AA/strips at t→1. Same near-flat re-check as
      // the arc branch (both control points must hug the chord).
      const chx = dg.p4[0] - dg.p1[0], chy = dg.p4[1] - dg.p1[1];
      const chL = Math.hypot(chx, chy);
      if (chL > 1e-12) {
        const nx9 = chy / chL, ny9 = -chx / chL;
        const s2 = Math.abs((dg.p2[0] - dg.p1[0]) * nx9 + (dg.p2[1] - dg.p1[1]) * ny9);
        const s3 = Math.abs((dg.p3[0] - dg.p1[0]) * nx9 + (dg.p3[1] - dg.p1[1]) * ny9);
        if (Math.max(s2, s3) >= 0.004 * chL) return null;
      }
      p1d = dg.p1; p2d = dg.p4;
    } else { p1d = dg.p1; p2d = dg.p2; }
    const ex = p2d[0] - p1d[0], ey = p2d[1] - p1d[1], L = Math.hypot(ex, ey);
    if (L < 1e-9) return null;
    edgesD[ei] = { p1: p1d, p2: p2d, nx: (-ey / L) * outD, ny: (ex / L) * outD, out: outD,
      e1: edgeEndMeta(dc, dtg[e.ci9], e.si9, 0, interiorSignD[e.ci9]),
      e2: edgeEndMeta(dc, dtg[e.ci9], e.si9, 1, interiorSignD[e.ci9]) };
  }

  // strips: dst seg control points + end meta (kind-12 needs e1/e2 on both streams)
  const stripsD = new Array(src.stripArcs.length);
  for (let ti = 0; ti < src.stripArcs.length; ti++) {
    const sa = src.stripArcs[ti];
    if (sa.ci9 == null) return null;
    const dc = dstContours[sa.ci9], dg = dc[sa.si9];
    stripsD[ti] = {
      tri: new Float32Array([dg.p1[0], dg.p1[1], dg.p2[0], dg.p2[1], dg.p3[0], dg.p3[1]]),
      sign: sa.sign, w: sa.w, ci9: sa.ci9, si9: sa.si9,
      e1: edgeEndMeta(dc, dtg[sa.ci9], sa.si9, 0, interiorSignD[sa.ci9]),
      e2: edgeEndMeta(dc, dtg[sa.ci9], sa.si9, 1, interiorSignD[sa.ci9]),
    };
  }

  // cubic pieces: rebuild each rec's frame on the DST endpoint — same split
  // plan (piece correspondence), same classifiers (cubicKLMN / bezout), same
  // fan-tri row evaluation. Bails: hull point-set change, frame-mode change
  // (klmn↔Bezout health divergence), sign flip.
  const dstPieceOf9 = new Map();   // 'ci|si' → dst pieces array
  const cubicsD = new Array(src.cubics.length);
  const recsDst9 = new Map();      // rec idx → { cpD, klmnD, FD, ptsD }
  // invisible-boundary recs emit NO cubic entries (their region fills solid) —
  // still verify the dst endpoint is ALSO invisible there, else the solid is a lie
  for (const rec of (src.cubicRecs9 || [])) {
    if (!rec.invis9) continue;
    const sgS = srcContours[rec.ci9][rec.si9], sgD = dstContours[rec.ci9][rec.si9];
    const plan = partitionCubicSplitTs([sgS.p1, sgS.p2, sgS.p3, sgS.p4]);
    const piecesD = splitCubicMulti([sgD.p1, sgD.p2, sgD.p3, sgD.p4], plan.ts);
    const cpD = piecesD[rec.pi9];
    if (!cpD) return null;
    const cmD = [0.125 * cpD[0][0] + 0.375 * cpD[1][0] + 0.375 * cpD[2][0] + 0.125 * cpD[3][0],
                 0.125 * cpD[0][1] + 0.375 * cpD[1][1] + 0.375 * cpD[2][1] + 0.125 * cpD[3][1]];
    const ctrlMidD = [(cpD[1][0] + cpD[2][0]) / 2, (cpD[1][1] + cpD[2][1]) / 2];
    const txD = (cpD[1][0] - cpD[0][0]) + 2 * (cpD[2][0] - cpD[1][0]) + (cpD[3][0] - cpD[2][0]);
    const tyD = (cpD[1][1] - cpD[0][1]) + 2 * (cpD[2][1] - cpD[1][1]) + (cpD[3][1] - cpD[2][1]);
    let nxD = -tyD, nyD = txD;
    const nlD = Math.hypot(nxD, nyD);
    const chordD = Math.hypot(cpD[3][0] - cpD[0][0], cpD[3][1] - cpD[0][1]);
    if (nlD < 1e-12 || chordD < 1e-12) return null;
    if (nxD * (ctrlMidD[0] - cmD[0]) + nyD * (ctrlMidD[1] - cmD[1]) < 0) { nxD = -nxD; nyD = -nyD; }
    const offD = 0.05 * chordD;
    if (!(inFillD([cmD[0] + (nxD / nlD) * offD, cmD[1] + (nyD / nlD) * offD])
       && inFillD([cmD[0] - (nxD / nlD) * offD, cmD[1] - (nyD / nlD) * offD]))) return null;
  }
  // same for invisible quad hulls
  for (const h of (src.hulls9 || [])) {
    if (!h.invis9) continue;
    const dg = dstContours[h.ci9][h.si9];
    const wD = dg.w || 1, dmD = 2 + 2 * wD;
    const qmxD = (dg.p1[0] + 2 * wD * dg.p2[0] + dg.p3[0]) / dmD;
    const qmyD = (dg.p1[1] + 2 * wD * dg.p2[1] + dg.p3[1]) / dmD;
    let nxD = dg.p2[0] - qmxD, nyD = dg.p2[1] - qmyD;
    const nlD = Math.hypot(nxD, nyD);
    if (nlD < 1e-9) return null;
    const offD = 0.25 * nlD;
    if (!(inFillD([qmxD + (nxD / nlD) * offD, qmyD + (nyD / nlD) * offD])
       && inFillD([qmxD - (nxD / nlD) * offD, qmyD - (nyD / nlD) * offD]))) return null;
  }
  for (let ci = 0; ci < src.cubics.length; ci++) {
    const e = src.cubics[ci];
    if (e._ri9 == null) return null;
    const rec = src.cubicRecs9[e._ri9];
    let rd = recsDst9.get(e._ri9);
    if (!rd) {
      const sgS = srcContours[rec.ci9][rec.si9], sgD = dstContours[rec.ci9][rec.si9];
      const keyPS = rec.ci9 + '|' + rec.si9;
      let piecesD = dstPieceOf9.get(keyPS);
      if (!piecesD) {
        const plan = partitionCubicSplitTs([sgS.p1, sgS.p2, sgS.p3, sgS.p4]);
        piecesD = splitCubicMulti([sgD.p1, sgD.p2, sgD.p3, sgD.p4], plan.ts);
        dstPieceOf9.set(keyPS, piecesD);
      }
      const cpD = piecesD[rec.pi9];
      if (!cpD) return null;
      // fan tri corners on the dst piece: same control indices as the src rec
      const ptsD = rec.pts.map((sp) => {
        const mp = mapPt(sp[0], sp[1]);
        return mp ? [mp[0], mp[1]] : null;
      });
      if (ptsD.some((v) => !v)) return null;
      let klmnD = null, FD = null;
      if (rec.rows) {
        klmnD = cubicKLMN(cpD);
        if (!klmnD) return null;   // frame-health divergence → bail
      } else {
        FD = bezoutCubicImplicit(cpD);
        if (!FD) return null;
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
        const chSx = cpS[3][0] - cpS[0][0], chSy = cpS[3][1] - cpS[0][1];
        const cmSx = (cpS[1][0] + cpS[2][0]) / 2 - cpS[0][0], cmSy = (cpS[1][1] + cpS[2][1]) / 2 - cpS[0][1];
        const crS = chSx * cmSy - chSy * cmSx;
        const chDx = cpD[3][0] - cpD[0][0], chDy = cpD[3][1] - cpD[0][1];
        const cmDx = (cpD[1][0] + cpD[2][0]) / 2 - cpD[0][0], cmDy = (cpD[1][1] + cpD[2][1]) / 2 - cpD[0][1];
        const crD = chDx * cmDy - chDy * cmDx;
        if (Math.abs(crS) > 1e-12 && Math.abs(crD) > 1e-12 && (crS > 0) !== (crD > 0)) return null;
      }
      {
        const cmD = [0.125 * cpD[0][0] + 0.375 * cpD[1][0] + 0.375 * cpD[2][0] + 0.125 * cpD[3][0],
                     0.125 * cpD[0][1] + 0.375 * cpD[1][1] + 0.375 * cpD[2][1] + 0.125 * cpD[3][1]];
        const ctrlMidD = [(cpD[1][0] + cpD[2][0]) / 2, (cpD[1][1] + cpD[2][1]) / 2];
        const txD = (cpD[1][0] - cpD[0][0]) + 2 * (cpD[2][0] - cpD[1][0]) + (cpD[3][0] - cpD[2][0]);
        const tyD = (cpD[1][1] - cpD[0][1]) + 2 * (cpD[2][1] - cpD[1][1]) + (cpD[3][1] - cpD[2][1]);
        let nxD = -tyD, nyD = txD;
        const nlD = Math.hypot(nxD, nyD);
        const chordD = Math.hypot(cpD[3][0] - cpD[0][0], cpD[3][1] - cpD[0][1]);
        let ccxD = false, bothD = false;
        if (nlD > 1e-12 && chordD > 1e-12) {
          if (nxD * (ctrlMidD[0] - cmD[0]) + nyD * (ctrlMidD[1] - cmD[1]) < 0) { nxD = -nxD; nyD = -nyD; }
          const offD = 0.05 * chordD;
          ccxD = inFillD([cmD[0] + (nxD / nlD) * offD, cmD[1] + (nyD / nlD) * offD]);
          bothD = ccxD && inFillD([cmD[0] - (nxD / nlD) * offD, cmD[1] - (nyD / nlD) * offD]);
        }
        if (rec.invis9) { if (!bothD) return null; }
        else {
          if (bothD) return null;   // boundary became invisible → structure change
          const signD = klmnD ? cubicSignKLMN(cpD, klmnD, ccxD) : cubicSign(cpD, FD, ccxD);
          if (signD !== rec.sign) return null;   // classification flip → bail
        }
      }
      rd = { cpD, klmnD, FD, ptsD, rowsD: null };
      if (klmnD) {
        // klmn VALUES at the dst fan-tri corners: the corners are control
        // points of the piece — find each corner's control index by matching
        // the SRC rec's pts against the SRC piece cp (exact array identity was
        // lost through add(); match by coordinates).
        const sgSP = dstPieceOf9.get(keyPS + '#src') || (() => {
          const plan = partitionCubicSplitTs([sgS.p1, sgS.p2, sgS.p3, sgS.p4]);
          const ps = splitCubicMulti([sgS.p1, sgS.p2, sgS.p3, sgS.p4], plan.ts);
          dstPieceOf9.set(keyPS + '#src', ps);
          return ps;
        })();
        const cpS = sgSP[rec.pi9];
        const idxOf = (pt) => {
          for (let j = 0; j < 4; j++) if (Math.abs(cpS[j][0] - pt[0]) < 1e-9 && Math.abs(cpS[j][1] - pt[1]) < 1e-9) return j;
          return -1;
        };
        const rows = [];
        for (let k = 0; k < 3; k++) {
          const j = idxOf(rec.pts[k]);
          if (j < 0) return null;
          rows.push([klmnD.k[j], klmnD.l[j], klmnD.m[j]]);
        }
        rd.rowsD = rows;
      }
      recsDst9.set(e._ri9, rd);
    }
    // transform the entry: mapped hull verts + rows/F evaluated on dst
    const H = e.hull, HD = new Float32Array(6);
    const bary9 = [];
    for (let k = 0; k < 3; k++) {
      const mp = mapPt(H[2 * k], H[2 * k + 1]);
      if (!mp) return null;                      // clipped sub-verts → bail
      HD[2 * k] = mp[0]; HD[2 * k + 1] = mp[1];
      bary9.push(mp);
    }
    if (e.klmn) {
      // rows at the dst verts: affine over the dst fan tri (rowsD at ptsD)
      const [A9, B9, C9] = rd.ptsD;
      const den = (B9[0] - A9[0]) * (C9[1] - A9[1]) - (B9[1] - A9[1]) * (C9[0] - A9[0]);
      if (Math.abs(den) < 1e-18) return null;
      const rowsAt = (px, py) => {
        const w1 = ((px - A9[0]) * (C9[1] - A9[1]) - (py - A9[1]) * (C9[0] - A9[0])) / den;
        const w2 = ((B9[0] - A9[0]) * (py - A9[1]) - (B9[1] - A9[1]) * (px - A9[0])) / den;
        const w0 = 1 - w1 - w2;
        const R = rd.rowsD;
        return [w0 * R[0][0] + w1 * R[1][0] + w2 * R[2][0],
                w0 * R[0][1] + w1 * R[1][1] + w2 * R[2][1],
                w0 * R[0][2] + w1 * R[1][2] + w2 * R[2][2]];
      };
      const kl = new Float32Array(9);
      for (let k = 0; k < 3; k++) {
        const r = rowsAt(HD[2 * k], HD[2 * k + 1]);
        kl[3 * k] = r[0]; kl[3 * k + 1] = r[1]; kl[3 * k + 2] = r[2];
      }
      cubicsD[ci] = { hull: HD, klmn: kl, sign: e.sign, cp: rd.cpD };
    } else {
      cubicsD[ci] = { hull: HD, F: rd.FD, sign: e.sign };
    }
    // Kind-12 cubic ring end meta on DST (match static / SRC pack layout).
    {
      const cpD = rd.cpD;
      const stubE = { nN: [0, 0], k: 0, type: 0, curve: true, tsign: 1, qn: true, turn: 0 };
      const u = (x, y) => { const L = Math.hypot(x, y); return L > 1e-12 ? [x / L, y / L] : null; };
      const tA = u(cpD[1][0] - cpD[0][0], cpD[1][1] - cpD[0][1])
        || u(cpD[2][0] - cpD[0][0], cpD[2][1] - cpD[0][1])
        || u(cpD[3][0] - cpD[0][0], cpD[3][1] - cpD[0][1]);
      const tB = u(cpD[3][0] - cpD[2][0], cpD[3][1] - cpD[2][1])
        || u(cpD[3][0] - cpD[1][0], cpD[3][1] - cpD[1][1])
        || u(cpD[3][0] - cpD[0][0], cpD[3][1] - cpD[0][1]);
      const nPie = (dstPieceOf9.get(rec.ci9 + '|' + rec.si9) || []).length || 1;
      const dc = dstContours[rec.ci9];
      cubicsD[ci].a = cpD[0];
      cubicsD[ci].b = cpD[3];
      cubicsD[ci].na = tA;
      cubicsD[ci].nb = tB ? [-tB[0], -tB[1]] : null;
      cubicsD[ci].e1 = rec.pi9 === 0
        ? edgeEndMeta(dc, dtg[rec.ci9], rec.si9, 0, interiorSignD[rec.ci9]) : stubE;
      cubicsD[ci].e2 = rec.pi9 === nPie - 1
        ? edgeEndMeta(dc, dtg[rec.ci9], rec.si9, 1, interiorSignD[rec.ci9]) : stubE;
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
  if (!(opts && opts.plainDstRows)) try {
    const planD9 = splitInteriorByCurve(di, selfOrientRows(interiorEdgesFromTriPoints(di, edgesD), di), new Map(), new Map(), true, edgesD);
    if (planD9.solid.length === di.length) rowsD9 = planD9;
  } catch { rowsD9 = null; }
  const dst = {
    interior: di,
    interiorEdges: rowsD9 ? (rowsD9.solidEdges instanceof Float32Array ? rowsD9.solidEdges : new Float32Array(rowsD9.solidEdges))
                          : selfOrientRows(interiorEdgesFromTriPoints(di, edgesD), di),
    interiorEdges2: rowsD9 && rowsD9.solidEdges2 ? new Float32Array(rowsD9.solidEdges2) : null,
    interiorEdges3: rowsD9 && rowsD9.solidEdges3 ? new Float32Array(rowsD9.solidEdges3) : null,
    quads: quadsD, cubics: cubicsD, edges: edgesD, fallback: [],
    stripArcs: stripsD, _topo: null,
  };
  return { src, dst };
}

// Mid-morph frame drift of a partition pair, in hull-diagonal units. Quad tc is
// EXACT under per-vertex lerp (barycentric weights commute with it), but a
// cubic's klmn rows are not — the lerped rows describe a slightly different
// curve mid-morph. The oracle evaluates the lerped implicit at a point on the
// TRUE mid-morph curve (control points lerp exactly) and converts to a
// distance via the implicit's own gradient; callers split the t-range when it
// drifts past tolerance (each halving quarters the error).
export function partitionPairMidError(pair) {
  const S = pair.src.cubics || [], D = pair.dst.cubics || [];
  let worst = 0;
  for (let i = 0; i < S.length && i < D.length; i++) {
    const a = S[i], b = D[i];
    if (!a.klmn || !b.klmn || !a.cp || !b.cp || a.cp.length !== b.cp.length) continue;
    const cpM = a.cp.map((p, j) => [(p[0] + b.cp[j][0]) / 2, (p[1] + b.cp[j][1]) / 2]);
    const P = cubicPt(cpM, 0.5);
    const H = a.hull, HD = b.hull;
    const ax = (H[0] + HD[0]) / 2, ay = (H[1] + HD[1]) / 2;
    const bx = (H[2] + HD[2]) / 2, by = (H[3] + HD[3]) / 2;
    const cx = (H[4] + HD[4]) / 2, cy = (H[5] + HD[5]) / 2;
    const den = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(den) < 1e-18) continue;
    const w1 = ((P[0] - ax) * (cy - ay) - (P[1] - ay) * (cx - ax)) / den;
    const w2 = ((bx - ax) * (P[1] - ay) - (by - ay) * (P[0] - ax)) / den;
    const w0 = 1 - w1 - w2;
    const R = a.klmn, Q = b.klmn;
    const rows = [0, 1, 2].map((v) => [0, 1, 2].map((c) => (R[v * 3 + c] + Q[v * 3 + c]) / 2));
    const k = w0 * rows[0][0] + w1 * rows[1][0] + w2 * rows[2][0];
    const l = w0 * rows[0][1] + w1 * rows[1][1] + w2 * rows[2][1];
    const m = w0 * rows[0][2] + w1 * rows[1][2] + w2 * rows[2][2];
    const f = k * k * k - l * m;
    // ∇(k³−lm) from the affine row gradients over the mid tri
    const g = (col) => {
      const d1 = rows[1][col] - rows[0][col], d2 = rows[2][col] - rows[0][col];
      return [(d1 * (cy - ay) - d2 * (by - ay)) / den, (d2 * (bx - ax) - d1 * (cx - ax)) / den];
    };
    const gk = g(0), gl = g(1), gm = g(2);
    const gfx = 3 * k * k * gk[0] - gl[0] * m - l * gm[0];
    const gfy = 3 * k * k * gk[1] - gl[1] * m - l * gm[1];
    const grad = Math.hypot(gfx, gfy);
    if (grad < 1e-12) continue;
    const diag = Math.hypot(cx - ax, cy - ay) + Math.hypot(bx - ax, by - ay);
    if (diag < 1e-9) continue;
    const drift = Math.abs(f) / grad / diag;
    if (drift > worst) worst = drift;
  }
  return worst;
}
