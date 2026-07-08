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

const EPS = 1e-9;

// Twice the signed area of triangle abc (>0 ⇒ CCW).
function orient2d(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

// >0 ⇒ d strictly inside the circumcircle of CCW triangle abc.
function inCircle(a, b, c, d) {
  const ax = a[0] - d[0], ay = a[1] - d[1];
  const bx = b[0] - d[0], by = b[1] - d[1];
  const cx = c[0] - d[0], cy = c[1] - d[1];
  const ad = ax * ax + ay * ay, bd = bx * bx + by * by, cd = cx * cx + cy * cy;
  return ax * (by * cd - bd * cy) - ay * (bx * cd - bd * cx) + ad * (bx * cy - by * cx);
}

// Do open segments p1p2 and p3p4 properly cross (interiors intersect)?
function segsCross(p1, p2, p3, p4) {
  const d1 = orient2d(p3, p4, p1), d2 = orient2d(p3, p4, p2);
  const d3 = orient2d(p1, p2, p3), d4 = orient2d(p1, p2, p4);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
         ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}

const edgeKey = (a, b) => a < b ? a * 4294967296 + b : b * 4294967296 + a;

// Normalize a triangle's vertex order to CCW.
function ccw(pts, a, b, c) {
  return orient2d(pts[a], pts[b], pts[c]) < 0 ? [a, c, b] : [a, b, c];
}

// Build a Delaunay triangulation of `pts` (array of [x,y]) via Bowyer-Watson.
// Returns an array of triangles [i,j,k] (indices into pts), CCW, super-triangle
// verts excluded. Returns null if degenerate (all collinear / <3 points).
function delaunay(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const dx = maxX - minX || 1, dy = maxY - minY || 1, dm = Math.max(dx, dy) * 20;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  // Super-triangle vertices appended at indices n, n+1, n+2.
  const P = pts.concat([[cx - dm, cy - dm], [cx + dm, cy - dm], [cx, cy + dm]]);
  // Incremental Bowyer-Watson: locate the containing triangle by WALKING from the
  // previous insertion (contour-order inputs are spatially coherent → short walks),
  // then FLOOD-FILL the bad-triangle cavity through edge adjacency instead of
  // scanning every triangle. `tris` reuses freed slots (indices stay stable for the
  // edge map); `em` (edge→triangles) is maintained in step. Triangles stay CCW.
  const tris = [[n, n + 1, n + 2]];
  const em = new Map();
  const addTE = (k, t) => { let a = em.get(k); if (!a) { a = []; em.set(k, a); } a.push(t); };
  const remTE = (k, t) => { const a = em.get(k); if (!a) return; const i = a.indexOf(t); if (i >= 0) { a[i] = a[a.length - 1]; a.pop(); } if (!a.length) em.delete(k); };
  const nbr = (u, v, t) => { const a = em.get(edgeKey(u, v)); if (!a) return -1; return a[0] === t ? (a.length > 1 ? a[1] : -1) : a[0]; };
  addTE(edgeKey(n, n + 1), 0); addTE(edgeKey(n + 1, n + 2), 0); addTE(edgeKey(n + 2, n), 0);
  const free = [];
  let lastT = 0;
  const bad = [], badSet = new Set(), stack = [];
  for (let ip = 0; ip < n; ip++) {
    const p = P[ip];
    // Locate a triangle containing p by a straight walk (guarded against cycles).
    let t = lastT; if (!tris[t]) t = tris.findIndex(Boolean);
    let g = 0; const gMax = tris.length + 64;
    while (g++ < gMax) {
      const T = tris[t]; const a = T[0], b = T[1], c = T[2];
      if (orient2d(P[a], P[b], p) < -EPS) { const nb = nbr(a, b, t); if (nb < 0) break; t = nb; continue; }
      if (orient2d(P[b], P[c], p) < -EPS) { const nb = nbr(b, c, t); if (nb < 0) break; t = nb; continue; }
      if (orient2d(P[c], P[a], p) < -EPS) { const nb = nbr(c, a, t); if (nb < 0) break; t = nb; continue; }
      break;   // p is inside T (or on its boundary)
    }
    const T0 = tris[t];
    if (!T0 || inCircle(P[T0[0]], P[T0[1]], P[T0[2]], p) <= EPS) continue;   // degenerate / duplicate → skip
    // Flood the cavity of triangles whose circumcircle contains p.
    bad.length = 0; badSet.clear(); stack.length = 0;
    bad.push(t); badSet.add(t); stack.push(t);
    while (stack.length) {
      const bt = stack.pop(), T = tris[bt];
      for (let e = 0; e < 3; e++) {
        const nb = nbr(T[e], T[(e + 1) % 3], bt);
        if (nb < 0 || badSet.has(nb)) continue;
        const N = tris[nb];
        if (inCircle(P[N[0]], P[N[1]], P[N[2]], p) > EPS) { badSet.add(nb); bad.push(nb); stack.push(nb); }
      }
    }
    // Cavity boundary = edges used by exactly one bad triangle.
    const count = new Map(), firstE = new Map();
    for (const bt of bad) { const T = tris[bt];
      for (let e = 0; e < 3; e++) { const u = T[e], v = T[(e + 1) % 3], k = edgeKey(u, v);
        count.set(k, (count.get(k) || 0) + 1); if (!firstE.has(k)) firstE.set(k, [u, v]); } }
    for (const bt of bad) { const T = tris[bt];
      for (let e = 0; e < 3; e++) remTE(edgeKey(T[e], T[(e + 1) % 3]), bt);
      tris[bt] = null; free.push(bt); }
    for (const [k, uv] of firstE) {
      if (count.get(k) !== 1) continue;
      const nt = free.length ? free.pop() : tris.push(null) - 1;
      tris[nt] = ccw(P, uv[0], uv[1], ip);
      const T = tris[nt];
      addTE(edgeKey(T[0], T[1]), nt); addTE(edgeKey(T[1], T[2]), nt); addTE(edgeKey(T[2], T[0]), nt);
      lastT = nt;
    }
  }
  // Drop triangles touching the super-triangle (all already CCW).
  const out = [];
  for (const T of tris) if (T && T[0] < n && T[1] < n && T[2] < n) out.push(T);
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
    if (inCircle(pts[T[0]], pts[T[1]], pts[T[2]], pts[x]) > EPS) {
      flip(em, pts, tris, t1, t2, u, v);
      push(edgeKey(u, w)); push(edgeKey(w, v)); push(edgeKey(v, x)); push(edgeKey(x, u));
    }
  }
}

/**
 * Constrained Delaunay triangulation.
 *   @param pts          Array<[x,y]> — all vertices (deduped by the caller ideally)
 *   @param constraints  Array<[i,j]> — edges that MUST appear (contour + curve tris)
 *   @returns tris — Array of CCW [i,j,k] index triples, or null if degenerate.
 */
export function constrainedTriangulate(pts, constraints) {
  const base = delaunay(pts);
  if (!base) return null;
  const em = edgeMap(base);                                   // built once, patched by flip()
  const constraintSet = insertConstraints(pts, base, constraints || [], em);
  restoreDelaunay(pts, base, constraintSet, em);
  return { tris: base.filter(Boolean) };
}

export { orient2d, inCircle, segsCross };
