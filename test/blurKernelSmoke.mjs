// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// blurKernelSmoke — every feGaussianBlur sigma gets a kernel that reaches 3 sigma.
//
// A fixed 16-pair loop computing the taps per pixel has 32 px of reach, which is 3 sigma only up to sigma ~10.7: a
// sigma-20 blur would read 0 at 32 px from an edge where a Gaussian reads 14 levels, and a sigma-40 one 0 where it
// reads 54. So blur.frag.glsl's taps are a table built on the CPU (filterGraph/blurKernel.js) reaching ceil(3 sigma)
// up to 128 pairs, and wider blurs take box passes whose variances sum to sigma^2.
//
// THE REFERENCE IS THE SAMPLED GAUSSIAN ITSELF. Each plan is run on the CPU the way the shaders run it -- a pair
// tap is the exact two-texel sum the bilinear fetch returns, a box pass averages 2r + 1 texels -- over a 1-D step
// edge, in float64, and its response at distances d from the edge is compared with the continuous Gaussian's,
// Phi(-d / sigma). Chrome is the pixel reference in test/blurLargeSigmaSmoke.mjs; this pins the kernel math,
// across the whole sigma range, where a browser run cannot reach.
//
// Also pinned: the shader's table size is the planner's (a mismatch would read garbage past the table), and the box
// shader's loop reaches the planner's largest radius.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  BLUR_MAX_PAIRS,
  BOX_MAX_RADIUS,
  BOX_MAX_PASSES,
  gaussianTaps,
  boxRadii,
  blurAxisPlan,
  blurPasses,
} from '../src/filterGraph/blurKernel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

// ---- the shaders agree with the planner ----
const blurSrc = readFileSync(path.join(ROOT, 'src/shaders/blur.frag.glsl'), 'utf8');
const m = /#define\s+BLUR_MAX_PAIRS\s+(\d+)/.exec(blurSrc);
if (
  m &&
  +m[1] === BLUR_MAX_PAIRS &&
  /uniform\s+vec4\s+uTaps\[BLUR_MAX_PAIRS\s*\/\s*2\]/.test(blurSrc)
)
  ok(`blur.frag.glsl holds ${BLUR_MAX_PAIRS} pairs, as the planner fills`);
else
  fail(
    `blur.frag.glsl's table is not BLUR_MAX_PAIRS = ${BLUR_MAX_PAIRS} pairs (found ${m ? m[1] : 'none'})`,
  );
if (/for\s*\(\s*int\s+\w+\s*=\s*0;\s*\w+\s*<\s*BLUR_MAX_PAIRS\s*\/\s*2/.test(blurSrc))
  ok('blur.frag.glsl loops over the whole table');
else fail('blur.frag.glsl does not loop over BLUR_MAX_PAIRS / 2 vec4s');
const boxSrc = readFileSync(path.join(ROOT, 'src/shaders/boxBlur.frag.glsl'), 'utf8');
const bm = /for\s*\(\s*int\s+k\s*=\s*0;\s*k\s*<\s*(\d+)/.exec(boxSrc);
if (bm && 2 * +bm[1] >= BOX_MAX_RADIUS)
  ok(`boxBlur.frag.glsl's ${bm[1]} pair fetches reach radius ${2 * +bm[1]} >= ${BOX_MAX_RADIUS}`);
else
  fail(
    `boxBlur.frag.glsl's loop (${bm ? bm[1] : '?'} pair fetches) does not reach BOX_MAX_RADIUS ${BOX_MAX_RADIUS}`,
  );

// ---- CPU run of a plan over a step edge ----
// Signal: 1 left of the edge, 0 right of it. Pixel i covers [i, i + 1); the edge sits at x = E.
const erfc = (x) => {
  // Numerical Recipes erfcc, |error| < 1.2e-7
  const z = Math.abs(x),
    t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886187 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
};
const Phi = (x) => 0.5 * erfc(-x / Math.SQRT2);
function runAxis(sig, passes) {
  let a = sig;
  for (const p of passes) {
    const b = new Float64Array(a.length);
    const at = (i) => (i >= 0 && i < a.length ? a[i] : 0); // sampleIn: 0 off the input
    if (p.gauss) {
      const g = p.gauss;
      for (let i = 0; i < a.length; i++) {
        let acc = a[i] * g.w0;
        for (let k = 0; k < g.count; k++) {
          const off = g.taps[2 * k],
            w = g.taps[2 * k + 1],
            f = Math.floor(off),
            t = off - f;
          // A bilinear fetch at +off returns (1-t) a[i+f] + t a[i+f+1]; at -off, (1-t) a[i-f] + t a[i-f-1].
          acc +=
            w * ((1 - t) * at(i + f) + t * at(i + f + 1) + (1 - t) * at(i - f) + t * at(i - f - 1));
        }
        b[i] = acc;
      }
    } else {
      const r = p.box;
      for (let i = 0; i < a.length; i++) {
        let s = 0;
        for (let j = -r; j <= r; j++) s += at(i + j);
        b[i] = s / (2 * r + 1);
      }
    }
    a = b;
  }
  return a;
}
function stepResponse(sigma) {
  const passes = blurPasses(sigma, 0, true);
  const reach = passes.reduce((s, p) => s + (p.gauss ? 2 * p.gauss.count : p.box), 0);
  const E = reach + 8,
    n = 2 * E;
  const sig = new Float64Array(n);
  for (let i = 0; i < E; i++) sig[i] = 1;
  return { out: runAxis(sig, passes), E, passes, reach };
}

// ---- 1. the Gaussian table: normalized, reaching ceil(3 sigma), within half a level of Phi ----
const GAUSS = [0.6, 1, 2, 3.3, 7, 10.7, 12, 16, 20, 31.5, 40, 64, 85, 85.33];
for (const s of GAUSS) {
  const plan = blurAxisPlan(s, true);
  if (!plan || !plan.gauss) {
    fail(`sigma ${s}: expected one Gaussian pass, got ${JSON.stringify(plan && plan.box)}`);
    continue;
  }
  const g = plan.gauss;
  let sum = g.w0;
  for (let k = 0; k < g.count; k++) sum += 2 * g.taps[2 * k + 1];
  const lastTap = Math.floor(g.taps[2 * (g.count - 1)]) + 1; // the farthest texel the last pair touches
  const want = Math.ceil(3 * s);
  const { out, E } = stepResponse(s);
  // Distances from the edge to the pixel center, d = i + 0.5 - E, over the 3-sigma reach on the dark side.
  let worst = 0,
    at = 0;
  for (let d = 0.5; d <= 3 * s + 1; d += 1) {
    const e = Math.abs(out[E + d - 0.5] - Phi(-d / s)) * 255;
    if (e > worst) {
      worst = e;
      at = d;
    }
  }
  // Below ~3 px a SAMPLED Gaussian is not the integrated one (8.7 levels at sigma 0.6): that is the sampling, not the
  // table. Past it the table sits within a third of a level of Phi.
  const lim = s < 3 ? 10 : 0.6;
  const good = Math.abs(sum - 1) < 1e-6 && lastTap >= want && worst <= lim;
  const msg = `sigma ${s}: ${g.count} pairs, reach ${lastTap} px (ceil 3 sigma = ${want}), weights sum ${sum.toFixed(7)}, step response within ${worst.toFixed(2)} levels of Phi (worst at d=${at})`;
  if (good) ok(msg);
  else fail(msg);
}

// ---- 2. the box passes: variance within half a radius step of sigma^2, step response within 3 levels ----
const BOX = [85.4, 100, 150, 256, 300, 400, 513];
for (const s of BOX) {
  const plan = blurAxisPlan(s, true);
  if (!plan || !plan.box) {
    fail(`sigma ${s}: expected box passes`);
    continue;
  }
  const radii = plan.box;
  const variance = radii.reduce((v, r) => v + (r * (r + 1)) / 3, 0);
  const sEff = Math.sqrt(variance);
  const { out, E } = stepResponse(s);
  let worst = 0,
    at = 0;
  for (let d = 0.5; d <= 3 * s + 1; d += 1) {
    const e = Math.abs(out[E + d - 0.5] - Phi(-d / s)) * 255;
    if (e > worst) {
      worst = e;
      at = d;
    }
  }
  // A sum of boxes is a piecewise polynomial, not a Gaussian: three of them sit within ~1% (2.6 levels) of Phi.
  // One box moving r -> r + 1 moves the variance by 2(r + 1)/3; the split lands within half of that.
  const rLo = Math.min(...radii);
  const good =
    radii.length >= 3 &&
    radii.every((r) => r >= 1 && r <= BOX_MAX_RADIUS) &&
    Math.abs(variance - s * s) <= (rLo + 1) / 3 + 1e-9 &&
    worst <= 3;
  const msg = `sigma ${s}: boxes [${radii.join(',')}], effective sigma ${sEff.toFixed(3)}, step response within ${worst.toFixed(2)} levels of Phi (worst at d=${at})`;
  if (good) ok(msg);
  else fail(msg);
}
// The ceiling: past BOX_MAX_PASSES boxes of the largest radius the blur stops widening, and says so by its radii.
{
  const r = boxRadii(2000);
  const sEff = Math.sqrt(r.reduce((v, x) => v + (x * (x + 1)) / 3, 0));
  if (r.length === BOX_MAX_PASSES && r.every((x) => x === BOX_MAX_RADIUS))
    ok(
      `sigma 2000 saturates at ${BOX_MAX_PASSES} boxes of ${BOX_MAX_RADIUS} (effective sigma ${sEff.toFixed(1)})`,
    );
  else
    fail(`sigma 2000: expected ${BOX_MAX_PASSES} boxes of ${BOX_MAX_RADIUS}, got [${r.join(',')}]`);
}

// ---- 3. routing: identity, one pass, and the lean build without the box shader ----
if (blurAxisPlan(0.5, true) === null && blurAxisPlan(0, true) === null)
  ok('sigma <= 0.5 is the identity');
else fail('sigma <= 0.5 must plan no pass');
const lean = blurAxisPlan(200, false);
if (lean && lean.gauss && lean.gauss.count === BLUR_MAX_PAIRS)
  ok(
    `no box shader: sigma 200 keeps one Gaussian pass, truncated at the table (${BLUR_MAX_PAIRS} pairs)`,
  );
else fail('no box shader: sigma 200 should fall back to the full Gaussian table');
const ps = blurPasses(20, 0, true);
if (ps.length === 1 && ps[0].dir[0] === 1 && ps[0].gauss)
  ok('sigmaY 0 blurs only along x (one pass)');
else fail(`sigma (20, 0) should be one horizontal pass, got ${ps.length}`);
const psb = blurPasses(0, 150, true);
if (psb.length === 3 && psb.every((p) => p.dir[1] === 1 && p.box))
  ok('sigma (0, 150) is three vertical box passes, and nothing along x');
else
  fail(
    `sigma (0, 150) should be three vertical box passes, got ${JSON.stringify(psb.map((p) => [p.dir, p.box]))}`,
  );

// ---- 4. a fixed 16-pair kernel, for comparison: what a 16-pair loop gives at sigma 20 and 40 ----
for (const s of [20, 40]) {
  const old = {
    gauss: (() => {
      // a fixed-loop kernel: radius min(ceil(3 sigma), 32), 16 pairs
      const R = Math.min(Math.ceil(3 * s), 32),
        t = new Float64Array(64);
      let c = 0,
        sum = 1;
      for (let i0 = 1; i0 <= R && c < 16; i0 += 2) {
        const w0 = Math.exp((-i0 * i0) / (2 * s * s)),
          w1 = i0 + 1 <= R ? Math.exp(-((i0 + 1) ** 2) / (2 * s * s)) : 0;
        t[2 * c] = (i0 * w0 + (i0 + 1) * w1) / (w0 + w1);
        t[2 * c + 1] = w0 + w1;
        sum += 2 * (w0 + w1);
        c++;
      }
      for (let k = 0; k < c; k++) t[2 * k + 1] /= sum;
      return { w0: 1 / sum, count: c, taps: t };
    })(),
  };
  const E = 200,
    sig = new Float64Array(400);
  for (let i = 0; i < E; i++) sig[i] = 1;
  const o = runAxis(sig, [old]),
    nw = stepResponse(s);
  const row = [s / 2, s, 32, 1.5 * s, 2 * s].map(
    (j) =>
      `d=${j + 0.5}: 16-pair ${(o[E + j] * 255).toFixed(1)} table ${(nw.out[nw.E + j] * 255).toFixed(1)} Phi ${(Phi(-(j + 0.5) / s) * 255).toFixed(1)}`,
  );
  console.log(`  sigma ${s} step response (levels): ${row.join('; ')}`);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(
  '\nblurKernelSmoke: every sigma reaches 3 sigma, and the widest take boxes that match its variance',
);
