// newtonPrecisionSmoke — verify how many clamped-Newton iterations the coverage
// solver needs for sub-pixel roots. Replicates the shader's float32 solver math
// (deterministic 1D, no GPU needed) and measures the worst-case error of N
// iterations, using the same bracket construction the shaders use: sub-intervals
// split at the cubic's critical points (derivative roots), where the cubic is
// monotonic.
const f = Math.fround;

// Cubic coeff form f(t) = ((cx*t+cy)*t+cz)*t+cw, float32 throughout (GPU-like).
function evalC(c, t) {
  return f(f(f(f(f(c[0] * t) + c[1]) * t) + c[2]) * t) + c[3];
}
function evalCD(c, t) {
  return f(f(f(f(3 * c[0]) * t) + f(2 * c[1])) * t) + c[2];
}
function newton(c, lo, hi, iters) {
  let xr = f(0.5 * (lo + hi));
  for (let k = 0; k < iters; k++) {
    const fy = evalC(c, xr);
    const fdy = evalCD(c, xr);
    if (Math.abs(fdy) < 1e-12) break;
    xr = Math.max(lo, Math.min(hi, f(xr - f(fy / fdy))));
  }
  return xr;
}
// double-precision reference root via 80-iter bisection on a monotonic bracket.
function refRoot(c, lo, hi) {
  const g = (t) => ((c[0] * t + c[1]) * t + c[2]) * t + c[3];
  let a = lo, b = hi, ga = g(a);
  for (let i = 0; i < 80; i++) {
    const m = 0.5 * (a + b), gm = g(m);
    if (ga * gm <= 0) b = m; else { a = m; ga = gm; }
  }
  return 0.5 * (a + b);
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cubic coeffs from 4 control values (Bernstein → power basis), as the shader's
// cubicCoeff() does for the on-ray axis. Control points are glyph-like in [-1,1].
function cubicCoeff(p0, p1, p2, p3) {
  // f(t) = p0(1-t)^3 + 3p1 t(1-t)^2 + 3p2 t^2(1-t) + p3 t^3
  const cx = -p0 + 3 * p1 - 3 * p2 + p3;
  const cy = 3 * p0 - 6 * p1 + 3 * p2;
  const cz = -3 * p0 + 3 * p1;
  const cw = p0;
  return [cx, cy, cz, cw];
}

const rng = mulberry32(0x5106abcd);
const PIXEL_SCALE = 4096;             // worst case: one curve spanning a 4K render
const ITER_COUNTS = [3, 4, 5, 6, 8];
const maxT = {}, maxPx = {};          // all crossings
const maxPxWC = {};                   // well-conditioned only (|f'(root)|>0.05)
for (const it of ITER_COUNTS) { maxT[it] = 0; maxPx[it] = 0; maxPxWC[it] = 0; }
let n = 0, nWC = 0;

for (let i = 0; i < 300000; i++) {
  // Random cubic from glyph-like control values.
  const c = cubicCoeff(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1);
  // Bracket list = {0, critical points in (0,1), 1}, exactly as the shaders
  // build via the derivative roots — f is monotonic on each sub-interval.
  const bds = [0];
  const a = 3 * c[0], b = 2 * c[1], cc = c[2]; // f'(t) = a t^2 + b t + c
  if (Math.abs(a) > 1e-12) {
    const disc = b * b - 4 * a * cc;
    if (disc > 0) {
      const sq = Math.sqrt(disc);
      const r1 = (-b - sq) / (2 * a), r2 = (-b + sq) / (2 * a);
      for (const r of [Math.min(r1, r2), Math.max(r1, r2)]) if (r > 1e-6 && r < 1 - 1e-6) bds.push(r);
    }
  } else if (Math.abs(b) > 1e-12) {
    const r = -cc / b; if (r > 1e-6 && r < 1 - 1e-6) bds.push(r);
  }
  bds.push(1);
  const g = (t) => ((c[0] * t + c[1]) * t + c[2]) * t + c[3];
  for (let s = 0; s + 1 < bds.length; s++) {
    const lo = bds[s], hi = bds[s + 1];
    if (g(lo) * g(hi) > 0) continue;     // no crossing on this monotonic piece
    const ref = refRoot(c, lo, hi);
    // Slope at the root: near-zero ⇒ near-tangent crossing (negligible coverage
    // contribution, and ill-conditioned for ANY fixed-iter Newton). Classify so
    // we can judge the visually-significant (well-conditioned) crossings apart.
    const slope = Math.abs((3 * c[0] * ref + 2 * c[1]) * ref + c[2]);
    const wc = slope > 0.05;
    n++; if (wc) nWC++;
    for (const it of ITER_COUNTS) {
      const e = Math.abs(newton(c, lo, hi, it) - ref);
      if (e > maxT[it]) maxT[it] = e;
      const px = e * PIXEL_SCALE;
      if (px > maxPx[it]) maxPx[it] = px;
      if (wc && px > maxPxWC[it]) maxPxWC[it] = px;
    }
  }
}

console.log(`crossings: ${n} total, ${nWC} well-conditioned (|f'(root)|>0.05)`);
console.log(`iter | max px@4096 (all) | max px@4096 (well-cond, the visible ones)`);
for (const it of ITER_COUNTS)
  console.log(`  ${it}  |  ${maxPx[it].toFixed(2).padStart(9)}  |  ${maxPxWC[it].toFixed(3)}`);
const minGoodWC = ITER_COUNTS.find((it) => maxPxWC[it] <= 0.5);
console.log(`min sub-pixel iters (well-conditioned): ${minGoodWC ?? ">8"}`);

// Conclusion this test locks in: on the visually-significant (well-conditioned)
// crossings, 3 iters is NOT sub-pixel but 8 IS — which is why both runtimes use
// 8. Near-tangent crossings stay ill-conditioned at any fixed count but
// contribute ~no coverage.
const PASS = maxPxWC[8] <= 0.5 && maxPxWC[3] > 0.5 && nWC > 1000;
if (PASS) {
  console.log("NEWTON-PRECISION PASS (8 iters sub-pixel on visible crossings; 3 is not — both runtimes use 8)");
  process.exit(0);
}
console.log("NEWTON-PRECISION FAIL");
process.exit(1);
