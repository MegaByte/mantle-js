// pathBooleanSlice4Smoke — cubic × arc and arc × arc kernels.
//
// cubicArc: transform cubic to arc-local frame; |c(s)|² = 1 → degree-6
//   polynomial. Solve via Bernstein-subdivision root finder
//   (variation-diminishing property + secant refinement).
// arcArc: substitute arc B's parametric form into arc A's implicit
//   conic equation; trig equation in θ → Weierstrass substitution →
//   degree-4 polynomial in u = tan(θ/2). Ferrari.

import { intersectCubicArc, intersectArcArc } from '../src/svg/pathBoolean/intersect/index.js';
import { mkArc } from '../src/svg/segment.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => { failures++; console.error('FAIL', m); };
const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;

// ======================================================================
// CA: cubic × arc
// ======================================================================

// 1. Cubic line (straight) through unit circle.
//    Cubic (collinear control): (-2, 0) → (-1, 0) → (1, 0) → (2, 0)
//    is a straight line on y=0. Unit circle meets y=0 at (±1, 0).
{
  const arc = mkArc(0, 0, 1, 1, 0, 2*Math.PI, 0, 0, 1);
  const xs = intersectCubicArc([-2, 0], [-1, 0], [1, 0], [2, 0], arc);
  if (xs.length === 2) {
    const sorted = xs.slice().sort((a, b) => a.x - b.x);
    if (near(sorted[0].x, -1) && near(sorted[1].x, 1))
      ok(`CA: straight-cubic line meets unit circle at (±1, 0)`);
    else fail(`CA: 2-cross x's: ${sorted.map(p => p.x.toFixed(4)).join(', ')}`);
  } else fail(`CA: 2-cross expected 2, got ${xs.length}: ${JSON.stringify(xs)}`);
}

// 2. Cubic S-curve crossing unit circle. A cubic that passes through
//    (0.5, 0) — the chord (-2, 0) → (-0.5, 0.6) → (0.5, -0.6) → (2, 0).
{
  const arc = mkArc(0, 0, 1, 1, 0, 2*Math.PI, 0, 0, 1);
  const xs = intersectCubicArc([-2, 0], [-0.5, 0.6], [0.5, -0.6], [2, 0], arc);
  // Cubic crosses circle 2 or 3 times depending on amplitudes. Verify
  // the kernel doesn't crash and produces valid points (each on the
  // unit circle).
  let valid = true;
  for (const p of xs) {
    if (Math.abs(p.x*p.x + p.y*p.y - 1) > 1e-3) { valid = false; break; }
  }
  if (valid && xs.length >= 1)
    ok(`CA: S-cubic + unit circle yields ${xs.length} on-circle hits`);
  else fail(`CA: S-cubic invalid hits: ${JSON.stringify(xs)}`);
}

// 3. Cubic disjoint from arc (entirely above unit circle).
{
  const arc = mkArc(0, 0, 1, 1, 0, 2*Math.PI, 0, 0, 1);
  const xs = intersectCubicArc([-2, 5], [-1, 5], [1, 5], [2, 5], arc);
  if (xs.length === 0) ok('CA: cubic above unit circle → 0');
  else fail(`CA: disjoint got ${xs.length}`);
}

// 4. Cubic endpoint on arc.
{
  const arc = mkArc(0, 0, 1, 1, 0, 2*Math.PI, 0, 0, 1);
  const xs = intersectCubicArc([1, 0], [2, 1], [3, 1], [4, 0], arc);
  if (xs.some(p => p.endpointA && near(p.x, 1) && near(p.y, 0)))
    ok('CA: cubic start at (1, 0) on circle detected as endpoint');
  else fail(`CA: endpoint got ${JSON.stringify(xs)}`);
}

// 5. Sweep restriction: cubic crosses full circle 2x, arc restricted
//    to upper half → only upper crossings.
{
  const arcUpper = mkArc(0, 0, 1, 1, 0, Math.PI, 0, 0, 1);
  // Vertical-ish cubic at x=0 crossing circle at (0, ±1).
  // Cubic (0, -2) → (0, -1) → (0, 1) → (0, 2): straight vertical line x=0.
  const xs = intersectCubicArc([0, -2], [0, -1], [0, 1], [0, 2], arcUpper);
  if (xs.length === 1 && near(xs[0].y, 1, 1e-3))
    ok(`CA: vertical cubic + upper arc → only (0, 1)`);
  else fail(`CA: vertical-upper got ${JSON.stringify(xs)}`);
}

// ======================================================================
// AA: arc × arc
// ======================================================================

// 6. Two unit circles offset horizontally by 1 → intersection at
//    (0.5, ±√0.75).
{
  const arcA = mkArc(0, 0, 1, 1, 0, 2*Math.PI, 0, 0, 1);
  const arcB = mkArc(1, 0, 1, 1, 0, 2*Math.PI, 0, 0, 1);
  const xs = intersectArcArc(arcA, arcB);
  if (xs.length === 2) {
    const sorted = xs.slice().sort((a, b) => a.y - b.y);
    const ey = Math.sqrt(0.75);
    if (near(sorted[0].y, -ey, 1e-3) && near(sorted[1].y, ey, 1e-3)
        && near(sorted[0].x, 0.5, 1e-3) && near(sorted[1].x, 0.5, 1e-3))
      ok(`AA: two unit circles offset 1 → (0.5, ±${ey.toFixed(3)})`);
    else fail(`AA: 2-circle got ${sorted.map(p => `(${p.x.toFixed(3)},${p.y.toFixed(3)})`).join(', ')}`);
  } else fail(`AA: 2-circle expected 2, got ${xs.length}`);
}

// 7. Concentric circles → 0 intersections.
{
  const arcA = mkArc(0, 0, 1, 1, 0, 2*Math.PI, 0, 0, 1);
  const arcB = mkArc(0, 0, 2, 2, 0, 2*Math.PI, 0, 0, 1);
  const xs = intersectArcArc(arcA, arcB);
  if (xs.length === 0) ok('AA: concentric circles → 0 intersections');
  else fail(`AA: concentric got ${xs.length}`);
}

// 8. Tangent circles (touching externally).
{
  const arcA = mkArc(0, 0, 1, 1, 0, 2*Math.PI, 0, 0, 1);
  const arcB = mkArc(2, 0, 1, 1, 0, 2*Math.PI, 0, 0, 1);
  const xs = intersectArcArc(arcA, arcB);
  if (xs.length === 1 && near(xs[0].x, 1) && near(xs[0].y, 0))
    ok(`AA: tangent circles touch at (1, 0)`);
  else fail(`AA: tangent got ${JSON.stringify(xs)}`);
}

// 9. Sweep filtering: same as test 6 but arc B is upper-half only.
//    Only the upper intersection (0.5, +√0.75) is in B's sweep.
{
  const arcA = mkArc(0, 0, 1, 1, 0, 2*Math.PI, 0, 0, 1);
  const arcBupper = mkArc(1, 0, 1, 1, 0, Math.PI, 0, 0, 1);
  const xs = intersectArcArc(arcA, arcBupper);
  const ey = Math.sqrt(0.75);
  if (xs.length === 1 && near(xs[0].y, ey, 1e-3) && near(xs[0].x, 0.5, 1e-3))
    ok(`AA: full + upper-half → only upper intersection`);
  else fail(`AA: sweep got ${JSON.stringify(xs)}`);
}

// 10. Ellipse × circle. Rotated ellipse rx=2, ry=1, phi=0 vs unit
//     circle. Implicit ellipse: x²/4 + y² = 1. Circle: x² + y² = 1.
//     Subtract: x²/4 - x² = 0 → -3x²/4 = 0 → x = 0. y = ±1.
//     So 2 intersections at (0, ±1).
{
  const arcA = mkArc(0, 0, 2, 1, 0, 2*Math.PI, 0, 0, 1);  // ellipse
  const arcB = mkArc(0, 0, 1, 1, 0, 2*Math.PI, 0, 0, 1);  // unit circle
  const xs = intersectArcArc(arcA, arcB);
  if (xs.length === 2) {
    const sorted = xs.slice().sort((a, b) => a.y - b.y);
    if (near(sorted[0].x, 0, 1e-3) && near(sorted[0].y, -1, 1e-3)
        && near(sorted[1].x, 0, 1e-3) && near(sorted[1].y, 1, 1e-3))
      ok(`AA: rx=2 ellipse + unit circle → (0, ±1)`);
    else fail(`AA: ellipse+circle got ${sorted.map(p => `(${p.x.toFixed(4)},${p.y.toFixed(4)})`).join(', ')}`);
  } else fail(`AA: ellipse+circle expected 2, got ${xs.length}`);
}

if (failures > 0) {
  console.error(`\nPATH-BOOLEAN SLICE-4 FAIL (${failures})`);
  process.exit(1);
}
console.log('\nPATH-BOOLEAN SLICE-4 PASS');
