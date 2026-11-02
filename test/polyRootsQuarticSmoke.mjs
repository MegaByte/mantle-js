// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// polyRootsQuarticSmoke — solveQuartic returns the roots of the quartic it is given.
//
// THE HAZARD. Ferrari's method writes the depressed quartic as (u² + y)² = (w·u − q/(2w))² and
// splits it into u² − w·u + (y + q/(2w)) = 0 and u² + w·u + (y − q/(2w)) = 0. With the two constant
// terms swapped, every quartic whose cubic term survives depression (q ≠ 0) comes back with roots it
// does not have, and only the biquadratic branch (q = 0) is right -- which is the symmetric
// configuration a hand-written test tends to pick, hence the random quartics here. Three intersection
// kernels and the stroke hit test solve quartics with it: quad x quad, quad x arc and arc x arc
// crossings, and the closest point on an elliptical arc; two circles that plainly cross, drawn as
// arcs, would report no crossing at all.
//
// (a) random quartics with four real roots, two real roots and a complex pair, none, and a double root
// (b) the same polynomials scaled by 1e-6..1e6 (the roots do not move)
// (c) the consumers against independent references: quad x quad and quad x arc crossings against a
//     dense polyline, arc x arc against circle-circle geometry, the hit test's closest point on an
//     ellipse against a dense sample
import {
  solveCubic,
  solveQuartic,
  solvePolyInUnitInterval,
} from '../src/svg/pathBoolean/polyRoots.js';
import { intersectSegments } from '../src/svg/pathBoolean/intersect/index.js';
import { mkArc } from '../src/svg/segment.js';
import { closest } from '../src/hitTest/curveGeom.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
let seed = 0x2545f491;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const mul = (p, q) => {
  const o = new Array(p.length + q.length - 1).fill(0);
  p.forEach((a, i) =>
    q.forEach((b, j) => {
      o[i + j] += a * b;
    }),
  );
  return o;
};
const sameRoots = (got, want, eps) =>
  got.length === want.length &&
  got
    .slice()
    .sort((a, b) => a - b)
    .every((g, i) => Math.abs(g - want[i]) <= eps);

console.log('(a) quartics with known roots');
const families = {
  'four real roots': () => {
    const r = [0, 1, 2, 3].map(() => -3 + 6 * rnd());
    let p = [1];
    for (const x of r) p = mul(p, [-x, 1]);
    return { p, r };
  },
  'two real roots and a complex pair': () => {
    const a = -3 + 6 * rnd(),
      b = -3 + 6 * rnd(),
      re = -2 + 4 * rnd(),
      im = 0.2 + 2 * rnd();
    return { p: mul(mul([-a, 1], [-b, 1]), [re * re + im * im, -2 * re, 1]), r: [a, b] };
  },
  'no real roots': () => {
    const q1 = [0.3 + rnd(), -2 * (rnd() - 0.5), 1],
      q2 = [0.3 + rnd() * 2, -2 * (rnd() - 0.5), 1];
    return {
      p: mul(
        q1.map((v, i) => (i === 0 ? v + (q1[1] * q1[1]) / 4 : v)),
        q2.map((v, i) => (i === 0 ? v + (q2[1] * q2[1]) / 4 : v)),
      ),
      r: [],
    };
  },
};
const cases = [];
for (const [name, gen] of Object.entries(families)) {
  let bad = 0;
  for (let k = 0; k < 500; k++) {
    const { p, r } = gen();
    const lead = 0.5 + 3 * rnd() * (rnd() < 0.5 ? -1 : 1);
    const P = p.map((v) => v * lead);
    cases.push({ P, r });
    if (
      !sameRoots(
        solveQuartic(P[4], P[3], P[2], P[1], P[0]),
        r.slice().sort((a, b) => a - b),
        1e-6,
      )
    )
      bad++;
  }
  check(bad === 0, `${name}: ${500 - bad}/500 solved`);
}
{
  const d = 0.7,
    e = -1.3,
    f = 2.1; // (u - 0.7)² (u + 1.3)(u - 2.1)
  const P = mul(mul([-d, 1], [-d, 1]), mul([-e, 1], [-f, 1]));
  const got = solveQuartic(P[4], P[3], P[2], P[1], P[0]).sort((a, b) => a - b);
  const distinct = got.filter((v, i) => i === 0 || v - got[i - 1] > 1e-6);
  check(
    distinct.length === 3 && [e, d, f].every((x) => got.some((g) => Math.abs(g - x) < 1e-6)),
    `a double root: ${got.map((v) => v.toFixed(6)).join(', ')}`,
  );
}

console.log('(b) scaled polynomials');
for (const s of [1e-6, 1e-3, 1e3, 1e6]) {
  const bad = cases.filter(
    ({ P, r }) =>
      !sameRoots(
        solveQuartic(P[4] * s, P[3] * s, P[2] * s, P[1] * s, P[0] * s),
        r.slice().sort((a, b) => a - b),
        1e-6,
      ),
  ).length;
  check(bad === 0, `coefficients x ${s}: ${cases.length - bad}/${cases.length} solved`);
}

console.log('(c) the consumers');
const evalSeg = (s, t) => {
  if (s.type === 1) {
    const u = 1 - t;
    return [0, 1].map((k) => u * u * s.p1[k] + 2 * u * t * s.p2[k] + t * t * s.p3[k]);
  }
  const th = s.theta_start + (s.theta_end - s.theta_start) * t,
    cp = Math.cos(s.phi),
    sp = Math.sin(s.phi);
  const x = s.rx * Math.cos(th),
    y = s.ry * Math.sin(th);
  return [s.cx + x * cp - y * sp, s.cy + x * sp + y * cp];
};
// Dense polyline reference: crossings of the two sampled curves (measurement only), well away from
// their ends so an endpoint convention cannot decide the count.
function refCrossings(A, B, N = 1200) {
  const pa = [],
    pb = [];
  for (let i = 0; i <= N; i++) {
    pa.push(evalSeg(A, i / N));
    pb.push(evalSeg(B, i / N));
  }
  const out = [];
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const p = pa[i],
        p2 = pa[i + 1],
        q = pb[j],
        q2 = pb[j + 1];
      const rx = p2[0] - p[0],
        ry = p2[1] - p[1],
        sx = q2[0] - q[0],
        sy = q2[1] - q[1],
        den = rx * sy - ry * sx;
      if (den === 0) continue;
      const t = ((q[0] - p[0]) * sy - (q[1] - p[1]) * sx) / den,
        u = ((q[0] - p[0]) * ry - (q[1] - p[1]) * rx) / den;
      if (t >= 0 && t < 1 && u >= 0 && u < 1) out.push([(i + t) / N, (j + u) / N]);
    }
  return out;
}
function kernelAgainstReference(name, gen, n) {
  let bad = 0,
    total = 0;
  for (let k = 0; k < n; k++) {
    const [A, B] = gen();
    const ref = refCrossings(A, B);
    if (ref.some(([s, u]) => s < 0.01 || s > 0.99 || u < 0.01 || u > 0.99)) {
      k--;
      continue;
    }
    total += ref.length;
    const hits = intersectSegments(A, B);
    const ok =
      hits.length === ref.length &&
      ref.every(([s, u]) =>
        hits.some((h) => Math.abs(h.tA - s) < 2e-3 && Math.abs(h.tB - u) < 2e-3),
      );
    if (!ok) bad++;
  }
  check(bad === 0, `${name}: ${n - bad}/${n} pairs match the reference (${total} crossings)`);
}
const P2 = () => [-10 + 20 * rnd(), -10 + 20 * rnd()];
kernelAgainstReference(
  'quad x quad',
  () => [
    { type: 1, p1: P2(), p2: P2(), p3: P2() },
    { type: 1, p1: P2(), p2: P2(), p3: P2() },
  ],
  150,
);
kernelAgainstReference(
  'quad x arc',
  () => {
    const r = 3 + 6 * rnd(),
      q = 1.5 + 5 * rnd(),
      t0 = 6 * rnd();
    return [
      { type: 1, p1: P2(), p2: P2(), p3: P2() },
      mkArc(-3 + 6 * rnd(), -3 + 6 * rnd(), r, q, t0, t0 + 1 + 3 * rnd(), 2 * rnd(), 0, 1),
    ];
  },
  150,
);
kernelAgainstReference(
  'arc x arc (ellipses)',
  () => {
    const mk = () => {
      const t0 = 6 * rnd();
      return mkArc(
        -3 + 6 * rnd(),
        -3 + 6 * rnd(),
        3 + 6 * rnd(),
        2 + 6 * rnd(),
        t0,
        t0 + 1 + 4 * rnd(),
        2 * rnd(),
        0,
        1,
      );
    };
    return [mk(), mk()];
  },
  150,
);
{
  // Two circles that plainly cross: the crossings are known in closed form.
  const A = mkArc(0, 0, 10, 10, 0, 2 * Math.PI - 0.1, 0, 0, 1),
    B = mkArc(12, 3, 8, 8, 0.05, 2 * Math.PI - 0.05, 0, 0, 1);
  const d = Math.hypot(12, 3),
    a = (100 - 64 + d * d) / (2 * d),
    h = Math.sqrt(100 - a * a),
    ex = 12 / d,
    ey = 3 / d;
  const want = [
    [a * ex - h * ey, a * ey + h * ex],
    [a * ex + h * ey, a * ey - h * ex],
  ];
  const hits = intersectSegments(A, B);
  check(
    hits.length === 2 &&
      want.every((w) => hits.some((p) => Math.hypot(p.x - w[0], p.y - w[1]) < 1e-9)),
    `two crossing circles as arcs: ${hits.length} crossings at ${hits.map((p) => `(${p.x.toFixed(4)},${p.y.toFixed(4)})`).join(' ')}`,
  );
}
{
  let bad = 0;
  for (let k = 0; k < 300; k++) {
    const rx = 2 + 8 * rnd(),
      ry = 1 + 6 * rnd(),
      phi = 3 * rnd(),
      cx = -2 + 4 * rnd(),
      cy = -2 + 4 * rnd(),
      th0 = 6 * rnd(),
      th1 = th0 + 0.5 + 4 * rnd();
    const cp = Math.cos(phi),
      sp = Math.sin(phi);
    const at = (th) => [
      cx + rx * Math.cos(th) * cp - ry * Math.sin(th) * sp,
      cy + rx * Math.cos(th) * sp + ry * Math.sin(th) * cp,
    ];
    const [x0, y0] = at(th0),
      [x1, y1] = at(th1);
    const s = { t: 3, cx, cy, rx, ry, th0, th1, cp, sp, x0, y0, x1, y1 };
    const px = -12 + 24 * rnd(),
      py = -12 + 24 * rnd();
    let best = Infinity;
    for (let i = 0; i <= 20000; i++) {
      const p = at(th0 + ((th1 - th0) * i) / 20000);
      best = Math.min(best, (p[0] - px) ** 2 + (p[1] - py) ** 2);
    }
    const got = closest(s, px, py).d2;
    if (Math.abs(Math.sqrt(got) - Math.sqrt(best)) > 1e-3) bad++;
  }
  check(
    bad === 0,
    `hit test, closest point on an elliptical arc: ${300 - bad}/300 match a dense sample`,
  );
}

// Interval roots: scale, multiplicity, near-tangent signs and production callers.
{
  const families = [
    [0.25],
    [0.125, 0.375, 0.625, 0.875],
    [0.1, 0.2, 0.3, 0.7, 0.8, 0.9],
    [0, 0.25, 1],
    [0.5, 0.5],
    [0.25, 0.25, 0.75],
    [0.25, 0.25, 0.25, 0.875],
    [0, 0, 1, 1],
    [0.25, 0.25, 0.75, 0.75],
    [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
  ];
  let bad = 0,
    total = 0;
  for (const factors of families)
    for (const exponent of [-1000, -80, -30, 0, 30, 80, 1000]) {
      let p = [1];
      for (const root of factors) p = mul(p, [-root, 1]);
      const want = [...new Set(factors)].sort((a, b) => a - b);
      const got = solvePolyInUnitInterval(p.map((c) => c * 2 ** exponent));
      total++;
      if (!sameRoots(got, want, 1e-8)) bad++;
    }
  for (const exponent of [-1000, -80, 0, 80, 1000]) {
    const scale = 2 ** exponent;
    for (const p of [
      [1, 0, 1],
      [0.25 + Number.EPSILON, -1, 1],
    ]) {
      total++;
      if (solvePolyInUnitInterval(p.map((c) => c * scale)).length) bad++;
    }
    const delta = Math.sqrt(Number.EPSILON);
    total++;
    if (
      !sameRoots(
        solvePolyInUnitInterval([0.25 - Number.EPSILON, -1, 1].map((c) => c * scale)),
        [0.5 - delta, 0.5 + delta],
        1e-10,
      )
    )
      bad++;
  }
  check(bad === 0, `interval roots: ${total - bad}/${total} scale, multiplicity and sign controls`);
  let callerBad = 0;
  for (const exponent of [-20, 0, 20]) {
    const scale = 2 ** exponent;
    // x(t)=(2t-1)^3, y(t)=1: a sixth-order contact with the unit circle.
    const cubic = {
      type: 2,
      p1: [-scale, scale],
      p2: [scale, scale],
      p3: [-scale, scale],
      p4: [scale, scale],
    };
    const arc = mkArc(0, 0, scale, scale, 0, 2 * Math.PI, 0, 0, 1);
    const hits = intersectSegments(cubic, arc);
    if (
      hits.length !== 1 ||
      Math.abs(hits[0].tA - 0.5) > 1e-8 ||
      Math.abs(hits[0].y / scale - 1) > 1e-8
    )
      callerBad++;
    const segment = {
      t: 2,
      x0: -scale,
      y0: scale,
      c1x: scale,
      c1y: scale,
      c2x: -scale,
      c2y: scale,
      x1: scale,
      y1: scale,
    };
    const foot = closest(segment, 0, 2 * scale);
    if (Math.abs(foot.d2 / (scale * scale) - 1) > 1e-10) callerBad++;
  }
  check(
    callerBad === 0,
    'cubic/arc sixth-order tangency and cubic closest point at three coordinate scales',
  );
}

// Small distinct cubic roots must remain distinct near an ellipse evolute.
{
  let bad = 0;
  for (const exponent of [-1000, -20, 0, 20, 1000]) {
    const scale = 2 ** exponent;
    const roots = solveCubic(scale, 0, -1e-8 * scale, 0);
    if (!sameRoots(roots, [-1e-4, 0, 1e-4], 1e-12)) bad++;
  }
  check(bad === 0, 'three small distinct cubic roots survive coefficient scaling');
  let feet = 0;
  for (const exponent of [-20, 0, 20])
    for (const ratio of [16, 100])
      for (const phi of [0, 0.3]) {
        const rx = 2 ** exponent,
          ry = rx / ratio,
          A = 0.999;
        const cp = Math.cos(phi),
          sp = Math.sin(phi),
          q = rx * A * (1 - 1 / ratio ** 2);
        const s = {
          t: 3,
          cx: 0,
          cy: 0,
          rx,
          ry,
          cp,
          sp,
          th0: 0,
          th1: Math.PI / 2,
          x0: rx * cp,
          y0: rx * sp,
          x1: -ry * sp,
          y1: ry * cp,
        };
        const expected = Math.hypot(rx * A - q, ry * Math.sqrt(1 - A * A));
        if (Math.abs(Math.sqrt(closest(s, q * cp, q * sp).d2) - expected) / rx > 1e-11) feet++;
      }
  check(
    feet === 0,
    'ellipse closest foot near the major-axis evolute agrees with its analytic axis solution',
  );
}

if (fail) {
  console.error(`POLYROOTS-QUARTIC FAIL (${fail})`);
  process.exit(1);
}
console.log('POLYROOTS-QUARTIC PASS');
