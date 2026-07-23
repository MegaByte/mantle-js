// lbInteriorSplit.js — curve-aware interior partition. Splits the flat
// interior-triangle array into SOLID triangles (kind 0) and CURVE-boundary
// triangles (an edge on a curve chord) carrying the arc's affine texcoords,
// so boundary rows ramp with curveCov at the arc instead of ending in a hard
// solid-1 edge. Also owns the T-vertex heal-candidate list the split emits
// (edge midpoints) and healCracks later stitches.
import { _kox, _koy, _koScale } from './lbContour.js';

/** @typedef {{ line: number[], V: number[], dir: number[], len: number, _q?: number }} BoundaryLine */

// Edge-midpoint T-vertex candidates, reset per build by each top-level
// builder; splitInteriorByCurve pushes, healCracks consumes.
export const _healCand = [];

// Extend the crack-patching closure to CURVE faces (kind 5), from both sides.
// See the vset construction below for why.
const _CONFORM_CURVETRIS = true;

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
  // For CONVEX arcs f is convex along edges (max at endpoints — an endpoint test suffices);
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
  // Kind-0 line for an arc chord when the curve UV ramp can't own the face
  // (near-straight fonts, graze, out-of-span). Outward normal so the fill-side
  // triangle centroid has fi = n·p − c ≤ 0 (same convention as edge lines).
  const chordLineOf = (arc, A, B, C) => {
    const ex = arc.b[0] - arc.a[0], ey = arc.b[1] - arc.a[1];
    const L = Math.hypot(ex, ey) || 1;
    let nx = -ey / L, ny = ex / L;
    let c = nx * arc.a[0] + ny * arc.a[1];
    const cx = (A[0] + B[0] + C[0]) / 3, cy = (A[1] + B[1] + C[1]) / 3;
    if (nx * cx + ny * cy - c > 0) { nx = -nx; ny = -ny; c = -c; }
    return [nx, ny, c];
  };
  const nearStraightArc = (arc) => {
    const hax = arc.ctrl[0] - arc.a[0], hay = arc.ctrl[1] - arc.a[1];
    const hbx = arc.b[0] - arc.a[0], hby = arc.b[1] - arc.a[1];
    const chord2 = hbx * hbx + hby * hby;
    return Math.abs(hax * hby - hay * hbx) < 1e-4 * chord2;
  };
  const makeCurveTri = (A, B, C, arc) => {
    if (!arc) return null;
    // Only the interior triangle adjacent to the crescent may be curve-ramped.
    // Earcut can emit large interior triangles that share one endpoint with a
    // distant arc but are not bounded by its chord.
    const kA = key(A[0], A[1]), kB = key(B[0], B[1]), kC = key(C[0], C[1]);
    const kaa = key(arc.a[0], arc.a[1]), kbb = key(arc.b[0], arc.b[1]);
    const hasA = kA === kaa || kB === kaa || kC === kaa;
    const hasB = kA === kbb || kB === kbb || kC === kbb;
    if (!(hasA && hasB)) return null;
    // NEAR-STRAIGHT ARC GUARD: baryOf against a razor-thin hull (ctrl ~on the chord —
    // ubiquitous in fonts) divides by a clamped ~0 determinant and returns garbage
    // (u=v≈0 at every vert → f ≡ 0 → the piece paints NOTHING, a dead crescent over
    // real ink: G's 45px bar-bowl hole). Such an arc's AA is the LINE ramp's job —
    // return null and let the caller fall through to the line/solid handlers.
    if (nearStraightArc(arc)) return null;
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
  /** @type {Map<number, BoundaryLine[]>} */
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
  // Spatial grid over line entries. Without it findSecondLine/nearestFitLine scan
  // EVERY boundary line PER FACE — quadratic in boundary size (whole seconds on
  // organic many-segment shapes). spanOverlap already confines real candidates to the
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
  let arcGrid = null, agCell = 1, agMaxR = 1, agMaxHalf = 0;
  if (chordArcs && chordArcs.size > 96) {
    let sumA9 = 0;
    for (const arc of chordArcs.values()) sumA9 += Math.hypot(arc.b[0] - arc.a[0], arc.b[1] - arc.a[1]);
    agCell = Math.max(sumA9 / chordArcs.size, 1e-9);
    arcGrid = new Map();
    let minCX9 = Infinity, maxCX9 = -Infinity, minCY9 = Infinity, maxCY9 = -Infinity;
    for (const arc of chordArcs.values()) {
        agMaxHalf = Math.max(agMaxHalf, Math.hypot(arc.b[0] - arc.a[0], arc.b[1] - arc.a[1]) / 2);
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
  const minLineDepth = (A, B, C, line) => Math.min(
    line[2] - (line[0] * A[0] + line[1] * A[1]),
    line[2] - (line[0] * B[0] + line[1] * B[1]),
    line[2] - (line[0] * C[0] + line[1] * C[1]),
  );
  // TRUE squared distance from a point to a segment [a,b].
  const pSeg2 = (px, py, ax, ay, bx, by) => {
    const ex = bx - ax, ey = by - ay;
    const L2 = ex * ex + ey * ey;
    let t = L2 > 1e-18 ? ((px - ax) * ex + (py - ay) * ey) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px - ax - t * ex, dy = py - ay - t * ey;
    return dx * dx + dy * dy;
  };
  // TRUE squared distance from a boundary SEGMENT to a triangle (0 when they
  // touch or cross). This is the analytic ranking primitive: infinite-line
  // depth reads a remote parallel edge as "near" (the whole junction-mis-
  // attachment family), while segment distance cannot — the segment either
  // genuinely reaches the face or it ranks far.
  const segTriDist2 = (A, B, C, en) => {
    const sx = en.V[0], sy = en.V[1];
    const ex = sx + en.dir[0] * en.len, ey = sy + en.dir[1] * en.len;
    const inside = (px, py) => {
      const s1 = (B[0] - A[0]) * (py - A[1]) - (B[1] - A[1]) * (px - A[0]);
      const s2 = (C[0] - B[0]) * (py - B[1]) - (C[1] - B[1]) * (px - B[0]);
      const s3 = (A[0] - C[0]) * (py - C[1]) - (A[1] - C[1]) * (px - C[0]);
      return (s1 <= 0 && s2 <= 0 && s3 <= 0) || (s1 >= 0 && s2 >= 0 && s3 >= 0);
    };
    if (inside(sx, sy) || inside(ex, ey)) return 0;
    const segX = (p, q) => {
      const d1 = (q[0] - p[0]) * (sy - p[1]) - (q[1] - p[1]) * (sx - p[0]);
      const d2 = (q[0] - p[0]) * (ey - p[1]) - (q[1] - p[1]) * (ex - p[0]);
      const d3 = (ex - sx) * (p[1] - sy) - (ey - sy) * (p[0] - sx);
      const d4 = (ex - sx) * (q[1] - sy) - (ey - sy) * (q[0] - sx);
      return d1 * d2 <= 0 && d3 * d4 <= 0;
    };
    if (segX(A, B) || segX(B, C) || segX(C, A)) return 0;
    return Math.min(
      pSeg2(A[0], A[1], sx, sy, ex, ey), pSeg2(B[0], B[1], sx, sy, ex, ey), pSeg2(C[0], C[1], sx, sy, ex, ey),
      pSeg2(sx, sy, A[0], A[1], B[0], B[1]), pSeg2(sx, sy, B[0], B[1], C[0], C[1]), pSeg2(sx, sy, C[0], C[1], A[0], A[1]),
      pSeg2(ex, ey, A[0], A[1], B[0], B[1]), pSeg2(ex, ey, B[0], B[1], C[0], C[1]), pSeg2(ex, ey, C[0], C[1], A[0], A[1]),
    );
  };
  // A second boundary line whose band may cross this triangle's pixels (thin stroke /
  // corner): any fitting vertex line different from the first. cov saturates to 1 away
  // from it, so a far second line is harmless.
  const spanOverlap = (A, B, C, en) => {
    const ta = (A[0] - en.V[0]) * en.dir[0] + (A[1] - en.V[1]) * en.dir[1];
    const tb = (B[0] - en.V[0]) * en.dir[0] + (B[1] - en.V[1]) * en.dir[1];
    const tc = (C[0] - en.V[0]) * en.dir[0] + (C[1] - en.V[1]) * en.dir[1];
    const tmin = Math.min(ta, tb, tc), tmax = Math.max(ta, tb, tc);
    return Math.max(0, Math.min(tmax, en.len) - Math.max(tmin, 0));
  };
  const edgeOverlapLen = (P, Q, en) => {
    const tol = 1e-3 * en.len + 1e-6;
    const fp = en.line[0] * P[0] + en.line[1] * P[1] - en.line[2];
    const fq = en.line[0] * Q[0] + en.line[1] * Q[1] - en.line[2];
    if (Math.abs(fp) > tol || Math.abs(fq) > tol) return 0;
    const t0 = (P[0] - en.V[0]) * en.dir[0] + (P[1] - en.V[1]) * en.dir[1];
    const t1 = (Q[0] - en.V[0]) * en.dir[0] + (Q[1] - en.V[1]) * en.dir[1];
    return Math.max(0, Math.min(en.len, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)));
  };
  // Finite overlap between a boundary entry and the triangle's sides. This
  // distinguishes an owned face edge from a line that only grazes one vertex.
  const edgeMatchLen = (A, B, C, en) => {
    return Math.max(edgeOverlapLen(A, B, en), edgeOverlapLen(B, C, en), edgeOverlapLen(C, A, en));
  };
  const findSecondLine = (A, B, C, kv, firstLine) => {
    // Search ALL boundary lines (a face's Steiner vertices may touch neither endpoint of
    // the edge that cuts its pixels), ranked by SPAN OVERLAP — how much of the edge crosses
    // the face's projection — so corner-touching inert lines (depth 0, overlap ~0) can't
    // steal the slot from the edge that actually crosses (the N-notch sliver). Depth
    // tie-breaks. The side test in lineFits protects reflex wraps.
    //
    // Prefer anti-parallel thin-stroke opposites over acute tip partners: two
    // outward tip edges can otherwise saturate coverage across the stem fringe.
    //
    // Also reject a FAR second when the first is LOCAL and the pair is not a
    // thin-stroke opposite (nd ≲ −0.5): intersecting with a deep partner erases
    // local edge coverage. Absolute depth gates are scale-dependent, so compare
    // partner depth to the first line instead.
    let d1 = 0;
    if (firstLine) d1 = minLineDepth(A, B, C, firstLine);
    const area = Math.abs(
      (B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]),
    ) * 0.5;
    // For acute opposing partners, the line intersection must be local to the
    // face. A remote infinite wedge can saturate an unrelated tip face.
    // Near-antiparallel thin-stroke opposites keep their parallel intersection.
    const tipTol = Math.max(1.5 * Math.sqrt(Math.max(area, 0)), 1e-4);
    /** @type {BoundaryLine|null} */
    let best = null;
    let bestScore = Infinity;
    const scan9 = (en) => {
      if (firstLine && sameLine(en.line, firstLine)) return;
      if (!lineFits(A, B, C, en)) return;
      if (spanOverlap(A, B, C, en) < 1e-9) return;   // corner-grazing inert lines don't compete
      // Rank by TRUE segment distance. For in-span fill-side candidates this
      // coincides with line depth, so the guards below keep their meaning —
      // but an out-of-reach partner segment can no longer masquerade as near.
      const d = Math.sqrt(segTriDist2(A, B, C, en));
      const nd = firstLine ? (firstLine[0] * en.line[0] + firstLine[1] * en.line[1]) : 0;
      if (firstLine && d1 < 0.25 * d && d > d1 + 1e-6 && nd > -0.5) return;
      if (firstLine && nd < -0.35 && nd > -0.85) {
        const det = firstLine[0] * en.line[1] - firstLine[1] * en.line[0];
        if (Math.abs(det) < 1e-8) return;
        const hx = (firstLine[2] * en.line[1] - firstLine[1] * en.line[2]) / det;
        const hy = (firstLine[0] * en.line[2] - firstLine[2] * en.line[0]) / det;
        if (Math.min(
          Math.hypot(hx - A[0], hy - A[1]),
          Math.hypot(hx - B[0], hy - B[1]),
          Math.hypot(hx - C[0], hy - C[1]),
        ) > tipTol) return;
      }
      const score = d + (nd > 0.05 ? 1e3 : 0);
      if (score < bestScore) { bestScore = score; best = en; }
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
  // Find the shortest face side with a finite-overlapping boundary partner.
  // This keeps an actual corner side ahead of a line that merely grazes the
  // shared vertex, without allocating a candidate array per face.
  const findChordPartner = (A, B, C, ownLine) => {
    /** @type {BoundaryLine|null} */
    let partner = null;
    let partnerSideLen = Infinity, partnerShare = 0;
    const scanSide = (P0, Q0) => {
      const sideLen = Math.hypot(Q0[0] - P0[0], Q0[1] - P0[1]);
      if (sideLen < 1e-9) return;
      /** @type {BoundaryLine|null} */
      let sideBest = null;
      let sideShare = 0;
      const consider = (en) => {
        if (sameLine(en.line, ownLine)) return;
        const nd = ownLine[0] * en.line[0] + ownLine[1] * en.line[1];
        if (nd <= -0.85) return;
        const share = edgeOverlapLen(P0, Q0, en);
        if (share > sideShare) { sideShare = share; sideBest = en; }
      };
      const ll0 = vertexLines.get(key(P0[0], P0[1]));
      const ll1 = vertexLines.get(key(Q0[0], Q0[1]));
      if (ll0) for (const en of ll0) consider(en);
      if (ll1) for (const en of ll1) consider(en);
      if (sideBest && (sideLen < partnerSideLen || (sideLen === partnerSideLen && sideShare > partnerShare))) {
        partner = sideBest; partnerSideLen = sideLen; partnerShare = sideShare;
      }
    };
    scanSide(A, B); scanSide(B, C); scanSide(C, A);
    return partner;
  };
  const nearestFitLine = (A, B, C) => {
    // Rank by TRUE segment distance (segTriDist2), not infinite-line depth:
    // a remote parallel stroke edge has small line depth but a large segment
    // distance, so it cannot outrank the local edge — and a local touching
    // edge (dist 0) always passes the deep gate, which removes the old
    // vertex-touch retry. The gate itself keeps its S0 semantics: candidates
    // beyond 0.55·√area stay unattached, so a deep-interior face paints bare
    // solid (and the junction-chip handler in pushSolidTriRaw keeps owning
    // the tiny-face cases). Touching candidates tie-break by span overlap so
    // a corner-grazing inert line cannot steal the slot from the edge that
    // runs along a face side.
    const area = Math.abs(
      (B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]),
    ) * 0.5;
    const dMax2 = 0.3025 * area;   // (0.55·√area)²
    /** @type {BoundaryLine|null} */
    let best = null;
    let bestD2 = Infinity, bestOv = -Infinity;
    const scan9 = (en) => {
      if (!lineFits(A, B, C, en)) return;
      const ov = spanOverlap(A, B, C, en);
      if (ov < 1e-9) return;
      const d2 = segTriDist2(A, B, C, en);
      if (dMax2 > 1e-24 && d2 > dMax2) return;
      if (d2 < bestD2 - 1e-18 || (d2 <= bestD2 + 1e-18 && ov > bestOv)) {
        bestD2 = d2; bestOv = ov; best = en;
      }
    };
    forLinesNear(A, B, C, 2, scan9);
    return best;
  };
  // Sutherland-Hodgman clip of a triangle to an edge's along-span slab. Mid piece
  // ramps by `en`; out-of-span leftovers are returned for the caller to re-resolve.
  const spanClipTri = (A, B, C, en, sl) => {
    const slack = sl == null ? 0.05 : sl;
    const lo = -slack * en.len, hi = (1 + slack) * en.len;
    const tOf = (P) => (P[0] - en.V[0]) * en.dir[0] + (P[1] - en.V[1]) * en.dir[1];
    const clip = (poly, b, keepLower) => {
      if (!poly.length) return poly;
      const out = [];
      const inside = (P) => keepLower ? tOf(P) <= b : tOf(P) >= b;
      for (let i = 0; i < poly.length; i++) {
        const P = poly[i], Q = poly[(i + 1) % poly.length];
        const pi = inside(P), qi = inside(Q);
        if (pi) out.push(P);
        if (pi !== qi) {
          const tp = tOf(P), tq = tOf(Q);
          const u = (b - tp) / (tq - tp);
          const X = [P[0] + u * (Q[0] - P[0]), P[1] + u * (Q[1] - P[1])];
          _healCand.push(X);
          out.push(X);
        }
      }
      return out;
    };
    const tri = [A, B, C];
    const mid = clip(clip(tri, lo, false), hi, true);
    const below = clip(tri, lo, true);
    const above = clip(tri, hi, false);
    const areaOf = (p) => {
      let a = 0;
      for (let i = 0; i < p.length; i++) {
        const q = p[(i + 1) % p.length];
        a += p[i][0] * q[1] - q[0] * p[i][1];
      }
      return Math.abs(a) * 0.5;
    };
    const eps = 1e-12 * (en.len * en.len + 1);
    return { mid, below, above, areaOf, eps };
  };
  const pushSolidTriRaw = (A, B, C, line, line2, type, noAttach, sideDepth) => {
    if (!interiorEdges) {
      solid.push(A[0], A[1], B[0], B[1], C[0], C[1]);
      return;
    }
    let L = line, L2 = line2, T = type;
    /** @type {BoundaryLine|null} */
    let unionN3 = null;
    // FILL-SIDE INVARIANT: a face must lie in the CLOSED fill half-plane of its
    // primary line. The inner ramp reads ~0 on the line's exterior side, so a
    // face that pokes past its edge's corner (a junction face crossing the
    // edge's infinite-line extension into the neighbouring stroke's interior)
    // would claim real fill at near-zero coverage — the crotch-diamond hole.
    // Split analytically at the line: the fill-side piece keeps the ramp, the
    // overhang re-resolves its own nearest feature (lineFits' side test keeps
    // it from re-attaching this line), or paints bare solid. Reflex-union
    // pairs (T < 0) are exempt: fill = A ∪ B, so a face on the primary line's
    // exterior side is legitimately covered by the partner's half-plane.
    if (L && sideDepth !== -1 && !(L2 && T < 0)) {
      const dep = sideDepth == null ? 4 : sideDepth;
      const fa = L[0] * A[0] + L[1] * A[1] - L[2];
      const fb = L[0] * B[0] + L[1] * B[1] - L[2];
      const fc = L[0] * C[0] + L[1] * C[1] - L[2];
      // Tolerance absorbs f32 round-trip noise only (~1e-7 on em-scale coords).
      // A looser 1e-3 let shards overhang ~0.4px at large draw scales and claim
      // the neighbouring stroke's solid ink at near-zero coverage (the dotted
      // diagonal under-dots on 'w').
      const tol = 1e-5;
      if (dep > 0 && Math.max(fa, fb, fc) > tol && Math.min(fa, fb, fc) < -tol) {
        const P9 = [A, B, C], F9 = [fa, fb, fc];
        const keep = [], over = [];
        for (let i = 0; i < 3; i++) {
          const P0 = P9[i], P1 = P9[(i + 1) % 3];
          const f0 = F9[i], f1 = F9[(i + 1) % 3];
          (f0 <= 0 ? keep : over).push(P0);
          if ((f0 < 0) !== (f1 < 0)) {
            const u = f0 / (f0 - f1);
            const X = [P0[0] + u * (P1[0] - P0[0]), P0[1] + u * (P1[1] - P0[1])];
            _healCand.push(X);
            keep.push(X); over.push(X);
          }
        }
        const areaOf9 = (p) => {
          let a9 = 0;
          for (let i = 0; i < p.length; i++) {
            const q9 = p[(i + 1) % p.length];
            a9 += p[i][0] * q9[1] - q9[0] * p[i][1];
          }
          return Math.abs(a9) * 0.5;
        };
        if (keep.length >= 3 && areaOf9(keep) > 1e-12) {
          for (let i = 1; i + 1 < keep.length; i++) pushSolidTriRaw(keep[0], keep[i], keep[i + 1], L, L2, T, noAttach, -1);
        }
        if (over.length >= 3 && areaOf9(over) > 1e-12) {
          for (let i = 1; i + 1 < over.length; i++) pushSolidTriRaw(over[0], over[i], over[i + 1], null, null, 0, false, dep - 1);
        }
        return;
      }
      if (dep > 0 && Math.min(fa, fb, fc) > tol) {
        // Whole face on the exterior side of the proposed line: the ramp would
        // zero it entirely — drop the attachment and re-resolve instead.
        pushSolidTriRaw(A, B, C, null, null, 0, false, dep - 1);
        return;
      }
    }
    if (!L && !noAttach) {
      const en = nearestFitLine(A, B, C);
      if (en) L = en.line;
      else if (chordArcs) {
        const kk = [key(A[0], A[1]), key(B[0], B[1]), key(C[0], C[1])];
        for (let ei = 0; ei < 3 && !L; ei++) {
          const ka = kk[ei], kb = kk[(ei + 1) % 3];
          const arc = chordArcs.get(ka < kb ? ka + '|' + kb : kb + '|' + ka);
          if (arc) L = chordLineOf(arc, A, B, C);
        }
      }
    }
    const area = Math.abs(
      (B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]),
    ) * 0.5;
    // Degenerate bare leftovers at stroke junctions can paint solid into AA
    // gaps. Attach only a shallow nearby edge so the chip ramps; a deeper,
    // parallel stroke edge would incorrectly claim the junction fringe.
    if (!L && area < 0.002) {
      /** @type {BoundaryLine|null} */
      let best = null;
      let bestD = Infinity;
      const scan9 = (en) => {
        if (spanOverlap(A, B, C, en) < 1e-9) return;
        let dMin = Infinity, dMax = -Infinity;
        const fa = en.line[0] * A[0] + en.line[1] * A[1] - en.line[2];
        const fb = en.line[0] * B[0] + en.line[1] * B[1] - en.line[2];
        const fc = en.line[0] * C[0] + en.line[1] * C[1] - en.line[2];
        dMin = Math.min(-fa, -fb, -fc); dMax = Math.max(-fa, -fb, -fc);
        if (dMin < -1e-6) return;
        if (dMax > 0.04) return;
        if (dMax < bestD) { bestD = dMax; best = en; }
      };
      forLinesNear(A, B, C, 2, scan9);
      if (best) L = best.line;
      else if (area < 1e-9) return;
    } else if (!L && area < 1e-9) return;
    // A tiny intersection of near-antiparallel edges saturates tip AA.
    if (L && L2 && area < 0.002) {
      const nd = L[0] * L2[0] + L[1] * L2[1];
      if (nd <= -0.85) { L2 = null; T = 0; }
    }
    // Tiny junction chip claimed by a deep line that touches no vertex: the
    // claimed line is a remote parallel edge selected by proximity, not a
    // boundary of this face. Neither dropping the face (a hole over winding-1
    // interior — the crotch diamond) nor painting it bare solid (1.0 over the
    // junction notch's AA) is right. The truth at a junction notch is the
    // REFLEX UNION of the two nearest notch edges — fill = A ∪ B, which the
    // kind-0 two-line reflex model (T = −1) evaluates exactly: it saturates to
    // 1 deep inside either half-plane and gives the correct partial inside the
    // notch wedge, regardless of which side of each line the face sits on.
    if (L && area < 0.002) {
      let nOn = 0, dMin = Infinity;
      for (const Pp of [A, B, C]) {
        const fi = L[0] * Pp[0] + L[1] * Pp[1] - L[2];
        if (Math.abs(fi) <= 1e-3) nOn++;
        dMin = Math.min(dMin, -fi);
      }
      if (nOn === 0 && dMin > 0.55 * Math.sqrt(Math.max(area, 0))) {
        const cx9 = (A[0] + B[0] + C[0]) / 3, cy9 = (A[1] + B[1] + C[1]) / 3;
        /** @type {BoundaryLine|null} */
        let n1 = null;
        /** @type {BoundaryLine|null} */
        let n2 = null;
        /** @type {BoundaryLine|null} */
        let n3 = null;
        let d1 = Infinity, d2 = Infinity, d3u = Infinity;
        const scanU = (en) => {
          if (spanOverlap(A, B, C, en) < 1e-9) return;
          const d = Math.abs(en.line[0] * cx9 + en.line[1] * cy9 - en.line[2]);
          if (d < d1) {
            if (n1 && !sameLine(n1.line, en.line)) {
              if (n2 && !sameLine(n2.line, en.line)) { n3 = n2; d3u = d2; }
              n2 = n1; d2 = d1;
            }
            n1 = en; d1 = d;
          } else if (d < d2 && n1 && !sameLine(n1.line, en.line)) {
            if (n2 && !sameLine(n2.line, en.line)) { n3 = n2; d3u = d2; }
            n2 = en; d2 = d;
          } else if (d < d3u && n1 && n2 && !sameLine(n1.line, en.line) && !sameLine(n2.line, en.line)) { n3 = en; d3u = d; }
        };
        forLinesNear(A, B, C, 3, scanU);
        if (n1 && n2) {
          L = n1.line; L2 = n2.line; T = -1;
          // X-CROSSING chips: two half-planes cannot express the union of two
          // crossing strokes — a pixel deep inside the OTHER stroke lies
          // outside both chosen edges and read ~0 (the dotted under-dots on
          // 'w'). A third union term through the L3 slot (type −1, the FS's
          // cA+cC−cA·cC) saturates it.
          if (n3) unionN3 = n3;
        }
        else if (n1) { L = n1.line; L2 = null; T = 0; }
        // no near feature at all: keep the deep line (inert — cov saturates to 1)
      }
    }
    solid.push(A[0], A[1], B[0], B[1], C[0], C[1]);
    if (L) for (let i = 0; i < 3; i++) solidEdges.push(L[0], L[1], L[2]); else for (let i = 0; i < 9; i++) solidEdges.push(0);
    if (L2 && T) for (let i = 0; i < 3; i++) solidEdges2.push(L2[0], L2[1], L2[2], T); else for (let i = 0; i < 12; i++) solidEdges2.push(0);
    let en3 = null, d3 = Infinity;
    if (L && L2) {
      const scan9 = (en) => {
        if (sameLine(en.line, L) || sameLine(en.line, L2)) return;
        if (!lineFits(A, B, C, en)) return;
        if (spanOverlap(A, B, C, en) < 1e-9) return;
        let d = Infinity;
        for (const Pp of [A, B, C]) d = Math.min(d, en.line[2] - (en.line[0] * Pp[0] + en.line[1] * Pp[1]));
        if (d < d3) { d3 = d; en3 = en; }
      };
      forLinesNear(A, B, C, 2, scan9);
    }
    const en3v = /** @type {any} */ (unionN3 || en3);
    if (unionN3) {
      for (let i = 0; i < 3; i++) solidEdges3.push(unionN3.line[0], unionN3.line[1], unionN3.line[2], -1);
    } else if (en3v) {
      const oe3 = findOwnEntry([key(A[0], A[1]), key(B[0], B[1]), key(C[0], C[1])], L);
      const t3 = cornerTypeOf(oe3, en3v);
      if (t3) { for (let i = 0; i < 3; i++) solidEdges3.push(en3v.line[0], en3v.line[1], en3v.line[2], t3); } else for (let i = 0; i < 12; i++) solidEdges3.push(0);
    } else for (let i = 0; i < 12; i++) solidEdges3.push(0);
  };
  const pushSolidTri = (A, B, C, line, line2, type) => {
    // A line-less solid piece (belts of the corner-cut recursion, chord fall-backs) still
    // attaches the nearest fitting boundary line — its pixels' boxes may be cut by an edge
    // the piece doesn't touch, and a bare solid paints 1.0 where Slug ramps. Saturating
    // coverage makes a far attachment harmless.
    pushSolidTriRaw(A, B, C, line, line2, type);
  };
  // Recursive corner processor. A triangle may touch SEVERAL distinct boundary features (one
  // vertex on the outer contour, another on a counter — the thin-ring case), and one affine
  // frame can only ramp one of them: cut a corner piece per feature-vertex (each ramped by ITS
  // wedge-correct feature) and recurse on the belt. A LINE feature rides the kind-0 inner ramp
  // (valid at any distance); an ARC corner whose full extent fails edgeMaxF (the extended
  // parabola cuts back — the concave hole risk) shrinks toward its vertex until the implicit
  // is locally valid. The pinch zone where crescents vanish always ramps.
  let ptNodes = 0;
  const ptBudget = Math.max(4096, (interior.length / 6) * 8);
  // distance from a point to an arc's chord SEGMENT — the fair comparison
  // against a line entry's perpendicular distance. The old chord-MIDPOINT
  // distance made a face near an arc's END read the arc as far, so a straight
  // line won the nearest-feature contest and painted SOLID across the curve
  // (s's spine shoulder, lb 4 vs ref 118 — the curve second-row class).
  const distToChord = (p, arc) => {
    const dx = arc.b[0] - arc.a[0], dy = arc.b[1] - arc.a[1];
    const L2 = dx * dx + dy * dy || 1e-30;
    const t = Math.max(0, Math.min(1, ((p[0] - arc.a[0]) * dx + (p[1] - arc.a[1]) * dy) / L2));
    return Math.hypot(p[0] - (arc.a[0] + t * dx), p[1] - (arc.a[1] + t * dy));
  };
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
      let bestEn = null, bestD = Infinity, spanFail = false, spanEn = null, spanD = Infinity;
      const scanL9 = (en) => {
        if (!lineFits(A, B, C, en, 0.45)) return;
        if (!lineFits(A, B, C, en)) {
          // side ok, span too wide → CLIP to the edge's span below (was: quarter the face)
          spanFail = true;
          let d = Infinity;
          for (const Pp of [A, B, C]) d = Math.min(d, en.line[2] - (en.line[0] * Pp[0] + en.line[1] * Pp[1]));
          if (d < spanD) { spanD = d; spanEn = en; }
          return;
        }
        let d = Infinity;
        for (const Pp of [A, B, C]) d = Math.min(d, en.line[2] - (en.line[0] * Pp[0] + en.line[1] * Pp[1]));
        if (d < bestD) { bestD = d; bestEn = en; }
      };
      forLinesNear(A, B, C, 2, scanL9);
      let bestArc = null, bestAD = Infinity;
      if (!arcGrid) {
        for (const arc of chordArcs.values()) {
          const d = distToChord(cen, arc);
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
              const d = distToChord(cen, arc);
              if (d < bestAD) { bestAD = d; bestArc = arc; }
            }
          }
          // ring bound over SEGMENT distance: a chord's grid cells cover its
          // midpoint, so a segment can be up to agMaxHalf nearer than any
          // scanned midpoint — widen the stop by that much.
          if (bestArc && bestAD + agMaxHalf <= (r9 - 1) * agCell) break;
        }
      }
      // Drop tip or stroke partners that are deep relative to the face so a
      // nearer arc can claim the junction fringe.
      {
        const area = Math.abs(
          (B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]),
        ) * 0.5;
        const dMax = 0.55 * Math.sqrt(Math.max(area, 0));
        if (bestEn && dMax > 1e-12 && bestD > dMax) bestEn = null;
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
      if (spanFail && spanEn && depth > 0) {
        // A side-valid face can extend past the boundary segment. Clip it by the
        // segment's span planes: the middle slab uses this ramp directly, while
        // the outer convex pieces resolve their own nearest feature.
        const en = /** @type {any} */ (spanEn);
        const { mid, below, above, areaOf, eps } = spanClipTri(A, B, C, en);
        if (mid.length >= 3 && areaOf(mid) > eps) {
          // fits by construction → attach this edge's ramp line, no second search
          for (let i = 1; i + 1 < mid.length; i++) pushSolidTri(mid[0], mid[i], mid[i + 1], en.line, null, 0);
          for (const piece of [below, above]) {
            if (piece.length < 3 || areaOf(piece) <= eps) continue;
            for (let i = 1; i + 1 < piece.length; i++) processTri(piece[0], piece[i], piece[i + 1], depth - 1);
          }
          return;
        }
        // degenerate cut (the slab missed the face) → fall through to solid
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
        // Near-straight: curve UV is ill-conditioned and peel never helps — chord line.
        // Other makeCurveTri failures (graze / out-of-span) still fall through to peel.
        if (nearStraightArc(f.arc)) {
          pushSolidTri(A, B, C, chordLineOf(f.arc, A, B, C));
          return;
        }
      }
    }
    if (depth <= 0) { pushSolidTri(A, B, C); return; }
    // The face carries MORE THAN ONE boundary feature, so no single ramp line/arc describes it.
    // The old cut isolated ONE feature vertex per level and recursed on the belt: 3^depth faces.
    // A single midpoint split isolates ALL of them at once — each corner keeps exactly one
    // original vertex (hence at most one feature) and the centre keeps none, so no child can
    // re-enter this branch. One level, four faces, and it terminates by construction.
    const Mab = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const Mbc = [(B[0] + C[0]) / 2, (B[1] + C[1]) / 2];
    const Mca = [(C[0] + A[0]) / 2, (C[1] + A[1]) / 2];
    _healCand.push(Mab, Mbc, Mca);
    processTri(A, Mab, Mca, depth - 1);
    processTri(Mab, B, Mbc, depth - 1);
    processTri(Mca, Mbc, C, depth - 1);
    processTri(Mab, Mbc, Mca, depth - 1);
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
      // CDT-owned edge can be a far tip/stroke partner while the face's pixels sit on
      // a nearer stem edge. Full lineFits may fail when a vertex lies just past
      // the endpoint or outside the half-plane. Pick the nearest edge by centroid
      // depth, clip the face into that edge's fill+span slab, ramp the mid; leftovers
      // attach nearest fit (no deep processTri — that exploded 'x' to ~6k faces).
      const cen = [(P[0][0] + P[1][0] + P[2][0]) / 3, (P[0][1] + P[1][1] + P[2][1]) / 3];
      let ownD = own[2] - (own[0] * cen[0] + own[1] * cen[1]);
      /** @type {BoundaryLine|null} */
      let nearEn = null;
      let nearD = Infinity;
      const scanNear = (en) => {
        if (sameLine(en.line, own)) return;
        const fiC = en.line[0] * cen[0] + en.line[1] * cen[1] - en.line[2];
        if (fiC > 1e-3 * en.len + 1e-9) return;   // centroid outside fill
        const t = (cen[0] - en.V[0]) * en.dir[0] + (cen[1] - en.V[1]) * en.dir[1];
        if (t < -0.25 * en.len || t > 1.25 * en.len) return;   // centroid far off-span
        const d = -fiC;
        if (d < nearD) { nearD = d; nearEn = en; }
      };
      forLinesNear(P[0], P[1], P[2], 3, scanNear);
      // Clip face to `en`'s fill half-plane + span slab; emit kind-0 mids.
      // Returns true if anything was emitted (caller should continue).
      const clipFaceToLine = (en) => {
        const tol = 1e-3 * en.len + 1e-9;
        const sideOf = (Q) => en.line[0] * Q[0] + en.line[1] * Q[1] - en.line[2];
        const clipSide = (poly, keepFill) => {
          if (!poly.length) return poly;
          const out = [];
          for (let i = 0; i < poly.length; i++) {
            const A = poly[i], B = poly[(i + 1) % poly.length];
            const sa = sideOf(A), sb = sideOf(B);
            const ai = keepFill ? sa <= tol : sa > tol;
            const bi = keepFill ? sb <= tol : sb > tol;
            if (ai) out.push(A);
            if (ai !== bi) {
              const u = (sa - tol) / (sa - sb);
              const X = [A[0] + u * (B[0] - A[0]), A[1] + u * (B[1] - A[1])];
              _healCand.push(X);
              out.push(X);
            }
          }
          return out;
        };
        let poly = clipSide([P[0], P[1], P[2]], true);
        const areaOf = (p) => {
          let a = 0;
          for (let i = 0; i < p.length; i++) {
            const q = p[(i + 1) % p.length];
            a += p[i][0] * q[1] - q[0] * p[i][1];
          }
          return Math.abs(a) * 0.5;
        };
        const eps = 1e-12 * (en.len * en.len + 1);
        if (poly.length < 3 || areaOf(poly) <= eps) return false;
        // The EXTERIOR-side remainder is REAL GEOMETRY, not provably air: the
        // clip line is only a boundary within its segment's span, and the face
        // can extend past the segment's end where fill continues on the line's
        // other side (the 'D' counter's left edge extended below the counter
        // clipped the whole under-arm wedge away — a 6402px hole). Re-resolve
        // it like a span-clip leftover: nearest fitting feature or bare solid.
        {
          const rest = clipSide([P[0], P[1], P[2]], false);
          if (rest.length >= 3 && areaOf(rest) > eps) {
            for (let i = 1; i + 1 < rest.length; i++) pushSolidTri(rest[0], rest[i], rest[i + 1]);
          }
        }
        const fan = [];
        for (let i = 1; i + 1 < poly.length; i++) fan.push([poly[0], poly[i], poly[i + 1]]);
        let did = false;
        for (const tri of fan) {
          if (lineFits(tri[0], tri[1], tri[2], en)) {
            const en2 = findSecondLine(tri[0], tri[1], tri[2], null, en.line);
            pushSolidTri(tri[0], tri[1], tri[2], en.line, en2 && en2.line, en2 ? cornerTypeOf(en, en2) : 0);
            did = true;
            continue;
          }
          const { mid, below, above, areaOf: a2, eps: e2 } = spanClipTri(tri[0], tri[1], tri[2], en);
          if (mid.length >= 3 && a2(mid) > e2) {
            for (let i = 1; i + 1 < mid.length; i++) {
              const en2 = findSecondLine(mid[0], mid[i], mid[i + 1], null, en.line);
              pushSolidTri(mid[0], mid[i], mid[i + 1], en.line, en2 && en2.line, en2 ? cornerTypeOf(en, en2) : 0);
            }
            for (const piece of [below, above]) {
              if (piece.length < 3 || a2(piece) <= e2) continue;
              for (let i = 1; i + 1 < piece.length; i++) {
                pushSolidTri(piece[0], piece[i], piece[i + 1]);
              }
            }
            did = true;
          }
        }
        return did;
      };
      // The absolute gate prevents relative-only clipping on large crossing faces.
      if (nearEn && ownD > 0.015 && ownD > nearD * 3 + 1e-6) {
        // Same-side acute near edge (nd ≳ 0.5): span-clipping the face to that
        // edge drops junction wedges. Keep the CDT-owned ramp; opposite or
        // orthogonal nearer edges still rebind and clip.
        // Exception: CDT own that matches no face side (nOn/edgeMatch 0) is a
        // remote parallel stroke edge and must not saturate junction AA.
        const ndNear = own[0] * nearEn.line[0] + own[1] * nearEn.line[1];
        const ownEnGate = findOwnEntry(k, own);
        const ownTouches = ownEnGate ? edgeMatchLen(P[0], P[1], P[2], ownEnGate) > 1e-6 : false;
        if (ndNear > 0.5 && ownTouches) {
          const en2 = ownD > 0.02 ? null : findSecondLine(P[0], P[1], P[2], k, own);
          pushSolidTri(P[0], P[1], P[2], own, en2 && en2.line, en2 ? cornerTypeOf(findOwnEntry(k, own), en2) : 0);
          continue;
        }
        if (clipFaceToLine(nearEn)) continue;
      }
      // For a large face whose CDT owner is deep, sample vertices and edge
      // midpoints for a fringe-grazing line; otherwise re-resolve against arcs.
      {
        const area = Math.abs(
          (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]),
        ) * 0.5;
        const faceScale = Math.sqrt(Math.max(area, 0));
        if (ownD > 0.55 * faceScale && ownD > 0.05) {
          const ownEnKeep = findOwnEntry(k, own);
          const ownEdgeMatch = ownEnKeep ? edgeMatchLen(P[0], P[1], P[2], ownEnKeep) : 0;
          /** @type {BoundaryLine|null} */
          let sampEn = null;
          let sampD = Infinity;
          const scanSamp = (en) => {
            if (sameLine(en.line, own)) return;
            const tolH = 1e-3 * en.len + 1e-9;
            let dMin = Infinity, nOut = 0, anyIn = false;
            for (let si = 0; si < 6; si++) {
              let sx, sy;
              if (si < 3) { sx = P[si][0]; sy = P[si][1]; }
              else {
                const i0 = si - 3, i1 = (i0 + 1) % 3;
                sx = (P[i0][0] + P[i1][0]) * 0.5;
                sy = (P[i0][1] + P[i1][1]) * 0.5;
              }
              const fi = en.line[0] * sx + en.line[1] * sy - en.line[2];
              if (fi > tolH) { nOut++; continue; }
              dMin = Math.min(dMin, -fi);
              const t = (sx - en.V[0]) * en.dir[0] + (sy - en.V[1]) * en.dir[1];
              if (t >= -0.25 * en.len && t <= 1.25 * en.len) anyIn = true;
            }
            if (nOut > 1 || dMin === Infinity || !anyIn) return;
            if (dMin < sampD) { sampD = dMin; sampEn = en; }
          };
          forLinesNear(P[0], P[1], P[2], 4, scanSamp);
          if (sampEn && sampD < 0.25 * ownD && ownD > sampD * 3 + 1e-6) {
            // A line that only grazes one tip vertex must not steal ownership
            // from a CDT line that overlaps an actual face edge.
            const sampMatch = edgeMatchLen(P[0], P[1], P[2], sampEn);
            if (!(ownEdgeMatch > 1e-6 && sampMatch < 1e-6)) {
              if (clipFaceToLine(sampEn)) continue;
            }
          }
          // Re-resolve deep tip or stroke partners so a nearer arc can win.
          // A chord-matched owner already is the AA edge and remains attached.
          if (ownEdgeMatch < 1e-6) {
            processTri(P[0], P[1], P[2], 2);
            continue;
          }
        }
      }
      // A distant second partner can saturate the stem fringe. Keep one ramp
      // unless the owner overlaps a face side, in which case pair the other
      // overlapping side to preserve corner coverage. Ignore near-antiparallel
      // partners here; findSecondLine handles true thin-stroke opposites.
      {
        const ownEn = findOwnEntry(k, own);
        const ownMatch = ownEn ? edgeMatchLen(P[0], P[1], P[2], ownEn) : 0;
        /** @type {BoundaryLine|null} */
        let en2 = null;
        if (ownMatch > 1e-6) en2 = findChordPartner(P[0], P[1], P[2], own);
        if (!en2 && ownD <= 0.02) en2 = findSecondLine(P[0], P[1], P[2], k, own);
        pushSolidTri(P[0], P[1], P[2], own, en2 && en2.line, en2 ? cornerTypeOf(ownEn || findOwnEntry(k, own), en2) : 0);
      }
      continue;
    }
    // Chord EDGE on an arc → the whole triangle hugs that arc's span (the implicit is valid
    // across it): ramp it in one piece, after peeling the opposite corner if THAT touches a
    // different feature.
    let arcA = null, opp = -1;
    for (let ei = 0; ei < 3 && !arcA; ei++) { const ka = k[ei], kb = k[(ei + 1) % 3]; arcA = chordArcs.get(ka < kb ? ka + '|' + kb : kb + '|' + ka) || null; if (arcA) opp = (ei + 2) % 3; }
    // One feature-isolation split plus one span clip is sufficient; deeper
    // recursion grows geometry rapidly without changing the selected feature.
    if (!arcA) { processTri(P[0], P[1], P[2], 2); continue; }
    // Chord tri: the whole edge lies on the arc, so the near-chord region MUST ramp by it.
    // A guard failure (skinny tri whose far corner swings out of the arc's span — the graze
    // guard, or a far corner on another feature) peels toward the chord and recurses: the
    // hugging piece always passes eventually; far pieces resolve their own features via
    // processTri. All-or-nothing pushSolid here left HARD arc boundaries.
    const chordPiece = (A3, B3, C3, depth) => {
      const ct = makeCurveTri(A3, B3, C3, arcA);
      if (ct) { curveTris.push(ct); return; }
      // Near-straight arcs never become valid curveTris (UV ill-conditioned) —
      // peel is useless; AA via the chord's kind-0 line. Same fallback when
      // depth is exhausted after graze/span peels.
      if (nearStraightArc(arcA) || depth <= 0) {
        pushSolidTri(A3, B3, C3, chordLineOf(arcA, A3, B3, C3));
        return;
      }
      const M1 = [(A3[0] + C3[0]) / 2, (A3[1] + C3[1]) / 2], M2 = [(B3[0] + C3[0]) / 2, (B3[1] + C3[1]) / 2];
      _healCand.push(M1, M2);
      chordPiece(A3, B3, M2, depth - 1);
      processTri(A3, M2, M1, 2);
      processTri(M1, M2, C3, 2);
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
    const addV9 = (x9, y9) => {
      const kk = Math.round((x9 - _kox) * _koScale) * 2097152 + Math.round((y9 - _koy) * _koScale);
      if (!seen.has(kk)) { seen.add(kk); vset.push([x9, y9]); }
    };
    for (let i = 0; i < solid.length; i += 2) addV9(solid[i], solid[i + 1]);
    // CURVE faces are part of the same tiling and must take part in the closure
    // from BOTH sides. Without their vertices here, a curveTri corner sitting on
    // a solid edge is never seen; without the curveTri split below, a solid
    // vertex sitting on a curveTri edge is never repaired. The second case is
    // the dominant one measured on the pause icons: 56 T-junctions at distance
    // EXACTLY 0, 42 of them at edge parameter s = 0.5 — the fingerprint of
    // processTri's 1-to-4 midpoint split, whose Mab lands on the neighbour's
    // edge. healCracks repairs the crescent side, but the partition route
    // (buildLoopBlinnCDT's default for line/quad/rquad/cubic shapes) returns
    // without ever calling it, so on that route nothing did.
    if (_CONFORM_CURVETRIS) for (const ct of curveTris)
      for (let k = 0; k < 3; k++) addV9(ct.tri[2 * k], ct.tri[2 * k + 1]);
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
    // Re-emit cracked shards (X-junction crotch overs need a partner cut that
    // also hits all-out siblings / Steiner chips — tip-inside geom-clip alone
    // leaves those painting; all-out drops underfill stroke AA).
    solid.length = 0; solidEdges.length = 0; solidEdges2.length = 0; solidEdges3.length = 0;
    for (const w of out) {
      solid.push(w.P[0][0], w.P[0][1], w.P[1][0], w.P[1][1], w.P[2][0], w.P[2][1]);
      for (const x of w.e) solidEdges.push(x);
      for (const x of w.e2) solidEdges2.push(x);
      for (const x of w.e3) solidEdges3.push(x);
    }
    // CURVE-FACE closure, the other half of the tiling. Splitting a curveTri is
    // EXACT, not an approximation: (u,v,r) are affine over the control triangle,
    // so lerping them along the cut edge carries the identical implicit into both
    // children — the arc and its analytic coverage are unchanged (the same
    // property healCracks relies on). Only the fragment set is repartitioned.
    if (_CONFORM_CURVETRIS && curveTris.length) {
      const workC = curveTris.slice();
      const outC = [];
      let guardC = workC.length * 8;
      while (workC.length) {
        const q = workC.pop();
        const P = [[q.tri[0], q.tri[1]], [q.tri[2], q.tri[3]], [q.tri[4], q.tri[5]]];
        let split = null;
        outerC: for (let ei = 0; ei < 3 && guardC > 0; ei++) {
          const Pa = P[ei], Pb = P[(ei + 1) % 3];
          const ex = Pb[0] - Pa[0], ey = Pb[1] - Pa[1];
          const L2 = ex * ex + ey * ey;
          if (L2 < 1e-12) continue;
          const exLo9 = Math.min(Pa[0], Pb[0]) - 1e-4, exHi9 = Math.max(Pa[0], Pb[0]) + 1e-4;
          let lo9 = 0, hi9 = vset.length;
          while (lo9 < hi9) { const mid9 = (lo9 + hi9) >> 1; if (vset[mid9][0] < exLo9) lo9 = mid9 + 1; else hi9 = mid9; }
          for (let vi9 = lo9; vi9 < vset.length && vset[vi9][0] <= exHi9; vi9++) {
            const V = vset[vi9];
            const rx = V[0] - Pa[0], ry = V[1] - Pa[1];
            const tt = (rx * ex + ry * ey) / L2;
            if (tt < 0.02 || tt > 0.98) continue;
            const dx = rx - tt * ex, dy = ry - tt * ey;
            if (dx * dx + dy * dy > 1e-8) continue;   // same true-T-junction gate as the solid pass
            split = { ei, V, tt }; break outerC;
          }
        }
        if (split && guardC-- > 0) {
          const { ei, V, tt } = split;
          const ia = ei, ib = (ei + 1) % 3, ic = (ei + 2) % 3;
          const ta = q.tc.slice(ia * 3, ia * 3 + 3), tb = q.tc.slice(ib * 3, ib * 3 + 3), tcC = q.tc.slice(ic * 3, ic * 3 + 3);
          const tv = [ta[0] + (tb[0] - ta[0]) * tt, ta[1] + (tb[1] - ta[1]) * tt, ta[2] + (tb[2] - ta[2]) * tt];
          const mk = (p0, t0, p1, t1, p2, t2) => ({ ...q,
            tri: new Float32Array([p0[0], p0[1], p1[0], p1[1], p2[0], p2[1]]),
            tc: new Float32Array([...t0, ...t1, ...t2]) });
          workC.push(mk(P[ia], ta, V, tv, P[ic], tcC));
          workC.push(mk(V, tv, P[ib], tb, P[ic], tcC));
        } else outC.push(q);
      }
      curveTris.length = 0;
      for (const q of outC) curveTris.push(q);
    }
  }
      return { solid: new Float32Array(solid), solidEdges: interiorEdges ? new Float32Array(solidEdges) : null,
           solidEdges2: interiorEdges ? new Float32Array(solidEdges2) : null,
           solidEdges3: interiorEdges ? new Float32Array(solidEdges3) : null, curveTris };
}
