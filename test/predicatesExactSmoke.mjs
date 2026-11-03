// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// predicatesExactSmoke.mjs — validate the vendored adaptive-exact predicates (src/geom/predicates.js)
// against an independent BigInt exact oracle.
//
// Both predicates are adaptive cascades (Shewchuk): a float filter with a rigorous error bound,
// then progressively longer exact expansions. Every level must agree in SIGN with the true
// determinant; a level may only DECLINE (recompute at higher precision), never disagree. If any
// error-free-transformation step of the hand-transcribed expansions is wrong, the sign of
// orient2d or incircle disagrees with the exact determinant on some near-degenerate input, and
// this test fails before the predicate reaches cdt.js. A single disagreement corrupts the CDT
// (flip loops, inverted triangles), so this is a correctness gate, not a quality one.
//
// Part 1, signs against the oracle: (1) random integer triangles, (2) exactly collinear points
// (must return exactly 0), (3) the classic near-collinear float stress where the naive double
// determinant returns the WRONG sign (precisely what the adaptive path must fix), (4) the sign
// convention (CCW-positive, matching cdt.js), and (5) incircle on integer quads, near-cocircular
// boxes and its inside-positive convention.
//
// Part 2, the tiers: adversarial inputs at every scale (exact collinears, near-collinears, points
// one ulp apart, huge/tiny magnitudes, cocircular lattices), with predicateStats proving that
// each level, down to the fully expanded one, was actually reached.
import { orient2d, incircle, predicateStats, resetPredicateStats } from '../src/geom/predicates.js';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const check = (cond, m) => (cond ? ok(m) : fail(m));

// ---- independent exact reference (BigInt over a common power-of-two scale) ----
// Every finite double is m * 2^e; shifting all coordinates to their smallest e makes them exact
// integers, so the determinants below are exact and so are their signs.
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

// ==== Part 1: signs against the oracle ====

// --- (1) random integer triangles -------------------------------------------
let rng = 123456789 >>> 0;
const rand = () => (rng = (rng * 1103515245 + 12345) >>> 0) / 4294967296;
let mism = 0;
for (let i = 0; i < 20000; i++) {
  const R = () => Math.floor((rand() - 0.5) * 4000);
  const a = [R(), R()],
    b = [R(), R()],
    c = [R(), R()];
  if (sgn(orient2d(a, b, c)) !== refOrient(a, b, c)) mism++;
}
mism === 0
  ? ok('20000 random integer triangles: sign matches BigInt oracle')
  : fail(`integer triangles: ${mism} sign mismatches`);

// --- (2) exactly collinear → exactly 0 --------------------------------------
let colFail = 0;
for (let i = 0; i < 5000; i++) {
  const R = () => Math.floor((rand() - 0.5) * 2000);
  const a = [R(), R()],
    d = [R() || 1, R()];
  const b = [a[0] + d[0], a[1] + d[1]];
  const k = Math.floor((rand() - 0.5) * 20) || 3;
  const c = [a[0] + k * d[0], a[1] + k * d[1]]; // exactly on line a→b (integer)
  if (orient2d(a, b, c) !== 0) colFail++;
}
colFail === 0
  ? ok('5000 exactly-collinear integer triples: orient2d === 0')
  : fail(`collinear: ${colFail} nonzero`);

// --- (3) near-collinear FLOAT stress (naive double flips sign) ---------------
// Generate points sitting a fraction of an ULP off the line a→b: the true offset
// (~1e-15 for unit coords) is comparable to the determinant's rounding error
// (~1e-16·magnitude), so the naive determinant frequently returns the WRONG sign.
// The adaptive path must agree with the exact BigInt oracle on every one of them.
let nearFail = 0,
  naiveWrong = 0;
const naive = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
for (let i = 0; i < 200000; i++) {
  const r24 = () => Math.floor(rand() * (1 << 24)) / (1 << 24); // 24-bit double in [0,1)
  const a = [r24(), r24()],
    b = [r24(), r24()];
  const t = r24();
  const c = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  c[0] += (rand() - 0.5) * 2 ** -47; // sub-ulp perpendicular-ish nudge
  c[1] += (rand() - 0.5) * 2 ** -47;
  const exact = refOrient(a, b, c);
  if (sgn(orient2d(a, b, c)) !== exact) nearFail++;
  if (sgn(naive(a, b, c)) !== exact) naiveWrong++;
}
nearFail === 0
  ? ok(
      `200000 near-collinear float stress: exact orient2d matches oracle on ALL (naive double was WRONG on ${naiveWrong})`,
    )
  : fail(`near-collinear: ${nearFail} sign mismatches vs oracle`);
naiveWrong > 0
  ? ok(`non-vacuous: adaptive path corrected ${naiveWrong} naive-double sign errors`)
  : fail('stress produced no naive failures — test is not exercising the adaptive path');

// --- (4) sign convention: known CCW triangle > 0 ----------------------------
{
  const a = [0, 0],
    b = [1, 0],
    c = [0, 1]; // CCW
  orient2d(a, b, c) > 0
    ? ok('CCW triangle → orient2d > 0 (matches cdt.js convention)')
    : fail('sign convention wrong (CCW should be > 0)');
  orient2d(a, c, b) < 0
    ? ok('CW triangle → orient2d < 0')
    : fail('sign convention wrong (CW should be < 0)');
}

// --- (5) incircle against the exact 3×3 lifted determinant (cdt.js formula) ---
// cdt.js's own naive double inCircle, for the non-vacuous demonstration.
const naiveInc = (a, b, c, d) => {
  const ax = a[0] - d[0],
    ay = a[1] - d[1],
    bx = b[0] - d[0],
    by = b[1] - d[1],
    cx = c[0] - d[0],
    cy = c[1] - d[1];
  const ad = ax * ax + ay * ay,
    bd = bx * bx + by * by,
    cd = cx * cx + cy * cy;
  return ax * (by * cd - bd * cy) - ay * (bx * cd - bd * cx) + ad * (bx * cy - by * cx);
};
// (5a) random integer quads
let incMis = 0;
for (let i = 0; i < 20000; i++) {
  const R = () => Math.floor((rand() - 0.5) * 2000);
  const a = [R(), R()],
    b = [R(), R()],
    c = [R(), R()],
    d = [R(), R()];
  if (orient2d(a, b, c) === 0) continue; // incircle undefined for degenerate abc
  const abc = orient2d(a, b, c) > 0 ? [a, b, c] : [a, c, b]; // feed CCW
  if (sgn(incircle(abc[0], abc[1], abc[2], d)) !== refIncircle(abc[0], abc[1], abc[2], d)) incMis++;
}
incMis === 0
  ? ok('20000 random integer incircle: sign matches BigInt oracle')
  : fail(`incircle integers: ${incMis} mismatches`);

// (5b) near-cocircular stress: rectangle corners are exactly cocircular; perturb
// the 4th point sub-ulp so the naive double determinant flips sign.
let incNear = 0,
  incNaiveWrong = 0;
for (let i = 0; i < 200000; i++) {
  const s = 1 + rand() * 40;
  const cx = (rand() - 0.5) * 10,
    cy = (rand() - 0.5) * 10;
  // 3 corners of an axis box (cocircular), CCW
  const a = [cx - s, cy - s],
    b = [cx + s, cy - s],
    c = [cx + s, cy + s];
  // 4th corner is exactly on the same circle; nudge it sub-ulp off
  const d = [cx - s, cy + s];
  d[0] += (rand() - 0.5) * 2 ** -40;
  d[1] += (rand() - 0.5) * 2 ** -40;
  const exact = refIncircle(a, b, c, d);
  if (sgn(incircle(a, b, c, d)) !== exact) incNear++;
  if (sgn(naiveInc(a, b, c, d)) !== exact) incNaiveWrong++;
}
incNear === 0
  ? ok(
      `200000 near-cocircular stress: exact incircle matches oracle on ALL (naive double was WRONG on ${incNaiveWrong})`,
    )
  : fail(`incircle near-cocircular: ${incNear} mismatches`);
incNaiveWrong > 0
  ? ok(`non-vacuous: exact incircle corrected ${incNaiveWrong} naive-double sign errors`)
  : fail('incircle stress produced no naive failures — not exercising the exact path');

// (5c) convention: point at center of a CCW triangle's circumcircle is inside
{
  const a = [0, 0],
    b = [4, 0],
    c = [0, 4]; // CCW, circumcircle centered ~(2,2)
  incircle(a, b, c, [2, 2]) > 0
    ? ok('point inside circumcircle → incircle > 0 (matches cdt.js)')
    : fail('incircle convention wrong (inside should be > 0)');
  incircle(a, b, c, [100, 100]) < 0
    ? ok('far point → incircle < 0')
    : fail('incircle convention wrong (outside should be < 0)');
}

// ==== Part 2: the tiers ====
// predicateStats is reset below, so the tier checks count only these cases.

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

const st = predicateStats;
const uncertain = st.orient2dAdapt;
console.log(
  `  orient2d: ${cases.length} cases -> filter ${st.orient2d - uncertain}, adaptive ${st.orient2dAdapt}, fully-exact ${st.orient2dExact}`,
);
console.log(
  `  incircle: ${icCases.length} cases -> filter ${st.incircle - st.incircleAdapt}, adaptive ${st.incircleAdapt}, tails ${st.incircleExact}, full expansion ${st.incircleFull}`,
);
if (firstBad) console.error('  first mismatch:', JSON.stringify(firstBad));

check(mismatches === 0, `orient2d sign is exact (${mismatches} mismatches vs the exact reference)`);
if (icFirst) console.error('  first incircle mismatch:', JSON.stringify(icFirst));
check(
  icMis === 0,
  `incircle sign is exact (${icMis} mismatches over ${icCases.length} cocircular cases)`,
);
// the adaptive levels must actually be exercised, or this gate is vacuous
check(
  uncertain > 100,
  `the filter was actually uncertain often enough to test the tiers (${uncertain} cases)`,
);
check(st.orient2dAdapt > 0, `orient2d reached the adaptive path (${st.orient2dAdapt})`);
check(
  st.orient2dExact > 0,
  `orient2d reached the fully-expanded exact level (${st.orient2dExact})`,
);
check(st.incircleAdapt > 0, `incircle reached the adaptive path (${st.incircleAdapt})`);
check(
  st.incircleFull > 0,
  `incircle reached the fully-expanded exact level (${st.incircleFull}) — exact expansions, no BigInt`,
);

console.log(failures ? `\nPREDICATES SMOKE FAIL (${failures})` : `\nPREDICATES SMOKE PASS`);
process.exit(failures ? 1 : 0);
