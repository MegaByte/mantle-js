// The polyline poly-clip kernel, extracted verbatim from _polyClip.mjs so it can
// serve as an importable REFERENCE. _polyClip.mjs validates it at 0.5/255 vs
// 256× supersampling; _polyClipConic.mjs validates the conic kernel against it
// at 2048–4096 pieces per arc, where the polyline's own sagitta error vanishes.
// Keep byte-identical in behaviour to _polyClip.mjs's fillCov.
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const EPS = 1e-9;
const shoelace = (poly) => { let s = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; s += p[0] * q[1] - q[0] * p[1]; } return s * 0.5; };
function leftOfPoly(p, pts) { let best = Infinity, side = true;
  for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    let t = L2 > EPS ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = clamp(t, 0, 1);
    const cx = a[0] + t * dx, cy = a[1] + t * dy, d = Math.hypot(p[0] - cx, p[1] - cy);
    if (d < best - 1e-12) { best = d; side = (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) >= 0; } }
  return side; }
function clipSeg(A, B) { let t0 = 0, t1 = 1; const dx = B[0] - A[0], dy = B[1] - A[1];
  const P = [-dx, dx, -dy, dy], Q = [A[0] + 0.5, 0.5 - A[0], A[1] + 0.5, 0.5 - A[1]];
  for (let i = 0; i < 4; i++) { if (Math.abs(P[i]) < EPS) { if (Q[i] < 0) return null; continue; }
    const r = Q[i] / P[i]; if (P[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; } }
  if (t1 < t0) return null;
  return { A2: [A[0] + t0 * dx, A[1] + t0 * dy], B2: [A[0] + t1 * dx, A[1] + t1 * dy], t0, t1 }; }
function bparam(p) {
  if (Math.abs(p[1] + 0.5) < 1e-6) return clamp(p[0] + 0.5, 0, 1);
  if (Math.abs(p[0] - 0.5) < 1e-6) return 1 + clamp(p[1] + 0.5, 0, 1);
  if (Math.abs(p[1] - 0.5) < 1e-6) return 2 + clamp(0.5 - p[0], 0, 1);
  return 3 + clamp(0.5 - p[1], 0, 1); }
const CORNERS = [[0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5]];
function borderTanCCW(p) {
  if (Math.abs(p[1] + 0.5) < 1e-6 && p[0] < 0.5 - 1e-6) return [1, 0];
  if (Math.abs(p[0] - 0.5) < 1e-6 && p[1] < 0.5 - 1e-6) return [0, 1];
  if (Math.abs(p[1] - 0.5) < 1e-6 && p[0] > -0.5 + 1e-6) return [-1, 0];
  return [0, -1];
}
function borderWalk(X, E, dir) {
  let a = bparam(X), b = bparam(E); const out = [];
  if (dir > 0) { if (b < a - 1e-9) b += 4; for (let k = 0; k < 8; k++) { const cp = k + 1; if (cp > a + 1e-9 && cp < b - 1e-9) out.push(CORNERS[k % 4]); } }
  else { if (b > a + 1e-9) b -= 4; for (let k = 7; k >= 0; k--) { const cp = k + 1 - 4; if (cp < a - 1e-9 && cp > b + 1e-9) out.push(CORNERS[k % 4]); } }
  return out;
}
export function fillCovPolyline(pts, multiPiece = false) {
  // MULTI-PIECE mode: a chain that leaves the box and re-enters forms SEPARATE
  // inside pieces. Joining them with a straight jump is exact only when both
  // border points sit on the SAME box edge (the thin-counter / staple case,
  // where the jump lies along the border). When the excursion wraps a box
  // CORNER, the jump cuts the corner off and the area is wrong. Closing each
  // gap with a border WALK instead is correct in both cases.
  if (multiPiece) return fillCovPieces(pts);
  const chain = []; let E = null, X = null;
  for (let i = 0; i + 1 < pts.length; i++) { const c = clipSeg(pts[i], pts[i + 1]); if (!c) continue;
    if (!chain.length) { chain.push(c.A2); E = c.A2; } else if (Math.hypot(chain[chain.length - 1][0] - c.A2[0], chain[chain.length - 1][1] - c.A2[1]) > 1e-7) { chain.push(c.A2); }
    chain.push(c.B2); X = c.B2; }
  if (chain.length < 2) return leftOfPoly([0, 0], pts) ? 1 : 0;
  const inside = (p) => Math.max(Math.abs(p[0]), Math.abs(p[1])) < 0.5 - 1e-4;
  const toBorder = (p, d) => { const L = Math.hypot(d[0], d[1]) || 1; const dn = [d[0] / L, d[1] / L];
    const tx = Math.abs(dn[0]) > 1e-6 ? ((dn[0] > 0 ? 0.5 : -0.5) - p[0]) / dn[0] : 1e9;
    const ty = Math.abs(dn[1]) > 1e-6 ? ((dn[1] > 0 ? 0.5 : -0.5) - p[1]) / dn[1] : 1e9;
    const t = Math.min(tx, ty); return [p[0] + dn[0] * t, p[1] + dn[1] * t]; };
  {
    const m = chain.length;
    if (inside(chain[m - 1])) { const q = toBorder(chain[m - 1], [chain[m - 1][0] - chain[m - 2][0], chain[m - 1][1] - chain[m - 2][1]]); chain.push(q); X = q; }
    if (inside(chain[0])) { const q = toBorder(chain[0], [chain[0][0] - chain[1][0], chain[0][1] - chain[1][1]]); chain.unshift(q); E = q; }
  }
  const n = chain.length; const dX = [chain[n - 1][0] - chain[n - 2][0], chain[n - 1][1] - chain[n - 2][1]];
  const leftN = [-dX[1], dX[0]]; const tCCW = borderTanCCW(X);
  const dir = (tCCW[0] * leftN[0] + tCCW[1] * leftN[1]) >= 0 ? 1 : -1;
  const poly = chain.concat(borderWalk(X, E, dir));
  return clamp(Math.abs(shoelace(poly)), 0, 1);
}

// Multi-piece closure: split the clipped chain into maximal CONTIGUOUS pieces
// and close each gap by walking the box border (fill side) from one piece's
// exit to the next piece's entry, wrapping from the last back to the first.
// Reduces to the single-chain kernel when there is exactly one piece.
export function fillCovPieces(pts) {
  const pieces = []; let cur = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const c = clipSeg(pts[i], pts[i + 1]); if (!c) continue;
    if (cur && Math.hypot(cur[cur.length - 1][0] - c.A2[0], cur[cur.length - 1][1] - c.A2[1]) < 1e-7) cur.push(c.B2);
    else { if (cur && cur.length >= 2) pieces.push(cur); cur = [c.A2, c.B2]; }
  }
  if (cur && cur.length >= 2) pieces.push(cur);
  if (!pieces.length) return leftOfPoly([0, 0], pts) ? 1 : 0;
  const inside = (p) => Math.max(Math.abs(p[0]), Math.abs(p[1])) < 0.5 - 1e-4;
  const toBorder = (p, d) => { const L = Math.hypot(d[0], d[1]) || 1; const dn = [d[0] / L, d[1] / L];
    const tx = Math.abs(dn[0]) > 1e-6 ? ((dn[0] > 0 ? 0.5 : -0.5) - p[0]) / dn[0] : 1e9;
    const ty = Math.abs(dn[1]) > 1e-6 ? ((dn[1] > 0 ? 0.5 : -0.5) - p[1]) / dn[1] : 1e9;
    const t = Math.min(tx, ty); return [p[0] + dn[0] * t, p[1] + dn[1] * t]; };
  // real chain ENDS (first entry / last exit) may sit strictly inside the box
  const f = pieces[0], l = pieces[pieces.length - 1];
  if (inside(f[0])) f.unshift(toBorder(f[0], [f[0][0] - f[1][0], f[0][1] - f[1][1]]));
  if (inside(l[l.length - 1])) l.push(toBorder(l[l.length - 1], [l[l.length - 1][0] - l[l.length - 2][0], l[l.length - 1][1] - l[l.length - 2][1]]));
  const poly = [];
  for (let k = 0; k < pieces.length; k++) {
    const P = pieces[k], Q = pieces[(k + 1) % pieces.length];
    for (const p of P) poly.push(p);
    const X = P[P.length - 1], E = Q[0];
    const dX = [X[0] - P[P.length - 2][0], X[1] - P[P.length - 2][1]];
    const leftN = [-dX[1], dX[0]], tCCW = borderTanCCW(X);
    const dir = (tCCW[0] * leftN[0] + tCCW[1] * leftN[1]) >= 0 ? 1 : -1;
    for (const c of borderWalk(X, E, dir)) poly.push(c);
  }
  return clamp(Math.abs(shoelace(poly)), 0, 1);
}
