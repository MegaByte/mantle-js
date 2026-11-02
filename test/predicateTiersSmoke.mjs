// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// predicateTiersSmoke — the double-double middle tier must never change a predicate's SIGN.
//
// Both predicates are adaptive cascades (Shewchuk): a float filter with a rigorous error bound,
// then progressively longer exact expansions. Every level must agree in SIGN with the true
// determinant; a level may only DECLINE (recompute at higher precision), never disagree.
//
// This reimplements the exact determinant here, independently of predicates.js, and compares the
// public orient2d() sign against it on adversarial inputs: exact collinears, near-collinears at
// every scale, points that differ in one ulp, and huge/tiny magnitudes. A single disagreement
// corrupts the CDT (flip loops, inverted triangles), so this is a correctness gate, not a
// quality one.
import { orient2d, incircle, predicateStats, resetPredicateStats } from '../src/geom/predicates.js';

// ---- independent exact reference (BigInt over a common power-of-two scale) ----
const dv = new DataView(new ArrayBuffer(8));
function toBig(x) {
  if (x === 0) return { m: 0n, e: 0 };
  dv.setFloat64(0, x);
  const bits = dv.getBigUint64(0);
  const sign = (bits >> 63n) & 1n ? -1n : 1n;
  let exp = Number((bits >> 52n) & 0x7ffn);
  let man = bits & 0xfffffffffffffn;
  if (exp === 0) exp = -1074;
  else {
    man |= 0x10000000000000n;
    exp -= 1075;
  }
  return { m: sign * man, e: exp };
}
function refOrient(a, b, c) {
  const vs = [a[0], a[1], b[0], b[1], c[0], c[1]].map(toBig);
  let minE = Infinity;
  for (const v of vs) if (v.e < minE) minE = v.e;
  const [ax, ay, bx, by, cx, cy] = vs.map((v) => v.m << BigInt(v.e - minE));
  const det = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return det > 0n ? 1 : det < 0n ? -1 : 0;
}
function refIncircle(a, b, c, d) {
  const vs = [a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]].map(toBig);
  let minE = Infinity;
  for (const v of vs) if (v.e < minE) minE = v.e;
  const [ax0, ay0, bx0, by0, cx0, cy0, dx0, dy0] = vs.map((v) => v.m << BigInt(v.e - minE));
  const ax = ax0 - dx0,
    ay = ay0 - dy0,
    bx = bx0 - dx0,
    by = by0 - dy0,
    cx = cx0 - dx0,
    cy = cy0 - dy0;
  const ad = ax * ax + ay * ay,
    bd = bx * bx + by * by,
    cd = cx * cx + cy * cy;
  const det = ax * (by * cd - bd * cy) - ay * (bx * cd - bd * cx) + ad * (bx * cy - by * cx);
  return det > 0n ? 1 : det < 0n ? -1 : 0;
}
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

// ---- adversarial generators ----
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const ulp = (x) => {
  dv.setFloat64(0, x);
  dv.setBigUint64(0, dv.getBigUint64(0) + 1n);
  return dv.getFloat64(0);
};

const cases = [];
for (let i = 0; i < 40000; i++) {
  const s = [1e-8, 1e-3, 1, 1e3, 1e8][i % 5];
  const a = [(rnd() - 0.5) * s, (rnd() - 0.5) * s];
  const b = [(rnd() - 0.5) * s, (rnd() - 0.5) * s];
  const mode = i % 4;
  if (mode === 0)
    cases.push([a, b, [(rnd() - 0.5) * s, (rnd() - 0.5) * s]]); // generic
  else if (mode === 1) {
    const t = rnd() * 2 - 0.5; // exactly collinear
    cases.push([a, b, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]]);
  } else if (mode === 2) {
    const t = rnd() * 2 - 0.5; // collinear, 1 ulp off
    const c = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    cases.push([a, b, [ulp(c[0]), c[1]]]);
  } else {
    const c = [a[0], a[1]];
    cases.push([a, b, c]);
  } // degenerate (a == c)
}
// exact lattice collinears: the classic killer for a naive filter
for (let x = -8; x <= 8; x++)
  for (let y = -8; y <= 8; y++)
    if (x || y)
      cases.push([
        [0, 0],
        [x, y],
        [2 * x, 2 * y],
      ]);

// Cases that reach the FULLY-EXPANDED level (D). Random near-collinear jitter never gets there:
// the C-level correction always decides it. Level D needs collinear-ish points whose SUBTRACTIONS
// round — i.e. coordinates of wildly different magnitude (|a| >> |c|), so the twoDiff tails are
// nonzero while the determinant stays at the noise floor. 400k random probes found none of these.
cases.push([
  [1, 1],
  [2, 2],
  [1e-30, 1e-30],
]); // exactly on y = x
cases.push([
  [1e-30, 1e-30],
  [1, 1],
  [1e30, 1e30],
]); // spread over 1e60
cases.push([
  [1, 3],
  [2, 6],
  [1e-25, 3e-25],
]); // y = 3x (c only near the line)
cases.push([
  [1e-22, 3e-22],
  [1, 3],
  [1e22, 3e22],
]);
cases.push([
  [1, 1],
  [2, 2],
  [1e-30, 1.0000000000000002e-30],
]); // 1 ulp off, with tails

resetPredicateStats();
let mismatches = 0,
  firstBad = null;
for (const [a, b, c] of cases) {
  const got = sgn(orient2d(a, b, c));
  const want = refOrient(a, b, c);
  if (got !== want) {
    mismatches++;
    if (!firstBad) firstBad = { a, b, c, got, want };
  }
}

// ---- incircle: cocircular and near-cocircular, the CDT's flip-loop trigger ----
const icCases = [];
for (let i = 0; i < 20000; i++) {
  const R = [1e-3, 1, 1e3][i % 3];
  const cx = (rnd() - 0.5) * R,
    cy = (rnd() - 0.5) * R;
  const th = () => rnd() * 2 * Math.PI;
  const on = (t) => [cx + R * Math.cos(t), cy + R * Math.sin(t)];
  const [t1, t2, t3] = [th(), th(), th()].sort((p, q) => p - q);
  const a = on(t1),
    b = on(t2),
    c = on(t3);
  const mode = i % 3;
  const d =
    mode === 0
      ? on(th()) // (near-)cocircular
      : mode === 1
        ? [ulp(on(th())[0]), on(th())[1]] // 1 ulp off the circle
        : [cx + (rnd() - 0.5) * 2 * R, cy + (rnd() - 0.5) * 2 * R];
  icCases.push([a, b, c, d]);
}
// exact cocircular integer lattice: (0,0),(1,0),(0,1),(1,1) all lie on one circle
for (let k = 1; k <= 40; k++)
  icCases.push([
    [0, 0],
    [k, 0],
    [0, k],
    [k, k],
  ]);
// Reach incircle's FULLY-EXPANDED level: coordinates spanning 1e-30..1e30, so every input
// subtraction rounds (all six tails nonzero) AND the C-level bound fails. This path runs on exact
// expansions, with no BigInt.
for (let k = 1; k <= 60; k++)
  icCases.push([
    [1e-30, 1e-30],
    [1, 0],
    [0, 1],
    [1e30, 1e30],
  ]);
for (let k = 1; k <= 60; k++)
  icCases.push([
    [1e-30, 2e-30],
    [1, 0],
    [0, 1],
    [k * 1e25, k * 1e25],
  ]);

let icMis = 0,
  icFirst = null;
for (const [a, b, c, d] of icCases) {
  // incircle's convention needs CCW abc; skip degenerate/CW triples, they are not its domain
  if (refOrient(a, b, c) <= 0) continue;
  const got = sgn(incircle(a, b, c, d));
  const want = refIncircle(a, b, c, d);
  if (got !== want) {
    icMis++;
    if (!icFirst) icFirst = { a, b, c, d, got, want };
  }
}

let fail = 0;
const ok = (cond, msg) =>
  cond ? console.log('  ok ' + msg) : (fail++, console.error('  FAIL ' + msg));

const st = predicateStats;
const uncertain = st.orient2dAdapt;
console.log(
  `  orient2d: ${cases.length} cases -> filter ${st.orient2d - uncertain}, adaptive ${st.orient2dAdapt}, fully-exact ${st.orient2dExact}`,
);
console.log(
  `  incircle: ${icCases.length} cases -> filter ${st.incircle - st.incircleAdapt}, adaptive ${st.incircleAdapt}, tails ${st.incircleExact}, full expansion ${st.incircleFull}`,
);
if (firstBad) console.error('  first mismatch:', JSON.stringify(firstBad));

ok(mismatches === 0, `orient2d sign is exact (${mismatches} mismatches vs the exact reference)`);
if (icFirst) console.error('  first incircle mismatch:', JSON.stringify(icFirst));
ok(
  icMis === 0,
  `incircle sign is exact (${icMis} mismatches over ${icCases.length} cocircular cases)`,
);
// the adaptive levels must actually be exercised, or this gate is vacuous
ok(
  uncertain > 100,
  `the filter was actually uncertain often enough to test the tiers (${uncertain} cases)`,
);
ok(st.orient2dAdapt > 0, `orient2d reached the adaptive path (${st.orient2dAdapt})`);
ok(st.orient2dExact > 0, `orient2d reached the fully-expanded exact level (${st.orient2dExact})`);
ok(st.incircleAdapt > 0, `incircle reached the adaptive path (${st.incircleAdapt})`);
ok(
  st.incircleFull > 0,
  `incircle reached the fully-expanded exact level (${st.incircleFull}) — exact expansions, no BigInt`,
);

console.log(fail ? `\nPREDICATE-TIERS FAIL (${fail})` : '\nPREDICATE-TIERS PASS');
process.exit(fail ? 1 : 0);
