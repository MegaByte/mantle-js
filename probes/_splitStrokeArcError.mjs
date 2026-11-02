// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _splitStrokeArcError — the split-stroke path stores every segment as a CUBIC, and for arcs that
// is an approximation.
//
// buildSplitStroke normalises its input before packing: _noRQuad turns every rational quadratic
// (an exact circular/elliptical arc) into a cubic, and elevateToCubic raises lines and quads. The
// elevations are exact — degree elevation changes the representation, not the curve. The arc
// conversion is not: a circular arc has no cubic form, so this interpolates one through t=1/3 and
// 2/3 and accepts the deviation.
//
// That deviation is constant in EM, so it grows without bound in PIXELS as the view zooms — the same
// property that makes a fixed-iteration closest point unacceptable for quadratics (see the note
// above quadClosestT). And it is paid on a path where every other route draws arcs NATIVELY: the
// band walk has its own ARCS sub-loop.
//
// Reached by stroked arcs in composed morphs (_ensureMorphSplitStrokes). The incremental paint
// stroke is polylines, where elevation is exact and only costs the wrong kernel.
//
// How wrong is rquadToCubic (splitStroke.js:31)? An interpolating cubic through t=1/3, 2/3 of a
// rational quadratic. Exact for a LINE or a QUAD (degree elevation); a circular arc has no cubic
// form, so this one is an approximation — on a path that renders arcs NATIVELY everywhere else.
const at = (P0, P1, P2, w, t) => {
  const a = (1 - t) * (1 - t),
    b = 2 * (1 - t) * t * w,
    c = t * t,
    d = a + b + c;
  return [(a * P0[0] + b * P1[0] + c * P2[0]) / d, (a * P0[1] + b * P1[1] + c * P2[1]) / d];
};
const toCubic = (P0, P1, P2, w) => {
  const Qa = at(P0, P1, P2, w, 1 / 3),
    Qb = at(P0, P1, P2, w, 2 / 3);
  return [
    P0,
    [
      (-5 * P0[0] + 18 * Qa[0] - 9 * Qb[0] + 2 * P2[0]) / 6,
      (-5 * P0[1] + 18 * Qa[1] - 9 * Qb[1] + 2 * P2[1]) / 6,
    ],
    [
      (2 * P0[0] - 9 * Qa[0] + 18 * Qb[0] - 5 * P2[0]) / 6,
      (2 * P0[1] - 9 * Qa[1] + 18 * Qb[1] - 5 * P2[1]) / 6,
    ],
    P2,
  ];
};
const evalCub = (C, t) => {
  const m = 1 - t;
  return [
    m * m * m * C[0][0] + 3 * m * m * t * C[1][0] + 3 * m * t * t * C[2][0] + t * t * t * C[3][0],
    m * m * m * C[0][1] + 3 * m * m * t * C[1][1] + 3 * m * t * t * C[2][1] + t * t * t * C[3][1],
  ];
};
console.log('  rquad -> cubic deviation, unit-radius arc (em, i.e. fraction of the radius)');
console.log('    sweep     max deviation     at 100em radius     at 1000x zoom of a 1em stroke');
for (const deg of [30, 60, 90, 120, 150, 180]) {
  const a = (deg * Math.PI) / 180,
    R = 1;
  // Circular arc as a rational quadratic: P0,P2 on the circle, P1 the tangent intersection, w=cos(a/2)
  const P0 = [Math.cos(-a / 2), Math.sin(-a / 2)],
    P2 = [Math.cos(a / 2), Math.sin(a / 2)];
  const w = Math.cos(a / 2),
    P1 = [1 / w, 0];
  const C = toCubic(P0, P1, P2, w);
  let worst = 0;
  for (let i = 0; i <= 2000; i++) {
    const t = i / 2000;
    const q = evalCub(C, t);
    const d = Math.abs(Math.hypot(q[0], q[1]) - R);
    if (d > worst) worst = d;
  } // true arc is the unit circle
  console.log(
    `    ${String(deg + '°').padEnd(9)} ${worst.toExponential(3).padStart(13)} ${(worst * 100).toExponential(3).padStart(19)} em ${(worst * 1000).toFixed(3).padStart(14)} px`,
  );
}
