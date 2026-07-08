// curvatureSmoke.mjs — signed endpoint curvature per segment type. Groundwork
// for the SVG2 `arcs` line join, which extends each stroke edge as an arc of
// the edge's curvature (derived from this centerline curvature at render time).
// Goldens are analytic; the C# port must match.

import { segEndpointCurvature } from '../../src/svg/textures.js';

const SEG_LINE = 0, SEG_QUAD = 1, SEG_CUBIC = 2, SEG_ARC = 3;
let failures = 0;
const near = (a, b) => Math.abs(a - b) < 1e-6;
const check = (label, got, want) => {
  if (near(got, want)) console.log(`ok ${label}: ${got.toFixed(6)}`);
  else { console.error(`FAIL ${label}: ${got.toFixed(6)} want ${want.toFixed(6)}`); failures++; }
};

// Line: straight → 0 curvature.
check('line', segEndpointCurvature({ type: SEG_LINE, p1: [0, 0], p2: [5, 3] }, true), 0);

// Quadratic p1(0,0) c(1,1) p2(2,0): symmetric arch, κ = cross(B',B'')/|B'|³.
// B'(0)=(2,2), B''=(0,-4) → cross=-8, |B'|³=(2√2)³ → κ = -1/(2√2). Same at t=1.
const quad = { type: SEG_QUAD, p1: [0, 0], p2: [1, 1], p3: [2, 0] };
check('quad@start', segEndpointCurvature(quad, true), -1 / (2 * Math.SQRT2));
check('quad@end', segEndpointCurvature(quad, false), -1 / (2 * Math.SQRT2));

// Cubic that is a straight line (collinear control points) → 0 curvature.
check('cubic-straight',
  segEndpointCurvature({ type: SEG_CUBIC, p1: [0, 0], p2: [1, 0], p3: [2, 0], p4: [3, 0] }, true), 0);

// Circle r=10: κ = ±1/r, signed by sweep direction (CCW +, CW −).
check('circleCCW', segEndpointCurvature(
  { type: SEG_ARC, cx: 0, cy: 0, rx: 10, ry: 10, phi: 0, theta_start: 0, theta_end: Math.PI / 2 }, true), 0.1);
check('circleCW', segEndpointCurvature(
  { type: SEG_ARC, cx: 0, cy: 0, rx: 10, ry: 10, phi: 0, theta_start: 0, theta_end: -Math.PI / 2 }, true), -0.1);

// Ellipse rx=2, ry=1 (rotation ignored by curvature): major-axis end κ = a/b² = 2,
// minor-axis end κ = b/a² = 1/4.
const ell = { type: SEG_ARC, cx: 0, cy: 0, rx: 2, ry: 1, phi: 0.7, theta_start: 0, theta_end: Math.PI / 2 };
check('ellipse@major(θ=0)', segEndpointCurvature(ell, true), 2.0);
check('ellipse@minor(θ=π/2)', segEndpointCurvature(ell, false), 0.25);

console.log();
if (failures === 0) { console.log('CURVATURE PASS'); process.exit(0); }
console.log(`CURVATURE FAIL (${failures})`); process.exit(1);
