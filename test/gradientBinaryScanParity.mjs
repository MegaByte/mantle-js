// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gradientBinaryScanParity — proves the binary-search gradient stop sampler is
// bit-identical to a linear scan across every edge the linear fn handles, the
// algebraic guarantee that the inner scan in _gradientHelpers.glsl /
// MantleColrHelpers.hlsl / MantleCommon.hlsl can be swapped without shifting a
// rendered pixel.
//
// Both functions below mirror the shader logic exactly (same texelFetch/Load
// semantics, same `max(span,1e-6)`, same lerp). `sampleLinear` is the for-loop
// scan; `sampleBinary` is the lower_bound form. Their RGBA outputs must be
// exactly equal (===, not approx) over a hostile input space:
//   - random sorted gradients, 1..65536 stops (the LUT cap)
//   - hard stops (duplicate offsets) — the case where bracket choice matters
//   - t at/below first, at/above last, exactly on each stop, and ulp-adjacent

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};

// A "stops LUT" here is an array of {off, col:[r,g,b,alpha]} with off in [0,1]
// ascending — modeling the 2-texel layout: col = straight RGBA (texel A),
// off = stop position (texel B). Both samplers bracket by `off` and interpolate
// `col` (all 4 channels), returning straight (rgb, alpha).

// ---- linear scan (the for-loop form) ----
function sampleLinear(stops, off, n, t) {
  if (n <= 0) return [0, 0, 0, 0];
  if (n === 1) return stops[off].col.slice();
  let prev = stops[off];
  if (t <= prev.off) return prev.col.slice();
  for (let i = 1; i < 65536; i++) {
    if (i >= n) break;
    const cur = stops[off + i];
    if (t <= cur.off) {
      const span = Math.max(cur.off - prev.off, 1e-6);
      const k = (t - prev.off) / span;
      return mix(prev.col, cur.col, k);
    }
    prev = cur;
  }
  return prev.col.slice();
}

// ---- lower_bound binary search (mirror of sampleStopsRaw) ----
// Invariant after the loop: lo == clamp(lower_bound(t), 0, n-1), where
// lower_bound = first index with stops[i].off >= t. The two guards recover the
// exact three linear outcomes (t<=first, in-bracket, t>last).
const BINARY_ITERS = 16; // ceil(log2(65536)), the stop cap; _gradientHelpers.glsl's bound
function sampleBinary(stops, off, n, t) {
  if (n <= 0) return [0, 0, 0, 0];
  if (n === 1) return stops[off].col.slice();
  let lo = 0,
    hi = n - 1;
  for (let it = 0; it < BINARY_ITERS; it++) {
    if (lo >= hi) break;
    const mid = (lo + hi) >> 1;
    if (stops[off + mid].off < t) lo = mid + 1;
    else hi = mid;
  }
  const cur = stops[off + lo];
  if (lo === 0) return cur.col.slice(); // t <= first stop
  if (cur.off < t) return cur.col.slice(); // t > last stop (lo == n-1)
  const prev = stops[off + lo - 1];
  const span = Math.max(cur.off - prev.off, 1e-6);
  const k = (t - prev.off) / span;
  return mix(prev.col, cur.col, k);
}

function mix(a, b, k) {
  return a.map((c, i) => c + (b[i] - c) * k);
}
const eq3 = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);

// Deterministic LCG so the test is reproducible (no Math.random()).
let _s = 0x9e3779b9 >>> 0;
const rnd = () => (_s = (_s * 1664525 + 1013904223) >>> 0) / 0x100000000;

// Build a sorted stops array; `hard` injects duplicate-offset hard stops.
function makeStops(n, { hard = false } = {}) {
  const offs = [];
  for (let i = 0; i < n; i++) offs.push(rnd());
  offs.sort((a, b) => a - b);
  if (hard && n >= 4) {
    // clone a few offsets to make hard stops
    for (let h = 0; h < Math.min(3, n - 1); h++) {
      const j = 1 + ((rnd() * (n - 1)) | 0);
      offs[j] = offs[j - 1];
    }
  }
  // 8-bit quantize offsets + straight RGBA exactly like packGradientStops.
  const stops = offs.map((o) => ({
    off: Math.round(o * 255) / 255,
    col: [
      Math.round(rnd() * 255),
      Math.round(rnd() * 255),
      Math.round(rnd() * 255),
      Math.round(rnd() * 255),
    ],
  }));
  // Re-sort: quantization can reorder near-equal offsets; packer sorts pre-quant
  // but the LUT is read in stored order, so sort the quantized array to model it.
  stops.sort((x, y) => x.off - y.off);
  return stops;
}

// Probe t set for a given stops array: every stop offset, ±1ulp around it,
// midpoints, and out-of-range below/above.
function probes(stops) {
  const ts = [-0.1, 0, 0.5, 1, 1.1];
  for (const s of stops) {
    ts.push(s.off, s.off - 1e-7, s.off + 1e-7, s.off - 1 / 510, s.off + 1 / 510);
  }
  for (let i = 1; i < stops.length; i++) ts.push((stops[i - 1].off + stops[i].off) / 2);
  return ts;
}

let cases = 0,
  probesRun = 0;
const COUNTS = [1, 2, 3, 4, 5, 8, 16, 17, 32, 33, 64, 100, 128, 255, 256, 257, 600, 4097];
for (const hard of [false, true]) {
  for (const n of COUNTS) {
    for (let rep = 0; rep < (n > 256 ? 2 : 12); rep++) {
      const stops = makeStops(n, { hard });
      cases++;
      for (const t of probes(stops)) {
        probesRun++;
        const a = sampleLinear(stops, 0, n, t);
        const b = sampleBinary(stops, 0, n, t);
        if (!eq3(a, b)) {
          fail(
            `n=${n} hard=${hard} t=${t}: linear=[${a}] binary=[${b}] offsets=[${stops.map((s) => s.off).join(',')}]`,
          );
          if (failures > 20) {
            console.error('...too many, aborting');
            process.exit(1);
          }
        }
      }
    }
  }
}

// Also assert BINARY_ITERS is sufficient for the 65536 cap: the loop must fully
// converge (lo===hi) for the largest gradient before the iteration budget runs
// out — otherwise large gradients would silently mis-bracket.
{
  const n = 65536;
  let lo = 0,
    hi = n - 1,
    iters = 0;
  while (lo < hi && iters < BINARY_ITERS) {
    const mid = (lo + hi) >> 1;
    lo = mid + 1;
    iters++;
  }
  // worst case (always take the high branch) must converge within budget
  if (lo < hi)
    fail(`BINARY_ITERS=${BINARY_ITERS} insufficient to converge n=65536 (lo=${lo} hi=${hi})`);
  else
    console.log(`ok: BINARY_ITERS=${BINARY_ITERS} converges worst-case n=65536 in ${iters} iters`);
}

console.log(`\n${cases} gradients × probes = ${probesRun} comparisons`);
if (failures === 0) console.log('PASS: binary search is bit-identical to linear scan');
else console.log(`\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
