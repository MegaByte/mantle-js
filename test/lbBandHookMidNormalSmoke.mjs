// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbBandHookMidNormalSmoke -- the closed form behind the curve band's hook partition (probes/lbAccuracy/_lbKernel.mjs hookMidLine,
// the shader's aSide12 / bSide12 block): the normal line at the point of a rational quad whose normal bisects its end normals.
// Checked against a bisection on the arc's own normal angle, over random pieces that turn 91 to 178 degrees, with weights from
// a thin ellipse to a hyperbola, end tangent lengths a thousand to one, and the whole piece scaled by 2^-40 to 2^40 (the
// answer is a length ratio, so no absolute epsilon may enter). The line is held to a relative 1e-9 of the chord; and each side
// of it must hold the arc points before the bisecting normal and after it, so the end tests cannot cut an arc pixel.
import { hookMidLine } from '../probes/lbAccuracy/_lbKernel.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
let seed = 12345;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const cross = (p, q) => p[0] * q[1] - p[1] * q[0],
  dot = (p, q) => p[0] * q[0] + p[1] * q[1];

let worst = 0,
  worstSide = 0,
  n = 0;
for (let it = 0; it < 4000; it++) {
  const turn = ((91 + rnd() * 87) * Math.PI) / 180,
    left = rnd() < 0.5 ? 1 : -1;
  const lu = Math.exp((rnd() * 2 - 1) * 3.5),
    lv = Math.exp((rnd() * 2 - 1) * 3.5);
  const w = Math.exp((rnd() * 2 - 1) * 1.5),
    sc = 2 ** Math.round((rnd() * 2 - 1) * 40),
    ph = rnd() * 2 * Math.PI;
  // end tangents at the turn: u at angle ph, v at ph + turn (left) or ph - turn
  const tu = [Math.cos(ph), Math.sin(ph)],
    tv = [Math.cos(ph + left * turn), Math.sin(ph + left * turn)];
  const a = [0, 0],
    u = [tu[0] * lu * sc, tu[1] * lu * sc],
    c = u,
    v = [tv[0] * lv * sc, tv[1] * lv * sc],
    b = [c[0] + v[0], c[1] + v[1]];
  // outward normal: to the right of the travel direction on a left turn, to the left on a right turn
  const nrm = (t) => (left > 0 ? [t[1], -t[0]] : [-t[1], t[0]]);
  const nOA = nrm(tu),
    nOB = nrm(tv);
  const P = (s) => {
    const g = 1 - s,
      W = g * g + 2 * w * s * g + s * s;
    return [(2 * w * s * g * c[0] + s * s * b[0]) / W, (2 * w * s * g * c[1] + s * s * b[1]) / W];
  };
  const T = (s) => {
    const g = 1 - s,
      p1 = g * (w * g + s),
      p2 = s * (g + w * s);
    return [p1 * u[0] + p2 * v[0], p1 * u[1] + p2 * v[1]];
  };
  const nAt = (s) => {
    const t = T(s),
      l = Math.hypot(t[0], t[1]);
    return nrm([t[0] / l, t[1] / l]);
  };
  const nm = [nOA[0] + nOB[0], nOA[1] + nOB[1]],
    nl = Math.hypot(nm[0], nm[1]),
    nM = [nm[0] / nl, nm[1] / nl];
  // the arc's normal turns monotonically from nOA to nOB: bisect cross(n(s), nM) for its sign change
  const sgn = (s) => cross(nAt(s), nM) * (left > 0 ? 1 : -1);
  let lo = 0,
    hi = 1;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (sgn(mid) > 0) lo = mid;
    else hi = mid;
  }
  const sStar = (lo + hi) / 2,
    q = P(sStar);
  const m = hookMidLine(a, b, c, w, nOA, nOB),
    chord = Math.hypot(b[0], b[1]);
  const offTrue = cross(nM, q);
  const err = Math.abs(m.off - offTrue) / chord;
  worst = Math.max(worst, err);
  // sides: arc points well before and after the bisecting normal fall on a's and b's sides of the line
  let sideBad = 0;
  for (const s of [
    0,
    0.01,
    sStar * 0.5,
    sStar * 0.9,
    sStar * 0.999,
    sStar + (1 - sStar) * 0.001,
    sStar + (1 - sStar) * 0.1,
    sStar + (1 - sStar) * 0.5,
    0.99,
    1,
  ]) {
    const p = P(s),
      side = m.side(p),
      before = s < sStar;
    if (Math.abs(side) < 1e-12 * chord) continue;
    if ((before && side > 0) || (!before && side < 0)) sideBad++;
  }
  worstSide += sideBad;
  n++;
}
ok(
  worst < 1e-9,
  `the bisecting normal's line is the arc's own: worst offset error ${worst.toExponential(2)} of the chord over ${n} pieces`,
);
ok(
  worstSide === 0,
  `the arc's points fall on the side of the line their parameter says (${worstSide} wrong)`,
);
console.log(
  fail ? `lbBandHookMidNormalSmoke FAIL (${fail})` : 'lbBandHookMidNormalSmoke: all checks passed',
);
process.exit(fail ? 1 : 0);
