// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// pathBooleanMonotoneSmoke — y-monotone subdivision preprocessor.

import {
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  SEG_ARC,
  mkLine,
  mkQuad,
  mkCubic,
  mkArc,
} from '../src/svg/segment.js';
import { subdivideYMonotone } from '../src/svg/pathBoolean/subdivide.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ----- LINE: always monotone -----
{
  const out = subdivideYMonotone(mkLine([0, 0], [1, 1]));
  if (out.length === 1) ok('LINE: passthrough (always monotone)');
  else fail(`LINE: expected 1, got ${out.length}`);
}

// ----- QUAD: monotone in y (control y values increasing) -----
{
  const out = subdivideYMonotone(mkQuad([0, 0], [1, 0.5], [2, 1]));
  if (out.length === 1) ok('QUAD: monotone passthrough');
  else fail(`QUAD: monotone got ${out.length}`);
}

// ----- QUAD: dips at apex (peak in middle) → 2 sub-segments -----
//   Power form: ay = 0, by = 2(p2.y - p1.y) = 2(2 - 0) = 4,
//   cy = 0 - 4 + 0 = -4.
//   dy/ds = 4 - 8s = 0 → s = 0.5.
{
  const out = subdivideYMonotone(mkQuad([0, 0], [1, 2], [2, 0]));
  if (out.length === 2) {
    // Both sub-quads should be y-monotone. Verify by checking
    // each decomposes to length 1.
    const recheckLeft = subdivideYMonotone(out[0]);
    const recheckRight = subdivideYMonotone(out[1]);
    if (recheckLeft.length === 1 && recheckRight.length === 1)
      ok(`QUAD: peaked → 2 sub-segs, each y-monotone`);
    else fail(`QUAD: sub-segs not monotone: ${recheckLeft.length}, ${recheckRight.length}`);
  } else fail(`QUAD: peaked got ${out.length}`);
}

// ----- CUBIC: S-curve (2 y-extrema) → 3 sub-segments -----
//   Cubic with y'(s) = quadratic having 2 roots in (0, 1).
//   Use a cubic that overshoots up then down: y0=0, y1=2, y2=-2, y3=0.
//   Power form: by=6, cy=3(0-4+(-2))=-18, dy=-0+6-(-6)+0=12.
//   y'(s) = 6 + 2(-18)s + 3(12)s² = 6 - 36s + 36s².
//   Discriminant: 36² - 4·36·6 = 1296 - 864 = 432. roots ≈ 0.211, 0.789.
{
  const out = subdivideYMonotone(mkCubic([0, 0], [1, 2], [2, -2], [3, 0]));
  if (out.length === 3) {
    // Each sub-segment should be monotone (no further split).
    let allMonotone = true;
    for (const s of out) {
      if (subdivideYMonotone(s).length !== 1) {
        allMonotone = false;
        break;
      }
    }
    if (allMonotone) ok(`CUBIC: S-curve → 3 sub-segs, each y-monotone`);
    else fail(`CUBIC: sub-segs not all monotone`);
  } else fail(`CUBIC: S-curve got ${out.length}`);
}

// ----- ARC: quarter arc, axis-aligned, no y-extrema in (0, 1) -----
//   Quarter arc from (1, 0) to (0, 1): θ in [0, π/2].
//   y(θ) = sin(θ). dy/dθ = cos(θ). Zeros at θ = ±π/2 — only π/2 is
//   at the endpoint, none interior. So 1 sub-segment.
{
  const arc = mkArc(0, 0, 1, 1, 0, Math.PI / 2, 0, 0, 1);
  const out = subdivideYMonotone(arc);
  if (out.length === 1) ok('ARC: quarter arc, no interior extremum → 1');
  else fail(`ARC: quarter got ${out.length}`);
}

// ----- ARC: full unit circle starting at θ=0, going through y=±1 -----
//   Full circle θ in [0, 2π]. y-extrema at θ=π/2 (top, y=+1) and
//   θ=3π/2 (bottom, y=-1). Both interior → 3 sub-segments.
{
  const arc = mkArc(0, 0, 1, 1, 0, 2 * Math.PI, 0, 0, 1);
  const out = subdivideYMonotone(arc);
  if (out.length === 3) {
    let allMonotone = true;
    for (const s of out) {
      if (subdivideYMonotone(s).length !== 1) {
        allMonotone = false;
        break;
      }
    }
    if (allMonotone) ok('ARC: full circle → 3 sub-arcs, each y-monotone');
    else fail('ARC: sub-arcs not monotone');
  } else fail(`ARC: full circle got ${out.length}`);
}

// ----- ARC: rotated ellipse, semicircle -----
//   rx=2 ry=1 phi=π/4. Semicircle θ in [0, π].
//   y(θ) = sin(phi)·rx·cos(θ) + cos(phi)·ry·sin(θ)
//        = (√2/2)·2·cos(θ) + (√2/2)·1·sin(θ) = √2·cos(θ) + (√2/2)·sin(θ).
//   dy/dθ = -√2·sin(θ) + (√2/2)·cos(θ) = 0 → tan(θ) = 1/2 → θ ≈ 0.4636.
//   In (0, π) → 1 interior extremum → 2 sub-segments.
{
  const arc = mkArc(0, 0, 2, 1, 0, Math.PI, Math.PI / 4, 0, 1);
  const out = subdivideYMonotone(arc);
  if (out.length === 2) ok('ARC: rotated ellipse semicircle → 2 sub-segs');
  else fail(`ARC: rotated semi got ${out.length}`);
}

if (failures > 0) {
  console.error(`\nPATH-BOOLEAN MONOTONE FAIL (${failures})`);
  process.exit(1);
}
console.log('\nPATH-BOOLEAN MONOTONE PASS');
