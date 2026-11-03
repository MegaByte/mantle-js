// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbInteriorSignSmoke — guards the TRAVEL-FRAME interiorSign verification on LINE-LESS
// contours (verifyInteriorSign in lbContour.js).
//
// calibrateInterior's ctrl-side sliver probe is only pinned to the travel-frame
// convention ("+1 ⇔ fill on the left-perp of travel") by a verification probe. Verified
// only against the longest LINE seg, a contour with NO lines (glyph bowls: a font's '8')
// would go unverified, and the kind-10/12 end metadata built from it would carry
// inverted outward normals and convex↔reflex corner types — kind-12 bands would then
// claim waist pixels at ~0.05 coverage over interior truth 0.94 (white waist holes at
// text scales).
//
// This asserts, on a synthetic line-less quad-only "peanut" (two bulges + two REFLEX
// waist notches) in both traversal orientations:
//   (a) verifyInteriorSign returns the travel-frame truth (fill side of a probed point);
//   (b) edgeEndMeta classifies the waist notch as REFLEX (type −1) and a bulge seam as
//       tangent-continuous-or-convex (type ≥ 0) — the classifications the band's corner
//       machinery keys on.
import { mkQuad } from '../src/primitives/seg.js';
import {
  calibrateInterior,
  verifyInteriorSign,
  segTangents,
  edgeEndMeta,
  chordRing,
  pointInPoly,
  rayWinding,
} from '../src/geom/lbContour.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};

// Peanut: bulges left/right, reflex notches top/bottom at (0, ±20). All quads, no lines.
// Outline (CCW in math coords): from top notch (0,20) via left bulge to bottom notch
// (0,-20) via right bulge back. Each side = two quads meeting at the bulge apex.
const peanut = (flip) => {
  const F = flip ? -1 : 1; // flip = reverse orientation by mirroring x
  const P = (x, y) => [x * F, y];
  return [
    [
      mkQuad(P(0, 20), P(-55, 45), P(-70, 0)), // top notch → left apex (bulge out)
      mkQuad(P(-70, 0), P(-55, -45), P(0, -20)), // left apex → bottom notch
      mkQuad(P(0, -20), P(55, -45), P(70, 0)), // bottom notch → right apex
      mkQuad(P(70, 0), P(55, 45), P(0, 20)), // right apex → top notch
    ],
  ];
};

for (const flip of [false, true]) {
  const contours = peanut(flip);
  const segs = contours[0];
  const all = contours.flat();
  const inkAt = (p) => rayWinding(all, p[0], p[1] + 1e-4) !== 0;
  // ground truth for the travel frame: probe both perp sides at the first seg's midpoint
  // chord tangent (a quad's secant at t=0.5 is exact enough for a side test)
  const s0 = segs[0];
  const q = (t) => {
    const u = 1 - t;
    return [
      u * u * s0.p1[0] + 2 * u * t * s0.p2[0] + t * t * s0.p3[0],
      u * u * s0.p1[1] + 2 * u * t * s0.p2[1] + t * t * s0.p3[1],
    ];
  };
  const m = q(0.5),
    m1 = q(0.55);
  let dx = m1[0] - m[0],
    dy = m1[1] - m[1];
  const L = Math.hypot(dx, dy);
  dx /= L;
  dy /= L;
  const truth = inkAt([m[0] - dy * 2, m[1] + dx * 2]) ? 1 : -1; // fill on left-perp ⇒ +1
  const calib = calibrateInterior(segs, inkAt);
  const verified = verifyInteriorSign(segs, inkAt, calib);
  check(
    verified === truth,
    `${flip ? 'flipped' : 'forward'}: verifyInteriorSign = travel-frame truth (${verified} == ${truth}; raw calibrate ${calib})`,
  );
  // corner classifications with the verified sign
  const tg = segs.map(segTangents);
  const notch = edgeEndMeta(segs, tg, 0, 0, verified); // seg 0 start = the top notch
  const apex = edgeEndMeta(segs, tg, 0, 1, verified); // seg 0 end = the left apex seam
  check(
    notch.type === -1,
    `${flip ? 'flipped' : 'forward'}: waist notch classified REFLEX (type ${notch.type})`,
  );
  check(
    apex.type >= 0,
    `${flip ? 'flipped' : 'forward'}: bulge apex seam not reflex (type ${apex.type})`,
  );
}
if (fail) {
  console.error(`LB-INTERIOR-SIGN FAIL (${fail})`);
  process.exit(1);
}
console.log('LB-INTERIOR-SIGN PASS');
