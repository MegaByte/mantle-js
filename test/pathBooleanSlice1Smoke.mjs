// pathBooleanSlice1Smoke — exact intersection kernels involving a
// LINE primitive. No GL, no rendering — pure unit tests against
// closed-form known answers.
//
// Covers:
//   - LINE × LINE
//   - LINE × QUAD
//   - LINE × CUBIC
//   - LINE × ARC

import {
  intersectLineLine, intersectLineQuad,
  intersectLineCubic, intersectLineArc,
} from '../src/svg/pathBoolean/intersect/index.js';
import { mkArc } from '../src/svg/segment.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => { failures++; console.error('FAIL', m); };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const pointNear = (p, x, y, tol = 1e-6) => near(p.x, x, tol) && near(p.y, y, tol);

// ======================================================================
// LINE × LINE
// ======================================================================

// X-cross: two perpendicular lines meeting at origin.
{
  const xs = intersectLineLine([-1, 0], [1, 0], [0, -1], [0, 1]);
  if (xs.length === 1 && pointNear(xs[0], 0, 0))
    ok(`LL: X-cross at origin (tA=${xs[0].tA.toFixed(3)}, tB=${xs[0].tB.toFixed(3)})`);
  else fail(`LL: X-cross got ${JSON.stringify(xs)}`);
}

// Parallel (no intersection).
{
  const xs = intersectLineLine([0, 0], [1, 0], [0, 1], [1, 1]);
  if (xs.length === 0) ok('LL: parallel → 0 intersections');
  else fail(`LL: parallel got ${xs.length} intersections`);
}

// Endpoint-touching (T-join): a's endpoint sits on b.
{
  const xs = intersectLineLine([0, 0], [1, 0], [1, -1], [1, 1]);
  if (xs.length === 1 && xs[0].endpointA && pointNear(xs[0], 1, 0))
    ok('LL: T-junction at a\'s endpoint detected (endpointA=true)');
  else fail(`LL: T got ${JSON.stringify(xs)}`);
}

// Both at endpoints (corner of two segments meeting).
{
  const xs = intersectLineLine([0, 0], [1, 0], [1, 0], [1, 1]);
  if (xs.length === 1 && xs[0].endpointA && xs[0].endpointB && pointNear(xs[0], 1, 0))
    ok('LL: corner-meet (endpointA && endpointB)');
  else fail(`LL: corner-meet got ${JSON.stringify(xs)}`);
}

// No intersection within segment range (extended lines cross, segments don't).
{
  const xs = intersectLineLine([0, 0], [1, 0], [2, -1], [2, 1]);
  if (xs.length === 0) ok('LL: extended-cross outside segment range → 0');
  else fail(`LL: extended-cross got ${xs.length}`);
}

// ======================================================================
// LINE × QUAD
// ======================================================================

// Quad bulging upward (control above its chord), line through its peak.
// Quad: (0,0) → (1,2) (control) → (2,0). At s=0.5: (1, 1). So a
// horizontal line at y=1 crosses once at x=1.
{
  const xs = intersectLineQuad([-1, 1], [3, 1], [0, 0], [1, 2], [2, 0]);
  if (xs.length === 1 && near(xs[0].x, 1, 1e-6) && near(xs[0].y, 1, 1e-6))
    ok(`LQ: tangent at peak (1, 1) (tB=${xs[0].tB.toFixed(3)})`);
  else fail(`LQ: tangent-at-peak got ${JSON.stringify(xs)}`);
}

// Line crosses quad at two points (chord through interior of the arc).
// Same quad, line y = 0.5 → quad y at sQ satisfies
//   y(sQ) = 2·sQ·(1-sQ) = 0.5 → sQ²·-2 + sQ·2 - 0.5 = 0 → sQ²-sQ+0.25=0
//   → sQ = 0.5 (double root). Hmm, that's tangent. Use y=0.75:
//   2·sQ·(1-sQ) = 0.75 → sQ ∈ {0.5 - √(0.0625), 0.5 + √(0.0625)} = {0.25, 0.75}
{
  const xs = intersectLineQuad([-1, 0.75], [3, 0.75], [0, 0], [1, 1.5], [2, 0]);
  // quad y = 2·sQ·(1-sQ) · max-y, where max-y = 1.5/2·1 = 0.75 at sQ=0.5
  // Actually for control (1, 1.5), max y on the curve is 1.5/2 · 1 ... wait:
  //   y(s) = 2·(1-s)·s · 1.5 = 3s(1-s), max at s=0.5 gives 0.75.
  // So y=0.75 is exactly tangent → 1 intersection at (1, 0.75).
  if (xs.length === 1 && near(xs[0].x, 1, 1e-5) && near(xs[0].y, 0.75, 1e-5))
    ok(`LQ: tangent line at apex (1, 0.75)`);
  else fail(`LQ: tangent got ${JSON.stringify(xs)}`);
}

// Line below quad apex → 2 intersections.
{
  const xs = intersectLineQuad([-1, 0.375], [3, 0.375], [0, 0], [1, 1.5], [2, 0]);
  // 3s(1-s) = 0.375 → s² - s + 0.125 = 0 → s = 0.5 ± √(0.125) ≈ 0.146, 0.854.
  // x at those s: x(s) = 2s, so x ≈ 0.293, 1.707.
  if (xs.length === 2) {
    const xsSorted = xs.slice().sort((a, b) => a.x - b.x);
    if (near(xsSorted[0].x, 2*0.146, 1e-3) && near(xsSorted[1].x, 2*0.854, 1e-3))
      ok(`LQ: two intersections (x ≈ ${xsSorted[0].x.toFixed(3)}, ${xsSorted[1].x.toFixed(3)})`);
    else fail(`LQ: two-cross x's wrong: ${xsSorted.map(p => p.x.toFixed(3)).join(', ')}`);
  } else fail(`LQ: two-cross expected 2, got ${xs.length}`);
}

// Line endpoint touches quad endpoint (corner share).
{
  const xs = intersectLineQuad([0, 0], [-1, 0], [0, 0], [1, 1], [2, 0]);
  if (xs.length >= 1 && xs.some(p => p.endpointA && p.endpointB && pointNear(p, 0, 0)))
    ok('LQ: endpoint-on-endpoint detected');
  else fail(`LQ: endpoint-on-endpoint got ${JSON.stringify(xs)}`);
}

// ======================================================================
// LINE × CUBIC
// ======================================================================

// Cubic S-curve crossing a horizontal line three times.
// Cubic (0,1) (1,1) (1,-1) (2,-1)... actually easier: use a sigmoid-
// like S-curve. Bezier (0, -1) → (1, -1) → (1, 1) → (2, 1):
//   y(s) = (1-s)³(-1) + 3(1-s)²s(-1) + 3(1-s)s²(1) + s³(1)
//        = -(1-s)³ - 3(1-s)²s + 3(1-s)s² + s³
//        = -(1-s)²(1-s + 3s) + s²(3(1-s) + s) = -(1-s)²(1+2s) + s²(3-2s)
// At s=0.5: -0.25·2 + 0.25·2 = 0. y=0 at s=0.5.
// Horizontal line y=0 should hit at s=0.5 and possibly elsewhere.
{
  const xs = intersectLineCubic(
    [-1, 0], [3, 0],
    [0, -1], [1, -1], [1, 1], [2, 1],
  );
  // S-curve, monotone-ish, crosses y=0 once.
  if (xs.length === 1 && near(xs[0].y, 0, 1e-5))
    ok(`LC: S-curve crosses y=0 once (x=${xs[0].x.toFixed(3)}, tB=${xs[0].tB.toFixed(3)})`);
  else fail(`LC: S-curve got ${xs.length} hits: ${JSON.stringify(xs)}`);
}

// Cubic loop / 3-cross case: design a cubic whose y(s) has three
// crossings on y=0 within [0,1]. Make a sinusoidal-like shape:
//   y(s) = sin(2π·s) approximately via a cubic that overshoots.
// Easier: use a known cubic with 3 real roots at s=0.2, 0.5, 0.8.
// Construct y(s) = c·(s-0.2)·(s-0.5)·(s-0.8) — that's already in
// power form, convert to Bezier control points.
{
  // Power form: y(s) = c·(s³ - 1.5s² + 0.66s - 0.08).
  // c = 100 to amplify. y'(s) for chosen Bernstein form?
  // Power-form coefficients: (s³, s², s, 1) = (c, -1.5c, 0.66c, -0.08c).
  // Bezier control points (y) for power form (E, D, C, B):
  //   E (s³ coef) = -y0 + 3y1 - 3y2 + y3 = c
  //   D (s² coef) = 3y0 - 6y1 + 3y2     = -1.5c
  //   C (s¹ coef) = -3y0 + 3y1          = 0.66c
  //   B (s⁰ coef) = y0                  = -0.08c
  // Solve: y0 = -0.08c.
  //   -3y0 + 3y1 = 0.66c → y1 = 0.22c + y0 = 0.14c. With c=100, y1=14.
  //   3y0 - 6y1 + 3y2 = -1.5c → y2 = (-0.5c - y0 + 2y1)/1 = (-50 + 8 + 28)/1 = -14.
  //   -y0 + 3y1 - 3y2 + y3 = c → y3 = c + y0 - 3y1 + 3y2 = 100 - 8 - 42 - 42 = 8.
  const c = 100;
  const y0 = -0.08 * c, y1 = 0.14 * c, y2 = -0.14 * c, y3 = 0.08 * c;
  // X linear from 0..1 for clean lookup.
  const xs = intersectLineCubic(
    [-1, 0], [2, 0],
    [0, y0], [1/3, y1], [2/3, y2], [1, y3],
  );
  if (xs.length === 3) {
    const ts = xs.map(p => p.tB).sort((a, b) => a - b);
    if (near(ts[0], 0.2, 1e-4) && near(ts[1], 0.5, 1e-4) && near(ts[2], 0.8, 1e-4))
      ok(`LC: 3-cross cubic (tB = ${ts.map(t => t.toFixed(3)).join(', ')})`);
    else fail(`LC: 3-cross tB values: ${ts.map(t => t.toFixed(4)).join(', ')}`);
  } else fail(`LC: 3-cross expected 3 hits, got ${xs.length}`);
}

// Cubic line crossing exactly at an endpoint.
{
  const xs = intersectLineCubic(
    [0, 0], [-1, 0],
    [0, 0], [0.25, 0.5], [0.75, -0.5], [1, 0],
  );
  if (xs.some(p => p.endpointB && pointNear(p, 0, 0)))
    ok('LC: endpoint detected at cubic start (tB=0)');
  else fail(`LC: endpoint got ${JSON.stringify(xs)}`);
}

// ======================================================================
// LINE × ARC
// ======================================================================

// Horizontal line y=0 through the center of a quarter-arc (cx=0, cy=0,
// rx=1, ry=1, theta from 0 to π/2 — quarter from +x axis to +y axis).
// Line should intersect at (1, 0) — the arc's start.
{
  const arc = mkArc(0, 0, 1, 1, 0, Math.PI/2, 0, 0, 1);
  const xs = intersectLineArc([-2, 0], [2, 0], arc);
  if (xs.length === 1 && near(xs[0].x, 1) && near(xs[0].y, 0))
    ok(`LA: quarter arc at (1,0) (tB=${xs[0].tB.toFixed(3)})`);
  else fail(`LA: quarter got ${JSON.stringify(xs)}`);
}

// Vertical line x=0 through center → meets quarter arc at (0, 1).
{
  const arc = mkArc(0, 0, 1, 1, 0, Math.PI/2, 0, 0, 1);
  const xs = intersectLineArc([0, -2], [0, 2], arc);
  if (xs.length === 1 && near(xs[0].x, 0, 1e-9) && near(xs[0].y, 1))
    ok(`LA: quarter arc at (0,1)`);
  else fail(`LA: vertical got ${JSON.stringify(xs)}`);
}

// Chord through full circle (semicircle arc): line y=0.5 cuts a
// unit-radius half-arc theta in [0, π] at two points.
{
  const arc = mkArc(0, 0, 1, 1, 0, Math.PI, 0, 0, 1);
  const xs = intersectLineArc([-2, 0.5], [2, 0.5], arc);
  if (xs.length === 2) {
    const xsSorted = xs.slice().sort((a, b) => a.x - b.x);
    const expectX = Math.sqrt(1 - 0.25);  // = √0.75
    if (near(xsSorted[0].x, -expectX, 1e-6) && near(xsSorted[1].x, expectX, 1e-6))
      ok(`LA: chord y=0.5 hits semicircle at x=±${expectX.toFixed(3)}`);
    else fail(`LA: chord x's: ${xsSorted.map(p => p.x.toFixed(4)).join(', ')}`);
  } else fail(`LA: chord expected 2, got ${xs.length}`);
}

// Tangent: line y=1 touches top of unit circle (arc theta in [0, π]).
{
  const arc = mkArc(0, 0, 1, 1, 0, Math.PI, 0, 0, 1);
  const xs = intersectLineArc([-2, 1], [2, 1], arc);
  if (xs.length === 1 && near(xs[0].x, 0, 1e-5) && near(xs[0].y, 1, 1e-5))
    ok(`LA: tangent at top (0,1)`);
  else fail(`LA: tangent got ${JSON.stringify(xs)}`);
}

// Line misses arc entirely (above tangent).
{
  const arc = mkArc(0, 0, 1, 1, 0, Math.PI, 0, 0, 1);
  const xs = intersectLineArc([-2, 2], [2, 2], arc);
  if (xs.length === 0) ok('LA: line above arc → 0');
  else fail(`LA: miss got ${xs.length}`);
}

// Sweep restricts crossings: full circle's right half (θ∈[-π/2, π/2])
// vs a horizontal line at y=0 crosses at x=+1 only (the +x point;
// the -x point is outside the sweep).
{
  const arc = mkArc(0, 0, 1, 1, -Math.PI/2, Math.PI/2, 0, 0, 1);
  const xs = intersectLineArc([-2, 0], [2, 0], arc);
  if (xs.length === 1 && near(xs[0].x, 1) && near(xs[0].y, 0))
    ok(`LA: right-half arc, y=0 line hits only at +x`);
  else fail(`LA: right-half got ${JSON.stringify(xs)}`);
}

// Rotated ellipse arc: rx=2, ry=1, phi=π/4 (45° rotated). Sanity
// check that the transform-to-local-frame logic works.
{
  // Quarter of rotated ellipse, theta in [0, π/2].
  const arc = mkArc(0, 0, 2, 1, 0, Math.PI/2, Math.PI/4, 0, 1);
  // The ellipse's "start" (theta=0) point in world space:
  //   p(0) = (cx + cos(φ)·rx, cy + sin(φ)·rx) = (√2, √2).
  // A line passing through that point at any angle should produce at
  // least one intersection close to it.
  const xs = intersectLineArc([0, 0], [3, 3], arc);
  if (xs.length >= 1 && xs.some(p => Math.abs(p.x - Math.SQRT2) < 1e-4 && Math.abs(p.y - Math.SQRT2) < 1e-4))
    ok(`LA: rotated ellipse — line through (√2,√2) detects intersection`);
  else fail(`LA: rotated got ${JSON.stringify(xs)}`);
}

if (failures > 0) {
  console.error(`\nPATH-BOOLEAN SLICE-1 FAIL (${failures})`);
  process.exit(1);
}
console.log('\nPATH-BOOLEAN SLICE-1 PASS');
