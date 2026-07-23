// cdt.js — constrained Delaunay triangulation.
//
// The triangulation backbone for the proper Loop-Blinn fill (p1000-loop §3.1):
// triangulate ALL control points (on-curve + off-curve), PRESERVING the contour
// edges and the per-curve control triangles as constraints, then the caller
// removes triangles whose centroid is outside the fill (winding test) — which is
// how holes are handled with no coverage buffer and no hole tessellation.
//
// Algorithm: Bowyer-Watson incremental Delaunay over a super-triangle, then
// Sloan-style constrained edge recovery by EDGE FLIPS — for each missing
// constraint, WALK the mesh from an endpoint to collect the edges its segment
// crosses (O(crossed), falling back to an exhaustive scan only on a degenerate
// walk), then flip them off a queue until the constraint edge appears — then an
// incremental Lawson sweep restores Delaunay everywhere except across constraints.
// A single edge→triangle map is built once and patched in O(1) per flip (shared
// by both phases); constraint recovery also patches a vertex→triangle map for the
// walk. This keeps the two flip phases near-linear in the flip count instead of
// rebuilding adjacency per iteration. Robust for design-space (fixed-point)
// glyph/icon control points; near-degenerate inputs the caller can fall back to
// the Slug path.
//
// Points are [x, y]. Returns { tris: Array<[i,j,k]> (CCW) }.
//
// Orientation AND the in-circle test are computed with EXACT-sign predicates
// (predicates.js) so both signs are always correct — near-degenerate inputs
// can flip the sign of a plain double determinant, which causes the
// "8's waist" cavity livelock, the earcut "wrong wedges", and near-cocircular
// Delaunay churn. There is no epsilon anywhere in the triangulation: every
// orientation / crossing / empty-circle decision is exact-zero.
import { orient2d, incircle, orient2dXY, incircleXY } from './predicates.js';

// Do open segments p1p2 and p3p4 properly cross (interiors intersect)? Exact:
// both endpoint pairs must strictly straddle. Collinear or endpoint-touching
// configurations are NOT proper crossings (orient2d returns exactly 0 there).
function segsCross(p1, p2, p3, p4) {
  const d1 = orient2d(p3, p4, p1), d2 = orient2d(p3, p4, p2);
  const d3 = orient2d(p1, p2, p3), d4 = orient2d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

const edgeKey = (a, b) => a < b ? a * 4294967296 + b : b * 4294967296 + a;

// Normalize a triangle's vertex order to CCW.
function ccw(pts, a, b, c) {
  return orient2d(pts[a], pts[b], pts[c]) < 0 ? [a, c, b] : [a, b, c];
}

// Build a Delaunay triangulation of `pts` (array of [x,y]) via Bowyer-Watson.
// Returns an array of triangles [i,j,k] (indices into pts), CCW, super-triangle
// verts excluded. Returns null if degenerate (all collinear / <3 points).
//
// FLAT INTERNALS. This is the build's hot loop, and it was allocation-bound rather than
// arithmetic-bound: `Array<[x,y]>` points, `Array<[i,j,k]>` triangles, a `Map` edge→triangle
// index keyed by a float-packed edgeKey, a `Set` for the cavity, and — worst — TWO fresh `Map`s
// plus a `[u,v]` pair per POINT INSERTION. Measured against an identical-algorithm flat rewrite
// (probes/_wasmCdtBench.mjs): 3.0x, flat across 500/2000/8000 points. So everything below lives
// in typed arrays that are allocated once per call and reused across insertions.
//
// The public shape (Array<[x,y]> in, Array<[i,j,k]> out) is unchanged — the rest of cdt.js and
// its callers still speak the old idiom, and delaunay's `em` was always private to it.
//
// OUTPUT IS BIT-IDENTICAL to the pointer-chasing version, order included. That is not incidental:
// the tie-breaks depend on bookkeeping order that has nothing to do with the math, so the flat
// structures must reproduce it exactly or the mesh silently changes —
//   * `edges`: per-edge push order + swap-pop removal, since that decides what nbr() returns;
//   * `bad`/`stack`: LIFO flood-fill order;
//   * `touch`: the old `firstE` Map's first-seen insertion order, which sets retriangulation
//     order and hence `lastT` (the next walk's seed).
// probes/_lbCdtGolden.mjs is the regression gate.
function delaunay(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const dx = maxX - minX || 1, dy = maxY - minY || 1, dm = Math.max(dx, dy) * 20;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  // Super-triangle vertices appended at indices n, n+1, n+2.
  const np = n + 3;
  const PX = new Float64Array(np), PY = new Float64Array(np);
  for (let i = 0; i < n; i++) { const p = pts[i]; PX[i] = p[0]; PY[i] = p[1]; }
  PX[n] = cx - dm; PY[n] = cy - dm;
  PX[n + 1] = cx + dm; PY[n + 1] = cy - dm;
  PX[n + 2] = cx; PY[n + 2] = cy + dm;

  // Triangle slots: TRI[3t..3t+2], with TRI[3t] === -1 marking a free/null slot (the old
  // `tris[t] = null`). `triLen` mirrors the old `tris.length`; freed slots are recycled so
  // indices stay stable for the edge table.
  let triCap = 2 * np + 64;
  let TRI = new Int32Array(triCap * 3);
  let triLen = 1;
  TRI[0] = n; TRI[1] = n + 1; TRI[2] = n + 2;

  // Edge → incident triangles, open-addressed on the (lo,hi) vertex pair. Capacity is sized for
  // every DISTINCT edge the run will ever touch (entries are never deleted — see below), which is
  // O(n) for a Delaunay build; grow-and-rehash covers the tail.
  let eCap = 1; while (eCap < 8 * np) eCap *= 2;
  let eMask = eCap - 1;
  let EA = new Int32Array(eCap).fill(-1);   // -1 = empty slot
  let EB = new Int32Array(eCap);
  let EN = new Int32Array(eCap);            // how many triangles on this edge (0..2)
  let ET = new Int32Array(eCap * 2);        // the (up to 2) triangle ids, in push order
  let eUsed = 0;                            // occupied slots — drives the rehash
  // Deletion is deliberately absent. The old code did `em.delete(k)` once an edge's array went
  // empty, so a later `em.get(k)` returned undefined and nbr() answered -1. Leaving the entry
  // with EN === 0 answers -1 identically, and a later re-add starts from count 0 exactly as a
  // fresh array would — so the observable behaviour matches without tombstones.
  //
  // Because nothing is deleted, the table accumulates every edge the run ever touches, so it
  // MUST be able to grow: a full table would make the probe loop below spin forever. The rehash
  // drops EN === 0 entries (semantically absent anyway), which is what keeps it bounded.
  const growEdges = () => {
    const oA = EA, oB = EB, oN = EN, oT = ET, oCap = eCap;
    eCap *= 2; eMask = eCap - 1;
    EA = new Int32Array(eCap).fill(-1); EB = new Int32Array(eCap);
    EN = new Int32Array(eCap); ET = new Int32Array(eCap * 2); eUsed = 0;
    for (let s = 0; s < oCap; s++) {
      if (oA[s] === -1 || oN[s] === 0) continue;
      const lo = oA[s], hi = oB[s];
      let i = ((lo * 0x9E3779B1 ^ hi * 0x85EBCA77) >>> 0) & eMask;
      while (EA[i] !== -1) i = (i + 1) & eMask;
      EA[i] = lo; EB[i] = hi; EN[i] = oN[s]; ET[i * 2] = oT[s * 2]; ET[i * 2 + 1] = oT[s * 2 + 1];
      eUsed++;
    }
  };
  const eSlot = (a, b) => {
    const lo = a < b ? a : b, hi = a < b ? b : a;
    for (;;) {
      let i = ((lo * 0x9E3779B1 ^ hi * 0x85EBCA77) >>> 0) & eMask;
      for (;;) {
        const ka = EA[i];
        if (ka === -1) {
          if (++eUsed * 2 >= eCap) { eUsed--; growEdges(); break; }   // rehash, then re-probe
          EA[i] = lo; EB[i] = hi; return i;
        }
        if (ka === lo && EB[i] === hi) return i;
        i = (i + 1) & eMask;
      }
    }
  };
  const addTE = (a, b, t) => { const i = eSlot(a, b); if (EN[i] < 2) ET[i * 2 + EN[i]] = t; EN[i]++; };
  const remTE = (a, b, t) => {                       // mirrors indexOf + swap-pop + delete-if-empty
    const i = eSlot(a, b), c = EN[i];
    if (c === 0) return;
    if (ET[i * 2] === t) { if (c > 1) ET[i * 2] = ET[i * 2 + 1]; EN[i] = c - 1; }
    else if (c > 1 && ET[i * 2 + 1] === t) { EN[i] = c - 1; }
  };
  const nbr = (u, v, t) => {                         // a[0]===t ? (a[1] ?? -1) : a[0]
    const i = eSlot(u, v), c = EN[i];
    if (c === 0) return -1;
    return ET[i * 2] === t ? (c > 1 ? ET[i * 2 + 1] : -1) : ET[i * 2];
  };
  addTE(n, n + 1, 0); addTE(n + 1, n + 2, 0); addTE(n + 2, n, 0);

  let FREE = new Int32Array(triCap); let freeLen = 0;
  let lastT = 0;

  // Cavity scratch, allocated once. `badStamp` replaces the per-insertion `Set`: a generation
  // counter makes "clear" free.
  let bad = new Int32Array(256), stack = new Int32Array(256);
  let badStamp = new Int32Array(triCap); let gen = 0;
  // Everything indexed by triangle slot grows together, or a slot id outruns its side table.
  const growTris = () => {
    triCap *= 2;
    const T = new Int32Array(triCap * 3); T.set(TRI); TRI = T;
    const F = new Int32Array(triCap); F.set(FREE); FREE = F;
    const B = new Int32Array(triCap); B.set(badStamp); badStamp = B;
  };

  // Per-insertion cavity-boundary tally — the old `count`/`firstE` Maps. Same open-addressed
  // pair table, stamped by generation instead of reallocated, plus `touch` recording first-seen
  // slot order so the retriangulation loop iterates exactly as Map insertion order did.
  let cCap = 256, cMask = cCap - 1;
  let CA = new Int32Array(cCap), CB = new Int32Array(cCap), CS = new Int32Array(cCap).fill(-1),
      CC = new Int32Array(cCap), CU = new Int32Array(cCap), CV = new Int32Array(cCap);
  let touch = new Int32Array(256), touchLen = 0;
  // A cavity has at most 3*badLen distinct boundary edges. Sizing to >= 4x that keeps the load
  // factor under 1/2 — necessary, because a full gen-stamped table has no empty slot to stop the
  // probe. Called after the flood fill (badLen known) and before the tally, so nothing is live:
  // the arrays can simply be replaced rather than rehashed.
  const ensureCavityCap = (badLen) => {
    const need = 8 * badLen;
    if (cCap >= need) return;
    while (cCap < need) cCap *= 2;
    cMask = cCap - 1;
    CA = new Int32Array(cCap); CB = new Int32Array(cCap); CS = new Int32Array(cCap).fill(-1);
    CC = new Int32Array(cCap); CU = new Int32Array(cCap); CV = new Int32Array(cCap);
  };
  const cSlot = (a, b) => {
    const lo = a < b ? a : b, hi = a < b ? b : a;
    let i = ((lo * 0x9E3779B1 ^ hi * 0x85EBCA77) >>> 0) & cMask;
    for (;;) {
      if (CS[i] !== gen) { CS[i] = gen; CA[i] = lo; CB[i] = hi; CC[i] = 0; return i; }
      if (CA[i] === lo && CB[i] === hi) return i;
      i = (i + 1) & cMask;
    }
  };

  for (let ip = 0; ip < n; ip++) {
    const px = PX[ip], py = PY[ip];
    // Locate a triangle containing p by a straight walk (guarded against cycles).
    let t = lastT;
    if (TRI[t * 3] === -1) { t = -1; for (let s = 0; s < triLen; s++) if (TRI[s * 3] !== -1) { t = s; break; } if (t < 0) continue; }
    let g = 0; const gMax = triLen + 64;
    while (g++ < gMax) {
      const a = TRI[t * 3], b = TRI[t * 3 + 1], c = TRI[t * 3 + 2];
      if (orient2dXY(PX[a], PY[a], PX[b], PY[b], px, py) < 0) { const nb = nbr(a, b, t); if (nb < 0) break; t = nb; continue; }
      if (orient2dXY(PX[b], PY[b], PX[c], PY[c], px, py) < 0) { const nb = nbr(b, c, t); if (nb < 0) break; t = nb; continue; }
      if (orient2dXY(PX[c], PY[c], PX[a], PY[a], px, py) < 0) { const nb = nbr(c, a, t); if (nb < 0) break; t = nb; continue; }
      break;   // p is inside T (or on its boundary)
    }
    if (TRI[t * 3] === -1) continue;
    {
      const a = TRI[t * 3], b = TRI[t * 3 + 1], c = TRI[t * 3 + 2];
      if (incircleXY(PX[a], PY[a], PX[b], PY[b], PX[c], PY[c], px, py) <= 0) continue;   // degenerate / duplicate → skip
    }
    // Flood the cavity of triangles whose circumcircle contains p.
    gen++;
    let badLen = 0, stackLen = 0;
    bad[badLen++] = t; badStamp[t] = gen; stack[stackLen++] = t;
    while (stackLen) {
      const bt = stack[--stackLen];
      for (let e = 0; e < 3; e++) {
        const nb = nbr(TRI[bt * 3 + e], TRI[bt * 3 + (e + 1) % 3], bt);
        if (nb < 0 || badStamp[nb] === gen) continue;
        const a = TRI[nb * 3], b = TRI[nb * 3 + 1], c = TRI[nb * 3 + 2];
        if (incircleXY(PX[a], PY[a], PX[b], PY[b], PX[c], PY[c], px, py) > 0) {
          badStamp[nb] = gen;
          if (badLen === bad.length) { const B = new Int32Array(badLen * 2); B.set(bad); bad = B; }
          bad[badLen++] = nb;
          if (stackLen === stack.length) { const S = new Int32Array(stackLen * 2); S.set(stack); stack = S; }
          stack[stackLen++] = nb;
        }
      }
    }
    // Cavity boundary = edges used by exactly one bad triangle.
    ensureCavityCap(badLen);
    touchLen = 0;
    for (let bi = 0; bi < badLen; bi++) {
      const bt = bad[bi];
      for (let e = 0; e < 3; e++) {
        const u = TRI[bt * 3 + e], v = TRI[bt * 3 + (e + 1) % 3];
        const i = cSlot(u, v);
        if (CC[i] === 0) { CU[i] = u; CV[i] = v;                       // first-seen wins, as firstE did
          if (touchLen === touch.length) { const T2 = new Int32Array(touchLen * 2); T2.set(touch); touch = T2; }
          touch[touchLen++] = i; }
        CC[i]++;
      }
    }
    for (let bi = 0; bi < badLen; bi++) {
      const bt = bad[bi];
      for (let e = 0; e < 3; e++) remTE(TRI[bt * 3 + e], TRI[bt * 3 + (e + 1) % 3], bt);
      TRI[bt * 3] = -1; FREE[freeLen++] = bt;
    }
    for (let ti = 0; ti < touchLen; ti++) {
      const i = touch[ti];
      if (CC[i] !== 1) continue;
      let nt;
      if (freeLen) nt = FREE[--freeLen];
      else { if (triLen === triCap) growTris(); nt = triLen++; }
      // ccw(): orient the new triangle, writing straight into the slot.
      const u = CU[i], v = CV[i];
      let a = u, b = v, c = ip;
      if (orient2dXY(PX[u], PY[u], PX[v], PY[v], PX[ip], PY[ip]) < 0) { b = ip; c = v; }
      TRI[nt * 3] = a; TRI[nt * 3 + 1] = b; TRI[nt * 3 + 2] = c;
      addTE(a, b, nt); addTE(b, c, nt); addTE(c, a, nt);
      lastT = nt;
    }
  }
  // Drop triangles touching the super-triangle (all already CCW).
  const out = [];
  for (let t = 0; t < triLen; t++) {
    const a = TRI[t * 3];
    if (a === -1) continue;
    const b = TRI[t * 3 + 1], c = TRI[t * 3 + 2];
    if (a < n && b < n && c < n) out.push([a, b, c]);
  }
  return out;
}

// Map every interior edge → the (exactly two) triangles sharing it.
// Boundary edges (one triangle) and any non-manifold edge are also present but
// the callers only act on length-2 entries. Deleted (null) triangles skipped.
// Maintained INCREMENTALLY across flips (edgeAssign/edgeRemove/flip) so neither
// constraint insertion nor Delaunay restoration ever rebuilds it — the whole map
// is O(V) to build once and O(1) to update per flip.
function edgeMap(tris) {
  const em = new Map();
  for (let t = 0; t < tris.length; t++) {
    const T = tris[t];
    if (!T) continue;
    for (let e = 0; e < 3; e++) {
      const k = edgeKey(T[e], T[(e + 1) % 3]);
      let a = em.get(k);
      if (!a) { a = []; em.set(k, a); }
      a.push(t);
    }
  }
  return em;
}
// Decode an edgeKey back to its two vertex indices.
const KHI = 4294967296;
function edgeVerts(k) { const hi = Math.floor(k / KHI); return [hi, k - hi * KHI]; }
// Incremental adjacency mutators. edgeReassign swaps the triangle owning an edge
// (a flip re-parents two of the quad's rim edges); edgeRemove drops the old
// diagonal; edgeAdd registers the new one.
function edgeReassign(em, k, told, tnew) { const a = em.get(k); if (!a) return; for (let i = 0; i < a.length; i++) if (a[i] === told) { a[i] = tnew; return; } }
function edgeRemove(em, k) { em.delete(k); }
function edgeAdd(em, k, t) { let a = em.get(k); if (!a) { a = []; em.set(k, a); } a.push(t); }
// Vertex → incident-triangle adjacency (optional; only insertConstraints needs it,
// for the segment walk). Maintained incrementally alongside `em` in flip().
function vtRemove(vt, vert, t) { const a = vt[vert]; if (!a) return; for (let i = 0; i < a.length; i++) if (a[i] === t) { a[i] = a[a.length - 1]; a.pop(); return; } }
function vtAdd(vt, vert, t) { vt[vert].push(t); }

const third = (T, u, v) => T[0] !== u && T[0] !== v ? T[0] : (T[1] !== u && T[1] !== v ? T[1] : T[2]);

// Flip the interior edge (u,v) shared by tris[t1],tris[t2] to the other diagonal
// (w,x) of their quad. w,x = the two off-edge vertices. Rewrites both triangles
// in place (CCW) AND patches the incremental edge map `em` in O(1): the old
// diagonal (u,v) disappears, the new diagonal (w,x) appears, and the two rim
// edges (v,w)/(x,u) change which of t1,t2 owns them. When `vt` (vertex→triangle)
// is supplied it's patched too: t1 loses v gains x, t2 loses u gains w. Assumes
// the quad u-w-v-x is convex (caller checks segsCross).
function flip(em, pts, tris, t1, t2, u, v, vt) {
  const w = third(tris[t1], u, v), x = third(tris[t2], u, v);
  edgeRemove(em, edgeKey(u, v));
  edgeReassign(em, edgeKey(v, w), t1, t2);
  edgeReassign(em, edgeKey(x, u), t2, t1);
  tris[t1] = ccw(pts, u, w, x);
  tris[t2] = ccw(pts, w, v, x);
  edgeAdd(em, edgeKey(w, x), t1);
  edgeAdd(em, edgeKey(w, x), t2);
  if (vt) { vtRemove(vt, v, t1); vtAdd(vt, x, t1); vtRemove(vt, u, t2); vtAdd(vt, w, t2); }
}

// Collect the edges that segment (ca→cb) properly crosses by WALKING the mesh:
// find the triangle in ca's fan the segment enters, then march triangle-to-
// triangle across each exit edge until cb's triangle. Returns the crossed edge
// keys in order, or null on any ambiguity (segment through a vertex, boundary,
// non-convergence) so the caller can fall back to the exhaustive scan. O(crossed)
// instead of O(edges), which is the whole point.
function walkCrossings(ca, cb, pts, tris, em, vt) {
  const pa = pts[ca], pb = pts[cb], fan = vt[ca];
  if (!fan || !fan.length) return null;
  let curT = -1, u = -1, v = -1;
  for (const t of fan) {
    const T = tris[t]; if (!T) continue;
    let o1 = -1, o2 = -1;
    for (const z of T) if (z !== ca) { if (o1 < 0) o1 = z; else o2 = z; }
    if (o1 === cb || o2 === cb) return [];                     // ca-cb already this tri's edge
    if (segsCross(pa, pb, pts[o1], pts[o2])) { curT = t; u = o1; v = o2; break; }
  }
  if (curT < 0) return null;
  const crossings = [];
  const maxSteps = tris.length + 8;
  for (let s = 0; s < maxSteps; s++) {
    crossings.push(edgeKey(u, v));
    const ts = em.get(edgeKey(u, v));
    if (!ts || ts.length !== 2) return null;                   // boundary edge → ambiguous
    const tn = ts[0] === curT ? ts[1] : ts[0];
    const wv = third(tris[tn], u, v);
    if (wv === cb) return crossings;                           // reached cb's triangle
    const cw = segsCross(pa, pb, pts[u], pts[wv]);
    const cv = segsCross(pa, pb, pts[v], pts[wv]);
    if (cw === cv) return null;                                // through a vertex / neither → ambiguous
    curT = tn; if (cw) v = wv; else u = wv;                    // exit edge (u,wv) or (v,wv)
  }
  return null;
}

// Recover each constraint edge by flipping crossing edges (Sloan). For a missing
// constraint (ca,cb): collect the set of triangulation edges its segment properly
// crosses ONCE, then flip them off a work queue — each flip either removes the
// crossing (its new diagonal no longer meets the segment) or replaces it with a
// new crossing, which goes back on the queue. Non-convex quads are deferred (their
// diagonal doesn't cross yet); at least one crossing edge is always convex so this
// drains. A constraint that can't clear (its crossings include another constraint)
// is left absent. Adjacency `em` is maintained incrementally by flip() — no per-
// iteration rebuild or full-triangle present scan.

// CAVITY-RETRIANGULATION FALLBACK: flip recovery can livelock when every crossed
// edge's quad is non-convex (mutually-blocked defers — the 8's waist chord stalled
// this way and the torn sliver rendered as a dead stripe). The robust classical
// insertion: delete the corridor of triangles the open segment crosses, then
// ear-clip the two boundary chains against the constraint edge. Rare path; O(n)
// scan + tiny polygon clip. Returns false (mesh untouched) on any ambiguity.
function cavityInsert(pts, tris, em, vt, ca, cb) {
  const pa = pts[ca], pb = pts[cb];
  const crossed = [];
  for (let t = 0; t < tris.length; t++) {
    const T = tris[t]; if (!T) continue;
    const hasA = T[0] === ca || T[1] === ca || T[2] === ca;
    const hasB = T[0] === cb || T[1] === cb || T[2] === cb;
    if (hasA && hasB) return false;                      // already an edge? caller checks; bail
    if (hasA || hasB) {
      const o = T.filter(z => z !== ca && z !== cb);
      if (o.length === 2 && segsCross(pa, pb, pts[o[0]], pts[o[1]])) crossed.push(t);
      continue;
    }
    if (segsCross(pa, pb, pts[T[0]], pts[T[1]]) || segsCross(pa, pb, pts[T[1]], pts[T[2]]) || segsCross(pa, pb, pts[T[2]], pts[T[0]])) crossed.push(t);
  }
  if (!crossed.length) return false;
  const inCav = new Set(crossed);
  const bEdges = [];
  for (const t of crossed) {
    const T = tris[t];
    for (let e = 0; e < 3; e++) {
      const u = T[e], v = T[(e + 1) % 3];
      const owners = em.get(edgeKey(u, v)) || [];
      let cnt = 0; for (const ot of owners) if (inCav.has(ot)) cnt++;
      if (cnt === 1) bEdges.push([u, v]);
    }
  }
  // boundary must form one closed loop through ca and cb
  const adj = new Map();
  const link = (u, v) => { let l = adj.get(u); if (!l) adj.set(u, l = []); l.push(v); };
  for (const [u, v] of bEdges) { link(u, v); link(v, u); }
  if (!adj.has(ca) || !adj.has(cb)) return false;
  for (const [, l] of adj) if (l.length !== 2) return false;   // non-manifold cavity → bail
  const chainFrom = (first) => {
    const chain = [ca, first];
    let prev = ca, cur = first, guard = bEdges.length + 4;
    while (cur !== cb && guard-- > 0) {
      const l = adj.get(cur);
      const nxt = l[0] === prev ? l[1] : l[0];
      chain.push(nxt); prev = cur; cur = nxt;
    }
    return cur === cb ? chain : null;
  };
  const [n1, n2] = adj.get(ca);
  const chainL = chainFrom(n1), chainR = chainFrom(n2);
  if (!chainL || !chainR) return false;
  // remove crossed tris from em/vt/tris
  for (const t of crossed) {
    const T = tris[t];
    for (let e = 0; e < 3; e++) {
      const k = edgeKey(T[e], T[(e + 1) % 3]);
      const owners = em.get(k);
      if (owners) { const i = owners.indexOf(t); if (i >= 0) { owners[i] = owners[owners.length - 1]; owners.pop(); } if (!owners.length) em.delete(k); }
    }
    if (vt) { vtRemove(vt, T[0], t); vtRemove(vt, T[1], t); vtRemove(vt, T[2], t); }
    tris[t] = null;
  }
  const emit = (a, b, c) => {
    const nt = tris.length;
    tris.push(ccw(pts, a, b, c));
    const T = tris[nt];
    edgeAdd(em, edgeKey(T[0], T[1]), nt); edgeAdd(em, edgeKey(T[1], T[2]), nt); edgeAdd(em, edgeKey(T[2], T[0]), nt);
    if (vt) { vtAdd(vt, T[0], nt); vtAdd(vt, T[1], nt); vtAdd(vt, T[2], nt); }
  };
  // ear-clip a chain polygon [ca, ..., cb] closed by the constraint edge
  const clip = (poly) => {
    const idx = poly.slice();
    let guard = idx.length * idx.length + 8;
    while (idx.length > 3 && guard-- > 0) {
      let clipped = false;
      for (let i = 0; i < idx.length; i++) {
        const A = idx[(i + idx.length - 1) % idx.length], B = idx[i], C = idx[(i + 1) % idx.length];
        const ax = pts[A][0], ay = pts[A][1], bx = pts[B][0], by = pts[B][1], cx = pts[C][0], cy = pts[C][1];
        const ar = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (ar <= 0) continue;                                  // reflex/degenerate for this orientation
        let ok = true;
        for (const D of idx) {
          if (D === A || D === B || D === C) continue;
          const dx = pts[D][0], dy = pts[D][1];
          const s1 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
          const s2 = (cx - bx) * (dy - by) - (cy - by) * (dx - bx);
          const s3 = (ax - cx) * (dy - cy) - (ay - cy) * (dx - cx);
          if (s1 >= 0 && s2 >= 0 && s3 >= 0) { ok = false; break; }
        }
        if (!ok) continue;
        emit(A, B, C);
        idx.splice(i, 1);
        clipped = true;
        break;
      }
      if (!clipped) return false;                               // stuck (shouldn't happen on simple polys)
    }
    if (idx.length === 3) emit(idx[0], idx[1], idx[2]);
    return true;
  };
  // orient each chain CCW (signed area of the closed polygon)
  const orientPoly = (poly) => {
    let a2 = 0;
    for (let i = 0; i < poly.length; i++) { const P = pts[poly[i]], Q = pts[poly[(i + 1) % poly.length]]; a2 += P[0] * Q[1] - Q[0] * P[1]; }
    return a2 > 0 ? poly : poly.slice().reverse();
  };
  if (!clip(orientPoly(chainL))) return false;
  if (!clip(orientPoly(chainR))) return false;
  return true;
}
function insertConstraints(pts, tris, constraints, em) {
  const constraintSet = new Set();
  for (const [a, b] of constraints) if (a !== b) constraintSet.add(edgeKey(a, b));

  // vertex → incident triangles, for the walk (patched by flip via `vt`).
  const vt = new Array(pts.length);
  for (let i = 0; i < vt.length; i++) vt[i] = [];
  for (let t = 0; t < tris.length; t++) { const T = tris[t]; if (T) { vt[T[0]].push(t); vt[T[1]].push(t); vt[T[2]].push(t); } }

  for (let ci9 = 0; ci9 < constraints.length; ci9++) {
    const ca = constraints[ci9][0], cb = constraints[ci9][1];
    if (ca === cb) continue;
    const ck = edgeKey(ca, cb);
    if (em.has(ck)) continue;
    const pa = pts[ca], pb = pts[cb];
    // Seed the flip queue with the edges the constraint crosses. Walk first
    // (O(crossed)); fall back to the exhaustive edge scan only if the walk hits an
    // ambiguity, so degenerate inputs stay as robust as before.
    let queue = walkCrossings(ca, cb, pts, tris, em, vt);
    if (queue === null) {
      queue = [];
      for (const [k, ts] of em) {
        if (ts.length !== 2 || constraintSet.has(k)) continue;
        const [u, v] = edgeVerts(k);
        if (u === ca || u === cb || v === ca || v === cb) continue;
        if (segsCross(pa, pb, pts[u], pts[v])) queue.push(k);
      }
    }
    let guard = 0;
    const maxG = queue.length * 24 + 512;
    let head = 0;
    while (head < queue.length && guard++ < maxG) {
      const k = queue[head++];
      const ts = em.get(k);
      if (!ts || ts.length !== 2 || constraintSet.has(k)) continue;    // flipped away / not flippable
      const [u, v] = edgeVerts(k);
      if (!segsCross(pa, pb, pts[u], pts[v])) continue;                // no longer crosses
      const t1 = ts[0], t2 = ts[1];
      const w = third(tris[t1], u, v), x = third(tris[t2], u, v);
      if (!segsCross(pts[u], pts[v], pts[w], pts[x])) { queue.push(k); continue; }  // non-convex → defer
      flip(em, pts, tris, t1, t2, u, v, vt);
      const nk = edgeKey(w, x);
      if (nk !== ck && !constraintSet.has(nk) && segsCross(pa, pb, pts[w], pts[x])) queue.push(nk);
    }
    if (!em.has(ck)) {
      // THROUGH-A-VERTEX: a constraint collinear with an intermediate vertex can never
      // appear as a single edge — no triangle edge properly crosses it either (the
      // cavity collector finds nothing). Split at the on-segment vertex and process
      // both halves in this same pass (for-of sees pushed items).
      let split9 = false;
      const rx9 = pb[0] - pa[0], ry9 = pb[1] - pa[1], L29 = rx9 * rx9 + ry9 * ry9;
      if (L29 > 0) for (let v9 = 0; v9 < pts.length; v9++) {
        if (v9 === ca || v9 === cb) continue;
        const px9 = pts[v9][0] - pa[0], py9 = pts[v9][1] - pa[1];
        const t9 = (px9 * rx9 + py9 * ry9) / L29;
        if (t9 <= 1e-9 || t9 >= 1 - 1e-9) continue;
        const cr9 = px9 * ry9 - py9 * rx9;
        // generous on-segment tolerance (dist < 1e-3·|seg|): a razor quad's ctrl vertex
        // can sit ~1e-5 em off its own chord — splitting at a near-line vertex is always
        // topologically valid (the boundary polyline kinks by the offset, sub-visible).
        if (cr9 * cr9 > 1e-6 * L29 * L29) continue;
        constraints[ci9] = [ca, v9];   // REPLACE in place: the un-insertable original must
        constraints.push([v9, cb]);    // not linger (the post-CDT audit would re-split it forever)
        constraintSet.delete(ck);
        constraintSet.add(edgeKey(ca, v9)); constraintSet.add(edgeKey(v9, cb));
        split9 = true;
        break;
      }
      if (!split9) cavityInsert(pts, tris, em, vt, ca, cb);
      else ci9--;   // reprocess the replaced first half now
    }
  }
  return constraintSet;
}

// Restore the Delaunay property everywhere except across constraints, via the
// incremental Lawson flip: seed a stack with every edge, and whenever an edge's
// opposite vertex violates the empty-circle test (and its quad is convex, and it
// isn't a constraint) flip it and re-queue the quad's four rim edges. Converges
// with no per-pass edgeMap rebuild — `em` is patched in place by flip().
function restoreDelaunay(pts, tris, constraintSet, em) {
  const stack = [], inStack = new Set();
  const push = (k) => { if (!inStack.has(k)) { inStack.add(k); stack.push(k); } };
  for (const k of em.keys()) push(k);
  let guard = 0;
  const maxG = em.size * 40 + 1024;
  while (stack.length && guard++ < maxG) {
    const k = stack.pop(); inStack.delete(k);
    const ts = em.get(k);
    if (!ts || ts.length !== 2 || constraintSet.has(k)) continue;
    const [u, v] = edgeVerts(k);
    const t1 = ts[0], t2 = ts[1];
    const w = third(tris[t1], u, v), x = third(tris[t2], u, v);
    if (!segsCross(pts[u], pts[v], pts[w], pts[x])) continue;   // non-convex → can't flip
    const T = ccw(pts, u, v, w);
    if (incircle(pts[T[0]], pts[T[1]], pts[T[2]], pts[x]) > 0) {
      flip(em, pts, tris, t1, t2, u, v);
      push(edgeKey(u, w)); push(edgeKey(w, v)); push(edgeKey(v, x)); push(edgeKey(x, u));
    }
  }
}

// Intersection point of open segments p1p2 and p3p4 (double), or null if parallel
// or the crossing is not in both interiors. Paired with the exact segsCross test.
function segIntersect(p1, p2, p3, p4) {
  const rx = p2[0] - p1[0], ry = p2[1] - p1[1];
  const sx = p4[0] - p3[0], sy = p4[1] - p3[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;                   // parallel / degenerate
  const qx = p3[0] - p1[0], qy = p3[1] - p1[1];
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null;
  return [p1[0] + t * rx, p1[1] + t * ry];
}

/**
 * Resolve pairwise-crossing constraints (CGAL `Exact_intersections_tag` behaviour):
 * insert a shared vertex at each proper crossing and split BOTH constraints there,
 * so the returned set has NO properly-crossing constraints. Intersection coordinates
 * are computed in double (a consistent snap, as CGAL's non-exact-construction modes
 * do); the exact-predicate pipeline then triangulates the augmented set robustly.
 * O(C²) pairwise — fine at glyph/path constraint counts. Lets self-intersecting
 * outlines (figure-eight subpaths, stroke-to-fill overlaps) triangulate as one exact
 * planar subdivision instead of routing to the Slug fallback.
 *   @returns an object with the augmented `pts` (Array<[x,y]>) and crossing-free
 *            `constraints` (Array<[i,j]>).
 */
export function resolveConstraintIntersections(pts, constraints) {
  const P = pts.map((p) => [p[0], p[1]]);
  const cons = (constraints || []).map((c) => [c[0], c[1]]).filter((c) => c[0] !== c[1]);
  const splits = cons.map(() => []);                          // per-constraint [{t, vi}]
  const findOrAdd = (x, y) => {                               // dedup coincident crossings
    for (let i = 0; i < P.length; i++) { const dx = P[i][0] - x, dy = P[i][1] - y; if (dx * dx + dy * dy < 1e-14) return i; }
    P.push([x, y]); return P.length - 1;
  };
  const paramOf = (c0, c1, vi) => { const rx = P[c1][0] - P[c0][0], ry = P[c1][1] - P[c0][1]; return ((P[vi][0] - P[c0][0]) * rx + (P[vi][1] - P[c0][1]) * ry) / Math.max(rx * rx + ry * ry, 1e-30); };
  for (let i = 0; i < cons.length; i++) {
    for (let j = i + 1; j < cons.length; j++) {
      const ai = cons[i][0], bi = cons[i][1], cj = cons[j][0], dj = cons[j][1];
      if (ai === cj || ai === dj || bi === cj || bi === dj) continue;   // shared endpoint → not a proper cross
      if (!segsCross(P[ai], P[bi], P[cj], P[dj])) continue;             // exact proper-cross test
      const it = segIntersect(P[ai], P[bi], P[cj], P[dj]);
      if (!it) continue;
      const vi = findOrAdd(it[0], it[1]);
      if (vi !== ai && vi !== bi) splits[i].push({ t: paramOf(ai, bi, vi), vi });
      if (vi !== cj && vi !== dj) splits[j].push({ t: paramOf(cj, dj, vi), vi });
    }
  }
  const out = [];
  for (let i = 0; i < cons.length; i++) {
    if (!splits[i].length) { out.push(cons[i]); continue; }
    splits[i].sort((a, b) => a.t - b.t);
    let prev = cons[i][0];
    for (const s of splits[i]) { if (s.vi !== prev) out.push([prev, s.vi]); prev = s.vi; }
    if (cons[i][1] !== prev) out.push([prev, cons[i][1]]);
  }
  return { pts: P, constraints: out };
}

/**
 * Constrained Delaunay triangulation.
 *   @param pts          Array<[x,y]> — all vertices (deduped by the caller ideally)
 *   @param constraints  Array<[i,j]> — edges that MUST appear (contour + curve tris)
 *   @param opts         optional; opts.resolveIntersections splits crossing
 *                       constraints at their intersection first (G4).
 *   @returns an object with `tris` (Array of CCW [i,j,k]) and the vertex list `pts`
 *            the tris index into (possibly augmented); null if degenerate.
 */
export function constrainedTriangulate(pts, constraints, opts) {
  let P = pts, C = constraints || [];
  if (opts && opts.resolveIntersections) { const r = resolveConstraintIntersections(pts, C); P = r.pts; C = r.constraints; }
  const base = delaunay(P);
  if (!base) return null;
  const em = edgeMap(base);                                   // built once, patched by flip()
  const constraintSet = insertConstraints(P, base, C, em);
  restoreDelaunay(P, base, constraintSet, em);
  return { tris: base.filter(Boolean), pts: P };
}

export { orient2d, incircle, segsCross };
