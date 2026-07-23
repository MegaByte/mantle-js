// predicatesExactSmoke.mjs — validate the vendored adaptive-exact orient2d
// (src/renderer/predicates.js) against an independent BigInt exact oracle.
//
// This is the safety net for the hand-transcribed Shewchuk expansions: if any
// error-free-transformation step is wrong, the SIGN of orient2d will disagree with
// the exact BigInt determinant on some near-degenerate input, and this test fails
// before the predicate ever reaches cdt.js. Covers: (1) random integer triangles,
// (2) exactly-collinear points (must return exactly 0), (3) the classic near-
// collinear float stress where the naive double determinant returns the WRONG sign
// (this is precisely what the adaptive path must fix), and (4) sign-convention
// (CCW-positive, matching cdt.js).
import { orient2d, incircle } from '../src/renderer/predicates.js';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

// Exact orientation sign via BigInt on dyadic-rational coordinates. Each coord is
// an exact double; scale all six by 2^d (d large enough that s*coord is an integer)
// and compute (b-a)×(c-a) exactly. Returns -1 / 0 / +1 (cdt.js CCW-positive).
function exactSign(a, b, c) {
  // Every finite double is k * 2^e; multiply by 2^1075 makes ALL representable
  // doubles integral. Use BigInt via the bit pattern to stay exact.
  const toBig = (x) => {
    // decompose x into mantissa*2^exp exactly, return {m: BigInt, e: number}
    if (x === 0) return { m: 0n, e: 0 };
    const buf = new DataView(new ArrayBuffer(8));
    buf.setFloat64(0, x);
    const bits = buf.getBigUint64(0);
    const sign = (bits >> 63n) & 1n ? -1n : 1n;
    let exp = Number((bits >> 52n) & 0x7ffn);
    let man = bits & 0xfffffffffffffn;
    if (exp === 0) { exp = -1074; } // subnormal
    else { man |= 0x10000000000000n; exp -= 1075; }
    return { m: sign * man, e: exp };
  };
  // Represent each coordinate as m*2^e, put all over a common exponent = min(e).
  const vals = [a[0], a[1], b[0], b[1], c[0], c[1]].map(toBig);
  const minE = Math.min(...vals.map(v => v.e));
  const I = vals.map(v => v.m << BigInt(v.e - minE)); // exact integers (common scale 2^minE)
  const [ax, ay, bx, by, cx, cy] = I;
  const det = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax); // scale 2^(2*minE), sign exact
  return det > 0n ? 1 : det < 0n ? -1 : 0;
}

const sgn = (x) => x > 0 ? 1 : x < 0 ? -1 : 0;

// --- (1) random integer triangles -------------------------------------------
let rng = 123456789 >>> 0;
const rand = () => (rng = (rng * 1103515245 + 12345) >>> 0) / 4294967296;
let mism = 0;
for (let i = 0; i < 20000; i++) {
  const R = () => Math.floor((rand() - 0.5) * 4000);
  const a = [R(), R()], b = [R(), R()], c = [R(), R()];
  if (sgn(orient2d(a, b, c)) !== exactSign(a, b, c)) mism++;
}
mism === 0 ? ok('20000 random integer triangles: sign matches BigInt oracle') : fail(`integer triangles: ${mism} sign mismatches`);

// --- (2) exactly collinear → exactly 0 --------------------------------------
let colFail = 0;
for (let i = 0; i < 5000; i++) {
  const R = () => Math.floor((rand() - 0.5) * 2000);
  const a = [R(), R()], d = [R() || 1, R()];
  const b = [a[0] + d[0], a[1] + d[1]];
  const k = Math.floor((rand() - 0.5) * 20) || 3;
  const c = [a[0] + k * d[0], a[1] + k * d[1]]; // exactly on line a→b (integer)
  if (orient2d(a, b, c) !== 0) colFail++;
}
colFail === 0 ? ok('5000 exactly-collinear integer triples: orient2d === 0') : fail(`collinear: ${colFail} nonzero`);

// --- (3) near-collinear FLOAT stress (naive double flips sign) ---------------
// Generate points sitting a fraction of an ULP off the line a→b: the true offset
// (~1e-15 for unit coords) is comparable to the determinant's rounding error
// (~1e-16·magnitude), so the naive determinant frequently returns the WRONG sign.
// The adaptive path must agree with the exact BigInt oracle on every one of them.
let nearFail = 0, naiveWrong = 0;
const naive = (a, b, c) => (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);
for (let i = 0; i < 200000; i++) {
  const r24 = () => Math.floor(rand() * (1 << 24)) / (1 << 24); // 24-bit double in [0,1)
  const a = [r24(), r24()], b = [r24(), r24()];
  const t = r24();
  const c = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  c[0] += (rand() - 0.5) * 2 ** -47;   // sub-ulp perpendicular-ish nudge
  c[1] += (rand() - 0.5) * 2 ** -47;
  const exact = exactSign(a, b, c);
  if (sgn(orient2d(a, b, c)) !== exact) nearFail++;
  if (sgn(naive(a, b, c)) !== exact) naiveWrong++;
}
nearFail === 0 ? ok(`200000 near-collinear float stress: exact orient2d matches oracle on ALL (naive double was WRONG on ${naiveWrong})`)
              : fail(`near-collinear: ${nearFail} sign mismatches vs oracle`);
naiveWrong > 0 ? ok(`non-vacuous: adaptive path corrected ${naiveWrong} naive-double sign errors`)
              : fail('stress produced no naive failures — test is not exercising the adaptive path');

// --- (4) sign convention: known CCW triangle > 0 ----------------------------
{
  const a = [0, 0], b = [1, 0], c = [0, 1]; // CCW
  orient2d(a, b, c) > 0 ? ok('CCW triangle → orient2d > 0 (matches cdt.js convention)') : fail('sign convention wrong (CCW should be > 0)');
  orient2d(a, c, b) < 0 ? ok('CW triangle → orient2d < 0') : fail('sign convention wrong (CW should be < 0)');
}

// --- (5) incircle: exact 3×3 lifted determinant oracle (cdt.js formula) ------
// Independent BigInt oracle using cdt.js's exact inCircle determinant.
function exactInc(a, b, c, d) {
  const toBig = (x) => {
    if (x === 0) return { m: 0n, e: 0 };
    const buf = new DataView(new ArrayBuffer(8)); buf.setFloat64(0, x);
    const bits = buf.getBigUint64(0);
    const sign = (bits >> 63n) & 1n ? -1n : 1n;
    let exp = Number((bits >> 52n) & 0x7ffn); let man = bits & 0xfffffffffffffn;
    if (exp === 0) exp = -1074; else { man |= 0x10000000000000n; exp -= 1075; }
    return { m: sign * man, e: exp };
  };
  const vs = [a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]].map(toBig);
  const minE = Math.min(...vs.map(v => v.e));
  const [ax0, ay0, bx0, by0, cx0, cy0, dx0, dy0] = vs.map(v => v.m << BigInt(v.e - minE));
  const ax = ax0 - dx0, ay = ay0 - dy0, bx = bx0 - dx0, by = by0 - dy0, cx = cx0 - dx0, cy = cy0 - dy0;
  const ad = ax*ax + ay*ay, bd = bx*bx + by*by, cd = cx*cx + cy*cy;
  const det = ax*(by*cd - bd*cy) - ay*(bx*cd - bd*cx) + ad*(bx*cy - by*cx);
  return det > 0n ? 1 : det < 0n ? -1 : 0;
}
// cdt.js's own naive double inCircle, for the non-vacuous demonstration.
const naiveInc = (a, b, c, d) => {
  const ax=a[0]-d[0], ay=a[1]-d[1], bx=b[0]-d[0], by=b[1]-d[1], cx=c[0]-d[0], cy=c[1]-d[1];
  const ad=ax*ax+ay*ay, bd=bx*bx+by*by, cd=cx*cx+cy*cy;
  return ax*(by*cd-bd*cy)-ay*(bx*cd-bd*cx)+ad*(bx*cy-by*cx);
};
// (5a) random integer quads
let incMis = 0;
for (let i = 0; i < 20000; i++) {
  const R = () => Math.floor((rand() - 0.5) * 2000);
  const a=[R(),R()], b=[R(),R()], c=[R(),R()], d=[R(),R()];
  if (orient2d(a,b,c) === 0) continue;                 // incircle undefined for degenerate abc
  const abc = orient2d(a,b,c) > 0 ? [a,b,c] : [a,c,b]; // feed CCW
  if (sgn(incircle(abc[0],abc[1],abc[2],d)) !== exactInc(abc[0],abc[1],abc[2],d)) incMis++;
}
incMis === 0 ? ok('20000 random integer incircle: sign matches BigInt oracle') : fail(`incircle integers: ${incMis} mismatches`);

// (5b) near-cocircular stress: rectangle corners are exactly cocircular; perturb
// the 4th point sub-ulp so the naive double determinant flips sign.
let incNear = 0, incNaiveWrong = 0;
for (let i = 0; i < 200000; i++) {
  const s = 1 + rand() * 40;
  const cx = (rand()-0.5)*10, cy = (rand()-0.5)*10;
  // 3 corners of an axis box (cocircular), CCW
  const a=[cx-s,cy-s], b=[cx+s,cy-s], c=[cx+s,cy+s];
  // 4th corner is exactly on the same circle; nudge it sub-ulp off
  const d=[cx-s, cy+s];
  d[0] += (rand()-0.5)*2**-40; d[1] += (rand()-0.5)*2**-40;
  const exact = exactInc(a,b,c,d);
  if (sgn(incircle(a,b,c,d)) !== exact) incNear++;
  if (sgn(naiveInc(a,b,c,d)) !== exact) incNaiveWrong++;
}
incNear === 0 ? ok(`200000 near-cocircular stress: exact incircle matches oracle on ALL (naive double was WRONG on ${incNaiveWrong})`)
             : fail(`incircle near-cocircular: ${incNear} mismatches`);
incNaiveWrong > 0 ? ok(`non-vacuous: exact incircle corrected ${incNaiveWrong} naive-double sign errors`)
                 : fail('incircle stress produced no naive failures — not exercising the exact path');

// (5c) convention: point at center of a CCW triangle's circumcircle is inside
{
  const a=[0,0], b=[4,0], c=[0,4]; // CCW, circumcircle centered ~(2,2)
  incircle(a,b,c,[2,2]) > 0 ? ok('point inside circumcircle → incircle > 0 (matches cdt.js)') : fail('incircle convention wrong (inside should be > 0)');
  incircle(a,b,c,[100,100]) < 0 ? ok('far point → incircle < 0') : fail('incircle convention wrong (outside should be < 0)');
}

console.log(failures ? `\nPREDICATES SMOKE FAIL (${failures})` : `\nPREDICATES SMOKE PASS`);
process.exit(failures ? 1 : 0);
