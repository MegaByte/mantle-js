// pathBooleanSlice2bSmoke — quad × arc intersection kernel.
// Transform-to-arc-local-frame + Ferrari on |c(s)|² = 1.

import { intersectQuadArc } from '../src/svg/pathBoolean/intersect/index.js';
import { mkArc } from '../src/svg/segment.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => { failures++; console.error('FAIL', m); };
const near = (a, b, tol = 1e-5) => Math.abs(a - b) <= tol;

// ======================================================================
// 1. Parabola crossing unit circle at 2 points
// ======================================================================
//
// Parabola y = 2x², parameterized as Bezier through x ∈ [-1, 1]:
//   x(s) = -1 + 2s, y(s) at endpoints = 2.
//   Power form: x = -1 + 2s (linear). y(s) at s=0 → 2, s=1 → 2,
//   s=0.5 → 0. So y(s) = a + b·s + c·s² with y(0)=2, y(0.5)=0, y(1)=2.
//   2 = a, 0 = 2 + 0.5b + 0.25c, 2 = 2 + b + c.
//   From last: c = -b. Substitute: 0 = 2 + 0.5b - 0.25b = 2 + 0.25b
//   → b = -8, c = 8. So y(s) = 2 - 8s + 8s².
//   Verify: at s=0.5, y = 2 - 4 + 2 = 0. ✓ And 2x² where x = -1+2s:
//   2·(-1+2s)² = 2·(1 - 4s + 4s²) = 2 - 8s + 8s². ✓
//
//   To express as Bezier: from power y = 2 - 8s + 8s²:
//     y0 = 2 (= power coef 0)
//     2(y1 - y0) = -8 → y1 = -2
//     y0 - 2y1 + y2 = 8 → y2 = 8 + 2(-2) - 2 = 2.
//   Bezier control y: (2, -2, 2). And x: (-1, 0, 1) trivially.
//
// Full unit circle vs parabola y = 2x²:
//   x² + y² = 1, y = 2x² → x² + 4x⁴ = 1.
//   Let u = x²: 4u² + u - 1 = 0 → u = (-1 + √17)/8 ≈ 0.3904.
//   So x = ±0.625 (approximately). y = 2·0.3904 = 0.7808.
//   Verify: 0.39 + 0.609 ≈ 1.0. ✓
//   Both x-values give the same y, so 2 intersections.
{
  const arc = mkArc(0, 0, 1, 1, 0, 2*Math.PI, 0, 0, 1);
  const xs = intersectQuadArc([-1, 2], [0, -2], [1, 2], arc);
  if (xs.length === 2) {
    const expectX = Math.sqrt((-1 + Math.sqrt(17)) / 8);
    const got = xs.map(p => Math.abs(p.x)).sort();
    if (near(got[0], expectX, 1e-3) && near(got[1], expectX, 1e-3))
      ok(`QA: parabola y=2x² meets unit circle at ±x = ±${expectX.toFixed(4)} (got ${got.map(v => v.toFixed(4)).join(', ')})`);
    else fail(`QA: 2-cross x's: ${got.map(v => v.toFixed(4)).join(', ')}`);
  } else fail(`QA: 2-cross expected 2 hits, got ${xs.length}: ${JSON.stringify(xs)}`);
}

// ======================================================================
// 2. Parabola tangent to unit circle
// ======================================================================
//
// Parabola y = 1 - x² parameterized as Bezier (-1, 0) (0, 2) (1, 0).
// At apex (0, 1) tangent to top of unit circle (which has y=1 only at (0,1)).
// Verify Bezier: y0=0, 2(y1-y0)=4 so y1=2, y0-2y1+y2=-4 so y2=0. ✓
// Power: y(s) = 0 + 4s + (0-4+0)s² = 4s - 4s². At s=0.5: 1. ✓
// y = 1 - x² where x = -1+2s: 1 - (1-4s+4s²) = 4s - 4s². ✓
{
  const arc = mkArc(0, 0, 1, 1, 0, 2*Math.PI, 0, 0, 1);
  const xs = intersectQuadArc([-1, 0], [0, 2], [1, 0], arc);
  // Need: parabola touches circle at (0, 1). Other intersections?
  // x² + (1 - x²)² = 1 → x² + 1 - 2x² + x⁴ = 1 → x⁴ - x² = 0 →
  // x²(x² - 1) = 0 → x = 0, ±1. So 3 distinct points: (0, 1), (1, 0), (-1, 0).
  // The parabola passes through (±1, 0) at endpoints, and through (0, 1) at apex.
  if (xs.length === 3) {
    const sorted = xs.slice().sort((a, b) => a.x - b.x);
    if (near(sorted[0].x, -1) && near(sorted[1].x, 0) && near(sorted[2].x, 1))
      ok(`QA: parabola y=1-x² meets circle at (-1,0), (0,1), (1,0)`);
    else fail(`QA: 3-pt got ${sorted.map(p => `(${p.x.toFixed(3)}, ${p.y.toFixed(3)})`).join(', ')}`);
  } else fail(`QA: 3-cross expected 3, got ${xs.length}: ${JSON.stringify(xs)}`);
}

// ======================================================================
// 3. Parabola misses arc entirely
// ======================================================================
{
  const arc = mkArc(0, 0, 1, 1, 0, Math.PI, 0, 0, 1);  // upper semicircle
  // Parabola entirely below y=0.
  const xs = intersectQuadArc([-2, -1], [0, -1], [2, -1], arc);
  if (xs.length === 0) ok('QA: parabola below arc → 0 intersections');
  else fail(`QA: miss got ${xs.length}`);
}

// ======================================================================
// 4. Sweep restriction: a quad that crosses the full circle 2x but
//    arc is restricted to one quadrant. Result: filtered count.
// ======================================================================
{
  // Same parabola as test 1 (y = 2x²) intersecting full circle at 2
  // points at angles ±atan2(0.78, 0.625) ≈ ±51.3°.
  // Restrict arc to upper half (θ in [0, π]) — both intersections are
  // in upper half (y > 0), still 2 hits.
  const arcUpper = mkArc(0, 0, 1, 1, 0, Math.PI, 0, 0, 1);
  const xs = intersectQuadArc([-1, 2], [0, -2], [1, 2], arcUpper);
  if (xs.length === 2) ok('QA: upper-half arc — both crossings retained');
  else fail(`QA: upper-half expected 2, got ${xs.length}`);

  // Restrict arc to right half (θ in [-π/2, π/2]) — both crossings
  // are at ±x ≈ ±0.625, so one is in left half (filtered out).
  // Right half = positive x. So 1 hit.
  const arcRight = mkArc(0, 0, 1, 1, -Math.PI/2, Math.PI/2, 0, 0, 1);
  const xsR = intersectQuadArc([-1, 2], [0, -2], [1, 2], arcRight);
  if (xsR.length === 1 && xsR[0].x > 0)
    ok(`QA: right-half arc — only +x crossing (x=${xsR[0].x.toFixed(3)})`);
  else fail(`QA: right-half got ${xsR.length}: ${JSON.stringify(xsR)}`);
}

// ======================================================================
// 5. Rotated ellipse arc + quadratic
// ======================================================================
{
  // Rotated rx=2 ry=1 phi=π/4. Quad through the rotated-ellipse origin
  // (cx,cy)=(0,0) at apex.
  const arc = mkArc(0, 0, 2, 1, 0, 2*Math.PI, Math.PI/4, 0, 1);
  // A quadratic apex at origin: control (-1, 1) (0, -1) (1, 1) — y(s)
  // = 1 - 4s + 4s², x(s) = -1 + 2s. At s=0.5, (0, 0).
  // The point (0, 0) is the ellipse's CENTER, not on the ellipse.
  // So this quad should NOT hit. But it does cross the ellipse
  // somewhere on its arc.
  const xs = intersectQuadArc([-1, 1], [0, -1], [1, 1], arc);
  ok(`QA: rotated ellipse — quad through origin yields ${xs.length} intersections (kernel did not crash)`);
}

if (failures > 0) {
  console.error(`\nPATH-BOOLEAN SLICE-2B FAIL (${failures})`);
  process.exit(1);
}
console.log('\nPATH-BOOLEAN SLICE-2B PASS');
