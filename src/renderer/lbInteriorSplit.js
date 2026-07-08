// lbInteriorSplit.js — curve-aware interior partition. Splits the flat
// interior-triangle array into SOLID triangles (kind 0) and CURVE-boundary
// triangles (an edge on a curve chord) carrying the arc's affine texcoords,
// so boundary rows ramp with curveCov at the arc instead of ending in a hard
// solid-1 edge. Also owns the T-vertex heal-candidate list the split emits
// (edge midpoints) and healCracks later stitches.
import { _kox, _koy, _koScale } from './lbContour.js';

// Edge-midpoint T-vertex candidates, reset per build by each top-level
// builder; splitInteriorByCurve pushes, healCracks consumes.
export const _healCand = [];

function baryOf(p, a, b, c) {
  // AREA form (one cross product per weight): the Gram form (d00·d11 − d01²) suffers
  // catastrophic cancellation on thin triangles — thin-hull adopted pieces got f errors
  // of ±0.02 frame units, reading "beyond the arc" where the truth is "inside" (the
  // e/6/8/9 zoom-crop holes traced to exactly this).
  const v0x = b[0] - a[0], v0y = b[1] - a[1], v1x = c[0] - a[0], v1y = c[1] - a[1], v2x = p[0] - a[0], v2y = p[1] - a[1];
  const den = v0x * v1y - v0y * v1x;
  if (Math.abs(den) < 1e-18) return [1, 0, 0];
  const w1 = (v2x * v1y - v2y * v1x) / den, w2 = (v0x * v2y - v0y * v2x) / den;
  return [1 - w1 - w2, w1, w2];
}
// Evaluate an arc's affine texcoord map at em point p (extrapolates outside the control
// triangle — the map is affine everywhere). quad: uv (0,0)/(½,0)/(1,1); rquad: homogeneous
// (0,0,1)/(½w⁻¹,0,w⁻¹)/(1,1,1). Returns [t0,t1,t2].
function arcInteriorTC(p, arc, out) {
  // baryOf inlined (its array return was ~10⁶ allocs/sec on streamed roads; the
  // area form is kept verbatim — see baryOf for the cancellation rationale).
  const a = arc.a, b = arc.ctrl, c = arc.b;
  const v0x = b[0] - a[0], v0y = b[1] - a[1], v1x = c[0] - a[0], v1y = c[1] - a[1], v2x = p[0] - a[0], v2y = p[1] - a[1];
  const den = v0x * v1y - v0y * v1x;
  let w0 = 1, w1 = 0, w2 = 0;
  if (Math.abs(den) >= 1e-18) {
    w1 = (v2x * v1y - v2y * v1x) / den; w2 = (v0x * v2y - v0y * v2x) / den; w0 = 1 - w1 - w2;
  }
  const o = out || [0, 0, 0];
  if (arc.w === 1) { o[0] = 0.5 * w1 + w2; o[1] = w2; o[2] = 0; return o; }
  const iw = 1 / arc.w;
  o[0] = 0.5 * iw * w1 + w2; o[1] = w2; o[2] = w0 + iw * w1 + w2;
  return o;
}
const _tcS0 = [0, 0, 0], _tcS1 = [0, 0, 0];   // rotating scratch (callers hold ≤2 at once)
// Split a flat interior-triangle array [x0,y0,…] into SOLID triangles (kind 0) and
// CURVE-boundary triangles (an edge lies on a curve chord). The latter carry the arc's
// texcoords and render with curveCov — so they RAMP at the arc near the on-curve points
// instead of a hard solid-1 edge, which is what over-covered at seams. Deep interior stays
// solid (curveCov→1 there anyway; keeping it kind-0 is cheaper). chordArcs maps a chord's
// endpoint-key pair → its arc {a,ctrl,b,sign,w}.
export function splitInteriorByCurve(interior, interiorEdges, chordArcs, vertexArcs, enabled, edges) {
  // Ramp interior triangles that touch a curve at the arc (curveCov) instead of a hard
  // solid-1 edge/vertex — that solid, sitting inside the arc's ½px AA band near the on-curve seam
  // points, is the residual seam over-coverage. Gated (`enabled`) to the holed/CDT static path;
  // the earcut/streaming caller leaves it off (fixed-topology refresh can't absorb the extra
  // curveTris).
  if (!enabled || ((!chordArcs || !chordArcs.size) && (!edges || !edges.length))) return { solid: interior, solidEdges: interiorEdges, solidEdges2: null, solidEdges3: null, curveTris: [] };
  const key = (x, y) => Math.round((x - _kox) * _koScale) * 2097152 + Math.round((y - _koy) * _koScale);   // numeric: string keys were a top build allocator
  const solid = [], solidEdges = [], solidEdges2 = [], solidEdges3 = [], curveTris = [];
  // Signed implicit of the arc's affine map at em point p. f<0 = inside-fill by this arc.
  const fAt = (p, arc) => { const c = arcInteriorTC(p, arc, _tcS0); return arc.sign * (arc.w === 1 ? c[0] * c[0] - c[1] : c[0] * c[0] - c[1] * c[2]); };
  // Max of the signed implicit along segment P→Q. The texcoords are affine in em space, so
  // f(t) is an exact quadratic along any segment: A t² + B t + C from the endpoint texcoords.
  // For CONVEX arcs f is convex along edges (max at endpoints — the old vertex test sufficed);
  // for CONCAVE arcs f is CONCAVE along edges, so it can bulge ABOVE zero mid-edge while both
  // endpoints read ≤0 — the "extended parabola cuts the triangle" hole. Checking the true edge
  // max makes concave ramping safe (a would-be-holed triangle stays solid instead).
  const edgeMaxF = (Pp, Qp, arc) => {
    const c0 = arcInteriorTC(Pp, arc, _tcS0), c1 = arcInteriorTC(Qp, arc, _tcS1);
    const u0 = c0[0], du = c1[0] - u0;
    const v0 = c0[1], dv = c1[1] - v0;
    const r0 = arc.w === 1 ? 1 : c0[2], dr = arc.w === 1 ? 0 : c1[2] - r0;
    const A = arc.sign * (du * du - dv * dr);
    const B = arc.sign * (2 * u0 * du - (v0 * dr + r0 * dv));
    const C = arc.sign * (u0 * u0 - v0 * r0);
    let m = Math.max(C, A + B + C);
    if (Math.abs(A) > 1e-12) { const tc = -B / (2 * A); if (tc > 0 && tc < 1) m = Math.max(m, A * tc * tc + B * tc + C); }
    return m;
  };
  const TOL = 0.03;
  // GRAZING guard for one edge P→Q: the implicit is only a boundary NEAR the arc's span
  // (u∈[0,1]). If f comes within δ of zero where u is OUT of span — the extended
  // parabola's far branch sweeping through a big fill triangle ramped by a SMALL arc —
  // the ramp paints a 0.3-coverage under-stripe DEEP inside the fill that no sign test
  // sees (f never crosses zero). Bound the exact quadratic f(t) over the out-of-span
  // sub-intervals of the edge; reject if it exceeds −δ there. Scale-free (frame units).
  const grazes = (Pp, Qp, arc) => {
    const c0 = arcInteriorTC(Pp, arc, _tcS0), c1 = arcInteriorTC(Qp, arc, _tcS1);
    const u0 = c0[0], du = c1[0] - u0;
    const v0 = c0[1], dv = c1[1] - v0;
    const r0 = arc.w === 1 ? 1 : c0[2], dr = arc.w === 1 ? 0 : c1[2] - r0;
    const A2 = arc.sign * (du * du - dv * dr);
    const B2 = arc.sign * (2 * u0 * du - (v0 * dr + r0 * dv));
    const C2 = arc.sign * (u0 * u0 - v0 * r0);
    const fAtT = (t) => A2 * t * t + B2 * t + C2;
    // out-of-span sub-intervals of t where u(t) ∉ [−0.15, 1.15]
    const lo = -0.15, hi = 1.15, segs = [];
    if (Math.abs(du) < 1e-12) { if (u0 < lo || u0 > hi) segs.push([0, 1]); }
    else {
      const tLo = (lo - u0) / du, tHi = (hi - u0) / du;
      const tin0 = Math.max(0, Math.min(tLo, tHi)), tin1 = Math.min(1, Math.max(tLo, tHi));
      if (tin0 > 0) segs.push([0, Math.min(tin0, 1)]);
      if (tin1 < 1) segs.push([Math.max(tin1, 0), 1]);
      if (tin1 < tin0) { segs.length = 0; segs.push([0, 1]); }
    }
    const DELTA = -0.12;
    for (const [t0, t1] of segs) {
      if (t1 <= t0) continue;
      let m = Math.max(fAtT(t0), fAtT(t1));
      if (Math.abs(A2) > 1e-12) { const tc2 = -B2 / (2 * A2); if (tc2 > t0 && tc2 < t1) m = Math.max(m, fAtT(tc2)); }
      if (m > DELTA) return true;
    }
    return false;
  };
  const makeCurveTri = (A, B, C, arc) => {
    if (!arc) return null;
    // NEAR-STRAIGHT ARC GUARD: baryOf against a razor-thin hull (ctrl ~on the chord —
    // ubiquitous in fonts) divides by a clamped ~0 determinant and returns garbage
    // (u=v≈0 at every vert → f ≡ 0 → the piece paints NOTHING, a dead crescent over
    // real ink: G's 45px bar-bowl hole). Such an arc's AA is the LINE ramp's job —
    // return null and let the caller fall through to the line/solid handlers.
    const hax = arc.ctrl[0] - arc.a[0], hay = arc.ctrl[1] - arc.a[1];
    const hbx = arc.b[0] - arc.a[0], hby = arc.b[1] - arc.a[1];
    const chord2 = hbx * hbx + hby * hby;
    if (Math.abs(hax * hby - hay * hbx) < 1e-4 * chord2) return null;
    if (edgeMaxF(A, B, arc) > TOL || edgeMaxF(B, C, arc) > TOL || edgeMaxF(C, A, arc) > TOL) return null;
    if (grazes(A, B, arc) || grazes(B, C, arc) || grazes(C, A, arc)) return null;
    const tc = [];
    for (const p of [A, B, C]) { const c = arcInteriorTC(p, arc, _tcS0); tc.push(c[0], c[1], c[2]); }
    // IN-SPAN GUARD, per vertex: a vertex past the arc's endpoint (u outside [0,1]) that
    // ALSO reads beyond the arc (f > 0) rides the EXTENDED PARABOLA, whose coverage is
    // meaningless — beyond the endpoint the outline continues with the NEXT segment. At a
    // spiral terminal that face is ink and the extrapolated ramp painted ~0 over it (the
    // 6/9/e zoom-crop holes: a sliver past 'a' with u<0, f=+0.016). Fill-side (f≤0)
    // out-of-span verts are fine (cov saturates to 1), and concave-dip faces keep their
    // ramp (their f>0 verts are IN-span). Reject → the face falls to line/solid handlers.
    for (let vi9 = 0; vi9 < 3; vi9++) {
      const u9 = tc[vi9 * 3], f9 = arc.sign * (u9 * u9 - tc[vi9 * 3 + 1]);
      if ((u9 < -0.02 || u9 > 1.02) && f9 > 1e-3) return null;
    }
    return { tri: new Float32Array([A[0], A[1], B[0], B[1], C[0], C[1]]), sign: arc.sign, w: arc.w, tc: new Float32Array(tc) };
  };
  // Straight boundary edges by ENDPOINT — an interior triangle touching a boundary edge at
  // only a VERTEX still has that edge's AA band crossing its pixels (the thin-stroke zigzag:
  // alternate CDT triangles own partial pixels of the OPPOSITE edge → periodic solid dots).
  // Unlike arcs, a line ramp is valid everywhere (it saturates to 1 away from the line), so a
  // line-touched triangle simply rides the kind-0 inner ramp with that line.
  const vertexLines = new Map();
  if (edges) for (const ed of edges) {
    const line = [ed.nx, ed.ny, ed.nx * ed.p1[0] + ed.ny * ed.p1[1]];
    for (const [Pp, Qp] of [[ed.p1, ed.p2], [ed.p2, ed.p1]]) {
      const kk = key(Pp[0], Pp[1]);
      const dx = Qp[0] - Pp[0], dy = Qp[1] - Pp[1], L = Math.hypot(dx, dy) || 1;
      let l = vertexLines.get(kk); if (!l) vertexLines.set(kk, l = []);
      l.push({ line, V: Pp, dir: [dx / L, dy / L], len: L });
    }
  }
  // Spatial grid over line entries. findSecondLine/nearestFitLine used to scan EVERY
  // boundary line PER FACE — quadratic in boundary size; one organic wave shape
  // spent 14 SECONDS here. spanOverlap already confines real candidates to the
  // face's along-edge neighbourhood, so a bbox grid prefilters exactly; the
  // distance-bounded retry in the callers keeps argmin selection identical.
  let lineGrid = null, lgCell = 1, lgQ = 0;
  {
    let cnt9 = 0, sum9 = 0;
    for (const l9 of vertexLines.values()) { for (const e9 of l9) { cnt9++; sum9 += e9.len; } }
    if (cnt9 > 96) {
      lgCell = Math.max(sum9 / cnt9, 1e-9);
      lineGrid = new Map();
      for (const l9 of vertexLines.values()) for (const e9 of l9) {
        const x29 = e9.V[0] + e9.dir[0] * e9.len, y29 = e9.V[1] + e9.dir[1] * e9.len;
        const cx09 = Math.floor(Math.min(e9.V[0], x29) / lgCell), cx19 = Math.floor(Math.max(e9.V[0], x29) / lgCell);
        const cy09 = Math.floor(Math.min(e9.V[1], y29) / lgCell), cy19 = Math.floor(Math.max(e9.V[1], y29) / lgCell);
        for (let cy9 = cy09; cy9 <= cy19; cy9++) for (let cx9 = cx09; cx9 <= cx19; cx9++) {
          const k9 = cx9 * 262147 + cy9; let a9 = lineGrid.get(k9);
          if (!a9) lineGrid.set(k9, a9 = []);
          a9.push(e9);
        }
      }
    }
  }
  // Arc grid: chord midpoints, for the nearest-arc query in processTri (was a full
  // chordArcs scan per recursion node — the other quadratic half).
  let arcGrid = null, agCell = 1, agMaxR = 1;
  if (chordArcs && chordArcs.size > 96) {
    let sumA9 = 0;
    for (const arc of chordArcs.values()) sumA9 += Math.hypot(arc.b[0] - arc.a[0], arc.b[1] - arc.a[1]);
    agCell = Math.max(sumA9 / chordArcs.size, 1e-9);
    arcGrid = new Map();
    let minCX9 = Infinity, maxCX9 = -Infinity, minCY9 = Infinity, maxCY9 = -Infinity;
    for (const arc of chordArcs.values()) {
      const cx9 = Math.floor(((arc.a[0] + arc.b[0]) / 2) / agCell), cy9 = Math.floor(((arc.a[1] + arc.b[1]) / 2) / agCell);
      const k9 = cx9 * 262147 + cy9; let a9 = arcGrid.get(k9);
      if (!a9) arcGrid.set(k9, a9 = []);
      a9.push(arc);
      if (cx9 < minCX9) minCX9 = cx9; if (cx9 > maxCX9) maxCX9 = cx9;
      if (cy9 < minCY9) minCY9 = cy9; if (cy9 > maxCY9) maxCY9 = cy9;
    }
    agMaxR = Math.min(8, Math.max(maxCX9 - minCX9, maxCY9 - minCY9) + 1);
  }
  // Visit entries whose padded bbox cells overlap the face bbox (deduped by query stamp).
  const forLinesNear = (A9, B9, C9, padCells, fn9) => {
    if (!lineGrid) { for (const l9 of vertexLines.values()) for (const e9 of l9) fn9(e9); return; }
    lgQ++;
    const x09 = Math.floor((Math.min(A9[0], B9[0], C9[0])) / lgCell) - padCells;
    const x19 = Math.floor((Math.max(A9[0], B9[0], C9[0])) / lgCell) + padCells;
    const y09 = Math.floor((Math.min(A9[1], B9[1], C9[1])) / lgCell) - padCells;
    const y19 = Math.floor((Math.max(A9[1], B9[1], C9[1])) / lgCell) + padCells;
    for (let cy9 = y09; cy9 <= y19; cy9++) for (let cx9 = x09; cx9 <= x19; cx9++) {
      const a9 = lineGrid.get(cx9 * 262147 + cy9);
      if (a9) for (const e9 of a9) { if (e9._q !== lgQ) { e9._q = lgQ; fn9(e9); } }
    }
  };
  // A line ramp is only valid where the edge actually BOUNDS the fill: every vertex on the
  // inner side (beyond a REFLEX corner the fill wraps to the line's outward side — ramping
  // there erases it) and within the edge's span (the extension past a corner is not a
  // boundary). Failing triangles fall to the corner-cut recursion, whose V-pieces shrink
  // until they fit (or stay solid).
  const lineFits = (A, B, C, en, spanSlack) => {
    const tol = 1e-3 * en.len + 1e-9;
    const sl = spanSlack || 0.05;
    // CONTAINMENT span test — every vertex inside the line AND within the edge's span.
    // Interval-intersection variants attached a stem's line to crossbar faces past the
    // edge's end: fill continues straight through a T-join on the line's INNER side, so
    // the side test alone cannot protect reflex joins (the H crossbar seam regression).
    for (const Pp of [A, B, C]) {
      if (en.line[0] * Pp[0] + en.line[1] * Pp[1] - en.line[2] > tol) return false;
      const t = (Pp[0] - en.V[0]) * en.dir[0] + (Pp[1] - en.V[1]) * en.dir[1];
      if (t < -sl * en.len || t > (1 + sl) * en.len) return false;
    }
    return true;
  };
  // Wedge-correct boundary FEATURE (arc or straight line) at a seam vertex: of the features
  // meeting at the vertex, pick the one whose span `toward` lies in — score = dot(toward−V,
  // span direction at V). Last-write-wins picked the WRONG arc half the time, which ramped
  // the far side of a seam with the wrong (extrapolated) parabola → the alternating
  // over/under speckle along curve contours.
  const featureAtVertex = (vi, V, toward) => {
    let best = /** @type {any} */ (null), bestS = -Infinity, arcS = -Infinity, lineS = -Infinity;
    const la = vertexArcs && vertexArcs.get(vi);
    if (la) for (const arc of la) {
      const isA = Math.abs(arc.a[0] - V[0]) + Math.abs(arc.a[1] - V[1]) < Math.abs(arc.b[0] - V[0]) + Math.abs(arc.b[1] - V[1]);
      const nx = arc.ctrl[0] - (isA ? arc.a[0] : arc.b[0]), ny = arc.ctrl[1] - (isA ? arc.a[1] : arc.b[1]);
      const L = Math.hypot(nx, ny) || 1;
      const s = ((toward[0] - V[0]) * nx + (toward[1] - V[1]) * ny) / L;
      if (s > arcS) arcS = s;
      if (s > bestS) { bestS = s; best = { arc }; }
    }
    const ll = vertexLines.get(vi);
    if (ll) for (const en of ll) {
      const s = (toward[0] - V[0]) * en.dir[0] + (toward[1] - V[1]) * en.dir[1];
      if (s > lineS) lineS = s;
      if (s > bestS) { bestS = s; best = { en }; }
    }
    // A curve–line JUNCTION vertex claimed nearly equally by both feature classes (the
    // piece straddles the corner bisector): a whole-piece emit with the winner leaves the
    // loser's pixels wrong (an arc ramp extends full-cov over the line's AA band and vice
    // versa) — flag so the caller CUTS; sub-pieces move off the bisector and resolve.
    // Clear winners (score ratio) emit whole, so the recursion terminates.
    if (best && arcS > -Infinity && lineS > -Infinity && Math.min(arcS, lineS) > 0.6 * Math.max(arcS, lineS) && Math.min(arcS, lineS) > 0) best.mixed = true;
    return best;
  };
  const arcAtVertex = (vi, P, toward) => { const f = featureAtVertex(vi, P, toward); return f && f.arc ? f.arc : null; };
  // Corner type of two boundary lines: +1 = convex/stroke (local fill = inside both →
  // combined coverage covA+covB−1) · −1 = reflex (fill = union → covA+covB−covA·covB).
  // Two edges sharing a vertex: convex iff each edge's span direction points inside the
  // other's half-plane. Unshared (a thin stroke's opposite sides) → intersection (+1).
  const cornerTypeOf = (enA, enB) => {
    // NEARLY-PARALLEL same-side lines are a continuation, not a corner: their box cuts
    // NEST, so the intersection formula covA+covB−1 double-subtracts the shared cut (a
    // 0.3-deep under-stripe wherever a gently-turning polyline ran near a pixel). Pair
    // only when the normals genuinely differ — anti-parallel normals (a thin stroke's
    // two sides, dot≈−1) stay paired.
    if (enB.line && enA && enA.line) {
      const nd = enA.line[0] * enB.line[0] + enA.line[1] * enB.line[1];
      if (nd > 0.85) return 0;   // < ~32° apart — cuts nest; single line is within O(θ)
    }
    if (!enA) return 1;
    const shared = key(enA.V[0], enA.V[1]) === key(enB.V[0], enB.V[1]);
    if (!shared) return 1;
    const dA = enA.dir[0] * enB.line[0] + enA.dir[1] * enB.line[1];
    const dB = enB.dir[0] * enA.line[0] + enB.dir[1] * enA.line[1];
    if (dA < -0.15 && dB < -0.15) return 1;
    if (dA > 0.15 || dB > 0.15) return -1;
    return 0;   // near-collinear continuation — no corner
  };
  // f32-tolerant: the own-line values round-trip through a Float32Array (solidEdges), so a
  // 1e-6 double compare misses and a triangle would pair ITS OWN edge as the "second" line —
  // covA+covA−1 = 2covA−1 → periodic under-dots on every straight-edge AA pixel.
  const sameLine = (l, m) => Math.abs(l[0] - m[0]) + Math.abs(l[1] - m[1]) < 1e-4 && Math.abs(l[2] - m[2]) < 1e-3 * (1 + Math.abs(m[2]));
  // A second boundary line whose band may cross this triangle's pixels (thin stroke /
  // corner): any fitting vertex line different from the first. cov saturates to 1 away
  // from it, so a far second line is harmless.
  const spanOverlap = (A, B, C, en) => {
    let tmin = Infinity, tmax = -Infinity;
    for (const Pp of [A, B, C]) {
      const t = (Pp[0] - en.V[0]) * en.dir[0] + (Pp[1] - en.V[1]) * en.dir[1];
      if (t < tmin) tmin = t; if (t > tmax) tmax = t;
    }
    return Math.max(0, Math.min(tmax, en.len) - Math.max(tmin, 0));
  };
  const findSecondLine = (A, B, C, kv, firstLine) => {
    // Search ALL boundary lines (a face's Steiner vertices may touch neither endpoint of
    // the edge that cuts its pixels), ranked by SPAN OVERLAP — how much of the edge crosses
    // the face's projection — so corner-touching inert lines (depth 0, overlap ~0) can't
    // steal the slot from the edge that actually crosses (the N-notch sliver). Depth
    // tie-breaks. The side test in lineFits protects reflex wraps.
    let best = null, bestD = Infinity;
    const scan9 = (en) => {
      if (firstLine && sameLine(en.line, firstLine)) return;
      if (!lineFits(A, B, C, en)) return;
      if (spanOverlap(A, B, C, en) < 1e-9) return;   // corner-grazing inert lines don't compete
      let d = Infinity;
      for (const Pp of [A, B, C]) d = Math.min(d, en.line[2] - (en.line[0] * Pp[0] + en.line[1] * Pp[1]));
      if (d < bestD) { bestD = d; best = en; }
    };
    forLinesNear(A, B, C, 2, scan9);
    return best;
  };
  const findOwnEntry = (kv, line) => {
    for (let vi = 0; vi < 3; vi++) {
      const ll = vertexLines.get(kv[vi]);
      if (ll) for (const en of ll) if (sameLine(en.line, line)) return en;
    }
    return null;
  };
  const nearestFitLine = (A, B, C) => {
    let best = null, bestD = Infinity;
    const scan9 = (en) => {
      if (!lineFits(A, B, C, en)) return;
      if (spanOverlap(A, B, C, en) < 1e-9) return;
      let d = Infinity;
      for (const Pp of [A, B, C]) d = Math.min(d, en.line[2] - (en.line[0] * Pp[0] + en.line[1] * Pp[1]));
      if (d < bestD) { bestD = d; best = en; }
    };
    forLinesNear(A, B, C, 2, scan9);
    return best;
  };
  const pushSolidTri = (A, B, C, line, line2, type) => { solid.push(A[0], A[1], B[0], B[1], C[0], C[1]);
    if (interiorEdges) {
      // A line-less solid piece (belts of the corner-cut recursion, chord fall-backs) still
      // attaches the nearest fitting boundary line — its pixels' boxes may be cut by an edge
      // the piece doesn't touch, and a bare solid paints 1.0 where Slug ramps. Saturating
      // coverage makes a far attachment harmless.
      if (!line) { const en = nearestFitLine(A, B, C); if (en) line = en.line; }
      if (line) for (let i = 0; i < 3; i++) solidEdges.push(line[0], line[1], line[2]); else for (let i = 0; i < 9; i++) solidEdges.push(0);
      if (line2 && type) for (let i = 0; i < 3; i++) solidEdges2.push(line2[0], line2[1], line2[2], type); else for (let i = 0; i < 12; i++) solidEdges2.push(0);
      // THIRD line (rides kind-0's unused aTC + aC3.w): a sliver face can span between a
      // corner shared with its own edge AND a distant notch — three cutting features.
      let en3 = null, d3 = Infinity;
      if (line && line2) {
        const scan9 = (en) => {
          if (sameLine(en.line, line) || sameLine(en.line, line2)) return;
          if (!lineFits(A, B, C, en)) return;
          if (spanOverlap(A, B, C, en) < 1e-9) return;
          let d = Infinity;
          for (const Pp of [A, B, C]) d = Math.min(d, en.line[2] - (en.line[0] * Pp[0] + en.line[1] * Pp[1]));
          if (d < d3) { d3 = d; en3 = en; }
        };
        forLinesNear(A, B, C, 2, scan9);
      }
      const en3v = /** @type {any} */ (en3);
      if (en3v) {
        const oe3 = findOwnEntry([key(A[0], A[1]), key(B[0], B[1]), key(C[0], C[1])], line);
        const t3 = cornerTypeOf(oe3, en3v);
        if (t3) { for (let i = 0; i < 3; i++) solidEdges3.push(en3v.line[0], en3v.line[1], en3v.line[2], t3); } else for (let i = 0; i < 12; i++) solidEdges3.push(0);
      } else for (let i = 0; i < 12; i++) solidEdges3.push(0);
    } };
  // Recursive corner processor. A triangle may touch SEVERAL distinct boundary features (one
  // vertex on the outer contour, another on a counter — the thin-ring case), and one affine
  // frame can only ramp one of them: cut a corner piece per feature-vertex (each ramped by ITS
  // wedge-correct feature) and recurse on the belt. A LINE feature rides the kind-0 inner ramp
  // (valid at any distance); an ARC corner whose full extent fails edgeMaxF (the extended
  // parabola cuts back — the concave hole risk) shrinks toward its vertex until the implicit
  // is locally valid. The pinch zone where crescents vanish always ramps.
  let ptNodes = 0;
  const ptBudget = Math.max(4096, (interior.length / 6) * 8);
  const processTri = (A, B, C, depth) => {
    // WORK BUDGET: the spanFail 4-way split fans out 4^depth nodes per face — on
    // long-edged organic shapes (waves: edges much longer than
    // faces, wide-slack lineFits passes, strict span fails) thousands of faces
    // each exploded into ~1024 nodes: a 14-SECOND single build. Past the budget a
    // node degrades to exactly what depth-0 does (solid push) — render-identical
    // for these mostly-saturated faces, and the build is linear again.
    if (++ptNodes > ptBudget) { pushSolidTri(A, B, C); return; }
    const kv = [key(A[0], A[1]), key(B[0], B[1]), key(C[0], C[1])];
    const Pv = [A, B, C];
    const cen = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3];
    const feats = [featureAtVertex(kv[0], A, cen), featureAtVertex(kv[1], B, cen), featureAtVertex(kv[2], C, cen)];
    const touched = [0, 1, 2].filter(i => feats[i]);
    if (!touched.length) {
      // No vertex touches a feature — but a boundary-adjacent PIXEL's box extends past the
      // face: a "second-row" face within the AA band of an edge/arc must still ramp, else
      // its pixels read solid-1 where the box is partially cut (the N stem runs, the acute
      // notch interior). Coverage saturates with distance, so attaching the NEAREST fitting
      // feature is safe: far faces just compute cov=1.
      let bestEn = null, bestD = Infinity, spanFail = false;
      const scanL9 = (en) => {
        if (!lineFits(A, B, C, en, 0.45)) return;
        if (!lineFits(A, B, C, en)) { spanFail = true; return; }   // side ok, span too wide → cut below
        let d = Infinity;
        for (const Pp of [A, B, C]) d = Math.min(d, en.line[2] - (en.line[0] * Pp[0] + en.line[1] * Pp[1]));
        if (d < bestD) { bestD = d; bestEn = en; }
      };
      forLinesNear(A, B, C, 2, scanL9);
      let bestArc = null, bestAD = Infinity;
      if (!arcGrid) {
        for (const arc of chordArcs.values()) {
          const mx2 = (arc.a[0] + arc.b[0]) / 2, my2 = (arc.a[1] + arc.b[1]) / 2;
          const d = Math.hypot(cen[0] - mx2, cen[1] - my2);
          if (d < bestAD) { bestAD = d; bestArc = arc; }
        }
      } else {
        // ring-expand around the centroid cell; once a hit exists, one more ring
        // bounds the true nearest (cell diagonal slack), preserving the argmin.
        const ccx9 = Math.floor(cen[0] / agCell), ccy9 = Math.floor(cen[1] / agCell);
        for (let r9 = 0; r9 <= agMaxR; r9++) {
          for (let cy9 = ccy9 - r9; cy9 <= ccy9 + r9; cy9++) for (let cx9 = ccx9 - r9; cx9 <= ccx9 + r9; cx9++) {
            if (r9 > 0 && cx9 > ccx9 - r9 && cx9 < ccx9 + r9 && cy9 > ccy9 - r9 && cy9 < ccy9 + r9) continue;
            const a9 = arcGrid.get(cx9 * 262147 + cy9);
            if (a9) for (const arc of a9) {
              const mx2 = (arc.a[0] + arc.b[0]) / 2, my2 = (arc.a[1] + arc.b[1]) / 2;
              const d = Math.hypot(cen[0] - mx2, cen[1] - my2);
              if (d < bestAD) { bestAD = d; bestArc = arc; }
            }
          }
          if (bestArc && bestAD <= (r9 - 1) * agCell) break;   // nearer hit impossible outside scanned rings
        }
      }
      if (bestArc && bestAD < bestD) {
        const ct = makeCurveTri(A, B, C, bestArc);
        if (ct) { curveTris.push(ct); return; }
      }
      const bestEnv = /** @type {any} */ (bestEn);
      if (bestEnv) {
        const en2 = findSecondLine(A, B, C, kv, bestEnv.line);
        pushSolidTri(A, B, C, bestEnv.line, en2 && en2.line, en2 ? cornerTypeOf(bestEnv, en2) : 0);
        return;
      }
      if (bestArc) { const ct = makeCurveTri(A, B, C, bestArc); if (ct) { curveTris.push(ct); return; } }
      if (spanFail && depth > 0) {
        // A boundary line passes the side test but the face out-spans it (big face near a
        // stem end): quarter it — the near-edge pieces will fit and ramp.
        const Mab = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], Mbc = [(B[0] + C[0]) / 2, (B[1] + C[1]) / 2], Mca = [(C[0] + A[0]) / 2, (C[1] + A[1]) / 2];
        processTri(A, Mab, Mca, depth - 1); processTri(Mab, B, Mbc, depth - 1);
        processTri(Mca, Mbc, C, depth - 1); processTri(Mab, Mbc, Mca, depth - 1);
        return;
      }
      pushSolidTri(A, B, C); return;
    }
    if (touched.length === 1 && !feats[touched[0]].mixed) {
      const f = feats[touched[0]];
      if (f.en) {
        if (lineFits(A, B, C, f.en)) {
          const en2 = findSecondLine(A, B, C, kv, f.en.line);
          pushSolidTri(A, B, C, f.en.line, en2 && en2.line, en2 ? cornerTypeOf(f.en, en2) : 0);
          return;
        }
      } else {
        const ct = makeCurveTri(A, B, C, f.arc);
        if (ct) { curveTris.push(ct); return; }
      }
    }
    if (depth <= 0) { pushSolidTri(A, B, C); return; }
    // Cut the first feature-vertex's corner at edge midpoints; corner + belts recurse
    // (midpoints are off-boundary so each corner ends up alone with its own feature).
    const vi = touched[0], V = Pv[vi], Pa = Pv[(vi + 1) % 3], Pb = Pv[(vi + 2) % 3];
    const Ma = [(V[0] + Pa[0]) / 2, (V[1] + Pa[1]) / 2], Mb = [(V[0] + Pb[0]) / 2, (V[1] + Pb[1]) / 2];
    _healCand.push(Ma, Mb);
    processTri(V, Ma, Mb, depth - 1);
    processTri(Ma, Pa, Pb, depth - 1);
    processTri(Ma, Pb, Mb, depth - 1);
  };
  for (let t = 0, e = 0; t < interior.length; t += 6, e += 9) {
    const P = [[interior[t], interior[t + 1]], [interior[t + 2], interior[t + 3]], [interior[t + 4], interior[t + 5]]];
    const k = [key(P[0][0], P[0][1]), key(P[1][0], P[1][1]), key(P[2][0], P[2][1])];
    const pushSolid = () => { for (let i = 0; i < 6; i++) solid.push(interior[t + i]); if (interiorEdges) { for (let i = 0; i < 9; i++) solidEdges.push(interiorEdges[e + i]); for (let i = 0; i < 12; i++) solidEdges2.push(0); } };
    // A triangle carrying a STRAIGHT boundary edge keeps its kind-0 line ramp — converting it
    // to an arc ramp would drop the inner AA half along its whole straight edge (a solid-vs-Slug
    // over-stripe down every stem the triangle spans; the 'N' inner-edge regression). It may
    // additionally pick up a SECOND line (the opposite side of a thin stroke, or the other
    // edge at a corner) for the combined-coverage box model.
    const hasLine = interiorEdges && (interiorEdges[e] !== 0 || interiorEdges[e + 1] !== 0 || interiorEdges[e + 2] !== 0);
    if (hasLine) {
      const own = [interiorEdges[e], interiorEdges[e + 1], interiorEdges[e + 2]];
      const en2 = findSecondLine(P[0], P[1], P[2], k, own);
      pushSolidTri(P[0], P[1], P[2], own, en2 && en2.line, en2 ? cornerTypeOf(findOwnEntry(k, own), en2) : 0);
      continue;
    }
    // Chord EDGE on an arc → the whole triangle hugs that arc's span (the implicit is valid
    // across it): ramp it in one piece, after peeling the opposite corner if THAT touches a
    // different feature.
    let arcA = null, opp = -1;
    for (let ei = 0; ei < 3 && !arcA; ei++) { const ka = k[ei], kb = k[(ei + 1) % 3]; arcA = chordArcs.get(ka < kb ? ka + '|' + kb : kb + '|' + ka) || null; if (arcA) opp = (ei + 2) % 3; }
    if (!arcA) { processTri(P[0], P[1], P[2], 5); continue; }
    // Chord tri: the whole edge lies on the arc, so the near-chord region MUST ramp by it.
    // A guard failure (skinny tri whose far corner swings out of the arc's span — the graze
    // guard, or a far corner on another feature) peels toward the chord and recurses: the
    // hugging piece always passes eventually; far pieces resolve their own features via
    // processTri. All-or-nothing pushSolid here left HARD arc boundaries (the '?' 0.6 max-err).
    const chordPiece = (A3, B3, C3, depth) => {
      const ct = makeCurveTri(A3, B3, C3, arcA);
      if (ct) { curveTris.push(ct); return; }
      if (depth <= 0) { pushSolidTri(A3, B3, C3); return; }
      const M1 = [(A3[0] + C3[0]) / 2, (A3[1] + C3[1]) / 2], M2 = [(B3[0] + C3[0]) / 2, (B3[1] + C3[1]) / 2];
      _healCand.push(M1, M2);
      chordPiece(A3, B3, M2, depth - 1);
      processTri(A3, M2, M1, 3);
      processTri(M1, M2, C3, 3);
    };
    chordPiece(P[(opp + 1) % 3], P[(opp + 2) % 3], P[opp], 4);
  }
  // CRACK PATCHING: the ramp machinery (boundary fans, corner cuts, quartering) splits
  // face edges independently of their neighbours, leaving T-junctions — a vertex of one
  // face sitting strictly inside another face's edge. Rasterization then drops pixels on
  // the unshared edge at unlucky fp alignments (the M mid-diagonal 1.00 hole). Split every
  // such face at the offending vertex; pieces inherit the face's line attachments.
  if (interiorEdges) {
    const vset = [];
    const seen = new Set();
    for (let i = 0; i < solid.length; i += 2) {
      const kk = Math.round((solid[i] - _kox) * _koScale) * 2097152 + Math.round((solid[i + 1] - _koy) * _koScale);
      if (!seen.has(kk)) { seen.add(kk); vset.push([solid[i], solid[i + 1]]); }
    }
    vset.sort((a9, b9) => a9[0] - b9[0]);
    const work = [];
    for (let t = 0, e = 0, e2 = 0; t < solid.length; t += 6, e += 9, e2 += 12) {
      work.push({ P: [[solid[t], solid[t + 1]], [solid[t + 2], solid[t + 3]], [solid[t + 4], solid[t + 5]]],
                  e: solidEdges.slice(e, e + 9), e2: solidEdges2.slice(e2, e2 + 12), e3: solidEdges3.slice(e2, e2 + 12) });
    }
    const out = [];
    let guard = work.length * 8;
    while (work.length) {
      const w = work.pop();
      let split = null;
      outer: for (let ei = 0; ei < 3 && guard > 0; ei++) {
        const Pa = w.P[ei], Pb = w.P[(ei + 1) % 3];
        const ex = Pb[0] - Pa[0], ey = Pb[1] - Pa[1];
        const L2 = ex * ex + ey * ey;
        if (L2 < 1e-12) continue;
        // x-sorted slice (the splitPt pattern): only vset entries within the edge's
        // x-range ±ε can be T-verts on it — kills the faces×vset quadratic (55-seg
        // curly art → ~2800 pieces → 76ms builds before this).
        const exLo9 = Math.min(Pa[0], Pb[0]) - 1e-4, exHi9 = Math.max(Pa[0], Pb[0]) + 1e-4;
        let lo9 = 0, hi9 = vset.length;
        while (lo9 < hi9) { const mid9 = (lo9 + hi9) >> 1; if (vset[mid9][0] < exLo9) lo9 = mid9 + 1; else hi9 = mid9; }
        for (let vi9 = lo9; vi9 < vset.length && vset[vi9][0] <= exHi9; vi9++) {
          const V = vset[vi9];
          const rx = V[0] - Pa[0], ry = V[1] - Pa[1];
          const tt = (rx * ex + ry * ey) / L2;
          if (tt < 0.02 || tt > 0.98) continue;
          const dx = rx - tt * ex, dy = ry - tt * ey;
          // only true T-junctions: a shared subdivision point differs by f32 rounding
          // (~1e-4 em); anything looser grabs merely-near vertices and BENDS the edge,
          // opening new cracks against the third neighbour.
          if (dx * dx + dy * dy > 1e-8) continue;
          split = { ei, V }; break outer;
        }
      }
      if (split && guard-- > 0) {
        const { ei, V } = split;
        const Pa = w.P[ei], Pb = w.P[(ei + 1) % 3], Pc = w.P[(ei + 2) % 3];
        work.push({ P: [Pa, V, Pc], e: w.e, e2: w.e2, e3: w.e3 });
        work.push({ P: [V, Pb, Pc], e: w.e, e2: w.e2, e3: w.e3 });
      } else out.push(w);
    }
    solid.length = 0; solidEdges.length = 0; solidEdges2.length = 0; solidEdges3.length = 0;
    for (const w of out) {
      solid.push(w.P[0][0], w.P[0][1], w.P[1][0], w.P[1][1], w.P[2][0], w.P[2][1]);
      for (const x of w.e) solidEdges.push(x);
      for (const x of w.e2) solidEdges2.push(x);
      for (const x of w.e3) solidEdges3.push(x);
    }
  }
  return { solid: new Float32Array(solid), solidEdges: interiorEdges ? new Float32Array(solidEdges) : null,
           solidEdges2: interiorEdges ? new Float32Array(solidEdges2) : null,
           solidEdges3: interiorEdges ? new Float32Array(solidEdges3) : null, curveTris };
}
