// signedAreaCoverageSmoke.mjs — validate the G1 signed-area coverage module against
// exact ground truth (per-pixel polygon∩pixel area via Sutherland–Hodgman) and prove
// it is CONFLATION-FREE (a shape split into abutting triangles has NO seam on the
// shared edge — the property the per-primitive path lacks).
import { signedAreaCoverage, signedAreaCoverageSegs } from '../src/renderer/signedAreaCoverage.js';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

// exact area of poly ∩ [x0,x1]×[y0,y1]
function clipArea(poly, x0, y0, x1, y1) {
  const clip = (pts, inside, isect) => { const o = []; for (let i = 0; i < pts.length; i++) { const a = pts[(i + pts.length - 1) % pts.length], b = pts[i]; const ia = inside(a), ib = inside(b); if (ib) { if (!ia) o.push(isect(a, b)); o.push(b); } else if (ia) o.push(isect(a, b)); } return o; };
  let p = poly;
  p = clip(p, (q) => q[0] >= x0, (a, b) => { const t = (x0 - a[0]) / (b[0] - a[0]); return [x0, a[1] + t * (b[1] - a[1])]; });
  p = clip(p, (q) => q[0] <= x1, (a, b) => { const t = (x1 - a[0]) / (b[0] - a[0]); return [x1, a[1] + t * (b[1] - a[1])]; });
  p = clip(p, (q) => q[1] >= y0, (a, b) => { const t = (y0 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), y0]; });
  p = clip(p, (q) => q[1] <= y1, (a, b) => { const t = (y1 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), y1]; });
  if (p.length < 3) return 0;
  let a2 = 0; for (let i = 0; i < p.length; i++) { const u = p[i], v = p[(i + 1) % p.length]; a2 += u[0] * v[1] - v[0] * u[1]; } return Math.abs(a2) / 2;
}
const truthGrid = (poly, W, H) => { const g = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = clipArea(poly, x, y, x + 1, y + 1); return g; };
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

// 1) exactness vs ground truth on assorted single polygons
const W = 16, H = 16;
const polys = {
  'axis square': [[2, 2], [12, 2], [12, 12], [2, 12]],
  'sub-pixel square': [[2.3, 3.7], [11.6, 3.7], [11.6, 10.2], [2.3, 10.2]],
  'rotated diamond': [[8, 2], [14, 8], [8, 14], [2, 8]],
  triangle: [[2, 2], [13, 4], [6, 13]],
};
for (const [name, poly] of Object.entries(polys)) {
  const sa = signedAreaCoverage([poly], W, H, false);
  const gt = truthGrid(poly, W, H);
  const d = maxDiff(sa, gt);
  d < 1e-4 ? ok(`${name}: signed-area == exact ground truth (max diff ${d.toExponential(1)})`) : fail(`${name}: max diff ${d.toExponential(2)} vs ground truth`);
}

// 2) CONFLATION-FREE: the square as ONE contour vs the same region declared as TWO
//    abutting triangles sharing the diagonal. Signed-area on both must equal the
//    square's coverage exactly (the shared diagonal's opposite-winding edges cancel).
{
  const square = [[2, 2], [12, 2], [12, 12], [2, 12]];
  // two triangles, consistently wound, sharing diagonal (2,2)-(12,12)
  const T1 = [[2, 2], [12, 2], [12, 12]];
  const T2 = [[2, 2], [12, 12], [2, 12]];
  const one = signedAreaCoverage([square], W, H, false);
  const two = signedAreaCoverage([T1, T2], W, H, false);
  const d = maxDiff(one, two);
  d < 1e-4 ? ok(`conflation-free: two abutting triangles == one square (max diff ${d.toExponential(1)}) — NO shared-diagonal seam`)
          : fail(`conflation seam: two-triangle coverage differs from square by ${d.toFixed(3)}`);
  // and verify an interior pixel straddling the diagonal reads ~1.0 (not the 0.5/0.75 seam)
  const px = 7, py = 7;   // centre, on the diagonal, fully interior
  const cov = two[py * W + px];
  cov > 0.99 ? ok(`interior-on-diagonal pixel coverage ${cov.toFixed(3)} ≈ 1.0 (per-primitive would give 0.5/0.75)`) : fail(`interior-on-diagonal pixel under-covered: ${cov.toFixed(3)}`);
}

// 3) even-odd hole: square with a centered square hole (opposite winding) — the hole
//    must read 0 coverage, the ring ~1, matching ground truth (area = outer − hole).
{
  const outer = [[1, 1], [15, 1], [15, 15], [1, 15]];
  const hole = [[5, 5], [5, 11], [11, 11], [11, 5]];   // reversed winding → hole
  const sa = signedAreaCoverage([outer, hole], W, H, false);
  const gtOuter = truthGrid(outer, W, H), gtHole = truthGrid(hole, W, H);
  const gt = new Float32Array(W * H); for (let i = 0; i < gt.length; i++) gt[i] = Math.max(0, gtOuter[i] - gtHole[i]);
  const d = maxDiff(sa, gt);
  const holeCov = sa[8 * W + 8];   // centre of the hole
  d < 1e-4 && holeCov < 1e-4 ? ok(`holed square: matches (outer − hole) ground truth (diff ${d.toExponential(1)}, hole centre ${holeCov.toExponential(1)})`)
                            : fail(`holed square: diff ${d.toExponential(2)}, hole centre coverage ${holeCov.toFixed(3)}`);
}

// 4) CLOSED-FORM CURVE coverage (no flatten): a rounded shape from 4 quad arcs vs
//    exact ground truth. Proves the curve signed-area contribution is resolution-
//    independent and matches area coverage (the AA path for a mesh-free renderer).
{
  const cx = 8, cy = 8, r = 5;
  const on = [[cx + r, cy], [cx, cy + r], [cx - r, cy], [cx, cy - r]];
  const ct = [[cx + r, cy + r], [cx - r, cy + r], [cx - r, cy - r], [cx + r, cy - r]];
  const segs = on.map((a, i) => ({ type: 'quad', P0: a, P1: ct[i], P2: on[(i + 1) % 4] }));
  const q = (P0, P1, P2) => (t) => { const u = 1 - t; return [u * u * P0[0] + 2 * u * t * P1[0] + t * t * P2[0], u * u * P0[1] + 2 * u * t * P1[1] + t * t * P2[1]]; };
  const poly = []; for (let i = 0; i < 4; i++) { const f = q(on[i], ct[i], on[(i + 1) % 4]); for (let s = 0; s < 96; s++) poly.push(f(s / 96)); }
  const cov = signedAreaCoverageSegs(segs, W, H, false);
  const gt = truthGrid(poly, W, H);
  const d = maxDiff(cov, gt);
  // tolerance ~1e-3: the residual is the 96-gon ground-truth's own arc approximation.
  d < 2e-3 ? ok(`closed-form quad-arc coverage matches ground truth (max diff ${d.toExponential(1)}, no flatten)`)
          : fail(`quad-arc coverage: max diff ${d.toExponential(2)} vs ground truth`);
}

console.log(failures ? `\nSIGNED-AREA-COVERAGE FAIL (${failures})` : `\nSIGNED-AREA-COVERAGE PASS`);
process.exit(failures ? 1 : 0);
