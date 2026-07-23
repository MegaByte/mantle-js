#!/usr/bin/env node
// THE one true local kernel: coverage = area(box ∩ fill), fill = LEFT of a
// directed outline polyline, computed by clipping the polyline to the box and
// shoelacing the fill polygon. NO convex/reflex tag, NO gate — span is handled
// by clipping segments to the box, so a segment that ends before the box simply
// doesn't bound the pixel. Handles convex, reflex, horizontal, junction alike.
// Validated vs 256x supersampling; if clean, this ports to the kind-0 shader.
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const EPS = 1e-9;
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const shoelace = (poly) => { let s = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; s += p[0] * q[1] - q[0] * p[1]; } return s * 0.5; };
// nearest-seg fill side (fill = left of directed polyline)
function leftOfPoly(p, pts) { let best = Infinity, side = true;
  for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    let t = L2 > EPS ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = clamp(t, 0, 1);
    const cx = a[0] + t * dx, cy = a[1] + t * dy, d = Math.hypot(p[0] - cx, p[1] - cy);
    if (d < best - 1e-12) { best = d; side = (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) >= 0; } }
  return side; }
// clip segment A->B to box [-.5,.5]^2 via Liang-Barsky; return {A2,B2,t0,t1} or null
function clipSeg(A, B) { let t0 = 0, t1 = 1; const dx = B[0] - A[0], dy = B[1] - A[1];
  const P = [-dx, dx, -dy, dy], Q = [A[0] + 0.5, 0.5 - A[0], A[1] + 0.5, 0.5 - A[1]];
  for (let i = 0; i < 4; i++) { if (Math.abs(P[i]) < EPS) { if (Q[i] < 0) return null; continue; }
    const r = Q[i] / P[i]; if (P[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; } }
  if (t1 < t0) return null;
  return { A2: [A[0] + t0 * dx, A[1] + t0 * dy], B2: [A[0] + t1 * dx, A[1] + t1 * dy], t0, t1 }; }
// border param CCW: bottom y=-.5 x:-.5->.5 [0,1); right x=.5 y:-.5->.5 [1,2); top y=.5 x:.5->-.5 [2,3); left x=-.5 y:.5->-.5 [3,4)
function bparam(p) {
  if (Math.abs(p[1] + 0.5) < 1e-6) return clamp(p[0] + 0.5, 0, 1);
  if (Math.abs(p[0] - 0.5) < 1e-6) return 1 + clamp(p[1] + 0.5, 0, 1);
  if (Math.abs(p[1] - 0.5) < 1e-6) return 2 + clamp(0.5 - p[0], 0, 1);
  return 3 + clamp(0.5 - p[1], 0, 1); }
const CORNERS = [[0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5]]; // at params 1,2,3,4(=0)
// CCW border tangent at a border point
function borderTanCCW(p) {
  if (Math.abs(p[1] + 0.5) < 1e-6 && p[0] < 0.5 - 1e-6) return [1, 0];   // bottom → +x
  if (Math.abs(p[0] - 0.5) < 1e-6 && p[1] < 0.5 - 1e-6) return [0, 1];   // right → +y
  if (Math.abs(p[1] - 0.5) < 1e-6 && p[0] > -0.5 + 1e-6) return [-1, 0]; // top → -x
  return [0, -1];                                                        // left → -y
}
// walk border from X to E in direction `dir` (+1 CCW / -1 CW), emit corners crossed.
// Corner candidates span TWO laps (8, index k%4): a walk crossing the param-0
// origin needs the wrapped corners — one lap dropped a corner on e.g. a leftward
// horizontal edge (fill above), halving the coverage (the H crossbar-band bug).
function borderWalk(X, E, dir) {
  let a = bparam(X), b = bparam(E); const out = [];
  if (dir > 0) { if (b < a - 1e-9) b += 4; for (let k = 0; k < 8; k++) { const cp = k + 1; if (cp > a + 1e-9 && cp < b - 1e-9) out.push(CORNERS[k % 4]); } }
  else { if (b > a + 1e-9) b -= 4; for (let k = 7; k >= 0; k--) { const cp = k + 1 - 4; if (cp < a - 1e-9 && cp > b + 1e-9) out.push(CORNERS[k % 4]); } }
  return out;
}
function fillCov(pts) {
  // collect inside chain(s). For the local case assume ONE inside chain.
  const chain = []; let E = null, X = null;
  for (let i = 0; i + 1 < pts.length; i++) { const c = clipSeg(pts[i], pts[i + 1]); if (!c) continue;
    if (!chain.length) { chain.push(c.A2); E = c.A2; } else if (Math.hypot(chain[chain.length - 1][0] - c.A2[0], chain[chain.length - 1][1] - c.A2[1]) > 1e-7) { chain.push(c.A2); }
    chain.push(c.B2); X = c.B2; }
  if (chain.length < 2) return leftOfPoly([0, 0], pts) ? 1 : 0;
  // ENDS-ON-BORDER INVARIANT (mirrors the GLSL): a chain end strictly inside
  // the box is extended along its terminal segment's direction to the border.
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
  // Close along the border from X back to E, heading into the FILL (left of the
  // chain's exit direction). Robust: choose the border walk direction whose CCW
  // tangent at X lies on the fill (left) side of the exit segment.
  const n = chain.length; const dX = [chain[n - 1][0] - chain[n - 2][0], chain[n - 1][1] - chain[n - 2][1]];
  const leftN = [-dX[1], dX[0]]; const tCCW = borderTanCCW(X);
  const dir = (tCCW[0] * leftN[0] + tCCW[1] * leftN[1]) >= 0 ? 1 : -1;
  const poly = chain.concat(borderWalk(X, E, dir));
  return clamp(Math.abs(shoelace(poly)), 0, 1);
}

function ssTruth(pts, c) { const N = 256; let n = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const x = (i + 0.5) / N - 0.5, y = (j + 0.5) / N - 0.5; if (leftOfPoly([c[0] + x, c[1] + y], pts)) n++; }
  return n / (N * N); }
let worst = 0;
function check(name, pts, c = [0, 0]) { const cov = fillCov(pts.map(p => [p[0] - c[0], p[1] - c[1]])); const truth = ssTruth(pts, c);
  const e = Math.abs(cov - truth) * 255; worst = Math.max(worst, e); console.log(`${name.padEnd(20)} truth=${truth.toFixed(4)} cov=${cov.toFixed(4)} err=${e.toFixed(1)}`); }

check('edge-45', [[-1, -1], [1, 1]]);
check('edge-horiz', [[-1, 0.1], [1, 0.1]]);         // horizontal top edge, fill below
check('edge-vert', [[0.1, -1], [0.1, 1]]);
// WRAP cases: walks that cross the border param-0 origin (bottom-left corner).
// The one-lap corner loop dropped a corner here — leftward-horizontal coverage
// came out at exactly half (the H crossbar-band bug, found on GPU 2026-07-18).
check('edge-horiz-left', [[1, 0.1], [-1, 0.1]]);    // leftward, fill above
check('edge-vert-down', [[0.1, 1], [0.1, -1]]);     // upward, fill right
check('edge-45-rev', [[1, 1], [-1, -1]]);
check('wrap-corner', [[1, 0.2], [0.1, 0.2], [0.1, 1]]);   // reflex corner, wrapped walk
check('convex', [[-0.6, -0.5], [0, 0], [0.5, -0.6]]);
check('reflex', [[-0.6, 0.5], [0, 0], [0.5, 0.6]]);
check('reflex-offV', [[-2, 0.3], [0.2, 0.3], [0.3, 2]], [0, 0]);   // reflex vertex near cell, e2 goes up
check('midedge-far-corner', [[-3, 0], [0, 0], [0, 3]], [-1.5, 0]); // fragment mid-edge, corner 1.5px away
check('zigzag', [[-0.7, -0.3], [-0.1, 0.15], [0.15, -0.15], [0.7, 0.3]]);
// tip: nearest-seg SS is WRONG near a convex spike (rounds the apex). The true
// winding-fill = box minus the straight spike triangle (E,apex,X). Validate the
// clip against that exact analytic area instead.
{ const pts = [[-0.4, -0.6], [0, 0.3], [0.4, -0.6]];
  const cov = fillCov(pts);
  const E = [-0.356, -0.5], apex = [0, 0.3], X = [0.356, -0.5];
  const tri = Math.abs((apex[0] - E[0]) * (X[1] - E[1]) - (apex[1] - E[1]) * (X[0] - E[0])) * 0.5;
  const truth = 1 - tri; const e = Math.abs(cov - truth) * 255; worst = Math.max(worst, e);
  console.log(`${'tip(analytic)'.padEnd(20)} truth=${truth.toFixed(4)} cov=${cov.toFixed(4)} err=${e.toFixed(1)}`); }
console.log(`\nWORST ${worst.toFixed(1)}/255  ${worst < 2 ? 'PASS — clip kernel is exact' : 'FAIL'}`);
