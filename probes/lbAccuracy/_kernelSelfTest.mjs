// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _kernelSelfTest — what the CPU twin of the coverage kernel can be checked against WITHOUT a GPU.
//
// The twin's fidelity to the shader is a GPU question and _gpuModelCheck.mjs asks it. This asks the
// other half: are the pieces of arithmetic the twin is made of the quantities they claim to be?
// Two independent checks, none of which involves a renderer:
//
//   1. exactBoxCov / exactBoxCov2 / exactBoxCov3 against BRUTE-FORCE supersampling of the very
//      half-planes they are handed. These are closed forms for an area, so an area is the check.
//   2. chainBoxCov against the exact area of the box on the chain's fill side, for chains that cross
//      the box: the chain continued along its end segments and closed far away on its left, clipped
//      to the box -- a polygon, so its area is exact (_chainExact.mjs, which also says which random
//      chains are cases). An exact area is the reference, not the separate copy in
//      probes/lbEmTuned/_chainKernel.mjs, which lacks the border walk at every gap and disagrees with
//      the twin. Asserted separately where the chain clips into the box as ONE run and where it
//      clips as SEVERAL: pairing each run's exit with the next run's entry in chain order is the
//      border's order only when the runs do not interleave along it, and reads up to the complement
//      where they do (`__LB_CHAIN_WALK_CLOSE = true` reproduces that closure); an end within 1e-4 of
//      the border whose ray runs back across the box must still be continued.
//
// And one property check of the term this cluster's curve numbers rest on: curveCov's kappa/24
// mean-curvature bias. For a boundary of constant curvature it is exact in the band regime (the
// area under y = d - kappa x^2/2 over [-1/2,1/2] is 1/2 + d - kappa/24) and an approximation in the
// corner regime, so the check is against the exact area of a pixel box cut by a CIRCLE.
//
//   node probes/lbAccuracy/_kernelSelfTest.mjs     N=20000 SS=512
import { exactBoxCov, exactBoxCov2, exactBoxCov3, chainBoxCov } from './_lbBoxCov.mjs';
import { curveCov } from './_lbKernel.mjs';
import { randomCrossingChains } from './_chainExact.mjs';

const N = +(process.env.N || 20000);
const SS = +(process.env.SS || 512);
let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

// A deterministic generator, so a failure is reproducible.
let _s = 0x2545f491;
const rnd = () => {
  _s ^= _s << 13;
  _s ^= _s >>> 17;
  _s ^= _s << 5;
  return (_s >>> 0) / 4294967296;
};

/// area of the box on the given side(s), by SSxSS point sampling at cell centers
function brute(planes, ss) {
  let n = 0;
  for (let j = 0; j < ss; j++)
    for (let i = 0; i < ss; i++) {
      const x = -0.5 + (i + 0.5) / ss,
        y = -0.5 + (j + 0.5) / ss;
      let inside = true;
      for (const [nn, d] of planes)
        if (nn[0] * x + nn[1] * y > d) {
          inside = false;
          break;
        }
      if (inside) n++;
    }
  return n / (ss * ss);
}

// ── 1. the closed-form box areas ─────────────────────────────────────────────────────────────
for (const [name, k] of [
  ['exactBoxCov', 1],
  ['exactBoxCov2', 2],
  ['exactBoxCov3', 3],
]) {
  let max = 0,
    sum = 0;
  const M = Math.min(N, 4000);
  for (let t = 0; t < M; t++) {
    const planes = [];
    for (let p = 0; p < k; p++) {
      const a = rnd() * Math.PI * 2;
      planes.push([[Math.cos(a), Math.sin(a)], (rnd() - 0.5) * 1.6]);
    }
    const got =
      k === 1
        ? exactBoxCov(planes[0][0], planes[0][1])
        : k === 2
          ? exactBoxCov2(planes[0][0], planes[0][1], planes[1][0], planes[1][1])
          : exactBoxCov3(
              planes[0][0],
              planes[0][1],
              planes[1][0],
              planes[1][1],
              planes[2][0],
              planes[2][1],
            );
    const ref = brute(planes, 256);
    const d = Math.abs(got - ref);
    sum += d;
    if (d > max) max = d;
  }
  // 256x256 point sampling of a half-plane is itself ~1/256 of a cell wrong on the cut edge.
  ok(
    max < 0.006,
    `${name}: max ${(max * 255).toFixed(3)}/255, mean ${((sum / M) * 255).toFixed(4)}/255 vs 256x supersampling over ${M} random cases`,
  );
}

// ── 2. chainBoxCov against the exact area ────────────────────────────────────────────────────
{
  // The cases and their truth are _chainExact's: chains that cross the box and, with their end rays, are a simple path.
  let one = 0,
    oneWorst = 0,
    multi = 0,
    multiWorst = 0;
  for (const c of randomCrossingChains(3 * N)) {
    const P = c.pts;
    let d = 0;
    for (const fi of [0, 1, 2])
      d = Math.max(d, Math.abs(chainBoxCov(P[0], P[1], P[2], P[3], P[4], fi) - c.want));
    if (c.runs === 1) {
      one++;
      oneWorst = Math.max(oneWorst, d);
    } else {
      multi++;
      multiWorst = Math.max(multiWorst, d);
    }
  }
  // one chain, three forceInside values: a chain that crosses the box never reaches forceInside's miss answers
  ok(
    one > 1000 && oneWorst < 1e-9,
    `chainBoxCov: exact on ${one} one-run crossing chains (worst ${(oneWorst * 255).toExponential(2)}/255)`,
  );
  ok(
    multi > 100 && multiWorst < 1e-9,
    `chainBoxCov: exact on ${multi} several-run crossing chains (worst ${(multiWorst * 255).toExponential(2)}/255)`,
  );
}

// ── 3. curveCov's kappa/24 against a circle's exact box coverage ─────────────────────────────
// The exact area of the box cut by a circle of radius R centered at (0, -R + d) — the boundary
// passes d above the cell center with curvature kappa = 1/R — by adaptive x integration.
function circleBoxArea(R, d) {
  const cy = -R + d; // center below, so the fill is BELOW the arc
  const M = 200000;
  let a = 0;
  for (let i = 0; i < M; i++) {
    const x = -0.5 + (i + 0.5) / M;
    const dy2 = R * R - x * x;
    if (dy2 <= 0) continue;
    const yTop = cy + Math.sqrt(dy2); // the arc's height at this x
    a += Math.max(0, Math.min(0.5, yTop) + 0.5);
  }
  return a / M;
}
{
  const rows = [];
  for (const kappa of [0, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0]) {
    let max = 0,
      sum = 0,
      n = 0;
    for (let s = -12; s <= 12; s++) {
      const d = s / 16;
      const R = kappa > 0 ? 1 / kappa : 1e9;
      const ref = circleBoxArea(R, d);
      // the kernel's own inputs for this configuration: f = -(signed distance) with an outward
      // gradient of unit length in px, and the rank-1 Hessian of a circle
      const f = -d,
        fx = 0,
        fy = 1; // grad points AWAY from the fill (f > 0 outside)
      const fxx = kappa,
        fyy = 0,
        fxy = 0;
      const got = curveCov(f, fx, fy, fxx, fyy, fxy, null);
      const e = Math.abs(got - ref);
      sum += e;
      n++;
      if (e > max) max = e;
    }
    rows.push([kappa, max, sum / n]);
  }
  for (const [kappa, max, mean] of rows)
    console.log(
      `  kappa ${kappa.toFixed(2)} (radius ${kappa ? (1 / kappa).toFixed(2) : 'inf'} px): ` +
        `curveCov vs the exact circle -- max ${(max * 255).toFixed(2)}/255, mean ${(mean * 255).toFixed(2)}/255`,
    );
  ok(rows[0][1] < 1e-9, 'curveCov is EXACT at zero curvature (it is exactBoxCov there)');
  ok(rows[3][1] < 0.02, 'curveCov within 5/255 at kappa 0.25 (a 4 px radius)');
}

console.log(fail ? `LB-KERNEL-SELFTEST FAIL (${fail})` : 'LB-KERNEL-SELFTEST OK');
process.exit(fail ? 1 : 0);
